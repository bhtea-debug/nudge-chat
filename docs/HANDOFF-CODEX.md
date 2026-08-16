# Handoff: AI Operator — brief dla kolejnego agenta

Dokument przekazania. Czytaj razem z `docs/AI-OPERATOR-MVP.md` (pełny opis, w
szczególności sekcja **8. Live validation**) i `docs/ARCHITEKTURA-AI-2026.md`
(dlaczego to wygląda tak, a nie inaczej).

**Zadanie, które zostało:** doprowadzić `ai-operator` do działania w `MODE=live`
na prawdziwej poczcie i prawdziwym TeaBrew v2. Kod jest gotowy. Brakuje sekretów
i akcji człowieka. **Nie rozszerzaj zakresu.**

---

## 0. Przeczytaj to najpierw

**`MODE=live` nie uruchomi się w środowisku agentowym w chmurze.** Polityka
egress typowej sesji przepuszcza GitHub, npm i `api.anthropic.com`, ale nie
serwer poczty ani wdrożenie Convex firmy (zmierzone: TCP timeout na IMAP,
403 z proxy na Convex). Uruchomienie live należy do maszyny właściciela —
tam jest dostęp i tam mają zostać sekrety.

Do tego jest gotowy skrypt: `ai-operator/scripts/live-setup.sh`. Dopytuje
tylko o brakujące wartości, sekrety czyta bez echa, zapisuje do `.env` z
prawami 600 i uruchamia wszystkie testy bez modelu. Nie próbuj tego odtwarzać
ręcznie ani obchodzić — pełny opis w `docs/AI-OPERATOR-MVP.md` §8.9.

**Trasy ERP są już wdrożone na żywym backendzie**, choć `main` ich nie zawiera:
build preview Vercela uruchamia `convex deploy` bez guardów produkcyjnych
(one działają tylko przy `VERCEL_ENV === "production"`). Potwierdzone:
`/ai-operator/health` zwraca **500**, czyli trasa istnieje, a
`AI_OPERATOR_API_TOKEN` nie jest jeszcze ustawiony (fail-closed). Konsekwencja:
merge PR #27 domyka rozjazd między `main` a wdrożeniem — gdyby ktoś zbudował
produkcję z `main`, trasy zniknęłyby.

---

## 1. Współrzędne

