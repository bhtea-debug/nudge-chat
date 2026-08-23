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

ENV_FILE="${BHT_COPILOT_ENV_FILE:-.env}"
ENV_EXTERNAL=0
[ -n "${BHT_COPILOT_ENV_FILE:-}" ] && ENV_EXTERNAL=1
MOUNT="/data"

# Nazwa usługi wewnątrz projektu. Railway wiąże z NIĄ wolumen, zmienne
# środowiskowe i wdrożenie — świeży projekt nie ma żadnej, a `volume add`
# bez `--service` kończy się błędem. Pierwsza wersja skryptu tego nie tworzyła
# i właśnie na tym stanęła.
SERVICE="bht-copilot"
PRODUCTION_MODE="${BHT_COPILOT_PRODUCTION:-0}"
CONFIGURE_REPLY_ONLY="${BHT_COPILOT_CONFIGURE_REPLY_ONLY:-0}"
# Wyłącznik awaryjny mostu odpowiedzi: czyści OBA tokeny i restartuje BIEŻĄCE
# wdrożenie. Nie buduje i nie wysyła żadnego kodu, nie czyta pliku sekretów.
DISABLE_REPLY_ONLY="${BHT_COPILOT_DISABLE_REPLY_ONLY:-0}"
EXPECTED_PROJECT_ID="bd311917-f3d7-419f-aeba-79bf5b4dafe4"
EXPECTED_ENVIRONMENT_ID="e8e60c09-4de2-4fb3-a11d-6e9048371e54"
EXPECTED_SERVICE_ID="c4a9c0ad-7c0e-4494-a16e-321e0e382b6c"
EXPECTED_REMOTE="https://github.com/bhtea-debug/nudge-chat"
PRODUCTION_TARGET_ARGS=(--project "$EXPECTED_PROJECT_ID" --environment "$EXPECTED_ENVIRONMENT_ID")

if [ "$CONFIGURE_REPLY_ONLY" = "1" ] && [ "$PRODUCTION_MODE" != "1" ]; then
  printf 'Tryb BHT_COPILOT_CONFIGURE_REPLY_ONLY wymaga BHT_COPILOT_PRODUCTION=1.\n' >&2
  exit 1
fi
if [ "$DISABLE_REPLY_ONLY" = "1" ] && [ "$PRODUCTION_MODE" != "1" ]; then
  printf 'Tryb BHT_COPILOT_DISABLE_REPLY_ONLY wymaga BHT_COPILOT_PRODUCTION=1.\n' >&2
  exit 1
fi
if [ "$DISABLE_REPLY_ONLY" = "1" ] && [ "$CONFIGURE_REPLY_ONLY" = "1" ]; then
  printf 'Tryby CONFIGURE_REPLY_ONLY i DISABLE_REPLY_ONLY wykluczaja sie.\n' >&2
  exit 1
fi

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
  if [ "$PRODUCTION_MODE" = "1" ]; then
    $RAILWAY "$cmd" "${PRODUCTION_TARGET_ARGS[@]}" --service "$EXPECTED_SERVICE_ID" "$@" >/tmp/bht-out 2>&1
    return $?
  fi
  $RAILWAY "$cmd" --service "$SERVICE" "$@" >/tmp/bht-out 2>&1 && return 0
  grep -q "unexpected argument" /tmp/bht-out || return 1
  # Ta wersja CLI nie chce flagi w tym miejscu — przy jednej usłudze zbędna.
  $RAILWAY "$cmd" "$@" >/tmp/bht-out 2>&1
}

railway_variable_list_json() {
  if [ "$PRODUCTION_MODE" = "1" ]; then
    $RAILWAY variable list "${PRODUCTION_TARGET_ARGS[@]}" --service "$EXPECTED_SERVICE_ID" --json
  else
    $RAILWAY variable list --service "$SERVICE" --json
  fi
}

