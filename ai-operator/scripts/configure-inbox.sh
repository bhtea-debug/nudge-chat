#!/usr/bin/env bash
set -uo pipefail

# Kontrola konfiguracji kanału „Obsługa klienta” na Railwayu.
#
# Trzy tryby, bo wymagania są różne na różnych etapach i wspólna lista
# „wszystko musi być" blokowałaby podgląd, który z założenia jest bezpieczny:
#
#   inbound-preview  — kanał czyta tylko po to, żeby POLICZYĆ wiadomości.
#                      Nie wymaga Resend ani tokenów Meta.
#   inbound-live     — import i bieżąca synchronizacja. Wymaga kompletu źródeł.
#   outbound-live    — wysyłka. Wymaga dodatkowo Resend i rozdzielnych tokenów.
#
# Tryby przychodzące most odpowiedzi ODRZUCAJĄ, a nie tylko pomijają: most
# włącza się samą obecnością CUSTOMER_CASE_REPLY_BRIDGE_TOKEN, więc „podgląd"
# z ustawioną tą zmienną to podgląd z czynną ścieżką pisania do klientów.
#
# Wymagania są przepisane z walidacji wykonywanej przy starcie procesu
# (src/bin/mcp-http.ts oraz src/config.ts). Trzymanie ich osobno okazało się
# złudzeniem: bramka mówiła „kompletna", a proces kończył się kodem 1, zanim
# przeczytał pierwszą wiadomość. Każda zmiana tam wymaga zmiany tutaj.
#
# ── CZEGO TEN SKRYPT NIE ROBI ─────────────────────────────────────────────────
# Nie wypisuje ŻADNEJ wartości sekretu — ani na stdout, ani w komunikacie błędu.
# Sprawdza wyłącznie OBECNOŚĆ i kształt. Nie ustawia zmiennych, nie wdraża,
# nie dotyka Meta ani Resend.
#
# ── UCZCIWE OSTRZEŻENIE ───────────────────────────────────────────────────────
# Nie uruchamiałem tego na prawdziwym projekcie Railway — nie mam dostępu do
# konta. Składnia sprawdzona `bash -n`. Każdy krok zatrzymuje się przy pierwszym
# błędzie zamiast brnąć dalej.

cd "$(dirname "$0")/.." || exit 1

MODE="${1:-inbound-preview}"
SERVICE="bht-copilot"
EXPECTED_PROJECT_ID="bd311917-f3d7-419f-aeba-79bf5b4dafe4"
EXPECTED_ENVIRONMENT_ID="e8e60c09-4de2-4fb3-a11d-6e9048371e54"
EXPECTED_SERVICE_ID="c4a9c0ad-7c0e-4494-a16e-321e0e382b6c"
REQUIRED_MOUNT="/data"
REQUIRED_MAILBOXES="sklep biuro hurt"
# Ta sama stała co MIN_TOKEN_LENGTH w src/bin/mcp-http.ts. Krótszy token nie
# jest sekretem, tylko hasłem do zgadnięcia, i proces przy takim nie wstaje.
MIN_TOKEN_LENGTH=32

case "$MODE" in
  inbound-preview|inbound-live|outbound-live) ;;
  *)
    printf 'Użycie: %s [inbound-preview|inbound-live|outbound-live]\n' "$0" >&2
    exit 1
    ;;
esac

fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m  OK\033[0m  %s\n' "$1"; }
warn() { printf '\033[33m  !\033[0m   %s\n' "$1"; }

printf '\033[1mTryb: %s\033[0m\n\n' "$MODE"

# ── 1. Właściwy projekt, środowisko i USŁUGA ─────────────────────────────────
# `railway link` zapamiętuje ostatni wybór, a ten bywa z zupełnie innej pracy.
# Bez kontroli service ID skrypt potrafi skonfigurować sąsiednią usługę w tym
# samym projekcie — czyli dokładnie to, przed czym ma chronić.

command -v railway >/dev/null 2>&1 || fail "Brak Railway CLI. Zainstaluj je i zaloguj się przed konfiguracją."
command -v node >/dev/null 2>&1 || fail "Brak node — skrypt używa go do odczytu JSON."

# Cel podajemy JAWNIE po identyfikatorach, nie przez `railway link`: link
# pamięta ostatni wybór z zupełnie innej pracy, a bramka kontrolna nie ma
# prawa zależeć od tego, co kto ostatnio klikał. Ten sam kształt wywołań,
# co w produkcyjnym deploy-railway.sh (sprawdzony na żywym CLI 2026-08-23;
# poprzedni kształt, `environment.id` w statusie bez argumentów, w dzisiejszym
# CLI nie istnieje i bramka pierwszego dnia na produkcji poległa właśnie o to).
STATUS_JSON="$(railway status --project "$EXPECTED_PROJECT_ID" --environment "$EXPECTED_ENVIRONMENT_ID" --json 2>/dev/null)" \
  || fail "Railway CLI nie odpowiada albo nie ma dostępu do projektu. Zaloguj się: railway login"

# Projekt, środowisko production, usługa i trwały wolumen: wszystko z JEDNEGO
# odczytu statusu, w całości po identyfikatorach i nazwach naraz.
printf '%s' "$STATUS_JSON" | EXPECTED_PROJECT_ID="$EXPECTED_PROJECT_ID" EXPECTED_ENVIRONMENT_ID="$EXPECTED_ENVIRONMENT_ID" EXPECTED_SERVICE_ID="$EXPECTED_SERVICE_ID" REQUIRED_MOUNT="$REQUIRED_MOUNT" node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    try {
      const value = JSON.parse(raw);
      if (value.id !== process.env.EXPECTED_PROJECT_ID) process.exit(2);
      const environment = value.environments?.edges?.find(
        (edge) => edge.node?.id === process.env.EXPECTED_ENVIRONMENT_ID && edge.node?.name === "production",
      )?.node;
      if (!environment) process.exit(3);
      const service = environment.serviceInstances?.edges?.find(
        (edge) => edge.node?.serviceId === process.env.EXPECTED_SERVICE_ID && edge.node?.serviceName === "bht-copilot",
      )?.node;
      if (!service) process.exit(4);
      const volume = environment.volumeInstances?.edges?.find(
        (edge) => edge.node?.serviceId === process.env.EXPECTED_SERVICE_ID && edge.node?.mountPath === process.env.REQUIRED_MOUNT && edge.node?.state === "READY",
      )?.node;
      if (!volume) process.exit(5);
    } catch {
      process.exit(1);
    }
  });
'
# Kod wyjścia ŁAPIEMY do zmiennej: po `if ! potok` w bashu $? niesie już
# wynik negacji, a nie potoku, i każda diagnoza spadałaby do gałęzi ogólnej.
WYNIK_STATUSU=$?
if [ "$WYNIK_STATUSU" -ne 0 ]; then
  case "$WYNIK_STATUSU" in
    2) fail "Podłączony projekt to nie BHT Copilot ($EXPECTED_PROJECT_ID)." ;;
    3) fail "Złe środowisko. Oczekiwane: production ($EXPECTED_ENVIRONMENT_ID)" ;;
    4) fail "Usługa $SERVICE ($EXPECTED_SERVICE_ID) nie istnieje w środowisku production." ;;
    5) fail "BRAK gotowego wolumenu pod $REQUIRED_MOUNT. Bez niego kursory startują od zera po każdym wdrożeniu.
Dodaj: railway volume add --service $SERVICE --mount-path $REQUIRED_MOUNT" ;;
    *) fail "Nie udało się zinterpretować statusu Railway." ;;
  esac
fi
ok "projekt zgodny"
ok "środowisko: production"
ok "usługa: $SERVICE"
ok "wolumen trwały pod $REQUIRED_MOUNT"

# ── 3. Zmienne ───────────────────────────────────────────────────────────────
# `variable list --json` zwraca obiekt NAZWA→wartość; spłaszczamy do KV,
# na którym działa reszta bramki. Wartości wieloliniowe nie występują
# w tej konfiguracji (tokeny, hasła, adresy, listy po przecinku).

