# BHT Copilot — GO / NO-GO VALIDATION

**17–18.08.2026.** Trzy testy na prawdziwym środowisku, w kolejności narzuconej
przez zadanie. Bez fikstur, bez emulatorów, bez „dokumentacja mówi, że powinno".

---

## FINAL VERDICT

| Obszar | Wynik | Jednozdaniowe uzasadnienie |
| --- | --- | --- |
| **Connecteam** | **FAIL** | Klucz działa i konto widzi 10 konwersacji, ale wszystkie trzy ścieżki odczytu treści odmawiają (404/405) i nie ma webhooka na nową wiadomość — API tej firmy nie udostępnia wiadomości, których potrzebujemy. |
| **Push iPhone** | **PASS** | Właściciel dostał prawdziwe powiadomienie na iPhone przy zamkniętej aplikacji, z naszego serwera, z treścią szyfrowaną end-to-end i potwierdził, że widział oba wiersze. |
| **Quality** | **FAIL** | Na 50 prawdziwych wiadomościach system nie trafił **ani jednego** z czterech alarmów właściciela, a wszystkie trzy alarmy, które podniósł, były pomyłkami — czułość 0%, precyzja 0%. |

### Decyzja architektoniczna: **NO-GO**

Nie dlatego, że nie da się dowieźć alertu — to akurat jest dowiedzione. Dlatego,
że **nie mamy dziś CZEGO dowozić.** Wyzwalacz alarmu nie ma mierzalnego związku
z tym, co właściciel uważa za pilne: zero trafień przy zerowej precyzji to nie
jest „do dostrojenia", to jest zły sygnał. Zadanie definiuje NO-GO wprost jako
sytuację, w której „jakość nie pozwala zaufać systemowi", i to jest ta sytuacja.

Zgodnie z poleceniem nie proponuję tu nowej architektury i nie naprawiam tych
błędów. Poniżej są klasy błędów i liczby, na których ta decyzja stoi.

---

## Connecteam — FAIL

### Co faktycznie pobraliśmy

Sonda `npm run check:connecteam` na koncie **Brown House & Tea**, kluczem
wygenerowanym przez właściciela w panelu (Settings → API Keys):

| Sprawdzenie | Wynik |
| --- | --- |
| Klucz API działa | **✓** — konto rozpoznane po nazwie |
| Lista czatów zespołowych i kanałów | **✓** — 10 konwersacji |
| **Odczyt treści wiadomości** | **✗** — trzy ścieżki, trzy odmowy |
| API webhooków | **✓** — odpowiada |
| Webhook na nową wiadomość czatu | **✗** |

```
/chat/v1/conversations/{c}/messages   → 404
/chat/v1/conversations/{c}            → 405
/chat/v1/messages?conversationId={c}  → 404
```

Wymagane minimum — źródło, autor, timestamp, treść lub preview, stabilny
identyfikator — **spełnione tylko w punkcie „źródło".** Znamy nazwy konwersacji
i nic więcej.

### Dlaczego FAIL, a nie BLOCKED

Test **został wykonany** na prawdziwym koncie, kluczem o wystarczających
uprawnieniach — sam fakt, że klucz dało się utworzyć, znaczy plan Expert lub
wyższy. Odpowiedź jest jednoznaczna i zgodna z tym, co ustaliliśmy z dokumentacji
**przed** napisaniem kodu (`docs/DECYZJA-CONNECTEAM.md`): sekcja Chat opisuje
**wysyłanie** i listę konwersacji — tę ostatnią dodano, jak mówi changelog
dostawcy, **żeby wspierać wysyłanie**. Odczytu nie opisuje.

### Jedna droga niewyczerpana — po stronie dostawcy, nie naszej

Konto ma API webhooków, ale nie ma skonfigurowanego ani jednego, więc lista
dopuszczalnych typów zdarzeń jest pusta. Poznanie jej wymagałoby próby
utworzenia webhooka typu czatowego — **czego nie zrobiłem**, bo tworzy to
konfigurację w koncie właściciela bez jego zgody.

