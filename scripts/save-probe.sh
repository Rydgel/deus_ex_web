#!/usr/bin/env bash
# scripts/travel-probe.sh for a session that writes into the Wine prefix's Save folder (SaveGame, QuickSave, LoadGame, DeleteGame: docs/travel.md order
# step 4). The prefix's Save folder is the user's own (their real slots), so this takes the shared Wine lock first, sets the whole folder aside under
# .work/travel/save-backup-<tag> BEFORE the game starts, runs the probe, and puts the folder back exactly as it was (files, times) when the probe ends,
# whatever the session wrote. The slots a session wants to keep are copied out by the probe's `savedir:<label>:<dir>` step while the game runs.
# A backup that already exists is a session that did not finish: nothing starts, the folder is restored by hand from it.
#
#   scripts/save-probe.sh <tag> <step>...        (the steps of scripts/travel-probe.sh)
set -u
TAG=${1:?usage: save-probe.sh <tag> <step>...}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK=${DX_LOCK:-/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock}
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex}
GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
SAVE="$GAME/Save"
BACKUP="$ROOT/.work/travel/save-backup-$TAG"
exec 9>"$LOCK"
command -v flock >/dev/null && flock 9
if [ -e "$BACKUP" ]; then echo "save-probe: $BACKUP exists (an unfinished session): restore $SAVE from it by hand, then remove it" >&2; exit 8; fi
mkdir -p "$ROOT/.work/travel"
cp -a "$SAVE" "$BACKUP" || { echo "save-probe: cannot set $SAVE aside" >&2; exit 8; }
restore() {
  rm -rf "$SAVE" && cp -a "$BACKUP" "$SAVE" && rm -rf "$BACKUP" && echo "save-probe: $SAVE restored"
}
trap restore EXIT
# the probe takes the lock again on /dev/null: this process already holds the real one
DX_LOCK=/dev/null "$ROOT/scripts/travel-probe.sh" "$@"