VARS="$(railway variable list --project "$EXPECTED_PROJECT_ID" --environment "$EXPECTED_ENVIRONMENT_ID" --service "$EXPECTED_SERVICE_ID" --json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    try {
      const data = JSON.parse(raw);
      process.stdout.write(Object.entries(data).map(([k, v]) => `${k}=${String(v ?? "")}`).join("\n"));
    } catch {
      process.exit(1);
    }
  });
')" || fail "Nie udało się odczytać zmiennych usługi $SERVICE."

has_var() { printf '%s' "$VARS" | grep -q "^$1="; }
value_of() { printf '%s' "$VARS" | sed -n "s/^$1=//p" | head -1; }
# Kod traktuje pustą wartość jak brak zmiennej (wszędzie `?.trim() || null`),
# więc bramka też musi — inaczej NAZWA= przechodzi, a proces widzi brak.
has_value() { [ -n "$(value_of "$1")" ]; }

MISSING=()

# Ta sama zmienna potrafi być wymagana z dwóch powodów naraz (np. TEABREW_BASE_URL
# przez MODE=live i przez most odpowiedzi). Lista braków ma ją pokazać raz.
add_missing() {
  local existing
  for existing in ${MISSING+"${MISSING[@]}"}; do
    [ "$existing" = "$1" ] && return 0
  done
  MISSING+=("$1")
}

require_var() { has_value "$1" || add_missing "$1"; }

# Proces odrzuca token krótszy niż MIN_TOKEN_LENGTH, więc sama OBECNOŚĆ nie
# wystarcza. Bramka, która przepuszcza token 13-znakowy, potwierdza
# konfigurację, przy której serwer nie wstaje.
require_token() {
  local value
  if ! has_value "$1"; then
    add_missing "$1"
    return 0
  fi
  value="$(value_of "$1")"
  [ "${#value}" -ge "$MIN_TOKEN_LENGTH" ] \
    || add_missing "$1 (minimum $MIN_TOKEN_LENGTH znaków)"
}

# Token opcjonalny: proces bez niego wstaje, ale z za krótkim — nie. Ustawiony
# po części jest gorszy niż nieustawiony, bo wygląda na zabezpieczenie.
check_token_length() {
  local value
  has_value "$1" || return 0
  value="$(value_of "$1")"
  [ "${#value}" -ge "$MIN_TOKEN_LENGTH" ] \
    || add_missing "$1 (ustawiony, ale krótszy niż $MIN_TOKEN_LENGTH znaków)"
}

# Wspólna wartość dwóch tokenów wygląda jak zabezpieczenie, którym nie jest:
# kto może czytać kolejkę, mógłby wtedy pisać do klientów. Proces wylicza takie
# pary w forbiddenReuse i odmawia startu — komunikat podaje wyłącznie NAZWY.
require_distinct() {
  local left right
  left="$(value_of "$1")"
  right="$(value_of "$2")"
  [ -n "$left" ] && [ -n "$right" ] || return 0
  [ "$left" != "$right" ] \
    || fail "Zmienne $1 i $2 mają IDENTYCZNE wartości. Proces odmawia startu."
}

# Pary „albo obie, albo żadna" — config.ts przerywa start przy jednej połówce.
require_pair() {
  if has_value "$1" && ! has_value "$2"; then add_missing "$2 (wymagane razem z $1)"; fi
  if has_value "$2" && ! has_value "$1"; then add_missing "$1 (wymagane razem z $2)"; fi
}

require_var INBOX_ENABLED
require_var INBOX_STATE_DIR

if has_var INBOX_STATE_DIR; then
  case "$(value_of INBOX_STATE_DIR)" in
    "$REQUIRED_MOUNT"*) ok "INBOX_STATE_DIR wskazuje wolumen trwały" ;;
    *) fail "INBOX_STATE_DIR musi zaczynać się od $REQUIRED_MOUNT, inaczej stan ginie przy deployu." ;;
  esac
fi

