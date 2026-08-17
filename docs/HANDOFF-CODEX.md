# Handoff: AI Operator — brief dla kolejnego agenta

Dokument przekazania. Czytaj razem z `docs/AI-OPERATOR-MVP.md` (pełny opis,
w szczególności **sekcja 8 — Live validation**), `docs/ARCHITEKTURA-AI-2026.md`
(dlaczego to wygląda tak, a nie inaczej) oraz
`docs/AI-OPERATOR-CODZIENNIE.md` (jak właściciel tego używa na co dzień —
tam jest opisana **różnica gwarancji** między trybem MCP i `npm run ask`).

**Nie rozszerzaj zakresu i nie projektuj niczego od nowa.**

---

## 0. Stan na dziś: LIVE DZIAŁA

Uruchomienie na prawdziwych danych firmy jest **zakończone**. Nie musisz go
powtarzać ani „dokańczać".

| element | wynik | gdzie |
| --- | --- | --- |
| `verify:teabrew` | **17/17** — potwierdzone ponownie po merge #27 | 8.10, punkt 2 |
| `check:mail` | **11/11** na prawdziwej skrzynce (okno 7 dni) | 8.11 |
| `npm run triage` | działa na prawdziwej poczcie z prawdziwym modelem | 8.11 |
| tryb MCP (Claude jako model) | **Etap A zaliczony** — 4 testy na prawdziwych danych w Claude Desktop | 8.12, 8.13 |
| raport dzienny | `launchd` + panel HTML + powiadomienie macOS | 8.14 |
| testy | **142**, bez sieci i bez klucza API | — |
| BHT Copilot v1 | kod gotowy, **wdrożenie i test z telefonu po stronie właściciela** | 9 |

Cztery rzeczy, które musisz o tym wiedzieć, zanim czegokolwiek dotkniesz:

1. **Uruchomienie live odbywa się na maszynie właściciela, nie w środowisku
   agentowym.** Polityka egress typowej sesji w chmurze nie przepuszcza ani
   `imap.zenbox.pl` (TCP timeout na 993 i 143), ani wdrożenia Convex (proxy
   odrzuca CONNECT z 403). Zmierzone, nie założone — dowody w 8.9. Nie próbuj
   tego obchodzić; do uruchomienia u właściciela jest
   `ai-operator/scripts/live-setup.sh` (dopytuje tylko o brakujące wartości,
   sekrety bez echa, prawa 600, `--reset KLUCZ` do poprawienia literówki).

2. **ROZWIĄZANE (17.08.2026): PR #27 zmergowany, trasy ERP wróciły na trwałe.**

   Przebieg, warty zapamiętania, bo to była przewidziana awaria: trasy wdrożył
   build **preview** tego PR-a, a kolejny preview z innej gałęzi uruchomił
   `convex deploy` i je **usunął**. `verify:teabrew` spadło z 17/17 na 0 z 11
   sprawdzeń merytorycznych (same 404), a monitor poczty dostawał
   `HTTP 404 na /ai-operator/order`.

   Naprawa: **squash-merge PR #27 do `main`** (`d950b97`), build produkcyjny
   `READY`, `Deployed Convex functions`. Po tym `verify:teabrew` = **17/17**
   pod NIEZMIENIONYM `TEABREW_BASE_URL`.

   Ustalenie z tego wynikające: **klucz wdrożeniowy produkcji celuje w to samo
   wdrożenie Convex (`calm-porpoise-426`), co buildy preview.** Nie trzeba było
   zmieniać ani adresu, ani ustawiać tokenu na drugim wdrożeniu — moja obawa
   o rozdział dev/prod się NIE potwierdziła. Zapisane jako fakt, żeby kolejny
   agent nie planował migracji, której nie ma potrzeby robić.

   Trwałość: trasy są w `main`, więc odtwarza je każdy build produkcyjny.

