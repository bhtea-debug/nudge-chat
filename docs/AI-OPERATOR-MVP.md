# AI Operator — MVP

**Agent:** `inbox-operator` · **Zakres:** przychodząca poczta + dane operacyjne
TeaBrew v2 · **Uprawnienia:** wyłącznie czytanie · **Kod:** `ai-operator/`

Podstawa: `docs/ARCHITEKTURA-AI-2026.md`. Ten dokument opisuje, co z tamtego
projektu zostało **zbudowane**, a co nie.

---

## 1. Co działa

### Ścieżka docelowa: poczta → AI → TeaBrew → odpowiedź

Agent dostaje pytanie, czyta pocztę, wyciąga z treści numery i nazwy, sprawdza
je w TeaBrew i odpowiada z danych, które faktycznie pobrał. Przykład z zadania —
mail „Co z zamówieniem 12345? Klient potrzebuje dostawy do środy.” — przechodzi
całą ścieżkę: `mail_search` → `mail_get_thread` (rekonstrukcja wątku z nagłówka
`References`, 3 wiadomości **z dwóch folderów** — dwa pytania klienta ze
skrzynki odbiorczej i nasza wcześniejsza odpowiedź z folderu wysłanych) →
`teabrew_get_order_status` (dopasowanie po `externalOrderId`, status realizacji
`confirmed`, powiązane zlecenie produkcyjne `in_progress`, pozycje) →
odpowiedź ze stopką dowodową. To jest scenariusz 2 w
`ai-operator/tests/scenarios.test.ts`.

### Dwa wejścia dla właściciela

```bash
npm run triage                 # przegląd poczty w pięciu kategoriach
npm run ask -- "pytanie"       # konkretne pytanie
```

`triage` odpowiada na trzy pytania naraz — co ważnego przyszło, co wymaga
odpowiedzi, kto czeka na decyzję — grupując pocztę w kategorie **Pilne /
Wymaga decyzji / Do odpowiedzi / Informacyjne / Można pominąć**. Dla spraw
pilnych i decyzyjnych dociąga status zamówienia z TeaBrew. Wiadomości, których
klasyfikacja nie objęła, trafiają do osobnej sekcji „Nieklasyfikowane” — nie
dostają kategorii na siłę.

### Siedem capability, wszystkie `read`

| capability | odpowiada na |
| --- | --- |
| `mail_list_recent` | co przyszło |
| `mail_search` | gdzie jest sprawa/numer/klient |
| `mail_get_thread` | co dokładnie ustalono w tym wątku |
| `teabrew_get_order_status` | co z zamówieniem |
| `teabrew_get_stock` | czy mamy towar / surowiec |
| `teabrew_find_product` | jaki kod ma to, o czym pisze klient |
| `teabrew_get_production_status` | jak wygląda produkcja |

Jedna deklaracja capability (`nazwa, opis, input, output, wersja, zakres,
effectClass`) generuje **klienta TypeScript, JSON Schema dla function callingu,
dokument OpenAPI i listę narzędzi MCP**. Nie ma drugiego miejsca opisującego tę
samą funkcję. `npm run openapi` i `npm run caps` produkują to z rejestru, bez
sekretów, więc działają w CI.

### Read-only jest wymuszone, nie obiecane

| Ograniczenie | Gdzie żyje |
| --- | --- |
| brak wysyłki maili | w `src/mail/` nie ma linii SMTP; `MailProvider` nie ma metody zapisu |
| brak oznaczania jako przeczytane | `mailboxOpen(..., { readOnly: true })` — serwer odmówi zmiany |
| brak mutacji TeaBrew | rejestr przyjmuje wyłącznie `effectClass: "read"`; łatka ERP to same `internalQuery` |
| granica zakresów | `registry.invoke` sprawdza `scope` przy każdym wywołaniu, także odrzuconym |

Capability zapisująca **nie da się zarejestrować** — rzuca `forbidden_effect`.
To jest test, nie deklaracja.

### „Nie zgaduj” jest wymuszone konstrukcyjnie

Trzy mechanizmy w `src/agent/evidence.ts`:

1. **Stopka dowodowa powstaje z logu audytu**, nie od modelu. Model nie ma jak
   dopisać wywołania, którego nie było.
2. **Kontrola po fakcie** skanuje odpowiedź: twierdzenie o statusie, stanie
   magazynowym, treści poczty albo numerze zamówienia musi mieć odpowiadające mu
   udane wywołanie. Wykrywane kody: `claim_without_any_erp_call`,
   `stock_claim_without_stock_call`, `mail_claim_without_mail_call`,
   `order_ref_never_checked`.
3. **Ostrzeżenie jest widoczne** dla człowieka w odpowiedzi; `npm run ask`
   kończy się kodem `3`.

Detektor numerów działa **kontekstowo** (liczba po słowie „zamówienie”,
„zlecenie”, „partia”, albo identyfikator z prefiksem literowym typu
`ZP-2026-0412`), a nie przez czarną listę jednostek. Świadomie: ostrzeżenie,
które krzyczy na „1200 opakowań”, zostanie zignorowane — a wtedy nie chroni
przed niczym.

Po stronie danych ta sama zasada: brak zamówienia to `matchedBy: "none"`,
nieznany kod to `unknownCodes`, przycięty wynik to `truncated: true`. Nigdy
zero, nigdy pusty rekord, nigdy ciche skrócenie.

### Audyt

Każde wywołanie zapisuje `ts`, `agent`, `capability`, `capabilityVersion`, `ok`,
`latencyMs`, `correlationId` i `refs`. `refs` zawiera **wyłącznie identyfikatory
i liczniki** — to, czego capability sama zadeklarowała w `auditRefs`. Test
sprawdza, że w logu nie ma tematów, treści ani adresów nadawców; identyfikatory
wiadomości są skrótowane (`messageIdHash`). Nieudane wywołania też zostawiają
wpis — z kodem błędu, nie z danymi.

`AUDIT_FILE=./.audit/calls.jsonl` daje trwały log JSONL. `npm run ask -- --trace`
pokazuje ślad od razu.

### Warstwa modeli po rolach

Dwie role: `fast` (klasyfikacja poczty) i `reason` (łączenie danych i pisanie
odpowiedzi). **W logice agenta nie występuje żaden identyfikator modelu** —
podmiana to zmiana `MODEL_FAST` / `MODEL_REASON` w `.env`. Ról `deep`, `vision`
i `embeddings` nie ma, bo nic w tym MVP ich nie potrzebuje, a rola bez wywołania
to martwy kod.

### Testy

68 testów, bez sieci i bez klucza API — model jest atrapą odgrywającą
zaplanowane kroki, dane pochodzą z fikstur. Pięć scenariuszy akceptacyjnych
odpowiada pięciu wymaganiom: read-only, ścieżka od maila do danych, brak
zmyślania, dostępność produktu z nazwy handlowej, użyteczność audytu bez
wycieku treści. Do tego testy jednostkowe warstwy poczty i projekcji oraz
12 testów bezpieczeństwa łatki ERP (patrz 8.3) i 6 testów integralności adaptera MCP.

Osobno, bez modelu: `npm run check:mail` (11 sprawdzeń warstwy poczty) i
`npm run verify:teabrew` (17 sprawdzeń wdrożonej łatki).

---

## 2. Czego nie ma

### Nie zostało zbudowane, bo nie było potrzebne w 7 dni

Centralnej bramy, firmowego SSO, szyny zdarzeń, frameworka agentowego,
megaagenta, RAG-u dla firmy, vector DB, panelu administracyjnego, platformy
promptów. Żadnej nowej usługi — `ai-operator` to katalog w istniejącym
repozytorium, uruchamiany komendą, bez wdrożenia i bez DevOps.

MCP jest **tylko adapterem** (`npm run mcp`, serwer stdio bez nowej zależności),
żeby te same siedem funkcji podłączyć w Claude Desktop bez pisania drugiej
integracji. Nie definiuje żadnej capability i nic od niego nie zależy —
skasowanie pliku nie psuje agenta.

