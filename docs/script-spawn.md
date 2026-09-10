# Original script `Actor.Spawn` contract

This is the source-first contract for the ordinary dynamic spawn path: an
`Actor.Spawn` call requesting a concrete, non-colliding script subclass whose
native base is `Actor`. The accepted concrete fixture is `CameraPoint`; its
native vtable and inherited Actor startup slots are verified below. Pawn
startup and the special brush, network, and collision-placement branches are
outside this bounded path; the notifier tail is included because its guards
are part of this `SpawnActor` body. The authority is the local GOTY
`System/Engine.dll` (`sha256
0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`) and the
embedded original `Actor.uc` declarations. Public engine headers are research
references only; the instruction addresses below establish the native behavior.

## Script wrapper

`Actor.uc` declares native index 278 as:

```uc
native(278) final function actor Spawn
(
    class<actor> SpawnClass,
    optional actor SpawnOwner,
    optional name SpawnTag,
    optional vector SpawnLocation,
    optional rotator SpawnRotation
);
```

The VM thunk at `0x103011ef` jumps to `execSpawn` at `0x103e36d0`. It evaluates
the five expressions in declaration order. The optional owner and tag start as
null/zero. The optional location and rotation start as copies of the caller's
`Actor+0x114` and `Actor+0x120`, respectively, and are overwritten if their
expressions are present. The location default-copy sequence starts at
`0x103e373f`, the rotation default-copy sequence at `0x103e377a`, and the
caller `Instigator` is read last at `0x103e3805`; these points preserve the
observable order when an optional expression itself executes. A null
`SpawnClass` writes a null result and returns before resolving the level.

The wrapper calls the caller's `GetLevel` (`0x10301d5c`) and dispatches the
level virtual slot `+0x9c` (`0x103e381e`–`0x103e3825`), whose implementation is
`ULevel::SpawnActor` at `0x10394f60` (export thunk `0x103016db`). The by-value
call has this layout:

```text
Class, NAME_None construction name, SpawnOwner, caller.Actor+0xbc (Instigator),
SpawnLocation[3], SpawnRotation[3],
Template = null, bNoCollisionFail = 0, bRemoteOwned = 0
```

The three zero words are pushed by the wrapper at `0x103e37d3`–`0x103e37d6`.
`SpawnOwner` and the caller's `Instigator` are distinct inputs. The wrapper
constructs the FName argument in a stack temporary at `0x103e3814`–
`0x103e3818`, pushing `EName=0` (`NAME_None`) through Core IAT `0x10599bb8`
(`??0FName@@QAE@W4EName@@@Z`). This is the native construction Name; the saved
script `SpawnTag` is not passed in this argument. After a non-null return, the
wrapper copies that saved tag to the returned actor's `+0xb0` at
`0x103e382f`–`0x103e3837`, then writes the script result at `0x103e383d`.
Consequently native construction and all SpawnActor callbacks see the class
identity initially written by SpawnActor, while the caller-supplied tag (even
`None`) is installed only after SpawnActor has completed. Every native failure
path returns null and skips this post-return tag write.

## Class and placement gates

`ULevel::SpawnActor` uses a 0x34-byte argument block and returns with
`retl $0x34`:

```text
+08 Class       +0c SpawnTag       +10 SpawnOwner   +14 Instigator
+18..20 Location                 +24..2c Rotation
+30 Template    +34 bNoCollisionFail             +38 bRemoteOwned
```

The first gates (`0x10394f81`–`0x103950b0`) are observable before any actor
array mutation:

* Null `Class` logs and returns null.
* A set bit 0 at `Class+0x484` logs and returns null. This is the serialized
  `ClassFlags` abstract bit (the package/layout evidence is below).
  `Actor.uc` declares the base `Actor` class `abstract`, so
  `Spawn(class'Actor')` takes this rejection branch. A concrete script
  subclass using the `Actor` native base must pass it.
