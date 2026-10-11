#!/usr/bin/env bash
# One run of the original for the live-scene acceptance (docs/visual-acceptance.md "Live scenes"), under the
# shared Wine lock: only one DeusEx.exe may run at a time on this prefix (other agents capture with it too).
# Launches the game on <map>, runs `live-acceptance.mjs original` (reloading the map until the original's
# population holds nothing Play's seeded load lacks: the driver exits 3), and quits the game by the PID it started.
#
#   scripts/live-original.sh <map> [live-acceptance.mjs original options...]
#   e.g. scripts/live-original.sh 01_NYC_UNATCOIsland --ticks 600 --delta 0.0166666675 --monitor 20
set -u
MAP=${1:?usage: live-original.sh <map> [options]}; shift
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK=/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
cd "$ROOT" || exit 1
exec 9>"$LOCK"
flock 9
if pgrep -x DeusEx.exe >/dev/null; then echo "a DeusEx.exe is already running; not starting" >&2; exit 9; fi
node ad/scripts/original-game.mjs launch "$MAP.dx" || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(pgrep -x DeusEx.exe | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do pgrep -x DeusEx.exe >/dev/null || return 0; sleep 1; done
  # it did not exit on its own: it is the one this script started (the lock keeps others out)
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
}
trap quit_game EXIT
# up: the viewport player exists; a Recovery Mode wizard (after a crash) is answered once
for _ in $(seq 1 60); do
  if "$DX_WINE" ad/build/dump-actor-win.exe JCDentonMale 'Player:0x5d4:u32' 2>/dev/null | grep -q '^JCDentonMale JCDentonMale.* Player=0x[1-9a-f]'; then break; fi
  if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
    printf 'button Run Deus Ex\nsleep 500\n' > /tmp/live-original-recover.txt; node ad/scripts/original-game.mjs run /tmp/live-original-recover.txt >/dev/null 2>&1
  fi
  sleep 5
done
PID=$(pgrep -x DeusEx.exe | head -1)
sleep 5
code=1
for attempt in 1 2 3 4; do
  node scripts/live-acceptance.mjs original --map "$MAP" --current "$MAP" --load-wait 40000 "$@"; code=$?
  [ "$code" = 3 ] || break
  echo "attempt $attempt: population mismatch, reloading"
done
exit $code