### Uruchomienie na żywo — ZAKOŃCZONE

Pełne wyniki i lista usterek znalezionych po drodze: **8.11**. Skrót:
`verify:teabrew` 17/17 na produkcyjnych danych, `check:mail` 11/11 na prawdziwej
skrzynce, `npm run triage` działa na prawdziwej poczcie z prawdziwym modelem.

Uruchomienie odbywa się **na maszynie właściciela**, nie w środowisku
agentowym — to drugie nie ma trasy sieciowej ani do serwera poczty, ani do
wdrożenia Convex (dowody w 8.9), a sekrety mają zostać na komputerze właściciela.

Wszystko jest przy tym zbudowane **do interfejsów**, z dostawcami na fiksturach.
`MODE=fixture` przechodzi całą ścieżkę end-to-end bez żadnego sekretu;
`MODE=live` zmienia implementację dostawcy, nie narzędzia widziane przez AI.

**Co zostało sprawdzone, a co nie:**

| element | stan |
| --- | --- |
| rejestr, projekcje, audyt, kontrola dowodów, pętla agenta, triage | przetestowane, 68 testów przechodzi |
| ścieżka poczta → AI → TeaBrew na fiksturach | działa end-to-end |
| `npm run caps`, `npm run openapi` | uruchomione, dają 7 capability |
| konfiguracja → warstwa modeli → API Anthropic | potwierdzone (żądanie dociera, przy błędnym kluczu wraca 401) |
| odpowiedź prawdziwego modelu | **działa** — `triage` uruchomiony na prawdziwej skrzynce (8.11) |
| adapter IMAP wobec prawdziwego serwera | **działa** — 11/11 na prawdziwej skrzynce (8.11) |
| pięć tras w TeaBrew v2 | **wdrożone i potwierdzone** — 17/17 (8.10) |
| tryb MCP (Claude jako model) | protokół przetestowany, 7 narzędzi z rejestru, bez klucza API |

---

## 3. Jak jest podłączona poczta

**Generyczny IMAP, nie API konkretnego dostawcy.** Ta decyzja wynika z analizy
archiwalnych systemów: oba (`nudge-mail`, `teabrew-calendar`) czytały pocztę
przez `imapflow` + `mailparser`, z hostem i portem z konfiguracji. Nic nie było
przywiązane do dostawcy — i tak zostaje.

Warstwa jest niezależna od dostawcy w konkretnym, sprawdzalnym sensie:
kanonicznym identyfikatorem wiadomości jest RFC `Message-ID`, nie IMAP UID.
Rzeczy specyficzne dla dostawcy siedzą w nieprzejrzystym `providerRef`
(`imap:INBOX:1234`), którego AI nigdy nie interpretuje. **Zmiana hostingu
poczty to jedna nowa klasa implementująca `MailProvider` — narzędzia widziane
przez AI nie zmieniają się wcale.**

Konfiguracja (`MODE=live`): `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`,
`MAIL_IMAP_USER`, `MAIL_IMAP_PASSWORD`, `MAIL_FOLDER`, `MAIL_THREAD_FOLDERS`.
Wyłącznie ze zmiennych środowiskowych; w repozytorium nie ma żadnej wartości
sekretu, tylko `.env.example` z nazwami.

### Co odzyskano z archiwalnego Nudge Mail

Nie reanimowano aplikacji. Wyjęto wzorce:

| wzorzec | dlaczego akurat ten |
| --- | --- |
| `mailboxOpen(..., { readOnly: true })` | read-only na poziomie protokołu: czytanie nie oznacza wiadomości jako przeczytanych |
| `search({ header: { "Message-ID": … } })` | jedyny sposób dociągnięcia wiadomości wątku, których nie ma w oknie czasowym |
| envelope-first, potem `source` tylko dla nowych | drugi przebieg jest prawie darmowy |
| `fetch(uids.join(","), …, { uid: true })` | jedno zapytanie na wiele wiadomości |
| normalizacja `References` | **mailparser zwraca to raz jako string, raz jako tablicę** — archiwalny kod już się na tym potknął |

Świadomie **nie** przeniesiono: kolejek, Turso, stałych połączeń IMAP IDLE,
powiadomień push, wysyłki przez Resend. MVP odpytuje na żądanie — nie ma procesu,
który trzeba utrzymywać.

Szyfrowanie haseł AES-256-GCM z archiwalnego workera zostało przeanalizowane
i **nieużyte**: tam było potrzebne, bo hasła wielu skrzynek leżały w bazie.
Tutaj jest jedna skrzynka i hasło w `.env` z prawami `600`. Szyfrowanie z
kluczem w tym samym `.env` tylko przeniosłoby problem o jeden plik.

### Dwa ulepszenia względem archiwalnego kodu

**Odcinanie cytowanej historii.** Archiwalne skanery nie odcinały linii
zaczynających się od `>` — najczęstszego sposobu cytowania w ogóle. Model
dostawał więc pięć poprzednich odpowiedzi jako nową treść. Teraz
`stripQuotedHistory` odcina je, z zabezpieczeniem: jeśli po odcięciu zostałoby
mniej niż 20 znaków (wiadomość cytowana górą), zwracana jest całość.

**Rekonstrukcja wątku przez union-find.** Identyfikatorem wątku jest najstarsza
posiadana wiadomość, stabilnie i niezależnie od kolejności wejścia — a nie
`inReplyTo` pierwszej napotkanej wiadomości.

---

## 4. Jakie capability powstały

Pełna tabela: `npm run caps`. Projekcje: `npm run caps -- --tools` (JSON Schema),
`npm run openapi` (OpenAPI 3.0.3, 7 ścieżek `POST /capabilities/{name}`,
wszystkie z `bearerAuth` i `x-effect-class: read`).

Po stronie TeaBrew v2 odpowiada im pięć tras GET
(`ai-operator/teabrew-patch/`), nazwanych po konsumencie tak jak istniejące
`/medusa/*`, `/b2b/*`, `/budzeciek/*`:

```
GET /ai-operator/health
GET /ai-operator/order?ref=&limit=
GET /ai-operator/stock?codes=&profile=
GET /ai-operator/product-search?query=&limit=
GET /ai-operator/production?limit=&status=
```

Autoryzacja: `Authorization: Bearer <AI_OPERATOR_API_TOKEN>` z
`constantTimeTextEqual` — wzorzec skopiowany 1:1 z istniejących tras
`/budzeciek/*`. Token **osobny dla tego jednego konsumenta**, tak samo jak
npd-studio ma własny: odebranie agentowi dostępu to usunięcie jednej zmiennej
środowiskowej, bez wdrożenia i bez rotacji tokenów innych aplikacji.
Token nigdy nie trafia do URL — wyłącznie do nagłówka.

**Nie wystawiono „Convexa”.** TeaBrew v2 ma ponad sto tabel i kilkaset funkcji.
Agent widzi cztery pytania. Stan magazynowy liczy wspólny helper
`salesAvailabilityByCode` — ten sam, którego używa portal B2B i push do sklepu,
żeby agent nie podawał innych liczb niż portal.

---

## 5. Ograniczenia

**Twarde, wynikające z decyzji projektowej:**

- Agent nie wykonuje żadnego działania. Sugeruje; wykonuje człowiek. Wynika to
  wprost z historii firmy — funkcja „AI Organizuj” w aplikacji Drive została
  usunięta właśnie dlatego, że pisała bez rozliczalności.
- Brak SMTP, brak zmiany flag, brak mutacji ERP, brak dostępu do plików.
- Bez zaufania do treści maila jako źródła prawdy: to, co klient napisał, i to,
  co jest w systemie, są w odpowiedzi rozdzielone.

**Praktyczne, warte świadomości:**

- **Wyszukiwanie to IMAP SEARCH, nie wyszukiwarka.** Odpowiedź zawiera
  `searchNote` mówiące, co realnie objęło. Niektóre serwery odrzucają
  `SEARCH BODY`; wtedy pomijamy to kryterium, a nie całe wyszukiwanie.
