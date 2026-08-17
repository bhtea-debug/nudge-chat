#!/bin/bash
# Ustawia codzienny raport na macOS przez launchd.
#
#   bash scripts/install-schedule.sh            # dni robocze, 8:00
#   bash scripts/install-schedule.sh --o 7:30   # inna godzina
#   bash scripts/install-schedule.sh --codziennie
#   bash scripts/install-schedule.sh --wylacz   # zdejmij harmonogram
#
# Dlaczego launchd, a nie cron: launchd uruchomi pominięty przebieg po wybudzeniu
# komputera. Cron po prostu go opuszcza, a Mac rzadko czuwa o 8:00.
#
# Dlaczego nie zaplanowane zadanie w chmurze: raport potrzebuje dostępu do serwera
# IMAP i do wdrożenia Convex. Środowiska w chmurze tego dostępu nie mają
# (zmierzone — patrz docs/AI-OPERATOR-MVP.md, sekcja 8.9). Musi działać tutaj.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="pl.brownhouseandtea.raport"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$DIR/scripts/daily-report.sh"

HOUR=8
MINUTE=0
WEEKDAYS_ONLY=1

die() { printf '\n✗ %s\n\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Ten skrypt jest dla macOS. Na innym systemie użyj cron albo systemd timer."

while [ $# -gt 0 ]; do
  case "$1" in
    --wylacz|--off)
      if [ -f "$PLIST" ]; then
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null
        rm -f "$PLIST"
        printf '\n✓ Harmonogram zdjęty. Raport możesz nadal odpalić ręcznie: npm run raport\n\n'
      else
        printf '\nHarmonogramu nie było — nic nie zmieniłem.\n\n'
      fi
      exit 0
      ;;
    --o|--godzina)
      shift
      [ $# -gt 0 ] || die "Podaj godzinę, np. --o 7:30"
      HOUR="${1%%:*}"
      case "$1" in *:*) MINUTE="${1##*:}" ;; *) MINUTE=0 ;; esac
      ;;
    --codziennie) WEEKDAYS_ONLY=0 ;;
    *) die "Nie znam opcji \"$1\". Użycie: --o 7:30 | --codziennie | --wylacz" ;;
  esac
  shift
done

# Godzina musi być liczbą — literówka w plist kończy się zadaniem, które nigdy
# nie wystartuje i nie powie dlaczego.
case "$HOUR" in ''|*[!0-9]*) die "Godzina \"$HOUR\" nie jest liczbą." ;; esac
case "$MINUTE" in ''|*[!0-9]*) die "Minuta \"$MINUTE\" nie jest liczbą." ;; esac
[ "$HOUR" -le 23 ] || die "Godzina musi być z zakresu 0–23."
[ "$MINUTE" -le 59 ] || die "Minuta musi być z zakresu 0–59."

[ -f "$RUNNER" ] || die "Nie ma $RUNNER"
[ -f "$DIR/.env" ] || die "Nie ma $DIR/.env — najpierw: bash scripts/live-setup.sh"
[ -f "$DIR/node_modules/tsx/dist/cli.mjs" ] || die "Brak zależności — najpierw: npm install"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Nie znalazłem node w PATH."

# Klucz API NIE jest wymagany. Raport i monitor pracują deterministycznie:
# zbierają fakty z poczty i TeaBrew, a ocenę robi Claude w rozmowie, na
# subskrypcji właściciela. Klucz jest potrzebny tylko przy świadomym włączeniu
# MONITOR_CLASSIFIER=model, i wtedy brak klucza zgłosi sam przebieg.
if grep -q '^MONITOR_CLASSIFIER=model' "$DIR/.env" 2>/dev/null &&
   ! grep -q '^ANTHROPIC_API_KEY=.\+' "$DIR/.env"; then
  die "W .env jest MONITOR_CLASSIFIER=model, ale nie ma ANTHROPIC_API_KEY. Albo uzupełnij klucz, albo usuń tę linię — tryb domyślny (deterministyczny) klucza nie potrzebuje."
fi

chmod +x "$RUNNER"
mkdir -p "$HOME/Library/LaunchAgents"

if [ "$WEEKDAYS_ONLY" -eq 1 ]; then
  # launchd: 1=poniedziałek … 5=piątek. Tablica słowników = pięć terminów.
  CALENDAR="<array>"
  for d in 1 2 3 4 5; do
    CALENDAR="$CALENDAR
    <dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>"
  done
  CALENDAR="$CALENDAR
  </array>"
  WHEN="dni robocze"
else
  CALENDAR="<dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>"
  WHEN="codziennie"
fi

cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BHT_NODE</key><string>$NODE</string>
  </dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  $CALENDAR
  <key>StandardErrorPath</key><string>$DIR/raporty/launchd.log</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLISTEOF

mkdir -p "$DIR/raporty"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  launchctl load "$PLIST" 2>/dev/null || die "launchctl nie przyjął $PLIST"
fi

printf '\n✓ Raport dzienny ustawiony.\n\n'
printf '  kiedy:  %s o %02d:%02d\n' "$WHEN" "$HOUR" "$MINUTE"
printf '  panel:  %s/raporty/dzisiaj.html\n' "$DIR"
printf '  log:    %s/raporty/przebiegi.log\n\n' "$DIR"
cat <<'INFO'
Co się stanie rano:
  • dostaniesz powiadomienie z jednym zdaniem (np. „Poczta: 12 · 3 numerów nie ma w TeaBrew”),
  • panel otworzy się SAM tylko wtedy, gdy jest po co — w spokojny dzień zostanie zamknięty,
  • przy wyłączonym Macu przebieg wykona się po wybudzeniu, nie przepadnie.

Sprawdź teraz, bez czekania do rana:
  npm run raport -- --otworz

Zdjąć harmonogram:
  bash scripts/install-schedule.sh --wylacz
INFO
