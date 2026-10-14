#!/usr/bin/env bash
# The original's security-camera screen at a held level time (docs/visual-acceptance.md "Security cameras"), under the shared Wine lock:
# only one DeusEx.exe may run on this prefix at a time (other agents capture with it too). Launches the game, runs
# `camera-acceptance.mjs original` (which opens the map, flies JC to the computer, frobs it, types the login, holds the level and takes
# the screenshot) and quits the game by the PID it started.
#
#   scripts/camera-original.sh <map> --computer ComputerSecurity1 --user U --password P --cameras SecurityCamera0,SecurityCamera4 --name cs1
set -u
MAP=${1:?usage: camera-original.sh <map> --computer C --user U --password P --cameras A,B,C --name n}; shift
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK=/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine} DX_HYPRLAND=${DX_HYPRLAND:-1}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
cd "$ROOT" || exit 1
exec 9>"$LOCK"
flock 9
# another agent's game may still be closing (it is not always started under the lock): wait for it, up to 30 minutes
for _ in $(seq 1 360); do pgrep -x DeusEx.exe >/dev/null || break; sleep 5; done
if pgrep -x DeusEx.exe >/dev/null; then echo "a DeusEx.exe is still running; not starting" >&2; exit 9; fi
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
# up: the viewport player exists
for _ in $(seq 1 60); do
  if "$DX_WINE" ad/build/dump-actor-win.exe JCDentonMale 'Player:0x5d4:u32' 2>/dev/null | grep -q '^JCDentonMale JCDentonMale.* Player=0x[1-9a-f]'; then break; fi
  # a Recovery Mode wizard (the game before this one was not shut down by itself) is answered once
  if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
    printf 'button Run Deus Ex\nsleep 500\n' > /tmp/camera-original-recover.txt; node ad/scripts/original-game.mjs run /tmp/camera-original-recover.txt >/dev/null 2>&1
  fi
  sleep 5
done
PID=$(pgrep -x DeusEx.exe | head -1)
sleep 5
node scripts/camera-acceptance.mjs original --map "$MAP" "$@"