- **Rekonstrukcja wątku widzi tylko skonfigurowane foldery.** Bez `Sent`
  w `MAIL_THREAD_FOLDERS` agent nie zobaczy naszych własnych odpowiedzi i może
  uznać, że nikt nie odpisał.
- **Klasyfikacja triage nie jest deterministyczna.** Nieparsowalna odpowiedź
  modelu nie udaje, że się udała — wszystkie wiadomości idą do
  „Nieklasyfikowane”.
- **`teabrew_get_order_status` skanuje wszystkie zamówienia**, bo indeks
  `by_external` jest złożony `(source, externalOrderId)`, a źródła z maila nie
  znamy. Przy obecnej skali to tańsze niż zapytanie po każdym źródle; przy
  wielokrotnie większym zbiorze będzie wymagało indeksu po samym numerze.
- **Kontrola dowodów jest heurystyką.** Łapie twierdzenia w typowej polszczyźnie
  i numery w kontekście referencyjnym. Nie wyłapie wszystkiego i celowo woli
  przepuścić niejasny przypadek niż krzyczeć na każdą liczbę.
- **Limit 12 tur** w pętli agenta. Po przekroczeniu agent mówi, że przerwał,
  i pokazuje, co zdążył sprawdzić — nie improwizuje odpowiedzi.
- Jeden agent, jedna skrzynka, jeden użytkownik. Brak tożsamości wielu
  użytkowników i delegacji uprawnień — świadomie odłożone.

---

## 6. Następne pięć kroków

**1. Założyć łatkę w TeaBrew v2 i przełączyć na dane produkcyjne.**
`ai-operator/teabrew-patch/README.md`, potem `npm run verify:teabrew` (9
sprawdzeń, w tym negatywne). Dopóki nie przechodzą wszystkie — nie włączać
`MODE=live`. To jedyny krok, który dzieli MVP od pracy na prawdziwych danych.

**2. Podłączyć skrzynkę na koncie tylko do czytania.** Osobne dane dostępowe
albo hasło aplikacji z uprawnieniem wyłącznie do odczytu, jeśli dostawca to
umożliwia. Dodać `Sent` do `MAIL_THREAD_FOLDERS` — bez tego agent nie widzi
naszych odpowiedzi. Pierwszy tydzień z `AUDIT_FILE`, żeby po tygodniu dało się
odpowiedzieć, czego agent naprawdę szukał i co odpowiadał.

**3. Zebrać rozbieżności z tygodnia i naprawić to, co naprawdę zawiodło.**
Kod wyjścia `3` z `npm run ask` i pole `findings` dają listę przypadków, w
których kontrola dowodów coś zgłosiła. Ta lista jest jedyną wiarygodną podstawą
do stwierdzenia, czy agent zmyśla i gdzie. Wcześniejsze zgadywanie, co poprawić
w promptcie, byłoby zgadywaniem.

**4. Dodać pierwsze działanie z zatwierdzeniem — przygotowanie odpowiedzi, bez
wysyłki.** Nowa klasa efektu (`write-reversible`) obok istniejącej `read`:
agent przygotowuje szkic odpowiedzi jako plik lub kopię do schowka, człowiek go
czyta, poprawia i wysyła sam ze swojego klienta poczty. Rejestr już to
przewiduje w typie `EffectClass` — trzeba rozszerzyć `ALLOWED_EFFECTS` i dodać
jawną bramkę zatwierdzenia. **Nie wcześniej niż po kroku 3**: dopuszczanie
zapisów, zanim wiadomo, jak często agent się myli, powtórzyłoby historię „AI
Organizuj”.

**5. Rozstrzygnąć, czy uruchomienie ma być regularne, i wtedy dopiero wybrać
gdzie.** Jeśli `triage` okaże się użyteczny co rano, warto go uruchamiać
automatycznie. Wtedy — i tylko wtedy — decyzja: cron w TeaBrew v2 (Convex już
ma crony, zero nowej infrastruktury) czy osobne małe wdrożenie. Dziś to
komenda, którą uruchamia człowiek, i to wystarcza.

**Czego w tych krokach świadomie nie ma:** vector DB, RAG-u nad pocztą,
drugiego agenta, panelu web. Każde z nich odpowiada na pytanie, którego jeszcze
nie zadano — a po kroku 3 będzie wiadomo, które z nich firma faktycznie ma.

---

## 7. Decyzje wymagające właściciela firmy

Tylko rzeczy, których nie da się wyczytać z kodu, historii ani infrastruktury:

1. **Która skrzynka.** Wspólna firmowa czy prywatna właściciela? Od tego zależy,
   czyją korespondencję agent widzi i czy w ogóle jest tam to, o co właściciel
   pyta.
2. **Czy dostawca poczty daje konto tylko do czytania.** Jeśli tak — użyć go.
   Jeśli nie — świadoma zgoda na hasło aplikacji z pełnymi uprawnieniami, przy
   czym kod i tak nie ma czym wysłać maila.
3. **Jak długo trzymać log audytu** i czy zapisywać go na dysk. Log nie zawiera
   treści maili, ale zawiera numery zamówień i frazy wyszukiwania.
4. **Kto poza właścicielem może pytać agenta.** Dziś: kto ma dostęp do maszyny
   i `.env`. Jeśli ma to być więcej osób, tożsamość użytkownika przestaje być
   szczegółem i wraca jako decyzja projektowa.

---

## 8. Live validation

Etap przejścia z fikstur na prawdziwe dane firmy. Ta sekcja rozdziela to, co
**faktycznie uruchomiono**, od tego, co jest **zablokowane** i na czym.

### 8.1 Stan: uruchomienie na żywo NIE nastąpiło

Trzy rzeczy blokują `MODE=live` i żadnej z nich nie da się obejść z tego
środowiska. Nie są to problemy techniczne — to brakujące uprawnienia i wartości.

