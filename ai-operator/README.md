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
npm test                                     # 68 testów, bez sieci
npm run check:mail                           # 11 sprawdzeń warstwy poczty, bez modelu
npm run triage                               # przegląd poczty z fikstur
npm run ask -- "Co z zamówieniem 12345? Klient potrzebuje dostawy do środy."
```

Domyślny `MODE=fixture` czyta pocztę z `fixtures/mail/inbox.json`, a dane
operacyjne z `fixtures/teabrew/erp.json`. Cała ścieżka **poczta → AI → TeaBrew →
odpowiedź** działa od pierwszej minuty, bez czekania na hasła.

## Przełączenie na dane produkcyjne

Kolejność jest obowiązkowa: **poczta i ERP sprawdzane bez modelu, model na końcu.**
Jeśli którykolwiek krok nie przechodzi, nie włączaj `MODE=live` — napraw przyczynę.

```bash
# 1. Łatka po stronie TeaBrew v2 — patrz teabrew-patch/README.md
#    Weryfikacja wdrożenia: bezpieczeństwo, kontrakt, prawdziwe dane.
npm run verify:teabrew
npm run verify:teabrew -- --order 12345 --product rooibos   # wymuszone wartości

# 2. Warstwa poczty, BEZ modelu — 11 sprawdzeń, m.in. wykrycie folderu wysłanych
MODE=live npm run check:mail
MODE=live npm run check:mail -- --days 7

# 3. Wszystko naraz przed pierwszym uruchomieniem na żywo
MODE=live npm run preflight        # typecheck + testy + poczta + TeaBrew

