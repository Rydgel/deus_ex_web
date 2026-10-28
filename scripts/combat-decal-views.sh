#!/usr/bin/env bash
# Bullet holes and scorch marks in a frame of the original and of Play (docs/decals.md "Combat decals against the original"):
# 00_Training's start doors, decals placed by the original's own Summon on the wall (surface 88) and on DeusExMover49's leaf.
#
#   scripts/combat-decal-views.sh play       Play's frames (writes the plan; run it again after `original` for the held clock)
#   scripts/combat-decal-views.sh original   the original's, under the Wine lock (scripts/original-views.sh)
#   scripts/combat-decal-views.sh compare    frames, the decals' contributions and their state, bit for bit
#
# PlayerPawn.Summon spawns at Location + (CollisionRadius + Default.CollisionRadius + 30) Vector(Rotation) + 15 z, here
# 20 + 0 + 30 = 50 units ahead: the ghost stands 34 units behind the face, facing +X, so the decal spawns 16 units in front of it
# and its trace back meets the face 15 units above the player. `@rng 11223344` starts the next summon from that CRT rand state in
# both programs (ScorchMark's texture draw and AttachDecal's random direction).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
R='(Pitch=0,Yaw=0,Roll=0)'
at() { echo "set DeusEx.JCDentonMale Location (X=$1,Y=$2,Z=$3)"; }
CMDS=(
  # the wall (x -1184): the scorch first, then two bullet holes over it -> TArray [ScorchMark0, BulletHole1, BulletHole0]
  "$(at -1218 716 -55)" "set DeusEx.JCDentonMale ViewRotation $R" "set DeusEx.JCDentonMale Rotation $R" "@rng 11223344" "summon ScorchMark"
  "$(at -1218 718 -53)" "set DeusEx.JCDentonMale Rotation $R" "summon BulletHole"
  "$(at -1218 714 -56)" "set DeusEx.JCDentonMale Rotation $R" "summon BulletHole"
  # DeusExMover49's leaf (x -1188): a bullet hole first, then the scorch, then a bullet hole -> [BulletHole3, BulletHole2, ScorchMark1]
  "$(at -1222 800 -55)" "set DeusEx.JCDentonMale Rotation $R" "summon BulletHole"
  "$(at -1222 802 -53)" "set DeusEx.JCDentonMale Rotation $R" "@rng 11223344" "summon ScorchMark"
  "$(at -1222 798 -57)" "set DeusEx.JCDentonMale Rotation $R" "summon BulletHole"
)
VIEWS=(--view wide:-1010,800,-80:0,32768,0 --view wall:-1134,716,-80:0,32768,0 --view door:-1138,800,-80:0,32768,0
  --view wide-base:-1010,800,-80:0,32768,0 --view wall-base:-1134,716,-80:0,32768,0 --view door-base:-1138,800,-80:0,32768,0)
ARGS=(--maps 00_Training --brightness 0.666667 --decal-state "${VIEWS[@]}")
for c in "${CMDS[@]}"; do ARGS+=(--cmd "$c"); done
case "${1:-}" in
  play) exec node scripts/visual-acceptance.mjs play "${ARGS[@]}" --base decal ;;
  original) exec scripts/original-views.sh 00_Training "${ARGS[@]}" --base-cmd 'set WinDrv.WindowsClient Decals False' ;;
  compare) exec node scripts/visual-acceptance.mjs compare --maps 00_Training "${VIEWS[@]:0:6}" --decal-state --contribution ;;
  *) echo "usage: combat-decal-views.sh play|original|compare" >&2; exit 2 ;;
esac
