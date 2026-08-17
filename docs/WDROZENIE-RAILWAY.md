# Wdrożenie BHT Copilot na Railway — instrukcja dla właściciela

Hosting został wybrany wcześniej i nie jest tu ponownie analizowany —
uzasadnienie w `docs/DECYZJA-REMOTE-MCP.md`. Ten dokument mówi tylko **co
kliknąć i co wpisać**.

Wszystko, co dało się przygotować bez Twojego konta, jest gotowe: `Dockerfile`,
health-check, trwały stan na wolumenie, fail-closed przy braku tokenu. Zostają
czynności, których nie wykonam za Ciebie, bo wymagają Twojego konta i Twoich
sekretów.

---

## Najpierw spróbuj jedną komendą

Na Macu, w katalogu projektu:

```bash
cd ~/nudge-chat-live/ai-operator && git pull && npm run wdroz
```

Skrypt robi wszystko poza dwiema rzeczami, których nie może: zalogowaniem do
Railwaya (otworzy przeglądarkę, zatwierdzasz) i dodaniem konektora w Claude
(krok 5 poniżej). Konkretnie:

- instaluje CLI Railwaya, jeśli go nie ma,
- **generuje token i zapisuje go do `.env`, nie pokazując go na ekranie** —
  nie musisz go kopiować ani nigdzie wklejać,
- zakłada projekt i wolumen na `/data`,
- przenosi zmienne z Twojego `.env` (wypisuje NAZWY, nigdy wartości),
- buduje obraz i wdraża,
- generuje adres HTTPS i czeka, aż serwer odpowie na `/health`.

**Skryptu nie uruchomiłem** — nie mam konta Railway, a dokumentacja ich CLI jest
zablokowana przez politykę sieci mojej sesji, więc flagi komend znam z opisów,
nie z dokumentacji. Dlatego po każdym niepewnym kroku skrypt sprawdza wynik
i przy błędzie wypisuje pomoc tej komendy, zamiast brnąć dalej. Jeśli się
zatrzyma — wklej mi jego wyjście. Można go uruchamiać wielokrotnie: pomija
kroki, które już przeszły.

Jeśli skrypt się zatrzyma, na końcu tego dokumentu jest **droga ręczna** — te same
kroki do wyklikania w panelu.

---

## Podłączenie jako konektor w Claude — TO MUSISZ ZROBIĆ SAM

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

## Test z telefonu

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

---

## Droga ręczna — gdy skrypt się zatrzyma

### 1. Projekt z repozytorium

Railway: **New Project → Deploy from GitHub repo →** `bhtea-debug/nudge-chat`.
Potem w ustawieniach usługi:

| pole | wartość |
| --- | --- |
| Branch | `claude/ai-company-architecture-mvy1uv` |
| Root Directory | `ai-operator` |
| Builder | Dockerfile (Railway wykryje sam) |

Root Directory jest istotny: `Dockerfile` leży w `ai-operator/`, nie w korzeniu
repozytorium.

### 2. Wolumen na stan spraw

**Settings → Volumes → New Volume**, punkt montowania: `/data`.

To nie jest opcjonalne. Bez wolumenu każdy restart kontenera zaczyna od zera:
sprawy znikają, checkpointy przepadają, a monitor przeanalizuje całą skrzynkę od
nowa. `Dockerfile` celuje `COPILOT_STATE_DIR` w `/data/state` właśnie po to.

### 3. Zmienne środowiskowe

**Variables**. Wartości bierzesz z pliku `.env` na Macu — te same, które już
działają lokalnie.

| zmienna | wartość |
| --- | --- |
| `MCP_BEARER_TOKEN` | `openssl rand -base64 48 \| tr -d '\n' \| pbcopy`, potem Cmd+V |
| `MODE` | `live` |
| `MAIL_IMAP_HOST` | jak w `.env` |
| `MAIL_IMAP_PORT` | `993` |
| `MAIL_IMAP_USER` | jak w `.env` |
| `MAIL_IMAP_PASSWORD` | jak w `.env` |
| `MAIL_FOLDER` | `INBOX` |
| `MAIL_SENT_FOLDER` | `Sent` |
| `TEABREW_BASE_URL` | jak w `.env` |
| `TEABREW_AI_OPERATOR_TOKEN` | jak w `.env` |

Czego **nie** ustawiać: `ANTHROPIC_API_KEY` (reasoning robi Claude na Twojej
subskrypcji) i `CONNECTEAM_API_KEY`, dopóki nie wiemy, czy jego API cokolwiek nam
daje (`docs/DECYZJA-CONNECTEAM.md`).

Zmienne w Railway są zaszyfrowane i nie ma ich w repozytorium. Odebranie dostępu
to zmiana jednej wartości.

### 4. Adres HTTPS

**Settings → Networking → Generate Domain.** HTTPS z certyfikatem dostajesz
automatycznie; nic nie konfigurujesz.

Sprawdź w przeglądarce `https://twoj-adres.up.railway.app/health` — powinno
odpowiedzieć `"ok":true` i `"tools":11`. Ten adres nie wymaga tokenu i nie
zawiera danych firmy, dlatego można go otworzyć bez obaw.

Przy `"ok":false` albo błędzie zajrzyj w logi usługi i wklej mi ostatnie
kilkanaście linii. Log nie zawiera treści maili ani tokenów.
