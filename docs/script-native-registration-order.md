# Native UObject registration order

This note records the smallest native-only bootstrap path needed to give
`Core.Class` its real object identity. The authority is the installed GOTY
`Core.dll`, with focused disassembly in `.cache/research/Core.asm`; the public
engine sources are only terminology references. Addresses below are original
image virtual addresses.

## The constructor header and registration queue

`UObject` construction enters the exported thunk `1010339b` and body
`1014f4c0`. Before registration it writes the common header as follows:

- `+04 = -1` (not yet an entry in `GObjObjects`), `+08/+0c/+10/+18/+20 = 0`,
  and `+14 = -1`;
- `+1c = input object flags | 04000000` and `+24 = input class`;
- after checking the raw global at `102a2648`, it writes the source name pointer
  to `+20` and the source outer/package-name pointer to `+18`. The branch at
  `1014f501` skips `appFailAssert` when this global is zero and reaches the
  assertion only when it is nonzero; its symbolic meaning is unresolved.
- it prepends the object to the singly linked registration list at
  `102a265c`, using the object's `+14` as the next link.

When the registration gate at `102a2644` is already set and the object's class
is the native `Core.Object` class at `1029e0d0`, the constructor immediately
calls `UObject::Register` (`101020ae` -> `10152550`). Other objects remain on
that queue. `appInit` writes `1` to `102a2648` at `101527bb`, temporarily writes
`0` at `10153077` while loading, and restores `1` at `10153092`; this is not a
simple object-system-initialized flag, so the host contract preserves the raw
branch and does not prescribe a guessed value.

`ProcessRegistrants` (`101018d4` -> `10152a40`) is the queue drain. It increments
nesting depth at `102a2654` and only the outermost call drains. It repeatedly
copies the current head into the temporary `FArray` at `1029e5e8`, advances the
head through `+14`, and then calls `ConditionalRegister` (`101022ac` ->
`1014fea0`) for each temporary entry in ascending array order. Since each
constructor prepends, this is reverse construction order. The temporary array
count/capacity are reset and freed before the routine asserts that the queue
head (`102a265c`) is null, then the nesting depth is decremented. A registration
callback that leaves a new queue entry reaches that final assertion; the
reentrant behavior outside this observed path is not inferred here.

`ConditionalRegister` checks that an unregistered object (`+04 == -1`) is one
of the temporary registrants, then dispatches virtual slot `+4c`. If `+04 !=
-1`, the native branch returns directly without dispatching again. It does not
insert the object itself; the class-specific virtual `Register` implementation
performs that work.

## Core.Class's initial identity

The static registration body for `Core.Class` is `10128750`, and its static
object storage is `101f1c18` (`?PrivateStaticClass@UClass@@0V1@A`). It calls the
shared `UClass` constructor (`10102d9c` -> `10128630`) with these recovered
inputs:

| input | value |
| --- | --- |
| native instance constructor (`+4e0`) | `10102e0a` (`UClass::InternalConstructor`) |
| static constructor (`+4e4`) | `10101041` (`UObject::StaticConstructor`, a `ret`) |
| raw object flags | `04084004` |
| config text | `101a82c8` = `System` |
| package/outer text | `101a7ef4` = `Core` |
| object name text | `101a9f56` = `Class` |
| FGuid | zeroed local value |
| Within | `1029b8e0` (`Core.Package` static UClass) |
| Super | `101f2118` (`Core.State` static UClass) |
| class flags input | zero |
| instance size | `4f4` |

`UStruct` construction (`1010126c` -> `10125ef0`) calls the UObject
constructor with the hardcoded class pointer `101f1c18` at `10125f05`. Thus
this static object has `+24 == this`: the DLL gives `Core.Class` its self-class
identity before the registration queue is drained. Its `Super` is subsequently
stored at `+28`; the UClass constructor stores the class metadata and installs
vtable `101758f4`.

## Registration and registry insertion

The virtual slot `+4c` for this object reaches `UClass::Register`
(`10101e74` -> `10127800`). Its first operation is `UStruct::Register`
(`10103076` -> `10125fe0`), which calls `UField::Register` and then
`UObject::Register` (`101020ae` -> `10152550`). The base registration order is:

1. Assert the registration gate `102a2644` is set.
2. Read the still-textual `+18` and `+20`. The cdecl pushes at `101525a0`
   and `101525a2` mean the semantic call is
   `CreatePackage(Outer = NULL, Name = object->+18)`.
3. Store the returned `UPackage*` in `+18`, construct `FName(+20,
   EFindName=1)` (`10102e96`), and replace `+20` with that FName index.
4. Set `+14 = -1`; duplicate/missing-package and zero-name cases only log in
   the observed body.
5. Resolve the name text through `GNames` at `102961f0`, call
   `StaticFindObject(Class=NULL, Outer=object->+18, Name=text,
   ExactClass=0)` (`1010326a`), and log if a duplicate is found.
6. Call `AddObject(-1)` (`10102473` -> `10157830`). `AddObject` writes the
   object into `GObjObjects` data at `1029e628`, stores the chosen index at
   object `+04`, and only then calls `HashObject` (`101012e9` -> `10157730`).