Gdyby Connecteam włączył dla tej firmy webhooki czatu, wejście po naszej stronie
**jest gotowe**: `POST /webhook/connecteam`, idempotentne po
`ct:<konwersacja>:<wiadomość>`, z weryfikacją podpisu HMAC-SHA256. Nie trzeba by
niczego budować — wystarczy podać adres.

Scrapingu i odtwarzania prywatnego API nie zrobię bez wyraźnej zgody: taka
integracja psuje się przy każdej zmianie u dostawcy i psuje się w sposób
**nieodróżnialny od „nikt nic nie napisał"**.

---

## Push iPhone — PASS

### Jak fizycznie dotarł alert

Serwer na Railwayu → Web Push (RFC 8291) → bramka Apple → iPhone właściciela.
Odbiornikiem jest strona dodana do ekranu początkowego: jedno pole, jeden
przycisk, ani jednej sprawy na ekranie. Interfejsem produktu pozostaje Claude.

Przebieg testu, w kolejności:

1. właściciel dodał `/push` do ekranu początkowego i zezwolił na powiadomienia,
2. `/health` potwierdził rejestrację urządzenia (`pushUrzadzenia: 1`),
3. aplikacja na telefonie została **zamknięta**,
4. z Maca poszło `npm run push:test` z ręcznie wskazaną treścią,
5. właściciel potwierdził: **powiadomienie przyszło**, oba wiersze widoczne.

Wymagane minimum — krótki tytuł, jednozdaniowy opis, poziom ważności — spełnione:
„Pilne — Rossmann" niesie kategorię w tytule, opis w drugim wierszu.

### Dlaczego akurat Web Push

Odrzucone: gotowa aplikacja (ntfy, Pushover) — treść alertu, czyli nazwy klientów
i numery zamówień, szłaby przez cudzy serwer **otwartym tekstem**, i dochodziłaby
kolejna zewnętrzna usługa. Odrzucone: własna aplikacja iOS — konto deweloperskie
Apple i Xcode dla jednego powiadomienia.

Web Push szyfruje ładunek end-to-end, kosztuje zero i nie wymaga niczyjego konta.
Cena: **wymaga ikony na ekranie początkowym**, bo Apple nie dostarcza powiadomień
do karty w Safari. To reguła systemu, nie nasza decyzja.

### Warunek, który trzeba spełnić przed codzienną pracą

**Wolumen `/data` na Railwayu nie jest dodany.** Subskrypcja powiadomień żyje
w katalogu stanu, więc restart kontenera ją kasuje i właściciel musi włączyć
powiadomienia od nowa. Do testu to nie przeszkadzało; do działania na co dzień
przeszkadza. CLI Railwaya wywraca się na dodaniu wolumenu paniką własnego
narzędzia (`volume.rs:836`) — panel działa.

---

## Quality — FAIL

### Zbiór

**50 wiadomości** z prawdziwej skrzynki, wszystkie ze skonfigurowanych folderów,
odsiane wyłącznie z duplikatów po Message-ID. Nie 100, i powód jest strukturalny:
kontrakt `mail_list_recent` ogranicza jeden odczyt do 50 pozycji, a **to samo
ograniczenie ma monitor** — system nigdy nie ogląda więcej za jednym razem.
Podniesienie limitu na potrzeby pomiaru znaczyłoby, że mierzę coś innego niż
produkt.

Właściciel etykietował **nie widząc oceny systemu**; zbiór był zamrożony do pliku,
więc człowiek i system oceniali dokładnie te same wiadomości.

### Liczby

| | A (alarm) | B (podsumowanie) | C (nieistotne) |
| --- | --- | --- | --- |
| **właściciel** | 4 | 18 | 28 |
| **system** | 3 | 8 | 39 |

