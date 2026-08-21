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

`responseState`, `responseClassificationVersion` i `pendingAction` przenoszą
wersjonowaną decyzję TeaBrew. Potrzeba odpowiedzi klientowi jest niezależna od
niewykonanej jeszcze czynności firmy: sprawa może nie mieć SLA odpowiedzi, ale
nadal pozostawać otwarta jako „Czeka na realizację”. MCP nie próbuje
samodzielnie zmieniać tej oceny i nadal nie udostępnia żadnego narzędzia
wysyłki.
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

## Odpowiedź klientowi — osobny bridge, nigdy narzędzie AI

Wysyłka nie została dodana do capability ani MCP. `tools/list` nadal publikuje
dokładnie cztery operacje Allegro, wszystkie `effectClass: read`; model nie ma
narzędzia `send`, `reply`, `write` ani mutacji statusu.

Backend firmowego czatu może po potwierdzeniu człowieka wywołać dedykowany:

`POST /internal/customer-cases/allegro/reply`

Endpoint ma osobny `CUSTOMER_CASE_REPLY_BRIDGE_TOKEN` (min. 32 znaki), który
nie może być równy żadnemu tokenowi MCP ani tokenowi odczytu TeaBrew. Dalej
bridge wykonuje dokładnie jeden:

`POST {TEABREW_BASE_URL}/ai-operator/customer-case-reply`

z osobnym `TEABREW_AI_OPERATOR_REPLY_TOKEN` i nagłówkiem
`x-bht-human-confirmation: confirmed`. Token wyjściowy jest inny także od
`TEABREW_AI_OPERATOR_TOKEN` używanego do odczytu. BHT Copilot nadal nie zna
tokenu Allegro; jedyną bramą zewnętrzną pozostaje TeaBrew.

Ładunek jest walidowany przez strict Zod i zawiera wyłącznie:

- `requestId` — 16–128 znaków `[A-Za-z0-9._:-]`, klucz idempotencji,
- `caseId` — identyfikator sprawy TeaBrew, max 128 znaków,
- `text` — niepusty tekst, max 2000 znaków,
- `expectedLastMessageAt` — czas ostatniej znanej wiadomości w ms lub `null`,
- `confirmation: "SEND_ALLEGRO_CUSTOMER_REPLY"`.

Nieznane pola i `attachments` są odrzucane. Bridge nie zapisuje ani nie loguje
tekstu. Odpowiedź TeaBrew też przechodzi strict schema i allowlistę pól; surowa
odpowiedź upstreamu nie jest przekazywana.

Nie ma automatycznego retry. HTTP 200 (`sent`), 202 (`uncertain`) i 409
(`failed`) przechodzą po sprawdzeniu kontraktu. Timeout, błąd sieci, 5xx lub
niezgodna odpowiedź kończą się bez drugiego requestu jako `ambiguous: true` —
operator musi najpierw odświeżyć wątek. Odrzucenie 4xx przed akcją jest
sanityzowane jako jednoznaczny błąd upstreamu.

Bridge jest wyłączony, dopóki oba nowe tokeny nie są ustawione. Konfiguracja
połowiczna, token krótszy niż 32 znaki albo ponowne użycie tokenu MCP/read-only
zatrzymują proces przy starcie zamiast otworzyć słabszą ścieżkę.

## Jedyny ręczny krok integracyjny

Administrator zaznacza `allegro:api:messaging` w aplikacji Allegro, a potem
ponownie łączy konto w TeaBrew. Istniejący refresh token nie dostaje nowego
scope automatycznie. Bez tego pilot pokazuje `reconnect_required` i nie udaje,
że synchronizacja działa.