3. **Rozjazd w `scripts/safe-build.mjs` NADAL istnieje i nie został naprawiony.**
   Build preview uruchamia `convex deploy` bez guardów produkcyjnych — te
   działają wyłącznie w bloku `isVercel && isProduction`. To przyczyna awarii
   z punktu 2 i może ją powtórzyć. Wtedy lekarstwem jest ponowny build z `main`,
   nie zmiana konfiguracji. Naprawa jest po stronie teabrew-v2 i wymaga decyzji
   właściciela; przed edycją wykonaj kroki z `AGENTS.md`.

4. **Tryb MCP nie potrzebuje `ANTHROPIC_API_KEY`.** Modelem jest Claude po
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
vector DB, kolejnego agenta, PWA/iOS/Android, własnego chatu ani UI, centralnej
bramy, SSO, nowych usług.

Świadoma decyzja: najpierw 1–2 tygodnie używania Claude jako gotowego
interfejsu, potem ewentualna decyzja o własnym UI — na podstawie realnych
potrzeb, nie przewidywania.

**Zmiana decyzji właściciela (17.08.2026): harmonogram JEST dozwolony.**
Na pierwotnej liście były „crony i automatyczne poranne uruchamianie". Właściciel
wprost stwierdził, że wpisywanie pytań z ściągawki nie automatyzuje jego pracy,
i wybrał pełny raport dzienny. To nie jest rozszerzenie zakresu zrobione
samowolnie — jeśli trafisz na sprzeczność z listą powyżej, ta linia ją
rozstrzyga. Harmonogram to `launchd` na Macu właściciela uruchamiający kod,
który już istniał; **nie** nowa usługa, nie serwer, nie nowa zależność.

Co pozostaje zakazane bez kolejnej wyraźnej zgody: **wysyłanie raportu mailem**
(brak SMTP jest konstrukcyjny, nie przypadkowy) i uruchamianie raportu w chmurze
— środowisko `anthropic_cloud` nie ma dostępu ani do IMAP-a, ani do Convexa,
więc zaplanowane zadanie po stronie Anthropic tego raportu nie wykona. Sprawdzone
przez `list_environments`: konto ma jedno środowisko i jest typu `anthropic_cloud`.

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
- **Przycięcie wyniku do limitu MUSI być widoczne.** `listRecent` i `search`
  zwracają `MailListResult { messages, matched }`, gdzie `matched` to liczba
  trafień **przed** `slice(-limit)`. Bez niej model dostaje 30 wiadomości przy
  limicie 30 i pisze „pobrałem pełne 30 z 7 dni" — twierdzenie, którego nie ma
  jak sprawdzić. Kontrola dowodów tego nie łapie: wywołanie się odbyło i zwróciło
  prawdziwe dane, fałszywa jest tylko **kompletność**. `matched: null`
  (dostawca nie umie podać liczby) daje `truncated: true` — brak wiedzy nie może
  wyglądać jak komplet. To był realny błąd w odpowiedzi na prawdziwej skrzynce.
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

### Git

- **Wzorzec w `.gitignore` bez ukośnika na początku dopasowuje się na KAŻDYM
  poziomie drzewa.** `state/` (dla katalogu z danymi w czasie działania) ukryło
  także `src/state/` — siedem plików źródłowych nie trafiło do commita,
  `git add -A` pominął je bez słowa, `typecheck` i `test` przeszły (pliki były na
  dysku), a właściciel dowiedział się przy `git pull`:
  `Cannot find module 'src/state/store.js'`. Katalogi danych zapisuj
  zakotwiczone: `/state/`, `/raporty/`, `/.audit/`.
- **„U mnie przechodzi" nie jest dowodem na to, co wypchnięte.**
  `npm run verify:clone` rozpakowuje drzewo z `HEAD` przez `git archive`,
  sprawdza, czy każdy import z `src/` ma swój plik W COMMICIE, i uruchamia na tym
  typecheck oraz testy. Weryfikacja samej kontroli: usunięcie jednego pliku
  z rozpakowanego drzewa daje 4 zgłoszone zepsute importy.

