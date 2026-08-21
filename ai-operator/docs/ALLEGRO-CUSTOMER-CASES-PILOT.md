# Pilot: Zapytania klientów z Allegro

## Granica systemu

Przepływ ma jeden kierunek:

`Allegro -> TeaBrew -> BHT Copilot/MCP -> firmowy czat`.

TeaBrew jest jedyną bramą do Allegro. Copilot zna wyłącznie ograniczony token
HTTP TeaBrew i odczytuje znormalizowany cache. Nie przechowuje tokenów Allegro,
nie otrzymuje surowych odpowiedzi API ani adresów plików i nie ma klienta
Allegro.

Pilot publikuje cztery capability, wszystkie z `effectClass: read`:

- `teabrew_list_allegro_customer_cases`,
- `teabrew_get_allegro_customer_case`,
- `teabrew_get_allegro_customer_case_messages`,
- `teabrew_search_allegro_customer_cases`.

Rejestr i adapter MCP odrzucają każdą klasę efektu inną niż `read`. Nie istnieje
capability wysyłki, odpowiedzi, zmiany statusu Allegro ani pobierania załącznika.

## Uprawnienia i prywatność

`customer_cases:read` daje metadane kolejki. `customer_cases:content` jest
osobnym zakresem i jest wymagany dla zredagowanej treści. Niezredagowany
`display` wymaga trzeciego zakresu `customer_cases:display`, którego zwykły
MCP/model nigdy nie otrzymuje. Zakres jest nadawany wyłącznie principalowi
uwierzytelnionemu osobnym `MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN`; wartość ta
jest inna niż publiczny `MCP_BEARER_TOKEN`. Firmowy czat nadal musi sprawdzić
sesję i uprawnienie konkretnego użytkownika przed wywołaniem MCP — principal
serwisowy nie zastępuje autoryzacji użytkownika końcowego.

Treść ma zawsze jawny cel:

- `authorized_chat_view` — surowy tekst tylko dla zaufanego principalu
  firmowego czatu; próba użycia go przez zwykły MCP kończy się `forbidden_scope`,
- `user_requested_review`, `user_requested_summary`, `user_requested_draft` —
  wyłącznie po bezpośredniej akcji użytkownika, w trybie `model`.

Tryb `model` usuwa login autora, redaguje oczywiste dane kontaktowe i nie
zwraca nawet metadanych załączników. Tryb `display` może zwrócić wyłącznie
metadane pliku (`id`, nazwa, MIME, status), bez URL-a i bez binarnej treści.
Żadna synchronizacja ani odświeżenie kolejki nie wywołuje Anthropic.

Audyt narzędzi zawiera nazwę capability, wynik, czas, identyfikator sprawy lub
licznik oraz zadeklarowany cel. Nie zapisuje treści, loginu kupującego ani frazy
wyszukiwania.

## Świeżość i SOP P0

Każda odpowiedź zawiera `freshness`: czas ostatniej udanej synchronizacji,
wiek danych, następny retry, stan scope i komunikat dla użytkownika. Klient ma
pokazać stany `missing_scope`, `reconnect_required`, `rate_limited`, `stale` i
`error`; pustej kolejki przy takim stanie nie wolno opisywać jako braku spraw.

TeaBrew dostarcza jedną kolejkę `/messaging` i historycznych `/sale/issues`,
bez podwójnego importu. Pola `priority`, `responseDueAt` i `slaState` przenoszą
SOP operacyjny: P0/P1/P2 oraz progi żółty 12 h, czerwony 4 h, krytyczny 2 h i
przekroczenie. Copilot prezentuje wyliczenie TeaBrew; nie klasyfikuje ponownie
treści klienta automatycznie.

`responseState` i `responseClassificationVersion` przenoszą wersjonowaną
decyzję TeaBrew: wymaga odpowiedzi, odpowiedziane, samodzielne podziękowanie,
zamknięte źródłowo albo brak wiadomości. MCP nie próbuje samodzielnie zmieniać
tej oceny i nadal nie udostępnia żadnego narzędzia wysyłki.
Dla metadanych `state=all` przenosi także opcjonalne `nextCursor`; kursor nie
jest logowany w audycie i służy wyłącznie do read-only paginacji backfillu.

`serviceTargetAt` reprezentuje cel pierwszej merytorycznej odpowiedzi w ciągu
2 godzin dyżuru. Dopóki TeaBrew nie ma wiarygodnego kalendarza dyżurów, wartość
pozostaje `null` zamiast zgadywanej daty. `serviceMaxAt` wskazuje absolutne 12 h
od początku oczekiwania, a `answeredAt` potwierdza odpowiedź wynikającą z
historii kierunków wiadomości.

## Kontrakt HTTP TeaBrew

Wszystkie wywołania to GET, a token jest tylko w `Authorization: Bearer ...`:

- `/ai-operator/customer-cases`,
- `/ai-operator/customer-case`,
- `/ai-operator/customer-case-messages`,
- `/ai-operator/customer-case-search`.

Schematy są walidowane przed przekazaniem danych do capability. HTTP 429 ma
jednoznaczny komunikat retry; stan OAuth i potrzeba ponownego połączenia są
przekazywane przez `freshness`.

## Etap drugi — tylko projekt, nieaktywny

Przyszła odpowiedź powinna mieć trzy odseparowane kroki:

1. użytkownik jawnie prosi o szkic; model dostaje zredagowaną treść bez
   załączników,
2. szkic zostaje obiektem wewnętrznym, podlega osobnemu audytowi i ręcznej
   akceptacji użytkownika z uprawnieniem `canApproveExternalReply`,
3. dopiero osobne wdrożenie TeaBrew może dodać wąski endpoint wysyłki z
   allowlistą typu wiadomości, idempotency key, ponowną kontrolą uprawnienia i
   bez możliwości przekazania komentarza wewnętrznego.

Żaden element kroku 2 ani 3 nie jest aktywny w pilocie. Dodanie endpointu
wysyłki wymaga osobnej decyzji, testów i wdrożenia; samo połączenie scope
`allegro:api:messaging` nie może go uruchomić.

## Jedyny ręczny krok integracyjny

Administrator zaznacza `allegro:api:messaging` w aplikacji Allegro, a potem
ponownie łączy konto w TeaBrew. Istniejący refresh token nie dostaje nowego
scope automatycznie. Bez tego pilot pokazuje `reconnect_required` i nie udaje,
że synchronizacja działa.
