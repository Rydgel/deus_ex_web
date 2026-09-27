# Original standalone SetBasedPawnSize

Contract before implementation: embedded DeusExPlayer.SetBasedPawnSize3187–3278,
GetDefaultCollisionHeight3283–3286 and ResetBasedPawnSize3275–3278, plus the native
SetCollisionSize/MoveActor contracts in docs/relocation.md and docs/move-query.md.
At this helper's original checkpoint the bounded script VM rejected the
722-byte function at opcode 0x3a; `.cache/stance/vm-scope.json` records that
historical limitation. Batch 6 Play executes the original function's bytecode
through ProcessMove, using the already recovered SetCollisionSize and
MoveActor bodies. The helper described below remains a source translation
for retained Stage 2 fixtures. See [the live player tick](script-player-tick.md).

Arguments are float32, negatives clamp to zero. Save original radius and height;
standalone unchanged dimensions return true before any other operation.
centerDelta is vect(0,0,1)*float32(newHeight-oldHeight). deltaEyeHeight is
float32(GetDefaultCollisionHeight()-Default.BaseEyeHeight); the original player
GetDefaultCollisionHeight returns float32(Default.CollisionHeight-4.5).

When BOTH newHeight<=currentHeight and newRadius<=currentRadius, first call
SetCollisionSize(newRadius,newHeight), then Move(centerDelta). A false Move
restores the original dimensions through a second SetCollisionSize call. Every
other change calls Move with the OLD dimensions first, resizing only when Move
returns true. Increasing radius with unchanged height uses a zero translation;
original tiny Move succeeds without a new-volume fit test. This seemingly weak
fit behavior must not be replaced by an overlap check.

Move success is the native boolean, not time==1 or a truthy hit object. A positive
partial movement succeeds; a failed movement may still have altered position
through its own callbacks. The script does not restore position. On success,
PrePivot-=centerDelta, BaseEyeHeight=newHeight-deltaEyeHeight,
EyeHeight-=centerDelta.Z, each through original float32 script stores. On failure,
these visual fields stay unchanged. An unchanged-size early return leaves them
unchanged even if their values are currently inconsistent.

This bounded helper handles NM_Standalone and no carried decoration. Multiplayer
changes equality/eye-height rules, and carried-decoration success reattaches and
relocates the decoration; these branches must be explicit unsupported errors
rather than silently omitting their effects. No stance flag or crouch dimensions
are invented: the caller supplies the values selected by original player script.

## Delivered helper and validation boundary

`src/runtime/stance.mjs` exports `setBasedPawnSize(pawn,radius,height)`,
`resetBasedPawnSize(pawn)` and `defaultPawnCollisionHeight(defaultHeight)`.
State fields are `radius`, `height`, `prePivot`, `baseEyeHeight`, `eyeHeight`,
`defaultCollisionHeight`, `defaultBaseEyeHeight`, `defaultCollisionRadius`
(the last for reset), `netMode` and `carriedDecoration`. Defaults are inherited
player class properties, not current dimensions. For JCDentonMale,
Default.CollisionHeight47.5 gives ordinary standing height43.

`pawn.setCollisionSize(radius,height)` must immediately mutate dimensions using
the original hash remove/store/add sequence. `pawn.move(delta)` must apply
movement and return a strict boolean, with positive partial-time native success
preserved. An object return is rejected so a collision result cannot accidentally
be treated as success. The helper itself never does overlap fitting or pose
rollback. `resetBasedPawnSize` calls the same helper with default radius and
GetDefaultCollisionHeight; it does not force a successful uncrouch.

Seven tests check source-prescribed callback order and state effects, including
partial failure pose retention, partial successful growth, radius-only zero
movement, negative clamp and unchanged-dimension early return. These are source
regressions, not whole-script native conformance. Its numerical movement boundary
is independently backed by404 native MoveActor comparisons including boolean;
SetCollisionSize is separately validated by the relocation harness. These
helper tests do not claim original VM execution; the former opcode0x3a
limitation is historical and does not describe batch 6 Play.

```sh
node --test test/stance.test.mjs test/move-query.test.mjs
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-native-move-query.mjs
```