* The class/super chain is followed through `+0x28` until the
  `AActor::PrivateStaticClass` object at `0x1057cdf0`. `AActor::StaticClass`
  is exported by Engine at thunk `0x103030da`; its body at `0x103234b0`
  returns that address. A chain that ends at null is rejected. This is the
  native ancestry check behind the `class<actor>` requirement.
* With imported Core global `GIsEditor == 0` (Engine IAT `0x10599c94`,
  `?GIsEditor@@3HA`), the class's `+0x4d8`/default data is checked and the
  default object at `Class+0x4d4` is required. Default-object flag word
  `+0x28` bits `0x1` and `0x4` each take the common failure path; these are
  the Actor flags `bStatic` and `bNoDelete`, respectively, as declared in
  `Actor.uc` and confirmed by the same native flag layout in
  `DestroyActor`. The meaning of `+0x4d8` remains unresolved. These checks
  remain distinct from the abstract test at `Class+0x484`.

The template used for construction is the explicit `Template` at `+0x30`, or
the class default object at `Class+0x4d4` when `Template` is null
(`0x103950bb`–`0x103950fb`). The ordinary wrapper always selects the latter.
The native `StaticConstructObject` helper at `0x10599db0` receives this
selected template/default, so default/property initialization occurs inside
that helper before SpawnActor's post-construction stores. No separate property
copy loop appears in SpawnActor.

For a non-colliding class, the placement probe is skipped. The exact gate is
still recorded here because the wrapper passes `bNoCollisionFail = 0`:

* If the selected object has neither the packed `+0x1dc` bit `0x2`
  (`bCollideWorld`) nor object flag `+0x28` mask `0x20000`
  (`bCollideWhenPlacing`), control goes directly to actor-array insertion
  (`0x103950fb`–`0x1039510b`).
* Otherwise, when level mode byte `LevelInfo+0x518` is not `3` and
  `bNoCollisionFail == 0`, the routine calls `FindSpot` through level vtable
  `+0xb0` at `0x10395170`–`0x103951ae`. It passes the selected
  `CollisionRadius`/`CollisionHeight` (`+0x1d4`/`+0x1d8`), the requested
  location, and options `(checkActors=0, checkFirst=1)`. A zero return fails
  the spawn. A nonzero `bNoCollisionFail` bypasses this probe.

## Native execution-frame initialization

The two native calls immediately before the first script event were initially
labelled backwards. The `AActor` vtable entries and the call sites establish
the actual mapping:

| SpawnActor site | vtable slot | base AActor target | body |
| --- | --- | --- | --- |
| `0x103954f6` | `+0x38` | `InitExecution@AActor` thunk `0x10302194` | `0x103deb40` |
| `0x103954fd` | `+0x74` | `Spawned@AActor` thunk `0x10303373` | `0x1030d730` (`ret`) |

For the accepted `CameraPoint` object (class object `0x10579240`), the Engine
`.rdata` vtable at `0x10427178` contains the same two pointers: vtable address `+0x38`
(`0x104271b0`) is `0x10302194`, and `+0x74` (`0x104271ec`) is `0x10303373`.
Therefore `SpawnActor` dispatches `CameraPoint` through the recovered
`AActor::InitExecution` body (`0x103deb40`) and the recovered no-op
`AActor::Spawned` body (`0x1030d730`); neither slot is a CameraPoint-specific
override in this build. The CameraPoint constructor's vtable installation is
recorded in [script-construction.md](script-construction.md).

`InitExecution@AActor` first calls the imported Core virtual
`?InitExecution@UObject@@UAEXXZ` through Engine IAT `0x10599ad0`. The Core
export thunk is `0x1010286f`, and its body is `0x10150750`. This is the helper
that creates the execution frame; it is not a second `Spawned` callback.

At `0x10150750`, Core asserts that `UObject+0x24` is present, releases the
old `UObject+0x0c` frame through that frame's vtable `+0x08` when non-null,
then asks the global allocator at `0x101a7c44` for exactly `0x28` bytes
(`0x101507ac`–`0x101507bb`). The new frame is initialized as follows before
being stored back at `UObject+0x0c` (`0x101507bd`–`0x10150800`):