`HashObject` computes
`((object->+18 ? object->+18->+04 : 0) XOR object->+20) & 0xfff`, prepends the
object to the corresponding bucket in `GObjHashBuckets` at `1029e644`, and
stores the previous head in object `+08`. Therefore the registry insertion
order is array slot first, hash chain second. `AddObject` may reuse the last
free index from the free-index array; that allocator path is part of
`AddObject`, not a separate registration step.

`CreatePackage` (`10101ccb` -> `101549f0`) first calls `ResolveName` with the
outer/name references and flags `1,0`, then searches for a `Core.Package`
object (`1029b8e0`) via `StaticFindObject`. If absent, it constructs a 0x34
byte `UPackage` with `FName(EFindName=1)` and `UPackage`'s constructor
(`10101a9b`). The detailed package/config path is outside this bounded
registration contract.

## UClass post-registration calls

After the base identity has been inserted, `UClass::Register` continues in the
same body (`10127830`–`101279bb`):

1. Convert `ClassConfigName` at `+4a0` to an FName (`EFindName=1`), call the
   virtual slot `+64` to obtain the properties size, and initialize `Defaults`
   at `+4d4`.
2. Call `InitClassDefaultObject` (`10101226`).
3. If the superclass static-constructor pointer differs, call this class's
   static constructor (`+4e4`) on its defaults object.
4. Copy the selected superclass class flags into `+484`.
5. Build a local metadata frame and call virtual slot `+6c`.
6. Call `LoadConfig(0,0,0)` (`101023dd`) and then `LoadLocalized(0,0)`
   (`1010306c`).

`Bind` (`10102afe` -> `10127a20`) and `Link` are separate later phases; the
`UClass::Register` body does not call them. Native export resolution, field
linking, and the full config/default/localization resources therefore remain
explicit dependencies for a complete native class graph.

## Smallest supported bootstrap

A host that needs only the native `Core.Class` identity can reproduce this
source-backed order:

1. Initialize the 4096 hash buckets at `1029e644` and set the registration
   gate `102a2644`, as `appInit` (`10152790`) does. Preserve the raw
   `102a2648` branch described above; its startup value is not prescribed by
   this registration contract.
2. Run the DLL's static `Core.Class` registration body (`10128750`) so the
   object is constructed with `+24 == 101f1c18` and queued at `102a265c`.
3. Drain with `ProcessRegistrants` (`10152a40`), preserving its temporary array
   and reverse-construction order.
4. Dispatch `ConditionalRegister` through virtual `+4c`; for Core.Class this
   reaches `UClass::Register`, then `UStruct`/`UField`/`UObject::Register`,
   `CreatePackage(NULL, "Core")`, FName assignment, `AddObject`, and
   `HashObject` in that order.
5. Treat `InitClassDefaultObject`, the class static constructor,
   `LoadConfig`, `LoadLocalized`, and virtual `+6c` as reached calls. Bind/link
   and resource loading need their own verified implementation before claiming
   a complete class bootstrap.

This note does not establish a synthetic catalog for other native classes. It
also leaves the exact symbolic names and full semantics of globals
`102a2644/48/54/5c`, `ResolveName`, package creation, defaults, config/localized
loading, and later Bind/Link branches unresolved beyond the calls and field
order shown above.

## Host adapter

`src/runtime/script-native-registration.mjs` exposes
`createScriptNativeRegistration`. It requires a `ScriptObjectRegistry`, a
`createScriptNames` result, mutable raw globals, and concrete callbacks for
the three calls that cannot be replaced by empty host behavior:

```text
createPackage({outer: null, name, object}) -> package|null
staticFindObject({classRef: null, outer, name, exactClass: 0, object})
  -> existing|null
virtualRegister(object, {vtableOffset: 0x4c})
```

The adapter methods are `constructUObject`, `registerUObject`,
`conditionalRegister`, `processRegistrants`, `addObject`, and `hashObject`.
`constructUObject` accepts the raw `objectClass`/`nameText`/`outerText`/`flags`
inputs (with `classRef`/`name`/`outerName` aliases) and retains
the class constructor pointers as `nativeInstanceConstructor` (`+0x4e0`) and
`staticConstructor` (`+0x4e4`). It writes the native UObject header, checks
that raw `102a2648` is zero on the accepted path, prepends the record through
`102a265c`, and takes the immediate base-register branch only when the
registration gate is set and the supplied class identity is Core.Object.

`registerUObject` invokes the required package callback, interns the name with
`EFindName=1`, resolves the canonical GNames text for the required lookup
callback, and performs the live object-array write followed by hash linking.
The adapter uses the registry's arrays directly so `addObject` and
`hashObject` remain separately observable in the original order. Its strict
assertion policy reports the native `appFailAssert` boundaries and throws for
nonzero `102a2648`, a zero registration gate, malformed registrant membership,
or a queue left after processing; callers may opt into the original
assert-and-continue behavior explicitly with `continueAfterAssert`.

`conditionalRegister` follows the native `+04 != -1` early return: an already
indexed object produces no virtual dispatch or registration side effects. The
constructor's immediate Core.Object branch still leaves its raw queue-head
pointer in place while base `Register` resets the object's `+14` link, matching
the original constructor/register sequence; the later queue drain therefore
reports that malformed sentinel rather than silently repairing it.

The adapter intentionally stops at `virtualRegister`: UClass's default-object,
class-static-constructor, config/localization, and Bind/Link work remains the
separate native class metadata boundary described above.
