# Wdrożenie BHT Copilot na Railway — instrukcja dla właściciela

Hosting został wybrany wcześniej i nie jest tu ponownie analizowany —
uzasadnienie w `docs/DECYZJA-REMOTE-MCP.md`. Ten dokument mówi tylko **co
kliknąć i co wpisać**.

Wszystko, co dało się przygotować bez Twojego konta, jest gotowe: `Dockerfile`,
health-check, trwały stan na wolumenie, fail-closed przy braku tokenu. Zostają
czynności, których nie wykonam za Ciebie, bo wymagają Twojego konta i Twoich
sekretów.

---

## Zanim zaczniesz: wygeneruj token

Na swoim Macu, w terminalu:

```bash
openssl rand -base64 48
```

Skopiuj wynik. To będzie `MCP_BEARER_TOKEN` — hasło, którym Claude wchodzi do
Twoich danych. **Nie wklejaj go do rozmowy ze mną ani do żadnego pliku
w repozytorium.** Wpisujesz go tylko w panelu Railway.

---

## Krok 1 — projekt z repozytorium

W Railway: **New Project → Deploy from GitHub repo →** `bhtea-debug/nudge-chat`.

Potem w ustawieniach usługi:

| pole | wartość |
| --- | --- |
| Branch | `claude/ai-company-architecture-mvy1uv` |
| Root Directory | `ai-operator` |
| Builder | Dockerfile (Railway wykryje sam) |

Root Directory jest istotny: `Dockerfile` leży w `ai-operator/`, nie w korzeniu
repozytorium.

---

## Krok 2 — wolumen na stan spraw

**Settings → Volumes → New Volume**, punkt montowania: `/data`.

To nie jest opcjonalne. Bez wolumenu każdy restart kontenera zaczyna od zera:
sprawy znikają, checkpointy przepadają, a monitor przeanalizuje całą skrzynkę od
nowa. `Dockerfile` celuje `COPILOT_STATE_DIR` w `/data/state` właśnie po to.

---

## Krok 3 — zmienne środowiskowe

**Variables**. Wartości bierzesz z pliku `.env` na swoim Macu — te same, które
już działają lokalnie.

| zmienna | wartość |
| --- | --- |
| `MCP_BEARER_TOKEN` | wynik `openssl` z góry |
| `MODE` | `live` |
| `MAIL_IMAP_HOST` | jak w `.env` |
| `MAIL_IMAP_PORT` | `993` |
| `MAIL_IMAP_USER` | jak w `.env` |
| `MAIL_IMAP_PASSWORD` | jak w `.env` |
| `MAIL_FOLDER` | `INBOX` |
| `MAIL_SENT_FOLDER` | `Sent` |
| `TEABREW_BASE_URL` | jak w `.env` |
| `TEABREW_AI_OPERATOR_TOKEN` | jak w `.env` |

Czego **nie** ustawiać: `ANTHROPIC_API_KEY` (nie jest potrzebny — reasoning robi
Claude na Twojej subskrypcji) i `CONNECTEAM_API_KEY`, dopóki nie wiemy, czy jego
API cokolwiek nam daje (`docs/DECYZJA-CONNECTEAM.md`).

Zmienne w Railway są zaszyfrowane i nie ma ich w repozytorium. Odebranie dostępu
to zmiana jednej wartości.

---

## Krok 4 — adres HTTPS

**Settings → Networking → Generate Domain.** Railway wystawia HTTPS z certyfikatem
automatycznie; nic nie konfigurujesz.

Dostaniesz adres w rodzaju `bht-copilot-production.up.railway.app`. Sprawdź, czy
żyje — w przeglądarce:

```
https://twoj-adres.up.railway.app/health
```

Powinno odpowiedzieć jednym wierszem z `"ok":true` i `"tools":11`. Ten adres
**nie wymaga tokenu i nie zawiera danych firmy** — właśnie dlatego można go
otworzyć bez obaw.

Jeśli zobaczysz `"ok":false` albo błąd — zajrzyj w logi usługi w Railway
i wklej mi ostatnie kilkanaście linii. Log nie zawiera treści maili ani tokenów.

---

## Krok 5 — podłączenie jako konektor w Claude

To jest jedyny krok, którego **nie umiem dla Ciebie sprawdzić** — dialog dodawania
konektora jest w Twojej aplikacji i nie mam do niego wglądu.

W Claude: **Ustawienia → Konektory → Dodaj własny konektor** (nazwa menu może się
różnić między wersjami).

- adres: `https://twoj-adres.up.railway.app/mcp`
- uwierzytelnienie: token, który wygenerowałeś

**Powiedz mi, o co dokładnie pyta ten dialog.** Możliwe trzy warianty i każdy
oznacza inną robotę po mojej stronie:

1. tylko adres URL → gotowe, nic więcej nie trzeba,
2. adres + pole na nagłówek/token → wpisz `Authorization: Bearer <token>`,
3. adres + OAuth client ID i secret → serwer tego dziś nie obsługuje i muszę
   dopisać obsługę. **Nie buduję jej na zapas**, bo nie wiem, czy jest potrzebna.

---

## Krok 6 — test z telefonu

W aplikacji Claude na telefonie, w **nowej** rozmowie:

```
Co wymaga teraz mojej uwagi?
```

Potem, na tej samej liście:

```
Rozwiń 2.
```

I w **całkiem nowej** rozmowie, żeby sprawdzić, czy pamięć spraw działa bez
starego kontekstu:

```
Co z Rossmannem?
```

Jeśli wszystkie trzy odpowiedzą sensownie — produkt działa i to jest moment, od
którego można go używać w codziennej pracy.

---

## Czego to wdrożenie NIE zmienia

Twój Mac przestaje być potrzebny do codziennej pracy, ale **`npm run copilot`
lokalnie i wdrożenie na Railway to dwie osobne pamięci spraw.** Każde ma swój
katalog stanu, więc sprawy zamknięte w jednym miejscu nie znikną w drugim.
Po wdrożeniu wyłącz lokalny serwer i pracuj tylko na zdalnym — inaczej monitor
w dwóch miejscach będzie czytał tę samą skrzynkę i zobaczysz podwójne sprawy.

Wszystkie systemy źródłowe pozostają tylko do odczytu. Wdrożenie nie dodaje ani
jednej możliwości zapisu: ani do poczty, ani do Connecteam, ani do TeaBrew.
