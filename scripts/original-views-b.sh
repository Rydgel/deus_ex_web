#!/usr/bin/env bash
# The original's frames of the stored acceptance views of several maps at Brightness 2/3 (Shot == framebuffer), under the shared Wine lock:
#   scripts/original-views-b.sh map1,map2,... [--brightness 0.666667]
# Launches the game, opens each map in turn through `visual-acceptance.mjs original` and quits the game by its PID.
set -u
MAPS=${1:?usage: original-views-b.sh map1,map2,...}; shift
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ "$(uname)" = Darwin ]; then
  # the Mac: the CrossOver bottle "DeusEx" (original-game.mjs's defaults); no flock there, so the lock is advisory only, and no Hyprland
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
for _ in $(seq 1 360); do [ -n "$(game_pids)" ] || break; sleep 5; done
if [ -n "$(game_pids)" ]; then echo "a DeusEx.exe is still running; not starting" >&2; exit 9; fi
FIRST=${MAPS%%,*}
node ad/scripts/original-game.mjs launch "$FIRST.dx" || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(game_pids | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -n "$(game_pids)" ] || return 0; sleep 1; done
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
}
trap quit_game EXIT
for _ in $(seq 1 60); do
  if "$DX_WINE" ad/build/dump-actor-win.exe JCDentonMale 'Player:0x5d4:u32' 2>/dev/null | grep -q '^JCDentonMale JCDentonMale.* Player=0x[1-9a-f]'; then break; fi
  if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
    printf 'button Run Deus Ex\nsleep 500\n' > /tmp/original-views-b-recover.txt; node ad/scripts/original-game.mjs run /tmp/original-views-b-recover.txt >/dev/null 2>&1
  fi
  sleep 5
done
PID=$(game_pids | head -1)
sleep 5
node scripts/visual-acceptance.mjs original --maps "$MAPS" --load-wait 40000 "$@"
