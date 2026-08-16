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
`References`, 2 wiadomości) → `teabrew_get_order_status` (dopasowanie po
`externalOrderId`, status `in_production`, pozycje, powiązane zlecenie
produkcyjne) → odpowiedź ze stopką dowodową. To jest scenariusz 2 w
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

37 testów, bez sieci i bez klucza API — model jest atrapą odgrywającą
zaplanowane kroki, dane pochodzą z fikstur. Pięć scenariuszy akceptacyjnych
odpowiada pięciu wymaganiom: read-only, ścieżka od maila do danych, brak
zmyślania, dostępność produktu z nazwy handlowej, użyteczność audytu bez
wycieku treści.

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

### Nie działa, dopóki nie dostanie danych wejściowych

Dwie rzeczy są poza zasięgiem tego repozytorium i **nie zostały udawane**:

1. **Poczta.** Nie mam żadnych danych dostępowych do skrzynki. Adapter IMAP jest
   napisany, ale nigdy nie łączył się z prawdziwym serwerem.
2. **TeaBrew v2.** Mam do tamtego repozytorium dostęp wyłącznie do odczytu, więc
   pięć tras nie zostało tam wdrożonych. Leżą gotowe w
   `ai-operator/teabrew-patch/` wraz z instrukcją i skryptem weryfikującym.

Dlatego wszystko jest zbudowane **do interfejsów**, z dostawcami na fiksturach.
`MODE=fixture` przechodzi całą ścieżkę end-to-end od razu; `MODE=live` zmienia
implementację dostawcy, nie narzędzia widziane przez AI.

**Co zostało sprawdzone, a co nie:**

| element | stan |
| --- | --- |
| rejestr, projekcje, audyt, kontrola dowodów, pętla agenta, triage | przetestowane, 37 testów przechodzi |
| ścieżka poczta → AI → TeaBrew na fiksturach | działa end-to-end |
| `npm run caps`, `npm run openapi` | uruchomione, dają 7 capability |
| konfiguracja → warstwa modeli → API Anthropic | potwierdzone (żądanie dociera, przy błędnym kluczu wraca 401) |
| odpowiedź prawdziwego modelu | **nie uruchomione — brak klucza API w tym środowisku** |
| adapter IMAP wobec prawdziwego serwera | **nie uruchomione — brak danych dostępowych** |
| pięć tras w TeaBrew v2 | **nie wdrożone — brak uprawnień do zapisu** |

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
