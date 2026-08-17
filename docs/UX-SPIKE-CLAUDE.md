# UX SPIKE — powiadomienie → jedno kliknięcie → rozmowa o tej sprawie

**17.08.2026.** Pytanie: czy da się z powiadomienia trafić prosto do rozmowy
o konkretnej sprawie, bez kopiowania, wklejania i pamiętania identyfikatorów.

---

## Wynik

| Platforma | Czynności | MCP | Wynik |
| --- | --- | --- | --- |
| **Mac** (Claude Desktop) | **2**: klik w link + wyślij | **działa** — potwierdzone na prawdziwych danych (Etap A) | **AKCEPTOWALNE** |
| **iPhone** (Claude Mobile) | **do zmierzenia** — jedno dotknięcie rozstrzyga | **NIE działa** — brak wdrożenia Remote MCP | **FAIL dzisiaj** |

Wiersz iPhone'a jest FAIL **nie z powodu UX**, tylko dlatego, że aplikacja
mobilna nie ma dziś dostępu do spraw. Nawet idealny link otworzyłby rozmowę,
w której Claude nie ma czym pobrać sprawy.

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

**3. Telefon nie ma dziś dostępu do spraw.** Claude Mobile potrzebuje Remote MCP
pod publicznym adresem. Kod jest gotowy, wdrożenie czeka na konto właściciela.

**4. Deep link mobilny — niepotwierdzony.** Dokumentacja mówi, że aplikacje
iOS i Android odpowiadają na schemat `claude://` i potrafią wypełnić pole nowej
sesji. Ale **większość opisanych tras dotyczy zakładki Claude Code**, a jedno
źródło zaznacza, że takie linki wymagają dostępu do Claude Code na koncie.
Czy `claude://claude.ai/new?q=` — czyli ZWYKŁY czat — zadziała na iPhonie,
**nie jest przez mnie potwierdzone**. Autorytatywna strona pomocy
(`support.claude.com`) jest zablokowana przez politykę sieci mojej sesji.

To rozstrzyga jedno dotknięcie na Twoim telefonie i nie da się tego zastąpić
czytaniem.

---

## Czego świadomie nie zrobiłem

Nie budowałem obejścia dla auto-wysyłania polecenia. Zakaz jest po stronie
platformy i celowy; obchodzenie go dawałoby kruche rozwiązanie, które przestanie
działać przy pierwszej aktualizacji aplikacji — a przestanie w sposób
nieodróżnialny od „nic nie przyszło".

Nie tknąłem Connecteam, zgodnie z zakresem spike'a.

---

## Rekomendacja

### **B — Claude nadaje się na desktopie; telefon nierozstrzygnięty**

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

## Jak dokończyć ten spike

Dwie czynności, w tej kolejności:

1. **Wdróż Remote MCP** — `npm run wdroz`, potem podłącz konektor w Claude.
   Bez tego telefon nie ma czego pobrać i test nie odpowie na nic.
2. **Uruchom `npm run pilne`** i dotknij adresu na telefonie oraz kliknij go na
   Macu. Policz czynności do momentu, w którym Claude mówi o tej jednej sprawie.

Do zmierzenia przy każdym kliknięciu:

- ile czynności od kliknięcia do rozmowy,
- czy polecenie wysyła się samo, czy trzeba nacisnąć wyślij,
- czy Claude sięgnął po sprawę przez MCP, czy zaczął zgadywać z samego numeru.

Trzecie jest najważniejsze: jeśli Claude odpowie sensownie **bez** wywołania
narzędzia, to znaczy, że zmyślił, i wynik testu jest negatywny mimo dobrego
wrażenia.
