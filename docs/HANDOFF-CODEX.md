# Handoff: AI Operator — brief dla kolejnego agenta

Dokument przekazania. Czytaj razem z `docs/AI-OPERATOR-MVP.md` (pełny opis,
w szczególności **sekcja 8 — Live validation**) i `docs/ARCHITEKTURA-AI-2026.md`
(dlaczego to wygląda tak, a nie inaczej).

**Nie rozszerzaj zakresu i nie projektuj niczego od nowa.**

---

## 0. Stan na dziś: LIVE DZIAŁA

Uruchomienie na prawdziwych danych firmy jest **zakończone**. Nie musisz go
powtarzać ani „dokańczać".

| element | wynik | gdzie |
| --- | --- | --- |
| `verify:teabrew` | **17/17** na produkcyjnych danych | 8.10 |
| `check:mail` | **11/11** na prawdziwej skrzynce (okno 7 dni) | 8.11 |
| `npm run triage` | działa na prawdziwej poczcie z prawdziwym modelem | 8.11 |
| tryb MCP (Claude jako model) | protokół przetestowany, 7 narzędzi z rejestru | 8.11 |
| testy | **68**, bez sieci i bez klucza API | — |

Trzy rzeczy, które musisz o tym wiedzieć, zanim czegokolwiek dotkniesz:

1. **Uruchomienie live odbywa się na maszynie właściciela, nie w środowisku
   agentowym.** Polityka egress typowej sesji w chmurze nie przepuszcza ani
   `imap.zenbox.pl` (TCP timeout na 993 i 143), ani wdrożenia Convex (proxy
   odrzuca CONNECT z 403). Zmierzone, nie założone — dowody w 8.9. Nie próbuj
   tego obchodzić; do uruchomienia u właściciela jest
   `ai-operator/scripts/live-setup.sh` (dopytuje tylko o brakujące wartości,
   sekrety bez echa, prawa 600, `--reset KLUCZ` do poprawienia literówki).

