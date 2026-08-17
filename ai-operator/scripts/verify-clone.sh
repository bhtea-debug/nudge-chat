#!/bin/bash
# Weryfikacja tego, co JEST W COMMICIE — nie tego, co leży w katalogu roboczym.
#
#   bash scripts/verify-clone.sh
#
# Powstało po realnej wpadce: wzorzec `state/` w .gitignore ukrył `src/state/`,
# `git add -A` pominął siedem plików źródłowych bez słowa, a `npm run typecheck`
# i `npm test` przeszły — bo pliki były na dysku. Zepsute było dopiero to, co
# wypchnięte, i dowiedział się o tym właściciel przy `git pull`.
#
# `git archive HEAD` materializuje DOKŁADNIE zawartość commita, więc brakujący
# plik nie ma jak się przemknąć. Świadomie bez `git clone`: nie potrzebujemy
# sieci, a interesuje nas treść commita, nie stan zdalnego repozytorium.
#
# node_modules podwiązujemy z katalogu roboczego. Ta kontrola dotyczy plików
# ŹRÓDŁOWYCH — zależności sprawdza `npm ci` na wdrożeniu.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$REPO" || exit 1

if [ -n "$(git status --porcelain -- "$DIR")" ]; then
  echo "Uwaga: masz niezacommitowane zmiany. Sprawdzam TREŚĆ COMMITA, nie je."
fi

echo "Rozpakowuję drzewo z HEAD…"
git archive HEAD | tar -x -C "$WORK" || { echo "✗ git archive nie zadziałał"; exit 1; }

TARGET="$WORK/ai-operator"
[ -d "$TARGET" ] || { echo "✗ w commicie nie ma katalogu ai-operator"; exit 1; }

ln -s "$DIR/node_modules" "$TARGET/node_modules"

cd "$TARGET" || exit 1

# Najpierw najtańsza i najostrzejsza kontrola: czy każdy import z src/ wskazuje
# na plik, który w commicie ISTNIEJE. To ta usterka, której szukamy.
echo "Sprawdzam, czy wszystkie importy mają swoje pliki…"
MISSING=0
while IFS= read -r line; do
  file="${line%%:*}"
  spec="${line#*:}"
  base="$(dirname "$file")"
  resolved="$base/${spec%.js}.ts"
  if [ ! -f "$resolved" ]; then
    echo "  ✗ $file → $spec (nie ma $resolved)"
    MISSING=$((MISSING + 1))
  fi
done < <(grep -rhoE '^\s*(import|export)[^"'"'"']*from "(\./|\.\./)[^"]+"' src --include="*.ts" -n \
         | sed -E 's/^([0-9]+):.*from "([^"]+)".*/\2/' \
         | sort -u \
         | while read -r spec; do
             grep -rlE "from \"$(printf '%s' "$spec" | sed 's/[.[\*^$]/\\&/g')\"" src --include="*.ts" \
               | while read -r f; do echo "$f:$spec"; done
           done)

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "✗ $MISSING importów bez pliku w commicie."
  echo "  Najczęstsza przyczyna: wzorzec w .gitignore bez ukośnika na początku"
  echo "  ukrył katalog źródłowy. Sprawdź: git check-ignore -v <ścieżka>"
  exit 1
fi

echo "Typecheck na drzewie z commita…"
npx tsc --noEmit || { echo "✗ typecheck padł na treści commita"; exit 1; }

echo "Testy na drzewie z commita…"
npx vitest run --reporter=dot || { echo "✗ testy padły na treści commita"; exit 1; }

echo ""
echo "✓ To, co jest w commicie, buduje się i przechodzi testy."
