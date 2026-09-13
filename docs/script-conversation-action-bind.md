# ConEventAnimation and ConEventTrade actor binding

This note records the shared native `BindActor` body used by the installed GOTY
`ConEventAnimation` and `ConEventTrade` classes.  It is a small event-field
binding operation; it does not implement animation playback or the trade
interaction.

The package evidence is `ConSys.u` (SHA-256
`3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada`).  The
class exports and their TextBuffers are:

| class | class export | TextBuffer export | serialized class flags | source fields used here |
| --- | ---: | ---: | ---: | --- |
| `ConEventAnimation` | 362 | 321 | `0x112` | `eventOwner`, `eventOwnerName` |
| `ConEventTrade` | 373 | 305 | `0x112` | `eventOwner`, `eventOwnerName` |

The source declarations are `class ConEventAnimation extends ConEvent native
noexport` and `class ConEventTrade extends ConEvent native noexport`.  Their
property exports confirm `eventOwner` and `eventOwnerName` for Animation at
276/277 and for Trade at 227/228.  The native layout inherited by both event
objects places `eventOwner` at `+0x40` and its `FString eventOwnerName` at
`+0x44` (`Data`, `ArrayNum`, `ArrayMax` at `+0x44/+0x48/+0x4c`).  The candidate
actor uses the Engine `Actor` fields `BindName` at `+0x2ac` (`ArrayNum +0x2b0`)
and `BarkBindName` at `+0x2b8` (`ArrayNum +0x2bc`).

Both class vtables select the same body at `0x100071b0` through virtual slot
`+0x58`:

| class | instance vtable | `vtable + 0x58` |
| --- | ---: | ---: |
| `ConEventAnimation` | `0x10013884` | `0x100071b0` |
| `ConEventTrade` | `0x10013c8c` | `0x100071b0` |

The body has the native signature
`BindActor(Actor firstActor, Actor candidateActor, Conversation conversation)`.
It ignores `firstActor` and uses the second stack argument as the candidate.
At `0x100071b9` it reads the event owner name's `ArrayNum` first.  A non-zero
count selects `event + 0x44`; a zero count selects the mapped static empty
TCHAR at `0x1001e1cc`.  The original ConSys image maps that location as eight
zero bytes, so it represents an empty string.  It is not the FName spelling
`None`, and the host must not write `None` there as a fallback.  The same
count-then-data rule is applied to candidate `BarkBindName` at `+0x2b8/+0x2bc`
and then to normal `BindName` at `+0x2ac/+0x2b0`.

The exact branch and call order is:

1. Read `eventOwnerName` and candidate `BarkBindName`, substituting the
   static empty text for either zero `ArrayNum`, then call the imported
   `appStricmp`/`_wcsicmp` at IAT `0x100130d0`.  The native pushes the event
   pointer and then the candidate pointer, so the cdecl comparator sees
   `(candidateBarkBindName, eventOwnerName)`.
2. If that comparison is equal, read `conversation + 0x50`, mask with `4`,
   and accept the bark match only when the masked value is `4`. This is the
   reflected `bFirstPerson` property; the layout evidence is below.
3. If the bark comparison was unequal, or it was equal while that bit was
   clear, read `eventOwnerName` again and then candidate `BindName` and call
   the same comparator again with `(candidateBindName, eventOwnerName)`.
4. On a normal match, write the candidate pointer to `event + 0x40` and return
   `true`.  Otherwise preserve the existing `event + 0x40` reference and
   return `false`.  The first actor argument is never read, and no other event
fields are changed.

## Conversation flag identity

The original Conversation Children chain, filtering UProperty subclasses in
native UStruct.Link order, begins with NameProperty export123 `conName`, then
StrProperty exports347/334/330 `Description`, `CreatedBy`, `conOwnerName`.
ConObject has native instance size `0x28` and adds no reflected properties.
Core's recovered NameProperty.Link10167250 and StrProperty.Link10167640 give
offsets `0x28`, `0x2c`, `0x38`, `0x44`; the next property starts at `0x50`.
The next three Children entries are BoolProperty exports311/310/309:
`bDataLinkCon`, `bDisplayOnce`, `bFirstPerson`, each ArrayDim1 and flags0.
Core UBoolProperty.Link10166060 calls UClass.MergeBools10111560 (true),
assigns the first bool mask1, and shifts the previous mask for consecutive
bools. Their masks are therefore 1, 2, 4 at the same offset `0x50`.
The native action gate reads `bFirstPerson`, not an undeclared bark flag.

The focused oracle executes those original property Link bodies in the
package's order with the recovered `0x28` base size. The caller publishes
`Offset + ElementSize * ArrayDim` between calls, as UStruct.Link does.
The shared event dispatch can consequently use the typed `bFirstPerson`
property; it requires no invented native flags word or default.

A read-only live capture on2026-09-12 independently confirms this layout in
the original Training process: Class.Conversation PropertiesSize120,
`bFirstPerson` Offset80 (`0x50`), ElementSize4, ArrayDim1, BitMask4. The
complete new capture is kept outside Git at
`.cache/stage3-live-training-20260912.txt`; `tools/dump-stage3-win.c` reproduces
the targeted read. The existing object-registry and actor-list captures remain
the references for those separate identities.

The native body is loaded and executed directly by
`scripts/native-conversation-action-bind-oracle.py`.  Its comparator is the
only serviced call; the oracle leaves the mapped empty storage untouched and
records both vtable selections, comparison operands, and `event +0x40` writes.
`src/runtime/script-conversation-action-bind.mjs` uses canonical logical
strings, where a zero-length `FString` is represented by `''`, while keeping
the native read/comparison order.  The runtime requires a typed field reader,
typed field writer, and synchronous comparator.  It does not claim the
unresolved animation/trade action routines or event construction.
