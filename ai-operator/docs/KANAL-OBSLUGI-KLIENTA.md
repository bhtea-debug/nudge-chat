# Kanał „Obsługa klienta” — adaptery źródeł

## Granice systemów

```
Allegro   -> TeaBrew ------------------+
3 x IMAP  -> adapter trwały -----------+-> kontrakt generyczny -> firmowy czat
Instagram -> webhook + uzgodnienie ----+
Facebook  -> webhook + uzgodnienie ----+

firmowy czat --potwierdzone przez człowieka--> /internal/inbox/reply
  -> e-mail przez Resend
  -> Instagram/Facebook przez Meta Send API
  -> Allegro NIE tędy: ma własną, przetestowaną bramę w TeaBrew
```

TeaBrew pozostaje jedyną bramą do Allegro i **nie zmienia się ani o linijkę**.
`src/inbox/providers/allegro/adapter.ts` tłumaczy jego istniejący read model na
wspólny kształt. `caseId` Allegro przechodzi bez zmian, bo po nim wiszą
komentarze zespołu, deep linki i audyt sprzed tej zmiany.

W tym repozytorium nie ma i nie może być haseł IMAP, tokenów Resend ani Meta
w kodzie — wyłącznie nazwy zmiennych w `.env.example`.

## Dlaczego to nie jest MCP

Kontrakt kanału stoi pod `/internal/inbox/*`, poza `/mcp`. Rejestr narzędzi jest
tym, co widzi model, a wysyłka do klienta nie ma prawa się tam znaleźć — nawet
omyłkowo, nawet jako narzędzie „tylko do przygotowania”. Test statyczny
w `src/inbox/http.test.ts` pilnuje, że rejestr narzędzi AI nie zawiera nazw
`send|reply|write|post|create|update|delete` i nie importuje modułu kanału.

## Niezawodność inbound: żadnej cichej utraty

Nie obiecujemy „zero awarii” zewnętrznych usług. Obowiązuje słabszy, ale
sprawdzalny invariant: **wiadomość nie może zniknąć po cichu; każda awaria jest
wykryta, widoczna i odzyskiwalna**.

### Wspólne

1. Trwały zapis wiadomości **przed** klasyfikacją (`InboxStore.claimMessage`).
2. Kursor przesuwa się dopiero po trwałym zapisie całej zatwierdzonej partii.
3. Klasyfikator nie usuwa ani nie pomija rekordu źródłowego.
4. Niska pewność i błąd klasyfikatora są fail-open: sprawa trafia do kolejki.
5. Dedup odporny na retry, restart, powtórzony webhook i zmianę kolejności.
6. Webhook to szybka ścieżka; każdy webhookowy dostawca ma uzgodnienie.
7. Błąd źródła nigdy nie jest pokazywany jako „0 spraw”
   (`mayReportEmptyQueue`).

### IMAP

- Kursor to **para** `uidValidity:uid`, nigdy sam UID. Serwer, który odtworzy
  folder z kopii, zmienia `uidValidity`, a wtedy kursor z samym numerem
  przeskakuje całą skrzynkę i wygląda przy tym na działający.
- Zwykły tick cofa zakres o `overlap` (domyślnie 20 UID); uzgodnienie skanuje
  szeroko wstecz i znajduje luki, których kursor już nie widzi.
- Kursor ląduje na **najwyższym faktycznie zapisanym UID**, nigdy na `uidNext`
  odczytanym na starcie: wiadomość doręczona w trakcie skanu dostaje wyższy UID
  i zostałaby przeskoczona.
- Nieczytelny rekord w partii **wstrzymuje** kursor. Cicho przycięta partia
  wygląda jak partia pełna.
- Dedup po `Message-ID` z rozstrzyganiem kolizji odciskiem treści; pusty
  nagłówek daje stabilny fingerprint ze skrzynki, folderu, `uidValidity` i UID.
- Wątkowanie: `Message-ID`, `In-Reply-To`, `References`, a dopiero na końcu
  konserwatywny fallback po znormalizowanym temacie **i uczestnikach** — sam
  temat skleiłby korespondencję dwudziestu różnych klientów piszących
  „Reklamacja”.
- Każda skrzynka ma własny sekret, własne połączenie, własny kursor i własne
  zdrowie.
- Folder wysłanych służy **wyłącznie obserwacji**. Nigdy nie jest dowodem
  wysyłki: Resend tam nie zapisuje, więc brak kopii nie znaczy „nie poszło”.

### Meta

- Podpis `X-Hub-Signature-256` weryfikowany z **surowego** ciała, przed
  jakimkolwiek zapisem. Ponowna serializacja JSON zmienia bajty i psuje podpis.
- Dedup po `mid`; zdarzenia poza kolejnością dają ten sam stan, bo sprawa jest
  **wyliczana** z posortowanego zbioru, a nie z ostatniego wpisu.
- Echo własnej wiadomości jest zapisywane jako wychodząca i oznaczone flagą:
  wyrzucone znika z historii, policzone jako przychodzące budzi zespół
  powiadomieniem o własnej odpowiedzi.
- Instagram i Facebook mają osobne `accountKey`, zdrowie i kursory, nawet przy
  jednej aplikacji Meta.
- Wygasły token / brak uprawnień dają jawny stan `reconnect_required`.

## Świeżość

Ogólny czas to **najstarszy** `lastSuccessfulSyncAt` spośród aktywnych źródeł.
Wersja z najnowszym pokazuje zielono, gdy jedna skrzynka żyje, a trzy pozostałe
leżą. Progi (5 / 10 / 15 min) są centralną polityką w `contract.ts`, nie
magicznymi liczbami w UI. Nieudana próba **nie** nadpisuje czasu ostatniego
sukcesu.

## Wysyłka: najwyżej raz

1. Wpis do ledgera powstaje **przed** pierwszym requestem.
2. Jedna aktywna próba na sprawę; drugi `requestId` odbija się o blokadę.
3. Marker ostatniej wiadomości klienta sprawdzany dwa razy: przy przygotowaniu
   i tuż przed POST-em.
4. Resend: deterministyczny `Idempotency-Key` wyliczony z `requestId`, hasha
   treści i sprawy. Klucz losowany przy ponowieniu nie jest kluczem
   idempotencji, tylko ozdobą.
5. Meta: **brak** wiarygodnej idempotencji, więc timeout/5xx = `uncertain`
   i zero automatycznych ponowień.
6. `Wróć do edycji` anuluje wyłącznie stan `prepared`.
7. Ręczne rozstrzygnięcie stanu niepewnego dopiero po 2 minutach i nie wymyśla
   zewnętrznego czasu wiadomości.

## Konfiguracja

Komplet nazw zmiennych opisuje `.env.example`, sekcja „Kanał «Obsługa klienta»”.
Kanał jest domyślnie **wyłączony** (`INBOX_ENABLED`), a każda brakująca wartość
oznacza funkcję wyłączoną i powiedzianą wprost, nigdy ciche „działa”.

`INBOX_STATE_DIR` musi wskazywać wolumen trwały (`/data` na Railway). Stan na
dysku efemerycznym znaczy kursory od zera po każdym deployu.

## Testy

```bash
npm run typecheck
npm test
npm run verify:clone
```

`verify:clone` sprawdza **zawartość commita**, nie katalogu roboczego.
Nie uruchamiać `npm run wdroz`.
