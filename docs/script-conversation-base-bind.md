# ConSys inherited `ConEvent.BindActor`

This note records the concrete ConSys event classes whose installed native
vtable slot `+0x58` points at the inherited `DConEvent::BindActor` body.  The
source package is `System/ConSys.u` (SHA-256
`3e9b10d48d5578ca7495e71a3c97540c693ac8dcc02393afe6633ba35b4c0ada`) and the
native image is `System/ConSys.dll` (SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`).  The
DLL is PE32 with image base `0x10000000`.

The original body is exported as `DConEvent::BindActor` at absolute address
`0x10002350` (RVA `0x2350`).  Its bytes in the installed image are:

```
32 c0 c2 0c 00       xor al, al; ret 0xc
```

`ret 0xc` consumes the three stack arguments in
`BindActor(Actor firstActor, Actor candidateActor, Conversation conversation)`.
The body reads neither `this` nor those arguments, performs no field writes,
and returns the logical value `false`.

## Package records

`ConSys.u` export 2 is the abstract base declaration.  Its TextBuffer is
export 328 (`ConEvent.ScriptText`), its serialized class flags are `0x113`,
and its source begins `class ConEvent extends ConObject abstract native
noexport;`.  Every direct event class below has export flags `0x040f0004`,
serialized class flags `0x112`, superclass export 2, and a class TextBuffer
with the listed export number.  The declarations were read from those
TextBuffers; they all say `class <name> extends ConEvent native noexport;`.

The vtable names are the original exported `??_7D<Class>@@6B@` records.  The
slot target is read from the exported vtable pointer plus `0x58`; no class is
classified from its name alone.

| Exact package class key | Class export | TextBuffer export | Exported vtable | `+0x58` target | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `ConSys.ConEventSpeech` | 4 | 306 | `0x10013c30` | `0x1000b070` | override; unsupported here |
| `ConSys.ConEventMoveCamera` | 24 | 312 | `0x10013b08` | `0x100098f0` | dedicated false-return binder; setup remains source-prescribed no-op |
| `ConSys.ConEventJump` | 35 | 313 | `0x10013664` | `0x10002350` | inherited false body |
| `ConSys.ConEventAddCredits` | 357 | 325 | `0x10013714` | `0x10002350` | inherited false body |
| `ConSys.ConEventAddGoal` | 358 | 324 | `0x10013770` | `0x10002350` | inherited false body |
| `ConSys.ConEventAddNote` | 359 | 323 | `0x100137cc` | `0x10002350` | inherited false body |
| `ConSys.ConEventAddSkillPoints` | 361 | 322 | `0x10013828` | `0x10002350` | inherited false body |
| `ConSys.ConEventAnimation` | 362 | 321 | `0x10013884` | `0x100071b0` | override; unsupported here |
| `ConSys.ConEventCheckFlag` | 364 | 320 | `0x100138e0` | `0x10002350` | inherited false body |
| `ConSys.ConEventCheckObject` | 365 | 319 | `0x1001393c` | `0x10007bf0` | dedicated `NK_`/class-loader binder |
| `ConSys.ConEventCheckPersona` | 366 | 318 | `0x10013998` | `0x10002350` | inherited false body |
| `ConSys.ConEventChoice` | 367 | 316 | `0x100139f4` | `0x10002350` | inherited false body |
| `ConSys.ConEventComment` | 368 | 315 | `0x10013a50` | `0x10002350` | inherited false body |
| `ConSys.ConEventEnd` | 370 | 314 | `0x10013aac` | `0x10002350` | inherited false body |
| `ConSys.ConEventRandomLabel` | 371 | 308 | `0x10013b78` | `0x10002350` | inherited false body |
| `ConSys.ConEventSetFlag` | 372 | 307 | `0x10013bd4` | `0x10002350` | inherited false body |
| `ConSys.ConEventTrade` | 373 | 305 | `0x10013c8c` | `0x100071b0` | override; unsupported here |
| `ConSys.ConEventTransferObject` | 381 | 304 | `0x10013ce8` | `0x1000bc40` | override; unsupported here |
| `ConSys.ConEventTrigger` | 382 | 303 | `0x10013d44` | `0x10002350` | inherited false body |

The exact verified inherited-false set is:

```
ConSys.ConEventJump
ConSys.ConEventAddCredits
ConSys.ConEventAddGoal
ConSys.ConEventAddNote
ConSys.ConEventAddSkillPoints
ConSys.ConEventCheckFlag
ConSys.ConEventCheckPersona
ConSys.ConEventChoice
ConSys.ConEventComment
ConSys.ConEventEnd
ConSys.ConEventRandomLabel
ConSys.ConEventSetFlag
ConSys.ConEventTrigger
```

The inherited helper rejects these five distinct override targets:

```
ConSys.ConEventSpeech       -> 0x1000b070
ConSys.ConEventAnimation    -> 0x100071b0
ConSys.ConEventCheckObject  -> 0x10007bf0
ConSys.ConEventTrade        -> 0x100071b0
ConSys.ConEventTransferObject -> 0x1000bc40
```

`ConSys.ConEventMoveCamera` is the one separately admitted concrete event
slice. Its vtable still selects the distinct `0x100098f0` address, whose
installed body is the same five-byte no-read false result as the inherited
body. `bindConversationMoveCameraActor` therefore keeps a separate exact-key
dispatch boundary. The authored `DataLinkPlay.PlayEvent.SetupEvent` source
groups `ET_MoveCamera` with its unsupported no-op cases; the local action stays
at `EA_NextEvent`, and the original `ProcessAction` advances
`currentEvent.nextEvent`. The canonical reference is Mission00
`Conversation0`/`M00MeetPage` export 989, MoveCamera export 50071, then Speech
export 50044. This slice does not implement camera presentation. The CheckObject override is
covered separately by the [native loader binder](script-conversation-check-object-bind.md);
the later inventory/keyring test is still outside that binder.

`ConEventMoveCamera` is kept in the override list even though its target has
the same short false-return byte sequence in this image: its vtable selects a
distinct native address, and no semantic equivalence is claimed here.

## Runtime boundary

`src/runtime/script-conversation-base-bind.mjs` exposes the pinned evidence
map, `conversationBaseBindNativeContract(classKey)`,
`isConversationBaseBindClass(classKey)`, and
`bindConversationBaseActor({classKey})`.  The last function returns `false`
only for the thirteen exact keys above.  It performs no receiver or argument
reads, matching the native body.  The same module exposes the separate
`CONVERSATION_MOVE_CAMERA_BIND` contract,
`isConversationMoveCameraBindClass(classKey)`,
`conversationMoveCameraBindNativeContract(classKey)`, and
`bindConversationMoveCameraActor({classKey})`; that binder returns `false`
only for the exact MoveCamera key and performs no receiver or argument reads.
Known overrides still throw an explicit `CONVERSATION_BASE_BIND_OVERRIDE`
error when sent to this inherited helper; exact-key dispatch chooses their
dedicated binders first. An unknown or malformed key throws an explicit
class-key error.

The shared `Conversation.BindActorEvents` host routes its already-resolved
MoveCamera class key through `isConversationMoveCameraBindClass`, CheckObject
through its [dedicated binder](script-conversation-check-object-bind.md),
TransferObject through its [actor/class binder](script-conversation-transfer-object-bind.md),
and inherited keys through `isConversationBaseBindClass`. Speech, Animation,
and Trade also have dedicated binders. These helpers do not replace the
surrounding original VM/native event walk.

`scripts/validate-conversation-base-bind.mjs` verifies the package superclass
and TextBuffer records, parses the installed PE export directory, checks every
`??_7DConEvent...` vtable identity and `+0x58` raw pointer, pins the body
bytes, and exercises all thirteen accepted keys plus all six explicit
override failures:

```
node scripts/validate-conversation-base-bind.mjs
```

The validation is for this hash-pinned GOTY build.  Other ConSys builds,
external subclasses, and any additional native target remain unverified.
