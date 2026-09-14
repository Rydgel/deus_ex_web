# Engine Actor collision size / overlap / radius / visibility natives

The authority for these four natives is the installed GOTY `System/Engine.u`
and hash-pinned `System/Engine.dll`:

```text
Engine.dll SHA-256  0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4
Actor.uc            the native() declarations quoted below
```

Each thunk is the exported `UObject::exec*` entry; its `E9`/`E8` target is
the recovered body. Native indices and `out`/`optional` parameter flags come
from the Engine.u exports, not from the declaration text.

| Index | Declaration | Exec/body | Key instructions |
| --- | --- | --- | --- |
| 283 | `final function bool SetCollisionSize (float NewRadius, float NewHeight)` | exec `0x103e19f0`, body `0x10369320` (thunk `0x10303d64`) | `NewRadius`/`NewHeight` evaluated in order into stack buffers, then `this` + both raw dwords pushed into the body; `*Result = 1` unconditionally |
| 718 | `final function bool IsOverlapping (actor checkActor)` | exec `0x1036ddb0`, body `0x10369430` (thunk `0x103029be`) | `checkActor` evaluated once; a null reference writes `0` without entering the body |
| 310 | `final iterator function RadiusActors (class<actor> BaseClass, out actor Actor, float Radius, optional vector Loc)` | exec `0x103e4fa0` | four argument evaluations, `Loc` buffer pre-stored from `this->+0x114`, Level->Actors array scan with Class-ancestry filter and a strict x87 radius predicate |
| 311 | `final iterator function VisibleActors (class<actor> BaseClass, out actor Actor, optional float Radius, optional vector Loc)` | exec `0x103e5260` | same skeleton plus a pre-zeroed `Radius` buffer, an `+0x28` bit-2 skip, a `Radius == 0.0` distance-gate bypass and a `Level->Model->FastLineCheck` visibility call |
| 298 | `final function SetBase (actor NewBase)` | exec `0x103e1a90`, body `0x10369c80` (thunk `0x10301285`) | `NewBase` evaluated once, then the C++ body called with `(this, NewBase, 1)` — the notify literal is the BaseChange gate |
| 306 | `final iterator function BasedActors (class<actor> BaseClass, out actor Actor)` | exec `0x103e4800` | two argument evaluations, Level->Actors scan with the Class-ancestry filter and `candidate->+0xc4 == this` |

## Recovered semantics

### 283 `SetCollisionSize` — exec `0x103e19f0`, body `0x10369320`

The body reads `*(this+0x1dc) & 1` (bCollideActors); when set and
`Level->+0xf8` (the collision hash) is non-null it calls vtable `+0xc`
(RemoveActor). It then re-reads `*(this+0x1dc)` and stores `NewRadius` to
`this->+0x1d4` and `NewHeight` to `this->+0x1d8` as raw dwords — float32
bit patterns pass through verbatim, including negative sizes. When the
re-read collide bit is still set and the hash is non-null it calls vtable
`+0x8` (AddActor). The exec writes `*Result = 1` unconditionally.

Cases (`scripts/native-set-collision-size-oracle.py` →
`validate-native-set-collision-size.mjs`, 5 cases):

- `collide × hash ∈ {1,0}` — the hash slots record the actor's live size at
  call time: `remove` observes the old fields, `add` the new; no calls at
  all without the collide bit or a null hash pointer.
- Non-f32-exact and negative sizes — stored verbatim.
- A binding-level pass drives `invokeNative(283)` on a collision-view
  receiver and asserts the `[0,1]` evaluation order and the result — a
  mutation writing the fields before `removeActor` is caught by the event
  payload.

### 718 `IsOverlapping` — exec `0x1036ddb0`, body `0x10369430`

