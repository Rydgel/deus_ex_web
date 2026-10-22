#!/usr/bin/env bash
# One step on an already running original Deus Ex (under Wine): the verbs of scripts/travel-probe.sh, for a session driven by hand.
# The caller holds the Wine lock (scripts/travel-probe.sh does; by hand take `flock` on the lock file around the whole session).
#
#   scripts/travel-step.sh <out dir> cmd <console line>
#   scripts/travel-step.sh <out dir> arrive <regex>         wait (up to 150 s) until a Level whose URL.Map matches, then 3 s more
#   scripts/travel-step.sh <out dir> snap <label>           save directory listing, log copy, player flags, travel text -> <out dir>/<label>.*
#   scripts/travel-step.sh <out dir> actors <name> <label>  tools/dump-actor-win.c for objects named like <name> -> <out dir>/<label>.actors.txt
#   scripts/travel-step.sh <out dir> shot <name>            the game's Shot key -> <out dir>/<name>.png
#   scripts/travel-step.sh <out dir> ini <label>            the session's ini files (DeusEx-ad.ini, User-ad.ini) and their modification times -> <out dir>/<label>.DeusEx.ini, .User.ini, .ini-times.txt (docs/config-persistence.md)
#   scripts/travel-step.sh <out dir> key <name> | type <text> | click <x> <y> | move <x> <y>   dxinput key (names as dxinput.c: ESC, ENTER, F9 ...), text, mouse (viewport client coordinates)
set -u
OUT=${1:?usage: travel-step.sh <out dir> <verb> ...}; VERB=${2:?}; shift 2
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-deusex} DX_WINE=${DX_WINE:-/usr/bin/wine}
export DX_GAME=${DX_GAME:-$WINEPREFIX/drive_c/Deus Ex GOTY Edition}
export DX_DESKTOP=${DX_DESKTOP-1400x860}
mkdir -p "$OUT"
cd "$ROOT" || exit 1
SAVE="$DX_GAME/Save"
clean() { grep -a -v 'MESA\|pci id' | tr -d '\r'; }
case $VERB in
  cmd) printf 'cmd %s\n' "$*" > "$OUT/step.txt"; node ad/scripts/original-game.mjs run "$OUT/step.txt" >/dev/null 2>&1
       echo "$(date +%T) cmd $*" >> "$OUT/steps.txt" ;;
  key|click|move|type) printf '%s %s\nsleep 1500\n' "$VERB" "$*" > "$OUT/step.txt"; node ad/scripts/original-game.mjs run "$OUT/step.txt" >/dev/null 2>&1
       echo "$(date +%T) $VERB $*" >> "$OUT/steps.txt" ;;
  arrive) ok=
          for _ in $(seq 1 30); do
            if "$DX_WINE" ad/build/dump-travel-win.exe 2>/dev/null | clean | grep -aiE "URL.Map: .*($1)" >/dev/null; then ok=1; break; fi
            sleep 2
          done
          result=${ok:+ok}; echo "$(date +%T) arrive $1 ${result:-TIMEOUT}" >> "$OUT/steps.txt"; sleep 3 ;;
  snap) ( cd "$SAVE" 2>/dev/null && find . -mindepth 1 -printf '%y %P\t%s\t%TY-%Tm-%Td %TH:%TM:%TS\n' | sort -k2 ) > "$OUT/$1.save.txt"
        cp "$DX_GAME/System/DeusEx.log" "$OUT/$1.log" 2>/dev/null
        "$DX_WINE" ad/build/dump-flags-win.exe JCDentonMale 2>/dev/null | clean > "$OUT/$1.flags.txt"
        "$DX_WINE" ad/build/dump-travel-win.exe 2>/dev/null | clean > "$OUT/$1.travel.txt"
        echo "$(date +%T) snap $1" >> "$OUT/steps.txt" ;;
  ini) cp "$DX_GAME/System/DeusEx-ad.ini" "$OUT/$1.DeusEx.ini"; cp "$DX_GAME/System/User-ad.ini" "$OUT/$1.User.ini"
       stat -c '%n %s %y' "$DX_GAME/System/DeusEx-ad.ini" "$DX_GAME/System/User-ad.ini" > "$OUT/$1.ini-times.txt"
       echo "$(date +%T) ini $1" >> "$OUT/steps.txt" ;;
  actors) "$DX_WINE" ad/build/dump-actor-win.exe "$1" 'Player:0x5d4:u32' 'Health:0x428:u32' 'Deleted:0x28:bit:0x80' 2>/dev/null | clean > "$OUT/$2.actors.txt" ;;
  shot) # only a Shot file that did not exist before the key is converted and removed (the older ones belong to other captures)
        before=$(ls "$DX_GAME/System" | grep '^Shot[0-9]*\.bmp$' | sort)
        printf 'shot\nsleep 2500\n' > "$OUT/step.txt"; node ad/scripts/original-game.mjs run "$OUT/step.txt" >/dev/null 2>&1
        after=$(ls "$DX_GAME/System" | grep '^Shot[0-9]*\.bmp$' | sort)
        new=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
        if [ -z "$new" ]; then   # a UI screen grabs the keyboard: the root window's hard-coded Ctrl-F9 still takes the shot (DeusExRootWindow.uc:143)
          printf 'down CTRL\nkey F9\nup CTRL\nsleep 2500\n' > "$OUT/step.txt"; node ad/scripts/original-game.mjs run "$OUT/step.txt" >/dev/null 2>&1
          after=$(ls "$DX_GAME/System" | grep '^Shot[0-9]*\.bmp$' | sort)
          new=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
        fi
        if [ -n "$new" ]; then magick "$DX_GAME/System/$new" "$OUT/$1.png" && rm -f "$DX_GAME/System/$new"; else echo "no new Shot file for $1" >&2; fi
        echo "$(date +%T) shot $1 (${new:-none})" >> "$OUT/steps.txt" ;;
  *) echo "unknown verb $VERB" >&2; exit 2 ;;
esac