# Tryb importu musi zgadzać się z trybem skryptu — inaczej „inbound-live"
# skonfigurowałby kanał, który nadal tylko liczy.
if has_var INBOX_BACKFILL_MODE; then
  BACKFILL_MODE="$(value_of INBOX_BACKFILL_MODE)"
else
  BACKFILL_MODE="preview"
fi
case "$MODE" in
  inbound-preview)
    [ "$BACKFILL_MODE" = "preview" ] \
      || fail "Tryb podglądu wymaga INBOX_BACKFILL_MODE=preview (jest: $BACKFILL_MODE)."
    ok "pierwszy import w trybie podglądu"
    ;;
  inbound-live|outbound-live)
    [ "$BACKFILL_MODE" = "import" ] \
      || fail "Tryb $MODE wymaga INBOX_BACKFILL_MODE=import. Podgląd nie zapisuje ani jednej wiadomości."
    ok "import aktywowany jawnie"
    ;;
esac

# ── 3b. Co jest potrzebne, żeby PROCES w ogóle wstał ────────────────────────
# Przepisane z walidacji przy ładowaniu modułu (src/bin/mcp-http.ts) i z
# loadConfig (src/config.ts). Bez tej sekcji bramka sprawdzała kanał pocztowy
# serwera, który kończy się kodem 1, zanim ten kanał zdąży ruszyć.

RUNTIME_MODE="fixture"
has_value MODE && RUNTIME_MODE="$(value_of MODE)"
case "$RUNTIME_MODE" in
  fixture|live) ok "MODE=$RUNTIME_MODE" ;;
  *) fail "MODE musi być \"fixture\" albo \"live\" (jest: $RUNTIME_MODE). Proces przerywa start w loadConfig." ;;
esac

# Claude jest jedyną powierzchnią tego produktu, więc bez MCP_BEARER_TOKEN nie
# ma czego uruchamiać — proces odmawia startu w KAŻDYM trybie kanału.
require_token MCP_BEARER_TOKEN
check_token_length MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
require_distinct MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN MCP_BEARER_TOKEN

# MODE=live: config.ts woła na tych zmiennych req(), czyli rzuca wyjątkiem przy
# pierwszym loadConfig, a nie dopiero przy pierwszym połączeniu z IMAP.
if [ "$RUNTIME_MODE" = "live" ]; then
  require_var MAIL_IMAP_HOST
  require_var MAIL_IMAP_USER
  require_var MAIL_IMAP_PASSWORD
  require_var TEABREW_BASE_URL
  require_var TEABREW_AI_OPERATOR_TOKEN
fi

require_pair MARKETING_PLANNER_BASE_URL MARKETING_PLANNER_TOKEN
require_pair BUDZECIK_BASE_URL BUDZECIK_COPILOT_TOKEN

# ── 4. Skrzynki: KOMPLET, nie „przynajmniej jedna" ──────────────────────────
# Jedna brakująca skrzynka to jedna niewidoczna kolejka klientów — i nikt się
# o tym nie dowie, bo pozostałe działają.

if has_var INBOX_EMAIL_ACCOUNTS; then
  ACCOUNTS="$(value_of INBOX_EMAIL_ACCOUNTS)"
  for required in $REQUIRED_MAILBOXES; do
    case ",$ACCOUNTS," in
      *",$required,"*) ;;
      *)
        if [ "$MODE" = "inbound-preview" ]; then
          warn "brak skrzynki $required w INBOX_EMAIL_ACCOUNTS"
        else
          MISSING+=("skrzynka $required w INBOX_EMAIL_ACCOUNTS")
        fi
        ;;
    esac
  done

  IFS=',' read -ra KEYS <<< "$ACCOUNTS"
  for key in "${KEYS[@]}"; do
    trimmed="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -z "$trimmed" ] && continue
    upper="$(printf '%s' "$trimmed" | tr '[:lower:]-' '[:upper:]_')"
    for suffix in HOST USER PASSWORD ADDRESS; do
      require_var "INBOX_EMAIL_${upper}_${suffix}"
    done
    ok "skrzynka $trimmed: komplet zmiennych"
  done