The body excludes the pair when `this->+0x178` (Primitive) is non-null and
`this`'s class ancestry reaches `class'Brush'` (`0x10582a28`), and
identically for `checkActor`; a Primitive without Brush ancestry does not
exclude. It also excludes `checkActor == this->+0xa8` (the LevelInfo world
actor). Both cylinders must then pass a strict x87 test:
`(Ra+Rb)^2 > dx^2+dy^2` and `(Ha+Hb)^2 > dz^2` — `fcompp` publishes the
carry/zero flags, so equal distances are not overlapping.

Cases (`scripts/native-is-overlapping-oracle.py` →
`validate-native-is-overlapping.mjs`, 12 cases): horizontal and vertical
boundaries at exactly `Ra+Rb`/`Ha+Hb` (excluded) and just inside
(included), the world-actor exclusion, the Brush-primitive exclusion on
either side, a Primitive-carrying non-Brush actor (not excluded), and the
null `checkActor` short circuit. A binding-level pass drives
`invokeNative(718)`; mutations removing either exclusion or relaxing the
strict comparison are caught.

The host view models the Primitive+Brush conjunction as `actor.movingBrush`
(`Boolean(values.Brush) && lineage includes engine.brush`); non-brush
Primitive carriers keep `movingBrush = false`, matching the native's
non-exclusion.

### 310 `RadiusActors` — `0x103e4fa0`

The exec evaluates `BaseClass`, the `out Actor` expression (through
`GPropAddr`, non-assignable expressions landing in a private temporary),
`Radius`, then copies `this->+0x114` into the `Loc` buffer before
evaluating the optional `Loc` expression. A null `BaseClass` result is
replaced by `class'Actor'` (`0x1057cdf0`) after all arguments.

Each resume clears the out slot and continues the `Level->+0x2c/+0x30`
actor-array scan from a saved index — null slots are skipped, candidates
must satisfy a `Class`/`+0x28` ancestry walk against `BaseClass`, and the
predicate is `strict`: `(Radius + candidate.CollisionRadius(+0x1d4))^2 >
sum((candidate.Location - Loc)^2)` over all three axes — `fcompp` +
`test ah,0x41` excludes equal and unordered distances. There is no self or
owner exclusion. Natural exhaustion leaves the out slot cleared; an early
`IteratorPop` keeps the last published actor.

Cases (`scripts/native-radius-actors-oracle.py` →
`validate-native-radius-actors.mjs`, 10 cases): default and explicit
`BaseClass` filters (Mover vs Actor candidates), the `Loc` override, the
strict boundary (`dist == Radius + CollisionRadius` excluded, `dist`
marginally inside yielded), null array slots, array-order yields including
the receiver itself, early-break out retention, the `z` axis term and a
negative `Radius` (squared, still matching near actors). Mutations
relaxing the comparison, dropping the `CollisionRadius` term, skipping
self, removing the class filter or skipping the per-resume out clear are
all caught.

### 311 `VisibleActors` — `0x103e5260`

Same argument skeleton with the `Radius` buffer pre-zeroed (the optional
default) before its expression runs, and the `Loc` buffer pre-stored from
`this->+0x114` before the last argument. The scan applies, in order: null
slot skip, `candidate->+0x28 & 2` (bHidden) skip, the Class ancestry walk,
then — only when `Radius` compares ordered-nonzero to the double constant
`0.0` — `Radius^2 > sum(d^2)` strictly, with **no** `CollisionRadius` term.
Survivors call `Level->+0x98->FastLineCheck(candidate.Location, Loc)`
(thunk `0x10301a37` → `UModel::FastLineCheck 0x103f3280`) and yield on a
nonzero `AL` byte.

Cases (`scripts/native-visible-actors-oracle.py` →
`validate-native-visible-actors.mjs`, 9 cases): `Radius` absent/zero keeps
far candidates (the gate is bypassed, not failed), the hidden-flag skip
runs before the visibility call (a hidden candidate never reaches
`FastLineCheck`), the strict boundary and the `Loc` override are measured
through the recorded query vectors, per-candidate visibility results and
class filtering, negative `Radius` (squared), and early-break out
retention. Mutations dropping the hidden skip, applying the distance gate
at `Radius == 0` or swapping the `FastLineCheck` arguments are caught.

