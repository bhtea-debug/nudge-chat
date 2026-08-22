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

## Scheduler

`InboxScheduler` startuje razem z serwerem HTTP i jest jedynym miejscem, które
wywołuje `runtime.tick()`. Bez niego cała trwała synchronizacja stała w miejscu,
a health i kolejka wyglądały normalnie — awaria wyglądająca jak działanie.

- pierwszy przebieg po `INBOX_TICK_FIRST_DELAY_MS`, kolejne co
  `INBOX_TICK_INTERVAL_MS`,
- przebiegi się NIE nakładają; pominięcia są liczone (`skippedOverlaps`),
- zamknięcie czeka na trwający przebieg, zamiast ucinać go w połowie partii,
- `/health` wystawia `inbox.lastFullRunFinishedAt`, `consecutiveErrors`
  i `running`: „brak nowych spraw" i „nic się nie synchronizuje" wyglądają
  z zewnątrz identycznie i muszą być rozróżnialne.

Dowodzi tego test integracyjny uruchamiający PRAWDZIWY entrypoint procesu
i sprawdzający, że tick następuje **bez żadnego żądania HTTP**.

## Pierwszy import

Domyślnie **podgląd**: adapter liczy wiadomości w oknie `INBOX_BACKFILL_DAYS`
i nie zapisuje ani jednej. Import wymaga jawnego `INBOX_BACKFILL_MODE=import`.

Skan startowy pyta serwer o UID-y nie starsze niż okno (`uidsSince`), zamiast
brać `1:*` — skrzynka z dziesięcioletnią historią trafiłaby inaczej w całości
do pamięci i do kolejki, nieodwracalnie. Pobieranie idzie partiami po liście
UID-ów, nie przedziałem `od:do`: po skasowanych wiadomościach przedział zwraca
więcej, niż wybraliśmy.

Podgląd **nie** zapala zielonego światła źródła: do kolejki nic nie trafiło.

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
- Folder wysłanych jest czytany OSOBNYM kursorem i wychwytuje odpowiedzi
  udzielone poza kanałem (z telefonu, z klienta pocztowego). Bez tego kolejka
  pokazywałaby sprawę jako czekającą, choć klient dostał odpowiedź wczoraj.
  Nie jest natomiast dowodem wysyłki przez kanał: Resend tam nie zapisuje,
  więc brak kopii nie znaczy „nie poszło”.

### Dziennik

Uszkodzony ogon dziennika jest **naprawiany przy starcie**, zanim cokolwiek
zostanie dopisane. Bez tego następny append doklejałby się do niepełnej linii
i przy kolejnym restarcie znikałyby OBIE części — razem z wiadomością, za którą
stoi już kursor.

- uszkodzone linie trafiają do pliku kwarantanny (`inbox.jsonl.damaged-N`),
- dziennik jest przepisywany atomowo z samych poprawnych zdarzeń; obcięcie
  zabrałoby też prawdziwe zdarzenia zapisane po uszkodzeniu,
- ogon bez znaku końca linii jest niedokończonym zapisem NAWET wtedy, gdy
  przypadkiem parsuje się poprawnie,
- alarm integralności jest TRWAŁYM rekordem zdrowia i zdejmuje go wyłącznie
  świadoma decyzja człowieka,
- `fsync` przy kursorze, ledgerze i zdrowiu. Wiadomości nie: ich utrata przed
  wymuszeniem kończy się powtórnym pobraniem, a `fsync` opróżnia cały bufor
  pliku, więc zapis kursora utrwala też całą poprzedzającą partię.

### Meta

- Podpis `X-Hub-Signature-256` weryfikowany z **surowego** ciała, przed
  jakimkolwiek zapisem. Ponowna serializacja JSON zmienia bajty i psuje podpis.
- Dedup po `mid`; zdarzenia poza kolejnością dają ten sam stan, bo sprawa jest
  **wyliczana** z posortowanego zbioru, a nie z ostatniego wpisu.
- Echo własnej wiadomości jest zapisywane jako wychodząca i oznaczone flagą:
  wyrzucone znika z historii, policzone jako przychodzące budzi zespół
  powiadomieniem o własnej odpowiedzi.
- Instagram i Facebook mają osobne `accountKey`, zdrowie i kursory, nawet przy
  jednej aplikacji Meta;
- uzgodnienie przez Graph API: `GET /{PAGE-ID}/conversations?platform=...`,
  stronicowanie z sufitem, okno czasowe. Źródło Meta jest zielone WYŁĄCZNIE po
  udanym odczycie — nie za samo bycie skonfigurowanym.

**Instagram wysyła i czyta przez PAGE ID połączonej strony**, a webhooki
przychodzą z `entry.id` równym identyfikatorowi konta IG. To są dwa różne
numery; pomylenie ich daje 404 przy wysyłce i nierozpoznane konto przy odbiorze.
Dlatego konfiguracja ma osobne `INBOX_META_<ALIAS>_PAGE_ID`.

Zweryfikowane w dokumentacji Meta 2026-08-22:
`POST /{PAGE-ID}/messages`, token strony, `messaging_type: RESPONSE`, okno 24 h,
pole webhooka `messages`, uprawnienia `pages_messaging`, `pages_show_list`,
`instagram_manage_messages`, `business_management`.

Wygasły token albo brak uprawnień dają jawny stan `reconnect_required`,
a ograniczenie tempa jest od niego odróżniane.

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
   Kody 408, 425 i 429 też są niepewne, a nie „na pewno niewysłane": potrafią
   przyjść już PO przyjęciu wiadomości przez dostawcę.
6. `Wróć do edycji` anuluje wyłącznie stan `prepared`.
7. Ręczne rozstrzygnięcie stanu niepewnego dopiero po 2 minutach i nie wymyśla
   zewnętrznego czasu wiadomości.
8. Potwierdzony sukces **dopisuje wiadomość wychodzącą do wątku** i przelicza
   sprawę. Bez tego ledger wiedział o wysyłce, a wątek nie.
9. Odbiorca jest funkcją `caseId`, nigdy parametrem żądania. Konto nadawcze
   musi należeć do źródła sprawy.
10. Stany dostarczenia z webhooków są monotoniczne: spóźnione „dostarczono"
    nie kasuje informacji o odbiciu.

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
npm run inbox:sprawdz   # kontrola konfiguracji Railway, bez wdrożenia
```

`inbox:sprawdz` waliduje komplet zmiennych `INBOX_*`, wymaga trwałego wolumenu
`/data`, sprawdza rozdzielność tokenów odczytu i wysyłki oraz osobne PAGE ID
dla Instagrama. Nie wypisuje żadnej wartości sekretu.

`verify:clone` sprawdza **zawartość commita**, nie katalogu roboczego.
Nie uruchamiać `npm run wdroz`.
