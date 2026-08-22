#!/usr/bin/env bash
set -uo pipefail

# Konfiguracja kanału „Obsługa klienta” na Railwayu.
#
# Powstał, bo alternatywą jest ustawianie kilkunastu zmiennych ręcznie „na
# boku”: jedna literówka w nazwie skrzynki i adapter cicho nie wstaje, a przy
# trzech kontach nikt nie zauważy, którego brakuje.
#
# ── CZEGO TEN SKRYPT NIE ROBI ─────────────────────────────────────────────────
# Nie wypisuje ANI JEDNEJ wartości sekretu — ani do stdout, ani do logu, ani
# w komunikacie błędu. Sprawdza wyłącznie OBECNOŚĆ i kształt.
# Nie wykonuje wdrożenia. Nie tworzy kont. Nie dotyka Meta ani Resend.
#
# ── UCZCIWE OSTRZEŻENIE ───────────────────────────────────────────────────────
# Ten skrypt nie został uruchomiony na prawdziwym projekcie Railway. Każdy krok
# sprawdza wynik i zatrzymuje się przy pierwszym błędzie zamiast brnąć dalej.

cd "$(dirname "$0")/.." || exit 1

SERVICE="bht-copilot"
EXPECTED_PROJECT_ID="bd311917-f3d7-419f-aeba-79bf5b4dafe4"
EXPECTED_ENVIRONMENT_ID="e8e60c09-4de2-4fb3-a11d-6e9048371e54"
EXPECTED_SERVICE_ID="c4a9c0ad-7c0e-4494-a16e-321e0e382b6c"
REQUIRED_MOUNT="/data"
APPLY="${BHT_INBOX_APPLY:-0}"

fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m  OK\033[0m  %s\n' "$1"; }
warn() { printf '\033[33m  !\033[0m   %s\n' "$1"; }

# ── 1. Właściwy projekt, środowisko i usługa ─────────────────────────────────
# Bez tej kontroli skrypt potrafi skonfigurować CUDZY projekt: `railway link`
# zapamiętuje ostatni wybór, a ten bywa z zupełnie innej pracy.

command -v railway >/dev/null 2>&1 || fail "Brak Railway CLI. Zainstaluj je i zaloguj się przed konfiguracją."

STATUS_JSON="$(railway status --json 2>/dev/null)" || fail "Railway CLI nie odpowiada. Zaloguj się: railway login"

read_json() {
  printf '%s' "$STATUS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const path = process.argv[1].split(".");
        let value = data;
        for (const key of path) value = value?.[key];
        process.stdout.write(String(value ?? ""));
      } catch {
        process.stdout.write("");
      }
    });
  ' "$1"
}

PROJECT_ID="$(read_json id)"
ENVIRONMENT_ID="$(read_json environment.id)"

[ "$PROJECT_ID" = "$EXPECTED_PROJECT_ID" ] \
  || fail "Podłączony projekt to nie BHT Copilot. Uruchom: railway link --project $EXPECTED_PROJECT_ID"
ok "projekt zgodny"

[ "$ENVIRONMENT_ID" = "$EXPECTED_ENVIRONMENT_ID" ] \
  || fail "Złe środowisko. Oczekiwane: production ($EXPECTED_ENVIRONMENT_ID)"
ok "środowisko: production"

# ── 2. Trwały wolumen ────────────────────────────────────────────────────────
# Stan kanału na dysku efemerycznym oznacza kursory od zera po KAŻDYM deployu,
# czyli ponowny import całej skrzynki i ryzyko lawiny powiadomień.

VOLUMES="$(railway volume list --service "$SERVICE" 2>/dev/null || true)"
if printf '%s' "$VOLUMES" | grep -q "$REQUIRED_MOUNT"; then
  ok "wolumen trwały pod $REQUIRED_MOUNT"
else
  fail "BRAK wolumenu pod $REQUIRED_MOUNT. Bez niego kursory startują od zera po każdym wdrożeniu.
Dodaj: railway volume add --service $SERVICE --mount-path $REQUIRED_MOUNT"
fi

# ── 3. Zmienne kanału ────────────────────────────────────────────────────────
# Sprawdzamy OBECNOŚĆ i kształt. Wartości nie są nigdzie wypisywane.

