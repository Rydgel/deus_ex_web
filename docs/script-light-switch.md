# Original `LightSwitch.Frob` route

This note records the bounded training-map route from the installed Deus Ex
GOTY data.  The authority is the local `DeusEx.u`/`DeusExDeco.u` data, the
extracted UnrealScript text in `.cache/reference`, and the original
`Engine.dll` disassembly in `.cache/reference/Engine.asm`.  It describes the
native boundaries that a host must provide; it does not claim that the browser
renderer or audio system already reproduces them.

## Concrete training data

`00_Training.dx` map actor `LightSwitch0` is map reference `1605`.  Its
serialized values include `Event='cratelight'`, `Tag='LightSwitch'`, and no
`bOn` or `ConListItems` value.  The absent `bOn` value combines with the class
default/zero value to start the switch false.  `ConListItems` is transient: raw
construction starts it null, but `DeusExDecoration.PostPostBeginPlay` calls
`ConBindEvents` (native `2101`), so the post-startup value is not established by
the map record alone.  The event names four
`TriggerLight` actors, in the map's actor array at references `111`, `113`,
`114`, and `110` (`TriggerLight0` through `TriggerLight3`).

The class is `DeusEx.u` export `19688`, and its `Frob` function is export
`13691`.  The class default stream contains these switch-specific values:

| field | original value |
| --- | --- |
| `Mesh` | object reference `-2793`, `DeusExDeco.LightSwitch` (`LodMesh`) |
| `ItemName` | `Switch` |
| `bInvincible` | `true` |
| `bPushable` | `false` |
| `CollisionRadius` / `CollisionHeight` | `3.75` / `6.25` |
| `Mass` / `Buoyancy` | `30` / `40` |

The mesh reference resolves to `DeusExDeco.u` export `606`, path `LightSwitch`.
That package also contains texture export `170`, `Skins.LightSwitchTex1`, but
this trace does not establish that the texture is selected by the native mesh
call.  `Off` and `On` are `FName` animation sequence names looked up on the
mesh; they are not separate script object references.

The sound references in the script are:

| script literal | import | resolved object |
| --- | ---: | --- |
| `Switch4ClickOff` | `-675` | `DeusExSounds.Special.Switch4ClickOff` (export `256`) |
| `Switch4ClickOn` | `-676` | `DeusExSounds.Special.Switch4ClickOn` (export `253`) |

## LightSwitch source and bytecode order

The class has no checked-in `.uc` source file.  Its original TextBuffer in
`DeusEx.u` export `19686` decodes to this body:

```uc
function Frob(Actor Frobber, Inventory frobWith)
{
    Super.Frob(Frobber, frobWith);

    if (bOn)
    {
        PlaySound(sound'Switch4ClickOff');
        PlayAnim('Off');
    }
    else
    {
        PlaySound(sound'Switch4ClickOn');
        PlayAnim('On');
    }

    bOn = !bOn;
}
```

`readFunctionMetadata` reports an expanded script size of `77` bytes; the
serialized script is `59` bytes.  The expanded offsets below are the offsets
used by `decodeScript` and preserve the native `SerializeExpr` stream order.

| expanded range | decoded operation |
| ---: | --- |
| `0–16` | final call to function export `129`, `DeusExDecoration.Frob`, with `Frobber` then `frobWith` |
| `16–25` | `JumpIfNot` to `44`, testing field `bOn` (field reference `6714`) |
| `25–33` | native `264`, `PlaySound`, object import `-675` (`Switch4ClickOff`) |
| `33–41` | native `259`, `PlayAnim`, name `Off` (name index `431`) |
| `41–44` | jump to `60` |
| `44–52` | native `264`, object import `-676` (`Switch4ClickOn`) |
| `52–60` | native `259`, name `On` (name index `593`) |
| `60–75` | assign `bOn` from native `129` logical-not of the current `bOn` |
| `75–77` | return |

The conditional reads `bOn` before either native effect.  A false initial
value therefore calls `PlaySound(Switch4ClickOn)` and `PlayAnim('On')`; only
after both calls return does the script assign `true`.  On the next call the
off sound/sequence is selected, then the script assigns `false`.  There is no
second `Super.Frob` call and no early toggle.

The final-call object index `129` and native index `129` are unrelated: the
former is the serialized `DeusExDecoration.Frob` function reference, while the
latter is the unary logical-not native expression.

## Inherited `DeusExDecoration.Frob`

The inherited source is `.cache/reference/DeusExDecoration.uc:949-975`:

