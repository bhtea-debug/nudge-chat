# BHT Copilot — wejście z Czatu Firmowego

Endpoint `POST /events/chat` przyjmuje wyłącznie kontrakt
`bht.chat.message-created.v1`. Reprezentatywna, wykonywalna fikstura znajduje
się w `fixtures/contracts/firmowy-chat-message-created-v1.json`.

## Brama

Wymagane nagłówki:

```text
X-BHT-Event-Id: <eventId z JSON>
X-BHT-Timestamp: <Unix time w sekundach>
X-BHT-Signature: sha256=<HMAC_SHA256(secret, timestamp + "." + rawBody)>
```

Sekret `FIRMOWY_CHAT_EVENTS_SECRET` musi mieć co najmniej 32 znaki. Brak
sekretu zamyka endpoint (HTTP 503), brak lub zły podpis daje HTTP 401, a podpis
starszy niż pięć minut jest odrzucany. `eventId` z nagłówka musi być identyczne
z wartością w JSON.

## Decyzja o sprawie

Bez modelu i bez kosztu:

- duplikat zwraca poprzednie `issueId`,
- jawne `replyTo` lub jednoznaczny numer może scalić wiadomość z otwartą sprawą,
- sam wspólny kanał `team/channel` nigdy nie jest wystarczającym dowodem do scalenia,
- zwykła rozmowa bez ważności, numeru i `linkedRef` jest oznaczona jako widziana,
  ale nie tworzy sprawy,
- `important`, `urgent`, numer zamówienia lub `linkedRef` tworzą sprawę,
- `urgent` tworzy kandydata do powiadomienia; push zawiera dokładne `issueId`.

W stanie zostaje maksymalnie 400 znaków podglądu, referencja, aktor i jego
zakresy. Pełna treść służy tylko bieżącemu ingestowi.

## Modele

Role konfiguracyjne to `classify`, `chat`, `reason`. `MODEL_FAST` pozostaje
wyłącznie zgodnym wstecz fallbackiem dla `MODEL_CLASSIFY`. Modelowa klasyfikacja
monitora jest nadal opt-in (`MONITOR_CLASSIFIER=model`); domyślna ścieżka jest
deterministyczna. Log kosztów zawiera rolę, model oraz tokeny każdego wywołania.
