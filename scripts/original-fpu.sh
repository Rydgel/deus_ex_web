#!/usr/bin/env bash
# The x87 control word the running original has where the lighting code runs, and its light-manager tables
# (docs/render-pass-precision.md "Measured in the running original"), under the shared Wine lock: only one DeusEx.exe
# may run on this prefix at a time (other agents capture with it too).
#
# Launches DeusEx.exe on <map> as a debuggee of tools/dx-fpu-win.c (so the code that runs once at start is reached too),
# breaks at the lighting entry points for <seconds>, dumps the tables, ends the game by the PID the tool created.
#
#   scripts/original-fpu.sh <map> [seconds] [outdir]     (default 01_NYC_UNATCOIsland 150 .work/fpu)
set -u
MAP=${1:-01_NYC_UNATCOIsland}; SECONDS_RUN=${2:-150}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${3:-$ROOT/.work/fpu}
LOCK=/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
cd "$ROOT" || exit 1
mkdir -p "$OUT"
exec 9>"$LOCK"
flock 9
# another agent's game may still be closing (it is not always started under the lock): wait for it, up to 30 minutes
for _ in $(seq 1 360); do pgrep -x DeusEx.exe >/dev/null || break; sleep 5; done
if pgrep -x DeusEx.exe >/dev/null; then echo "a DeusEx.exe is still running; not starting" >&2; exit 9; fi
node -e "import('./ad/scripts/original-game.mjs').then(m => m.writeIni())" || exit 1
Z() { printf 'Z:%s' "$(printf '%s' "$1" | tr / '\\')"; }
specs=(
  # game thread
  frame=Engine.dll:0x1038f110                 # UGameEngine::Draw entry: the frame starts
  tick=Engine.dll:0x103a51a0:n=2              # ULevel::Tick entry
  fghsv=Engine.dll:0x103ec8d0:n=8             # FGetHSV, from GlobalLighting / SetupForSurf / SetupForActor
  enable-fastmath=Core.dll:0x1016e050:n=4     # appEnableFastMath: its caller says PreRender or PostRender
  # Galaxy's Update (game thread, inside UGameEngine::Draw before PreRender) and its GlobalLighting call for a lit ambient sound
  galaxy-update=Galaxy.dll:0x10609510:n=2
  galaxy-lighting-call=Galaxy.dll:0x1060992e:ret:n=10
  # the pass
  prerender-entry=Render.dll:0x10b14560       # URender::PreRender entry, before appEnableFastMath(1)
  pass-open=Render.dll:0x10b1462f:ret         # right after appEnableFastMath(1)
  light-noise=Render.dll:0x10b13080:n=2
  postrender-entry=Render.dll:0x10b14700      # before appEnableFastMath(0)
  pass-close=Render.dll:0x10b14732:ret        # right after appEnableFastMath(0)
  setupdynamics=Render.dll:0x10b22d90:n=2
  dyn-filter=Render.dll:0x10b24a10:n=4
  drawframe=Render.dll:0x10b1a2d0:n=4
  setupforsurf=Render.dll:0x10b06c90:n=12
  globallighting=Render.dll:0x10b05e90:n=60
  computefromactor=Render.dll:0x10b05fa0:n=12
  body-normal=Render.dll:0x10b03360:n=3
  body-spot=Render.dll:0x10b04f80:n=3
  body-nonincidence=Render.dll:0x10b054e0:n=3
  body-cylinder=Render.dll:0x10b04a80:n=3
  body-searchlight=Render.dll:0x10b03770:n=3
  body-slowwave=Render.dll:0x10b03de0:n=3
  body-fastwave=Render.dll:0x10b040b0:n=3
  body-cloudcast=Render.dll:0x10b04380:n=3
  body-shock=Render.dll:0x10b043a0:n=3
  body-disco=Render.dll:0x10b046f0:n=3
  body-interference=Render.dll:0x10b04c80:n=3
  body-rotor=Render.dll:0x10b03ae0:n=3
  body-shell=Render.dll:0x10b05740:n=3
  merge=Render.dll:0x10b03040:n=3
  setupforactor=Render.dll:0x10b08c70:n=12
  light-mesh=Render.dll:0x10b027f0:n=12
  leafvolumetric=Render.dll:0x10b170e0:n=4
  # start-up: the cooperative level call (DDSCL_FPUSETUP), URender::Init, FLightManager::Init
  coop-before=D3DDrv.dll:0x1000b18e:ret
  coop-after=D3DDrv.dll:0x1000b191:ret
  urender-init=Render.dll:0x10b13460
  lightmanager-init=Render.dll:0x10b02080
  # the light manager's tables, as the original holds them at the end
  "dump=$(Z "$OUT/sqrt.bin"):0x10b3e1b8:8192"
  "dump=$(Z "$OUT/normal.bin"):0x10b34a6c:16384"
  "dump=$(Z "$OUT/shadow.bin"):0x10b3cae0:2048"
  "dump=$(Z "$OUT/rsqrt-mantissa.bin"):0x10b33650:4096"
  "dump=$(Z "$OUT/rsqrt-exponent.bin"):0x10b3d384:2048"
)
echo "map $MAP, $SECONDS_RUN s, out $OUT"
"$DX_WINE" ad/build/dx-fpu-win.exe cw launch "$SECONDS_RUN" "${specs[@]}" -- \
  'C:\Deus Ex GOTY Edition\System\DeusEx.exe' "$MAP.dx" INI=DeusEx-ad.ini USERINI=User-ad.ini >"$OUT/cw-$MAP.txt" 2>"$OUT/cw-$MAP.err" &
TOOL=$!
# a game that was ended from outside starts in Recovery Mode: answer that wizard (it blocks the start-up)
GAME_PID=
for _ in $(seq 1 40); do
  kill -0 "$TOOL" 2>/dev/null || break
  [ -n "$GAME_PID" ] || GAME_PID=$(pgrep -x DeusEx.exe | head -1)
  if node ad/scripts/original-game.mjs find 2>/dev/null | grep -q 'Recovery Mode'; then
    printf 'button Run Deus Ex\nsleep 500\n' > "$OUT/recover.txt"; node ad/scripts/original-game.mjs run "$OUT/recover.txt" >/dev/null 2>&1; echo "answered the Recovery Mode wizard"; break
  fi
  sleep 3
done
wait "$TOOL"
cat "$OUT/cw-$MAP.txt"
# the tool detached; quit the game through its own exit, and by its PID if that does not end it
[ -n "$GAME_PID" ] || GAME_PID=$(pgrep -x DeusEx.exe | head -1)
node ad/scripts/original-game.mjs quit >/dev/null 2>&1
for _ in $(seq 1 20); do pgrep -x DeusEx.exe >/dev/null || break; sleep 1; done
# it did not exit on its own: it is the one this script started (the lock keeps others out)
if [ -n "$GAME_PID" ] && kill -0 "$GAME_PID" 2>/dev/null; then kill "$GAME_PID" 2>/dev/null; sleep 2; fi
exit 0
