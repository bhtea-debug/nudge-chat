#!/usr/bin/env bash
#
# Uruchomienie inbox-operatora na prawdziwych danych — na TWOJEJ maszynie.
#
#   cd ai-operator && bash scripts/live-setup.sh
#
# Podanie wartości od nowa (np. po wpisaniu złego hasła):
#
#   bash scripts/live-setup.sh --reset MAIL_IMAP_PASSWORD
#   bash scripts/live-setup.sh --reset MAIL_IMAP_PASSWORD,ANTHROPIC_API_KEY
#
# Skrypt istnieje z jednego powodu: MODE=live wymaga dostępu sieciowego do
# serwera poczty i do wdrożenia Convex, a sekrety mają zostać na Twoim
# komputerze. Środowiska agentowe w chmurze nie mają ani jednego, ani drugiego.
#
# Co robi:
#   1. sprawdza wersję node i instaluje zależności, jeśli trzeba,
#   2. zakłada .env z prawami 600, jeśli go nie ma,
#   3. dopytuje WYŁĄCZNIE o brakujące wartości; sekrety czyta bez echa
#      i zapisuje prosto do .env — nie trafiają na ekran ani do historii shella,
#   4. uruchamia testy bez modelu: typecheck, testy jednostkowe,
#      verify:teabrew, check:mail,
#   5. zatrzymuje się, jeśli cokolwiek nie przejdzie. Modelu NIE uruchamia —
#      to osobna, świadoma komenda.
#
# Nie wypisuje żadnego sekretu. Nie wysyła niczego na zewnątrz poza tym, co
# robią same testy (IMAP read-only i GET-y do TeaBrew).

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ENV_FILE=".env"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
info() { printf "  %s\n" "$1"; }

fail() {
  printf "\n\033[31mSTOP.\033[0m %s\n" "$1"
  exit 1
}

# ── 1. node i zależności ──────────────────────────────────────────────────────

bold "1. Środowisko"

command -v node >/dev/null 2>&1 || fail "Nie ma node. Zainstaluj Node 22 lub nowszy."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node $NODE_MAJOR jest za stary. Potrzebny 22+ (skrypty używają --env-file-if-exists)."
fi
ok "node $(node -v)"

if [ ! -d node_modules ]; then
  info "instaluję zależności…"
  npm install --silent || fail "npm install nie przeszedł."
fi
ok "zależności zainstalowane"

# ── 2. .env ───────────────────────────────────────────────────────────────────

bold "2. Konfiguracja"

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE" || fail "Nie udało się utworzyć $ENV_FILE."
  info "utworzono $ENV_FILE z .env.example"
fi
chmod 600 "$ENV_FILE"
ok "$ENV_FILE istnieje, prawa 600"

