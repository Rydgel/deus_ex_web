# ConSys conversation construction

This note records the installed GOTY native constructor paths needed by
conversation loading and actor binding. It does not authorize a generic Actor
constructor for `DataLinkPlay`. The package and native evidence are:

- `ConSys.u` SHA-256 `3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada`;
- `ConSys.dll` SHA-256 `f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`;
- `DeusEx.u` SHA-256 `257f5c166739b3d13884a8b8e98a47dda458b325fa929b3b3b99be056cb74480`;
- PE image base `0x10000000`, with the original import slots shown below.

The ConSys static registration routines call the Core `UClass` constructor
through IAT `0x100130d8`. Their common inputs are raw object flags
`0x04084004`, input class flags `0`, a zero `FGuid`, `Within = Core.Object`,
config text `System` at `0x1001d16c`, package text `ConSys` at `0x1001d990`,
and the imported `UObject::StaticConstructor` at `0x10013008`. The registration
pushes `config`, `package`, and class name in that order because the native
calling convention pushes the later arguments first.

| script class | package export / script flags | native registration | static UClass | size | selected constructor | instance vtable | superclass |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `ConObject` | 6 / `0x113` | `0x1000ecf0` | `0x10026de0` | `0x28` | `0x10001370` → `0x10001380` | `0x100131c4` | `Core.Object` |
| `Conversation` | 30 / `0x112` | `0x1000f070` | `0x100277e8` | `0x78` | `0x100026d0` → `0x1000f120` | `0x100133c4` | `ConSys.ConObject` |
| `ConListItem` | 83 / `0x112` | `0x1000ec10` | `0x100268e0` | `0x30` | `0x10002e60` → `0x1000ecc0` | `0x1001346c` | `ConSys.ConObject` |

The class export flags for all three native/noexport classes are
`0x040f0004`. `ConObject` is declared `abstract native noexport`; `Conversation`
and `ConListItem` are declared `native noexport`. Their serialized class
`ClassFlags` are the package values in the table; the `0x04084004` value is the
separate raw UObject flags passed to native UClass registration.

The concrete default constructors call Core `UObject::UObject()` through
ConSys IAT `0x10013080`, then install their own vtable. `DConObject` writes
only `0x100131c4` at object offset `+0`. `DConversation` writes only
`0x100133c4` at `+0`; it does not call the DConObject body. `DConListItem`
writes `0x1001346c` at `+0`, then clears `con` at `+0x28` and `next` at
`+0x2c`. The script fields and defaults are still supplied by the ordinary
`InitProperties` step before native constructor dispatch. For example,
`Conversation` has the serialized default `bGenerateAudioNames = True`.

The internal-constructor thunks are null guarded. A non-null object jumps to
the concrete body and a null object returns immediately:

```text
DConObject    0x10001370 → 0x10001380
DConversation  0x100026d0 → 0x1000f120
DConListItem  0x10002e60 → 0x1000ecc0
```

`DConListItem::operator new` at `0x10002dc0` is also recovered. It forwards
the explicit class `0x100268e0` to Core `StaticAllocateObject` through IAT
`0x10013024` with the caller's `Outer`, `FName`, and flags, a null template,
the current `GError`, and a null subobject root. This is the allocation path
used by `DConversationList::BindConversations` at `0x10010b70`: the function
requests `0x30` bytes, invokes the `DConListItem` constructor, stores the
matched `Conversation` at `+0x28`, prepends the previous actor list head at
`+0x2c`, ORs `RF_Public` (`0x4`) into the new object's flags at `+0x1c`, and
stores the new head in `Actor + 0x2dc` (`ConListItems`). The purge path at
`0x10010cf0` walks that chain, decrements the conversation bound count at
`Conversation + 0x74`, calls the list-item virtual cleanup/destructor slot,
and clears the actor head. This confirms the prepend order observed by the
live binding capture.

`DConversation::BindEvents` at `0x1000fec0` is a separate native method. It
does not allocate `ConListItem`; it iterates event arrays and delegates actor
binding. The script native methods and indices are separate boundaries:

