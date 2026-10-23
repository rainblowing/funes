#!/bin/bash
# Bar #7 replay (RAI-318, PLAN-0.6.0 §Acceptance bar): the README quickstart through the first recall,
# then remember and supersede, in an isolated HOME. The count rule reads this transcript: the glossary
# headwords a user must understand to run it (stdout and stderr, `--help` excluded). Count 4: star,
# page, index, recall.
# Usage: scripts/first-run.sh <empty scratch dir>. The first build downloads the E5 model (135 MB) into
# <scratch>/home/.funes/models, unless that folder already holds a copy.
set -u
S=$(cd "${1:?usage: first-run.sh <empty scratch dir>}" && pwd)
export HOME=$S/home
unset FUNES_HOME FUNES_LOCUS FUNES_LIBSQL_DIR FUNES_MODEL_DIR
CLI="$(cd "$(dirname "$0")/.." && pwd)/packages/funes-engine/src/cli.ts"
funes() { bun "$CLI" "$@"; }
step() { echo; echo "\$ funes $*"; funes "$@"; echo "[exit $?]"; }
mkdir -p "$HOME" "$S/notes"
printf -- '---\ntitle: Roof repair decision\n---\nWe decided to replace the roof with metal tiles in spring, after the second quote from [[Contractors]].\n' > "$S/notes/roof.md"
printf '# Contractors\nIvan quoted 4200 for metal tiles. Petr quoted 5100.\n' > "$S/notes/contractors.md"
printf 'Plant tomatoes after the last frost.\n' > "$S/notes/garden.md"

cd "$S/notes"
step reindex
step recall "what did we decide about the roof"
echo; echo '$ funes remember --title "Roof start date" --body "Roofers start on 12 May."'
OUT=$(funes remember --title "Roof start date" --body "Roofers start on 12 May." 2>&1); echo "$OUT"
ID=$(echo "$OUT" | sed -n 's/^id: //p')
step recall "when do roofers start"
step supersede "$ID" --title "Roof start date" --body "Moved to 19 May."
step recall "when do roofers start"
