# Decyzja: gdzie postawić Remote MCP

Dokument decyzyjny, spisany **przed** wdrożeniem. Zadanie wymagało oceny opcji,
preferencji dla infrastruktury już używanej w firmie i wyboru czegoś prostego,
taniego i łatwego do wyłączenia.

Data: 17.08.2026. Autor: Claude (sesja Claude Code). Decyzję zatwierdza właściciel.

---

## 1. Czego ta usługa naprawdę potrzebuje

Cztery wymagania, z których **każde** eliminuje jakąś opcję:

| wymaganie | dlaczego |
| --- | --- |
| **Trwałe wychodzące TCP na port 993** | IMAP. Nie HTTP — surowe gniazdo TLS trzymane przez cały skan. |
| **Trwały dysk** | Dziennik spraw i checkpointy. Bez tego restart = utrata pamięci Copilota i ponowna analiza całej skrzynki. |
| **Długo żyjący proces** | Monitor co ~15 minut w tym samym procesie co MCP: jeden pisarz do stanu, brak wyścigu o dziennik. |
| **HTTPS + natychmiastowe odcięcie** | Klient mobilny. Odcięcie = zmiana jednej zmiennej albo usunięcie usługi. |

---

## 2. Opcje, w tym te już używane w firmie

### Vercel — **odrzucone**

Firma już go używa (Next.js, TeaBrew v2, panele). To była pierwsza opcja do
sprawdzenia właśnie dlatego.

Nie pasuje na trzech poziomach naraz: funkcje są bezstanowe i krótkotrwałe, więc
monitor w procesie nie ma gdzie żyć; nie ma trwałego dysku na dziennik spraw;
a trwałe wychodzące TCP do IMAP-a nie jest tym, do czego to środowisko służy.
Dałoby się to obejść — Vercel Cron plus zewnętrzny magazyn stanu plus osobna
usługa do poczty — ale wtedy zamiast jednej małej usługi mamy trzy elementy
i dwa nowe punkty awarii. To jest dokładnie ten kierunek, którego
`ARCHITEKTURA-AI-2026` punkt 15 każe unikać.

### Convex (wdrożenie TeaBrew) — **odrzucone**

Też już używany, i już trzyma token AI Operatora. Kuszące.

Dwa niezależne powody odrzucenia. Techniczny: funkcje Convex nie utrzymują
długo żyjących gniazd TCP, więc poczty nie obsłużą — a zadanie wprost mówi, że
wariant „tylko TeaBrew na telefonie" jest nieakceptowalny. Architektoniczny,
poważniejszy: rejestr capability mieszka w `ai-operator` i Convex go nie dosięgnie,
więc trasa `POST /mcp` po tamtej stronie wymagałaby **zduplikowania rejestru
i schematów** do repozytorium teabrew-v2. To wprost łamie zasadę „MCP jest
projekcją, nie drugim systemem" i pierwszego dnia rozjechałoby dwie definicje
tych samych narzędzi.

### Railway — **WYBRANE**

Trwały kontener, trwały wolumen, HTTPS z domeny, sekrety jako zmienne
środowiskowe, usunięcie usługi jednym kliknięciem. Wszystkie cztery wymagania
z punktu 1 spełnione bez obejść. Konfiguracja to jeden `Dockerfile` w repo —
brak osobnego DevOps, brak plików IaC, brak łańcucha buildów.

Koszt: rzędu kilku dolarów miesięcznie za usługę tej wielkości. Wyłączenie:
usunięcie usługi albo skasowanie tokenu.

To także opcja wskazana przez właściciela jako pierwsza do oceny — i ocena ją
potwierdza, a nie tylko przyjmuje.

### Fly.io — odrzucone (bez wady technicznej)

Technicznie równoważne z Railway. Odrzucone wyłącznie dlatego, że dokłada
kolejnego dostawcę i konfigurację sterowaną z CLI, nie dając nic w zamian.
Jeśli Railway kiedyś przestanie pasować, to jest pierwszy zamiennik.

### Mac właściciela + tunel (Cloudflare Tunnel) — **rezerwa, nie odrzucone**

Zero nowego hostingu i zero nowego kosztu: ten sam proces, który już działa
lokalnie, wystawiony przez tunel z uwierzytelnieniem. Do internetu wychodzi
wyłącznie nasza powierzchnia MCP — nigdy IMAP ani Convex.

Jedna wada i jest rozstrzygająca dla telefonu: **Mac musi być włączony.**
„Zapytam z telefonu w drodze do hali" przestaje działać w dniu, w którym
komputer został wyłączony — a wtedy Copilot okazuje się zawodny właśnie wtedy,
kiedy jest najbardziej potrzebny.

Ta opcja zostaje jako sensowny wariant, jeśli właściciel nie chce nowego
dostawcy. Wymaga jednej decyzji: zgody na to, że telefon działa tylko przy
włączonym komputerze.

---

## 3. Co zostało zbudowane

`ai-operator/src/bin/mcp-http.ts` — jeden proces, dwie role:

1. **Endpoint MCP** pod `POST /mcp` (Streamable HTTP, JSON-RPC).
2. **Monitor poczty** w tym samym procesie, co `MONITOR_INTERVAL_MINUTES`.

