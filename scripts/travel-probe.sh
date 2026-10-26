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
#     ini:<label>               the session's ini files and their modification times -> .work/travel/<tag>/<label>.* (docs/config-persistence.md)
#     snap:<label>              save directory listing, engine log, player flags, travel text -> .work/travel/<tag>/<label>.*
#     actors:<name>:<label>     tools/dump-actor-win.c for objects named like <name> -> .work/travel/<tag>/<label>.actors.txt
#     putcurrent:<file>:<name>  copy a host file over Save\Current\<name> (a file of Play's, to see the original load it)
#     savecopy:<label>          a copy of Save\Current -> .work/travel/<tag>/<label>.Current/ (the .dxs files and their times)
#     putslot:<host dir>:<slot> a save slot Play wrote (a host directory of .dxs files) as Save\<slot> (Save0010, QuickSave; replaced whole), to see the original load it
#     slotcopy:<slot>:<label>   a copy of Save\<slot> -> .work/travel/<tag>/<label>.<slot>/ (the files the original wrote for a SaveGame, with their times)
#     savedir:<label>:<dir>     a copy of Save\<dir> (a slot the session made, QuickSave) -> .work/travel/<tag>/<label>.<dir>/ (the probe removes what it created at the end)
#     gobjects:<label>          every object of GObjObjects (index, name, class; tools/dump-gobjects-win.c --available) -> <label>.gobjects.txt
#     gflags:<label>            the same with each object's address, ObjectFlags and Outer, and the root set (dump-gobjects-win.c --flags) -> <label>.gflags.txt
#     props:<name>:<label>:<field:offset:type>[,...]   tools/dump-actor-win.c with explicit fields -> <label>.props.txt
#     shot:<name>               the game's Shot key -> .work/travel/<tag>/<name>.png
#     hold:<key>:<ms>           dxinput: a key held down for that long (the player walks), then released
#     key:<name> | type:<text> | click:<x y> | move:<x y>   dxinput key (ESC, ENTER ...), text, / mouse (viewport client coordinates; the viewport is 1280x720)
#     follow:<file>             run the steps appended to <file> (one per line) until a `quit` line: an interactive session
#   The game starts on DX.dx whatever the command line says (the logo map): a session that wants another map starts with `cmd:open <map>`.
#   Console lines are typed through the Talk key and can lose characters on a loaded host: check each step's effect with `arrive`/`snap`.
#   DX_KEEP_SAVE=1 leaves Save/ as the session left it (default: the files this session created in Save/ are removed at the end).
#   DX_SAVE_BACKUP=<dir>: Save/ is copied to <dir> under the lock before the game starts and put back whole after it quit (a session that overwrites QuickSave, or
#   SaveGame/DeleteGame on the player's own slots, leaves the prefix as it found it; the files created and removed above do not matter then).
#   e.g. scripts/travel-probe.sh t1 'cmd:set LevelInfo bPlayersOnly True' 'cmd:LocalTravel 00_TrainingCombat' 'arrive:00_trainingcombat$' snap:combat
set -u
TAG=${1:?usage: travel-probe.sh <tag> <step>...}; shift
if [ "${1:-}" != "${1#@}" ]; then   # steps from a file (a read loop: the Mac's bash 3.2 has no mapfile)
  STEPS=()
  while IFS= read -r line; do STEPS+=("$line"); done < <(grep -v '^[[:space:]]*#' "${1#@}" | grep -v '^[[:space:]]*$')
else
  STEPS=("$@")
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ "$(uname)" = Darwin ]; then
  # the Mac: the CrossOver bottle "DeusEx" (scripts/live-original.sh's branch); no flock there, so the lock is advisory only
  LOCK=${DX_LOCK:-$ROOT/.work/wine-deusex.lock}
  export CX_BOTTLE=${CX_BOTTLE:-DeusEx} DX_WINE=${DX_WINE:-/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine}
  export DX_GAME=${DX_GAME:-$HOME/Library/Application Support/CrossOver/Bottles/$CX_BOTTLE/drive_c/Deus Ex GOTY Edition}
else
  LOCK=${DX_LOCK:-/home/rydgel/projects/deus_ex_web/.work/wine-deusex.lock}
  export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
  export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
  export DX_DESKTOP=${DX_DESKTOP-1400x860}