```text
frame+0x00 = 0x10175088 temporarily, then 0x101752bc (frame vtable)
frame+0x04 = (object != null) ? object+0x24 : null (Node / class sentinel)
frame+0x08 = object
frame+0x0c = 0
frame+0x10 = 0
frame+0x14 = 0
frame+0x18 = object+0x24 (StateNode / initial class sentinel)
frame+0x1c = 0xffffffff (ProbeMask low)
frame+0x20 = 0xffffffff (ProbeMask high)
frame+0x24 = not written by this initialization (LatentAction)
object+0x1c |= 0x02000000
```

The standalone `FStateFrame` constructor (`Core` thunk `0x10102cc0`, body
`0x10115970`) writes the same fields and confirms the `+0x08` object pointer.
`GetStateFrame@UObject` (`0x10101069` → `0x1010ad30`) reads the object
pointer at `UObject+0x0c`. `+0x04` is the frame's `Node` pointer and `+0x18`
is its `StateNode`; both initially hold the object's class sentinel. Core
`IsProbing` (`0x10115670`) reads `+0x1c/+0x20` as the active low/high probe-mask
words for EName range `[0x12c,0x16c)`, so the constructor's two `0xffffffff`
stores mean all probe bits are set temporarily, not that no mask exists.
`+0x24` is the latent/action slot used by `GotoState` (`0x1012e8f0`) and
`GotoLabel` (`0x1012eb10`); neither `InitExecution` nor the constructor writes
it, so its pre-transition value is allocator-dependent. Both state-entry
paths clear it before installing/resolving state code. `GotoState` then
recomputes the probe words from class/state masks. The meanings of the zero
fields `+0x10` and `+0x14` remain unresolved. In the accepted spawn sequence,
`SetInitialState` eventually calls `GotoState`, so the latent slot is zero by
the time that state-entry call completes.

The `AActor` body then only validates the result. It logs if the frame is
missing or `frame+0x08 != actor`, if `Actor+0xac` (`XLevel`) is null, if
`XLevel+0x2c` (the actor-array data pointer) is null, if its first element is
not `Actor+0xa8` (the LevelInfo pointer), or if `Actor+0xa8` is null
(`0x103deb73`–`0x103dec3f`). It makes no additional frame, state, latent, or
probe assignment. A native subclass can override either vtable entry, which
remains outside this base-path contract.

The second call at `0x103954fd` is therefore base `AActor::Spawned`, whose
body at `0x1030d730` is a no-op. The script `Spawned` ProcessEvent follows at
`0x10395500`.

## Class flag backing the abstract gate

The `testb $0x1, 0x484(class)` at `0x10394fc2` is the abstract-class rejection
in `ULevel::SpawnActor`; when set, it logs and returns null before construction.
`Actor.uc` declares `class Actor extends Object abstract`, so the native base
Actor itself is rejected. The package payload supplies the same semantic
mapping: `UClass::Load` reads a 32-bit `ClsFlags` immediately after the
serialized `UState` data (`.cache/reference/UClass.cpp:67-78`), and the class
reader decodes that field. Original Engine.u values are `Actor=0x833`
(bit `0x1` set), `Pawn=0x837` (set), `Mover=0x832` (clear), and
`LevelInfo=0x32` (clear); the corresponding source declares Actor/Pawn
abstract while Mover is concrete. `UClass::Save` writes this value back as a
32-bit field (`UClass.cpp:119-127`). Together with the native byte test, this
establishes `Class+0x484` bit `0x1` as the abstract class flag for this build.
The C++ enum identifier is absent from the local original headers, so the
numeric mapping above is the supported contract.

## Accepted CameraPoint sequence

After the gates and any placement probe, the ordinary path for CameraPoint is:

