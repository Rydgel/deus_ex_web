#!/usr/bin/env bash
# One session of the original Deus Ex under Wine that travels between maps and records what the engine leaves behind
# (docs/travel.md "Measurements"): the save directory's files, the engine log, the player's flags, and the travel text the
# new level kept (tools/dump-travel-win.c). It takes the shared Wine lock like scripts/live-original.sh (only one DeusEx.exe
# may run on the prefix) and quits the game by the PID it started. The steps are scripts/travel-step.sh's verbs.
#
#   scripts/travel-probe.sh <tag> <step>...        (or one argument @<file>: a step per line, # comments)
#     cmd:<console line>        type a line into the console (dxinput `cmd`: T, the line, Enter)
#     wait:<seconds>
#     arrive:<regex>            wait until a Level object whose URL.Map matches the regex exists, then 3 s more (up to 150 s)
#     snap:<label>              save directory listing, engine log, player flags, travel text -> .work/travel/<tag>/<label>.*
#     actors:<name>:<label>     tools/dump-actor-win.c for objects named like <name> -> .work/travel/<tag>/<label>.actors.txt
#     shot:<name>               the game's Shot key -> .work/travel/<tag>/<name>.png
#   The game starts on DX.dx whatever the command line says (the logo map): a session that wants another map starts with `cmd:open <map>`.
#   Console lines are typed through the Talk key and can lose characters on a loaded host: check each step's effect with `arrive`/`snap`.
#   DX_KEEP_SAVE=1 leaves Save/ as the session left it (default: the files this session created in Save/ are removed at the end).
#   e.g. scripts/travel-probe.sh t1 'cmd:set LevelInfo bPlayersOnly True' 'cmd:LocalTravel 00_TrainingCombat' 'arrive:00_trainingcombat$' snap:combat
set -u
TAG=${1:?usage: travel-probe.sh <tag> <step>...}; shift
if [ "${1:-}" != "${1#@}" ]; then   # steps from a file
  mapfile -t STEPS < <(grep -v '^[[:space:]]*#' "${1#@}" | grep -v '^[[:space:]]*$')
else
  STEPS=("$@")
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK=${DX_LOCK:-/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock}
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
export DX_DESKTOP=${DX_DESKTOP-1400x860}
OUT=$ROOT/.work/travel/$TAG
mkdir -p "$OUT"
cd "$ROOT" || exit 1
exec 9>"$LOCK"
command -v flock >/dev/null && flock 9
game_pids() { ps -e -o pid=,comm= | awk '/DeusEx\.exe$/ {print $1}'; }
for _ in $(seq 1 360); do [ -n "$(game_pids)" ] || break; sleep 5; done
[ -z "$(game_pids)" ] || { echo "a DeusEx.exe is still running; not starting" >&2; exit 9; }
SAVE="$DX_GAME/Save"
BEFORE=$(cd "$SAVE" 2>/dev/null && find . -type f -printf '%P\n' | sort)
node ad/scripts/original-game.mjs launch DX.dx || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(game_pids | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -n "$(game_pids)" ] || break; sleep 1; done
  if [ -n "$(game_pids)" ] && [ -n "$PID" ]; then kill "$PID" 2>/dev/null; fi   # the one this script started (the lock keeps others out)
  cp "$DX_GAME/System/DeusEx.log" "$OUT/final.log" 2>/dev/null
  if [ -z "${DX_KEEP_SAVE:-}" ]; then   # leave Save/ as it was found: remove what this session created
    AFTER=$(cd "$SAVE" 2>/dev/null && find . -type f -printf '%P\n' | sort)
    comm -13 <(echo "$BEFORE") <(echo "$AFTER") | while IFS= read -r f; do [ -n "$f" ] && rm -f "$SAVE/$f"; done
    find "$SAVE" -mindepth 1 -type d -empty ! -name Current ! -name QuickSave ! -name Save0001 -delete 2>/dev/null
  fi
}
trap quit_game EXIT
for _ in $(seq 1 60); do
  if "$DX_WINE" ad/build/dump-actor-win.exe JCDentonMale 'Player:0x5d4:u32' 2>/dev/null | grep -q '^JCDentonMale JCDentonMale.* Player=0x[1-9a-f]'; then break; fi
  if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
    printf 'button Run Deus Ex\nsleep 500\n' > "$OUT/recover.txt"; node ad/scripts/original-game.mjs run "$OUT/recover.txt" >/dev/null 2>&1
  fi
  sleep 5
done
PID=$(game_pids | head -1)
sleep 5
for step in "${STEPS[@]}"; do
  kind=${step%%:*}; arg=${step#*:}
  case $kind in
    cmd|arrive|snap|shot) scripts/travel-step.sh "$OUT" "$kind" "$arg" ;;
    actors) scripts/travel-step.sh "$OUT" actors "${arg%%:*}" "${arg#*:}" ;;
    wait) sleep "$arg" ;;
    *) echo "unknown step $step" >&2 ;;
  esac
done