| co | gdzie |
| --- | --- |
| kod agenta | `bhtea-debug/nudge-chat`, gałąź `claude/ai-company-architecture-mvy1uv`, katalog `ai-operator/` |
| łatka ERP | `bhtea-debug/teabrew-v2`, gałąź `claude/ai-operator-read-only-endpoints`, HEAD `27262de`, baza `b777d4d` |
| PR do merge | [`teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27) — `mergeable_state: clean`. Brak GitHub Actions; jedyny automat to preview Vercela (i to on wdrożył funkcje) |

Stan: **56 testów przechodzi, `tsc --noEmit` czysty w obu repo, `check:mail`
11/11 na fiksturach, `MODE=live` nigdy nie był uruchomiony.**

---

## 2. Co to jest w trzech zdaniach

Agent `inbox-operator` czyta przychodzącą pocztę (IMAP), wyciąga z niej numery
zamówień i nazwy produktów, sprawdza je w TeaBrew v2 i odpowiada właścicielowi
firmy z danych, które faktycznie pobrał. Ma **7 capability, wszystkie
read-only** — 3 do poczty, 4 do danych operacyjnych. Dwa wejścia:
`npm run triage` (przegląd poczty w 5 kategoriach) i `npm run ask -- "pytanie"`.

Firma ma ~12 osób. Architektura jest celowo mała: jeden katalog w istniejącym
repo, uruchamiany komendą, bez wdrożenia, bez DevOps, bez nowych usług.

---

## 3. Ograniczenia, których nie wolno naruszyć

To nie są preferencje. Każde jest wymuszone konstrukcyjnie i pokryte testem,
który się wywali, jeśli je złamiesz.

### 100% read-only

| gdzie | jak wymuszone |
| --- | --- |
| `src/capability/registry.ts` | `ALLOWED_EFFECTS = ["read"]`. Capability z innym `effectClass` **nie da się zarejestrować** |
| `src/mail/types.ts` | `MailProvider` nie ma metody zapisu. W całym `src/mail/` nie ma linii SMTP |
| `src/mail/imap.ts` | `mailboxOpen(..., { readOnly: true })` — serwer odmówi zmiany, czytanie nie oznacza wiadomości jako przeczytanych |
| łatka ERP | wyłącznie `internalQuery`. Zero mutacji, zero `scheduler`, zero `storage` |

Jeśli agent ma coś zrobić — **pisze sugestię, wykonuje człowiek**. To nie jest
ostrożność na zapas: firma już raz usunęła funkcję AI (Drive, „AI Organizuj"),
bo pisała bez rozliczalności.

### Zasada „nie zgaduj"

`src/agent/evidence.ts`, trzy mechanizmy:

1. **Stopka dowodowa powstaje z logu audytu, nie od modelu.** Model nie ma jak
   dopisać wywołania, którego nie było.
2. **Kontrola po fakcie** — twierdzenie o statusie, stanie magazynowym, treści
   poczty albo numerze zamówienia musi mieć odpowiadające mu **udane** wywołanie
   capability. Kody: `claim_without_any_erp_call`, `stock_claim_without_stock_call`,
   `mail_claim_without_mail_call`, `order_ref_never_checked`.
3. **Ostrzeżenie jest widoczne** dla człowieka w odpowiedzi; `npm run ask`
   kończy się **kodem wyjścia 3**.

**Nie obchodź tej kontroli.** Jeśli zgłasza fałszywy alarm, popraw detektor
(jest kontekstowy, nie oparty na czarnej liście jednostek) i dodaj test.
Jeśli zgłasza prawdziwy problem — to jest sygnał, po co ona jest.

Po stronie danych ta sama zasada: brak zamówienia to `matchedBy: "none"`
(HTTP 200, nie 404), nieznany kod to `unknownCodes` (**nie** stan zero),
przycięty wynik to `truncated: true`. Nigdy cicho.

### Audyt

Każde wywołanie zapisuje `ts`, `agent`, `capability`, `capabilityVersion`, `ok`,
`latencyMs`, `correlationId`, `refs`. W `refs` **wyłącznie identyfikatory i
liczniki** — to, co capability sama zadeklarowała w `auditRefs`.

**Nigdy w audycie:** treści maili, tematów, adresów nadawców, credentiali,
tokenów. Frazy wyszukiwania są logowane (bez nich audyt nie odpowiada na
pytanie, czego agent szukał), ale **adresy w nich są maskowane** przez
`maskAddressesInText` — model może szukać po adresie nadawcy.

Test `tests/scenarios.test.ts` („Scenariusz 5") tego pilnuje.

### Warstwa modeli po rolach

Dwie role: `fast` (klasyfikacja poczty), `reason` (analiza i odpowiedź).
**W logice agenta nie ma ani jednego identyfikatora modelu.** Podmiana =
zmiana `MODEL_FAST` / `MODEL_REASON` w `.env`. Nie wpisuj nazwy modelu w kod.

### Czego NIE dodawać

Wysyłania maili, draftów, mutacji ERP, integracji z Budżecikiem/B2B/Drive,
RAG, vector DB, kolejnego agenta, panelu webowego, cronów, automatycznego
porannego uruchamiania, centralnej bramy, SSO, nowych usług.

Najpierw dowód, że **obecny** operator działa dobrze na żywych danych.

---

## 4. Miny, które już wybuchły — nie nadepnij ponownie

To są realne błędy znalezione przy weryfikacji łatki wobec aktualnego schematu
TeaBrew. Wszystkie naprawione. Wszystkie łatwo wprowadzić z powrotem.

### `productionRunStatus` nie ma wartości `"running"`

Prawdziwe: `pending | in_progress | paused | partially_done | done | cancelled`.

Zapytanie o `"running"` **nie wywala się** — zwraca pustą listę, którą agent
uczciwie zaraportuje jako „brak otwartych ruchów produkcyjnych", przy pracującej
hali. Kontrola dowodów tego **nie wyłapie**, bo wywołanie się odbyło i zwróciło
ten wynik. Cicho fałszywa odpowiedź.

Aktualnie `productionStatus` pyta o `in_progress` oraz `paused`.
Test w `tests/patch-security.test.ts` blokuje powrót `"running"`.

### `"in_production"` nie jest statusem realizacji zamówienia

`orderFulfillmentStatus` = `awaiting_payment | new | confirmed | in_picking |
packed | shipped | delivered | cancelled`.

**„Zamówienie jest w produkcji" wynika z powiązanego
`productionOrders.status === "in_progress"`**, nie ze statusu zamówienia.
Fikstura z wymyślonym statusem uczyła agenta nieistniejącego słownictwa.

`productionOrderStatus` = `plan | draft | assigned | in_progress | done | cancelled`
(`"planned"` **nie istnieje**).

### `skus.gramatura` to `v.optional(v.number())` — gramy liczbą, nie tekst

W kontrakcie pole nazywa się `gramaturaG` właśnie po to, żeby to było widać.

### Materiał po kodzie MUSI iść przez `buildMaterialIndex`

Dwa materiały mogą mieć ten sam `code` (herbata z tagiem `sku` i akcesorium
z woocommerce). Kalkulator dostępności preferuje ten z tagiem `sku`. Naiwne
„pierwszy o tym kodzie" opisze ilość jednego materiału nazwą i jednostką
drugiego. Dlatego `buildMaterialIndex` dostał `export` w
`convex/lib/salesAvailability.ts` — **nie duplikuj tej reguły**.

Tak samo stan liczy `salesAvailabilityByCode`, ten sam kalkulator, którego
używa portal B2B i push do sklepu. Osobna arytmetyka dla AI = agent podaje
inne liczby niż portal i któraś jest nieprawdziwa.

### `convex codegen` jest ZABRONIONY

`AGENTS.md` w teabrew-v2: nigdy `convex deploy`, `convex dev` ani
`convex codegen`, gdy środowisko wskazuje na żywy backend — **codegen może też
wysłać funkcje**.

Wpisy modułu w `convex/_generated/api.d.ts` są dodane **ręcznie**, dokładnie
w formie generowanej przez codegen: jeden `import type * as queries_aiOperator`,
jeden wpis `"queries/aiOperator": typeof queries_aiOperator`, alfabetycznie
między `queries/access` i `queries/allegroSnapshot`. Jeśli dodasz kolejny
moduł — zrób to tak samo, ręcznie.

Wdrożenie idzie wyłącznie przez `npm run convex:live:check`, potem
`npm run convex:live:deploy -- --confirm=<nazwa-wdrożenia>`. To celowa bramka
dla człowieka. Przed jakąkolwiek edycją w teabrew-v2 wykonaj kroki wymagane
w jego `AGENTS.md` (`pwd`, `git remote -v`, `git status`, `git fetch origin main`,
`git rev-parse HEAD` vs `origin/main`, `git worktree list`).

### Nazwy folderu wysłanych NIE WOLNO zgadywać

Wykrywanie idzie po atrybucie IMAP **SPECIAL-USE** `\Sent`
(`src/mail/folders.ts`, `MAIL_THREAD_FOLDERS=auto`). U różnych dostawców to
„Sent", „Sent Items", „Sent Messages", „INBOX.Sent" albo nazwa zlokalizowana.

Test pokrywa przypadek odwrotny do intuicji: folder o nazwie „Sent" **bez**
atrybutu `\Sent` nie jest brany.

Stawka: bez folderu wysłanych agent nie widzi **naszych** odpowiedzi i może
uznać, że klientowi nikt nie odpisał.

### `mailparser` zwraca `references` raz jako string, raz jako tablicę

Archiwalny kod się na tym potknął. Normalizacja: `normalizeReferences()`
w `src/mail/thread.ts`.

### Cytowana historia zaczynająca się od `>`

Najczęstszy sposób cytowania w ogóle. Bez odcięcia model dostaje pięć
poprzednich odpowiedzi jako nową treść. `stripQuotedHistory()` w
`src/mail/text.ts`, z zabezpieczeniem: jeśli po odcięciu zostałoby < 20 znaków
(wiadomość cytowana górą), zwracana jest całość.

---

## 5. Mapa plików

```
ai-operator/
  src/capability/    rejestr (wymusza read), typy, audyt, projekcje
                     projections.ts: JSON Schema + OpenAPI + MCP z JEDNEJ definicji
  src/mail/          types.ts (MailProvider — brak metod zapisu)
                     imap.ts (adapter, readOnly), fixture.ts (adapter na plikach)
                     folders.ts (SPECIAL-USE), thread.ts (union-find), text.ts
  src/teabrew/       contract.ts (zod, JEDNO źródło prawdy o kształcie)
                     client.ts (HTTP + fixture, ten sam interfejs TeabrewReader)
  src/model/         roles.ts — fast / reason, zero ID modeli w logice
  src/agent/         operator.ts (pętla ręczna, bo w niej powstaje log dowodowy)
                     triage.ts, prompt.ts, evidence.ts
  src/bin/           ask, triage, caps, openapi, mcp, check-mail, verify-teabrew
  teabrew-patch/     źródło kontraktu ERP (już założone jako PR #27)
  fixtures/          poczta (INBOX + Sent) i dane ERP — prawdziwe enumy!
  tests/             scenarios (19), units (25), patch-security (12)
```

Kluczowa właściwość: **z jednej deklaracji capability** (`nazwa, opis,
input, output, wersja, zakres, effectClass`) powstaje klient TypeScript,
JSON Schema dla function callingu, dokument OpenAPI i lista narzędzi MCP.
Nie ma drugiego miejsca opisującego tę samą funkcję. Jeśli dodajesz
capability — dodaj ją **tylko** w rejestrze.

MCP (`src/bin/mcp.ts`) jest **adapterem, nie fundamentem**: nie definiuje
żadnej capability, nie dodaje zależności, skasowanie go nie psuje agenta.

---

## 6. Testowanie bez sekretów

Wszystkie 56 testów działają **bez sieci i bez klucza API**. Model jest atrapą
odgrywającą zaplanowane kroki (`tests/helpers.ts`, `scriptedModel`), dane
pochodzą z fikstur. Możesz rozszerzać testy nie mając żadnego dostępu.

```bash
cd ai-operator
npm install
npm run typecheck
npm test                  # 56 testów
npm run check:mail        # 11 sprawdzeń poczty na fiksturach, 11/11
npm run caps              # 7 capability, 0 zapisujących
npm run openapi           # projekcja HTTP
```

Fikstury mają dwie właściwości, których nie psuj:

- **daty są względne** (`{{-3h}}`, `{{+2d}}`) — inaczej okno `sinceDays`
  przestaje być testowane dzień po napisaniu testu,
- **statusy są dokładnie z enumów źródłowego schematu**, nie „w tym stylu".
  Fikstura z wymyśloną wartością przechodzi przez `z.string()` i uczy agenta
  nieistniejącego słownictwa.

---

## 7. Co zostało do zrobienia — w tej kolejności

### Krok 1 (człowiek): merge i wdrożenie łatki

Review i merge [`teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27),
potem wygenerowanie `AI_OPERATOR_API_TOKEN` (min. 32 losowe znaki) i ustawienie
go **w zmiennych środowiskowych Convex**, potem wdrożenie przez guarded command.
Bez tokenu trasy zwracają 500 (fail-closed).

### Krok 2: sekrety w `.env` (nigdy w repo, nigdy na czacie)

```bash
cd ai-operator && cp .env.example .env && chmod 600 .env
```

Brakujące wartości:

| zmienna | uwagi |
| --- | --- |
| `ANTHROPIC_API_KEY` | — |
| `TEABREW_BASE_URL` | baza HTTP actions wdrożenia Convex, bez końcowego ukośnika |
| `TEABREW_AI_OPERATOR_TOKEN` | ta sama wartość co `AI_OPERATOR_API_TOKEN` w Convex |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT` | port zwykle 993 |
| `MAIL_IMAP_USER`, `MAIL_IMAP_PASSWORD` | **hasło aplikacji**, nie hasło główne. Preferuj konto/hasło z prawem tylko do odczytu, jeśli dostawca to umożliwia. Jeśli nie umożliwia — kod i tak jest read-only |

`AUDIT_FILE` jest już włączony w `.env.example` — na pierwsze uruchomienia
zostaw go, bo bez trwałego logu po tygodniu nie da się odpowiedzieć, czego
agent naprawdę szukał.

### Krok 3: testy bez modelu — MUSZĄ przejść w całości

```bash
npm run verify:teabrew          # 17 sprawdzeń wdrożonej łatki
MODE=live npm run check:mail    # 11 sprawdzeń poczty
```

**Jeśli którykolwiek nie przechodzi — nie włączaj modelu.** Przyczyna jest po
stronie danych albo konfiguracji; model tego nie naprawi, tylko przykryje.

`verify:teabrew` odkrywa prawdziwe numery i kody z systemu (endpoint produkcji
je zwraca), więc testy pozytywne działają bez podawania czegokolwiek.
Wymuszenie: `-- --order <numer> --product <fraza>`.

Sprawdź szczególnie: `1b. Wykrycie folderu wysłanych`. Jeśli serwer nie wskaże
`\Sent`, wpisz nazwę ręcznie w `MAIL_THREAD_FOLDERS`.

### Krok 4: dopiero teraz model

```bash
MODE=live npm run triage
MODE=live npm run ask -- --trace "Co ważnego przyszło dzisiaj?"
```

### Krok 5: trzy testy korelacji na prawdziwych danych

| test | co agent powinien zrobić |
| --- | --- |
| **A** | mail o zamówieniu istniejącym w TeaBrew → przeczytać, wykryć numer, sprawdzić, podać status, pokazać evidence |
| **B** | mail o produkcie/dostępności → rozpoznać produkt, znaleźć kod, sprawdzić stan, odpowiedzieć z TeaBrew |
| **C** | mail, którego **nie da się** wiarygodnie połączyć → powiedzieć, że nie znalazł powiązania. **Nie wymyślić go** |

Po każdym: `npm run ask -- --trace` i weryfikacja, że każde twierdzenie o
statusie / stanie / produkcji / treści poczty ma odpowiadające mu prawdziwe
wywołanie capability.

### Krok 6: uzupełnij `docs/AI-OPERATOR-MVP.md` sekcję 8

Dopisz, co **faktycznie** uruchomiono, które testy przeszły, czego nie udało
się zweryfikować i jakie problemy wyszły dopiero na prawdziwych danych.

**Nie deklaruj działania czegoś, czego nie uruchomiłeś.** Sekcja 8 jest teraz
napisana w tej konwencji — utrzymaj ją.

---

## 8. Znane ograniczenia (świadome, nie do „naprawienia" po drodze)

- **`orderByRef` skanuje wszystkie zamówienia.** Indeks `by_external` jest
  złożony `(source, externalOrderId)`, a źródła z maila nie znamy. Przy obecnej
  skali to tańsze niż zapytanie po każdym źródle. Jeśli `latencyMs` w audycie
  zacznie rosnąć, właściwą odpowiedzią jest indeks po samym numerze — **nie**
  cache po stronie agenta.
- **Wyszukiwanie to IMAP SEARCH, nie wyszukiwarka.** Odpowiedź zawiera
  `searchNote`. Część serwerów odrzuca `SEARCH BODY` — wtedy pomijamy to
  kryterium, nie całe wyszukiwanie.
- **Klasyfikacja triage nie jest deterministyczna.** Nieparsowalna odpowiedź
  modelu nie udaje, że się udała — wiadomości idą do „Nieklasyfikowane".
- **Kontrola dowodów jest heurystyką.** Woli przepuścić niejasny przypadek niż
  krzyczeć na każdą liczbę — ostrzeżenie, które krzyczy zawsze, zostanie
  zignorowane i wtedy nie chroni przed niczym.
- **Limit 12 tur** w pętli agenta. Po przekroczeniu agent mówi, że przerwał, i
  pokazuje, co zdążył sprawdzić — nie improwizuje.
- Jeden agent, jedna skrzynka, jeden użytkownik. Brak tożsamości wielu
  użytkowników i delegacji — świadomie odłożone.

---

## 9. Decyzje należące do właściciela firmy — nie rozstrzygaj ich sam

1. **Która skrzynka** — firmowa czy prywatna właściciela.
2. **Czy dostawca daje konto tylko do czytania** — jeśli tak, użyć go.
3. **Jak długo trzymać log audytu** i czy na dysku. Log nie ma treści maili,
   ale ma numery zamówień i frazy wyszukiwania.
4. **Kto poza właścicielem może pytać agenta.** Dziś: kto ma dostęp do maszyny
   i `.env`. Jeśli więcej osób — tożsamość użytkownika wraca jako decyzja
   projektowa, a nie szczegół.
