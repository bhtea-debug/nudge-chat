# AI Operator w codziennej pracy — Etap A

Jak używać tego, co już działa: Claude Desktop + 7 narzędzi firmowych, poczta
i TeaBrew, wyłącznie do czytania.

Dokument praktyczny. Opis architektury jest w `AI-OPERATOR-MVP.md`, powody
w `ARCHITEKTURA-AI-2026.md`.

---

## 1. Co masz do dyspozycji

| narzędzie | odpowiada na pytanie |
| --- | --- |
| `mail_list_recent` | co przyszło |
| `mail_search` | czy pisali o tym numerze / kliencie / produkcie |
| `mail_get_thread` | co dokładnie ustalono w tej sprawie |
| `teabrew_get_order_status` | co system mówi o tym zamówieniu |
| `teabrew_find_product` | jaki kod ma ten produkt |
| `teabrew_get_stock` | ile realnie mamy do sprzedaży |
| `teabrew_get_production_status` | co się produkuje i czy zamówienie ma pokrycie |

Claude wybiera je sam. Nie musisz ich nazywać — pytaj po ludzku.

Jedna zasada obowiązuje bez wyjątku: **narzędzia czytają, nie zmieniają.**
Nie ma wysyłania maili, zmiany statusu, ceny, stanu magazynu ani tworzenia
zamówień. Jeśli coś trzeba zrobić — Claude to napisze, **wykonujesz Ty**.

---

## 2. Rzecz, którą trzeba zrozumieć, zanim zaczniesz ufać odpowiedziom

Są **dwa tryby** i mają **różne gwarancje**. To nie jest szczegół techniczny —
zmienia to, jak czytać odpowiedź.

| | Claude Desktop (MCP) | `npm run ask` / `triage` |
| --- | --- | --- |
| kto jest modelem | Claude po stronie klienta | nasz `inbox-operator` |
| read-only wymuszone konstrukcyjnie | **tak** | tak |
| uczciwe wyniki narzędzi (`matchedBy: none`, `unknownCodes`, `truncated`, `incomplete`) | **tak** | tak |
| log audytu każdego wywołania | **tak** | tak |
| **automatyczna kontrola, czy treść odpowiedzi ma pokrycie w wywołaniach** | **NIE** | tak (`evidence.ts`, stopka dowodowa, kod wyjścia 3) |

W Claude Desktop **nie ma stopki dowodowej** i nie ma kontroli po fakcie —
`evidence.ts` sprawdza odpowiedzi pisane przez naszego agenta, a nie odpowiedzi
pisane w oknie Claude Desktop.

Nie oznacza to, że MCP jest niepewny. Oznacza, że dowód przeniósł się z automatu
na **log audytu**:

```bash
cd ~/nudge-chat-live/ai-operator
npm run audit             # ostatnie 5 sesji
npm run audit -- --dzis   # tylko dzisiejsze
```

Log pokazuje każde wywołanie: czas, narzędzie, wynik, czas trwania i bezpieczne
identyfikatory (numer zamówienia, kod SKU, liczba trafień). **Nie zawiera treści
maili, tematów, adresów ani tokenów.** Trzy rzeczy sygnalizuje osobno, bo w samej
odpowiedzi łatwo je przeoczyć:

- `⚠ wynik przycięty do limitu` — odpowiedź mogła pomijać wiadomości,
- `• wywołań bez trafień` — „nie znalazłem" jest poprawnym wynikiem, nie usterką,
- `⚠ błędy` — te dane **nie** zostały sprawdzone, cokolwiek napisała odpowiedź.

Praktyczny nawyk: **przy każdej odpowiedzi, na której podstawie zamierzasz coś
zrobić lub coś obiecać klientowi — zerknij w `npm run audit`.** Przy zwykłym
„co dziś przyszło" nie ma potrzeby.

---

## 3. Cztery wzorce, które się sprawdzają

### A. Poranny przegląd (30 sekund)

```
Co przyszło na pocztę od wczoraj? Dla każdej wiadomości, która dotyczy
zamówienia, produktu albo produkcji — sprawdź to w TeaBrew i powiedz,
czy jest zgodność.
```

Jedno pytanie zamiast dwóch, bo korelacja poczta ↔ system jest tu całym sensem.

### B. Zanim odpowiesz klientowi

```
Wyszukaj w poczcie [numer / nazwisko / firma], pokaż mi cały wątek,
sprawdź status w TeaBrew i napisz, czego NIE wiesz.
```

Ostatnie zdanie jest ważniejsze od pozostałych. „Czego nie wiem" to jedyna część
odpowiedzi, której nie da się wymyślić.

### C. Luka między pocztą a systemem — najmocniejsze zastosowanie

```
Przejrzyj pocztę z ostatnich 7 dni. Znajdź wszystkie numery zamówień
i sprawdź każdy w TeaBrew. Wypisz osobno te, których w TeaBrew NIE MA.
```

To pytanie już raz zwróciło **trzy zamówienia Rossmanna z maili, których nie było
w systemie**. Żadne narzędzie w firmie nie odpowiada na to pytanie samo — bo
odpowiedź wymaga jednoczesnego zajrzenia w dwa miejsca.

Warto to zadawać raz na kilka dni.

### D. Magazyn i produkt

```
Ile mamy [nazwa handlowa] dostępnego do sprzedaży? Jeśli jest poniżej
minimum albo jest niepokryta rezerwacja — powiedz to wprost.
```