# Czyta wartość z .env, ignorując linie zakomentowane.
env_get() {
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

# Ustawia wartość: podmienia istniejącą linię (także zakomentowaną) albo dopisuje.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  # Usuwamy każde wystąpienie klucza, zakomentowane też, żeby nie zostawić
  # dwóch definicji, z których wygrywa nie ta, którą właśnie ustawiono.
  grep -vE "^#? *${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Dopytuje o wartość JAWNĄ (host, login) — pokazywana na ekranie, to nie sekret.
ask_plain() {
  local key="$1" prompt="$2" current answer
  current="$(env_get "$key")"
  if [ -n "$current" ]; then
    ok "$key = $current"
    return
  fi
  printf "  %s: " "$prompt"
  read -r answer
  [ -n "$answer" ] || fail "$key jest wymagane."
  env_set "$key" "$answer"
  ok "$key ustawione"
}

# Dopytuje o SEKRET — bez echa, bez wypisywania, bez historii.
ask_secret() {
  local key="$1" prompt="$2" current answer
  current="$(env_get "$key")"
  if [ -n "$current" ]; then
    ok "$key już ustawione (wartości nie pokazuję)"
    return
  fi
  printf "  %s\n  (wpisywanie jest niewidoczne, Enter zatwierdza): " "$prompt"
  read -rs answer
  printf "\n"
  [ -n "$answer" ] || fail "$key jest wymagane."
  env_set "$key" "$answer"
  ok "$key zapisane do $ENV_FILE (nie pokazuję wartości)"
}

# ── 2a. --reset: wyczyść wskazane wartości, żeby skrypt zapytał o nie ponownie ──
#
# Bez tego jedyną drogą do zmiany raz wpisanego sekretu byłaby ręczna edycja
# .env — czyli otwarcie pliku z hasłami w edytorze, żeby poprawić literówkę.

if [ "${1:-}" = "--reset" ]; then
  RESET_KEYS="${2:-}"
  [ -n "$RESET_KEYS" ] || fail "--reset wymaga nazwy zmiennej, np. --reset MAIL_IMAP_PASSWORD"
  for key in $(printf '%s' "$RESET_KEYS" | tr ',' ' '); do
    if [ -n "$(env_get "$key")" ]; then
      tmp="$(mktemp)"
      grep -vE "^#? *${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
      mv "$tmp" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      info "wyczyszczono $key — zapytam o nią ponownie"
    else
      info "$key nie było ustawione, nic do czyszczenia"
    fi
  done
elif [ -n "${1:-}" ]; then
  fail "Nieznany argument: $1. Dozwolone: --reset KLUCZ[,KLUCZ...]"
fi

env_set MODE live
ok "MODE = live"

ask_plain  MAIL_IMAP_HOST            "Host IMAP"
ask_plain  MAIL_IMAP_PORT            "Port IMAP (993 dla SSL/TLS)"
ask_plain  MAIL_IMAP_USER            "Login IMAP (pełny adres e-mail)"
ask_secret MAIL_IMAP_PASSWORD        "Hasło aplikacji do skrzynki"

# auto = folder wysłanych wykrywany po atrybucie IMAP SPECIAL-USE \Sent.
# Nazwy nie zgadujemy — bez tego folderu agent nie widzi naszych odpowiedzi.
if [ -z "$(env_get MAIL_THREAD_FOLDERS)" ]; then
  env_set MAIL_THREAD_FOLDERS auto
fi
ok "MAIL_THREAD_FOLDERS = $(env_get MAIL_THREAD_FOLDERS)"

ask_plain  TEABREW_BASE_URL          "Baza HTTP actions Convex (bez ukośnika na końcu)"
ask_secret TEABREW_AI_OPERATOR_TOKEN "Token agenta — ta sama wartość co AI_OPERATOR_API_TOKEN w Convex"
ask_secret ANTHROPIC_API_KEY         "Klucz API Anthropic"

if [ -z "$(env_get AUDIT_FILE)" ]; then
  env_set AUDIT_FILE "./.audit/calls.jsonl"
fi
ok "AUDIT_FILE = $(env_get AUDIT_FILE)"

# ── 3. testy bez modelu ───────────────────────────────────────────────────────

bold "3. Testy bez modelu"
info "Model NIE jest tu wołany. Jeśli coś nie przejdzie, przyczyna jest po"
info "stronie danych albo konfiguracji — model tego nie naprawi, tylko przykryje."
printf "\n"

npm run typecheck --silent || fail "typecheck nie przeszedł."
ok "typecheck"

npm test --silent >/dev/null 2>&1 || fail "testy jednostkowe nie przeszły. Uruchom 'npm test' i zobacz co."
ok "testy jednostkowe (56)"

printf "\n"
bold "3a. TeaBrew — 17 sprawdzeń wdrożonej łatki"
if ! npm run verify:teabrew --silent; then
  fail "verify:teabrew nie przeszedł w całości. Nie uruchamiaj modelu — najpierw przyczyna."
fi

printf "\n"
bold "3b. Poczta — 11 sprawdzeń, na prawdziwej skrzynce"
if ! npm run check:mail --silent; then
  fail "check:mail nie przeszedł w całości. Zwróć uwagę na sprawdzenie 1b: jeśli serwer nie wskazał \\Sent, wpisz właściwą nazwę folderu w MAIL_THREAD_FOLDERS i uruchom ponownie."
fi

# ── 4. co dalej ───────────────────────────────────────────────────────────────

printf "\n"
bold "Gotowe. Poczta i TeaBrew przeszły wszystkie sprawdzenia bez modelu."
printf "\n"
info "Teraz możesz uruchomić model:"
printf "\n"
printf "    npm run triage\n"
printf "    npm run ask -- --trace \"Co ważnego przyszło dzisiaj?\"\n"
printf "\n"
info "MODE=live jest już w .env, więc nie musisz go podawać przy komendach."
info "Kod wyjścia 3 z 'ask' znaczy, że kontrola dowodów coś zgłosiła —"
info "to nie błąd programu, to sygnał do sprawdzenia odpowiedzi."
printf "\n"