| Metryka | Wynik |
| --- | --- |
| **ALARM — czułość (recall)** | **0%** |
| ALARM — precyzja | 0% |
| trafienia (TP) | 0 |
| **przeoczone alarmy (FN)** | **4** |
| fałszywe alarmy (FP) | 3 |
| zgodność 3-klasowa | 68% |
| błędy z rozpoznania numerów | 6 z 7 |
| błędy na własnej domenie (stopki) | 2 |
| przeoczone, bo odsiane cicho | 2 |

Zgodność 3-klasowa 68% wygląda znośnie i jest myląca: bierze się prawie w całości
z klasy C, której jest najwięcej. Na pytaniu, po które ten produkt istnieje —
„czy mam Cię teraz przerwać" — system nie trafił **ani razu**.

Osobno warta uwagi jest różnica w klasie B: właściciel chce widzieć 18 rzeczy,
system pokazuje 8 i chowa 39. **System ukrywa więcej, niż właściciel chce ukryć.**

### Klasy błędów

**1. Jedyny wyzwalacz alarmu mierzy awarię danych, nie ważność sprawy.**
System podnosi alarm wtedy i tylko wtedy, gdy znajdzie numer o kształcie naszego
zamówienia, którego **nie ma w TeaBrew**. To odpowiada na pytanie „czy coś się
rozjechało w danych", a nie „czy to jest pilne". Wszystkie trzy fałszywe alarmy
pochodzą stąd:

| Wiadomość | Co system uznał za numer zamówienia | Czym to naprawdę było |
| --- | --- | --- |
| NOSAWA AMSTERDAM — final reminder for invoice 20260162 | `20260162` | numer faktury dostawcy |
| roksana@brownhouseandtea.pl — PŁATNOŚCI | `534888748` | numer telefonu ze stopki |
| Michał Skałba — (brak tematu) | `732958000` | **własny numer telefonu właściciela** |

**2. Prawdziwe zamówienie klienta nie ma jak zaalarmować.**
Dwa zamówienia Rossmanna (`2307348`, `2307029`) — realne, przychodzące, z numerem
poprawnie rozpoznanym. System wsadził je do podsumowania, bo numery **są**
w TeaBrew. Skoro alarm wyzwala wyłącznie brak w systemie, to poprawnie działające
zamówienie od dużego klienta jest z definicji niealarmowalne. To nie jest luka
w regule — to jest wprost jej konsekwencja.

**3. Filtr szumu ucina powiadomienia narzędzi zespołowych, i robi to cicho.**
Dwa powiadomienia z Missive („Aleksandra mentioned you", „Anna mentioned you")
zostały odrzucone przed jakąkolwiek oceną, na podstawie nagłówków
`List-Unsubscribe` / `Precedence` / `Auto-Submitted`. Reguła jest sama w sobie
poprawna — te nagłówki oznaczają masówkę — ale narzędzia zespołowe wysyłają nimi
także rzeczy skierowane imiennie do jednej osoby. Właściciel nie zobaczyłby tych
wiadomości **nigdzie**, bo odsianie jest milczące.

**4. Kontrola kształtu numeru z zasady nie odróżnia numeru zamówienia od
telefonu ani od faktury dostawcy.** Dziewięciocyfrowy telefon i ośmiocyfrowy
numer faktury mają poprawny kształt. To ta sama przyczyna, która wcześniej
wypchnęła na szczyt awizo InPostu (NIP, dziesięć cyfr) — czwarty raz ten sam
mechanizm, więc nie jest to seria pomyłek, tylko granica metody.

### Czego ten pomiar NIE rozstrzyga

Zbiór ma 50 wiadomości i cztery alarmy — to mało, żeby mówić o dokładności
z przecinkiem. Ale nie o to tu chodzi: przy zerowej liczbie trafień i zerowej
precyzji wniosek nie zależy od wielkości próby. Sygnał nie mierzy tego, co miał
mierzyć, i większy zbiór tego nie odwróci.