```uc
P = Pawn(Frobber);
Player = DeusExPlayer(Frobber);
Super.Frob(Frobber, frobWith);

if (Player != None)
    if (Player.StartConversation(Self, IM_Frob))
        return;

if (!IsA('HackableDevices'))
    if (Event != '')
        foreach AllActors(class 'Actor', A, Event)
            A.Trigger(Self, P);
```

The decoded expanded function is `156` bytes.  Its order and important
boundaries are:

1. Cast `Frobber` to `Pawn` for `P`, then to `DeusExPlayer` for `Player`.
2. Call the empty `Actor.Frob` base through `Super.Frob`.
3. For a non-null `Player`, call the scripted
   `DeusExPlayer.StartConversation(Self, IM_Frob)`.  A true result returns from
   `DeusExDecoration.Frob` only; the already-issued `LightSwitch` super call
   then returns to `LightSwitch.Frob`, which continues with sound, animation,
   and `bOn` assignment.
4. If the decoration is not `HackableDevices` and `Event` is not the `None`
   name, execute native `AllActors` (`304`) for class `Actor` and the event
   name, then call each result's `Trigger(Self, P)`.  `Self` is the switch;
   passing `None` here is incorrect.

`StartConversation` is a source-backed blocker for a complete Frob host.  Its
first non-forced guard in `.cache/reference/DeusExPlayer.uc:7739-7756` is:

```uc
if ((!bForcePlay) && ((invokeActor.conListItems == None) || (!CanStartConversation())))
    return False;
```

`LightSwitch0` has no serialized `ConListItems`, but that only proves the
pre-startup/default value.  `DeusExDecoration.PostPostBeginPlay` at
`.cache/reference/DeusExDecoration.uc:95-101` calls native `ConBindEvents`
(`2101`), which may populate the transient list before a playable Frob.  The
post-`ConBindEvents` value and the resulting `StartConversation` return are
therefore intentionally unverified here.  A host must preserve
`CanStartConversation` and the later conversation checks; treating
`StartConversation` as an unconditional false would skip a reached original
branch.

The `AllActors` argument order and out actor reference are covered by
`src/runtime/script-iterators.mjs`.  TriggerLight's `TriggerToggle` state is
covered by `src/runtime/script-lights.mjs`; its event call must receive the
switch as `Other` and the pawn cast as the event-instigator argument.

## Native `PlaySound` 264

`Actor.uc` declares native `264` as:

```uc
native(264) final function int PlaySound
(
    sound Sound,
    optional ESoundSlot Slot,
    optional float Volume,
    optional bool bNoOverride,
    optional float Radius,
    optional float Pitch
);
```

The exported thunk `0x10302612` jumps to the original body
`0x103e1f60` in `Engine.asm`; the body returns at `0x103e261b`.  The native
expression parser evaluates the six parameters in declaration order, then
consumes `EX_EndFunctionParms`:

| parameter | native initialization when omitted |
| --- | --- |
| `Sound` | null before the expression is evaluated |
| `Slot` | byte `1`, which is `SLOT_Misc` in `Actor.uc`'s `ESoundSlot` enum |
| `Volume` | actor `+0x1cc` (`TransientSoundVolume`) |
| `bNoOverride` | `false` |
| `Radius` | actor `+0x1d0` (`TransientSoundRadius`) |
| `Pitch` | `1.0` |

For the training switch's one-argument call, inherited `TransientSoundVolume`
is `1`, `TransientSoundRadius` begins at its zero value, and `Pitch` is `1`.
After the null-sound return check at `0x103e2117-0x103e211d`, the body replaces
a non-positive or unordered radius with `800.0` (`0x44480000`) at
`0x103e2132`.  Thus the verified native input tuple is
`(Switch4ClickOn|Switch4ClickOff, SLOT_Misc, 1, false, 800, 1)`.

A null `Sound` jumps straight to the epilogue and skips the normal result
write. The first non-null branch is **demo recording**: XLevel `+ac`, its
DemoRecDriver `+88`, and the driver's null ServerConnection `+38` gate a
`DemoPlaySound` event when Actors(0).NetMode is not3. Skipping that optional
branch does not skip later hearing propagation. Import `10599a88` is
`UObject.FindFunctionChecked`; it looks up the exported DemoPlaySound FName,
then dispatches through the emitter's ProcessEvent virtual at `+10`.

The wrapper next constructs the channel ID from the emitter's live global
UObject index. NetMode3 or a simulated enclosing UFunction selects eligible
same-level viewport actors; otherwise it follows LevelInfo.PawnList and
selects bIsPlayer pawns. `CheckHearSound` applies its original distance and
FastLineCheck gates before sending ClientHearSound. Result receives the ID
only after those callbacks complete.