Claude sam zamieni nazwę handlową na kod (`teabrew_find_product` →
`teabrew_get_stock`). Liczby pochodzą z tego samego wyliczenia, którego używa
portal B2B i push do sklepu — nie z osobnej interpretacji.

---

## 4. Jak wpiąć to w Claude na stałe

Serwer MCP wysyła własną instrukcję przy każdym połączeniu (rola, zakaz
zgadywania, read-only). Ale **kontekst firmy** — kto jest kim, co znaczy
„Rossmann", czego zawsze chcesz w odpowiedzi — jest Twój i tego serwer nie zna.

W Claude Desktop utwórz **Projekt** (np. „BHT — operacje"), a w jego instrukcjach
wklej poniższe. Od tej pory nie powtarzasz zasad w każdej rozmowie.

```
Jesteś moim asystentem operacyjnym w Brown House & Tea. Masz narzędzia do
poczty przychodzącej i do systemu produkcyjnego TeaBrew, wyłącznie do czytania.

Zawsze:
- Rozdzielaj to, co napisał klient w mailu, od tego, co jest w TeaBrew.
  Podawaj wprost, które zdanie pochodzi z którego źródła. Jeśli się nie
  zgadzają — powiedz to, nie wybieraj za mnie.
- Kończ każdą odpowiedź krótką linią „Sprawdziłem:" z listą narzędzi, których
  użyłeś, i „Nie sprawdziłem:" z tym, czego nie dało się sprawdzić.
- Jeśli wynik ma truncated: true — napisz, ilu wiadomości nie widziałeś.
  Nie twierdź, że masz wszystkie.
- Jeśli zamówienia nie ma (matchedBy: none) — powiedz, że go w systemie nie ma.
  To nie to samo co „nie istnieje": mógł nie zostać jeszcze wprowadzony.
- Kod nieznany w magazynie (unknownCodes) to NIE stan zero.

Nigdy:
- Nie zgaduj statusu, terminu, stanu ani ceny. Brak danych to poprawna odpowiedź.
- Nie twierdź, że coś sprawdziłeś, jeśli nie wywołałeś narzędzia.
- Nie pisz w moim imieniu do klienta jako rzeczy zrobionej. Możesz przygotować
  propozycję odpowiedzi — wysyłam ją ja.

Kontekst: [wpisz swoje — kluczowi klienci, co znaczą wasze skróty, czym się
zajmują poszczególne osoby, co jest pilne z definicji]
```

Ostatnia linia jest tą, która da najwięcej. Serwer nie wie, że „ZP" to zlecenie
produkcyjne ani kto odpowiada za NPD.

---

## 5. Czego nie robić

- **Nie proś o wysłanie maila ani o zmianę czegokolwiek.** Nie odmówi z uporem —
  po prostu nie ma takiego narzędzia, więc w najlepszym razie zaproponuje treść.
  Nie interpretuj propozycji jako wykonania.
- **Nie zakładaj, że widzi całą skrzynkę.** Czyta `INBOX`. Skrzynka ma 21
  folderów, w tym `FAKTURY`, `ROSSMANN`, `NPD`, `INBOX.WHITE LABEL.*`. Jeśli
  reguły serwerowe przenoszą korespondencję z klientami do podfolderów, to
  odpowiedzi będą prawdziwe, ale niepełne — i **to widać po `truncated` tylko
  wtedy, gdy limit został przekroczony, a nie wtedy, gdy folder jest poza
  zasięgiem.** Patrz punkt 6.
- **Nie bierz liczby „dostępne do sprzedaży" bez spojrzenia na niepokrytą
  rezerwację wysyłkową.** Przy BHTJM to była realna, niezerowa wartość.
- **Nie licz na natychmiastowość przy pierwszym pytaniu.** Zenbox odpowiada
  wolno; pierwsze wywołanie potrafi się nie udać i powtórzyć. Drugie pytanie
  w tej samej rozmowie jest już szybkie, bo połączenie żyje.
- **Mac musi być włączony.** Serwer działa lokalnie. Z telefonu to nie zadziała —
  do tego służyłby Etap B, jeszcze nie zapadła decyzja.

---

## 6. Rytm pierwszych dwóch tygodni

Trzy pytania są **otwarte i mają zostać rozstrzygnięte używaniem, nie
przewidywaniem.** Wszystkie trzy to decyzje właściciela, nie zmiany w kodzie.

1. **Czy `INBOX` wystarcza.** Zapisuj przypadki, w których wiedziałeś, że coś
   przyszło, a odpowiedź tego nie widziała. Po tygodniu będzie wiadomo, które
   foldery dołożyć do `MAIL_FOLDER` i dlaczego — zamiast dokładać wszystkie
   21 na wyczucie.
2. **Czy potrzebujesz dostępu z telefonu.** Jeśli po tygodniu okaże się, że
   sięgasz po to tylko przy biurku — Etap B nie jest potrzebny.
3. **Jak długo trzymać audyt.** Log rośnie o jedną linię na wywołanie. Po
   dwóch tygodniach będzie wiadomo, czy przydaje się do czegokolwiek poza
   weryfikacją na bieżąco.

Raz na kilka dni: `npm run audit`. Jeśli w logu widzisz same `ok` i sensowne
liczby — system robi to, co mówi. Jeśli widzisz powtarzające się błędy albo
regularnie przycięte wyniki, to jest konkretna informacja do naprawy, a nie
przeczucie.