railway_variable_set_stdin() {
  local key="$1"
  if [ "$PRODUCTION_MODE" = "1" ]; then
    $RAILWAY variable set "$key" --stdin --skip-deploys "${PRODUCTION_TARGET_ARGS[@]}" --service "$EXPECTED_SERVICE_ID"
  else
    $RAILWAY variable set "$key" --stdin --skip-deploys --service "$SERVICE"
  fi
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

if [ "$DISABLE_REPLY_ONLY" = "1" ]; then
  # Wyłącznik nie czyta ŻADNYCH sekretów, więc nie wymaga pliku .env: w chwili
  # incydentu plik może nie istnieć na tej maszynie i nie moze to blokowac
  # odciecia wysylki.
  ok "tryb awaryjny: plik sekretów nie jest potrzebny i nie jest czytany"
else
  if [ -n "${BHT_COPILOT_ENV_FILE:-}" ] && [[ "$ENV_FILE" != /* ]]; then
    stop "BHT_COPILOT_ENV_FILE musi być ścieżką bezwzględną."
  fi
  [ -L "$ENV_FILE" ] && stop "Plik $ENV_FILE nie może być dowiązaniem symbolicznym."
  [ -f "$ENV_FILE" ] || stop "Nie ma pliku $ENV_FILE. Bez niego nie wiem, jak łączyć się z pocztą i TeaBrew."
  ENV_MODE="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')"
  [ "$ENV_MODE" = "600" ] || stop "Plik $ENV_FILE musi mieć prawa 600; wykryto $ENV_MODE."
  ENV_UID="$(stat -f '%u' "$ENV_FILE" 2>/dev/null || stat -c '%u' "$ENV_FILE" 2>/dev/null || echo '?')"
  [ "$ENV_UID" = "$(id -u)" ] || stop "Plik $ENV_FILE musi należeć do bieżącego użytkownika."
  ok "$ENV_FILE"
fi

# Na produkcji odmawiamy przy najmniejszej niejednoznaczności repo/celu.
if [ "$PRODUCTION_MODE" = "1" ]; then
  # Wyłącznik awaryjny nie wdraża kodu, więc nie przechodzi kontroli gita
  # (czystość, HEAD==origin/main, fetch z sieci): w chwili incydentu drzewo
  # może być w dowolnym stanie, a brak sieci do GitHuba nie może blokować
  # odcięcia wysyłki. Kontrola CELU Railway niżej pozostaje w mocy.
  if [ "$DISABLE_REPLY_ONLY" != "1" ]; then
    git rev-parse --git-dir >/dev/null 2>&1 || stop "Tryb produkcyjny wymaga repozytorium git."
    git fetch --quiet origin main || stop "Nie udało się pobrać aktualnego origin/main; produkcyjny deploy jest zablokowany."
    REMOTE="$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##; s#/$##')"
    [ "$REMOTE" = "$EXPECTED_REMOTE" ] || stop "origin to $REMOTE, oczekiwano $EXPECTED_REMOTE."
    [ -z "$(git status --porcelain)" ] || stop "Worktree produkcyjny musi być całkowicie czysty."
    HEAD_COMMIT="$(git rev-parse HEAD)"
    MAIN_COMMIT="$(git rev-parse origin/main)"
    [ "$HEAD_COMMIT" = "$MAIN_COMMIT" ] || stop "HEAD nie jest dokładnym aktualnym origin/main."
  fi

  STATUS_JSON="$($RAILWAY status "${PRODUCTION_TARGET_ARGS[@]}" --json 2>/dev/null)" || stop "Nie można odczytać dokładnego projektu Railway production."
  if ! printf '%s' "$STATUS_JSON" | EXPECTED_PROJECT_ID="$EXPECTED_PROJECT_ID" EXPECTED_ENVIRONMENT_ID="$EXPECTED_ENVIRONMENT_ID" EXPECTED_SERVICE_ID="$EXPECTED_SERVICE_ID" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const value = JSON.parse(raw);
        const environment = value.environments?.edges?.find(
          (edge) => edge.node?.id === process.env.EXPECTED_ENVIRONMENT_ID && edge.node?.name === "production",
        )?.node;
        const service = environment?.serviceInstances?.edges?.find(
          (edge) => edge.node?.serviceId === process.env.EXPECTED_SERVICE_ID && edge.node?.serviceName === "bht-copilot",
        )?.node;
        if (value.id !== process.env.EXPECTED_PROJECT_ID || value.name !== "heartfelt-spontaneity" || !service) {
          process.exit(1);
        }
      } catch {
        process.exit(1);
      }
    });
  '; then
    unset STATUS_JSON
    stop "Railway link nie wskazuje dokładnie heartfelt-spontaneity / production / bht-copilot."
  fi
  unset STATUS_JSON
  ok "produkcyjny target jednoznaczny: heartfelt-spontaneity / production / bht-copilot"
  if [ "$DISABLE_REPLY_ONLY" != "1" ]; then
    ok "wdrażam $(git rev-parse --short HEAD): $(git log -1 --format=%s 2>/dev/null | cut -c1-58)"
  fi
elif git rev-parse --git-dir >/dev/null 2>&1; then
  # Zachowujemy historyczny tryb pomocniczy poza produkcją.
  GALAZ="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if git fetch --quiet origin "$GALAZ" 2>/dev/null; then
    ZA_STARE="$(git rev-list --count "HEAD..origin/$GALAZ" 2>/dev/null || echo 0)"
    if [ "${ZA_STARE:-0}" -gt 0 ]; then
      zle "Twoja kopia jest starsza o ${ZA_STARE} commit(ów) od origin/$GALAZ."
      printf '\n  Wdrożyłbym kod, którego już nie chcesz. Najpierw:\n\n    git pull\n\n'
      printf '  potem uruchom to jeszcze raz. Nic nie zostało wysłane.\n'
      exit 1
    fi
  else
    printf '  · nie sprawdziłem świeżości kopii (nie dosięgnąłem GitHuba) — wdrażam to, co tu leży\n'
  fi
  ok "wdrażam $(git rev-parse --short HEAD): $(git log -1 --format=%s 2>/dev/null | cut -c1-58)"
fi

# ── 1. logowanie ──────────────────────────────────────────────────────────────
kropka "1/8  Logowanie do Railwaya"

if $RAILWAY whoami >/dev/null 2>&1; then
  ok "już zalogowany jako $($RAILWAY whoami 2>/dev/null | tail -1)"
else
  printf '  Otworzę przeglądarkę — zatwierdź logowanie i wróć tutaj.\n'
  $RAILWAY login || stop "Logowanie nie przeszło." $RAILWAY login
  ok "zalogowany"
fi

# ── tryb awaryjny: wyłączenie mostu odpowiedzi ────────────────────────────────
#
# Czyści OBA tokeny mostu (połowiczna konfiguracja to odmowa startu procesu,
# więc czyszczenie jednego byłoby gorsze niż żadnego), weryfikuje wyczyszczenie
# odczytem stanu Railway, restartuje BIEŻĄCE wdrożenie bez budowania kodu
# i potwierdza wynik w /health. Idempotentny: puste tokeny to sukces.
if [ "$DISABLE_REPLY_ONLY" = "1" ]; then
  kropka "Wyłączenie mostu odpowiedzi (tryb awaryjny)"

  REMOTE_JSON="$(railway_variable_list_json 2>/dev/null)" || stop "Nie można odczytać stanu zmiennych Railway."
  STAN="$(printf '%s' "$REMOTE_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const remote = JSON.parse(raw);
        const names = ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_REPLY_TOKEN"];
        const values = names.map((name) => String(remote[name] ?? "").trim());
        process.stdout.write(values.every((value) => value === "") ? "puste" : "obecne");
      } catch {
        process.exit(1);
      }
    });
  ' 2>/dev/null)" || { unset REMOTE_JSON; stop "Nie można zinterpretować stanu zmiennych Railway."; }
  unset REMOTE_JSON

  if [ "$STAN" = "obecne" ]; then
    for KLUCZ in CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN; do
      if ! printf '' | railway_variable_set_stdin "$KLUCZ" >/tmp/bht-out 2>&1; then
        zle "KRYTYCZNE: nie udało się wyczyścić $KLUCZ — most może pozostać AKTYWNY."
        printf '\n  Co powiedziało CLI:\n\n'
        sed 's/^/    /' /tmp/bht-out
        exit 1
      fi
    done
    # Wyłącznik bez dowodu nie jest wyłącznikiem: czytamy stan ponownie.
    VERIFY_JSON="$(railway_variable_list_json 2>/dev/null)" || stop "Nie można potwierdzić wyczyszczenia tokenów."
    if ! printf '%s' "$VERIFY_JSON" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        try {
          const remote = JSON.parse(raw);
          const names = ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_REPLY_TOKEN"];
          if (!names.every((name) => String(remote[name] ?? "").trim() === "")) process.exit(1);
        } catch {
          process.exit(1);
        }
      });
    ' 2>/dev/null; then
      unset VERIFY_JSON
      zle "KRYTYCZNE: tokeny mostu nadal obecne po czyszczeniu; wysyłka pozostaje AKTYWNA."
      exit 1
    fi
    unset VERIFY_JSON
    ok "oba tokeny mostu wyczyszczone i potwierdzone odczytem stanu"
  else
    ok "oba tokeny mostu już są puste (idempotentnie: nic do czyszczenia)"
  fi

  # Restart BIEŻĄCEGO wdrożenia. Celowo NIE `railway up`: up budowałby i wysyłał
  # kod z lokalnego HEAD, a wyłącznik ma zdjąć tokeny z tego, co JUŻ działa.
  if ! zservice redeploy --yes; then
    zle "Tokeny wyczyszczone, ale restart usługi się nie powiódł."
    zle "Most pozostaje AKTYWNY do restartu — zrestartuj usługę w panelu Railway."
    printf '\n  Co powiedziało CLI:\n\n'
    sed 's/^/    /' /tmp/bht-out
    printf '\n  Pomoc komendy:\n\n'
    $RAILWAY redeploy --help 2>&1 | sed 's/^/    /'
    exit 1
  fi
  ok "restart bieżącego wdrożenia zlecony (bez budowania nowego obrazu)"

  zservice domain >/dev/null 2>&1 || true
  ADRES="$(grep -oE '[a-z0-9.-]+\.up\.railway\.app' /tmp/bht-out 2>/dev/null | head -1 || true)"
  if [ -z "$ADRES" ]; then
    zle "Nie udało się ustalić adresu /health — potwierdź RĘCZNIE, że customerCaseReplyBridge=false."
    exit 1
  fi
  PROBY="${BHT_COPILOT_HEALTH_PROBY:-24}"
  N=0
  while [ "$N" -lt "$PROBY" ]; do
    N=$((N + 1))
    if curl -fsS --max-time 8 "https://$ADRES/health" 2>/dev/null | grep -q '"customerCaseReplyBridge":false'; then
      ok "/health potwierdza: customerCaseReplyBridge=false"
      printf '\n  Most odpowiedzi jest WYŁĄCZONY.\n'
      exit 0
    fi
    # Przerwa wylacznie MIEDZY probami; po ostatniej nie ma na co czekac.
    if [ "$N" -lt "$PROBY" ]; then sleep 5; fi
  done
  zle "/health po restarcie nadal NIE melduje customerCaseReplyBridge=false."
  zle "Most może pozostawać AKTYWNY — sprawdź usługę w panelu Railway."
  exit 1
fi

# ── 2. token dla Claude ───────────────────────────────────────────────────────
kropka "2/8  Token, którym Claude wchodzi do danych"

# Generujemy po naszej stronie i NIE wypisujemy. Właściciel nie musi go widzieć
# ani kopiować — to eliminuje jedyny moment, w którym sekret trafiał na ekran.
if grep -q '^MCP_BEARER_TOKEN=.\{32,\}' "$ENV_FILE" 2>/dev/null; then
  ok "token już jest w .env (nie generuję nowego, żeby nie odciąć podłączonych klientów)"
else
  [ "$ENV_EXTERNAL" = "1" ] && stop "Brak bezpiecznego MCP_BEARER_TOKEN w zewnętrznym env; ten tryb nigdy nie modyfikuje pliku źródłowego."
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
  [ "$ENV_EXTERNAL" = "1" ] && stop "Brak COPILOT_AUTH_PASSWORD w zewnętrznym env; ten tryb nigdy nie modyfikuje pliku źródłowego."
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

# ── 2c. klucze powiadomień ────────────────────────────────────────────────────
kropka "2c/8  Klucze powiadomien (VAPID)"

# Generuje tylko wtedy, gdy ich nie ma: rotacja unieważniłaby subskrypcje
# i właściciel musiałby włączać powiadomienia od nowa na każdym urządzeniu.
if [ "$ENV_EXTERNAL" = "1" ]; then
  for VAPID_KEY in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
    grep -q "^${VAPID_KEY}=." "$ENV_FILE" || stop "Brak $VAPID_KEY w zewnętrznym env; ten tryb nigdy nie modyfikuje pliku źródłowego."
  done
  ok "klucze VAPID są obecne w zewnętrznym env (wartości ukryte; istniejący subject pozostaje bez zmian)"
elif VAPID_WYNIK="$(node scripts/generuj-vapid.mjs 2>&1)"; then
  ok "$VAPID_WYNIK"
else
  zle "Nie udało się przygotować kluczy VAPID."
  printf '%s\n' "$VAPID_WYNIK" | sed 's/^/    /'
  printf '  Powiadomienia będą wyłączone; reszta serwera działa normalnie.\n'
fi
unset VAPID_WYNIK

# ── 3. projekt ────────────────────────────────────────────────────────────────
kropka "3/8  Projekt w Railwayu"

if [ "$PRODUCTION_MODE" = "1" ]; then
  ok "produkcyjny projekt został zweryfikowany fail-closed w preflight"
elif $RAILWAY status >/dev/null 2>&1; then
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
if [ "$PRODUCTION_MODE" = "1" ]; then
  ok "produkcyjna usługa $SERVICE została zweryfikowana fail-closed w preflight"
elif $RAILWAY status 2>/dev/null | grep -q "$SERVICE"; then
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
if [ "$PRODUCTION_MODE" = "1" ]; then
  STATUS_JSON="$($RAILWAY status "${PRODUCTION_TARGET_ARGS[@]}" --json 2>/dev/null)" || stop "Nie można potwierdzić produkcyjnego wolumenu."
  if ! printf '%s' "$STATUS_JSON" | EXPECTED_ENVIRONMENT_ID="$EXPECTED_ENVIRONMENT_ID" EXPECTED_SERVICE_ID="$EXPECTED_SERVICE_ID" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const value = JSON.parse(raw);
        const environment = value.environments?.edges?.find(
          (edge) => edge.node?.id === process.env.EXPECTED_ENVIRONMENT_ID,
        )?.node;
        const volume = environment?.volumeInstances?.edges?.find(
          (edge) => edge.node?.serviceId === process.env.EXPECTED_SERVICE_ID && edge.node?.mountPath === "/data" && edge.node?.state === "READY",
        )?.node;
        if (!volume || volume.sizeMB < 5000) process.exit(1);
      } catch {
        process.exit(1);
      }
    });
  '; then
    unset STATUS_JSON
    stop "Brak jednoznacznie gotowego produkcyjnego wolumenu /data (minimum 5000 MB)."
  fi
  unset STATUS_JSON
  ok "produkcyjny wolumen /data jest READY"
elif $RAILWAY volume list 2>/dev/null | grep -qi "$MOUNT\|volume"; then
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
  MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
  COPILOT_AUTH_PASSWORD
  VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT
  MAIL_IMAP_HOST MAIL_IMAP_PORT MAIL_IMAP_USER MAIL_IMAP_PASSWORD
  MAIL_FOLDER MAIL_SENT_FOLDER MAIL_THREAD_FOLDERS
  TEABREW_BASE_URL TEABREW_AI_OPERATOR_TOKEN
  CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN
  MARKETING_PLANNER_BASE_URL MARKETING_PLANNER_TOKEN
  BUDZECIK_BASE_URL BUDZECIK_COPILOT_TOKEN
  CONNECTEAM_API_KEY CONNECTEAM_WEBHOOK_SECRET
)
if [ "$CONFIGURE_REPLY_ONLY" = "1" ]; then
  POTRZEBNE=(CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN)
  ok "wąski tryb aktywacji: setter dotknie wyłącznie 2 tokenów odpowiedzi Allegro"
fi

BRAK=()
DO_USTAWIENIA=()
for KLUCZ in "${POTRZEBNE[@]}"; do
  LINIA="$(grep -m1 "^${KLUCZ}=" "$ENV_FILE" 2>/dev/null || true)"
  WARTOSC="${LINIA#*=}"
  if [ -n "$LINIA" ] && [ -n "$WARTOSC" ]; then
    DO_USTAWIENIA+=("$KLUCZ")
    ok "$KLUCZ"                       # nazwa, NIGDY wartość
  else
    BRAK+=("$KLUCZ")
  fi
done

# MODE=live i monitor są stałymi wdrożenia, nie sekretami z .env.
ok "MODE=live, monitor w procesie"

if [ ${#BRAK[@]} -gt 0 ]; then
  printf '  · pominięte (nie ma ich w .env): %s\n' "${BRAK[*]}"
fi

for KONIECZNE in MAIL_IMAP_HOST MAIL_IMAP_USER MAIL_IMAP_PASSWORD TEABREW_BASE_URL TEABREW_AI_OPERATOR_TOKEN COPILOT_AUTH_PASSWORD; do
  grep -q "^${KONIECZNE}=." "$ENV_FILE" || stop "Brak $KONIECZNE w .env — bez tego serwer nie połączy się ze źródłami."
done

# Bridge odpowiedzi jest opcjonalny, ale konfiguracja połowiczna nie jest.
# Nie generujemy tych sekretów automatycznie: ich wartości trzeba skoordynować
# odpowiednio z firmowym czatem i TeaBrew, bez wypisywania ich na ekran.
REPLY_BRIDGE_IN=0
REPLY_BRIDGE_OUT=0
grep -q '^CUSTOMER_CASE_REPLY_BRIDGE_TOKEN=.' "$ENV_FILE" && REPLY_BRIDGE_IN=1
grep -q '^TEABREW_AI_OPERATOR_REPLY_TOKEN=.' "$ENV_FILE" && REPLY_BRIDGE_OUT=1
if [ "$REPLY_BRIDGE_IN" -ne "$REPLY_BRIDGE_OUT" ]; then
  stop "Bridge odpowiedzi wymaga razem CUSTOMER_CASE_REPLY_BRIDGE_TOKEN i TEABREW_AI_OPERATOR_REPLY_TOKEN."
fi

# Każda wartość idzie przez stdin, nigdy przez argv ani telemetry CLI. Wszystkie
# zmiany są staged bez restartu; dopiero `railway up` poniżej uruchamia jeden
# kontener z kompletnym zestawem. Błąd dowolnego settera zatrzymuje deploy.
export RAILWAY_NO_TELEMETRY=1
REPLY_REMOTE_STATE="not_checked"
if [ "$CONFIGURE_REPLY_ONLY" = "1" ]; then
  [ ${#BRAK[@]} -eq 0 ] || stop "Wąski tryb wymaga obu lokalnych tokenów odpowiedzi."
  REMOTE_VARIABLES_JSON="$(railway_variable_list_json 2>/dev/null)" || stop "Nie można bezpiecznie odczytać stanu tokenów Railway."
  REPLY_REMOTE_STATE="$(printf '%s' "$REMOTE_VARIABLES_JSON" | REPLY_ENV_FILE="$ENV_FILE" node -e '
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const remote = JSON.parse(raw);
        const local = parseEnv(readFileSync(process.env.REPLY_ENV_FILE, "utf8"));
        const names = ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_REPLY_TOKEN"];
        const remoteValues = names.map((name) => String(remote[name] ?? "").trim());
        const localValues = names.map((name) => String(local[name] ?? "").trim());
        if (remoteValues.every((value) => value === "")) process.stdout.write("absent");
        else if (remoteValues.every((value, index) => value === localValues[index])) process.stdout.write("match");
        else process.exit(2);
      } catch {
        process.exit(1);
      }
    });
  ' 2>/dev/null)" || {
    unset REMOTE_VARIABLES_JSON
    stop "Istniejące tokeny Railway są częściowe albo różnią się od bezpiecznego źródła; odmowa nadpisania."
  }
  unset REMOTE_VARIABLES_JSON
  if [ "$REPLY_REMOTE_STATE" = "match" ]; then
    DO_USTAWIENIA=()
    ok "oba tokeny Railway już odpowiadają źródłu; setter pozostaje idempotentny"
  elif [ "$REPLY_REMOTE_STATE" = "absent" ]; then
    ok "oba tokeny Railway są nieobecne; przygotowuję pierwsze ustawienie"
  else
    stop "Nieznany wynik preflightu tokenów Railway."
  fi
fi

for KLUCZ in "${DO_USTAWIENIA[@]}"; do
  LINIA="$(grep -m1 "^${KLUCZ}=" "$ENV_FILE" 2>/dev/null || true)"
  WARTOSC="${LINIA#*=}"
  if ! printf '%s' "$WARTOSC" | railway_variable_set_stdin "$KLUCZ" >/tmp/bht-out 2>&1; then
    unset WARTOSC LINIA
    if [ "$CONFIGURE_REPLY_ONLY" = "1" ]; then
      ROLLBACK_OK=1
      for COFNIJ in CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN; do
        printf '' | railway_variable_set_stdin "$COFNIJ" >/dev/null 2>&1 || ROLLBACK_OK=0
      done
      VERIFY_ROLLBACK_JSON="$(railway_variable_list_json 2>/dev/null)" || ROLLBACK_OK=0
      if [ "$ROLLBACK_OK" = "1" ]; then
        if ! printf '%s' "$VERIFY_ROLLBACK_JSON" | node -e '
          let raw = "";
          process.stdin.on("data", (c) => (raw += c)).on("end", () => {
            try {
              const value = JSON.parse(raw);
              const names = ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", "TEABREW_AI_OPERATOR_REPLY_TOKEN"];
              if (!names.every((name) => String(value[name] ?? "").trim() === "")) process.exit(1);
            } catch { process.exit(1); }
          });
        ' >/dev/null 2>&1; then
          ROLLBACK_OK=0
        fi
      fi
      unset VERIFY_ROLLBACK_JSON
      if [ "$ROLLBACK_OK" != "1" ]; then
        zle "KRYTYCZNE: nie potwierdzono wyzerowania obu staged tokenów; nie uruchamiaj kolejnego deployu przed ręczną korektą."
      fi
    fi
    zle "Nie udało się bezpiecznie ustawić $KLUCZ."
    printf '\n  Co powiedziało CLI (wartość nie była w argv):\n\n'
    sed 's/^/    /' /tmp/bht-out
    exit 1
  fi
  unset WARTOSC LINIA
done
if [ "$CONFIGURE_REPLY_ONLY" != "1" ]; then
  for PARA in "MODE=live" "MONITOR_IN_PROCESS=1"; do
    KLUCZ="${PARA%%=*}"
    WARTOSC="${PARA#*=}"
    if ! printf '%s' "$WARTOSC" | railway_variable_set_stdin "$KLUCZ" >/tmp/bht-out 2>&1; then
      unset WARTOSC
      stop "Nie udało się ustawić stałej wdrożenia $KLUCZ."
    fi
    unset WARTOSC
  done
fi
ok "zmienne staged przez stdin (wartości nie trafiły do argv ani logów)"

# ── 6. wdrożenie ──────────────────────────────────────────────────────────────
kropka "6/8  Wdrożenie"

# Adres i „kto teraz odpowiada" ustalamy PRZED wysłaniem. Bez tego jedynym
# sprawdzeniem po wdrożeniu było „czy /health odpowiada" — a odpowiadał także
# stary kontener, więc wdrożenie starego kodu meldowało sukces.
zservice domain >/dev/null 2>&1 || true
ADRES="$(grep -oE '[a-z0-9.-]+\.up\.railway\.app' /tmp/bht-out 2>/dev/null | head -1 || true)"
PRZED=""
if [ -n "$ADRES" ]; then
  PRZED="$(curl -fsS --max-time 8 "https://$ADRES/health" 2>/dev/null | grep -oE '"startedAt":"[^"]*"' || true)"
fi

# Znacznik wersji WJEŻDŻA DO OBRAZU razem ze źródłami.
#
# Bez niego „nowa wersja odpowiedziała" znaczyło tylko „odpowiedział nowy
# PROCES" — a ustawienie zmiennych środowiskowych restartuje kontener ze starym
# obrazem. Wdrożenie meldowało wtedy sukces po piętnastu sekundach, choć
# budowanie obrazu tyle nie trwa. Stary kontener nie może udawać nowego, jeżeli
# rozpoznajemy go po KODZIE, a nie po czasie startu.
#
# Plik NIE jest w .gitignore i nie może tam trafić: `railway up` pomija
# wszystko, co pasuje do .gitignore, więc wpisanie go tam znaczyło dokładnie
# „nie wysyłaj znacznika" — a skrypt czekał potem dziewięć minut na plik,
# którego sam nie wysłał. Kasujemy go po wyjściu, żeby nie zaśmiecał repozytorium.
WERSJA="$(git rev-parse --short HEAD 2>/dev/null || echo 'bez-gita')"
printf '{"commit":"%s"}\n' "$WERSJA" > src/wersja.json
trap 'rm -f src/wersja.json' EXIT
ok "znacznik wersji: $WERSJA"

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

if [ -z "$ADRES" ]; then
  zle "Nie odczytałem adresu z CLI."
  printf '\n  Wygeneruj go w panelu: Settings → Networking → Generate Domain,\n'
  printf '  potem sprawdź w przeglądarce: https://TWOJ-ADRES/health\n'
  exit 1
fi
ok "https://$ADRES"

# Zapisujemy adres lokalnie, żeby `npm run push:test` nie wymagał od właściciela
# wklejania go za każdym razem. To nie jest sekret — trafia do .env wyłącznie
# dlatego, że tam już mieszka reszta konfiguracji tej instalacji.
if [ "$ENV_EXTERNAL" = "1" ]; then
  ok "zewnętrzny env pozostaje tylko do odczytu; COPILOT_PUBLIC_URL nie jest modyfikowany"
elif ! grep -q "^COPILOT_PUBLIC_URL=https://$ADRES$" "$ENV_FILE" 2>/dev/null; then
  grep -v '^COPILOT_PUBLIC_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  printf 'COPILOT_PUBLIC_URL=https://%s\n' "$ADRES" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Czekamy na ZMIANĘ `startedAt`, nie na samą odpowiedź. Odpowiedź daje też stary
# kontener, który jeszcze nie zszedł — i właśnie na tym raz się przejechaliśmy.
# Ile realnie trwa wdrożenie, nie wiedzieliśmy: poprzednie sprawdzenie zaliczała
# natychmiast odpowiedź STAREGO kontenera, więc nigdy go nie zmierzyliśmy.
# W obrazie jest `npm ci` plus doinstalowanie tsx i typescript, potem wypchnięcie
# warstw i start — dziewięć minut to zapas, a nie oczekiwana wartość. Licznik
# minut jest po to, żeby ta wartość przestała być zgadywana.
CZEKAM_MINUT=9
printf '  Czekam, aż wstanie NOWY kontener (do %s minut):\n  ' "$CZEKAM_MINUT"
ZDROWY=0
PROBY=$((CZEKAM_MINUT * 12))
for I in $(seq 1 "$PROBY"); do
  ODP="$(curl -fsS --max-time 8 "https://$ADRES/health" 2>/dev/null || true)"
  TERAZ="$(printf '%s' "$ODP" | grep -oE '"startedAt":"[^"]*"' || true)"
  # Dwa warunki naraz i oba są konieczne: właściwy KOD (znacznik z obrazu)
  # oraz nowy PROCES. Sam znacznik nie wystarczy przy ponownym wdrożeniu tego
  # samego commita, sam czas startu — przy restarcie po zmianie zmiennych.
  if printf '%s' "$ODP" | grep -q "\"commit\":\"$WERSJA\"" &&
     printf '%s' "$ODP" | grep -q '"ok":true' && [ -n "$TERAZ" ] && [ "$TERAZ" != "$PRZED" ]; then
    ZDROWY=1
    NARZEDZIA="$(printf '%s' "$ODP" | grep -oE '"tools":[0-9]+' | cut -d: -f2)"
    OAUTH="$(printf '%s' "$ODP" | grep -oE '"oauth":(true|false)' | cut -d: -f2)"
    printf '\n  (nowa wersja odpowiedziała po ~%s s)\n' "$((I * 5))"
    break
  fi
  # Znak po każdej próbie: bez niego kilka minut ciszy wygląda jak zawieszenie
  # i człowiek przerywa skrypt w połowie budowania obrazu.
  if [ $((I % 12)) -eq 0 ]; then printf '%sm' "$((I / 12))"; else printf '.'; fi
  sleep 5
done

if [ "$ZDROWY" -ne 1 ]; then
  printf '\n'
  zle "Nowa wersja nie odpowiedziała na /health w ciągu $CZEKAM_MINUT minut."
  printf '\n  Stary serwer mógł dalej działać — to NIE znaczy, że wdrożenie przeszło.\n'
  printf '  Zajrzyj w Build Logs (adres wypisany wyżej przy „wysłane"): tam widać,\n'
  printf '  czy obraz się zbudował.\n\n'
  printf '  Ostatnie logi (bez treści maili i bez tokenów):\n\n'
  zservice logs >/dev/null 2>&1 || true
  tail -30 /tmp/bht-out | sed 's/^/    /'
  printf '\n  Wklej mi te linie — powiedzą, czego brakuje.\n'
  exit 1
fi

if [ "${OAUTH:-}" != "true" ]; then
  zle "Serwer wstał, ale OAuth jest WYŁĄCZONY — konektor w Claude się nie połączy."
  printf '  Znaczy to, że COPILOT_AUTH_PASSWORD nie dojechało do usługi.\n'
  exit 1
fi

PUSH_STAN="$(printf '%s' "$ODP" | grep -oE '"push":(true|false)' | cut -d: -f2)"
if [ "${PUSH_STAN:-}" != "true" ]; then
  zle "Serwer wstał, ale POWIADOMIENIA są wyłączone (brak kluczy VAPID na usłudze)."
  printf '  Test pusha nie ruszy. Reszta produktu działa normalnie.\n'
  exit 1
fi

REPLY_STAN="$(printf '%s' "$ODP" | grep -oE '"customerCaseReplyBridge":(true|false)' | cut -d: -f2)"
if [ "$REPLY_BRIDGE_IN" = "1" ] && [ "${REPLY_STAN:-}" != "true" ]; then
  zle "Serwer wstał, ale bridge odpowiedzi Allegro nie potwierdził gotowości."
  printf '  Sprawdź nazwy obu tokenów bridge\047a w Railway (bez wypisywania wartości).\n'
  exit 1
fi
if [ "$REPLY_BRIDGE_IN" = "0" ] && [ "${REPLY_STAN:-}" = "true" ]; then
  zle "Bridge odpowiedzi nadal jest włączony przez stare zmienne Railway."
  printf '  Usuń obie zmienne bridge\047a z usługi albo dopisz obie do lokalnego .env.\n'
  exit 1
fi
ok "nowa wersja stoi ($WERSJA), OAuth i powiadomienia włączone"
if [ "$REPLY_BRIDGE_IN" = "1" ]; then
  ok "bridge odpowiedzi Allegro gotowy (osobne tokeny, wymagane potwierdzenie człowieka)"
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
  Stan spraw: $([ "$BEZ_WOLUMENU" = "1" ] && printf 'w kontenerze (bez wolumenu)' || printf 'trwały wolumen %s' "$MOUNT")
  Poczta i narzędzia MCP: read-only, jak dotychczas
  Odpowiedzi Allegro: $([ "$REPLY_BRIDGE_IN" = "1" ] && printf 'bridge serwisowy po potwierdzeniu człowieka' || printf 'wyłączone')

  ZOSTAŁA JEDNA RZECZ, KTÓREJ ŻADEN SKRYPT NIE ZROBI.

  W aplikacji Claude: Ustawienia → Konektory → Dodaj własny konektor
    nazwa:  BHT Copilot
    adres:  https://$ADRES/mcp

  Pola OAuth Client ID i Secret ZOSTAW PUSTE — serwer rejestruje klienta sam.

  Po kliknięciu „Add" Claude otworzy stronę zgody i poprosi o hasło.
  To jest to hasło, które wypisałem wyżej (albo masz je w .env pod
  COPILOT_AUTH_PASSWORD).

  POWIADOMIENIA NA IPHONE — jednorazowo, w Safari na telefonie:

    https://$ADRES/push

    1. Udostępnij → Dodaj do ekranu początkowego.
    2. Otwórz NOWĄ ikonę (nie kartę Safari — ta nigdy nie dostanie pusha).
    3. Wpisz hasło, naciśnij „Włącz powiadomienia", zezwól.

  Potem test wysyłasz stąd, z Maca:

    npm run push:test
PODSUMOWANIE