elif [ "$MODE" = "inbound-preview" ]; then
  warn "INBOX_EMAIL_ACCOUNTS nieustawione — kanał pocztowy będzie wyłączony."
else
  MISSING+=("INBOX_EMAIL_ACCOUNTS")
fi

# ── 5. Meta ─────────────────────────────────────────────────────────────────
if has_var INBOX_META_ACCOUNTS; then
  IFS=',' read -ra ALIASES <<< "$(value_of INBOX_META_ACCOUNTS)"
  for alias in "${ALIASES[@]}"; do
    trimmed="$(printf '%s' "$alias" | tr -d '[:space:]')"
    [ -z "$trimmed" ] && continue
    upper="$(printf '%s' "$trimmed" | tr '[:lower:]-' '[:upper:]_')"
    for suffix in PROVIDER ID TOKEN; do
      require_var "INBOX_META_${upper}_${suffix}"
    done
    if [ "$(value_of "INBOX_META_${upper}_PROVIDER")" = "instagram" ]; then
      # Instagram wysyła i czyta przez PAGE ID połączonej strony, a webhooki
      # przychodzą z identyfikatorem konta IG. Bez PAGE_ID wysyłka idzie
      # pod zły adres i kończy się 404.
      has_var "INBOX_META_${upper}_PAGE_ID" \
        || MISSING+=("INBOX_META_${upper}_PAGE_ID (Instagram wymaga PAGE ID osobno)")
    fi
    ok "konto Meta $trimmed sprawdzone"
  done
  require_var INBOX_META_APP_SECRET
  require_var INBOX_META_VERIFY_TOKEN
else
  warn "INBOX_META_ACCOUNTS nieustawione — Instagram i Facebook będą wyłączone."
fi

# ── 6. Most odpowiedzi i wysyłka ────────────────────────────────────────────
# Most odpowiedzi klientom włącza SAMA obecność CUSTOMER_CASE_REPLY_BRIDGE_TOKEN
# — mcp-http.ts liczy REPLY_BRIDGE_ENABLED z jego długości, bez żadnego
# osobnego przełącznika. Dlatego tryb przychodzący nie może go „po prostu nie
# sprawdzać": to jedyne miejsce, w którym da się jeszcze zauważyć, że podgląd
# wstałby z czynną ścieżką pisania do klientów.

# Origin dopuszczany przez most: HTTPS bez danych logowania, ścieżki, query
# i fragmentu. HTTP wyłącznie na pętli zwrotnej i tylko poza MODE=live.
teabrew_base_url_ok() {
  case "$1" in
    *"@"*|*"?"*|*"#"*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^https://[A-Za-z0-9._-]+(:[0-9]+)?/?$' && return 0
  [ "$RUNTIME_MODE" != "live" ] \
    && printf '%s' "$1" | grep -Eq '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$' \
    && return 0
  return 1
}

if [ "$MODE" = "outbound-live" ]; then
  require_var INBOX_RESEND_API_KEY
  require_var INBOX_RESEND_WEBHOOK_SECRET
  require_token MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
  # Proces wymaga obu tokenów mostu RAZEM i przerywa start, gdy ustawiony jest
  # tylko jeden — plus adresu, pod który most ma wysyłać.
  require_token CUSTOMER_CASE_REPLY_BRIDGE_TOKEN
  require_token TEABREW_AI_OPERATOR_REPLY_TOKEN
  require_var TEABREW_BASE_URL

  if has_value TEABREW_BASE_URL; then
    teabrew_base_url_ok "$(value_of TEABREW_BASE_URL)" \
      || fail "TEABREW_BASE_URL musi być originem HTTPS bez danych logowania, ścieżki, query i fragmentu.
