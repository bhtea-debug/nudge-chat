#!/usr/bin/env bash
set -uo pipefail

# Wdrożenie BHT Copilota na Railway — jedna komenda dla właściciela.
#
# Powstał, bo właściciel powiedział wprost: „ja tego nie robię, nie mam czasu,
# sam ogarnij". Wszystko, co da się zrobić bez jego konta, jest tu zrobione.
# Zostają dwie rzeczy, których żaden skrypt nie wykona: zalogowanie do Railwaya
# w przeglądarce i dodanie konektora w aplikacji Claude.
#
# ── UCZCIWE OSTRZEŻENIE ───────────────────────────────────────────────────────
# Tego skryptu NIE URUCHOMIŁEM. Nie mam konta Railway, a dokumentacja ich CLI
# jest zablokowana przez politykę sieci mojej sesji — nazwy komend znam z opisów
# w wyszukiwarce, nie z dokumentacji, którą mógłbym przeczytać. Dlatego skrypt
# po KAŻDYM niepewnym kroku sprawdza wynik i przy błędzie wypisuje `--help` tej
# komendy, zamiast brnąć dalej. Jeśli się zatrzyma, wklej mi jego wyjście — to
# będzie dokładna informacja, czego brakuje.
#
# ── CZEGO TEN SKRYPT NIE ROBI ─────────────────────────────────────────────────
# Nie wypisuje ani jednej wartości sekretu. Token generuje sam, zapisuje do .env
# z prawami 600 i przekazuje do Railwaya — właściciel nigdy go nie widzi i nie
# musi go nigdzie kopiować.

cd "$(dirname "$0")/.." || exit 1

ENV_FILE=".env"
MOUNT="/data"

# Nazwa usługi wewnątrz projektu. Railway wiąże z NIĄ wolumen, zmienne
# środowiskowe i wdrożenie — świeży projekt nie ma żadnej, a `volume add`
# bez `--service` kończy się błędem. Pierwsza wersja skryptu tego nie tworzyła
# i właśnie na tym stanęła.
SERVICE="bht-copilot"

# Ustawiane na 1, gdy wolumenu nie udało się dodać. Wdrożenie idzie dalej —
# trwały dysk jest wymagany do codziennej pracy, ale NIE do rozstrzygnięcia,
# czy Claude na telefonie pobiera sprawę przez MCP. Blokowanie testu na rzeczy
# opcjonalnej byłoby moim błędem, nie ostrożnością.
BEZ_WOLUMENU=0

kropka() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()     { printf '  ✓ %s\n' "$1"; }
zle()    { printf '  ✗ %s\n' "$1" >&2; }