1. Append one slot to `Level.Actors` with the native array helper
   `FArray::Add(1,4)` at `0x103951bc`–`0x103951c8`. The returned index is used
   as `Actors.Data[index]`; this is an append and does not search earlier
   holes. The index is retained in `ESI`, then copied to the argument slot
   `[ebp+0x30]` at `0x103951d6`, overwriting the original `Template` argument;
   subsequent reads of that slot are the actor-array index. If Core `GUndo`
   (IAT `0x10599b0c`, `?GUndo@@3PAVFTransactionBase@@A`) is non-null, the
   branch at `0x103951d9`–`0x103951f7` records the array insertion in the
   transaction. The standalone accepted fixture sets `GUndo = null` to take
   the no-transaction branch. The `StaticConstructObject` call at
   `0x1039520a`–`0x1039521a` receives the selected class/default, flags `0`,
   construction name `NAME_None`, and Outer loaded from `ULevel+0x18` at
   `0x1039520d` (the level's package/map `UObject.Outer`, not the ULevel
   object itself). The returned pointer is immediately dereferenced at
   `0x10395227`; this caller does not add a null-result guard. Construction
   failure policy belongs to the Core helper and its error device.
2. Mark object flags `Actor+0x1c |= 1` and write the observed class identity
   word `[SpawnClass+0x20]` to `Actor+0xb0` (`0x10395227`–`0x10395236`).
   Object.uc names flag `1` RF_Transactional. Actor `+0xb0` is Tag,
   independently established by AllActors tag filtering. Thus Tag is reset to
   the class's short name before any startup callback. The wrapper's saved
   SpawnTag is installed only after the entire native SpawnActor body returns,
   as described above; it is the `NAME_None` construction argument at
   `0x1039520a`–`0x1039521a` that drives fresh unique-object naming.
3. Initialize level and region state. `Actor+0xa8` receives the first actor
   in the level actor array (the LevelInfo object), `Actor+0xac` receives the
   `ULevel` pointer, and `PointRegion` at `Actor+0xc8` becomes
   `{ Zone=LevelInfo, BspLeaf=-1, ZoneNumber=0 }`
   (`0x10395286`–`0x10395303`).
4. Update native flags around `Actor+0x28` using level field `+0x10c`
   (`0x10395309`–`0x1039531c`). The exact packed operation is
   `old = Actor+0x28; old &= ~0x200; if (Level+0x10c == 0) old |= 0x200;`
   followed by the store back to `Actor+0x28`. The level tick body repeats this
   relationship at `0x103a56e9`–`0x103a5703`: it compares the shifted/masked
   actor bit with `Level+0x10c` and dispatches actor vtable `+0x64` only on a
   mismatch. `Actor.uc` declares `bTicked` as the tenth packed boolean
   (`Actor+0x28` bit `0x200`), establishing the actor-side symbolic field.
   `Level+0x10c` is the corresponding current tick parity/generation value;
   its separate symbolic member name is not established by this trace.
   Implementations must preserve the raw comparison and bit update. The
   native code warns if Role at `+0x31` is not `4`. Because the wrapper passes
   `bRemoteOwned=0`, it does not swap Role and RemoteRole (`+0x31`/`+0x32`).
   A non-null Brush pointer at `+0x178` is cleared.
5. Copy the requested transform exactly, before collision-hash registration:
   `Location` to `Actor+0x114`, the same vector to `OldLocation` at
   `Actor+0x12c`, and `Rotation` to `Actor+0x120`
   (`0x10395366`–`0x103953b4`).
