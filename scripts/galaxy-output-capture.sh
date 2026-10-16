#!/usr/bin/env bash
# The poll of Galaxy's output in the running original (Stage 4 gate row 4.3.7, check 2; docs/audio-output-scope.md §5.1), under the
# shared Wine lock: launches the game on 00_Training, waits for the viewport player, runs `dx-live-win.exe galaxy poll` (read only:
# no debugger), loads the map again from the console (`open 00_Training`: UGameEngine::Browse, LoadMap, SetViewport with the same
# viewport, which keeps the output open), polls again, and quits the game it started.
#
#   scripts/galaxy-output-capture.sh [out dir]      (default: the main checkout's .work/audio-output)
#   COUNT=n INTERVAL=ms (default 3000 samples, 1 ms apart)
#
# Takes the sessions' bottle lock (.work/bottle.lock, mkdir) on the Mac and releases it once the game is quit.
# Writes <out>/training-load{1,2}.{json,pan.bin,poll.txt}. Needs ad/build/dx-live-win.exe built from tools/dx-live-win.c
# (i686-w64-mingw32-gcc -O2 -o ad/build/dx-live-win.exe tools/dx-live-win.c -lpsapi), ad/build/dump-actor-win.exe and ad/tools/dxinput.exe.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/Users/gcc/Documents/deus_ex_web/.work/audio-output}
COUNT=${COUNT:-3000} INTERVAL=${INTERVAL:-1}
if [ "$(uname)" = Darwin ]; then
  LOCK=${DX_LOCK:-/Users/gcc/Documents/deus_ex_web/.work/wine-deusex.lock}
  export CX_BOTTLE=${CX_BOTTLE:-DeusEx} DX_WINE=${DX_WINE:-/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine}
else
  LOCK=${DX_LOCK:-/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock}
  export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
  export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
fi
cd "$ROOT" || exit 1
mkdir -p "$OUT"
exec 9>"$LOCK"
if command -v flock >/dev/null; then flock 9; else echo "no flock: $LOCK is advisory" >&2; fi
# The sessions' bottle lock (one session at a time on the CrossOver bottle): a directory whose `owner` file names the holder.
BOTTLE_LOCK=${BOTTLE_LOCK:-/Users/gcc/Documents/deus_ex_web/.work/bottle.lock}
if [ "$(uname)" = Darwin ]; then
  if ! mkdir "$BOTTLE_LOCK" 2>/dev/null; then echo "the bottle is held: $(cat "$BOTTLE_LOCK/owner" 2>/dev/null)" >&2; exit 9; fi
  printf 'owner: row 4.3.7 galaxy output poll (scripts/galaxy-output-capture.sh)\nsince: %s\nrelease: removed by the script when the game is quit\n' "$(date '+%F %R')" > "$BOTTLE_LOCK/owner"
fi
release_bottle() { [ "$(uname)" = Darwin ] && grep -q 'row 4.3.7' "$BOTTLE_LOCK/owner" 2>/dev/null && rm -f "$BOTTLE_LOCK/owner" && rmdir "$BOTTLE_LOCK"; }
game_pids() { ps -e -o pid=,comm= | awk '/DeusEx\.exe$/ {print $1}'; }
if [ -n "$(game_pids)" ]; then echo "a DeusEx.exe is running; not starting" >&2; release_bottle; exit 9; fi
player_up() { "$DX_WINE" ad/build/dump-actor-win.exe JCDentonMale 'Player:0x5d4:u32' 2>/dev/null | grep -q '^JCDentonMale JCDentonMale.* Player=0x[1-9a-f]'; }
wait_player() {
  for _ in $(seq 1 60); do
    player_up && return 0
    if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
      printf 'button Run Deus Ex\nsleep 500\n' > /tmp/galaxy-output-recover.txt; node ad/scripts/original-game.mjs run /tmp/galaxy-output-recover.txt >/dev/null 2>&1
    fi
    sleep 5
  done
  return 1
}
node ad/scripts/original-game.mjs launch 00_Training.dx || { release_bottle; exit 1; }
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(game_pids | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -n "$(game_pids)" ] || return 0; sleep 1; done
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
}
trap 'quit_game; release_bottle' EXIT
wait_player || { echo "the player never came up" >&2; exit 1; }
PID=$(game_pids | head -1)
sleep 5
"$DX_WINE" ad/build/dx-live-win.exe galaxy poll "$COUNT" "$INTERVAL" "$OUT/training-load1" || exit 1
printf 'cmd open 00_Training\n' > /tmp/galaxy-output-open.txt
node ad/scripts/original-game.mjs run /tmp/galaxy-output-open.txt >/dev/null 2>&1
sleep 20
wait_player || { echo "the player never came back after the load" >&2; exit 1; }
sleep 5
"$DX_WINE" ad/build/dx-live-win.exe galaxy poll "$COUNT" "$INTERVAL" "$OUT/training-load2" || exit 1
echo "stored in $OUT"