# Zatrzymanie z wyjaśnieniem. Wypisuje pomoc komendy, która nie przeszła, bo to
# jedyna informacja, która pozwala poprawić flagę bez zgadywania.
stop() {
  local powod="$1"; shift
  zle "$powod"
  if [ $# -gt 0 ]; then
    printf '\n  Pomoc tej komendy (wklej mi to, jeśli nie wiesz, co dalej):\n\n'
    "$@" --help 2>&1 | sed 's/^/    /'
  fi
  printf '\n  Nic nie zostało zepsute — możesz uruchomić ten skrypt ponownie.\n'
  exit 1
}


# Wywołanie komendy Railwaya z przypięciem do usługi, odporne na to, gdzie ta
# wersja CLI chce widzieć flagę.
#
# Powód: `railway volume` to GRUPA i `--service` należy do niej, a nie do
# podkomendy `add`. Przy zwykłych komendach (`variables`, `up`) flaga stoi po
# komendzie. Jedna pomyłka w tej kolejności to kolejna wizyta właściciela
# w terminalu, więc próbujemy po cichu drugiej formy — a gdy projekt ma tylko
# jedną usługę, pominięcie flagi też jest poprawne.
#
# Wynik ostatniej próby zostaje w /tmp/bht-out, żeby wywołujący mógł go pokazać.
zservice() {
  local cmd="$1"; shift
  $RAILWAY "$cmd" --service "$SERVICE" "$@" >/tmp/bht-out 2>&1 && return 0
  grep -q "unexpected argument" /tmp/bht-out || return 1
  # Ta wersja CLI nie chce flagi w tym miejscu — przy jednej usłudze zbędna.
  $RAILWAY "$cmd" "$@" >/tmp/bht-out 2>&1
}

# ── 0. wymagania ──────────────────────────────────────────────────────────────
kropka "0/8  Sprawdzam wymagania"

command -v node >/dev/null || stop "Nie ma node. Zainstaluj Node 22 albo nowszy."
ok "node $(node --version)"

# CLI Railwaya wołamy przez zmienną, nie po nazwie — bo droga do niego zależy od
# maszyny, a instalacja globalna (`npm i -g`) na macOS najczęściej wymaga
# uprawnień do katalogu npm i po prostu się nie udaje. `npx` nie wymaga niczego:
# ściąga pakiet raz do cache'a i uruchamia. Kolejność prób od najtańszej.
RAILWAY=""
if command -v railway >/dev/null 2>&1; then
  RAILWAY="railway"
elif command -v brew >/dev/null 2>&1 && brew list railway >/dev/null 2>&1; then
  RAILWAY="railway"
else
  printf '  Nie ma CLI Railwaya — użyję npx (bez instalacji globalnej)…\n'
  if npx --yes @railway/cli@latest --version >/tmp/bht-railway-probe 2>&1; then
    RAILWAY="npx --yes @railway/cli@latest"
  else
    zle "Nie mogę uruchomić CLI Railwaya ani lokalnie, ani przez npx."
    printf '\n  Co powiedział npx:\n\n'
    sed 's/^/    /' /tmp/bht-railway-probe
    printf '\n  Spróbuj jednej z tych dróg, potem uruchom skrypt ponownie:\n'
    printf '    brew install railway\n'
    printf '    sudo npm i -g @railway/cli\n'
    exit 1
  fi
fi
ok "railway: $($RAILWAY --version 2>/dev/null | tail -1 || echo '?')"

[ -f "$ENV_FILE" ] || stop "Nie ma pliku .env w $(pwd). Bez niego nie wiem, jak łączyć się z pocztą i TeaBrew."
ok "$ENV_FILE"

# ── 1. logowanie ──────────────────────────────────────────────────────────────
kropka "1/8  Logowanie do Railwaya"

if $RAILWAY whoami >/dev/null 2>&1; then
  ok "już zalogowany jako $($RAILWAY whoami 2>/dev/null | tail -1)"
else
  printf '  Otworzę przeglądarkę — zatwierdź logowanie i wróć tutaj.\n'
  $RAILWAY login || stop "Logowanie nie przeszło." $RAILWAY login
  ok "zalogowany"
fi

# ── 2. token dla Claude ───────────────────────────────────────────────────────
kropka "2/8  Token, którym Claude wchodzi do danych"

# Generujemy po naszej stronie i NIE wypisujemy. Właściciel nie musi go widzieć
# ani kopiować — to eliminuje jedyny moment, w którym sekret trafiał na ekran.
if grep -q '^MCP_BEARER_TOKEN=.\{32,\}' "$ENV_FILE" 2>/dev/null; then
  ok "token już jest w .env (nie generuję nowego, żeby nie odciąć podłączonych klientów)"
else
  TOKEN_NOWY="$(openssl rand -base64 48 | tr -d '\n')"
  # Usuwamy ewentualną pustą albo za krótką linię, dopisujemy właściwą.
  if [ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE" | wc -l)" -eq 0 ]; then printf '\n' >> "$ENV_FILE"; fi
  grep -v '^MCP_BEARER_TOKEN=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  printf 'MCP_BEARER_TOKEN=%s\n' "$TOKEN_NOWY" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset TOKEN_NOWY
  ok "wygenerowany i zapisany w .env (prawa 600, wartość nigdzie nie wypisana)"
fi

# ── 2b. hasło do ekranu zgody ─────────────────────────────────────────────────
kropka "2b/8  Haslo do ekranu zgody (OAuth)"

# Okno konektora w Claude nie ma pola na token — jedyną drogą jest OAuth,
# a przy nim ktoś musi po ludzku potwierdzić zgodę. To hasło jest tą bramą.
#
# W przeciwieństwie do tokenu MUSI być widoczne: wpisujesz je na telefonie,
# więc trzeba je przeczytać. Dlatego jest krótkie i generowane raz.
if grep -q '^COPILOT_AUTH_PASSWORD=.\{8,\}' "$ENV_FILE" 2>/dev/null; then
  ok "hasło już jest w .env"
else
  # Bez znaków mylących na ekranie telefonu (0/O, 1/l/I) i bez znaków, które
  # trzeba przełączać klawiaturą.
  HASLO_NOWE="$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12)"
  if [ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE" | wc -l)" -eq 0 ]; then printf '\n' >> "$ENV_FILE"; fi
  grep -v '^COPILOT_AUTH_PASSWORD=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  printf 'COPILOT_AUTH_PASSWORD=%s\n' "$HASLO_NOWE" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "wygenerowane i zapisane w .env"
  printf '\n  ┌────────────────────────────────────────────────┐\n'
  printf '  │  HASŁO DO EKRANU ZGODY:  %-21s │\n' "$HASLO_NOWE"
  printf '  └────────────────────────────────────────────────┘\n'
  printf '  Wpiszesz je RAZ, gdy Claude poprosi o zgodę. Zapisz je sobie.\n'
  printf '  NIE wklejaj tej linii nikomu — to jest brama do poczty firmy.\n'
  unset HASLO_NOWE
fi

# ── 3. projekt ────────────────────────────────────────────────────────────────
kropka "3/8  Projekt w Railwayu"

if $RAILWAY status >/dev/null 2>&1; then
  ok "katalog jest już powiązany z projektem"
else
  printf '  Zakładam projekt. Jeśli CLI zapyta o nazwę, wpisz np. bht-copilot.\n'
  $RAILWAY init || stop "Nie udało się założyć projektu." $RAILWAY init
  ok "projekt założony"
fi

# ── 3b. usługa ────────────────────────────────────────────────────────────────
kropka "3b/8  Usluga $SERVICE w projekcie"

# Railway wiąże wolumen, zmienne i wdrożenie z USŁUGĄ, nie z projektem.
# Świeży projekt nie ma żadnej, więc trzeba ją najpierw utworzyć.
if $RAILWAY status 2>/dev/null | grep -q "$SERVICE"; then
  ok "usługa już istnieje"
elif $RAILWAY add --service "$SERVICE" >/tmp/bht-add 2>&1; then
  ok "usługa utworzona"
else
  # Może już istnieć — wtedy nie jest to błąd i idziemy dalej.
  if grep -qi "already\|exists\|duplicate" /tmp/bht-add; then
    ok "usługa już istniała"
  else
    zle "Nie udało się utworzyć usługi."
    printf '\n  Co powiedziało CLI:\n\n'
    sed 's/^/    /' /tmp/bht-add
    printf '\n  Pomoc komendy:\n\n'
    $RAILWAY add --help 2>&1 | sed 's/^/    /'
    exit 1
  fi
fi

# ── 4. wolumen na stan spraw ──────────────────────────────────────────────────
kropka "4/8  Trwały wolumen ($MOUNT)"

# Bez wolumenu każdy restart kontenera gubi sprawy i checkpointy, a monitor
# przeczytałby całą skrzynkę od nowa. To nie jest opcjonalne.
#
# Wykrywanie istniejącego wolumenu jest CELOWO pobłażliwe: sprawdzamy i ścieżkę
# montowania, i samo słowo „volume" w wyjściu. Wolumen dodany ręcznie w panelu
# może być wypisany inaczej, a druga próba dodania kończy się paniką CLI —
# lepiej pominąć krok, który już ktoś wykonał, niż wywalić cały skrypt.
if $RAILWAY volume list 2>/dev/null | grep -qi "$MOUNT\|volume"; then
  ok "wolumen już istnieje (pomijam)"
else
  # Trzy rzeczy ustalone na żywym CLI, wszystkie sprzeczne z jego własną pomocą:
  #
  #  1. `--service` jest flagą GRUPY `railway volume`, nie podkomendy `add`
  #     (przykład w pomocy pokazuje odwrotnie i kończy się „unexpected argument"),
  #  2. `--service` oczekuje **ID usługi**, nie jej nazwy,
  #  3. podanie nazwy zamiast ID nie daje czytelnego błędu, tylko PANIKĘ Rusta
  #     (`Option::unwrap()` on a `None`) — czyli błąd w narzędziu dostawcy.
  #
  # Dlatego najpierw próbujemy wyciągnąć ID usługi z `status --json`, a gdy się
  # nie uda, wołamy bez flagi. Jedna usługa w projekcie i tak czyni ją zbędną.
  SERVICE_ID="$($RAILWAY status --json 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      try {
        const j = JSON.parse(d);
        const szukaj = (o) => {
          if (!o || typeof o !== "object") return null;
          if (o.name === process.env.SERVICE && typeof o.id === "string") return o.id;
          for (const v of Object.values(o)) { const r = szukaj(v); if (r) return r; }
          return null;
        };
        process.stdout.write(szukaj(j) ?? "");
      } catch { /* brak json albo inny kształt — trudno */ }
    });
  ' 2>/dev/null || true)"

  if [ -n "$SERVICE_ID" ]; then
    printf '  (znalazłem ID usługi, używam go zamiast nazwy)\n'
    PROBA=($RAILWAY volume --service "$SERVICE_ID" add --mount-path "$MOUNT")
  else
    PROBA=($RAILWAY volume add --mount-path "$MOUNT")
  fi

  if "${PROBA[@]}" >/tmp/bht-vol 2>&1; then
    ok "wolumen dodany"
  else
    zle "Nie umiem dodać wolumenu."
    printf '\n  Co powiedziało CLI:\n\n'
    sed 's/^/    /' /tmp/bht-vol
    printf '\n  IDĘ DALEJ BEZ WOLUMENU — to NIE blokuje testu.\n\n'
    printf '  Co to znaczy w praktyce:\n'
    printf '    · serwer, poczta, TeaBrew i MCP działają normalnie,\n'
    printf '    · sprawy przeżyją bieżące uruchomienie, ale NIE restart kontenera,\n'
    printf '    · po restarcie monitor odtworzy je ze skrzynki przy pierwszym skanie.\n\n'
    printf '  Do codziennej pracy wolumen trzeba dodać. Do odpowiedzi na pytanie\n'
    printf '  „czy Claude na telefonie pobiera sprawę przez MCP" — nie jest potrzebny.\n\n'
    printf '  Kiedy będziesz mieć chwilę: panel Railway → usługa %s →\n' "$SERVICE"
    printf '  Settings → Volumes → New Volume → punkt montowania %s\n' "$MOUNT"
    BEZ_WOLUMENU=1
    if grep -q "panicked" /tmp/bht-vol; then
      printf '\n  To jest BŁĄD W NARZĘDZIU Railwaya (panika Rusta), nie w konfiguracji.\n'
      printf '  Nie da się go obejść z wiersza poleceń — panel działa normalnie.\n'
    fi

  fi