6. If `Actor+0x1dc` bit `0x1` (`bCollideActors`) is set and the LevelInfo hash
   pointer at `XLevel+0xf8` is non-null, call the hash's `AddActor` vtable
   slot `+0x8` (`0x103953b7`–`0x103953cf`). A plain non-colliding actor skips
   this call. The registration precedes all startup callbacks.
   The complete branch region after this hash call and before `SetOwner` is
   also observable. The code first emits non-fatal warnings when
   `Level.Actors.Data[0]` is null or is not a `LevelInfo` object
   (`0x103953d2`–`0x10395419`), then reinitializes `Actor+0xc8` to
   `{LevelInfo,-1,0}` at `0x1039541c`–`0x10395432`. It walks the Actor class
   chain through `Class+0x28` looking for `APawn` class object `0x1058c660`
   (`0x10395435`–`0x10395452`). Only a matching APawn ancestry repeats the
   non-fatal LevelInfo warnings and writes both extra regions:
   `Actor+0x33c` (`HeadRegion`) receives `{LevelInfo,-1,0}` at
   `0x103954b9`–`0x103954c9`, then `Actor+0x330` (`FootRegion`) receives the
   same value at `0x103954cc`–`0x103954db`. A null/non-APawn chain skips those
   writes. `CameraPoint` ends in the Keypoint/Actor ancestry, so this branch
   reinitializes only its center `Region` and reaches `SetOwner`; the warning
   branches do not reject the spawn.
7. Call `SetOwner` (`0x10301eab`) with `SpawnOwner`, then store the supplied
   Instigator directly at `Actor+0xbc` (`0x103954de`–`0x103954f4`).
8. Run native virtual slot `+0x38` (`0x103954f6`), which is
   `InitExecution@AActor` (`0x10302194` → `0x103deb40`) and the Core
   `UObject::InitExecution` frame setup documented above. Immediately run
   native virtual slot `+0x74` (`0x103954fd`), which is base
   `Spawned@AActor` (`0x10303373` → `0x1030d730`, a no-op). A native subclass
   may override either slot.
9. Dispatch the first three no-argument script events through ProcessEvent
   vtable slot `+0x10`:

   ```text
   Spawned       name global 0x10583730, body 0x10323430  (0x10395500–1c)
   PreBeginPlay  name global 0x1058364c, body 0x103227b0  (0x1039551f–34)
   BeginPlay     name global 0x10583650, body 0x10322840  (0x10395537–4c)
   ```

   The callback can mark the actor pending deletion (`Actor+0x28` mask
   `0x80`). SpawnActor checks that bit at `0x1039554f` and returns null if it
   is set, so this reentrant destruction check is part of the result contract.
10. Call the level vtable `+0xac` (`0x10395559`–`0x1039556c`) for
    `SetActorZone`. The original `Template` slot has already been overwritten
    with the actor-array index at `0x103951d6`; at `0x10395559` the index is
    moved to `EDI`, `0x10395565` computes the first boolean as
    `(Actors index == 0)`, and the call pushes `1` as the second boolean. The
    helper body `0x1039b940` confirms the signature `SetActorZone(Actor,
    test, force)`: its `arg+0xc` test flag suppresses zone-change callbacks,
    while `arg+0x10` force selects the reset path. Therefore an accepted
    CameraPoint appended after the LevelInfo entry (index >= 1) receives
    `test=0, force=1`; this is not a `Template == null` test. Then store raw
    float32 `-10.0` (`0xc1200000`) in `Actor+0x34` at `0x10395572`.
    `Actor.uc` places `LastRenderTime` at this offset, and
    `execLastRendered` (`0x1036de30`, thunk `0x103021da`) computes
    `max(0, XLevel.TimeSeconds - Actor+0x34)`; the level tick writes
    `TimeSeconds` at `Level+0xdc` (`0x103a547b`–`0x103a5481`). Thus this is
    `LastRenderTime=-10.0`, not a latent-time field.
11. Dispatch `PostBeginPlay` through ProcessEvent
    (name global `0x10583648`, body `0x10322530`, `0x10395579`–`8e`). With
    `bNoCollisionFail=0`, SpawnActor unconditionally calls the level vtable
    `+0xb8` at `0x103955d6`; the only caller gate at `0x10395591`–`0x10395596`
    is `bNoCollisionFail`. The target is `CheckEncroachment` body
    `0x1039a350`. For CameraPoint's non-brush, no-collision fixture, its early
    gate at `0x1039a39a`–`0x1039a3a9` tests `Actor+0x1dc & 0x0d == 0` and
    `Actor+0x178 == null`, then returns false at `0x1039a8fb`; no hash query is
    reached. A non-null Brush continues the ancestry/flag path even when the
    collision mask is clear. If the helper returns true, SpawnActor calls
    cleanup through level vtable `+0x94` before returning null
    (`0x103955e0`–`0x103955e8`).
