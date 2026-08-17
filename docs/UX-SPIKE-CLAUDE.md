# UX SPIKE — powiadomienie → jedno kliknięcie → rozmowa o tej sprawie

**17.08.2026.** Pytanie: czy da się z powiadomienia trafić prosto do rozmowy
o konkretnej sprawie, bez kopiowania, wklejania i pamiętania identyfikatorów.

---

# WERDYKT KOŃCOWY: **A — Claude nadaje się na interfejs, na Macu i na telefonie**

**Ale nie tą drogą, którą zakładało pytanie.** Wersja „powiadomienie → jedno
kliknięcie → rozmowa o sprawie" jest martwa i trzeba ją wykreślić z wymagań.
To, co działa, jest prostsze od tego, co budowaliśmy: **otwierasz Claude
i pytasz normalnym zdaniem.**

Sprawdzone 17.08 wieczorem na iPhonie właściciela, na prawdziwej skrzynce,
po wdrożeniu Remote MCP na Railway:

| Droga na iPhonie | Czynności | Zadziałało? |
| --- | --- | --- |
| **Otwórz Claude, zapytaj słowami** — „Co mam obecnie otwartego w BHT Copilot?" | **2** (+ zgoda na narzędzie) | **TAK.** Wypisał 14 spraw, ponumerowane, pierwsza zgodna z serwerem |
| **Deep link do konkretnej sprawy** | **5**, w tym logowanie w przeglądarce | Odpowiedź przyszła i była poprawna, ale **nie w zakładanej formie** |

Odpowiedź „14 spraw" jest twardym dowodem, a nie wrażeniem: dokładnie tyle
zwrócił w tej samej minucie serwer, a tych danych nie ma nigdzie poza nim.
**To zamyka pytanie otwarte z poprzedniej wersji tego dokumentu — konektor MCP
DZIAŁA w aplikacji mobilnej.**

Deep link **doszedł do końca** — właściciel dostał przeanalizowaną odpowiedź
o sprawie. Rozstrzyga go nie brak wyniku, tylko droga do niego. Pełny przebieg,
krok po kroku, tak jak go przeszedł:

1. wklejony adres Safari potraktowało najpierw jak frazę do **wyszukania
   w Google**,
2. przejście pod adres otworzyło Claude **w przeglądarce, nie w natywnej
   aplikacji**,
3. przeglądarka wymagała **zalogowania się** — natywna aplikacja jest zalogowana
   z góry i tego kroku by nie było,
4. polecenie **nie wysłało się samo** — czekało w polu na „wyślij"
   (to zakaz platformy, opisany niżej, nie nasza niedoróbka),
5. przed pobraniem sprawy Claude **zapytał o pozwolenie**,
6. odpowiedź przyszła — poprawna i przeanalizowana.

Krok 5 jest przy okazji dowodem, że narzędzie naprawdę zostało wywołane.
Krok 3 jest tym, który najbardziej boli i którego nie da się usunąć naszym
kodem: link `https://claude.ai/…` prowadzi do przeglądarki, a nie do aplikacji,
więc trafia się na sesję bez logowania.

**Wniosek, który zmienia plan:** inżynierowana droga jest dłuższa i bardziej
zawodna niż droga zwykła. Zbudowaliśmy generator linków (`npm run pilne`), żeby
skrócić dojście do sprawy, a wychodzi, że dojście po ludzku — otwórz i zapytaj —
jest krótsze. Deep link zostaje jako narzędzie diagnostyczne, nie jako pomysł
na produkt.

**Co z tego wynika dla powiadomień.** Push nie może być linkiem, który otwiera
gotową rozmowę, bo platforma na to nie pozwoli. Może być zwykłym
powiadomieniem, po którym właściciel sam otwiera Claude i pyta. Wartość
powiadomienia leży więc **wyłącznie w tym, że jest trafne** — a to jest
dokładnie ten obszar, w którym spike znalazł sześć usterek (niżej) i w którym
tego samego wieczoru znalazł siódmą: na szczyt „🔴 Teraz" wszedł **podpis
mailowy samego właściciela**, bo numer telefonu ze stopki (`732 958 000`) ma
kształt numeru zamówienia i nie ma go w TeaBrew. Ten sam mechanizm co przy
NIP-ie, inny rodzaj liczby.

