#!/usr/bin/env bash
# The original's frames of the stored acceptance views of several maps at Brightness 2/3 (Shot == framebuffer), under the shared Wine lock:
#   scripts/original-views-b.sh map1,map2,... [--brightness 0.666667]
# Launches the game, opens each map in turn through `visual-acceptance.mjs original` and quits the game by its PID.
set -u
MAPS=${1:?usage: original-views-b.sh map1,map2,...}; shift
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK=/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine} DX_HYPRLAND=${DX_HYPRLAND:-1}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
cd "$ROOT" || exit 1
exec 9>"$LOCK"
flock 9
for _ in $(seq 1 360); do pgrep -x DeusEx.exe >/dev/null || break; sleep 5; done
if pgrep -x DeusEx.exe >/dev/null; then echo "a DeusEx.exe is still running; not starting" >&2; exit 9; fi
FIRST=${MAPS%%,*}
node ad/scripts/original-game.mjs launch "$FIRST.dx" || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(pgrep -x DeusEx.exe | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do pgrep -x DeusEx.exe >/dev/null || return 0; sleep 1; done
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
PID=$(pgrep -x DeusEx.exe | head -1)
sleep 5
node scripts/visual-acceptance.mjs original --maps "$MAPS" --load-wait 40000 "$@"
