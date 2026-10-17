# Original `StaticConstructObject` construction contract

This note covers the accepted fresh-object path used by `Actor.Spawn`, the
native Actor constructor and the concrete CameraPoint constructor. It follows the
local GOTY `Core.dll` and `Engine.dll` rather than a public-engine
implementation. Special loading, existing-object reuse, subobjects, config
objects, other native subclasses, and failure cleanup remain outside this contract.

The analyzed files are `Core.dll` (SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`) and
`Engine.dll` (SHA-256
`0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4`).

## Spawn call and helper ABI

Engine IAT `0x10599db0` resolves Core's
`?StaticConstructObject@UObject@@...` export (`0x10101771`), whose body is
`0x10157ff0`. The ordinary `ULevel::SpawnActor` call at
`0x103951fa`–`0x10395236` pushes the six arguments in reverse order. The
semantic call is:

```text
StaticConstructObject(
    Class      = SpawnClass,
    Outer      = Level field +0x18,
    Name       = SpawnTag,             // NAME_None when the optional is absent
    SetFlags   = 0,
    Template   = selected EBX,         // Class+0x4d4 for the ordinary wrapper
    Error      = Engine error device
)
```

`SpawnTag` is the UObject `Name` input. It is not the later `Actor.Tag` store;
`SpawnActor` writes that field separately after construction. The selected
template is an explicit `Template` when one is supplied, otherwise the class
default object at `Class+0x4d4`; the ordinary script wrapper supplies the
class default. The seventh `StaticAllocateObject` argument, `SubobjectRoot`,
is forced to null by `StaticConstructObject`.

## Accepted fresh sequence

For a loaded concrete class, valid `Outer`, no object already registered with
the requested name, and the ordinary default template, the native order is:

1. `StaticConstructObject` (`0x10157ff0`) requires a non-null error device,
   calls `StaticAllocateObject` (`0x101579c0`), and returns null if allocation
   fails. After a non-null result it calls the function pointer at
   `[Class+0x4e0]` with the object pointer, then returns the same object.

2. `StaticAllocateObject` first checks the error device, class, class metadata
   at `Class+0x49c`, and the native-constructor pointer at `Class+0x4e0`
   (`0x101579dc`–`0x10157a4f`). It rejects the abstract bit at
   `Class+0x484` bit `0x1`. The `Outer` ancestry check is also performed here;
   the accepted Spawn path uses `Outer = [Level+0x18]` and passes it.

3. With `Name == NAME_None`, `StaticAllocateObject` calls
   `MakeUniqueObjectName` (`0x1010263a` -> body `0x101575b0`) and stores its
   returned `FName` back into the local name argument
   (`0x10157bb9`–`0x10157bd6`). Its generated-name algorithm is:

   * copy the class name from the name table (`Class+0x20`) and strip every
     trailing UTF-16 digit;
   * read the per-`UClass` counter at `Class+0x488`, format that integer with
     the wide `"%i"` format at Core `0x101af8d0`, and increment the field
     before checking the candidate;
   * pass `0x3f - suffixLength` to `appStrncpy` and append the decimal
     suffix. `appStrncpy` calls MSVCRT `wcsncpy` (IAT `0x102ab504`) and then
     writes a UTF-16 NUL at `dest[count-1]` (`0x101233da`), so the prefix is
     limited to `0x3e - suffixLength` characters and the final generated name
     is at most 62 characters. Then call
     `StaticFindObject(NULL, Outer, candidate, 0)`;
   * repeat with the next counter value while any object already has that
     `Outer` and generated name, then construct the result with
     `FName(PChar, EFindName=1)` (`0x10102e96`).

   There is no separator before the suffix. The counter is a signed 32-bit
   value as consumed by `%i`; the machine `incl` has no overflow guard, so
   `INT_MAX` is followed by the bit pattern for `INT_MIN` and a stored
   `0xffffffff` formats as `-1` before wrapping to zero. The parameterized
   `UClass` constructor body `0x10128630`
   initializes `Class+0x488` to zero at `0x10128714`, so a newly constructed
   class starts at suffix `0`; the class serialization body `0x101280d0`
   resets it at `0x101282d9`, while the UClass copy and assignment bodies
   (`0x10111850` and `0x10111d20`) preserve it. A non-null name takes the
   lookup/collision path instead.

4. The fresh path finds no existing object with `StaticFindObject`
   (`0x10157c51`–`0x10157c98`). It obtains the allocation size through the
   class virtual slot `+0x64` (`0x10157cc0`); the observed UStruct body
   `0x1010f7c0` returns `[Class+0x3c]`. It calls the allocator vtable through
   the global `GMalloc` pointer at `0x101a7c44`, passing that size and the
   corresponding name-table string as the allocation tag
   (`0x10157cbe`–`0x10157ce0`).

5. Before copying properties, the allocator writes the UObject header fields
   directly (`0x10157e9e`–`0x10157eda`):

   | object offset | value written | evidence/meaning |
   | --- | --- | --- |
   | `+0x04` | `0xffffffff` initially | replaced by the object index in `AddObject` |
   | `+0x08` | `0` initially; linked by `HashObject` | hash-chain link; `HashObject` later stores the previous bucket head here |
   | `+0x0c` | `0` | `StateFrame` pointer, initially null |
   | `+0x10` | `0` | `Linker` pointer, initially null |
   | `+0x14` | `0xffffffff` | linker-index/outer-index sentinel |
   | `+0x18` | `Outer` | object outer |
   | `+0x1c` | `SetFlags`, with `0x00004000` ORed when `Class+0x484` bit `0x8` is set | raw object flags; `0x4000` is `RF_Transient` in `Object.uc` |
   | `+0x20` | resolved `Name` | object name |
   | `+0x24` | `Class` | object class |

   The allocator does not initialize `+0x00` as a vtable. The native
   constructor does that after `StaticAllocateObject` returns. `InitProperties`
   starts at `+0x28`, so it does not overwrite these header stores.

   The meanings of `+0x08`, `+0x0c`, `+0x10`, and `+0x14` are cross-checked
   against [the object lifecycle trace](script-object-lifecycle.md), which
   follows the hash link, `StateFrame`, `Linker`, and linker-index/outer-index
   writes after allocation.

6. `InitProperties` (`0x1010102d` -> body `0x101520d0`) runs before registry
   insertion. StaticAllocate computes the class size twice and calls it as:

   ```text
   InitProperties(
       Data          = new object,
       Count         = class size,
       Class         = Class,
       Defaults      = Template,
       PropertySize  = class size
   )
   ```

   The body asserts `Count >= 0x28`. When `Defaults` is non-null, it first
   copies exactly `classSize - 0x28` bytes from `Defaults+0x28` to
   `Data+0x28` with `rep movs` (`0x10152146`–`0x10152176`). When `Defaults` is
   null, it uses `Class+0x4d4` as the default source and takes the size/end
   value from `Class+0x4d8`; the field's metadata name is unresolved. If no
   usable source exists, the property tail is zero-filled.

   It then walks the linked property list beginning at `Class+0x68`, following
   `Property+0x54`. This is the `CPF 0x00400000` destructor/constructor-linked
   list produced by `UStruct::Link` (`0x10126466`), rather than a second pass
   over every property. For each linked property whose `Property+0x48` offset
   is within the size, it zeroes `ElementSize (Property+0x38) * ArrayDim
   (Property+0x34)` bytes at `Data + offset`, then invokes the property's
   virtual slot `+0x90` with destination `Data + offset` and source
   `Defaults + offset` (`0x101521b1`–`0x10152203`). This is the typed
   `CopyCompleteValue` operation (the exported property helper is
   `0x10101820`) for that owning/constructor-linked subset. Ordinary Object
   and Name properties typically remain from the raw default-byte copy; this
   step must not be generalized to all property types. The corresponding
   ownership/destruction side is traced in
   [the object lifecycle document](script-object-lifecycle.md).

7. StaticAllocate calls `AddObject` at `0x10157efe` with index `-1` on the
   fresh path. `AddObject` body `0x10157830` either pops a reusable index from
   its free-index array at `0x1029e618` or takes/increments the next index at
   `0x1029e62c` (growing capacity at `0x1029e630`). It stores the object in
   the global object array at `0x1029e628[index]` and writes the resulting
   index to `object+0x04` (`0x10157969`–`0x10157977`). It then calls
   `HashObject` (`0x101012e9` -> body `0x10157730`). `HashObject` computes
   `(Outer ? Outer+0x04 : 0) XOR Name`, masks with `0xfff`, links the object
   at `0x1029e644 + hash*4`, and stores the previous bucket head at
   `object+0x08`.

8. The new object is checked by `IsValid` (`0x10101c1c`) at
   `0x10157f04`. The subsequent config/localization branches are gated by
   `ClassFlags & 0x400` (`testb $4,%ah` at `0x10157f2c`); they are outside the
   accepted ordinary class path, as is existing-object metadata propagation.
   StaticAllocate then returns the object to StaticConstructObject.

9. StaticConstructObject dispatches the class-selected native constructor via
   `[Class+0x4e0](object)` (`0x10158057`–`0x10158062`). Core's UClass
   constructor body `0x10128630` stores its native-constructor argument into
   `Class+0x4e0` (`0x10128732`). Engine's AActor class registration at
   `0x1035ed30` supplies the AActor constructor thunk `0x10302dab`.
   That thunk (`0x10323530`) jumps to `AActor::AActor` body `0x10323550`,
   which calls the UObject default constructor through Engine IAT
   `0x10599b58` (Core body `0x1014f340`). It then calls the Core default
   `FName` constructor (`0x10102383` -> `0x101099e0`) four times at
   `Actor+0x68` with a four-byte stride, and the Core default `FPlane`
   constructor (`0x10101807` -> `0x10118260`) four times at `Actor+0x26c`
   with a `0x10` stride. Both bodies are just `mov eax, ecx; ret`, so these
   calls do not change the member bytes copied by `InitProperties`. Their
   four-element shapes correlate with the script `BlendAnimSequence[4]` and
   `SimBlendAnim[4]` fields (`Actor.uc` and the generated `UActor.h` accessors),
   but no direct native offset table was recovered, so that field mapping is
   a correlation rather than an asserted offset fact. The UObject default
   constructor writes its temporary vtable, and the AActor body finally writes
   vtable `0x104268dc` at `+0`; neither constructor replaces the
   StaticAllocate `Outer`, `Name`, `Class`, object flags, or object index.

The result is therefore registered and typed-default-initialized before the
native constructor runs. The constructor is selected from class metadata, so a
runtime implementation must resolve `[Class+0x4e0]`; hard-coding the AActor
body is only justified for the AActor native class and its verified ordinary
script descendants.

### CameraPoint's selected native constructor

The lifecycle fixture's concrete class is Engine `CameraPoint` (package
export 62), whose serialized script superclass is `Keypoint` (export 148),
but its native constructor has a separate, observable selection path. The
Engine registration routine at `0x1035f9d0` constructs the native class object
at `0x10579240` through Engine IAT `0x10599de0` (Core `UClass` constructor),
passing the `ACameraPoint` internal-constructor thunk `0x103033af`, raw native
class-size literal `0x390`, raw registration flags `0x04084004`, and parent
class pointer `0x10577468` (the `Keypoint` class object returned by
`0x10331370`). The thunk jumps to the null-guarded body `0x10331930`, which
calls `ACameraPoint::ACameraPoint` (`0x103015f0` -> body `0x10331950`) for a
non-null object. This registration supplies the function later dispatched
from `[Class+0x4e0]`; it must not be replaced by a generic Actor constructor
when constructing this class.

The default `ACameraPoint` body has exactly this order: call the AActor default
constructor body `0x10323550` through thunk `0x10303431`, then write
`0x10427178` to the object's vtable slot `+0`, return `this`. It makes no
CameraPoint-specific member-constructor calls and does not call
`AKeypoint::AKeypoint` (`0x10331410`); the Keypoint script layer's serialized
fields are supplied by `InitProperties`. The AActor call still performs the
UObject vtable write and the four FName/FPlane no-op constructor calls listed
above, then temporarily installs AActor vtable `0x104268dc` before
CameraPoint overwrites it with `0x10427178`. The copy-constructor body
(`0x10331980`) is separate and is not part of fresh construction.

## Spawned names against the original (2026-10-17)

Play's `makeUniqueScriptObjectName` is the algorithm above. Its `StaticFindObject` check, though, only saw Play's host registry, which does not
hold the map's pre-placed actors (they hash by their measured index). So a spawned actor could take a map export's name: Training's summoned
crowbar was `WeaponCrowbar1`, like the map's own crowbar, and 05_NYC_UNATCOMJ12lab's summoned trooper was `MJ12Troop0`, like a placed trooper.
A preset of item classes' counters to 1 (b882853, no recorded evidence; the class serialization above resets the counter to 0) hid the first.
Now a generated name is also checked against the map package's export table (`script-datalink-live.mjs` `uniqueFindObject`; a destroyed map
actor keeps its name until LoadMap's collection, as in the original), and the preset is gone.

**Evidence: the names three captures of the original gave, explained by the rule.** Counters start at 0 when the class loads and live as long
as it does, so they carry the whole session. `live-original.sh` launches the game on the map, opens a second map unfrozen, and then reopens the
target map frozen. In all three captures the launch load initialized no NPCs, while the second, unfrozen load did.

| Capture | Original name | Explained by |
| --- | --- | --- |
| lab `npm`, the summoned trooper | `MJ12Troop3` | counter 0; the lab holds MJ12Troop0, 1, 2 (Play now names it the same) |
| lab `npm`, its rifle | `WeaponAssaultGun17` | Training's three troopers took 0..2, the lab's ten carriers 3, 4, 9..16 (it holds 1, 5..8): the summon takes 17 |
| Training `fpw`, the summoned crowbar | `WeaponCrowbar10` | Island's five thugs (ThugMale0, 3, 5, 7, 9) took 4, 5, 7, 8, 9 (it holds 0..3, 6); Training's NPCs carry none |
| Underworld `sndm5` (557 traced `AddObject`s) | `WeaponStealthPistol0`, `AmmoPepper0`, `Credits0, 2, 4..8, 10, 11`, `WeaponAssaultGun3` | new classes start at 0; the map holds Credits1, 3, 9, 12, 17; Training took rifles 0..2 |

After the fix, Play's replays name what their own session spawned by the same rule. The lab replay's summoned trooper is `MJ12Troop3`. Its stream
draws are now equal on every tick (before the fix they were shifted by one tick at six pairs, through the duplicate name). The Underworld replay
names 145 of the 557 takes like the original. What differs is the session's history (the 24 actors of classes Training spawned first), the AI event
manager's objects (355 `AIEventType`/`AISenderEvent`/`AIReceiverEvent` that Play's Rust manager does not materialize), the window system's objects
(Play's window host numbered every window class from one shared counter) and a flag object (Play names a `FlagBool` by its flag). Rows 4.3.6 (103 of 103 calls, 557 of 557 registry takes) and 4.1.10 pass unchanged.

## Explicitly unresolved branches

The accepted contract does not establish existing-object reuse and
class-compatibility rules in `StaticFindObject`, invalid `Outer`/`Class+0x49c`
combinations, non-null `SubobjectRoot`, allocator failure cleanup, or
constructor selection beyond the recovered Actor and CameraPoint registrations.
The direct native offset mapping of the four Actor FName/FPlane
constructor targets remains unproven beyond the four-element shape and the
matching script/generated declarations.

## Implemented boundary

`src/runtime/script-object-construction.mjs` translates generated names with a
per-loaded-class signed counter, fresh UObject headers, free-index reuse,
Outer/name hash insertion and dispatch after registration. The recovered Actor
and CameraPoint native constructors preserve copied member values and install
their respective virtual tables. `ScriptRuntime.constructObject` copies every
linked script property after the Core.Object header from an explicit template
or linked class defaults, retaining object identities and copying owned values.
It leaves the state frame null; a later `initExecution` installs that frame.

The host must supply the complete object/name lookup boundary, FName interning,
verified class/Outer eligibility, native template fields and the class-selected
constructor. These are explicit requirements, not defaults inferred from Play's
partial actor list. The JS representation does not reconstruct unused native
memory bytes. Existing-name replacement and config/localization are unsupported;
their rejection is a scope guard before allocation, not a translation of their
native side effects. Level actor insertion and the SpawnActor callback sequence
are not implemented by these helpers.

`node scripts/validate-script-construction.mjs` uses the original CameraPoint
class and inherited property metadata with a controlled template, registry and
name table. It checks collision-driven naming, header bindings, preservation of
template strings/vectors/fixed name arrays, the recovered CameraPoint native
constructor and separate execution-frame initialization. Two focused helper
checks cover signed counter wrap/name truncation and registration/constructor
order with reusable indices.