fi

# ── 5. zmienne środowiskowe ───────────────────────────────────────────────────
kropka "5/8  Zmienne środowiskowe"

# Przenosimy WYŁĄCZNIE to, co potrzebne na serwerze. Świadomie NIE przenosimy
# ANTHROPIC_API_KEY (reasoning robi Claude na subskrypcji właściciela) ani
# COPILOT_UI_* (interfejs został usunięty — całym UI jest Claude).
POTRZEBNE=(
  MCP_BEARER_TOKEN
  COPILOT_AUTH_PASSWORD
  MAIL_IMAP_HOST MAIL_IMAP_PORT MAIL_IMAP_USER MAIL_IMAP_PASSWORD
  MAIL_FOLDER MAIL_SENT_FOLDER MAIL_THREAD_FOLDERS
  TEABREW_BASE_URL TEABREW_AI_OPERATOR_TOKEN
  CONNECTEAM_API_KEY CONNECTEAM_WEBHOOK_SECRET
)

ARGS=()
BRAK=()
for KLUCZ in "${POTRZEBNE[@]}"; do
  LINIA="$(grep -m1 "^${KLUCZ}=" "$ENV_FILE" 2>/dev/null || true)"
  WARTOSC="${LINIA#*=}"
  if [ -n "$LINIA" ] && [ -n "$WARTOSC" ]; then
    ARGS+=(--set "${KLUCZ}=${WARTOSC}")
    ok "$KLUCZ"                       # nazwa, NIGDY wartość
  else
    BRAK+=("$KLUCZ")
  fi