HTTP jest dopuszczony wyłącznie na pętli zwrotnej i tylko poza MODE=live."
    ok "TEABREW_BASE_URL ma kształt akceptowany przez most odpowiedzi"
  fi

  # Komplet par z forbiddenReuse w mcp-http.ts. Skrypt znał wcześniej jedną
  # z nich, więc sześć pozostałych sposobów na wspólny token przechodziło.
  require_distinct CUSTOMER_CASE_REPLY_BRIDGE_TOKEN MCP_BEARER_TOKEN
  require_distinct CUSTOMER_CASE_REPLY_BRIDGE_TOKEN MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
  require_distinct CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_TOKEN
  require_distinct CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN
  require_distinct TEABREW_AI_OPERATOR_REPLY_TOKEN MCP_BEARER_TOKEN
  require_distinct TEABREW_AI_OPERATOR_REPLY_TOKEN MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
  require_distinct TEABREW_AI_OPERATOR_REPLY_TOKEN TEABREW_AI_OPERATOR_TOKEN
  ok "tokeny mostu, MCP i odczytu TeaBrew są rozdzielne"
else
  # Most odpowiedzi bywa już WŁĄCZONY z powodu wcześniejszego pilota Allegro
  # (odpowiedzi idą przez TeaBrew i nie są częścią tego kanału). W trybach
  # przychodzących pilnujemy tego, co naprawdę chroni klientów KANAŁU:
  # generyczna wysyłka nie może mieć czym doręczać. Dostawców doręczeń jest
  # dwóch: Resend (e-mail) i Graph API (Meta). Most + którykolwiek z nich
  # w trybie przychodzącym to twarda odmowa; sam most bez dostawców zostaje
  # jawnym ostrzeżeniem o pilocie Allegro.
  MOST_OBECNY=0
  for bridge_var in CUSTOMER_CASE_REPLY_BRIDGE_TOKEN TEABREW_AI_OPERATOR_REPLY_TOKEN; do
    has_value "$bridge_var" && MOST_OBECNY=1
  done
  if [ "$MOST_OBECNY" = "1" ]; then
    has_value INBOX_RESEND_API_KEY && fail "Tryb $MODE: most odpowiedzi jest ustawiony RAZEM z INBOX_RESEND_API_KEY.
To daje kanałowi generycznemu realną drogę wysyłki e-mail do klientów poza trybem outbound-live.
Usuń klucz: railway variables --service $SERVICE --unset INBOX_RESEND_API_KEY"
    META_Z_TOKENEM=""
    for meta_alias in $(printf '%s' "$(value_of INBOX_META_ACCOUNTS)" | tr ',' ' '); do
      alias_upper="$(printf '%s' "$meta_alias" | tr '[:lower:]' '[:upper:]' | tr -d ' ')"
      [ -n "$alias_upper" ] && has_value "INBOX_META_${alias_upper}_TOKEN" && META_Z_TOKENEM="$meta_alias"
    done
    [ -n "$META_Z_TOKENEM" ] && fail "Tryb $MODE: most odpowiedzi jest ustawiony RAZEM z tokenem Graph API konta $META_Z_TOKENEM.
To daje kanałowi generycznemu realną drogę wysyłki DM do klientów poza trybem outbound-live."
    warn "most odpowiedzi jest WŁĄCZONY (pilot odpowiedzi Allegro przez TeaBrew) — kanał generyczny nie ma dostawców doręczeń, więc pisać nie może."
  else
    ok "most odpowiedzi wyłączony"
  fi

  if [ "$MOST_OBECNY" = "0" ]; then
    has_value INBOX_RESEND_API_KEY \
      && warn "INBOX_RESEND_API_KEY ustawione, ale tryb to $MODE — wysyłka pozostanie wyłączona po stronie kodu." \
      || true
  fi
fi

# ── 7. Wynik ────────────────────────────────────────────────────────────────
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\n\033[31mBrakuje dla trybu %s:\033[0m\n' "$MODE"
  for name in "${MISSING[@]}"; do printf '  - %s\n' "$name"; done
  printf '\nUstaw je poleceniem: railway variables --service %s --set NAZWA=wartosc\n' "$SERVICE"
  printf 'Skrypt NIE ustawia sekretów za Ciebie i nie wypisuje żadnych wartości.\n'
  exit 1
fi

printf '\n\033[32mKonfiguracja kompletna dla trybu %s.\033[0m\n' "$MODE"
printf 'To była wyłącznie kontrola. Wdrożenie jest osobnym, jawnym krokiem.\n'