2. **Trasy ERP są wdrożone na żywym backendzie, choć `main` ich nie zawiera.**
   Build preview Vercela uruchamia `convex deploy` bez guardów produkcyjnych —
   te działają tylko przy `VERCEL_ENV === "production"`. PR
   [`teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27) jest
   **nadal otwarty**, a jego merge domyka rozjazd: gdyby ktoś zbudował produkcję
   z `main`, trasy zniknęłyby. Szczegóły i ocena ryzyka w 8.9 i w komentarzu na PR.

3. **Tryb MCP nie potrzebuje `ANTHROPIC_API_KEY`.** Modelem jest Claude po
   stronie klienta. Jeśli zobaczysz, że `npm run mcp` domaga się klucza — to
   regresja, bo warstwa modelu jest celowo leniwa.

---

## 1. Współrzędne

| co | gdzie |
| --- | --- |
| kod agenta | `bhtea-debug/nudge-chat`, gałąź `claude/ai-company-architecture-mvy1uv`, katalog `ai-operator/` |
| łatka ERP | `bhtea-debug/teabrew-v2`, gałąź `claude/ai-operator-read-only-endpoints`, baza `b777d4d` |
| PR do merge | `teabrew-v2#27` — `mergeable_state: clean`, brak GitHub Actions; jedyny automat to preview Vercela (i to on wdrożył funkcje) |
| klon roboczy właściciela | `~/nudge-chat-live/ai-operator` na jego Macu, z wypełnionym `.env` |

---

## 2. Dwa tryby. Nie mieszaj ich

| tryb | ścieżka | do czego | klucz API |
| --- | --- | --- | --- |
| **interaktywny** | `Claude → MCP → capabilities → Poczta/TeaBrew` | codzienna rozmowa człowieka z firmą | **nie** |
| **automatyczny** | `inbox-operator → API modelu → capabilities` | crony, nocne analizy, procesy bez człowieka | tak |

W trybie MCP **nie wołamy modelu u siebie**. Nie ma podwójnego wywołania,
podwójnego kosztu ani dwóch agentów podejmujących decyzje jednocześnie.
`inbox-operator` zostaje dla automatyzacji — nie podpinaj go pod MCP.

---

## 3. Ograniczenia, których nie wolno naruszyć

Każde jest wymuszone konstrukcyjnie i pokryte testem, który się wywali.

### 100% read-only

| gdzie | jak wymuszone |
| --- | --- |
| `src/capability/registry.ts` | `ALLOWED_EFFECTS = ["read"]` — capability z innym `effectClass` **nie da się zarejestrować** |
| `src/bin/mcp.ts` | osobny, jawny filtr `effectClass === "read"` przy `tools/list` **i** `tools/call` |
| `src/mail/types.ts` | `MailProvider` nie ma metody zapisu; w `src/mail/` nie ma linii SMTP |
| `src/mail/imap.ts` | `mailboxOpen(..., { readOnly: true })` — czytanie nie oznacza wiadomości jako przeczytanych |
| łatka ERP | wyłącznie `internalQuery`; zero mutacji, `scheduler`, `storage` |

Filtr w MCP jest **celowo redundantny** wobec rejestru: gdyby rejestr kiedyś
dopuścił capability zapisującą, nie może ona trafić do publicznego MCP przez
samo dodanie do rejestru.

Jeśli agent ma coś zrobić — **pisze sugestię, wykonuje człowiek**. Firma już raz
usunęła funkcję AI (Drive, „AI Organizuj"), bo pisała bez rozliczalności.

### Zasada „nie zgaduj"

`src/agent/evidence.ts`, trzy mechanizmy:

1. **Stopka dowodowa powstaje z logu audytu, nie od modelu.**
2. **Kontrola po fakcie** — twierdzenie o statusie, stanie, poczcie albo numerze
   zamówienia musi mieć odpowiadające mu **udane** wywołanie. Kody:
   `claim_without_any_erp_call`, `stock_claim_without_stock_call`,
   `mail_claim_without_mail_call`, `order_ref_never_checked`.
3. **Ostrzeżenie jest widoczne**; `npm run ask` kończy się **kodem 3**.

**Nie obchodź tej kontroli.** Fałszywy alarm → popraw detektor (jest kontekstowy,
nie oparty na czarnej liście jednostek) i dodaj test.

Po stronie danych: brak zamówienia to `matchedBy: "none"` (HTTP 200, nie 404),
nieznany kod to `unknownCodes` (**nie** stan zero), przycięty wynik to
`truncated: true`, niepełny wątek to `incomplete: true`. Nigdy cicho.

### Audyt

`ts`, `agent`, `capability`, `capabilityVersion`, `ok`, `latencyMs`,
`correlationId`, `refs`. W `refs` **wyłącznie identyfikatory i liczniki**.

**Nigdy:** treści maili, tematów, adresów nadawców, credentiali, tokenów.
Frazy wyszukiwania są logowane (bez nich audyt nie odpowiada na pytanie, czego
agent szukał), ale **adresy w nich są maskowane** przez `maskAddressesInText`.

W trybie MCP: **jedna korelacja na sesję**, nie na wywołanie — bo „co Claude
sprawdził, zanim odpowiedział" obejmuje całą rozmowę.

### Warstwa modeli po rolach

`fast` (klasyfikacja), `reason` (analiza). **W logice agenta nie ma ani jednego
identyfikatora modelu** — podmiana to `MODEL_FAST` / `MODEL_REASON` w `.env`.

### Czego NIE dodawać

Wysyłania maili, draftów, mutacji ERP, integracji z Budżecikiem/B2B/Drive, RAG,
vector DB, kolejnego agenta, PWA/iOS/Android, własnego chatu ani UI, cronów,
automatycznego porannego uruchamiania, centralnej bramy, SSO, nowych usług.

Świadoma decyzja: najpierw 1–2 tygodnie używania Claude jako gotowego
interfejsu, potem ewentualna decyzja o własnym UI — na podstawie realnych
potrzeb, nie przewidywania.

---

## 4. Miny, które już wybuchły — nie nadepnij ponownie

Wszystkie znalezione na prawdziwych danych. Wszystkie naprawione. Wszystkie
łatwe do wprowadzenia z powrotem.

### Schemat TeaBrew

- **`productionRunStatus` nie ma wartości `"running"`.** Prawdziwe:
  `pending | in_progress | paused | partially_done | done | cancelled`.
  Zapytanie o `"running"` **nie wywala się** — zwraca pustą listę, którą agent
  uczciwie zaraportuje jako „brak otwartych ruchów" przy pracującej hali.
  Kontrola dowodów tego nie wyłapie, bo wywołanie się odbyło. Na produkcji było
  **9 otwartych ruchów**. Test blokuje powrót `"running"`.
- **`"in_production"` nie jest statusem realizacji zamówienia.**
  `orderFulfillmentStatus` = `awaiting_payment | new | confirmed | in_picking |
  packed | shipped | delivered | cancelled`. O produkcji mówi powiązane
  `productionOrders.status === "in_progress"`.
  `productionOrderStatus` = `plan | draft | assigned | in_progress | done |
  cancelled` (`"planned"` nie istnieje).
- **`skus.gramatura` to liczba w gramach**, nie tekst. W kontrakcie
  `gramaturaG`, żeby to było widać. Potwierdzone na produkcji.
- **Materiał po kodzie MUSI iść przez `buildMaterialIndex`.** Dwa materiały mogą
  mieć ten sam `code`; kalkulator preferuje ten z tagiem `sku`. Naiwne „pierwszy
  o tym kodzie" opisze ilość jednego materiału nazwą i jednostką drugiego.
- **`convex codegen` jest ZABRONIONY** (może wysłać funkcje). Wpisy modułu
  w `convex/_generated/api.d.ts` dodawane **ręcznie**, w formie generowanej
  przez codegen. Wdrożenie tylko przez `npm run convex:live:deploy --
  --confirm=<wdrożenie>`. Przed edycją wykonaj kroki z `AGENTS.md` tamtego repo.

### Poczta

- **Nazwy folderu wysłanych nie wolno zgadywać.** Wykrywanie po atrybucie IMAP
  **SPECIAL-USE** `\Sent` (`src/mail/folders.ts`, `MAIL_THREAD_FOLDERS=auto`).
  Test pokrywa przypadek odwrotny do intuicji: folder o nazwie „Sent" **bez**
  atrybutu nie jest brany. Na Zenboxie wykrywa się przez `extension`.
- **`mailparser` zwraca `references` raz jako string, raz jako tablicę.**
  Normalizacja: `normalizeReferences()`.
- **Automaty wstawiają własny `Message-ID` do własnego `References`.** Realny
  przypadek: OpenERP/Odoo. Bez wykluczenia samej siebie taka wiadomość udaje
  odpowiedź z rodzicem w skrzynce, a poprawnie odtworzony wątek jednoelementowy
  wygląda jak usterka. Helper: **`parentRefsWithin`**.
  `normalizeReferences` świadomie NIE odsiewa autoreferencji — jej zadaniem jest
  wiernie oddać nagłówek; interpretacja należy do miejsca użycia.
- **Cytowana historia od `>` musi być odcinana** (`stripQuotedHistory`), inaczej
  model dostaje pięć poprzednich odpowiedzi jako nową treść.
- **Adapter MUSI mieć limity czasu.** `connectionTimeout`, `greetingTimeout`,
  `socketTimeout` oraz `acquireTimeout` na blokadach. `SEARCH BODY` na dużym
  folderze bez indeksu pełnotekstowego skanuje treść **każdej** wiadomości, a
  Dovecot potrafi przy tym odpowiadać na poziomie socketu — bez limitu narzędzie
  wisi bez komunikatu. Dlatego `search` nie odpala `SEARCH BODY`, jeśli nagłówki
  coś zwróciły, i mówi o tym w `searchNote`.
- **Nie pytaj osobno o każdą referencję wątku.** Pierwsza wersja wysyłała ~58
  zapytań na JEDEN wątek (29 referencji × 2 foldery, każde z osobną blokadą) i
  Zenbox rozłączył połączenie w trakcie. `maxMessages` ogranicza wynik, ale nie
  **pracę**. IMAP `SEARCH` ma kryterium `OR` — wszystkie `Message-ID` idą jednym
  zapytaniem na folder. Referencje bierz z **ogona** listy (`References` jest od
  najstarszej, więc najbliżsi przodkowie są na końcu).

### Klient MCP (Claude Desktop)

- **Aplikacja graficzna NIE daje procesowi tego, co daje `npm run`.** Katalog
  roboczy to `/`, środowisko nie ma nic z shella, `PATH` nie zawiera `npx`.
  Serwer, który wstaje pod `npm run mcp` i nie wstaje pod Claude Desktop, to
  norma, nie wyjątek.
- **Ścieżki relatywne z konfiguracji trzeba liczyć od katalogu pakietu.**
  `AUDIT_FILE=./.audit/calls.jsonl` przy katalogu roboczym `/` znaczy
  `/.audit/calls.jsonl`. `mkdirSync` w konstruktorze `MemoryAuditSink` rzucał
  wtedy EROFS/EACCES **przy imporcie modułu** — proces umierał przed odpowiedzią
  na `initialize`, a jedyne, co widział człowiek, to „Server disconnected".
  Helper: **`src/paths.ts` → `fromPackageRoot`**, stosowany do `AUDIT_FILE`
  i `FIXTURES_DIR`.
- **Start serwera nie może rzucać.** `createApp()` i `MemoryAuditSink` są
  w `try/catch`; błąd startu staje się czytelnym błędem JSON-RPC i wpisem na
  stderr, a `initialize` odpowiada **zawsze**. Przy zepsutej konfiguracji
  `tools/list` zwraca **błąd**, nie pustą listę — pusta lista znaczyłaby „nie ma
  narzędzi", a prawda jest „nie wiem, bo nie wstałem".
- **Utrata trwałego audytu degraduje do pamięci, ale nie po cichu** — komunikat
  na stderr. `write` był na to odporny od początku, konstruktor nie był.
- **`npm run mcp:doctor`** odtwarza uruchomienie z konfiguracji Claude Desktop
  w dwóch przebiegach: dokładnie jak we wpisie, oraz wrogo (`cwd=/`, minimalne
  env). Rozróżnia „nie wstaje wcale" od „wstaje tylko z właściwym katalogiem
  roboczym". Testy `tests/mcp-startup.test.ts` uruchamiają prawdziwy `mcp.ts`
  w tych warunkach — bo test jednostkowy na module, który przy imporcie robi
  robotę, tej klasy usterek nie złapie.

### Narzędzia diagnostyczne

- **Nie myl „brak danych" z „zepsute".** `check:mail` raportował jako porażki
  pusty folder wysłanych i wątek, którego rodzica nie ma w skrzynce. Narzędzie
  krzyczące na spokojnej skrzynce uczy właściciela ignorować czerwone krzyżyki —
  ten sam argument co przy kontroli dowodów.
- **Nie reimplementuj w sondzie tego, co diagnozujesz.** `probe:thread`
  wybierała ziarno po UID rosnąco, a `check:mail` po dacie malejąco — testowały
  dwa różne wątki, więc sonda rzetelnie odpowiadała na inne pytanie niż zadane.
  Sonda woła teraz **prawdziwy adapter**.

### Metoda

Przy usterce wątków postawiłem trzy hipotezy (format `Message-ID`, połykany
`catch` w `fetchByUids`, podmiana ziarna przez `uids.slice(-1)`). Wszystkie
rozsądne, wszystkie **błędne**. Rozstrzygnęły dopiero dane z sondy wołającej
prawdziwy adapter. Jeśli trafisz na coś podobnego — zbierz dane, nie poprawiaj
na wyczucie.

---

## 5. Mapa plików

```
ai-operator/
  src/capability/    rejestr (wymusza read), typy, audyt, projekcje
                     projections.ts: JSON Schema + OpenAPI + MCP z JEDNEJ definicji
  src/mail/          types.ts (MailProvider — brak metod zapisu)
                     imap.ts (adapter, readOnly, limity czasu, SEARCH OR)
                     fixture.ts, folders.ts (SPECIAL-USE), thread.ts, text.ts
  src/teabrew/       contract.ts (zod, JEDNO źródło prawdy), client.ts (HTTP + fixture)
  src/model/         roles.ts — fast / reason, zero ID modeli w logice, LENIWA
  src/agent/         operator.ts, triage.ts, prompt.ts, evidence.ts
  src/bin/           ask, triage, caps, openapi, mcp, check-mail, verify-teabrew,
                     probe-thread
  scripts/           live-setup.sh (uruchomienie live), install-claude-desktop-config.mjs,
                     mcp-doctor.mjs (diagnostyka startu serwera MCP)
  teabrew-patch/     źródło kontraktu ERP (założone jako PR #27)
  fixtures/          poczta (INBOX + Sent) i dane ERP — PRAWDZIWE enumy
  tests/             71 testów: scenariusze, jednostkowe, bezpieczeństwo łatki,
                     integralność adaptera MCP, start serwera MCP
  claude-desktop.example.json   konfiguracja MCP dla Claude Desktop
```

**Z jednej deklaracji capability** powstaje klient TypeScript, JSON Schema dla
function callingu, OpenAPI i lista narzędzi MCP. Dodając capability, dodaj ją
**tylko** w rejestrze.

MCP (`src/bin/mcp.ts`) jest **adapterem**: nie definiuje capability, nie dodaje
zależności (JSON-RPC po stdio), nie woła modelu po naszej stronie. Skasowanie go
nie psuje agenta. Sześć testów pilnuje, żeby nie stał się drugim systemem.

---

## 6. Testowanie bez sekretów

Wszystkie 68 testów działają **bez sieci i bez klucza API** — model jest atrapą
(`tests/helpers.ts`, `scriptedModel`), dane z fikstur.

```bash
cd ai-operator && npm install
npm run typecheck && npm test
npm run check:mail        # 11 sprawdzeń poczty na fiksturach, 11/11
npm run caps             # 7 capability, 0 zapisujących
```

Fikstury mają dwie właściwości, których nie psuj:

- **daty względne** (`{{-3h}}`, `{{+2d}}`) — inaczej okno `sinceDays` przestaje
  być testowane dzień po napisaniu testu,
- **statusy dokładnie z enumów źródłowego schematu**, nie „w tym stylu".
  Fikstura z wymyśloną wartością przechodzi przez `z.string()` i uczy agenta
  nieistniejącego słownictwa. To już raz się zdarzyło.

---

## 7. Co zostało do zrobienia

### Etap A — do potwierdzenia przez właściciela

Konfiguracja MCP jest gotowa (`claude-desktop.example.json`). Właściciel wkleja
wpis do `~/Library/Application Support/Claude/claude_desktop_config.json`,
restartuje Claude Desktop i wykonuje testy z punktu 7 zadania: poczta,
zamówienie, mail+TeaBrew, produkt, nieistniejące zamówienie.

**Nie zaczynaj Etapu B, dopóki A nie jest potwierdzone.**

### Etap B — dostęp zdalny, DECYZJA WŁAŚCICIELA

Rekomendacja: **nie budować własnego hostingu.** Najprostsza bezpieczna droga to
Convex jako broker MCP — to samo wdrożenie, które już trzyma token TeaBrew.
Jedna trasa `POST /mcp` po Streamable HTTP, autoryzowana osobnym tokenem per
urządzenie. HTTPS z pudełka, zero nowej infrastruktury, credentiale zostają
serwerowe, odebranie dostępu = usunięcie jednej zmiennej.

**Twardy problem: Convex nie ma dostępu do IMAP-a.** Z telefonu działałby więc
tylko TeaBrew. Stąd dwie opcje, wymagające wyboru właściciela:

- **B1 — tylko TeaBrew zdalnie.** Mała, oczywista zmiana w istniejącym
  wdrożeniu. Poczta zostaje lokalna.
- **B2 — pełny zakres.** Wymaga procesu z wyjściem na `imap.zenbox.pl`, czyli
  **pierwszej nowej usługi** w tym projekcie — wbrew dotychczasowej zasadzie.
  Wymaga jawnej zgody, nie domysłu.

Nie wybieraj za właściciela.

---

## 8. Otwarte obserwacje operacyjne

**Zasięg agenta w poczcie.** Pierwszy `triage` na prawdziwej skrzynce zwrócił
2 wiadomości z 24 godzin, obie niebiznesowe (automat rezerwacyjny i „wróciłem
z urlopu"). Skrzynka ma jednak **21 folderów**, w tym `FAKTURY`, `ROSSMANN`,
`NPD`, `INBOX.WHITE LABEL.*`. Jeśli reguły serwerowe przenoszą korespondencję
z klientami do podfolderów, agent czytający tylko `INBOX` będzie odpowiadał
prawdziwie, ale bezużytecznie.

To **decyzja właściciela** i dotyczy konfiguracji (`MAIL_FOLDER`), nie kodu.
Rozstrzygnie ją tydzień używania: jeśli odpowiedzi będą regularnie pomijać
sprawy, o których właściciel wie, że przyszły — wtedy wiadomo, które foldery
dołożyć i dlaczego. Nie rozszerzaj zasięgu bez tego dowodu.

**`shipmentReservationUncovered` niezerowe na realnym SKU.** Istnieją aktywne
rezerwacje wysyłkowe wskazujące partie wykluczone z profilu. Helper
`salesAvailability` celowo tego nie naprawia — tylko pokazuje. Zgłoszone
właścicielowi jako sygnał operacyjny; diagnoza przyczyny jest poza zakresem.

**Luka w guardach wdrożeniowych teabrew-v2.** Build preview uruchamia
`convex deploy` bez kontroli produkcyjnych. Zgłoszone w komentarzu na PR #27,
z sugestią domknięcia (rozszerzyć guardy na preview albo odciąć
`CONVEX_DEPLOY_KEY` od środowiska preview). **Nie domykaj tego bez zgody** — to
zmiana w produkcyjnej ścieżce wdrożeniowej.

---

## 9. Decyzje należące do właściciela — nie rozstrzygaj ich sam

1. **Merge PR #27** i domknięcie rozjazdu między `main` a wdrożeniem.
2. **Etap B: B1 czy B2** (patrz wyżej).
3. **Zasięg folderów poczty** — po tygodniu używania.
4. **Jak długo trzymać log audytu** i czy na dysku. Nie ma treści maili, ale ma
   numery zamówień i frazy wyszukiwania.
5. **Kto poza właścicielem może pytać agenta.** Dziś: kto ma dostęp do jego
   maszyny i `.env`. Przy większej liczbie osób tożsamość użytkownika wraca jako
   decyzja projektowa.
6. **Czy domykać lukę w guardach wdrożeniowych** teabrew-v2.
