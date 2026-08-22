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

[ "$(read_json id)" = "$EXPECTED_PROJECT_ID" ] \
  || fail "Podłączony projekt to nie BHT Copilot. Uruchom: railway link --project $EXPECTED_PROJECT_ID"
ok "projekt zgodny"

[ "$(read_json environment.id)" = "$EXPECTED_ENVIRONMENT_ID" ] \
  || fail "Złe środowisko. Oczekiwane: production ($EXPECTED_ENVIRONMENT_ID)"
ok "środowisko: production"

# Service ID sprawdzamy NAPRAWDĘ. Wcześniej stała była zadeklarowana i nieużyta,
# czyli bramka wyglądała na mocniejszą, niż była.
SERVICE_JSON="$(railway service --json 2>/dev/null || true)"
SERVICE_ID="$(printf '%s' "$SERVICE_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(raw);
      process.stdout.write(String(data?.id ?? data?.serviceId ?? ""));
    } catch {
      process.stdout.write("");
    }
  });
')"

if [ -z "$SERVICE_ID" ]; then
  fail "Nie udało się odczytać identyfikatora usługi. Wybierz ją: railway service $SERVICE"
fi
[ "$SERVICE_ID" = "$EXPECTED_SERVICE_ID" ] \
  || fail "Podłączona usługa to NIE $SERVICE. Oczekiwane: $EXPECTED_SERVICE_ID, jest: $SERVICE_ID"
ok "usługa: $SERVICE"

# ── 2. Trwały wolumen ────────────────────────────────────────────────────────
# Stan kanału na dysku efemerycznym oznacza kursory od zera po KAŻDYM deployu,
# czyli ponowny import całej skrzynki.

VOLUMES="$(railway volume list --service "$SERVICE" 2>/dev/null || true)"
printf '%s' "$VOLUMES" | grep -q "$REQUIRED_MOUNT" \
  || fail "BRAK wolumenu pod $REQUIRED_MOUNT. Bez niego kursory startują od zera po każdym wdrożeniu.
Dodaj: railway volume add --service $SERVICE --mount-path $REQUIRED_MOUNT"
ok "wolumen trwały pod $REQUIRED_MOUNT"

# ── 3. Zmienne ───────────────────────────────────────────────────────────────

VARS="$(railway variables --service "$SERVICE" --kv 2>/dev/null)" \
  || fail "Nie udało się odczytać zmiennych usługi $SERVICE."

has_var() { printf '%s' "$VARS" | grep -q "^$1="; }
value_of() { printf '%s' "$VARS" | sed -n "s/^$1=//p" | head -1; }

MISSING=()
require_var() { has_var "$1" || MISSING+=("$1"); }

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

# ── 6. Wysyłka ──────────────────────────────────────────────────────────────
if [ "$MODE" = "outbound-live" ]; then
  require_var INBOX_RESEND_API_KEY
  require_var INBOX_RESEND_WEBHOOK_SECRET
  require_var MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN
  require_var CUSTOMER_CASE_REPLY_BRIDGE_TOKEN

  if has_var MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN && has_var CUSTOMER_CASE_REPLY_BRIDGE_TOKEN; then
    # Wspólny token odczytu i wysyłki wygląda jak zabezpieczenie, którym nie
    # jest: kto może czytać kolejkę, mógłby wtedy pisać do klientów.
    [ "$(value_of MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN)" != "$(value_of CUSTOMER_CASE_REPLY_BRIDGE_TOKEN)" ] \
      || fail "Token odczytu i token wysyłki są IDENTYCZNE."
    ok "tokeny odczytu i wysyłki są rozdzielne"
  fi
else
  has_var INBOX_RESEND_API_KEY \
    && warn "INBOX_RESEND_API_KEY ustawione, ale tryb to $MODE — wysyłka pozostanie wyłączona po stronie kodu." \
    || true
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
