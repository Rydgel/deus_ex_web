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
if [ "$(uname)" = Darwin ]; then
  # the Mac: the CrossOver bottle "DeusEx" (original-game.mjs's defaults); no flock there, so the lock is advisory only, and no Hyprland
  # (live-original.sh and original-views.sh do the same)
  LOCK=${DX_LOCK:-/Users/gcc/Documents/deus_ex_web/.work/wine-deusex.lock}
  export CX_BOTTLE=${CX_BOTTLE:-DeusEx} DX_WINE=${DX_WINE:-/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine}
  export DX_GAME=${DX_GAME:-$HOME/Library/Application Support/CrossOver/Bottles/$CX_BOTTLE/drive_c/Deus Ex GOTY Edition}
else
  LOCK=${DX_LOCK:-/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock}
  export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine} DX_HYPRLAND=${DX_HYPRLAND:-1}
  export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
fi
cd "$ROOT" || exit 1
exec 9>"$LOCK"
if command -v flock >/dev/null; then flock 9; else echo "no flock: $LOCK is not taken" >&2; fi
# the game's process: its name is DeusEx.exe under Wine, its Windows path (C:\...\DeusEx.exe) under CrossOver
game_pids() { ps -e -o pid=,comm= | awk '/DeusEx\.exe$/ {print $1}'; }
# another agent's game may still be closing (it is not always started under the lock): wait for it, up to 30 minutes
for _ in $(seq 1 360); do [ -n "$(game_pids)" ] || break; sleep 5; done
if [ -n "$(game_pids)" ]; then echo "a DeusEx.exe is still running; not starting" >&2; exit 9; fi
node ad/scripts/original-game.mjs launch "$MAP.dx" || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(game_pids | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -n "$(game_pids)" ] || return 0; sleep 1; done
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
PID=$(game_pids | head -1)
sleep 5
code=0
node scripts/camera-acceptance.mjs original --map "$MAP" "$@" || code=$?
# DX_POST=script: run (bash, same environment) with the game still up after the capture (the level released): a look at actors with tools/dump-actor-win.c
[ "$code" = 0 ] && [ -n "${DX_POST:-}" ] && bash "$DX_POST"
exit $code