# 4. Dopiero teraz model
MODE=live npm run triage
MODE=live npm run ask -- --trace "Co ważnego przyszło dzisiaj?"
```

`check:mail` i `verify:teabrew` **nie wołają modelu**. Nie wypisują też treści
wiadomości ani danych dostępowych — adresy są maskowane, tematy przycinane,
z treści raportowane są tylko właściwości (długość, obecność polskich znaków,
czy HTML został poprawnie zamieniony na tekst).

### Poprawianie raz wpisanego sekretu

`scripts/live-setup.sh` dopytuje wyłącznie o brakujące wartości, więc samo
ponowne uruchomienie nie zapyta o coś, co już jest w `.env`. Do zmiany:

```bash
bash scripts/live-setup.sh --reset MAIL_IMAP_PASSWORD
bash scripts/live-setup.sh --reset MAIL_IMAP_PASSWORD,ANTHROPIC_API_KEY
```

Czyści wskazane klucze i pyta o nie ponownie, bez echa. Alternatywą byłoby
otwieranie pliku z hasłami w edytorze, żeby poprawić literówkę.

### Folder wysłanych

`MAIL_THREAD_FOLDERS=auto` (domyślnie) wykrywa go po atrybucie IMAP
**SPECIAL-USE** `\Sent`, a nie po nazwie — u różnych dostawców to „Sent",
„Sent Items", „INBOX.Sent" albo nazwa zlokalizowana. `check:mail` wypisuje,
co serwer wskazał i skąd to wie. Gdy serwer nie wskaże nic, trzeba podać nazwę
ręcznie — agent bez tego folderu nie widzi naszych odpowiedzi i może uznać,
że klientowi nikt nie odpisał.

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

## MCP — rozmowa z firmą wprost z Claude

Dwa niezależne tryby korzystania. **Nie mieszają się.**

| tryb | ścieżka | do czego | klucz API |
| --- | --- | --- | --- |
| interaktywny | `Claude → MCP → capabilities → Poczta/TeaBrew` | codzienna rozmowa człowieka z firmą | **nie potrzebny** |
| automatyczny | `inbox-operator → API modelu → capabilities` | crony, nocne analizy, procesy bez człowieka | wymagany |

W trybie MCP modelem jest Claude po stronie klienta — nie wołamy modelu u siebie.
Nie ma więc podwójnego wywołania, podwójnego kosztu ani dwóch agentów
podejmujących decyzje jednocześnie. `npm run mcp` startuje **bez**
`ANTHROPIC_API_KEY`; klucz jest potrzebny wyłącznie dla `ask` i `triage`.

### Podłączenie klienta

Serwer MCP po stdio jest **procesem lokalnym** — uruchamia go klient na tej samej
maszynie. Trzeba więc mieć klienta na tej maszynie. Sama przeglądarka
z claude.ai nie wystarczy: strona nie ma jak uruchomić procesu na Twoim
komputerze i nie zobaczy serwera stdio. To nie brak konfiguracji, to inny model
działania — dostęp z przeglądarki i telefonu wymaga zdalnego MCP (Etap B).

Dwa klienty, ta sama konfiguracja serwera. Wybierz ten, którego masz — albo
zainstaluj jednego:

| klient | instalacja | doświadczenie |
| --- | --- | --- |
| Claude Desktop | `claude.ai/download` | normalny czat, docelowe |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | terminal, dobre do weryfikacji |

**Claude Code** — nic nie trzeba konfigurować. `.mcp.json` leży w tym katalogu,
więc wystarczy uruchomić Claude Code **z katalogu `ai-operator`**:

```bash
cd ai-operator && claude
```

Ścieżki w `.mcp.json` są względne właśnie dlatego: plik jest w repozytorium i
ma działać na każdej maszynie bez podmieniania czegokolwiek.

**Claude Desktop** — patrz `claude-desktop.example.json`. Skopiuj wpis
`bht-operator` do `~/Library/Application Support/Claude/claude_desktop_config.json`
(katalog powstaje razem z aplikacją; jeśli go nie ma, aplikacji nie ma),
podmieniając ścieżki na **absolutne** — Claude Desktop uruchamia serwer z
nieokreślonego katalogu roboczego. Potem zrestartuj aplikację.

W obu przypadkach sekrety zostają po stronie serwera, w `.env`. Klient nie widzi
hasła IMAP ani tokenu TeaBrew — widzi siedem narzędzi read-only.

### Dlaczego to jest adapter, nie drugi system

- **Lista narzędzi pochodzi z rejestru**, nie z ręcznie utrzymywanego pliku.
  Zmiana capability w rejestrze pojawia się w MCP automatycznie.
- **Każde wywołanie idzie przez `registry.invoke`** — ten sam sprawdzian
  zakresu, ta sama walidacja wejścia i wyjścia, ten sam audyt, to samo
  wymuszenie read-only. MCP nie dotyka `MailProvider` ani klienta TeaBrew
  bezpośrednio.
- **Jedna korelacja na sesję MCP**, bo pytanie brzmi „co Claude sprawdził,
  zanim odpowiedział", a to obejmuje całą rozmowę, nie jedno wywołanie.
- **Jawna polityka wystawiania**: do MCP trafiają tylko capability
  `effectClass: "read"` — sprawdzane w adapterze, i przy `tools/list`,
  i przy `tools/call`. Gdyby rejestr kiedyś dopuścił capability zapisującą,
  nie pojawi się publicznie przez samo dodanie do rejestru.
- **Zero nowych zależności** — protokół to JSON-RPC po stdin/stdout.
  Skasowanie `src/bin/mcp.ts` nie psuje agenta.

## Struktura

```
src/capability/    rejestr, typy, audyt, projekcje (OpenAPI / JSON Schema / MCP)
src/mail/          MailProvider + adapter IMAP + adapter fikstur + wątki + foldery + tekst
src/teabrew/       kontrakt read-only + klient HTTP + klient fikstur
src/model/         role modeli (fast / reason) — żadnego ID modelu w logice
src/agent/         pętla agenta, triage, prompt, kontrola dowodów
src/bin/           ask, triage, caps, openapi, mcp, check:mail, verify:teabrew
teabrew-patch/     gotowe do założenia pliki dla teabrew-v2
fixtures/          poczta (z folderem Sent) i dane ERP do testów i demo
tests/             68 testów: scenariusze, jednostkowe, bezpieczeństwo łatki i MCP
```

## Zmiana dostawcy poczty

Warstwa poczty jest niezależna od dostawcy: kanonicznym identyfikatorem
wiadomości jest RFC `Message-ID`, a nie IMAP UID. Rzeczy specyficzne dla
dostawcy siedzą w nieprzejrzystym `providerRef`.

Nowy dostawca = jedna klasa implementująca `MailProvider` (`src/mail/types.ts`).
Narzędzia widziane przez AI nie zmieniają się wcale.