fi
OUT=$ROOT/.work/travel/$TAG
mkdir -p "$OUT"
cd "$ROOT" || exit 1
exec 9>"$LOCK"
if command -v flock >/dev/null; then flock 9; else echo "no flock: $LOCK is not taken" >&2; fi
game_pids() { ps -e -o pid=,comm= | awk '/DeusEx\.exe$/ {print $1}'; }
for _ in $(seq 1 360); do [ -n "$(game_pids)" ] || break; sleep 5; done
[ -z "$(game_pids)" ] || { echo "a DeusEx.exe is still running; not starting" >&2; exit 9; }
SAVE="$DX_GAME/Save"
BEFORE=$(cd "$SAVE" 2>/dev/null && find . -type f | sed 's|^\./||' | sort)
if [ -n "${DX_SAVE_BACKUP:-}" ]; then rm -rf "$DX_SAVE_BACKUP"; cp -a "$SAVE" "$DX_SAVE_BACKUP" || { echo "cannot back up $SAVE" >&2; exit 1; }; fi
node ad/scripts/original-game.mjs launch DX.dx || exit 1
PID=
quit_game() {
  [ -n "$PID" ] || PID=$(game_pids | head -1)
  node ad/scripts/original-game.mjs quit >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -n "$(game_pids)" ] || break; sleep 1; done
  if [ -n "$(game_pids)" ] && [ -n "$PID" ]; then kill "$PID" 2>/dev/null; fi   # the one this script started (the lock keeps others out)
  cp "$DX_GAME/System/DeusEx.log" "$OUT/final.log" 2>/dev/null
  if [ -n "${DX_SAVE_BACKUP:-}" ] && [ -d "$DX_SAVE_BACKUP" ] && [ -z "$(game_pids)" ]; then   # the game is gone: Save/ goes back as it was found (the lock is still held)
    rm -rf "$SAVE" && cp -a "$DX_SAVE_BACKUP" "$SAVE" && echo "Save restored from $DX_SAVE_BACKUP" >&2
  elif [ -z "${DX_KEEP_SAVE:-}" ]; then   # leave Save/ as it was found: remove what this session created
    AFTER=$(cd "$SAVE" 2>/dev/null && find . -type f | sed 's|^\./||' | sort)
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
run_step() {
  local step=$1 kind arg
  kind=${step%%:*}; arg=${step#*:}
  case $kind in
    cmd|arrive|snap|shot|key|type|click|move|ini|savecopy|gobjects|gflags) scripts/travel-step.sh "$OUT" "$kind" "$arg" ;;
    props) IFS=: read -r pname plabel pfields <<< "$arg"; IFS=, read -ra pf <<< "$pfields"; scripts/travel-step.sh "$OUT" props "$pname" "$plabel" "${pf[@]}" ;;
    actors) scripts/travel-step.sh "$OUT" actors "${arg%%:*}" "${arg#*:}" ;;
    savedir) scripts/travel-step.sh "$OUT" savedir "${arg%%:*}" "${arg#*:}" ;;
    hold) scripts/travel-step.sh "$OUT" hold "${arg%%:*}" "${arg#*:}" ;;
    putcurrent)   # <host file>:<name>: a file into Save\Current (cp over the one the session wrote; the name has no path)
      IFS=: read -r psrc pname <<< "$arg"
      case $pname in ''|*/*|*\\*) echo "putcurrent: bad name $pname" >&2 ;; *) cp -f "$psrc" "$SAVE/Current/$pname" && echo "putcurrent $pname ($(wc -c < "$SAVE/Current/$pname" | tr -d ' ') bytes)" ;; esac ;;
    putslot)   # <host dir>:<slot>: Play's files for a slot, whole (the slot's directory is replaced)
      IFS=: read -r psrc pslot <<< "$arg"
      case $pslot in ''|*/*|*\\*|Current) echo "putslot: bad slot $pslot" >&2 ;; *) rm -rf "${SAVE:?}/$pslot"; mkdir -p "$SAVE/$pslot" && cp -f "$psrc"/* "$SAVE/$pslot/" && echo "putslot $pslot ($(ls "$SAVE/$pslot" | wc -l) files)" ;; esac ;;
    slotcopy)  # <slot>:<label>
      IFS=: read -r pslot plabel <<< "$arg"; rm -rf "$OUT/$plabel.$pslot"; cp -a "$SAVE/$pslot" "$OUT/$plabel.$pslot" 2>/dev/null ;;
    wait) sleep "$arg" ;;
    *) echo "unknown step $step" >&2 ;;
  esac
}
for step in "${STEPS[@]}"; do
  case $step in
    follow:*)   # steps appended to a file by hand (a session driven interactively): until a `quit` line
      file=${step#follow:}; done_lines=0
      while :; do
        total=$(wc -l < "$file" 2>/dev/null || echo 0)
        while [ "$done_lines" -lt "$total" ]; do
          done_lines=$((done_lines + 1)); line=$(sed -n "${done_lines}p" "$file")
          [ "$line" = quit ] && break 2
          [ -n "$line" ] && run_step "$line"
        done
        sleep 1
      done ;;
    *) run_step "$step" ;;
  esac
done