| script method | native index | native export/body |
| --- | ---: | --- |
| `CreateFlagRef` | 2050 | `execCreateFlagRef` `0x10010600` |
| `CreateConCamera` | 2051 | `execCreateConCamera` `0x100106f0` |
| `BindEvents` | 2052 | `execBindEvents` `0x10010780` |
| `BindActorEvents` | 2053 | `execBindActorEvents` `0x10010840` |
| `ClearBindEvents` | 2054 | `execClearBindEvents` `0x100108c0` |
| `GetSpeechAudio` | 2055 | `execGetSpeechAudio` `0x10010900` |
| `GetSpeechLength` | 2056 | `execGetSpeechLength` `0x10010980` |

Those exec services remain owned by the ConSys/DataLink service work. The
constructor evidence does not establish their VM argument marshalling,
conversation UI, audio, or event execution semantics.

`DataLinkPlay` has a different status. `DeusEx.u` export 1154 has serialized
`ClassFlags = 0x3a`, export flags `0x000f0004`, and superclass export 4533
`ConPlayBase`. Its source declaration is exactly:

```uc
class DataLinkPlay expands ConPlayBase
    transient;
```

`ConPlayBase` is `class ConPlayBase expands Actor;` with serialized
`ClassFlags = 0x32`. Neither declaration is `native`, and the installed
`DeusEx.dll` export table has no `DataLinkPlay` or `ConPlayBase` constructor,
static-class, or vtable symbol. No independent native constructor or vtable
was recovered for DataLinkPlay. The subsequent
[scripted actor investigation](script-scripted-actor-construction.md) recovered
Core.UClass.Bind copying Actor's registered constructor10302dab through both
script classes. The shared spawn path now accepts that exact verified chain
and dispatches the inherited constructor with vtable104268dc. The mutable
class-slot writes are checked by [original native execution](script-class-bind.md).
Full package/world loading remains separate from the focused startup fixture.

The bounded implementation records these facts in
`src/runtime/script-conversation-construction.mjs`, and
`scripts/validate-script-conversation-construction.mjs` checks the package
declarations, native indices, constructor bytes, registration arguments,
and the `DConListItem` allocation/link writes against the installed files.

## ConListItem allocation and scalar release

The C++ operator new10002dc0 calls Core.StaticAllocateObject through
IAT10013024 with its ConListItem class, Outer, NAME_None, flags0, null
template, imported GError and null final argument. It returns before the
caller invokes constructor1000ecc0. That constructor calls UObject's
constructor through10013080, writes ConListItem vtable1001346c, then zeros
con+28 and next+2c. It does not write ObjectFlags.

The ConListItem vtable's deleting slot+0c points to10002ed0. For scalar
flags1, it calls destructor10002df0, then Core.UObject.operator delete
through1001308c with (object,size30). The complete destructor writes
vtable1001346c and calls ConditionalDestroy through1001307c, then writes
base ConObject vtable100131c4 and calls ConditionalDestroy again. Finally it
calls Core.UObject destructor through10013078. These repeated calls are
required even though the first may already have set destruction flags.
Both ConListItem and ConObject vtables have destruction-hook slot+24 pointing
to thunk100110c2, which jumps through IAT10013054 to Core.UObject.Destroy.
Array flags2 use a separate reverse-array helper and remain unsupported.

The shared fresh allocation path can stop after property initialization and
registry insertion so this C++ new/constructor ordering remains explicit.
The ConListItem release uses the existing Core destructor/registry/free
services after its own two vtable/ConditionalDestroy operations. These
services must bind the actual native allocation record; a plain `{con,next}`
object is not a constructed ConListItem.

`scripts/validate-conversation-item-lifecycle.mjs` executes constructor1000ecc0
and scalar wrapper10002ed0 for flags0/1. Core's base constructor executes from
the original image; process-dependent ConditionalDestroy/base-destructor/free
imports are explicit services. It compares the vtable/field writes, unchanged
ObjectFlags, two conditional calls, Destroy thunk routing and size30 delete
gate with the translation. The Training binding validator separately exercises
the shared logical Core registry and destructor path on typed allocated items.