### Kredyty API — Copilot ich NIE UŻYWA

**Decyzja właściciela (17.08.2026): tylko subskrypcja Claude, zero kredytów API.**

Monitor w tle był jedynym miejscem, które wołało model po naszej stronie — i to
naruszało zasadę z jego własnego zadania („Claude wykonuje reasoning, nasza
infrastruktura NIE wywołuje drugiego modelu"). Teraz:

- `MONITOR_CLASSIFIER=deterministic` (domyślnie) — sprawa powstaje z FAKTÓW:
  nadawca, temat, numery wymienione w wiadomości, odpowiedź TeaBrew, czy
  odpowiedzieliśmy (`\Answered`). Tytuł i streszczenie NIE są generowane —
  tytuł to nadawca i temat, streszczenie to podgląd z serwera. Nic nie jest
  przeformułowane, więc nie ma czego zmyślić.
- Sprawa niesie `classifier: "deterministic"`, żeby Claude wiedział, że kategoria
  jest słabym sygnałem, nie oceną, i mógł ją nadpisać.
- Raport dzienny rysuje się z LISTY SPRAW, nie z osobnego przebiegu triage.
  Skutek uboczny na plus: raport i odpowiedzi Claude pokazują ten sam stan
  i nie mogą się rozjechać w liczbach.
- `ask` i `triage` zostają i nadal wołają model — są opcjonalne i płatne.
  `install-schedule.sh` NIE wymaga już klucza.

**Nie przywracaj modelu do ścieżki domyślnej.**

### `mailparser` grupuje nagłówki `List-*` pod kluczem `list`

**Nie ma klucza `list-unsubscribe`.** `List-Unsubscribe: <https://…>` staje się
`headers.get("list") === { unsubscribe: { url: "https://…" } }`, a `List-Id` →
`{ id: { name: … } }`.

Sprawdzanie `headers.has("list-unsubscribe")` zwraca **zawsze false** — i filtr
poczty masowej nie odsiał NICZEGO na prawdziwej skrzynce. Pierwszy przebieg
monitora: 16 wiadomości, w tym TikTok, Booking.com, PsiBufet i pięć newsletterów,
przeszło jako zwykła korespondencja i każda dostała własną sprawę.

Rozstrzygnięte przez przepuszczenie prawdziwego nagłówka RFC822 przez
`simpleParser`, nie przez czytanie dokumentacji. Test pokrywa cztery kształty
(`List-Unsubscribe`, `List-Id`, `Precedence: bulk`, `Auto-Submitted`) plus
`Auto-Submitted: no`, które znaczy „to napisał człowiek".

### Rozpoznawanie numerów zamówień — cztery kolejne wpadki w jednym miejscu

`src/state/order-refs.ts` jest JEDYNYM miejscem rozpoznającym numer zamówienia.
Powstało po serii błędów, każdy wykryty na prawdziwych danych i każdy tej samej
klasy — fałszywy alarm „numeru X nie ma w TeaBrew":

1. **„każda liczba od 4 cyfr"** — wzorzec działał w triage, bo tam dostawał
   numery, które model już WYBRAŁ semantycznie. Na surowym tekście dawał `1800`
   (tonaż) i `2026` (rok).
2. **`po` bez granic wyrazu** — dopasowywało się w „**Po**twierdzenie".
3. **przechwytywanie cyfr bez granicy tokenu** — „partia dostawcy RB-2026-118"
   dawało `2026` ze ŚRODKA numeru dostawcy. Sam `\b` nie wystarcza: między „-"
   i „2" granica wyrazu istnieje. Potrzebne `(?<![\w/-])`.
4. **numer przesyłki** (24 cyfry, InPost) sprawdzany w TeaBrew gwarantował
   odpowiedź „nie znam", czyli fałszywy alarm przy każdym przebiegu.
5. **próg 6 cyfr był za niski** — kod logowania do sklepu („348819 to Twój kod
   logowania") trafiał do TeaBrew. Prawdziwe numery tej firmy mają SIEDEM cyfr
   (`2307029`, `2271126`, `2307348`), więc próg to 7. Numery 4–6-cyfrowe nadal
   są łapane, ale tylko ze słowem kluczowym obok.

Reguły: numer musi mieć POWÓD (prefiks literowy, słowo kluczowe obok, albo ≥6
cyfr), a do TeaBrew idą tylko numery o KSZTAŁCIE naszego numeru
(`isOwnOrderShape`: 4–12 cyfr, bez prefiksu). Numer odrzucony z alarmowania
NADAL zostaje w sprawie jako wskaźnik. 10 testów.

Dlaczego to tyle uwagi: raport mówiący „3 numerów nie ma w systemie", gdzie dwa
to rok i tonaż, traci zaufanie w pierwszym dniu — a wtedy przestaje działać także
w dniu, w którym numer jest prawdziwy.

### Poczta — zakres folderów (ROZSTRZYGNIĘTE)

- **Foldery biznesowe wskazane w pierwszej wersji tego dokumentu są martwe.**
  `FAKTURY` 761 dni, `ROSSMANN` 885 dni, `NPD` 530 dni, `INBOX.WHITE LABEL.*`
  1104 dni albo puste. Obawa „korespondencja z klientami idzie do podfolderów,
  więc INBOX nie wystarcza" była **nieuzasadniona** — sprawdzona, nie założona
  (8.15). `MAIL_MONITOR_FOLDERS=INBOX` i nie rozszerzaj bez dowodu.
- **`Blocked` i `Archive` NIE nadają się do monitorowania.** `Blocked` to
  zbiornik (985 z 1157 nieprzeczytanych), `Archive` to miejsce, gdzie poczta
  trafia PO obsłużeniu (27911 wiadomości). Ocena folderów siedzi w
  `src/mail/folder-verdict.ts` i jest pokryta testami.

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
                     probe-thread, audit (podgląd logu — w trybie MCP JEDYNY dowód),
                     report (raport dzienny, panel HTML, jedna linia na powiadomienie)
  scripts/           live-setup.sh (uruchomienie live), install-claude-desktop-config.mjs,
                     mcp-doctor.mjs (diagnostyka startu serwera MCP)
  teabrew-patch/     źródło kontraktu ERP (założone jako PR #27)
  fixtures/          poczta (INBOX + Sent) i dane ERP — PRAWDZIWE enumy
  tests/             81 testów: scenariusze, jednostkowe, bezpieczeństwo łatki,
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

---

## 9. BHT Copilot v1 — co jest zrobione, a co zablokowane

Stan na 17.08.2026. Tabela jest ustawiona wobec „Definition of Done" z zadania,
bez zaokrąglania w górę.

| wymaganie DoD | status |
| --- | --- |
| Remote MCP działa | **kod gotowy, przetestowany lokalnie** (401 bez tokenu, 11 narzędzi, zero sekretów w logu). **NIE wdrożony** — wymaga konta Railway właściciela |
| dostępny z telefonu | **NIE zweryfikowane.** Zależy od wdrożenia i od otwartego pytania o uwierzytelnienie konektora — patrz `docs/DECYZJA-REMOTE-MCP.md` punkt 4 |
| dostęp do prawdziwej poczty | kod bez zmian wobec działającego LIVE; w tej sesji nieweryfikowalny (egress) |
| dostęp do TeaBrew | jak wyżej |
| monitoruje właściwe foldery | **narzędzie gotowe** (`npm run mail:foldery`), **inwentaryzacja NIE wykonana** — wymaga IMAP-a, czyli maszyny właściciela |
| nie analizuje całej skrzynki ponownie | ✅ checkpoint per folder + globalny zbiór Message-ID, pokryte testem |
| checkpointy | ✅ na RFC Message-ID, nie na IMAP UID — obsługuje przeniesienie między folderami, powrót i duplikat |
| operator wykrywa nowe sprawy | ✅ kod i testy; **nie uruchomiony na prawdziwej poczcie** |
| trwały Operational State | ✅ dziennik JSONL, test przeżycia restartu |
| nowe wiadomości aktualizują sprawy | ✅ korelacja ze stopniami pewności, 6 testów |
| `get_changes_since` | ✅ |
| `get_open_issues` | ✅ |
| wejście w konkretną sprawę | ✅ `copilot_get_issue` |
| nie pokazuje tego samego dwa razy | ✅ i test, że **pokazanie nie jest zmianą** — inaczej sprawa wracałaby w każdej delcie na zawsze |
| TeaBrew read-only | ✅ bez zmian, 18 testów łatki dalej przechodzi |
| poczta read-only | ✅ bez zmian |
| audyt działa | ✅ |
| koszty operatora mierzone | ✅ `MonitorCost` + `state/koszty.jsonl` |
| awaria Copilota nie rusza produkcji | ✅ konstrukcyjnie + test, że nieudany przebieg monitora nie przewraca serwera MCP |
| instrukcja Claude Project | ✅ `docs/CLAUDE-COPILOT-INSTRUCTIONS.md` |
| test na prawdziwych danych z telefonu | ❌ **niewykonany** |

**Pięć pozycji jest zablokowanych na maszynie i koncie właściciela, nie na kodzie.**
Nie próbuj ich odblokować w środowisku agentowym — egress nie przepuszcza ani
IMAP-a, ani Convexa (zmierzone, 8.9).

### Nowe rzeczy, o których musisz wiedzieć

- **`src/mcp/core.ts` jest JEDYNĄ implementacją protokołu.** `bin/mcp.ts` (stdio)
  i `bin/mcp-http.ts` (zdalnie) są cienkimi transportami. Test pilnuje, żeby
  żaden z nich nie budował własnej listy narzędzi ani nie wołał rejestru wprost.
- **Zapis „to już pokazałem" robi ADAPTER, nie capability.** Wszystkie cztery
  nowe capability są czystym odczytem — dokładnie jak wpis do audytu jest efektem
  ubocznym rejestru. Gdyby capability sama zapisywała, `effectClass: "read"`
  przestałoby być prawdą i testy strzegące tej granicy przestałyby cokolwiek
  znaczyć. Nie „upraszczaj" tego.
- **Model nie może zamknąć sprawy.** `resolved` ustawia wyłącznie
  `ownerResolve` (aktor `wlasciciel`, komenda `npm run sprawy -- --zamknij`).
  Próba przez copilota daje `probably_resolved`. Wymuszone w `store.ts`.
- **Korelacja scala tylko przy wysokiej pewności.** Wspólny wątek scala zawsze;
  wspólny numer zamówienia dopiero razem ze zgodną domeną nadawcy. Sam numer bez
  nadawcy zakłada osobną sprawę i dopisuje podobieństwo do streszczenia —
  duplikat jest mniej groźny niż zmieszanie dwóch spraw dwóch klientów.
- **Filtr przed modelem stoi na nagłówkach RFC**, nie na nazwie nadawcy.
  Świadomie NIE odrzuca po `noreply@`: tak przychodzą potwierdzenia zamówień
  i awizo kurierskie.
- **Kanał powiadomień NIE istnieje** i to jest świadome. `notificationCandidate`
  jest wyliczany i widoczny w logu przebiegu oraz w `npm run sprawy`, żeby po
  tygodniu było wiadomo, ile takich sytuacji realnie jest, **zanim** ktokolwiek
  włączy alerty. Nie włączaj kanału bez zgody właściciela.