VARS="$(railway variables --service "$SERVICE" --kv 2>/dev/null)" \
  || fail "Nie udało się odczytać zmiennych usługi $SERVICE."

has_var() { printf '%s' "$VARS" | grep -q "^$1="; }
value_of() { printf '%s' "$VARS" | sed -n "s/^$1=//p" | head -1; }

MISSING=()
require_var() { has_var "$1" || MISSING+=("$1"); }

require_var INBOX_ENABLED
require_var INBOX_STATE_DIR

if has_var INBOX_STATE_DIR; then
  STATE_DIR="$(value_of INBOX_STATE_DIR)"
  case "$STATE_DIR" in
    "$REQUIRED_MOUNT"*) ok "INBOX_STATE_DIR wskazuje wolumen trwały" ;;
    *) fail "INBOX_STATE_DIR musi zaczynać się od $REQUIRED_MOUNT, inaczej stan ginie przy deployu." ;;
  esac
fi

# Konta pocztowe: każdy klucz musi mieć KOMPLET zmiennych.
if has_var INBOX_EMAIL_ACCOUNTS; then
  ACCOUNTS="$(value_of INBOX_EMAIL_ACCOUNTS)"
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
else
  warn "INBOX_EMAIL_ACCOUNTS nieustawione — kanał pocztowy będzie wyłączony."
fi

# Meta: identyfikator webhooka i PAGE ID to DWA różne numery.
if has_var INBOX_META_ACCOUNTS; then
  META="$(value_of INBOX_META_ACCOUNTS)"
  IFS=',' read -ra ALIASES <<< "$META"
  for alias in "${ALIASES[@]}"; do
    trimmed="$(printf '%s' "$alias" | tr -d '[:space:]')"
    [ -z "$trimmed" ] && continue
    upper="$(printf '%s' "$trimmed" | tr '[:lower:]-' '[:upper:]_')"
    for suffix in PROVIDER ID TOKEN; do
      require_var "INBOX_META_${upper}_${suffix}"
    done
    if [ "$(value_of "INBOX_META_${upper}_PROVIDER")" = "instagram" ]; then
      # Instagram wysyła i czyta przez PAGE ID połączonej strony, a webhooki
      # przychodzą z identyfikatorem konta IG. Bez PAGE_ID wysyłka trafia
      # pod zły adres.
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

# Wysyłka e-mail jest fail-closed: brak klucza = przycisk nieaktywny.
if has_var INBOX_RESEND_API_KEY; then
  has_var INBOX_RESEND_WEBHOOK_SECRET \
    || warn "Brak INBOX_RESEND_WEBHOOK_SECRET — statusy dostarczenia nie będą aktualizowane."
else
  warn "Brak INBOX_RESEND_API_KEY — wysyłka e-mail pozostanie wyłączona."
fi

# ── 4. Rozdzielność tokenów ──────────────────────────────────────────────────
# Wspólny token odczytu i wysyłki wygląda jak zabezpieczenie, którym nie jest.
if has_var MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN && has_var CUSTOMER_CASE_REPLY_BRIDGE_TOKEN; then
  if [ "$(value_of MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN)" = "$(value_of CUSTOMER_CASE_REPLY_BRIDGE_TOKEN)" ]; then
    fail "Token odczytu i token wysyłki są IDENTYCZNE. Kto może czytać kolejkę, mógłby pisać do klientów."
  fi
  ok "tokeny odczytu i wysyłki są rozdzielne"
fi

# ── 5. Wynik ─────────────────────────────────────────────────────────────────
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\n\033[31mBrakuje zmiennych:\033[0m\n'
  for name in "${MISSING[@]}"; do printf '  - %s\n' "$name"; done
  printf '\nUstaw je poleceniem: railway variables --service %s --set NAZWA=wartosc\n' "$SERVICE"
  printf 'Skrypt NIE ustawia sekretów za Ciebie i nie wypisuje żadnych wartości.\n'
  exit 1
fi

printf '\n\033[32mKonfiguracja kanału jest kompletna.\033[0m\n'
if [ "$APPLY" != "1" ]; then
  printf 'To była wyłącznie kontrola. Wdrożenie jest osobnym, jawnym krokiem.\n'
fi
