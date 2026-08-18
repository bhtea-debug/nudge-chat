# Handoff: AI Operator — brief dla kolejnego agenta

Dokument przekazania. Stan na **17.08.2026**, gałąź
`claude/ai-company-architecture-mvy1uv`, ostatni commit `f60c03d`.

> **Przeczytaj to, zanim cokolwiek zaplanujesz.** Kierunek co do interfejsu
> zmieniał się w ciągu jednego dnia DWA razy i ostateczna decyzja właściciela
> brzmi: **„NIE BUDUJEMY WŁASNEJ APLIKACJI. Całe UI ma być w Claude."**
> Zbudowany po drodze interfejs (`src/ui/`) został **usunięty** — jest w historii
> gita, ale jego przywrócenie łamie wprost wyrażone wymaganie. Pełna kolejność
> zdarzeń i co z tego kodu zostało: sekcja 11.
>
> Sekcja 12 mówi, co jest zablokowane i **na czym dokładnie** — to rzeczy, których
> żaden agent nie odblokuje sam, bo wymagają konta i telefonu właściciela.
>
> **Sekcja 15 jest najświeższa: walidacja GO/NO-GO zakończyła się NO-GO —
> dostarczanie działa (push na iPhone potwierdzony), ale dobór spraw ma czułość
> alarmu 0%. Przeczytaj ją, ZANIM zaplanujesz cokolwiek wokół powiadomień.**
>
> Sekcja 14 odpowiada na wcześniejsze pytanie architektoniczne: werdykt A —
> Claude nadaje się na interfejs na komputerze i na telefonie, potwierdzone
> pomiarem na iPhonie właściciela. Zawiera też cztery rundy, które kosztowało
> podłączenie konektora.

Czytaj razem z:

| dokument | do czego |
| --- | --- |
| `docs/AI-OPERATOR-MVP.md` | pełny opis, w szczególności **sekcja 8 — Live validation** (dowody z prawdziwych danych) |
| `docs/ARCHITEKTURA-AI-2026.md` | dlaczego to wygląda tak, a nie inaczej |
| `docs/AI-OPERATOR-CODZIENNIE.md` | jak właściciel tego używa na co dzień — tam jest **różnica gwarancji** między trybem MCP i `npm run ask` |
| `docs/DECYZJA-REMOTE-MCP.md` | wybór hostingu zdalnego MCP, spisany **przed** wdrożeniem |
| `docs/DECYZJA-CONNECTEAM.md` | co API Connecteam **faktycznie** daje, sprawdzone **przed** implementacją. Przeczytaj, zanim zaplanujesz cokolwiek wokół czatu |
| `docs/CLAUDE-COPILOT-INSTRUCTIONS.md` | instrukcja do wklejenia w Claude Project |

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
| monitor deterministyczny | **przebiegł na prawdziwej poczcie**: 20 nowych → 11 odsianych → 9 spraw, **0 wywołań modelu** | 4, „Kredyty API" |
| raport dzienny | `launchd` + panel HTML — **tylko diagnostyka**, nie produkt | 8.14 |
| capability | **11**, zapisujących **0** (`npm run caps`) | 5 |
| interfejs | **Claude, przez Remote MCP.** Własne UI usunięte na polecenie właściciela | 11 |
| Connecteam | kod gotowy, **konto niepodłączone**; API nie dokumentuje odczytu wiadomości | `docs/DECYZJA-CONNECTEAM.md` |
| testy | **170**, bez sieci i bez klucza API | 6 |
| wdrożenie zdalne | `npm run wdroz` gotowy, **NIE uruchomiony** — wymaga konta właściciela | 12 |

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
| łatka ERP | `bhtea-debug/teabrew-v2` — **PR #27 ZMERGOWANY** do `main` (`d950b97`), trasy odtwarza każdy build produkcyjny |
| wdrożenie Convex | `calm-porpoise-426` — to samo dla buildów preview i produkcyjnych (ustalone, patrz sekcja 0 punkt 2) |
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
- **Nie rzutuj odpowiedzi TeaBrew na własny kształt — użyj typu z KONTRAKTU.**
  W monitorze rzutowałem wynik na `{ order?: { fulfillmentStatus, paymentStatus } }`.
  Kontrakt ma `orders: Order[]`. TypeScript nic nie zgłosił (rzutowanie wyłącza
  kontrolę), pola były `undefined`, i raport na prawdziwych danych napisał
  `2307348: ? / ?` przy zamówieniu, które w systemie JEST i ma status.
  Poprawnie: `z.infer<typeof OrderResponse>["data"]`, potem `out.orders[0]`.
  Każde `as` na odpowiedzi HTTP to miejsce, w którym schemat i kod mogą się
  rozjechać bez ostrzeżenia.

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

### Raport bez modelu: lista faktów NIE JEST raportem

Pierwsza wersja raportu deterministycznego zbierała fakty i na tym poprzestawała.
Ocena właściciela, dosłownie: **„mało potrzebny ten raport, nie rozdziela spamu od
wiadomości, nie ma priorytetów, opisów, wyjaśnienia"**. Miał rację i warto
rozumieć, dlaczego, bo to jest pułapka wpisana w usunięcie modelu: przenosząc
ocenę do „spytaj Claude'a", zdjąłem ją z jedynej rzeczy, którą właściciel czyta
**bez zadawania pytania**.

Trzy z czterech zarzutów da się naprawić bez modelu i są naprawione
(`classify-deterministic.ts`, `report-view.ts`):

- **priorytety** — pięć uporządkowanych reguł w `judge()`, pierwsza pasująca
  wygrywa. Każda opiera się na fakcie, nie na wyczuciu.
- **rozdzielenie** — trzy ROZŁĄCZNE sekcje panelu: brakujące w TeaBrew →
  korespondencja → prawdopodobnie nieistotne (w `<details>`, zwinięte).