12. Dispatch `SetInitialState` (name global `0x10583620`, body `0x103224b0`,
    `0x103955f9`–`0x1039560f`). Its script source chooses
    `GotoState(InitialState)` when `InitialState != ''`, otherwise
    `GotoState('Auto')`.
13. The tail has three distinct parts, all before the final return:

    * `FindBase` is considered only when `Actor+0xc4 == 0` and packed byte
      `Actor+0x1dc` has bit `0x2` (`0x10395612`–`0x10395627`). The class chain
      is then tested, in order, for `ADecoration` (`0x10578d48`), `AInventory`
      (`0x10576f70`), and `APawn` (`0x1058c660`) at
      `0x10395629`–`0x1039568d`. A matching ancestry reaches the common gate
      at `0x1039568f`; no match skips directly to `PostPostBeginPlay`. The
      raw byte at `Actor+0x30` must be `0` or exactly `5` for the call to
      `AActor::FindBase` (`0x10301749`) at `0x1039569a`–`0x1039569c`.
      Other byte values skip the call. The symbolic meanings of `+0xc4`, the
      `+0x1dc` bit, and `+0x30` are not asserted by this trace. CameraPoint
      is not in any of these three class chains, so its accepted path skips
      `FindBase`.

    * `PostPostBeginPlay` is dispatched through ProcessEvent with name global
      `0x10583644`, body `0x103224f0`, at `0x103956a1`–`0x103956b6`.

    * The notifier tail reads raw `Level+0x108` at `0x103956b9`–`0x103956c4`.
      If zero, it skips link allocation. If nonzero, it calls the Engine IAT
      allocator `0x10599bd4` with size and alignment `8` and `ECX=0x10485c40`.
      On success the new 8-byte record stores `Actor` at `record+0`, the old
      `Level+0x104` at `record+4`, and then becomes the new `Level+0x104`
      head at `0x103956d9`–`0x103956ee`; allocation failure stores null in
      `Level+0x104`. The global reentrancy word `0x10588b48` is tested next.
      Nonzero skips all notifier dispatch and returns the actor. Otherwise
      the word is set to `1`, the first actor is checked for LevelInfo (with
      warning-only failure), and the notifier head is read from
      `LevelInfo+0x590` (`0x103956f4`–`0x1039577b`). A null head clears the
      guard and returns. Each notifier object follows `notifier+0x31c`; its
      class word at `notifier+0x318` matches when it is in the spawned actor's
      `Class`/parent chain. A match first resolves the notifier's
      `SpawnNotification` function by name global `0x105835c4`, then invokes
      its ProcessEvent vtable slot `+0x10` with a local 8-byte parameter block
      `{ Actor, 0 }` and a null result pointer (`0x103957a6`–`0x103957c6`).
      This matches the native `ASpawnNotify::eventSpawnNotification(AActor*)`
      wrapper (`0x103023c4` → `0x10330d40`). Iteration then continues. The
      guard is cleared at `0x103957d1` after the list and the actor is returned
      at `0x103957d7`. Thus nested SpawnActor calls while this guard is set do
      not recursively dispatch SpawnNotify callbacks.

The only explicit pending-delete test in this body is the
`Actor+0x28 & 0x80` check at `0x1039554f`, immediately after `BeginPlay` and
before `SetActorZone`. No later test occurs after `PostBeginPlay`,
`SetInitialState`, `PostPostBeginPlay`, or notifier dispatch; if one of those
callbacks sets that bit, the normal fall-through still returns the actor
pointer at `0x103957d7`. Earlier class/placement failures return null through
`0x10394fad`; the encroachment failure additionally calls the level cleanup
slot `+0x94` at `0x103955e0`–`0x103955e8`. This function body does not remove an
already appended actor from `Level.Actors` on its common null path.