---

## Wynik pomiarów

| Platforma | Czynności | MCP | Wynik |
| --- | --- | --- | --- |
| **Mac** (Claude Desktop) | **2**: klik w link + wyślij | **działa** — potwierdzone na prawdziwych danych (Etap A) | **AKCEPTOWALNE** |
| **iPhone** — pytanie słowami | **2** + zgoda na narzędzie | **działa** — 14 spraw, zgodne z serwerem co do jednej | **DOBRE** |
| **iPhone** — deep link | **5**: wklejenie (raz w Google), przeglądarka zamiast aplikacji, logowanie, wyślij, zgoda | działa — odpowiedź poprawna i przeanalizowana | **ODRZUCONE jako droga produktowa** — działa, ale dłużej niż zapytanie słowami |

---

## Co faktycznie działa

**Deep link do nowej rozmowy z gotowym poleceniem.** Format
`claude://claude.ai/new?q=<polecenie>` otwiera nowy czat z wpisanym poleceniem.
Wariant przeglądarkowy: `https://claude.ai/new?q=…`.

**W adresie jest wyłącznie identyfikator sprawy.** Żadnego tematu, nadawcy,
numeru zamówienia ani streszczenia. Dwa powody, oba praktyczne: adres trafia do
historii przeglądarki i bywa widoczny na ekranie blokady, a dane wpisane w URL
są **zamrożone w momencie kliknięcia** — Claude mówiłby wtedy o stanie sprzed
godziny z pełnym przekonaniem. Aktualny stan pobiera przez MCP.

**MCP na Macu jest sprawdzony na prawdziwych danych.** Cztery testy Etapu A,
w tym korelacja poczty z TeaBrew i uczciwe „tego zamówienia nie ma w systemie".

**Generator powiadomienia i linku:** `npm run pilne`. Bierze najpilniejszą
sprawę (albo wskazaną), wypisuje treść powiadomienia — sprawa, jedno zdanie,
dlaczego wymaga uwagi — oraz oba adresy, i wysyła powiadomienie systemowe macOS.

**Uruchomione TRZY RAZY na prawdziwej skrzynce właściciela.** Mechanizm działał
za każdym razem: treść powiadomienia, oba adresy, powiadomienie systemowe.
**Za każdym razem wybierał złą sprawę** — i to jest najważniejszy wynik tego
spike'a, ważniejszy niż sam link.

| przebieg | co wyszło na szczyt | przyczyna |
| --- | --- | --- |
| 1 | awizo InPostu (NIP + numer przesyłki) | `lastErpSummary` zapisane raz i nigdy nieweryfikowane |
| 2 | to samo awizo | kontrola KSZTAŁTU numerów nie działa: NIP ma 10 cyfr, czyli poprawny kształt |
| 3 | to samo awizo | `priority: high` i `notificationCandidate` ustawione tym SAMYM starym przebiegiem |
| 4 | wiadomość **phishingowa** | `likelyIrrelevant` kasowane na sztywno przy scaleniu + kolizja nazw `waiting_for_owner` |

Wszystkie sześć usterek ma jedno źródło: **stan wyliczony raz i nigdy
nieweryfikowany, używany jako fakt.** Szczegóły i wnioski w
`docs/HANDOFF-CODEX.md`, sekcja 13.

**Najgroźniejsza nie miała nic wspólnego z UX.** Diagnostyka pokazała
`likelyIrrelevant: undefined` — sprawy sprzed zmiany schematu nie mają pól
dodanych później, a wyjście capability jest sprawdzane zodem. Jedna taka sprawa
wywracała CAŁĄ odpowiedź `copilot_get_open_issues`, czyli **Claude nie mógł
wypisać ani jednej sprawy** — a awaria wyglądała jak problem z MCP, nie jak
jeden felerny wpis. To zdarzało się właścicielowi zanim ktokolwiek to zauważył.

