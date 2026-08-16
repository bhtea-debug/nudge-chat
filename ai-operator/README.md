# inbox-operator

Agent AI **tylko do czytania**: przychodząca poczta + dane operacyjne TeaBrew v2.

Odpowiada na pytania właściciela typu „co ważnego przyszło”, „kto czeka na
decyzję”, „co z zamówieniem 12345”, „czy mamy ten towar”, „jak wygląda produkcja”
— łącząc treść maili z tym, co faktycznie jest w systemie produkcyjnym.

## Start (bez dostępu do skrzynki i bez tokenu TeaBrew)

```bash
cd ai-operator
npm install
cp .env.example .env && chmod 600 .env      # wpisz tylko ANTHROPIC_API_KEY
npm test                                     # 37 testów, bez sieci
npm run triage                               # przegląd poczty z fikstur
npm run ask -- "Co z zamówieniem 12345? Klient potrzebuje dostawy do środy."
```

Domyślny `MODE=fixture` czyta pocztę z `fixtures/mail/inbox.json`, a dane
operacyjne z `fixtures/teabrew/erp.json`. Cała ścieżka **poczta → AI → TeaBrew →
odpowiedź** działa od pierwszej minuty, bez czekania na hasła.

## Przełączenie na dane produkcyjne

```bash
# 1. Po stronie TeaBrew v2 — patrz teabrew-patch/README.md
npm run verify:teabrew        # 9 sprawdzeń kontraktu, w tym negatywne

# 2. Dopiero gdy wszystkie przechodzą:
MODE=live npm run triage
```

## Czego agent NIE potrafi

Nie „nie powinien" — **nie ma czym**:

| Ograniczenie | Gdzie jest wymuszone |
| --- | --- |
| brak wysyłki maili, brak SMTP | w `src/mail/` nie ma ani jednej linii SMTP; interfejs `MailProvider` nie ma metody zapisu |
| brak oznaczania jako przeczytane | `mailboxOpen(..., { readOnly: true })` — serwer IMAP odmówi zmiany |
| brak mutacji w TeaBrew | `CapabilityRegistry` przyjmuje wyłącznie `effectClass: "read"`; łatka po stronie ERP zawiera tylko `internalQuery` |
| brak dostępu poza przyznane zakresy | `registry.invoke` sprawdza `scope` przy każdym wywołaniu |

Jeśli agent uważa, że coś trzeba zrobić — pisze to jako sugestię. Wykonuje człowiek.

## Zasada „nie zgaduj” jest wymuszona konstrukcyjnie

Nie prośbą w promptcie, tylko trzema mechanizmami w `src/agent/evidence.ts`:

1. **Stopka dowodowa jest generowana z logu audytu**, nie przez model. Model
   nie ma jak dopisać wywołania, którego nie było.
2. **Kontrola po fakcie** skanuje odpowiedź. Twierdzenie o statusie, stanie
   magazynowym albo numerze zamówienia musi mieć odpowiadające mu udane
   wywołanie capability.
3. **Ostrzeżenie jest widoczne** dla człowieka w odpowiedzi. `npm run ask`
   kończy się kodem `3`, gdy kontrola coś zgłosi.

## Capability (7, wszystkie read)

```bash
npm run caps            # tabela
npm run caps -- --tools # definicje narzędzi (JSON Schema)
npm run openapi         # projekcja HTTP/OpenAPI
```

| capability | do czego |
| --- | --- |
| `mail_list_recent` | ostatnie wiadomości z podglądem treści |
| `mail_search` | szukanie po numerze, kliencie, produkcie |
| `mail_get_thread` | pełny wątek, bez cytowanej historii |
| `teabrew_get_order_status` | status zamówienia, pozycje, powiązana produkcja |
| `teabrew_get_stock` | stan i dostępność po kodach |
| `teabrew_find_product` | nazwa handlowa → kod SKU/materiału |
| `teabrew_get_production_status` | zlecenia i uruchomione ruchy produkcyjne |

Jedna deklaracja capability (`nazwa, opis, input, output, wersja, zakres,
effectClass`) daje **klienta TypeScript, JSON Schema dla function callingu,
dokument OpenAPI i listę narzędzi MCP**. Nie ma drugiego miejsca opisującego tę
samą funkcję.

TeaBrew v2 ma ponad sto tabel. Agent widzi cztery pytania, nie sto tabel.

## Audyt

Każde wywołanie zapisuje: `ts`, `agent`, `capability`, `capabilityVersion`,
`ok`, `latencyMs`, `correlationId`, oraz `refs` — **wyłącznie identyfikatory
i liczniki**, nigdy tematy ani treści maili (test tego pilnuje).

```bash
npm run ask -- --trace "Co z zamówieniem 12345?"   # ślad na stderr
AUDIT_FILE=./.audit/calls.jsonl npm run triage      # trwały log JSONL
```

## MCP — adapter, nie fundament

`npm run mcp` uruchamia serwer MCP po stdio, żeby te same siedem funkcji dało
się podłączyć w Claude Desktop bez pisania drugiej integracji. Nie definiuje
żadnej capability, nie dodaje zależności i **nic w systemie od niego nie zależy**
— skasowanie `src/bin/mcp.ts` nie psuje agenta.

## Struktura

```
src/capability/    rejestr, typy, audyt, projekcje (OpenAPI / JSON Schema / MCP)
src/mail/          MailProvider + adapter IMAP + adapter fikstur + wątki + tekst
src/teabrew/       kontrakt read-only + klient HTTP + klient fikstur
src/model/         role modeli (fast / reason) — żadnego ID modelu w logice
src/agent/         pętla agenta, triage, prompt, kontrola dowodów
src/bin/           ask, triage, caps, openapi, mcp, verify:teabrew
teabrew-patch/     gotowe do założenia pliki dla teabrew-v2
fixtures/          poczta i dane ERP do testów i demo
```

## Zmiana dostawcy poczty

Warstwa poczty jest niezależna od dostawcy: kanonicznym identyfikatorem
wiadomości jest RFC `Message-ID`, a nie IMAP UID. Rzeczy specyficzne dla
dostawcy siedzą w nieprzejrzystym `providerRef`.

Nowy dostawca = jedna klasa implementująca `MailProvider` (`src/mail/types.ts`).
Narzędzia widziane przez AI nie zmieniają się wcale.