Jeden proces, bo: jeden deploy, jedno miejsce awarii i **jeden pisarz** do
dziennika spraw. Dwa procesy oznaczałyby wyścig o ten plik bez żadnej korzyści.

Cała obsługa protokołu jest w `src/mcp/core.ts`, **wspólna z transportem stdio**.
Nie ma dwóch list narzędzi ani dwóch implementacji — jest jedna projekcja
rejestru, używana przez dwa cienkie transporty. Pilnuje tego test
(`tests/patch-security.test.ts`, grupa „MCP jest adapterem").

### Bezpieczeństwo — zweryfikowane, nie zadeklarowane

| wymaganie | jak zrobione |
| --- | --- |
| HTTPS | terminowany przez platformę; kontener słucha po HTTP wewnątrz sieci |
| uwierzytelnienie | `Authorization: Bearer` z `MCP_BEARER_TOKEN`, min. 32 znaki |
| fail-closed | **brak tokenu = serwer nie wstaje** (`process.exit(1)`), nie „przepuść" |
| czas stały | `timingSafeEqual`; zwykłe `===` wycieka długość wspólnego prefiksu |
| limit żądań | kubełek żetonów per token, 60 na start + 1/s; nadmiar → 429 |
| brak sekretów w logach | log dostępu ma metodę i nazwę narzędzia, **nie ma** tokenu ani argumentów |
| brak treści maili w audycie | bez zmian — audyt to identyfikatory i liczniki |
| health bez danych | `/health` bez tokenu podaje tylko liczbę narzędzi i czas ostatniego skanu |
| brak cache po drodze | `cache-control: no-store` na każdej odpowiedzi |
| odcięcie dostępu | zmiana `MCP_BEARER_TOKEN` unieważnia wszystkie klienty natychmiast |

Sprawdzone lokalnie: bez tokenu 401, ze złym tokenem 401, `tools/list` zwraca
11 narzędzi, `mail_send` odrzucone jako niewystawione, **zero wystąpień tokenu
w logu serwera**.

### Czego świadomie NIE zbudowałem

**Własnej tożsamości, ról ani OAuth.** `ARCHITEKTURA-AI-2026` punkt 15 zabrania
autoryzacji wewnątrz MCP: „ta jedna decyzja przy złym wyborze odtwarza dzisiejsze
rozdrobnienie tożsamości o warstwę wyżej". Jeden token dla jednego aktora —
właściciela. Gdy pojawi się drugi człowiek, będzie to świadoma decyzja z osobnym
projektem, nie skutek uboczny.

**IMAP ani TeaBrew wystawionych do internetu.** Do sieci wychodzi wyłącznie
nasza powierzchnia MCP, za tokenem, tylko do czytania.

---

## 4. Otwarte pytanie, którego nie mogę rozstrzygnąć

**Nie wiem, jakiego uwierzytelnienia wymaga Claude przy dodawaniu własnego
konektora zdalnego.** Egress tej sesji blokuje `support.anthropic.com`
i `modelcontextprotocol.io`, więc nie mam tego z pierwszego źródła i **nie będę
tego zgadywał** — to samo ograniczenie, które nakładamy na agenta.

Dwie możliwości i co każda oznacza:

- **Konektor przyjmuje nagłówek / statyczny token** → gotowe, wdrażamy jak jest.
- **Konektor wymaga OAuth 2.1 z dynamiczną rejestracją klienta** → bearer nie
  wystarczy. Wtedy są dwie drogi: dołożyć minimalną warstwę OAuth przed
  endpointem (rośnie złożoność, ociera się o zakaz z punktu 15) albo korzystać
  z Remote MCP przez klienta, który przyjmuje nagłówki, i **udokumentować
  ograniczenie mobilne** zamiast udawać, że działa.

Rozstrzygnięcie kosztuje 30 sekund po stronie właściciela: otworzyć w Claude
dodawanie własnego konektora i zobaczyć, o jakie pola pyta.

---

## 5. Wdrożenie — kolejność

1. **Wygeneruj token:** `openssl rand -base64 48` (nie pokazuj go nikomu, nie
   wklejaj do czatu).
2. Railway → nowy projekt z tego repozytorium, katalog główny `ai-operator`,
   build z `Dockerfile`.
3. **Wolumen trwały** zamontowany pod `/data`. Bez tego restart gubi sprawy.
4. Zmienne środowiskowe: `MCP_BEARER_TOKEN`, `MODE=live`, `MAIL_IMAP_HOST`,
   `MAIL_IMAP_PORT`, `MAIL_IMAP_USER`, `MAIL_IMAP_PASSWORD`, `TEABREW_BASE_URL`,
   `TEABREW_AI_OPERATOR_TOKEN`, `ANTHROPIC_API_KEY`, `MAIL_MONITOR_FOLDERS`.
5. Sprawdź `GET /health` — musi zwrócić `ok: true` i `tools: 11`.
6. Dodaj konektor w Claude i wykonaj testy z punktu 20 zadania.

`ANTHROPIC_API_KEY` jest potrzebny **tylko** dla monitora w tle (on woła model po
naszej stronie). Sam endpoint MCP go nie używa — tam modelem jest Claude.