Wniosek dla oceny UX, i jest on ostrzejszy niż przed testem: **mechanizm
dostarczenia jest sprawny, a ryzyko produktu leży w CAŁOŚCI w doborze treści.**
Push z niewłaściwą sprawą jest gorszy niż brak pusha — po trzech takich
powiadomieniach właściciel przestaje je otwierać i cały pomysł umiera, niezależnie
od tego, jak dobry jest deep link.

Żadnej z tych sześciu usterek **nie wykrył test.** Wszystkie wyszły na prawdziwej
skrzynce, przy tym jednym scenariuszu. Testy dopisano po fakcie (175).

---

## Co blokuje idealny UX

**1. Jednego kliknięcia nie da się osiągnąć i to jest decyzja platformy, nie
nasza niedoróbka.** Dokumentacja Anthropica mówi wprost: *„A deep link never
executes anything on its own. The link only chooses a directory and fills the
prompt box… nothing reaches the model until you read what was filled in and
press Enter."* Polecenie z zewnętrznego linku jest **zawsze** wpisywane do pola
i czeka na potwierdzenie człowieka. Sesja pokazuje przy tym ostrzeżenie
`Prompt from an external link`.

To jest zabezpieczenie przed tym, żeby kliknięcie w cudzy link nie uruchomiło
niczego w Twoim imieniu — i z tego samego powodu **nie da się go obejść**.
Sufit tego scenariusza to więc kategoria AKCEPTOWALNE z Twojej listy:
klik + jedna oczywista czynność.

**2. Powiadomienie macOS nie otwiera adresu po kliknięciu.** AppleScript
`display notification` nie przyjmuje akcji z URL-em; kliknięcie budzi aplikację,
która powiadomienie wysłała. Adres jest więc wypisany w terminalu i to jego się
klika. Obejście istnieje (`terminal-notifier -open <url>`), ale to dodatkowa
zależność, a spike nie ma budować systemu powiadomień.

**3. ~~Telefon nie ma dziś dostępu do spraw.~~ ZAŁATWIONE 17.08 wieczorem.**
Remote MCP stoi na Railwayu, konektor podłączony przez OAuth, telefon pobiera
sprawy. Droga do tego zajęła cztery rundy i wszystkie były usterkami po naszej
stronie — spis w sekcji „Co kosztowało podłączenie".

**4. ~~Deep link mobilny — niepotwierdzony.~~ SPRAWDZONY, wynik negatywny dla
produktu.** Adres `https://claude.ai/new?q=…` otwiera **przeglądarkę, nie
natywną aplikację**, więc dochodzi logowanie. Wariantu `claude://` nie
testowaliśmy — po wyniku powyżej przestał mieć znaczenie: nawet gdyby otwierał
aplikację, zostaje zakaz auto-wysyłania z punktu 1, a droga „otwórz i zapytaj"
i tak jest krótsza.

---

## Czego świadomie nie zrobiłem

Nie budowałem obejścia dla auto-wysyłania polecenia. Zakaz jest po stronie
platformy i celowy; obchodzenie go dawałoby kruche rozwiązanie, które przestanie
działać przy pierwszej aktualizacji aplikacji — a przestanie w sposób
nieodróżnialny od „nic nie przyszło".

Nie tknąłem Connecteam, zgodnie z zakresem spike'a.

---

## Rekomendacja sprzed testu na telefonie — NIEAKTUALNA

> Zostawiona, bo pokazuje, co było wiadomo przed wieczorem 17.08 i czego nie
> dało się wtedy rozstrzygnąć. Obowiązuje **werdykt A** na górze dokumentu.

