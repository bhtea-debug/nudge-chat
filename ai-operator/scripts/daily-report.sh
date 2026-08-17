#!/bin/bash
# Jeden przebieg raportu dziennego. Uruchamiany przez launchd, nie przez człowieka.
#
# Trzy rzeczy, których nie robi zwykłe `npm run raport`:
#  1. nie zakłada, że w PATH jest node — launchd daje minimalne środowisko,
#  2. pokazuje wynik jako powiadomienie systemowe, bo nikt nie patrzy w terminal,
#  3. zapisuje błędy do pliku, bo nie ma komu ich wypisać na ekran.
#
# Ścieżkę do node podaje launchd w BHT_NODE (ustawia ją install-schedule.sh).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${BHT_NODE:-$(command -v node || true)}"
LOG="$DIR/raporty/przebiegi.log"

mkdir -p "$DIR/raporty"

notify() {
  # osascript dostaje tekst przez argv, nie przez interpolację w kodzie —
  # inaczej apostrof w temacie maila wywala całą składnię.
  /usr/bin/osascript - "$1" "$2" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
}

stamp() { date "+%Y-%m-%d %H:%M:%S"; }

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "$(stamp) BŁĄD: nie znalazłem node (BHT_NODE=${BHT_NODE:-brak})" >>"$LOG"
  notify "Raport BHT" "Nie udało się: brak node. Szczegóły w raporty/przebiegi.log"
  exit 1
fi

cd "$DIR" || exit 1

SUMMARY="$("$NODE" node_modules/tsx/dist/cli.mjs \
  --env-file-if-exists=.env \
  src/bin/report.ts --otworz-jesli-wazne 2>>"$LOG")"
CODE=$?

echo "$(stamp) kod=$CODE $SUMMARY" >>"$LOG"

case "$CODE" in
  0) notify "Raport BHT" "$SUMMARY" ;;
  # Kod 3 = w odpowiedzi było twierdzenie bez pokrycia w rzeczywistych
  # wywołaniach. Raport istnieje, ale nie wolno mu ufać bez zajrzenia.
  3) notify "Raport BHT — sprawdź" "$SUMMARY · uwaga: coś bez pokrycia w danych" ;;
  *) notify "Raport BHT — nie udało się" "${SUMMARY:-Przebieg zakończony błędem}. Log: raporty/przebiegi.log" ;;
esac

exit "$CODE"