- **wyjaśnienie** — `whyListed`, jedno zdanie przy KAŻDEJ pozycji („w wiadomości
  jest numer zamówienia 2307029", „nigdy nie pisaliśmy do psibufet.example, brak
  numeru i brak wątku"). Cel: żeby właściciel mógł odrzucić konkretną regułę,
  a nie cały mechanizm.

**Czwartego zarzutu nie da się naprawić bez modelu i nie udawaj, że się da.**
Opis to podgląd treści z serwera, dosłownie, przycięty do 400 znaków. Nie ma
streszczenia własnymi słowami. Zaleta: nie ma czego zmyślić. Wada: nie ma skrótu.
Otwarta propozycja dla właściciela — **jedno** wywołanie modelu na dobę, tylko do
raportu (~30× taniej niż monitor co 15 minut, który odrzucił). To jego decyzja.

Dwie rzeczy w tym mechanizmie, których nie ruszaj:

- **Bez skanu folderu wysłanych NIE WOLNO twierdzić „nieznany nadawca".**
  `Signals.senderHistoryAvailable` rozdziela „nie pisaliśmy do tej domeny" od
  „nie wiem, czy pisaliśmy". Reguła 4 w `judge()` obsługuje drugi przypadek i
  mówi o tym wprost w `whyListed`. Ukrycie pierwszego maila od nowego klienta
  byłoby najgorszą możliwą pomyłką tego systemu.
- **`deservesIssue` zwraca zawsze `true`.** Rozdzielenie robi flaga
  `likelyIrrelevant`, NIE odrzucenie na wejściu. Różnica jest praktyczna: sprawa
  oznaczona jako nieistotna nadal jest w pamięci i znajdzie ją
  `copilot_search_issues`; wiadomość odrzucona na wejściu przestaje istnieć dla
  całego systemu. Nie „optymalizuj" tego z powrotem.

`MAIL_SENT_FOLDER` **nie ma wartości domyślnej** — patrz zasada „nie zgaduj
nazwy folderu wysłanych" wyżej. Lista znanych domen jest odświeżana raz na 24 h
(`KNOWN_DOMAINS_TTL_HOURS`) i zapisana w dzienniku jako zdarzenie
`known_domains`, żeby nie skanować przy każdym przebiegu.

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

### Rozpoznawanie numerów zamówień — sześć kolejnych wpadek w jednym miejscu

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
6. **NIP wyglądał jak numer zamówienia.** `8842745578` (10 cyfr) przeszło próg
   długości i poszło do TeaBrew, gwarantując „tego numeru nie ma w systemie" —
   przy każdym mailu z podpisem firmowym, czyli praktycznie zawsze. Lista
   `NOT_ORDER` (`nip`, `regon`, `krs`, `pesel`, `iban`, `vat`, `konto`,
   `rachunek`, `tel`, `kod`, `pin`) odrzuca liczbę, jeśli w pobliżu stoi jedno
   z tych słów. Górna granica `isOwnOrderShape` to 12 cyfr — nie „dowolnie
   długa liczba".

Reguły: numer musi mieć POWÓD (prefiks literowy, słowo kluczowe obok, albo ≥7
cyfr), a do TeaBrew idą tylko numery o KSZTAŁCIE naszego numeru
(`isOwnOrderShape`: 4–12 cyfr, bez prefiksu). Numer odrzucony z alarmowania
NADAL zostaje w sprawie jako wskaźnik.

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
  src/paths.ts       fromPackageRoot — ścieżki od katalogu PAKIETU, nie od cwd
  src/capability/    rejestr (wymusza read), typy, audyt, projekcje
                     projections.ts: JSON Schema + OpenAPI + MCP z JEDNEJ definicji
  src/mail/          types.ts (MailProvider — brak metod zapisu)
                     imap.ts (adapter, readOnly, limity czasu, SEARCH OR, isBulk)
                     fixture.ts, folders.ts (SPECIAL-USE), thread.ts, text.ts,
                     folder-verdict.ts (ocena „monitorować czy nie" — testowalna)
  src/teabrew/       contract.ts (zod, JEDNO źródło prawdy), client.ts (HTTP + fixture)
  src/model/         roles.ts — fast / reason, zero ID modeli w logice, LENIWA
                     errors.ts — błąd API na komunikat, z którego wynika co zrobić
  src/state/         PAMIĘĆ COPILOTA (7 plików, patrz sekcja 10)
                     store.ts (dziennik JSONL, replay, guardStatus)
                     types.ts (Issue, StateEvent), monitor.ts (przebieg w tle)
                     classify-deterministic.ts (Signals + judge — priorytety)
                     order-refs.ts (JEDYNE rozpoznawanie numerów), correlate.ts,
                     noise.ts, capabilities.ts (4 capability copilot_*), report.ts
  src/mcp/core.ts    JEDYNA implementacja JSON-RPC dla OBU transportów
  src/agent/         operator.ts, triage.ts, prompt.ts, evidence.ts,
                     report-view.ts (panel HTML: 3 sekcje, plakietki, whyListed)
  src/bin/           ask, triage, caps, openapi, check-mail, verify-teabrew,
                     probe-thread, mail-folders (inwentaryzacja), monitor, issues,
                     mcp (stdio) i mcp-http (zdalnie) — cienkie transporty,
                     audit (podgląd logu — w trybie MCP JEDYNY dowód),
                     report (raport dzienny, panel HTML, linia na powiadomienie)
  scripts/           live-setup.sh (uruchomienie live), install-claude-desktop-config.mjs,
                     mcp-doctor.mjs (diagnostyka startu serwera MCP),
                     install-schedule.sh (launchd), daily-report.sh,
                     verify-clone.sh (weryfikacja TREŚCI commita — patrz „Git")
  Dockerfile         obraz dla Remote MCP (Railway) — patrz DECYZJA-REMOTE-MCP.md
  teabrew-patch/     źródło kontraktu ERP (zmergowane jako PR #27, d950b97)
  fixtures/          poczta (INBOX + Sent) i dane ERP — PRAWDZIWE enumy
  tests/             146 testów w 6 plikach: scenarios (19), copilot-state (52),
                     units (32), patch-security (27), report-view (13),
                     mcp-startup (3 — uruchamiają PRAWDZIWY serwer)
  claude-desktop.example.json   konfiguracja MCP dla Claude Desktop
```

**Z jednej deklaracji capability** powstaje klient TypeScript, JSON Schema dla
function callingu, OpenAPI i lista narzędzi MCP. Dodając capability, dodaj ją
**tylko** w rejestrze.

MCP jest **adapterem**: nie definiuje capability, nie dodaje zależności, nie woła
modelu po naszej stronie. Skasowanie go nie psuje agenta. Testy pilnują, żeby nie
stał się drugim systemem — w szczególności, żeby `bin/mcp.ts` ani `bin/mcp-http.ts`
nie budowały własnej listy narzędzi i nie wołały rejestru wprost.

---

## 6. Testowanie bez sekretów

Wszystkie **146** testów działa **bez sieci i bez klucza API** — model jest atrapą
(`tests/helpers.ts`, `scriptedModel`), dane z fikstur.

```bash
cd ai-operator && npm install
npm run preflight        # typecheck + test + verify:clone — TO uruchamiaj przed pushem
npm run check:mail       # 11 sprawdzeń poczty na fiksturach, 11/11
npm run caps             # 11 capability, 0 zapisujących
```

`preflight` zawiera `verify:clone`, i to nie jest ozdoba: dwa razy w tym projekcie
„u mnie przechodzi" znaczyło coś innego niż „przechodzi to, co wypchnięte"
(patrz „Git" w sekcji 4).

Fikstury mają dwie właściwości, których nie psuj:

- **daty względne** (`{{-3h}}`, `{{+2d}}`) — inaczej okno `sinceDays` przestaje
  być testowane dzień po napisaniu testu,
- **statusy dokładnie z enumów źródłowego schematu**, nie „w tym stylu".
  Fikstura z wymyśloną wartością przechodzi przez `z.string()` i uczy agenta
  nieistniejącego słownictwa. To już raz się zdarzyło.

---

## 7. Co zostało do zrobienia

### Etap A — ZALICZONY, nie powtarzaj

Claude Desktop odpowiedział na wszystkie cztery testy na prawdziwych danych
(8.12, 8.13): zamówienie `2271126` (anulowane, nieopłacone), stan Japan Matcha,
korelacja poczta↔TeaBrew (trzy zamówienia Rossmanna, `matchedBy: none`) oraz
nieistniejące `99999888` — z odpowiedzią „nie istnieje w TeaBrew, nie zgaduję
statusu", czyli dokładnie tak, jak ma działać.

Jedna rzecz z tych testów jest ważniejsza niż sam wynik: Claude napisał wtedy
„pobrałem **pełne** 30 wiadomości z 7 dni". To było nieprawdziwe twierdzenie
o KOMPLETNOŚCI, którego kontrola dowodów nie łapie. Stąd `MailListResult.matched`
i `truncated` — patrz sekcja 4, „Poczta".

### Etap B — dostęp zdalny, DECYZJA PODJĘTA (Railway)

**Nie planuj tego od nowa. Decyzja i jej uzasadnienie są w
`docs/DECYZJA-REMOTE-MCP.md`, spisane PRZED wdrożeniem, celowo.**

Skrót, żebyś nie musiał otwierać: rozważane były Convex (odpada — **nie ma
dostępu do IMAP-a**, a właściciel wprost odrzucił wariant „mobilnie tylko
TeaBrew"), Mac właściciela z tunelem (odpada — dostępność zależy od tego, czy
laptop jest otwarty), VPS (odpada — więcej administrowania niż wartości).
Wybrane: **Railway**, jeden kontener z `Dockerfile`, jeden wolumen na
`COPILOT_STATE_DIR`, `MCP_BEARER_TOKEN` w zmiennych środowiskowych.

Stan kodu: **gotowy i przetestowany lokalnie** — 401 bez tokenu, 11 narzędzi po
autoryzacji, zero sekretów w logu. **Niewdrożony**, bo wymaga konta właściciela.

**Otwarte pytanie, którego NIE DA SIĘ rozstrzygnąć z tej strony:** czego Claude
wymaga w dialogu „dodaj własny konektor" — samego URL-a, pary OAuth
client id/secret, czy pola na nagłówek. Musi to sprawdzić właściciel, bo dialog
jest w jego kliencie. Nie zgaduj i nie buduj OAuth „na wszelki wypadek".

---

## 8. Otwarte obserwacje operacyjne

**Zasięg agenta w poczcie — ROZSTRZYGNIĘTE, patrz sekcja 4.** Obawa o podfoldery
była nieuzasadniona; inwentaryzacja 21 folderów pokazała, że biznesowe są martwe
(`FAKTURY` 761 dni, `ROSSMANN` 885 dni). `MAIL_MONITOR_FOLDERS=INBOX`.

**Pięć automatów nadal zakłada sprawy.** Filtr poczty masowej stoi na nagłówkach
RFC, a te wiadomości **nie mają** `List-Unsubscribe` ani `Precedence: bulk` —
więc przechodzą. Trafiają do sekcji „prawdopodobnie nieistotne" (reguła 5
w `judge()`), czyli nie zaśmiecają góry raportu, ale są. Nie „napraw" tego listą
nadawców: `noreply@` to także potwierdzenia zamówień i awizo kurierskie.

**Rozjazd w liczbach dostępności na BHTJM, NIEROZSTRZYGNIĘTY.** Rano ten sam SKU
raportował `1896 dostępne, 0 rezerwacji`, a po południu `104 dostępne, 1792
zarezerwowane`. Nie umiem stwierdzić, która liczba była prawdziwa — nie mam
historii stanów i nie wolno mi tego dopisać do wniosków. Jeśli będziesz nad tym
pracował: to pytanie do TeaBrew, nie do agenta.

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

Zamknięte, żebyś ich nie otwierał ponownie: **merge PR #27** (zrobiony,
`d950b97`), **Etap B B1 czy B2** (B2 — Railway, `docs/DECYZJA-REMOTE-MCP.md`),
**zasięg folderów** (`INBOX`, na podstawie inwentaryzacji), **kredyty API**
(tylko subskrypcja Claude, zero kredytów).

Otwarte:

1. **Uwierzytelnienie konektora w Claude** — czego wymaga dialog „dodaj własny
   konektor". Tylko właściciel to widzi.
2. **Jak długo trzymać log audytu** i czy na dysku. Nie ma treści maili, ale ma
   numery zamówień i frazy wyszukiwania.
3. **Kto poza właścicielem może pytać agenta.** Dziś: kto ma dostęp do jego
   maszyny i `.env`. Przy większej liczbie osób tożsamość użytkownika wraca jako
   decyzja projektowa.
4. **Czy domykać lukę w guardach wdrożeniowych** teabrew-v2 (sekcja 0, punkt 3).
5. **Czy włączyć kanał powiadomień.** `notificationCandidate` jest wyliczany
   i widoczny, żeby po tygodniu było wiadomo, ile takich sytuacji realnie jest.
6. **Czy dopuścić JEDNO wywołanie modelu na dobę** wyłącznie do raportu — jedyna
   droga do streszczeń własnymi słowami. Zaproponowane, nierozstrzygnięte.

---

## 10. BHT Copilot v1 — co jest zrobione, a co zablokowane

Stan na 17.08.2026. Tabela jest ustawiona wobec „Definition of Done" z zadania,
bez zaokrąglania w górę.

| wymaganie DoD | status |
| --- | --- |
| Remote MCP działa | **kod gotowy, przetestowany lokalnie** (401 bez tokenu, 11 narzędzi, zero sekretów w logu). **NIE wdrożony** — wymaga konta Railway właściciela |
| dostępny z telefonu | **NIE zweryfikowane.** Zależy od wdrożenia i od otwartego pytania o uwierzytelnienie konektora — patrz `docs/DECYZJA-REMOTE-MCP.md` punkt 4 |
| dostęp do prawdziwej poczty | ✅ **potwierdzony przebiegiem monitora na skrzynce właściciela** (20 nowych wiadomości) |
| dostęp do TeaBrew | ✅ `verify:teabrew` 17/17 + 2 zapytania o zamówienia w przebiegu monitora |
| monitoruje właściwe foldery | ✅ **inwentaryzacja WYKONANA** — 21 folderów, wynik: `INBOX` (sekcja 4) |
| nie analizuje całej skrzynki ponownie | ✅ checkpoint per folder + globalny zbiór Message-ID, pokryte testem |
| checkpointy | ✅ na RFC Message-ID, nie na IMAP UID — obsługuje przeniesienie między folderami, powrót i duplikat |
| operator wykrywa nowe sprawy | ✅ **uruchomiony na prawdziwej poczcie**: 20 → 11 odsianych → 9 spraw, 0 wywołań modelu |
| priorytety, rozdzielenie szumu, uzasadnienie | ✅ po krytyce właściciela — sekcja 4, „Raport bez modelu". **Streszczeń własnymi słowami NIE MA** i bez modelu nie będzie |
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
| test na prawdziwych danych z telefonu | ❌ **niewykonany na telefonie właściciela**. Interfejs sprawdzony w Chromium przy 390×844 na zasianych danych — to nie to samo co jego iPhone i jego skrzynka |

**Trzy pozycje są zablokowane na koncie właściciela, nie na kodzie:** wdrożenie
Remote MCP, dostępność z telefonu i test z telefonu. Wszystkie trzy zależą od tej
samej rzeczy — wdrożenia na Railway. Nie próbuj ich odblokować w środowisku
agentowym: egress nie przepuszcza ani IMAP-a, ani Convexa (zmierzone, 8.9).

Reszta tabeli jest potwierdzona na prawdziwych danych, nie tylko testami.

### Nowe rzeczy, o których musisz wiedzieć

- **`src/mcp/core.ts` jest JEDYNĄ implementacją protokołu.** `bin/mcp.ts` (stdio)
  i `bin/mcp-http.ts` (zdalnie) są cienkimi transportami. Test pilnuje, żeby
  żaden z nich nie budował własnej listy narzędzi ani nie wołał rejestru wprost.
- **Ocena wiadomości siedzi w `judge()` w jednym pliku**, pięć uporządkowanych
  reguł, pierwsza pasująca wygrywa. Jeśli właściciel zgłosi, że coś jest źle
  spriorytetyzowane — poprawia się JEDNĄ regułę i dopisuje test, nie przepisuje
  klasyfikatora. Po to `whyListed` niesie treść reguły: żeby wiadomo było, KTÓRA
  reguła zadziałała.
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

---

## 11. Claude JEST interfejsem — i co z tego wynika

Stan na 17.08.2026, po dwóch zmianach kierunku w jednym dniu. Kolejność ma
znaczenie, bo bez niej kod wygląda na niespójny:

1. Rano obowiązywało „Claude jest interfejsem, nie budujemy UI".
2. Po południu właściciel ocenił doświadczenie jako „burdel na kółkach" i polecił
   zbudować interfejs. Zbudowałem: `src/ui/`, ekran spraw, ekran sprawy.
3. Wieczorem uchylił to jednoznacznie: **„NIE BUDUJEMY WŁASNEJ APLIKACJI. Całe UI
   ma być w Claude."** Interfejs został **usunięty**, nie oznaczony jako
   przestarzały — martwy kod sprzeczny z kierunkiem jest gorszy niż jego brak.

**Nie przywracaj `src/ui/`.** Jest w historii gita (`a2c91b2`), jeśli kiedykolwiek
będzie potrzebny, ale dziś jego istnienie łamie wprost wyrażone wymaganie.

### Co z UI zostało, bo było danymi, a nie ekranem

`src/state/lanes.ts` — podział spraw na grupy. Zasila odpowiedź capability,
a Claude rysuje z tego widok. **Grupowanie zostaje po naszej stronie celowo**
i to jest decyzja, którą łatwo „uprościć" i zepsuć: dwa pytania o to samo mają
dać ten sam układ. Gdyby model liczył sekcje za każdym razem od nowa, właściciel
dostawałby raz trzy grupy, raz pięć, i przestałby im wierzyć.

Pola, które `IssueBrief` niesie dla prezentacji: `lane`, `whyListed`,
`neededFromOwner`, `sources`, `missingInErp`, a w liście otwartych spraw dodatkowo
`byLane` i `laneOrder`. Opisy narzędzi mówią Claude, JAK to pokazać — polskie
nagłówki grup, numerowanie pozycji pod „rozwiń 2", zakaz wymyślania zadań, gdy
`neededFromOwner` jest puste.

`laneOf` MUSI zwracać grupę dla każdej sprawy. Ostatnia gałąź jest workiem na
wszystko, także na kategorie, których dziś nie ma. Test `KAŻDA sprawa dostaje
grupę` tego pilnuje — sprawdzone mutacją, że faktycznie broni tej gałęzi.

### Trzy błędy, które wyszły dopiero na prawdziwym wyjściu

Warte zapamiętania, bo żaden nie był widoczny w testach na obecność pól:

1. **To samo zdanie o TeaBrew trzy razy na jednym ekranie**, raz jako „co przyszło
   ostatnio". TeaBrew nic nie przysyła — to MY pytamy. Stąd `EntryKind`
   (`komunikacja` / `system` / `wlasne`) i `lastIncoming()` w `timeline.ts`.
2. **Nazwa kanału wciśnięta między autora i treść**: „Ania — Produkcja — nie mamy
   etykiet". Nazwa kanału należy do etykiety źródła.
3. **Stopka liczyła źródła z konfiguracji, nie z danych.**

Metoda, która je znalazła: uruchomienie serwera na zasianym stanie i przeczytanie
wyjścia. Rób tak samo, zamiast wnioskować z testów.

### Czat w sprawie — dlaczego nie ma go po naszej stronie

Nasza infrastruktura NIE wywołuje modelu i to jest wymaganie, nie oszczędność.
Właściciel pracuje na subskrypcji Claude, bez kredytów API. Reasoning, streszczanie
i priorytetyzowanie w kontekście robi Claude w momencie pytania. Nasza strona
zbiera fakty deterministycznie.

**Nie odtwarzaj reasoningu Claude zestawem reguł deterministycznych.** Reguły mają
filtrować oczywisty szum, wykrywać sygnały i korelować bezpieczne identyfikatory —
i na tym koniec.

---

## 12. Co jest zablokowane i na czym dokładnie

To jest najważniejsza sekcja dla kogoś, kto przejmuje robotę, bo dotyczy rzeczy,
których **żaden agent nie odblokuje sam** — ani ja, ani Ty.

| pozycja | na czym stoi |
| --- | --- |
| wdrożenie na Railway | konto właściciela; logowanie w przeglądarce |
| podłączenie konektora w Claude | dialog w aplikacji właściciela; nie wiemy, czy wymaga OAuth |
| test z telefonu | jego telefon, jego skrzynka |
| Connecteam | klucz API z jego panelu (plan Expert), plus pytanie do wsparcia o Bety |
| zamykanie spraw bez terminala | decyzja produktowa właściciela — patrz niżej |

Przygotowane po naszej stronie: `Dockerfile`, health-check, trwały wolumen,
fail-closed przy braku tokenu, `scripts/deploy-railway.sh` (`npm run wdroz`)
i `docs/WDROZENIE-RAILWAY.md` z drogą ręczną.

**`deploy-railway.sh` nie został uruchomiony na prawdziwym Railwayu.** Nie ma tam
konta, a `docs.railway.com` jest zablokowana przez politykę egress sesji
agentowej — flagi komend pochodzą z opisów w wyszukiwarce. Dlatego każdy niepewny
krok sprawdza wynik i przy błędzie wypisuje `--help`. Sprawdzony na atrapie CLI:
kolejność kroków, idempotencja, kompletność zmiennych, brak wycieku wartości.

### Luka, której nie zamknąłem, bo wymaga decyzji

Po usunięciu UI **nie ma jak zamknąć sprawy bez terminala.** Trzy wymagania
właściciela wykluczają się parami:

- CLI nie ma być częścią codziennej pracy,
- nie dodajemy capability zapisujących,
- model nie ma prawa ustawić statusu `resolved` (wymuszone w `guardStatus`).

Sprawy będą się więc odkładać bez końca. Jedyne wyjście, które nie łamie żadnego
z tych trzech: **reguła deterministyczna w monitorze** — sprawa, w której
odpowiedzieliśmy i od X dni nic nie przyszło, sama przechodzi w
`probably_resolved`. Zgłoszone właścicielowi, **nierozstrzygnięte**. Nie buduj
tego bez jego zgody: to zmiana zachowania, którą ma zaakceptować, a nie odkryć.

### Czego NIE powtarzaj po mnie

Trzy potknięcia z tej sesji, wszystkie tej samej klasy — „ułatwienie", które
tworzy nowy problem:

1. **Dwa razy kazałem właścicielowi wypisać sekret na ekran** (`grep`, `openssl`
   bez `pbcopy`), a on wkleja mi wyjście z terminala. Dwa tokeny do wyrzucenia.
   Sekret nigdy nie ma trafiać na stdout — do schowka albo prosto do pliku.
2. **Zdusiłem wyjście instalatora** przez `>/dev/null 2>&1` i komunikat błędu nie
   powiedział nic. Diagnostyki nie wolno wyciszać.
3. **Założyłem, że `npm i -g` przejdzie na macOS.** Nie przechodzi bez uprawnień.


---

## 13. Wieczór 17.08 — sześć usterek JEDNEJ klasy

To jest najcenniejsza sekcja tego dokumentu, bo opisuje błąd systemowy, który
w tym projekcie wraca. Wszystkie sześć wyszło w ciągu godziny, przy jednym
zadaniu (UX spike), i wszystkie mają to samo źródło:

> **Stan wyliczony raz i nigdy nieweryfikowany, używany jako fakt.**

### Przebieg

Właściciel uruchomił `npm run pilne`. Jako najpilniejsza sprawa w firmie wyszło
**awizo InPostu** — 24-cyfrowy numer przesyłki i NIP w temacie, z uzasadnieniem
„numeru nie ma w TeaBrew".

1. **Sprawdziłem `order-refs.ts` — był naprawiony.** NIP i numer przesyłki nie
   trafiają dziś do TeaBrew. Sprawa pochodziła z przebiegu sprzed poprawki.
2. **Poprawka pierwsza: sprawdzaj KSZTAŁT zapisanych numerów.** Nie zadziałała.
   NIP `8842745578` ma dziesięć cyfr, czyli poprawny kształt naszego numeru
   zamówienia. **Kontrola kształtu z zasady nie odróżni numeru, którego dziś
   byśmy nie wyciągnęli, od takiego, który byśmy wyciągnęli.**
3. **Poprawka druga: rozpoznaj numery OD NOWA** dzisiejszymi regułami, z tytułu
   i streszczenia sprawy (`currentOwnOrderRefs`). Zadziałała — ale sprawa dalej
   stała na górze.
4. **Diagnostyka od właściciela** (`npm run pilne -- --dlaczego`) pokazała
   dlaczego: monitor ustawił w JEDNYM przebiegu `lastErpSummary`, `priority:
   high` **i** `notificationCandidate: true`. Odebranie wiary jednemu polu nic
   nie dawało — sprawa wracała z innym uzasadnieniem. **Unieważniać trzeba cały
   przebieg, nie pojedyncze pole.**
5. **Ta sama diagnostyka pokazała coś groźniejszego:** `likelyIrrelevant:
   undefined`. Dziennik odtwarzamy przez `JSON.parse`, więc sprawy sprzed
   dodania pola nie mają go wcale — a wyjście capability **jest sprawdzane
   zodem** i `whyListed` jest tam wymaganym łańcuchem. Jedna stara sprawa
   wywracała CAŁĄ odpowiedź `copilot_get_open_issues` błędem `invalid_output`,
   czyli **Claude nie mógł wypisać ani jednej sprawy.** Naprawa:
   `CopilotStore.complete()` uzupełnia pola przy wczytaniu.
6. **Po naprawie na górę weszła wiadomość phishingowa** i odsłoniła dwie kolejne:
   - monitor przy scaleniu ustawiał `likelyIrrelevant: false` **na sztywno**
     („ktoś wrócił do sprawy, więc to korespondencja"). Zawodzi dokładnie tam,
     gdzie boli: phishing i newslettery piszą powtórnie **z definicji**,
   - `laneOf` traktowało status `waiting_for_owner` jak DECYZJE, a monitor
     ustawia go KAŻDEJ wiadomości kategorii `reply`. DECYZJE były więc drugą
     kopią ODPOWIEDZI.

### Co z tego wynika dla Ciebie

- **Nie ufaj polu, którego nie umiesz dziś odtworzyć.** Jeśli wartość powstała
  z reguły, która od tamtej pory się zmieniła, przelicz ją albo zignoruj.
  `currentOwnOrderRefs` jest wzorcem: liczy z tekstu, który mamy, dzisiejszymi
  regułami, więc stan **leczy się sam** przy każdej kolejnej poprawce.
- **Unieważniaj przebieg, nie pole.** Monitor pisze kilka pól naraz; jeśli
  podstawa przebiegu upadła, upadają wszystkie jego skutki.
- **Wyjście capability jest walidowane zodem.** Każde nowe pole w `Issue`
  wymaga wartości domyślnej w `CopilotStore.complete()`, inaczej stary dziennik
  wywali całe narzędzie. Awaria wygląda wtedy jak problem z MCP, nie jak jeden
  felerny wpis — i to jest najgorsze w niej.
- **Nie zgaduj, co siedzi w danych właściciela.** Zgadywałem dwa razy i dwa razy
  wysłałem go do terminala po nic. Rozstrzygnęło dopiero
  `npm run pilne -- --dlaczego`, które wypisuje pola decydujące BEZ treści
  wiadomości. Ta flaga istnieje właśnie po to — używaj jej od razu.

### Stan po tych poprawkach

175 testów. Trzy nowe pliki testowe odtwarzają dokładnie te kształty danych,
łącznie z dziennikiem sprzed zmiany schematu. **Żadna z tych usterek nie została
wykryta testem — wszystkie wyszły na prawdziwej skrzynce.** Testy powstały
później, żeby nie wróciły.

---

## 14. Wieczór 17.08, część druga — telefon podłączony, werdykt A

Odpowiedź na pytanie architektoniczne z ostatniej specyfikacji: **czy Claude
może być docelowym interfejsem na komputerze i na telefonie.**

### Werdykt: A — tak, na obu. Ale nie drogą, którą zakładało pytanie.

Pełne uzasadnienie i pomiary: `docs/UX-SPIKE-CLAUDE.md`, sekcja na samej górze.
Tu jest to, czego nie wolno zgubić przy planowaniu dalszej pracy.

### Dowód, że to nie jest wrażenie

Właściciel zapytał z iPhone'a w nowej rozmowie: „Co mam obecnie otwartego w BHT
Copilot?". Claude odpowiedział, że jest **14 otwartych spraw**, i wypisał je
ponumerowane, zaczynając od tej samej pozycji, którą w tej samej minucie
zwracał serwer. Liczba i kolejność zgadzają się co do jednego, a tych danych
nie ma nigdzie poza tym serwerem — więc narzędzie zostało wywołane naprawdę.
Drugim, niezależnym potwierdzeniem jest to, że aplikacja **zapytała o pozwolenie**
przed wywołaniem.

**To zamyka pytanie, które poprzednia wersja spike'a musiała zostawić otwarte:
konektor MCP DZIAŁA w aplikacji mobilnej.**

### Co odpada z wymagań

**„Powiadomienie → jedno kliknięcie → rozmowa o sprawie" jest martwe.** Nie
z powodu naszego kodu. Deep link doszedł do końca i dał poprawną, przeanalizowaną
odpowiedź, ale przez pięć czynności:

1. wklejony adres Safari potraktowało najpierw jak frazę do wyszukania w Google,
2. otworzył się **przeglądarkowy** Claude, nie natywna aplikacja,
3. przeglądarka wymagała **zalogowania**,
4. polecenie czekało w polu na „wyślij" — platforma nigdy nie wysyła polecenia
   z zewnętrznego linku bez potwierdzenia człowieka i **nie wolno tego obchodzić**,
5. zgoda na wywołanie narzędzia.

Droga zwykła — otwórz Claude, zapytaj słowami — to **dwie** czynności i żadnej
pułapki. Zbudowaliśmy generator linków (`npm run pilne`), żeby skrócić dojście
do sprawy, a wyszło, że dojście po ludzku jest krótsze. **`npm run pilne`
zostaje narzędziem diagnostycznym, nie pomysłem na produkt.**

Konsekwencja dla planu powiadomień: skoro push nie może otworzyć rozmowy, jego
JEDYNĄ wartością jest trafność. Cała wartość produktu przenosi się na dobór
treści — czyli na obszar, w którym sekcja 13 wylicza sześć usterek jednej klasy.

### Siódma usterka tej samej klasy — nienaprawiona, świadomie

Tego samego wieczoru na szczyt grupy „🔴 Teraz" wszedł **podpis mailowy samego
właściciela**: numer telefonu ze stopki (`732 958 000`) ma kształt naszego
numeru zamówienia, w TeaBrew go nie ma, więc sprawa dostała `missingInErp` i
najwyższy priorytet. To dokładnie ten sam mechanizm co NIP InPostu z sekcji 13,
tylko inny rodzaj liczby.

**Nie naprawiona, bo właściciel wprost zakazał naprawiania czegokolwiek w trakcie
testu UX.** Do podjęcia przy najbliższej okazji — i uwaga: kontrola KSZTAŁTU
tego nie złapie, bo kształt jest poprawny. Potrzebny jest kontekst (numer
pochodzący z bloku podpisu / z własnej domeny nadawcy nie jest numerem
zamówienia).

### Co kosztowało samo podłączenie — cztery rundy, wszystkie nasze

Każda wyglądała dla właściciela identycznie: „nie łączy się i nie mówi dlaczego".
Żadnej nie złapał test przed faktem.

| # | Objaw | Przyczyna | Naprawa |
| --- | --- | --- | --- |
| 1 | okno „Add custom connector" nie ma pola na token | serwer bronił się statycznym tokenem, którego ten klient nie umie podać | OAuth 2.1: `src/mcp/oauth.ts` — PKCE S256, rejestracja dynamiczna, tokeny podpisane HMAC (przeżywają restart), ekran zgody na hasło właściciela |
| 2 | „Couldn't register with sign-in service" | `OPTIONS` na końcówkach OAuth zwracało 404, więc preflight blokował żądanie **zanim wyszło** — po naszej stronie nie było nawet wpisu w logu | odpowiedź na preflight + CORS na powierzchni JSON |
| 3 | wdrożenie zameldowało sukces ze **starym** kodem | `railway up` wysyła katalog **lokalny**, a kopia właściciela była starsza o dwa commity; sprawdzenie po wdrożeniu pytało tylko „czy `/health` odpowiada" — a odpowiadał poprzedni kontener | porównanie `HEAD` z `origin` **przed** wysłaniem + czekanie na **zmianę** `startedAt` |
| 4 | „nowa wersja nie wstała w 4 minuty" | wstała po ~5,5 min; okno było zgadywane, bo pełnego cyklu nigdy nie zmierzyliśmy — poprzednie sprawdzenie zaliczało odpowiedź starego kontenera natychmiast | okno 9 minut + wypisywanie zmierzonego czasu |

**Reguła, którą z tego wyciągam i którą warto trzymać w tym projekcie:**
„gotowe" musi znaczyć **„odpowiada nowa wersja"**, nie „cokolwiek odpowiada".
Runda 3 kosztowała najwięcej i była w całości usterką narzędzia, nie produktu.

### Co przybyło w kodzie

| plik | co |
| --- | --- |
| `src/mcp/oauth.ts` | cały OAuth 2.1 — funkcje czyste, bez stanu na dysku |
| `src/bin/mcp-http.ts` | okablowanie OAuth, CORS, `/health` mówi `oauth`, `issuer`, `startedAt`, `protocols` |
| `src/mcp/core.ts` | uzgadnianie wersji protokołu (`negotiateProtocol`) zamiast jednej stałej odpowiedzi |
| `tests/oauth-chain.test.ts` | **cała droga Claude na żywym procesie**: 401 ze wskazaniem → metadane zasobu → metadane serwera autoryzacji → rejestracja → zgoda → kod → token → `tools/list`. Powstał, bo runda 2 była zielona we wszystkich testach jednostkowych |
| `scripts/deploy-railway.sh` | strażnik świeżości kopii, czekanie na nowy kontener, sprawdzenie `oauth` |

201 testów przechodzi. `tsc --noEmit` czysty.

### Co zostaje otwarte

- **Wolumen `/data` na Railwayu NIE JEST dodany.** Sprawy nie przeżyją restartu
  kontenera; po restarcie monitor odtworzy je ze skrzynki przy pierwszym skanie.
  CLI Railwaya wywraca się na tym paniką Rusta (`volume.rs:836`) — to błąd ich
  narzędzia, panel działa. **Do codziennej pracy wymagane.**
- **Siódma usterka doboru** (wyżej).
- Wszystko z sekcji 9 — decyzje właściciela — pozostaje aktualne.

---

## 15. Walidacja GO/NO-GO — wynik: NO-GO

Pełny raport: `docs/GO-NOGO-VALIDATION.md`. Tu jest to, co musi wpłynąć na
planowanie dalszej pracy.

| Obszar | Wynik | Skąd wiadomo |
| --- | --- | --- |
| Connecteam | **FAIL** | prawdziwe konto, prawdziwy klucz, trzy ścieżki odczytu → 404/405 |
| Push iPhone | **PASS** | prawdziwe powiadomienie na iPhonie właściciela, aplikacja zamknięta |
| Quality | **FAIL** | 50 prawdziwych wiadomości, etykiety właściciela, czułość alarmu **0%** |

### Najważniejsze ustalenie: to jest JEDEN zły sygnał, nie seria pomyłek

Sekcja 13 opisywała sześć usterek jednej klasy i traktowała je jako usterki.
Pomiar pokazał, że to nie były usterki, tylko **konsekwencje reguły**:

> System podnosi alarm wtedy i tylko wtedy, gdy znajdzie numer o KSZTAŁCIE
> naszego zamówienia, którego **NIE MA w TeaBrew**.

Ta reguła odpowiada na pytanie „czy coś się rozjechało w danych", a nie „czy to
jest pilne". Z niej wynikają obie strony błędu naraz — i dlatego nie da się jej
poprawić wyjątkami:

**Fałszywe alarmy (3 z 3 pochodzą stąd):** numer faktury dostawcy `20260162`,
numer telefonu współpracowniczki `534888748`, własny numer telefonu właściciela
ze stopki `732958000`. Każdy z nich ma poprawny kształt numeru zamówienia.
Kontrola kształtu **z zasady** tego nie odróżni — to czwarty raz, kiedy ten sam
mechanizm wyprodukował fałszywy alarm (wcześniej NIP InPostu, dziesięć cyfr).

**Przeoczone alarmy (2 z 4 pochodzą stąd):** zamówienia Rossmanna `2307348`
i `2307029` — prawdziwe, przychodzące, numer rozpoznany poprawnie. Nie
zaalarmowały, bo **są** w TeaBrew. Przy tej regule poprawnie działające
zamówienie od dużego klienta jest **z definicji niealarmowalne.**

**Pozostałe 2 przeoczenia** to inna klasa: powiadomienia z Missive („X mentioned
you") odrzucone przez filtr szumu po nagłówkach `List-Unsubscribe` /
`Precedence` / `Auto-Submitted`. Reguła jest poprawna dla masówki, ale narzędzia
zespołowe wysyłają tymi nagłówkami także rzeczy imienne. Odsianie jest
**milczące**, więc te wiadomości nie pojawiają się nigdzie.

### Liczby, żeby nie trzeba było ich szukać

| | A (alarm) | B (podsumowanie) | C (nieistotne) |
| --- | --- | --- | --- |
| właściciel | 4 | 18 | 28 |
| system | 3 | 8 | 39 |

Czułość ALARM **0%**, precyzja **0%**, TP **0**, FN **4**, FP **3**, zgodność
3-klasowa 68%. Ta ostatnia liczba jest myląca — bierze się prawie w całości
z klasy C, najliczniejszej. Osobna obserwacja: **system ukrywa więcej, niż
właściciel chce ukryć** (39 wobec 28).

Zbiór ma 50, nie 100 wiadomości, i powód jest strukturalny: kontrakt
`mail_list_recent` ogranicza jeden odczyt do 50, a **to samo ograniczenie ma
monitor** — system nigdy nie ogląda więcej za jednym razem. Nie podniosłem tego
limitu, bo zmiana kontraktu w środku pomiaru znaczyłaby, że mierzę coś innego
niż produkt.

### Czego NIE robić

**Nie łatać tych przypadków wyjątkami per nadawca, format czy numer.** Zadanie
tego zabraniało i pomiar pokazuje, dlaczego: przy zerowej czułości i zerowej
precyzji problemem nie jest kalibracja progu, tylko to, że sygnał mierzy co
innego. Każdy wyjątek dołożony do tej reguły przedłuża jej życie i utrudnia
zobaczenie, że jest zła.

**Nie zwiększać zbioru w nadziei na lepszy wynik.** Przy zerowej liczbie trafień
wniosek nie zależy od wielkości próby.

### Narzędzie do powtórzenia pomiaru

`npm run ocena` — zamraża zbiór do pliku, klasyfikuje go aktualnym mechanizmem,
zbiera etykiety właściciela **bez pokazywania mu oceny systemu** (jedno
naciśnięcie klawisza na wiadomość), liczy metryki i wypisuje przeoczone alarmy
z powodem przegapienia. `npm run ocena -- --wynik` wypisuje same liczby.
`--od-nowa` zaczyna od zera. Narzędzie nie woła modelu i niczego nie zapisuje
ani w skrzynce, ani w dzienniku spraw.

**Po każdej zmianie w doborze spraw ten pomiar da się powtórzyć na tym samym
zamrożonym zbiorze i tych samych etykietach** — czyli porównać uczciwie.

### Co przybyło w kodzie przy okazji Testu 2

Odbiornik Web Push: `src/push/{subskrypcje,wyslij,strona}.ts`, okablowanie
w `src/bin/mcp-http.ts` (`/push`, `/push/sw.js`, `/push/manifest.webmanifest`,
`/push/ikona.png`, `POST /push/{subscribe,unsubscribe,test}`), generator kluczy
`scripts/generuj-vapid.mjs` i wysyłka `npm run push:test`. Wybrany świadomie
zamiast ntfy/Pushover: ładunek jest szyfrowany end-to-end, więc nazwy klientów
i numery zamówień nie przechodzą przez cudzy serwer otwartym tekstem.

Strona jest ODBIORNIKIEM, nie interfejsem: jedno pole, jeden przycisk, zero
spraw na ekranie. Nie jest wyjątkiem od decyzji „całe UI w Claude".

### Otwarte, z przypisaniem

- **Wolumen `/data` na Railwayu — właściciel, 2 minuty w panelu.** Bez niego
  restart kontenera kasuje sprawy ORAZ subskrypcję powiadomień. CLI Railwaya
  wywraca się na tym paniką własnego narzędzia (`volume.rs:836`).
- **Webhooki czatu Connecteam — pytanie do wsparcia dostawcy.** Jeśli włączą,
  po naszej stronie nie ma nic do zbudowania.
- **Zamykanie spraw bez terminala — decyzja produktowa właściciela.** Wciąż
  otwarta, patrz sekcja 9.