### ~~B — Claude nadaje się na desktopie; telefon nierozstrzygnięty~~

Uzasadnienie, bez zaokrąglania:

- **Na Macu scenariusz działa dziś** w kategorii AKCEPTOWALNE. Dwie czynności:
  kliknięcie w link i wysłanie gotowego polecenia. Mniej się nie da i to nie
  jest kwestia naszego kodu.
- **Telefon nie jest jeszcze przetestowany, ale nie ma dowodu, że zawodzi.**
  Blokuje go jedno wdrożenie, nie ograniczenie produktu. Uznanie teraz wariantu
  C byłoby porzuceniem interfejsu na podstawie testu, którego nie wykonano.
- **Wariant A będzie uzasadniony**, jeśli po wdrożeniu telefon zachowa się jak
  Mac: dotknięcie linku otwiera Claude z gotowym poleceniem, a Claude pobiera
  sprawę przez MCP.

**Wariant C rozważaj dopiero wtedy**, gdy telefon pokaże jedno z dwóch: link nie
otwiera zwykłego czatu z poleceniem, albo konektor MCP nie działa w aplikacji
mobilnej. Wtedy — i tylko wtedy — Claude nie spełnia wymagań interfejsu
mobilnego i trzeba szukać czegoś innego.

---

## Co kosztowało podłączenie telefonu

Cztery rundy, wszystkie z winy naszego kodu albo naszych narzędzi. Zapisane,
bo każda była niewidoczna w testach i każda wyglądała dla właściciela identycznie:
„nie łączy się i nie mówi dlaczego".

| # | Objaw | Przyczyna | Naprawa |
| --- | --- | --- | --- |
| 1 | okno konektora nie ma pola na token | serwer bronił się statycznym tokenem, którego ten klient nie umie podać | OAuth 2.1 z rejestracją dynamiczną i ekranem zgody na hasło |
| 2 | „Couldn't register with sign-in service" | `OPTIONS` na końcówki OAuth zwracało 404, więc preflight przeglądarki blokował żądanie **zanim wyszło** — u nas nie było nawet wpisu w logu | odpowiedź na preflight + nagłówki CORS |
| 3 | wdrożenie meldowało sukces ze starym kodem | skrypt wysyła katalog **lokalny**, a kopia właściciela była starsza o dwa commity; sprawdzenie po wdrożeniu pytało tylko „czy `/health` odpowiada", a odpowiadał poprzedni kontener | porównanie z `origin` przed wysłaniem + czekanie na **zmianę** `startedAt` |
| 4 | „nowa wersja nie wstała w 4 minuty" | wstała po ~5,5 minuty — okno było zgadywane, bo pełnego cyklu nigdy nie zmierzyliśmy | okno 9 minut i wypisywanie zmierzonego czasu |

Wniosek narzędziowy: **„gotowe" musi znaczyć „nowa wersja odpowiada", nie
„cokolwiek odpowiada"**. Trzecia runda kosztowała najwięcej i była w całości
usterką skryptu, nie produktu.

---

## Co dalej — decyzje dla właściciela

1. **Wykreślić „jedno kliknięcie" z wymagań.** Platforma nigdy nie wyśle
   polecenia z zewnętrznego linku bez potwierdzenia człowieka i nie należy tego
   obchodzić. Wejściem do Copilota jest otwarcie Claude i zapytanie słowami.
2. **Powiadomienia mają sens tylko wtedy, gdy są trafne.** Skoro push nie może
   otworzyć rozmowy, jego jedyną wartością jest treść. Siódma usterka doboru
   (podpis mailowy właściciela na szczycie „Teraz") mówi, że tam jest dziś
   ryzyko produktu — nie w dostarczaniu.
3. **Dodać wolumen na Railwayu** (panel → usługa `bht-copilot` → Settings →
   Volumes → `/data`). Bez niego sprawy nie przeżyją restartu kontenera. CLI
   Railwaya wywraca się na tym błędem własnego narzędzia; panel działa.