### 298 `SetBase` — exec `0x103e1a90`, body `0x10369c80`

The exec evaluates `NewBase` once, then calls the body as
`SetBase(this, NewBase, 1)` — the `1` literal is the BaseChange notify
flag. The body (`AActor::SetBase`) first walks `NewBase`'s `+0xc4` chain:
any link equal to `this` returns without side effects. A `NewBase` equal to
the current `+0xc4` also returns. Otherwise the old base's `+0xd8` byte is
decremented and `Detach` is dispatched on it — unless the old base is
`this->+0xa8` (LevelInfo). `+0xc4` is then stored, the new base's `+0xd8`
byte incremented and `Attach` dispatched on it — again skipped for the
world actor. The notify flag gates the final `BaseChange` dispatch on the
receiver. Events run through vtable `+0x10` (`ProcessEvent`) with the
receiver as the single argument, and the `+0xd8` counts wrap as bytes.

Cases (`scripts/native-set-base-oracle.py` →
`validate-native-set-base.mjs`, 9 cases): the Detach → store → Attach →
BaseChange order (each event records the live `+0xc4`), the same-base and
null no-ops, the world exclusion on both ends, the self-ancestry guard
including a two-hop chain, and the `&0xff` wrap at 255. Mutations removing
the guard, either exclusion, the store ordering, the early out or the byte
width are caught.

### 306 `BasedActors` — `0x103e4800`

The exec evaluates `BaseClass` and the out `Actor` expression, defaults a
null `BaseClass` to `class'Actor'` (`0x1057cdf0`), clears the out slot and
resumes the `Level->+0x2c/+0x30` actor-array scan from a saved index. A
candidate yields when it is non-null, its Class ancestry reaches
`BaseClass` and `candidate->+0xc4` (Base) is the receiver — there is no
other exclusion, distance or visibility test. Natural exhaustion leaves
the out slot cleared; an early `IteratorPop` keeps the last publish.

Cases (`scripts/native-based-actors-oracle.py` →
`validate-native-based-actors.mjs`, 8 cases): array order, unbased and
other-based candidates skipped, the Mover ancestry filter, null slots, a
LevelInfo candidate still yielding, the receiver itself not yielding
(its own `+0xc4` is not itself), and early-break out retention. Mutations
dropping the class filter, the Base test or the per-resume out clear are
caught.

## Runtime binding notes

- `invokeNative(283)` remains gated on `collisionViewActors`: the spawned
  actor view routes `radius`/`height` through the real field storage that
  `values.CollisionRadius`/`collisionValues` expose to the hash, so
  remove/add observe correct bounds. Map actors carry `values` as a static
  decode-time snapshot — writing `.radius` would not feed the hash's
  re-add bounds, so widening the gate needs field-storage evidence first.
- `invokeNative(718)` accepts any receiver carrying the actor view
  (`worldActor`/`position`/`radius`/`height`/`movingBrush`); a null
  `checkActor` returns `false` without touching the receiver, matching the
  exec.
- `createIterator(310/311/306)` requires `actorClass` and `levelFor`; the
  candidate class test is `IsChildOf` over the attached instance's `cls`
  chain — the same walk `AllActors` performs — so map actors and spawned
  actors both filter correctly. `311` resolves `level.model` and
  `level.fastLineCheck ?? fastLineCheck` (the ported `UModel::FastLineCheck`)
  per resume. `306` reads the candidate's `Base` through
  `fieldReference(actor, 'Base')` and compares object identity to the
  receiver.
- `invokeNative(298)` remains gated on `collisionViewActors` like the other
  attachment natives — the receiver needs the `base`/`worldActor`/
  `standingCount` view — and delegates to the already-validated `setBase`
  port with `notify=true`, matching the exec's `(NewBase, 1)` call.