done

# MODE=live i ścieżki stanu są stałymi wdrożenia, nie sekretami z .env.
ARGS+=(--set "MODE=live" --set "MONITOR_IN_PROCESS=1")
ok "MODE=live, monitor w procesie"

if [ ${#BRAK[@]} -gt 0 ]; then
  printf '  · pominięte (nie ma ich w .env): %s\n' "${BRAK[*]}"
fi

for KONIECZNE in MAIL_IMAP_HOST MAIL_IMAP_USER MAIL_IMAP_PASSWORD TEABREW_BASE_URL TEABREW_AI_OPERATOR_TOKEN COPILOT_AUTH_PASSWORD; do
  grep -q "^${KONIECZNE}=." "$ENV_FILE" || stop "Brak $KONIECZNE w .env — bez tego serwer nie połączy się ze źródłami."
done

zservice variables "${ARGS[@]}" || {
  zle "Nie udało się ustawić zmiennych."
  printf '\n  Co powiedziało CLI:\n\n'
  sed 's/^/    /' /tmp/bht-out
  printf '\n  Pomoc komendy:\n\n'
  $RAILWAY variables --help 2>&1 | sed 's/^/    /'
  exit 1
}
ok "zmienne przeniesione (wartości nie były nigdzie wypisane)"

# ── 6. wdrożenie ──────────────────────────────────────────────────────────────
kropka "6/8  Wdrożenie"

printf '  Buduję obraz z Dockerfile i wysyłam. Potrwa 1–3 minuty…\n'
zservice up --detach || {
  zle "Wdrożenie nie przeszło."
  printf '\n  Co powiedziało CLI:\n\n'
  sed 's/^/    /' /tmp/bht-out
  printf '\n  Pomoc komendy:\n\n'
  $RAILWAY up --help 2>&1 | sed 's/^/    /'
  exit 1
}
cat /tmp/bht-out | tail -3 | sed 's/^/    /' 
ok "wysłane"

# ── 7. adres i sprawdzenie ────────────────────────────────────────────────────
kropka "7/8  Adres HTTPS i sprawdzenie, czy żyje"

zservice domain >/dev/null 2>&1 || true
ADRES="$(grep -oE '[a-z0-9.-]+\.up\.railway\.app' /tmp/bht-out 2>/dev/null | head -1 || true)"
if [ -z "$ADRES" ]; then
  zle "Nie odczytałem adresu z CLI."
  printf '\n  Wygeneruj go w panelu: Settings → Networking → Generate Domain,\n'
  printf '  potem sprawdź w przeglądarce: https://TWOJ-ADRES/health\n'
  exit 1
fi
ok "https://$ADRES"

printf '  Czekam, aż wstanie (do 3 minut). Każda kropka to jedna próba:\n  '
ZDROWY=0
for _ in $(seq 1 36); do
  ODP="$(curl -fsS --max-time 8 "https://$ADRES/health" 2>/dev/null || true)"
  if printf '%s' "$ODP" | grep -q '"ok":true'; then
    ZDROWY=1
    NARZEDZIA="$(printf '%s' "$ODP" | grep -oE '"tools":[0-9]+' | cut -d: -f2)"
    printf '\n'
    break
  fi
  # Kropka po każdej próbie: bez niej trzy minuty ciszy wyglądają jak zawieszenie
  # i człowiek przerywa skrypt w połowie budowania obrazu.
  printf '.'
  sleep 5
done

if [ "$ZDROWY" -ne 1 ]; then
  zle "Serwer nie odpowiedział na /health w ciągu 3 minut."
  printf '\n  Ostatnie logi (bez treści maili i bez tokenów):\n\n'
  zservice logs >/dev/null 2>&1 || true
  tail -30 /tmp/bht-out | sed 's/^/    /'
  printf '\n  Wklej mi te linie — powiedzą, czego brakuje.\n'
  exit 1
fi

OSTRZEZENIE_WOLUMEN=""
if [ "$BEZ_WOLUMENU" = "1" ]; then
  OSTRZEZENIE_WOLUMEN="  UWAGA: bez trwałego wolumenu — sprawy nie przeżyją restartu kontenera.
  Do testu to wystarcza; do codziennej pracy dodaj wolumen w panelu."
fi

kropka "GOTOWE po mojej stronie"
cat <<PODSUMOWANIE
  Serwer działa: https://$ADRES
$OSTRZEZENIE_WOLUMEN
  Narzędzia dla Claude: ${NARZEDZIA:-?}
  Stan spraw: trwały wolumen $MOUNT
  Poczta i TeaBrew: read-only, jak dotychczas

  ZOSTAŁA JEDNA RZECZ, KTÓREJ ŻADEN SKRYPT NIE ZROBI.

  W aplikacji Claude: Ustawienia → Konektory → Dodaj własny konektor
    nazwa:  BHT Copilot
    adres:  https://$ADRES/mcp

  Pola OAuth Client ID i Secret ZOSTAW PUSTE — serwer rejestruje klienta sam.

  Po kliknięciu „Add" Claude otworzy stronę zgody i poprosi o hasło.
  To jest to hasło, które wypisałem wyżej (albo masz je w .env pod
  COPILOT_AUTH_PASSWORD).
PODSUMOWANIE