Thus the proven ordinary callback order is:

```text
append/construct → native InitExecution(+0x38) → native Spawned(+0x74) → Spawned → PreBeginPlay
→ BeginPlay → pending-delete check → SetActorZone(test=(index==0),force=1)
→ LastRenderTime=-10 → PostBeginPlay → CheckEncroachment call
  (CameraPoint early gate returns false) →
SetInitialState → optional FindBase → PostPostBeginPlay
→ optional SpawnNotify callbacks → return actor
```

`PostNetBeginPlay` is not called by this standalone `SpawnActor` body. Pawn
specific `PreBeginPlay`/`PostBeginPlay` work and player startup belong to the
separate pawn-startup contract in `docs/pawn-list.md`.

## Explicit boundaries

The native evidence does not establish the symbolic names of the remaining
class/default guards, the four non-object `FStateFrame` fields listed above,
or the level mode/flag branches. The actor-side tick flag is established as
`bTicked` (the tenth packed boolean, bit `0x200`); the corresponding
`Level+0x10c` generation/parity field retains only its raw name here. Native
subclass overrides remain an integration boundary.
Brush and network handling, remote-owned role swapping, the full
CheckEncroachment ancestry/hash path, encroachment failure cleanup, and
actor-list exhaustion remain outside the accepted CameraPoint
implementation. The SpawnNotify list guard and matching dispatch are traced
above, but the notifier callback bodies themselves are outside this contract.
The accepted target is a concrete CameraPoint path with no collision placement
probe and no native subclass override.

Related source-backed notes: [zone.md](zone.md), [collision-hash.md](collision-hash.md),
[script-construction.md](script-construction.md),
[fitting.md](fitting.md), `.cache/reference/SpawnActor.asm`,
`.cache/reference/Engine.asm`, `.cache/research/Core.asm`,
`.cache/reference/Core-rng.asm`, `.cache/reference/UClass.cpp`,
`.cache/reference/Actor.uc`, and `.cache/reference/UActor.h`.


## Implemented runtime boundary

`src/runtime/script-spawn.mjs` translates the script wrapper and the accepted
CameraPoint level sequence. `ScriptRuntime` supplies typed fields, the fresh
construction helper, native frame initialization, original script dispatch and
an adapter to the recovered `setActorZone`/`pointRegion` helpers. Unsupported
classes, colliding paths, editor/undo handling and spawn-tracking allocation
remain explicit errors; abstract and non-Actor classes follow native null
rejection. The common script dispatcher binds native 278 to this path.

The explicit host `level.tickParity` boolean represents the known zero/one
value at raw `ULevel+0x10c`; it does not assert a recovered C++ member name.
`level.spawnTracking=false` selects the zero `+0x108` branch, `level.undo=null`
selects the null GUndo branch, and `level.spawnNotifyGuard` is the shared native
guard representation. A nonempty notification list requires its separate
ProcessEvent return/parameter implementation and is rejected when reached.

`node scripts/validate-script-spawn.mjs` uses actual CameraPoint class defaults,
constructor, original startup event bodies and the actual GameInfo/Mutator
relevance chain. It supplies an explicit standalone world, name/object registry,
native template tail and empty BSP. Checks cover append despite an earlier
actor-array hole, unique object name versus post-startup Tag, ownership/world
stores, LastRenderTime, bTicked, zone assignment, single shared FRand transition,
automatic Idle-state selection and abstract-class rejection before insertion.
The installed Idle continuation is not executed until a later actor script
phase. This fixture establishes the scoped runtime integration; it does not
bootstrap the map, fill the native class/resource registry, or enable arbitrary
spawning in Play.

Two focused wrapper checks retain native evaluation-order edge cases: argument
side effects change the transforms sampled by later default arguments, and a
null SpawnClass still evaluates every argument before returning without a level
lookup. Startup observes the class-name Tag; the requested script SpawnTag is
written after SpawnActor returns.