These native steps are translated in `src/runtime/script-sound.mjs`; see
[the sound contract](script-sound.md) for addresses, constants and service
requirements. Native object indices, the live level/viewport graph,
FastLineCheck and native audio events remain required host bindings. The
deferred mover sound callback in `src/runtime/script-doors.mjs` is still a
separate, incomplete Play boundary.

## Native `PlayAnim` 259

`Actor.uc` declares:

```uc
native(259) final function PlayAnim(name Sequence, optional float Rate, optional float TweenTime);
```

The exported thunk `0x103011b8` jumps to body `0x103e0160`; the body returns at
`0x103e04e9`.  It evaluates `Sequence`, `Rate`, and `TweenTime` in that order,
with defaults `1.0` (`0x3f800000`) and `-1.0` (`0xbf800000`) for the optional
floats, then consumes `EX_EndFunctionParms`.  The switch supplies only the
sequence name, so both defaults apply.

The first required resource gate reads the actor's mesh pointer at `+0x174`.
If it is null, the body calls the original logging import `0x10599a68` with
the mesh-null diagnostic and returns without animation field writes.  For a
non-null mesh it calls the mesh virtual at vtable slot `+0x68` with the
sequence `FName`.  A null sequence result takes the second logging path at
`0x103e049c-0x103e04d4` and likewise returns before the animation state is
written.

After both gates pass, the body writes the selected sequence name to actor
`+0x54`, derives rate/frame values from the returned sequence object (including
its members at `+0x0c`, `+0x10`, and `+0x18`), updates the animation flags at
`+0x28`, and stores the animation state at `+0x58`, `+0x5c`, and `+0x60`.
The successful path also updates raw animation/tween slots `+0x220`, `+0x224`,
`+0x228`, `+0x230`, `+0x234`, and `+0x238`.  The local disassembly establishes
these writes and their branch order, but this pass does not establish a
complete semantic label for every raw slot; a host must preserve the writes
and float32 arithmetic rather than replacing them with a visual toggle.

The required animation service is therefore a mesh resolver plus the original
mesh `+0x68` sequence lookup and a mutable actor animation-state writer.  A
name-only callback that accepts every `Off`/`On` value would bypass the native
null-resource behavior and is unsupported by this trace.

## Host boundary and remaining blockers

The script VM already exposes lazy native dispatch through
`services.invokeNative({ index, receiver, argumentCount, evaluateArgument, ... })`;
this preserves the original argument evaluation order.  The switch host should
route indices `264` and `259` there, while reusing the iterator, `IsA`, event,
and TriggerLight services named above.

The following pieces remain explicit dependencies for a complete Play route:

* `DeusExPlayer.StartConversation`, `ConBindEvents(2101)`, and their
  player/UI/conversation state; the post-bind `ConListItems` value and return
  are not established by the map serialization;
* the `PlaySound` level audio-start and `CheckHearSound` boundaries;
* `LodMesh` sequence lookup at vtable `+0x68` and the animation state writes;
* mesh package payload decoding/render selection, including whether
  `Skins.LightSwitchTex1` is bound to the switch mesh; and
* renderer light invalidation after TriggerLight changes, which is outside this
  Frob trace.

No branch in this document is a substitute for those boundaries.  In
particular, `scripts/validate-script-lights.mjs` runs the inherited
DeusExDecoration.Frob and its AllActors/Trigger fanout in Play's shared actor
host, with its pre-startup null conversation storage explicitly checked. It
does not invoke the complete `LightSwitch.Frob` wrapper: native conversation
registration, audio and animation remain separate dependencies.

## Evidence and focused validation

The source and data checks used for this note were local and reproducible:

* `readClass` on `DeusEx.u` export `19688` resolves the mesh import, switch
  defaults, and export `13691` child function;
* the `DeusEx.u` TextBuffer at export `19686` decodes the exact
  `LightSwitch.Frob` source shown above;
* `decodeScript(readFunctionMetadata(...))` reports the `77`-byte expanded
  offsets and native/object/name references in the table;
* `decodeMap` on `00_Training.dx` reports `LightSwitch0` reference `1605`, no
  serialized `ConListItems`, and `Event='cratelight'`; and
* `objectAt`/package resolution confirms the `DeusExDeco.LightSwitch` mesh and
  both `DeusExSounds` sound exports.

The native addresses and guard order are read directly from the installed
`Engine.asm` bodies `0x103e0160` and `0x103e1f60`, rather than inferred from a
public engine implementation.