| blokada | stan |
| --- | --- |
| łatka w TeaBrew v2 | **kod założony i wypchnięty**, PR [`bhtea-debug/teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27) na gałęzi `claude/ai-operator-read-only-endpoints`. Czeka na merge, ustawienie `AI_OPERATOR_API_TOKEN` w zmiennych Convex i wdrożenie. Wdrożenie na żywe Convex idzie **wyłącznie** przez `npm run convex:live:deploy -- --confirm=<wdrożenie>` — `AGENTS.md` w TeaBrew celowo stawia tu bramkę dla człowieka i nie jest to coś do obejścia |
| brak danych dostępowych do skrzynki | host, port, login i hasło aplikacji nie istnieją w tym środowisku |
| brak klucza API modelu | `ANTHROPIC_API_KEY` nie jest ustawiony |

W konsekwencji **żaden** z testów z listy Definition of Done wymagających
żywych danych nie został wykonany: `verify:teabrew` przeciw wdrożeniu,
`check:mail` przeciw serwerowi, `triage` i `ask` na prawdziwej skrzynce,
korelacja mail ↔ zamówienie, test produktu, przypadek „nie znaleziono" na
prawdziwych danych. Nie deklaruję ich jako działających.

To, co **zostało** zrobione, to doprowadzenie kodu do stanu, w którym po
podaniu trzech brakujących wartości uruchomienie jest kwestią czterech komend —
oraz wyłapanie błędów, które inaczej wyszłyby dopiero na produkcji.

### 8.2 Weryfikacja łatki wobec aktualnego TeaBrew v2 — wykonana

Łatka została porównana z `teabrew-v2` na `main` (`b777d4d`). **Nie została
skopiowana mechanicznie** — i słusznie, bo zawierała cztery realne rozjazdy:

| rozjazd | skutek na produkcji, gdyby wszedł |
| --- | --- |
| `gramatura` czytana jako tekst, w schemacie `v.optional(v.number())` | każde wyszukanie produktu z ustawioną gramaturą łamałoby kontrakt i wracało jako błąd |
| zapytanie o `productionRuns.status === "running"` — takiego statusu **nie ma** w schemacie (`pending\|in_progress\|paused\|partially_done\|done\|cancelled`) | zero wierszy **zawsze**. Agent raportowałby „nic się nie produkuje" przy pracującej hali. Cicho fałszywa odpowiedź, najgorszy możliwy błąd w tym systemie |
| własne dopasowanie materiału po `code`, gdy kalkulator dostępności preferuje materiał z tagiem `sku` | ilość jednego materiału opisana nazwą i jednostką drugiego — liczba o czymś innym, niż mówi napis obok |
| `ctx: { db: any }` zamiast `QueryCtx` z `_generated/server` | brak kontroli typów dokładnie tam, gdzie chroni przed powyższymi |

Przy okazji poprawiono fikstury, które zawierały statusy nieistniejące w
schemacie (`in_production` jako status realizacji zamówienia, `planned` jako
status zlecenia). To był mój błąd rozumienia domeny: **„zamówienie jest w
produkcji" nie wynika z `orderFulfillmentStatus`** (ten ma wartości
`awaiting_payment | new | confirmed | in_picking | packed | shipped | delivered
| cancelled`), tylko z powiązanego `productionOrders.status === "in_progress"`.
Fikstura z wymyślonym statusem uczyła agenta nieistniejącego słownictwa.

Co potwierdzono pozytywnie:

- **Całe repozytorium TeaBrew v2 przechodzi `npx tsc --noEmit` z założoną
  łatką — zero błędów**, po pełnym `npm ci`. To weryfikuje każdą nazwę pola,
  każdą nazwę indeksu (`by_order`, `by_sales_order`, `by_status`), każdą
  sygnaturę helpera i integrację z 949-linijkowym wygenerowanym `api.d.ts`.
  Wymagane kroki z `AGENTS.md` wykonano przed edycją: czysty worktree,
  `HEAD == origin/main`, `git fetch origin main`.
- **Wpisy w `convex/_generated/api.d.ts` dodane ręcznie**, dokładnie w formie
  i kolejności generowanej przez codegen (jeden import, jeden wpis w mapie,
  alfabetycznie). `AGENTS.md` zabrania uruchamiania `convex codegen` przy
  środowisku wskazującym na żywy backend, bo codegen może też **wysłać
  funkcje**. Przy najbliższym `npx convex dev` plik zregeneruje się identycznie.
- `next lint` nie jest w tym repo skonfigurowany (pyta interaktywnie o setup
  ESLint), więc nie był bramką. Playwright (`npm test`) nie był uruchamiany —
  wymaga działającej aplikacji i danych.
- **Wykorzystuje istniejące helpery domenowe.** Stan liczy
  `salesAvailabilityByCode`, ten sam, którego używa portal B2B i push do sklepu.
  Materiał wybiera `buildMaterialIndex`, ten sam, którego użył kalkulator.
  Autoryzacja to `constantTimeTextEqual` i `jsonResponse` już obecne w `http.ts`.
- **Jest read-only i to jest testowane**, nie obiecane —
  `tests/patch-security.test.ts`, 12 testów.

### 8.3 Bezpieczeństwo — zweryfikowane testami, nie deklaracją

`tests/patch-security.test.ts` czyta pliki łatki i sprawdza:

- brak `internalMutation`, `mutation(`, `action(`, `ctx.db.insert/patch/replace/delete`,
  `ctx.scheduler`, `ctx.storage`;
- wszystkie cztery eksporty to `internalQuery`, nie publiczne `query` —
  publiczne `query` byłoby wywoływalne przez każdego, kto zna adres wdrożenia,
  **bez naszego tokenu**;
- brak `v.any()` w argumentach i brak dynamicznej nazwy tabeli — agent nie ma
  jak wykonać dowolnego zapytania;
- zamknięta lista czytanych tabel: `orders`, `orderItems`, `skus`, `materials`,
  `productionOrders`, `productionRuns`;
- wyłącznie metody `GET`, dokładnie pięć zadeklarowanych ścieżek;
- autoryzacja **przed** jakimkolwiek `ctx.runQuery` w każdej trasie;
- token czytany tylko z nagłówka `Authorization`, nigdy z query stringu;
- fail-closed: brak `AI_OPERATOR_API_TOKEN` w środowisku daje 500, nie przejście;
- `console.error` nie zawiera żądania, URL-a ani tokenu;
- odpowiedź **nie** zawiera e-maila, telefonu ani adresu dostawy klienta —
  do odpowiedzi na pytanie z maila wystarcza nazwa.

`npm run verify:teabrew` sprawdza te same rzeczy z zewnątrz, na wdrożeniu:
17 sprawdzeń, w tym brak tokenu na każdej z pięciu tras, token w URL (musi być
bezsilny), metody zapisu i sondowanie nieudokumentowanych ścieżek
(`/ai-operator/query`, `/ai-operator/db`, …).

W audycie doszło jedno wzmocnienie wymuszone wymogiem „nie zapisuj adresów
nadawców": fraza wyszukiwania jest logowana (bez niej audyt nie odpowiada na
pytanie, czego agent szukał), ale **adresy w niej są maskowane** —
`m***@domena.example`. Model może szukać po adresie nadawcy, więc bez tego
adresy trafiałyby do logu.

### 8.4 Folder wysłanych — rozwiązany bez zgadywania nazwy

Nazwa folderu wysłanych **nie jest zgadywana**. `MAIL_THREAD_FOLDERS=auto`
(nowa wartość domyślna) wykrywa go po atrybucie IMAP **SPECIAL-USE** `\Sent`.
ImapFlow rozwiązuje ten atrybut trzema drogami — z podpowiedzi, z rozszerzenia
SPECIAL-USE/XLIST serwera, oraz przez dopasowanie znanych nazw zlokalizowanych —
i podaje w `specialUseSource`, skąd wziął wynik.

`src/mail/folders.ts` buduje z tego plan folderów i **ostrzega** w trzech
sytuacjach: serwer nie wskazał `\Sent`; jawna lista pomija wskazany przez serwer
folder wysłanych; jawna lista wskazuje folder, którego na serwerze nie ma
(taki byłby po cichu pomijany).

Testy pokrywają w szczególności przypadek odwrotny do intuicji: folder o
nazwie „Sent", ale **bez** atrybutu `\Sent`, nie jest brany. Zgadywanie po
nazwie kazałoby go użyć.

Fikstury zostały rozszerzone o folder `Sent` z dwiema naszymi odpowiedziami,
więc ta ścieżka jest **testowana**, a nie tylko napisana: wątek zamówienia
12345 ma teraz 3 wiadomości i przechodzi przez oba foldery. Bez tego agent
widziałby dwa pytania klienta i mógłby uznać, że nikt nie odpisał — a odpisano.

### 8.5 Testy bez modelu — dodane i przechodzą na fiksturach

`npm run check:mail` — 11 sprawdzeń warstwy poczty, **bez wołania modelu**:
połączenie, wykrycie folderu wysłanych, listowanie, pobranie treści,
wyszukiwanie, rekonstrukcja wątku, widoczność folderu wysłanych, polskie znaki,
zamiana HTML na tekst, `References`/`In-Reply-To`, metadane załączników.

Na fiksturach przechodzi 11/11 — to znaczy, że **sam checker działa**, więc
porażka na prawdziwej skrzynce będzie prawdziwym problemem, a nie błędem
narzędzia. Uruchamia się identycznie dla obu dostawców (sprawdzenie strukturalne,
nie `instanceof`), więc nie jest to ścieżka testowana tylko na produkcji.

Ochrona danych w logach checkera: adresy maskowane (`z***@domena.example`),
tematy przycinane do 48 znaków, treści **nigdy** nie wypisywane — raportowane
są tylko właściwości: długość, które diakrytyki wystąpiły, czy po normalizacji
zostały znaczniki HTML. Komunikaty błędów IMAP też przechodzą przez maskowanie,
bo zawierają nazwę konta.

`npm run preflight` = `typecheck && test && check:mail && verify:teabrew` —
jedna komenda przed pierwszym uruchomieniem na żywo.

### 8.6 Problemy, które wyszły dopiero przy tej weryfikacji

Wszystkie cztery rozjazdy z 8.2 to problemy, których nie widać na fiksturach —
fikstura zwracała to, co sama deklarowała, więc kontrakt się zgadzał sam ze sobą.
Wyszły dopiero z porównania z prawdziwym `schema.ts`. Dwa z nich są pouczające:

- **Status, którego nie ma, nie jest błędem — jest ciszą.** Zapytanie o
  `"running"` nie wywala się. Zwraca pustą listę, którą agent uczciwie
  zaraportuje jako „brak otwartych ruchów produkcyjnych". Nie ma tu żadnego
  sygnału, że coś jest nie tak. Kontrola dowodów tego nie wyłapie, bo wywołanie
  faktycznie się odbyło i faktycznie zwróciło ten wynik. Jedyną obroną było
  porównanie ze schematem.
- **Fikstura może uczyć nieprawdziwego słownictwa.** `in_production` brzmiało
  sensownie i przeszło przez `z.string()`. Gdyby weszło na produkcję, agent
  szukałby statusu, którego nigdy nie zobaczy, i opisywałby produkcję na
  podstawie złego pola.

Wniosek na przyszłość, już zastosowany: fikstury muszą używać **dokładnie**
wartości z enumów źródłowego schematu, a nie wartości „w tym stylu".

### 8.7 Czego brakuje, żeby dokończyć — dla właściciela

Trzy wartości i jedno uprawnienie. Nic z tego nie może trafić do repozytorium
ani na czat.

1. **Merge PR-a i wdrożenie łatki.** Kod jest gotowy w
   [`teabrew-v2#27`](https://github.com/bhtea-debug/teabrew-v2/pull/27). Po
   review i merge trzeba:
   - wygenerować `AI_OPERATOR_API_TOKEN` (min. 32 losowe znaki) i ustawić go
     **w zmiennych środowiskowych Convex**, nie w żadnym pliku w repo,
   - wdrożyć przez `npm run convex:live:check`, a potem
     `npm run convex:live:deploy -- --confirm=<nazwa-wdrożenia>`, zgodnie z
     `AGENTS.md` i `docs/DEPLOYMENT_SAFETY.md` w TeaBrew.

   Bez tokenu trasy zwracają 500 (fail-closed), więc kolejność „najpierw token,
   potem wdrożenie" nie ma znaczenia dla bezpieczeństwa — ma tylko dla tego,
   czy `verify:teabrew` od razu przejdzie.
2. **Dane skrzynki** — host IMAP, port (zwykle 993), login, oraz **hasło
   aplikacji** (nie hasło główne). Jeśli dostawca umożliwia konto lub hasło
   aplikacji z prawem tylko do odczytu — użyć go. Jeśli nie umożliwia, kod i tak
   pozostaje read-only: skrzynka otwierana jest przez
   `mailboxOpen(..., { readOnly: true })`, nie ma SMTP, nie ma zmiany flag,
   nie ma delete/move/archive.
3. **Klucz API modelu** — `ANTHROPIC_API_KEY`.

Punkty 2 i 3 ustawia się w **jednym miejscu**: plik `ai-operator/.env`
(`cp .env.example .env && chmod 600 .env`). Ten plik jest w `.gitignore` i
nigdy nie wchodzi do repozytorium. Token z punktu 1 idzie do zmiennych
środowiskowych Convex po stronie TeaBrew, a jego kopia do `.env` jako
`TEABREW_AI_OPERATOR_TOKEN` (plus `TEABREW_BASE_URL` — baza HTTP actions
wdrożenia).

Żadna z tych wartości nie należy do czatu ani do dokumentacji.

Potem, w tej kolejności:

```bash
cd ai-operator
npm run verify:teabrew          # ERP, bez modelu — musi przejść w całości
MODE=live npm run check:mail    # poczta, bez modelu — musi przejść w całości
MODE=live npm run triage        # dopiero teraz model
MODE=live npm run ask -- --trace "Co ważnego przyszło dzisiaj?"
```

Jeśli którykolwiek z pierwszych dwóch kroków nie przechodzi — nie włączać
modelu. Przyczyna jest po stronie danych albo konfiguracji, a nie AI, i model
tego nie naprawi, tylko przykryje.

### 8.8 Rekomendowane następne kroki

1. **Dokończyć uruchomienie według 8.7.** Nic z poniższych nie ma sensu przed tym.
2. **Pierwszy tydzień z włączonym `AUDIT_FILE`** (już domyślnie w `.env.example`).
   Bez trwałego logu po tygodniu nie da się odpowiedzieć, czego agent naprawdę
   szukał — a to jest jedyna wiarygodna podstawa do oceny, czy zmyśla.
3. **Zebrać przypadki, w których kontrola dowodów zgłosiła problem** (kod wyjścia
   `3` z `npm run ask`, pole `findings`). Ta lista, a nie wrażenie z demonstracji,
   mówi, co poprawić.
4. **Sprawdzić, czy `orderByRef` wystarcza na prawdziwym wolumenie.** Dopasowanie
   po `externalOrderId` idzie pełnym skanem zamówień, bo indeks `by_external`
   jest złożony `(source, externalOrderId)`, a źródła z maila nie znamy. Przy
   obecnej skali to tańsze niż zapytanie po każdym źródle; jeśli czasy z audytu
   (`latencyMs`) zaczną rosnąć, właściwą odpowiedzią jest indeks po samym numerze
   — a nie cache po stronie agenta.
5. **Nie rozszerzać zakresu, dopóki punkty 2–3 nie dadzą wniosków.** Draftów
   odpowiedzi, mutacji ERP, cronów, kolejnego agenta ani panelu w tym etapie
   nie ma i nie powinno być. Kolejność „najpierw dowód, że działa, potem
   uprawnienia" jest tu celowa — firma już raz usunęła funkcję AI, która pisała
   bez rozliczalności.

### 8.9 Ustalenia z próby uruchomienia `MODE=live`

Dwa fakty ustalone empirycznie przy próbie uruchomienia. Oba zmieniają plan
z 8.7, więc są tu zapisane zamiast poprawiania go w miejscu.

#### Środowisko agenta nie ma dostępu sieciowego do poczty ani do Convex

Polityka egress tej sesji przepuszcza GitHub, npm i `api.anthropic.com`.
Nie przepuszcza serwera poczty ani wdrożenia Convex firmy:

| host | wynik |
| --- | --- |
| `api.anthropic.com:443` | osiągalny (HTTP 401 bez klucza — czyli połączenie działa) |
| `github.com:443` | osiągalny |
| `imap.zenbox.pl:993` | DNS rozwiązuje się, TCP **timeout** |
| `imap.zenbox.pl:143` | TCP **timeout** |
| wdrożenie Convex, `:443` | proxy odrzuca CONNECT z **403** (`connect_rejected`, policy denial) |

Wniosek: **`MODE=live` nie może zostać uruchomiony z tej sesji** — ani
`check:mail`, ani `verify:teabrew`. Nie jest to brak sekretów, tylko brak
trasy sieciowej. Podanie hasła do skrzynki w tym środowisku nie dałoby nic
poza wyniesieniem sekretu do kontenera, który i tak nie ma jak się połączyć.

Właściwym miejscem uruchomienia `MODE=live` jest **maszyna właściciela**:
ma dostęp do jednego i drugiego hosta, a hasło do skrzynki nigdy nie opuszcza
jego komputera. Rozszerzanie polityki sieciowej tego środowiska byłoby
rozwiązaniem gorszym — wymagałoby wstawienia hasła do efemerycznego kontenera.

Wszystko, co da się sprawdzić bez sieci, jest sprawdzone: 56 testów,
`tsc --noEmit` w obu repozytoriach, `check:mail` 11/11 na fiksturach.

#### Build preview na Vercelu uruchamia `convex deploy` bez guardów produkcyjnych

`scripts/safe-build.mjs` w teabrew-v2 ma silne kontrole — zgodność
`NEXT_PUBLIC_CONVEX_URL`, zakres `CONVEX_DEPLOY_KEY`, gałąź tylko `main` —
ale **wyłącznie w bloku `isVercel && isProduction`** (`VERCEL_ENV === "production"`).
Build preview nie wchodzi w ten blok i dochodzi do ostatniej instrukcji pliku:

```
convex deploy --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd "next build"
```

Bot Vercela zaraportował na PR #27 preview jako **Ready**, czyli
`convex deploy` zakończył się sukcesem, czyli miał działający klucz wdrożeniowy.
Zgodnie z `AGENTS.md` klucz jest scope'owany na to samo wdrożenie, którego
używa live frontend — więc funkcje z PR-a **najprawdopodobniej są już na żywym
backendzie**, bez przejścia przez `npm run convex:live:deploy`.

Co to znaczy praktycznie:

- **Nie ma tu wycieku danych.** Trasy są fail-closed: dopóki
  `AI_OPERATOR_API_TOKEN` nie jest ustawiony w zmiennych Convex, każde żądanie
  dostaje 500, niezależnie od nagłówka.
- **Zdanie „ten PR niczego nie wdraża" w opisie PR-a było nieprawdziwe.**
  Poprawione w opisie PR-a.
- **To luka w modelu bezpieczeństwa wdrożeń, nie skutek tej zmiany.** Każdy PR
  do tego repo zachowuje się tak samo. Ten PR tylko to ujawnił.
- Weryfikacja wymaga jednej komendy z maszyny mającej dostęp do wdrożenia:
  `curl -s -o /dev/null -w "%{http_code}" <baza-http-actions>/ai-operator/health`.
  `404` = niewdrożone, `500` = wdrożone bez tokenu, `401` = wdrożone z tokenem.

Jeśli funkcje faktycznie są już wdrożone, z kroku 1 w 8.7 zostaje **tylko**
ustawienie `AI_OPERATOR_API_TOKEN` w zmiennych Convex — `convex:live:deploy`
nie jest potrzebne. To warto ustalić przed czymkolwiek innym.

Osobno, poza zakresem tego zadania, warto rozważyć domknięcie luki: albo
rozszerzyć guardy `safe-build.mjs` na buildy preview, albo odciąć
`CONVEX_DEPLOY_KEY` od środowiska preview na Vercelu. Nie robię tego tutaj —
to zmiana w ścieżce wdrożeniowej produkcji, a zadanie brzmiało „nie obchodź
istniejących zabezpieczeń deploymentu", nie „przepisz je".

### 8.10 Pierwsze uruchomienie na prawdziwych danych — TeaBrew potwierdzony

Uruchomione **na maszynie właściciela**, przez `ai-operator/scripts/live-setup.sh`.
Poniżej wyłącznie to, co faktycznie przeszło. Bez numerów zamówień, kodów SKU
i ilości — to repozytorium jest publiczne.

#### `AI_OPERATOR_API_TOKEN` — ustawiony, potwierdzony z zewnątrz

`/ai-operator/health` bez nagłówka autoryzacji zwraca **401**. Wcześniej zwracał
500 z `AI_OPERATOR_API_TOKEN not configured`, co potwierdziło zarówno że trasy
są wdrożone, jak i że fail-closed działa.

Dwie pułapki, na które warto uważać przy powtarzaniu tej konfiguracji:

- zmienną trzeba ustawić na **tym** wdrożeniu, którego używa live frontend
  (w Convexie figuruje jako *Development*), a nie na produkcyjnym wdrożeniu
  projektu. `AGENTS.md` w TeaBrew ostrzega o tym wprost;
- zmienna może już istnieć z **pustą wartością** — dashboard odpowiada wtedy
  „Environment variable name is not unique" na próbę dodania, a endpoint nadal
  raportuje „not configured", bo kod traktuje pusty string jak brak. Trzeba
  użyć **Edit**, nie *Add*.

#### `verify:teabrew` — 17/17 przeszło na produkcyjnych danych

Wszystkie cztery grupy, w tym testy pozytywne na realnych rekordach z wartościami
odkrytymi z systemu:

| grupa | wynik |
| --- | --- |
| bezpieczeństwo (5) | brak tokenu odrzucony na **każdej z pięciu tras**; zły token odrzucony; token w query stringu bezsilny; POST/PUT/PATCH/DELETE nieobsługiwane; brak nieudokumentowanych tras `/ai-operator/*` |
| kontrakt (5) | kształt każdej odpowiedzi zgodny ze schematem zod; walidacja parametrów zwraca 400 |
| brak danych (3) | nieistniejące zamówienie → `matchedBy: "none"` przy HTTP 200; nieistniejący kod → `unknownCodes`, nie stan zero; nieistniejący produkt → `totalCount: 0` |
| prawdziwe dane (4) | realne zamówienie dopasowane po `externalOrderId` wraz z pozycjami i powiązanym zleceniem produkcyjnym; realny SKU znaleziony w katalogu; stan policzony z nazwą materiału; oba profile (`finished_goods`, `all_locations`) dają wynik |

Trzy rzeczy, które te dane potwierdziły merytorycznie:

1. **Poprawka `gramatura` była konieczna i poprawna.** Realny SKU zwrócił
   gramaturę jako **liczbę**. Wersja czytająca ją jako tekst wywaliłaby kontrakt
   na pierwszym wyszukaniu produktu.
2. **Poprawka statusu ruchów produkcyjnych była konieczna.** Endpoint zwrócił
   **dziewięć otwartych ruchów**. Wersja pytająca o nieistniejący status
   `"running"` zwróciłaby zero i agent zaraportowałby „nic się nie produkuje"
   przy dziewięciu ruchach w toku — cicho fałszywa odpowiedź, bez żadnego błędu.
3. **`shipmentReservationUncovered` nie jest polem teoretycznym.** Dla realnego
   SKU wyszło **niezerowe**: istnieją aktywne rezerwacje wysyłkowe wskazujące
   partie wykluczone z profilu, które nie zabierają stanu z puli, ale nadal są
   otwarte. Helper `salesAvailability` celowo tego nie naprawia ani nie zwalnia —
   tylko pokazuje. Zgłoszone właścicielowi jako sygnał operacyjny; diagnoza
   przyczyny jest poza zakresem tego zadania.

#### `check:mail` — nie przeszedł, pierwszy krok

Połączenie z `imap.zenbox.pl:993` nie zostało nawiązane. Przy tej okazji
wyszła **wada mojego własnego narzędzia diagnostycznego**, naprawiona:

`ImapFlow.connect()` obejmuje także logowanie, więc odrzucone hasło i
nieosiągalny host wychodziły tym samym `catch` i dawały ten sam komunikat
„nie udało się połączyć". Dla narzędzia, którego cała rola to diagnoza, to jest
wada poważna: przy złym haśle wysyła człowieka szukać problemu w sieci, czyli
dokładnie tam, gdzie go nie ma.

Poprawione:

- nowy kod błędu `auth_failed`, odrębny od `upstream_unavailable`, rozpoznawany
  po `AuthenticationFailure.authenticationFailed` z imapflow;
- komunikat zawiera teraz kod błędu klienta i `serverResponseCode`, jeśli serwer
  go podał;
- `check:mail` idzie po łańcuchu `cause`, więc pokazuje to, co faktycznie
  powiedział serwer, a nie tylko własne opakowanie;
- po porażce wypisuje podpowiedzi **zależne od tego, czy serwer odpowiedział** —
  osobne dla odrzuconego logowania i osobne dla braku połączenia;
- adresy w komunikatach nadal maskowane.

Sprawdzone na wymuszonym `ECONNREFUSED`: raportuje kod błędu, komunikat
źródłowy i właściwą listę podpowiedzi.

### 8.11 Live Validation ZAKOŃCZONA — pełna ścieżka na prawdziwych danych

Uruchomione na maszynie właściciela, na prawdziwej skrzynce i prawdziwym
wdrożeniu TeaBrew. Poniżej wyłącznie to, co faktycznie przeszło.

| element | wynik |
| --- | --- |
| `verify:teabrew` | **17/17** na produkcyjnych danych |
| `check:mail` | **11/11** na prawdziwej skrzynce, okno 7 dni |
| `npm run triage` | **działa** — klasyfikacja prawdziwej poczty z prawdziwym modelem |
| stopka dowodowa | generowana z audytu, widoczna w odpowiedzi |
| tryb MCP | protokół przetestowany, 7 narzędzi z rejestru, bez klucza API |

Ostatnie sprawdzenia poczty przeszły po trzech poprawkach opisanych niżej.
Warto zapisać, że **żadna z moich pierwszych trzech hipotez nie była trafna** —
rozstrzygnęły dopiero dane z sondy wołającej prawdziwy adapter.

#### Trzy usterki znalezione na prawdziwej skrzynce

1. **Brak jakichkolwiek limitów czasu w adapterze IMAP.** `ImapFlow` przyjmuje
   `connectionTimeout`, `greetingTimeout`, `socketTimeout`, a `getMailboxLock`
   przyjmuje `acquireTimeout` — nie ustawiałem żadnego. `SEARCH BODY` na dużym
   folderze bez indeksu pełnotekstowego skanuje treść każdej wiadomości, więc
   narzędzie diagnostyczne wisiało bez komunikatu. Dołożone limity plus twardy
   deadline na krok w `check:mail`. `search` nie odpala już `SEARCH BODY`, jeśli
   nagłówki coś zwróciły — a `searchNote` mówi o tym wprost.

2. **Autoreferencja w nagłówku `References`.** Automat OpenERP/Odoo wstawia
   własny `Message-ID` do własnego `References`. Mój detektor uznał taką
   wiadomość za odpowiedź, której rodzic leży w skrzynce, i poprawnie odtworzony
   wątek jednoelementowy wyglądał jak usterka rekonstrukcji. Nowy helper
   `parentRefsWithin` wyklucza samą siebie; `normalizeReferences` **zostaje bez
   zmian**, bo jej zadaniem jest wiernie oddać nagłówek — interpretacja należy
   do miejsca użycia.

3. **Odtworzenie jednego wątku wysyłało ~58 zapytań.** 29 referencji × 2 foldery,
   każde z osobną blokadą skrzynki. `maxMessages` ograniczał wynik, ale nie
   ilość PRACY — i Zenbox rozłączył połączenie w trakcie przebiegu.
   IMAP `SEARCH` ma kryterium `OR`, więc wszystkie `Message-ID` idą teraz jednym
   zapytaniem na folder: z ~58 zapytań zostają 2. Referencje brane z ogona listy
   (`References` jest od najstarszej, więc najbliżsi przodkowie są na końcu),
   limit 25 z raportowaniem przekroczenia przez `incompleteNote`.

#### Dwie poprawki w moim własnym narzędziu diagnostycznym

- **`check:mail` mylił „brak danych" z „zepsute".** Pusty folder wysłanych w
  oknie i wątek, którego rodzica nie ma w skrzynce, były raportowane jako
  porażki. To ten sam błąd, którego uniknąłem przy sprawdzeniach 7, 9 i 10.
  Narzędzie krzyczące na spokojnej skrzynce uczy ignorować czerwone krzyżyki.
- **Sonda reimplementowała adapter i dlatego odpowiadała na inne pytanie** —
  wybierała ziarno po UID rosnąco, a `check:mail` po dacie malejąco, więc
  testowały dwa różne wątki. Sonda woła teraz prawdziwy adapter. Lekcja
  ogólniejsza: narzędzie diagnostyczne, które reimplementuje diagnozowaną rzecz,
  będzie się z nią rozjeżdżać.

#### Obserwacja operacyjna, nie usterka

Pierwszy `triage` na prawdziwej skrzynce zwrócił **2 wiadomości z ostatnich
24 godzin, obie niebiznesowe** (automat rezerwacyjny i odpowiedź „wróciłem z
urlopu"). Agent zaklasyfikował je poprawnie i uczciwie.

Skrzynka ma jednak **21 folderów**, w tym `FAKTURY`, `ROSSMANN`, `NPD` oraz
`INBOX.WHITE LABEL.*`. Jeśli reguły serwerowe przenoszą korespondencję z
klientami do tych podfolderów, to agent czytający wyłącznie `INBOX` będzie
odpowiadał prawdziwie, ale bezużytecznie — bo najciekawsze rzeczy będą poza
jego zasięgiem.

To **decyzja właściciela**, nie zmiana do wprowadzenia z automatu, i dotyczy
konfiguracji (`MAIL_FOLDER`), nie kodu. Rozstrzygnąć ją powinien tydzień
normalnego używania: jeśli odpowiedzi będą regularnie pomijać sprawy, o których
właściciel wie, że przyszły — wtedy wiadomo, które foldery dołożyć i dlaczego.
Zgadywanie tego teraz oznaczałoby rozszerzanie zasięgu agenta bez dowodu, że to
potrzebne.

---

### 8.12 Etap A (MCP lokalnie) — serwer nie wstawał pod Claude Desktop

Protokół był przetestowany i działał, gdy sterowałem serwerem z potoku. Pod
Claude Desktop ten sam serwer pokazywał **„Server disconnected"** i nic więcej.

**Przyczyna: aplikacja graficzna nie daje procesowi tego, co daje `npm run`.**
Katalog roboczy to `/`, a nie katalog pakietu. `.env` ustawia
`AUDIT_FILE=./.audit/calls.jsonl`, więc przy katalogu roboczym `/` ta ścieżka
znaczy `/.audit/calls.jsonl`. Konstruktor `MemoryAuditSink` wołał wtedy
`mkdirSync("/.audit")` — na macOS wolumin systemowy jest tylko do czytania, więc
rzut. A ponieważ `mcp.ts` składał aplikację **przy imporcie modułu**, proces
umierał **przed** odpowiedzią na `initialize`. Klient nie miał z czego zrobić
komunikatu, bo na poziomie protokołu nie zdążyło się nic zdarzyć.

To były **trzy błędy naraz**, więc naprawione są trzy:

1. **Ścieżki relatywne z konfiguracji liczone od katalogu pakietu**, nie od
   katalogu roboczego procesu (`src/paths.ts` → `fromPackageRoot`, stosowane do
   `AUDIT_FILE` i `FIXTURES_DIR`). Ścieżka bezwzględna działa jak dotąd.
2. **Konstruktor `MemoryAuditSink` nie rzuca.** Brak możliwości pisania na dysk
   degraduje audyt do pamięci i mówi o tym na stderr. `write` był na to odporny
   od początku — konstruktor nie był, a to on wykonuje się przy starcie.
3. **Start serwera nie może przewracać procesu.** `createApp()` jest w
   `try/catch`; `initialize` odpowiada **zawsze**, a błąd startu staje się
   czytelnym błędem JSON-RPC (i wpisem na stderr, który klienci MCP logują).
   Przy zepsutej konfiguracji `tools/list` zwraca **błąd**, nie pustą listę —
   pusta lista znaczyłaby „nie ma narzędzi", a prawda jest „nie wiem, bo nie
   wstałem". To ta sama zasada, co przy `matchedBy: "none"` i `unknownCodes`.

**Nowe narzędzie: `npm run mcp:doctor`.** Czyta *zainstalowaną* konfigurację
Claude Desktop i uruchamia z niej serwer dwa razy: raz dokładnie jak we wpisie,
raz wrogo — `cwd=/` i minimalne środowisko. Rozróżnia „nie wstaje wcale" od
„wstaje tylko z właściwym katalogiem roboczym", i pokazuje stderr serwera, czyli
prawdziwą przyczynę zamiast „Server disconnected".

**Nowe testy: `tests/mcp-startup.test.ts`** (3 testy, razem 71) uruchamiają
prawdziwy `src/bin/mcp.ts` w tych warunkach — z obcego katalogu roboczego, z
niezapisywalnym audytem i z niekompletną konfiguracją `MODE=live`. Test
jednostkowy na module, który przy imporcie wykonuje robotę, tej klasy usterek nie
złapie; dlatego te testy spawnują proces.

Lekcja ogólniejsza, warta zapisania: **„działa u mnie z terminala" nie jest
dowodem, że wstanie u klienta MCP.** Środowisko procesu startowanego z aplikacji
graficznej różni się w trzech rzeczach naraz — katalogu roboczym, `PATH` i
zmiennych środowiskowych — i każda z nich potrafi zabić serwer przed handshake.

---

### 8.13 Etap A ZALICZONY — i jedna usterka, którą wykrył

Cztery testy na prawdziwych danych, w Claude Desktop, z Claude jako modelem.
Wszystkie zdane.

| test | co sprawdzał | wynik |
| --- | --- | --- |
| zamówienie `2271126` | prawdziwe dane ERP | Rossmann, `cancelled`/`unpaid`, 1728 szt. BHTJM, powiązane ZP też anulowane |
| „Japan Matcha 40g" | czy Claude **łączy** narzędzia sam | tak: `find_product` → kod `BHTJM` → `get_stock`, bez podpowiedzi |
| korelacja poczta ↔ ERP | sens całości | 3 nowe zamówienia Rossmanna z maili, wszystkie `matchedBy: none` — czyli jeszcze nie wprowadzone do TeaBrew |
| zamówienie `99999888` | **zakaz zgadywania** | „nie istnieje w TeaBrew (…) nie zgaduję statusu" |

Test korelacji zachował się lepiej, niż zakładałem: przy wątku o transakcji P24
model **odmówił odpowiedzi i powiedział, czego mu brakuje** (pełnego numeru
transakcji, którego nie ma w mailu powiadamiającym), zamiast dopasować
najbliższą znalezioną transakcję. Zauważył też sam, że numery przesyłek InPost
nie są numerami TeaBrew.

#### Usterka: `mail_list_recent` nie mówił, ile wiadomości pominął

W odpowiedzi pojawiło się zdanie „ostatecznie pobrałem **pełne 30** wiadomości
z 7 dni". Model nie miał z czego tego wiedzieć — poprosił o 30, dostał 30
i nie istniał sposób odróżnienia „w oknie było 30" od „w oknie było 300".

`ImapMailProvider.listRecent` miał tę liczbę **darmowo** (`uids.length` przed
`slice(-limit)`) i ją wyrzucał. To samo w `search` (`seen.size`). Kontrola
dowodów tego nie łapie, bo wywołanie się odbyło i zwróciło prawdziwe dane —
fałszywa jest tylko **kompletność**, a jej nikt nie sprawdzał.

Naprawione w kontrakcie dostawcy, nie w promptcie: `listRecent` i `search`
zwracają `MailListResult { messages, matched }`, a capability wystawia `matched`,
`truncated` i `limitNote` z gotowym zdaniem („zwrócono 30 z 47 (…) pozostałe 17
NIE zostały sprawdzone"). `matched: null` znaczy „dostawca nie potrafi podać
liczby" i wtedy `truncated` też jest prawdą — brak wiedzy nie może wyglądać jak
komplet. `truncated` trafia również do audytu, bo „czego agent NIE widział" jest
równie istotne jak to, co sprawdził.

Zmiana typu `MailProvider` wyłapała wszystkie trzy pozostałe miejsca użycia
przez kompilator — dokładnie po to ten interfejs jest wąski.

---

### 8.14 Raport dzienny — automat zamiast ściągawki

Właściciel po Etapie A powiedział wprost: *„wpisywanie, pamiętanie co zapytać
wcale nie automatyzuje mojej pracy"*. Miał rację — Etap A to interfejs, nie
automat. Ściągawka z gotowymi pytaniami przenosi wysiłek, nie usuwa go.

Na jego decyzję (pełny raport) powstał `npm run raport`.

#### Dlaczego to musi działać na Macu, a nie w chmurze

Sprawdzone przez `list_environments`, nie założone: konto ma **jedno środowisko,
typu `anthropic_cloud`**. Zaplanowane zadanie po stronie Anthropic nie zrobiłoby
tego raportu, bo z chmury nie ma dostępu ani do `imap.zenbox.pl`, ani do
wdrożenia Convex (zmierzone w 8.9). Dane są za dwoma hostami, do których dosięga
tylko maszyna właściciela — więc silnik raportu jest tam, gdzie dane.

Harmonogram to `launchd`, nie cron: `launchd` wykona pominięty przebieg **po
wybudzeniu** komputera, cron go po prostu opuszcza, a Mac rzadko czuwa o 8:00.

#### Co raport składa i z czego

Zero nowej logiki biznesowej. Raport to `MailTriage` — ten sam agent, te same
capability, ta sama kontrola dowodów — plus widok. Dwie rzeczy trzeba było w
triage dodać, obie wynikające z tego, po co raport istnieje:

1. **`checkAllRefs`** — domyślnie triage sprawdza w ERP tylko numery ze spraw
   pilnych, bo odpytywanie „na wszelki wypadek" jest kosztem bez wartości. Ale
   pytanie „co przyszło mailem i nie ma tego w systemie" **jest** celem raportu,
   a nowe zamówienie od klienta rzadko trafia do kategorii „Pilne" — trzy
   zamówienia Rossmanna z 8.13 były „Do odpowiedzi". Bez tej flagi raport
   przemilczałby dokładnie to, po co go uruchamiamy.
2. **`mailNote`** — przycięcie listy do limitu przechodzi teraz do wyniku i do
   każdego renderu. Przegląd, który obejrzał 30 z 47 wiadomości, nie jest
   przeglądem poczty; jest przeglądem 30 wiadomości i musi to o sobie powiedzieć.

#### Kolejność sekcji panelu jest decyzją, nie układem

1. **Nie ma tego w TeaBrew** — jedyne pytanie, na które żaden inny program w
   firmie nie odpowiada, bo wymaga zajrzenia w dwa miejsca naraz.
2. Czeka na odpowiedź.
3. Reszta poczty, zwinięta po kategoriach.
4. **Co dokładnie sprawdziłem** — z audytu. Raport, którego nie da się
   zweryfikować, po tygodniu przestaje być czytany.

Trzy rzeczy raport wykrzyczy zamiast przemilczeć: niepełny przegląd, nieudane
sprawdzenie (te dane **nie** zostały sprawdzone — brak wpisu nie znaczy „nic tam
nie ma") i numery pominięte z powodu budżetu wywołań.

#### Zachowanie o 8:00

Powiadomienie macOS z jednym zdaniem o liczbach — *„Poczta: 12 · 3 numerów nie ma
w TeaBrew · 2 do odpowiedzi"*. Nie „raport gotowy": to nie jest informacja, po
której ktokolwiek cokolwiek zrobi.

Panel otwiera się sam **tylko gdy jest po co** — brakujący numer, sprawa pilna
albo nieudane sprawdzenie. Codzienne okno „nic się nie stało" uczy zamykać je bez
czytania, a wtedy przestaje działać także w dniu, w którym coś się stało. To ten
sam argument, co przy narzędziu diagnostycznym krzyczącym na spokojnej skrzynce.

#### Czego raport NIE robi

Nie przychodzi mailem. Brak SMTP jest konstrukcyjny, nie przypadkowy — zdjęcie
tej blokady jest osobną decyzją właściciela i nie zostało podjęte. Panel jest
plikiem lokalnym w `raporty/` (w `.gitignore`), zawiera tematy i nadawców z
prawdziwej poczty, więc nie wolno go nikomu wysyłać. Log audytu, w odróżnieniu od
raportu, treści nie zawiera i nigdy nie będzie zawierał.
