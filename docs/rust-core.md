# Rust simulation core

This plan moves the simulation's hot core (object memory, the UnrealScript VM,
primitive natives, then physics and collision) to Rust compiled to
WebAssembly. It continues [object memory](object-memory.md) stage 1e and the
direction in [frame cost](play-frame-cost.md#direction): "WebAssembly follows
the data". The behavior contract does not change. Every step is a
representation change, proven the same way as before: native oracle cases,
the full validator sweep, and `bench-sim` state digests
([frame cost](play-frame-cost.md)).

## Why now

The goal is 120 fps (8.3 ms per frame) on the largest maps. On September 29,
running UNATCO Island (`01_NYC_UNATCOIsland`, `--bypass`) in the browser
measured about 46 to 50 ms per frame. The simulation tick was 25 to 29 ms of
that; the rest was actor meshes, the HUD and rendering.

The tick is not doing much original work. In one Island tick, measured by
`scripts/bench-sim.mjs --render-feedback`:

* The VM runs about 11,700 statements and 44,000 expression nodes. That is
  about 300 ns per node, 10 to 30 times a lean interpreter.
* All non-primitive natives together take about 2.3 ms. The costliest is
  AICanSee (705), at about 50 µs per call.
* Most of the rest is the host object model:
  * 116,000 receiver→instance lookups per tick. Actor host objects are in
    V8 dictionary mode (2,584 of 2,586 on Island), so each lookup is a hash
    probe of about 20 to 36 ns.
  * 48,000 `readNamed` calls, at about 60 to 100 ns each.
  * VM variable references, each an allocated object with closures.
  * String-keyed `Map` locals.
* Exact x87 arithmetic falls back to BigInt in JavaScript. In Rust the same
  80-bit model is `u128` integer code (`native/lodmesh-kernel`, `Ext`).

JavaScript tuning halved the tick (Island 47.0 → 25.5 ms headless, digests
unchanged; see the September 29 section of [frame cost](play-frame-cost.md)).
Further JavaScript work would be replaced by the steps below, so it stops
here.

Two conclusions follow. First, a line-by-line port of the current design would
still be slow: its layers would become hash maps and callbacks in Rust.
Second, a Rust VM is useless while object state lives in JavaScript objects.
Every field access would cross the Wasm boundary, as the frame-cost notes
warned. The data has to move first.

## Target architecture

* **One linear memory.** A `WebAssembly.Memory` holds every script object's
  property image at the linked offsets (stage 1d layout, unchanged), along
  with the object table, name table and string heap. JavaScript reads and
  writes it through typed-array views that are re-derived after memory
  growth, the rule the mesh kernel already follows
  ([lodmesh Wasm](lodmesh-wasm.md)).
* **Numeric identities.** Object and class slots hold object-table indices,
  names hold name-table indices, and strings hold string-heap handles. These
  are host identities, not the original GObjObjects indices or FName values.
  Those stay with the boot-replay model ([boot replay](boot-replay.md)) and
  the Unresolved items in [object memory](object-memory.md#unresolved).
* **Rust VM.** The statement loop, expressions, calls, frames with locals in
  linear memory, states and latent actions, iterators, and the primitive
  (operator) natives with the 80-bit x87 model.
* **JavaScript natives as imports.** Natives not yet ported are called
  through one imported dispatch function. They keep today's `call` interface:
  `evaluateArgument(i)` calls back into the VM, so each native still decides
  its own argument order. They read and write fields through the shared
  memory.
* **Host-owned fields.** A field with a binding is flagged per object, and
  the VM calls JavaScript for it. Stage 1e then moves those fields into the
  image (position, collision word, Touching, regions, player view), and the
  flag goes away.
* **Presentation stays JavaScript.** three.js, the HUD renderer, audio and
  input stay in JavaScript. They read actor state from the shared memory.

## Steps

**R0 — Arena (implemented).** Every object image is a range of one
`WebAssembly.Memory` per runtime (`script-object-arena.mjs`). An instance
keeps `arena`, `base` and `size`. The access paths pass the arena's current
view and the base to the existing cell functions (they already took a base
offset), so no view outlives an allocation that grows the memory.
`instance.image` remains, as a view of the range addressed from zero, for
callers outside the access paths.

* **Lifetime.** Core's `freeObject` (the LoadMap collection, CriticalDelete
  of conversation items, DataLink cleanup) releases the object's range.
  Objects the collection model never frees, which the JavaScript GC used to
  reclaim once unreachable, release theirs through a `FinalizationRegistry`
  on the identity. A released range is reused only after `reclaimReleased()`,
  which runs at the end of a purge and at the start of each level tick. A
  reference built before the release (a `CellStorage`) therefore reads the old
  bytes until then, as it read the old buffer before.
* **Class default images** are ranges too. A class image can sit in another
  runtime's arena, because classes are shared; object construction copies its
  bytes across.

Verification: identical digests on Training (`ab389675b5413a8b`) and Island
with render feedback (`5496f30ee89033fc`). Also `validate-object-image` (1,474
classes), the LoadMap GC, destroy, spawn and DataLink validators, 546 unit
tests, the full sweep, and a browser Island run. Arena growth across 22
Player starts in `validate-loadmap-gc` is 58 KB per reset before
finalization. After a forced GC, the 4,285 unreachable objects' ranges are
released.

**R1 — Identities in memory.** Put object, class, name and string references
in 4-byte slots with handle tables.

A first attempt stored object and class pointers as handles in a module-wide
table, with names in a name table. `validate-loadmap-gc` rejected it: JS old
space grew 76 MiB over 19 Player starts. Two causes:

* **Objects outside the collection model.** Each reset creates about 25
  conversation-system objects (`Conversation`, `ConItem`, `ConEvent*`). The
  LoadMap collection model never registers or purges them. The JavaScript GC
  reclaims them once only dead reference arrays point at them. A strong
  handle table keeps them alive. A weak table (`WeakRef`) could lose an
  object that is still reachable only through another live object's image,
  such as a `ConListItem` chain.
* **Unique FNames per generation.** A name table that never frees grows
  every reset. The runtime already models the original FName table and the
  purge's deletion of unique names, so image name slots should hold that
  model's indices.

So R1 needs one of two designs:

1. Every object stored in an image is under the collection model, which is
   the original contract: GObjObjects registration and purge.
2. Object slots are written twice. The handle bytes serve Rust, and the
   reference array keeps the identity strongly for lifetime, as today. The
   handle table can then be weak, because the array keeps any identity alive
   while its owner lives.

Option 2 is enough for R2. Strings and dynamic arrays stay in the reference
arrays until owning-copy semantics are recovered.

Which objects end without an explicit release was then measured: the R0
finalizer, run over `validate-loadmap-gc`'s 22 Player starts, released 4,285
ranges. They were all window-system objects: 2,860 `Extension.GC` and the
HUD and window tree (`Window`, `TileWindow`, `TextWindow`, the `HUD*`
displays). Play's window host gives them no registry slot, so the
collection model never frees them. Their lifetime ends at recovered native
points that Play already runs: XWindow's scalar deleting destructor
(`deleteWindow` in `script-window-host.mjs`) and the GC release
(`destroyGc`). Hooking the release there gives these objects exact lifetimes,
and a strong handle table becomes possible for them. A weak table would put
handle recycling at the mercy of JavaScript GC timing while a Rust frame may
still hold a handle, so the explicit hooks are preferred. The conversation
objects of the first attempt carry no image (they are nonnative), so they do
not appear in this count.

**R1a — Object handles (implemented).** An object or class pointer's four
bytes at its linked Offset hold a handle (`script-object-handles.mjs`), and
the reference array keeps the identity. Every JavaScript access still reads
the array, so behavior is unchanged; the bytes are what the Rust core will
follow.

* **Table.** One table for all runtimes, because class default images hold
  handles and are shared. Handles are never reused, so a stale handle names
  no object rather than another one. `writeCell` writes the handle with the
  reference; snapshots and copies move bytes and array together.
* **Lifetime.** A handle ends where its object's lifetime ends:
  `releaseObjectImage` (the LoadMap collection's freeObject, CriticalDelete,
  DataLink cleanup), and XWindow's and XGC's deleting destructors in the
  window host. For windows and GCs only the handle ends there. Their image
  ranges stay with the R0 finalizer, because a host window has no released
  flag and a later access would read a reused range.
* **The conversation objects** that looked like a per-reset leak are not
  one. `prepareConversations` attaches the mission list's ConItem chain once
  per runtime (470 ConItems on Training), and the table keeps them for the
  runtime's life, as the list cache does.

Verification: `validate-loadmap-gc` now requires the live handle count to
stay the same across its 22 Player starts (2,727 on Training); old space
grew 0.5 MiB. `validate-object-image` checks 45,770 class-default pointers
and every pointer probe write at its linked Offset. The new
`validate-object-handles` checks that after 180 Training ticks, all 20,303
pointer slots of the 554 live imaged objects name their reference, struct
members and fixed-array elements included. Digests are unchanged
(`5496f30ee89033fc`, `04f77dc631509ae4`).

**R1a-2 — Handles are the pointer storage (implemented).** An object or
class pointer's handle bytes are now its only storage, so the Rust
interpreter can store a pointer without leaving a stale JavaScript copy. A
pointer cell (`POINTER` in `script-object-image.mjs`) reads the identity its
handle names and writes `handleOf` of the value; it has no reference-array
slot. Object, class-default and frame reference arrays keep only names,
strings and dynamic arrays.

* **Table.** `identityOfHandle` indexes a dense array, because handles are
  consecutive small integers; the Map remains for identity to handle. A
  released handle reads as None.
* **Values.** A pointer holds an object or None. Any other value now throws on
  write. Before, the reference array kept such a value while the bytes held 0.
  The only writes of that kind came from `validate-object-image`'s struct
  and fixed-array probes, which spelled the probed object as a string.
* **Lifetime.** The handle table is now the only strong reference that an
  image holds. It was already strong until release, so no identity ends
  before its release point. After release, an image that still holds the
  handle reads None, where the reference array returned the freed identity.
  That case was traced over the unit tests, `validate-loadmap-gc`, Training
  and Island bench runs and 19 lifecycle validators (DataLink, keypad, conversations, datacube, console,
  crowbar, the Training conformance gate). There were 61 such reads. Every one
  was the pre-read of an assignment that overwrites the pointer: read-merge-store
  in `assignField` or `assignLocalOf`, or the whole-array read of a
  fixed-array element store. That store discards the old pointer. Each pointer
  named a window that XWindow's deleting destructor had ended:
  `DataLinkPlay.datalink`, `InformationDevices.winText`,
  `HUDConWindowFirst.nameWindow`, the popped `DeusExRootWindow.winStack`
  element, and the locals `win` (`HUDConWindowFirst.DestroyChildren`) and
  `itemWindow` (`HUDReceivedDisplay.RemoveItems`). A script that tested such
  a pointer before overwriting it would now see None; none did.

Verification: digests are unchanged under both VMs (`SCRIPT_VM=js` and
`rust`): Training `04f77dc631509ae4` and Island `5496f30ee89033fc`, with
render feedback. The 546 unit tests, `validate-script-vm-interp` and
`validate-script-vm-x87` pass.
`validate-loadmap-gc` keeps 2,727 live handles across 22 Player starts, and
old space grew 0.72 MiB. `validate-object-image` checks its 45,770
class-default pointers against the lazy default path rather than the stored
value. It checks that the same 45,770 pointers reject a string and keep
their handle, and that no reference array holds a pointer.
`validate-object-handles` now checks that after 180 Training ticks, all
20,303 pointer slots of 554 live objects, and the 7,401 of their 154 class
default images, hold None or a live handle, and that each pointer property
reads the identities the byte walk names. Island's JavaScript tick median
is unchanged within noise: 25.2 ms before and 25.1 ms after, over the three
quietest of eight interleaved pairs on a loaded machine.

Names (the FName model's indices) and strings (FString `Data`/`Num`/`Max`)
are the rest of R1.

**R2a — Frames in the arena (implemented).** A function's parameters and
locals live in a frame block at their linked offsets, as the original's
`FFrame.Locals` does (`script-frame-locals.mjs`).

* **Original contract.** ProcessEvent takes `round4(round8(Function+0x3c))`
  bytes from the FMemStack, copies the parameter bytes in and zeroes the rest
  ([events](script-events.md#temporary-frame-and-parameter-abi)).
  CallFunction zeroes a fresh block before it evaluates any argument
  ([execution](script-execution.md)). UFunction's MergeBools (`1010fee0`)
  returns 0, so each bool parameter or local has its own dword
  ([bool link](script-bool-property-link.md)).
* **Layout.** `linkedFunctionLayout` reads PropertiesSize and each
  property's Offset, ElementSize, ArrayDim and mask from the linker's
  records, as `linkedClassLayout` does for classes. The cells are the object
  image's cells, so a local reads and writes exactly as a property of its
  type does. On Training, 6,711 of 6,972 prepared functions are linked, with
  no overlapping properties and every size equal to the aligned end of its
  last property. The other 261 belong to classes the native loader never
  linked, because no object of them exists. Their frames keep the Map storage
  used before R2a.
* **Allocation.** `FrameStack` stands for the FMemStack: blocks are pushed in
  arena chunks, zeroed, and released in a `finally` when the call ends,
  including by an exception. Values without a byte form yet (names, strings,
  object and class pointers, dynamic arrays) sit in the frame's reference
  array, as for objects. `FrameLocals` keeps the Map interface
  (`has`/`get`/`set`), so the parameter copy-in, out copyback and local
  destruction code is unchanged.

Verification: identical digests on Island with render feedback
(`5496f30ee89033fc`) and Training (`04f77dc631509ae4` with the same flags as
R0), and 546 unit tests. On Island every call used an arena frame (87,584 in
boot and 40 ticks, no Map fallback, no field without a cell).

**R2b — Rust VM.** Port the compiled engine case by case from its JavaScript
reference (`script-vm.mjs`). A lockstep mode runs both VMs and compares the
digest every tick. `SCRIPT_VM=js|rust` selects the engine for the validator
sweep until the JavaScript VM is retired.

Bound host fields do not block this step. On Island, one tick's VM makes
about 8,900 field accesses (4,500 values, 3,600 references, 840
assignments), and about 1,070 of them reach a binding: `Level.NetMode` 300,
`Level` 190, `Location` 180, `Velocity` 90, then `bDeleteMe`, the collision
size, `Rotation`, `Acceleration` and `Physics`. Routed through one JavaScript
import, they cost a fraction of a millisecond. Stage 1e removes that path
later.

**R2b-1 — The x87 operator kernel (implemented).** The crate
`native/script-vm` is `no_std`, has no allocator, and imports its memory;
its 1 MiB shadow stack and statics come first (`build.rs`), so it can later
run inside a runtime's arena with the arena allocating above them. Its first
part is Core's float, vector and rotator operator bodies that the
JavaScript VM computed with its BigInt x87 model: 160, 173, 193, 194, 219,
221, 222, 224, 226 (SafeNormal), 248, 276, 287, 288, 296, 297 and 300. The
80-bit model is `Ext` from the mesh kernel, extended with FDIV, FSQRT,
FILD, the FSTL double store, `_ftol` and SafeNormal's 1e-08 compare. Each
export transcribes its `native()` case step for step, and operands cross as
float32 bit patterns so NaN payloads and signed zeros are exact.

* **Loading.** `script-vm-kernel.mjs` loads the module once, from
  `prepareFunction`, before any compiled body runs. The BigInt bodies stay
  in `script-vm.mjs` as `x87Operators`: the reference, and the path in hosts
  that never load the kernel (unit tests that compile a body directly).
* **Verification.** `validate-script-vm-x87` compares the kernel with the
  BigInt bodies on edge and seeded random operands. Its first run found a
  kernel FDIV that dropped the round bit when the integer quotient had
  exactly 64 bits: `DivideEqual_IntFloat(617446728, 8.758457e-8)` truncated
  7049720607872202.9997… where the 64-bit rounding gives …203. After the
  fix, 3,000,000 operand sets are bit-identical (300,000 in the sweep).
  Digests are unchanged, and the 546 unit tests pass.

The BigInt model is about 1.6 ms of a profiled Island tick. Its other users
(physics, windows, lighting) keep the JavaScript model until their families
move.

**R2b-2 — The interpreter (implemented, behind `SCRIPT_VM=rust`).** Counted
on Island, one tick runs about 12,100 statements and 41,300 node evaluations.
The most frequent nodes are simple: literals (5,400), local and instance
variable reads (5,100 and 4,500), BoolVariable (2,650), assignments (2,350 plus
970 bool), `&&` and `||` (1,730 and 890), context `Other.X` (1,380), int and byte
conversions, object `!=`, float compares and int increments.

* **Lowered code.** `script-vm-lower.mjs` lowers each compiled function, per
  runtime and operand epoch, into a word array in the arena: a statement table,
  then each statement's typed expression tree in evaluation order
  (`native/script-vm/src/interp.rs` documents the format). Types come from the
  original tokens and linked properties: a literal's token, a variable's
  property type, an operator's Core signature. Lowered today: constants, scalar
  locals and fields (int, byte, bool, float, object handles) and scalar struct
  members at their linked offsets, `Self`, contexts, assignments of scalars,
  Core's int, float, bool and object operators and the byte, int and float
  conversions, jumps, typed returns and a foreach's IteratorNext and
  IteratorPop.
* **Per-node fallback.** Any other node becomes a JavaScript node of the kind
  its position expects: Rust calls one import, and the compiled closure
  evaluates that node on the same frame. The consumer's conversion is the
  closure's own (`v | 0`, `Boolean(v)`, `+v`, the object's handle); a
  JavaScript `undefined` in a float position is kept apart, because the float
  store codec turns it into 0. Any other statement returns to the JavaScript
  loop for exactly one step (`compiled.step`). Every function body runs, and
  coverage grows kind by kind.
* **Receivers.** A field is read in the image when its receiver has an image
  in this arena, no poisoned value, and no host binding for that key; the
  runtime keeps a table of the keys any binding uses. Bindings whose value
  changes only through their setter (`Actor.Level`, `LevelInfo.NetMode`) keep a
  copy in the image instead (`mirror`), which `SCRIPT_VM_CHECK=1` compares with
  the binding before every Rust run.
* **Shared state.** GRunaway crosses into the module around every run and
  import; each run keeps its own hang budget; the shadow stack pointer is
  restored after a JavaScript exception unwinds through Wasm frames.
* **Verification.** `validate-script-vm-interp` runs every code kind against
  the JavaScript expression it transcribes (130,000 checks, and deliberately
  broken builds fail it). `SCRIPT_VM=rust` bench-sim runs match the JavaScript
  VM's digest at all 30 checkpoints (every 10 ticks) on Training
  (`04f77dc631509ae4`) and Island (`5496f30ee89033fc`), with the mirror check
  on. Island: about 1,670 function bodies run in Rust per tick. In three
  alternating headless A/B rounds on a loaded machine the median tick was 8%
  and 13% lower in two and 9% higher in one; a quiet-machine measurement is
  pending. In a CPU profile the VM, value and runtime field services fall
  from 36 to 22 ms of a 57 ms profiled tick. The
  remaining cost is what the fallbacks do: script calls (about 810 per tick),
  object assignments (440), bound fields and natives.

**R2b-3 — Calls (implemented).** A final call, or a virtual call on `Self`,
whose function has only scalar or object parameters (no out parameters) and
no locals that need destruction runs in Rust.

* **Begin.** `js_call_begin` resolves the call as `runtime.invoke` and
  `callFunction` do, applies their checks, and pushes the callee's frame
  block on the FMemStack. The stack's state words live in the module
  (`FRAMES`), shared with the JavaScript `FrameStack`. A call that must take
  the JavaScript path is refused before any argument is evaluated, and
  JavaScript then runs the whole call.
* **Arguments and body.** Rust stores each argument, evaluated with the
  caller's `Self`, before evaluating the next. It then runs the callee as a
  nested run with its own hang budget. A callee statement left to JavaScript
  runs through `js_step`. The result is converted as `copyValue` converts it.
* **Runs.** `FRAMES` also holds the host's count of active runs, which is
  the next run id. Rust restores it with the stack after each call, so a
  callee whose arguments are still being evaluated keeps its id through
  nested calls. A callee that throws unwinds past Rust. The host's run
  therefore restores the stack, the budget and the shadow stack pointer, and
  frees the code of replaced lowerings only when no run is active.
* **Verification.** `validate-script-vm-interp` covers the call paths:
  argument receivers and order, frame pushes and restores, recursion,
  re-entry, budgets and bad kinds. Deliberately broken builds fail it,
  including one that leaves the run count raised. `SCRIPT_VM=rust` digests
  match the JavaScript VM at all 30 checkpoints on Training and Island.
  Island runs about 745 calls per tick in Rust.

**R2b-4 — Object stores and compound assignment (implemented).** Since
R1a-2 an object assignment is a handle store: a local, a field of `Self`
(except `Actor.Base`, whose store also bumps the base epoch in JavaScript) or
a scalar struct member of either. Object parameters are stored the same way.
Core's `<=`/`>=` on ints (152/153) and `<=` on floats (178, which reads an
undefined operand as 0) join the operators. `+=`, `-=` and `*=` on floats
(184/185/182) and `+=`/`-=` on ints (161/162) run as statements. As in
JavaScript, the value is evaluated before the target is read. When both
operands are NaN, the first one wins, explicitly, because Rust does not fix
the operand order of a float add. A member store writes only the member's
bytes, as the original's GPropAddr store does. JavaScript's member reference
rewrites the whole struct; the two can differ only when another member holds
a signaling NaN.
Verification: `validate-script-vm-interp` (93 kinds, 170,604 checks; 49 of
55 mutants caught; the six survivors are semantically identical). Digests
match at all 30 checkpoints on both maps. On Island the per-tick fallbacks
lost the object assignments (about 550) and nearly all compound assignments.

**R2b-5 — Casts, class defaults, array elements and state code
(implemented).** DynamicCast, DefaultVariable and fixed-array element reads
were the largest value fallbacks left on Island (about 940 per tick). They
now run in Rust, and state code runs its lowered statements there.

* **Handle class table.** A cast needs the object's class chain without an
  import per cast. Each interpreter keeps a u32 table in its arena indexed by
  handle (`CLASSES`), because handles are global, dense and never reused. An
  entry is 0 (not described), RELEASED, or the address of a class row:
  the class default image word, then the record ids along `cls.base`.
  `js_class_row` fills an entry the first time Rust needs it, for an instance
  attached to this runtime (`instances.get(identity).cls`); it runs no
  script. An entry never goes stale: attachment is permanent and a linked
  class's chain is fixed. Record ids are small integers per class record,
  shared with the lowering. The table starts with every handle released so
  far, and `releaseHandle` now notifies each interpreter
  (`onHandleRelease`).
* **Released handles read None.** Object reads from memory (locals, fields,
  elements) turn a RELEASED handle into None, as `identityOfHandle` does for
  the JavaScript read. Before this, Rust passed the stale handle on. No
  digest depended on it, but an `== None` test or a copy of such a pointer
  differed from JavaScript.
* **DynamicCast (0x2e).** The lowering resolves the target as the closure
  does (`objectReference`, before the value). A script class target becomes
  its record id, and a None target casts to the value. A native-only class
  target (`castToNativeClass`) or an invalid one stays in JavaScript. Rust
  evaluates the value once, with SELF. None or undefined is None. A
  described handle is the value when its row lists the target's id, else
  None. Any other handle runs castObject through `js_cast`, which also
  raises its errors: a native object cast through its `objectClass`, a class
  identity, an object of another runtime, or a released SELF handle (the
  closure casts `fr.instance`). MetaCast (0x13, 0.1 per tick) stays in
  JavaScript.
* **DefaultVariable (0x02).** A scalar default (int, byte, bool, float) is
  read in the receiver's class default image. `classImage` builds that image
  from the same `defaultValue` the closure returns, so Rust reads it only
  while it is current. `js_class_row` validates a row's image word: the
  image must pass `sameDefaults`, be in this arena, have no default that
  failed to build, and the class's `propertyLink` must be its chain's
  `propertyOrder`s. The word is reset when a class default is written
  (classDefaultReference's setter), when SaveConfig refreshes config
  defaults, and when `classImage` builds an image. The property must be in
  the class's PropertyLink, so the row must list its declaring class.
  Anything else evaluates the node in JavaScript: a HOST receiver (not
  attached, released, a class), a receiver without a readable image,
  Object's own properties, and object or array defaults.
* **Array elements (0x1a) and members of elements (0x36 over 0x1a).** These
  cover a fixed-array local or field with an imaged cell whose element, or
  the member read, is a scalar cell. The closure evaluates the index before
  the array reference. The lowering admits only an index without imports (a
  literal or a local), so Rust evaluates it first and the JavaScript path can
  evaluate it again without effect. An index outside [0, dim), or a field on
  the JavaScript path, evaluates the node in JavaScript, which logs
  ArrayIndexOutOfBounds and clamps.
* **Float operators.** `*`, `/`, `+` and `-` (171, 172, 174, 175) choose a
  NaN operand's payload with `nan_first`, as the compound assignments do.
  With a signaling NaN double, the arm64 FPU returns the signaling operand
  even when it comes second. No VM value is one: floats are f32 widenings
  and arithmetic results, which are quiet.
* **State code.** A state has no parameters or locals, so its frame is
  lowered with the empty layout. `resumeState` keeps JavaScript's loop: the
  hang budget, the cursor lookup and advance, and the latent, cursor,
  iterator and return checks between statements. Any statement may start a
  latent action, go to a label or change state. A statement with lowered
  work runs through `vm_statement`: an effect, or a condition not wholly
  left to JavaScript. A taken jump returns 1, and the host sets the cursor to
  the target after the condition, as stepCompiled does. Latent natives,
  GotoLabel, Stop, foreach steps, unconditional jumps and wholly JavaScript
  statements stay one compiled step.
* **SCRIPT_VM_CHECK** now also checks the new reads. Each cast, default and
  element read that Rust completes calls `js_check`. That import evaluates
  the node with the closures, or castObject on the evaluated value for a
  cast, and throws on a difference.

Verification: `validate-script-vm-interp` (108 kinds, 173,434 checks) runs
each new kind against the JavaScript it transcribes. Casts are compared with
`castObject` itself on a class hierarchy, covering row caching,
None/undefined/released values, the released-SELF path and castObject's
error. The float operators' NaN pairs compare exact result (f64) and stored
(f32) bits. 42 of 47 mutants are caught. The five survivors are in the float
operators: add or multiply without `nan_first` or written `b op a` (the
compiler emits the same operand order), and `nan_first` without the quiet
bit (every VM NaN is already quiet). Digests match at all 30 checkpoints
under both VMs on Training (`04f77dc631509ae4`) and Island
(`5496f30ee89033fc`) with `SCRIPT_VM_CHECK=1`, so every new read Rust
completed was also compared with the closures. The 546 unit tests,
`validate-script-vm-x87` and `validate-trace-kernel` pass. On Island the
per-tick value fallbacks lost DynamicCast (680), struct members of elements
(157), DefaultVariable (121) and element reads (27). State code is small at
steady state: about 2.5 state statements per Island tick after the warm-up,
0.9 of them now in Rust (Training: 0.2). Across four interleaved headless
pairs, the median `SCRIPT_VM=rust` Island tick was 20.6, 20.8, 20.0 and
20.6 ms before, and 19.8, 20.3, 20.2 and 20.0 ms after.

**R2b-6 — Vectors, rotators, names, IsA and iterator Returns
(implemented).** Operand-shape statistics (`SCRIPT_VM_STATS_DETAIL=1`) came
first. On Island, the 156 callee Returns per tick left to JavaScript were
not unlowerable values. They were Returns in bodies with a foreach, all of
which the lowering refused. IsA (88 per tick) always had a name literal. Most
vector operands were bound Actor fields (Location, Velocity, Rotation), whose
read stays one import until stage 1e images them. The word code is specified
in `interp.rs`'s header.

* **Values.** A vector is three float32 bit patterns, each NaN quiet. The
  JavaScript value is an Array of three float32 numbers (a codec copy or an
  operator result). A load sets the quiet bit of a signaling NaN, as
  `getFloat32`'s widening does. A rotator is three int32 words. A name is
  the id of its folded spelling `String(v || 'None').toLowerCase()`, interned
  once for every runtime (`nameId`, `none` = 1). This is exactly the string
  that 254/255 and IsA compare. No Rust consumer needs the spelling: name
  stores, Returns, conversions and switches stay in JavaScript, because names
  have no byte form yet (R1).
* **Kinds.** Vector and rotator locals and fields, literals, contexts,
  JavaScript nodes (`js_vector`, `js_rotator` fill a scratch cell), stores
  and Returns (`RESULT3`). The Core operators are:
  * 215/216/212/213: the `f(a op b)` doubles of `native()`.
  * 214 and VSize (225): the mover primitives' doubles and V8's correctly
    rounded `Math.sqrt`, through `trace::sqrt` with a NaN passed through.
  * 211: a sign flip.
  * 217/218 and 142/203: compares.
  * 316/317: wrapping adds.
  * The x87 kernel bodies for 219, 226, 276, 287/288, 296 and 300.
  * The out natives 221 to 224, 297, 318 and 319, as statements ordered like
    COMPOUND.

  A member of a vector or rotator value that is not a variable
  (`Other.Location.X`) is read like `structValue`. Name literals and name
  JavaScript nodes (`js_name`) feed 254/255.
* **JavaScript vectors.** A JavaScript node in a vector or rotator position
  is admitted only when its closure value is a codec copy (a variable, a
  default, an element, a struct member, or a context of one). An operator's
  own result is not converted, so for any other node the consumer stays in
  JavaScript. `js_vector` throws on a value that is not three float32
  numbers, as `js_object` does on a non-object.
* **IsA (303).** Class rows gain a second list, the ids of
  `String(cls.record.name).toLowerCase()` along `cls.base`. A HOST receiver,
  or a handle the table does not describe, evaluates the native in
  JavaScript. The literal argument has no effect. The runtime's own
  `invokeNative` must be in the services, and 303 must not be a boundary
  native.
* **Returns with a foreach.** `S_RETURN_ITER` asks the host for the frame's
  iterator count (`js_iterators`, which runs no script) before the value.
  A nonzero count raises stepCompiled's error.
* **Lowering policy.** A new vector, rotator or name node, or a store, is
  lowered only when its operands need at most one import (a JavaScript
  leaf, or a field whose key a binding uses). Two imports cost more than
  leaving the node to JavaScript. For example, `VSize(Location -
  Other.Location)` stays whole.
* **V8 NaN instability.** Probes while validating (`.work/logs/r2b6`) found
  that the JavaScript VM's own vector NaN payloads depend on JIT state:
  * With two NaN operands, `x op y` returns the first under Ignition and
    TurboFan and the second under Maglev.
  * Optimized code may store a NaN into a double-elements Array canonically.
  * Optimized code may fold a float32 widening with a later narrowing,
    keeping a signaling NaN.

  Rust keeps one rule: quiet loads, the first NaN operand, the kernel's
  words. The validator checks that rule with references computed as scalars
  from quiet words. `SCRIPT_VM_CHECK` treats any NaN as equal to any NaN.
  The same instability applies to the scalar float operators of R2b-5.
* **SCRIPT_VM_CHECK** compares every new value Rust completes:
  * Vector and rotator reads from memory (against the closure).
  * Operators, members and out natives: the JavaScript VM's own code
    (`compiled.primitive`, the `native()` body; `structValue`) runs on the
    operands Rust used, so operand subtrees are not evaluated twice.
  * IsA (against the closure).

Verification: `validate-script-vm-interp` covers 150 kinds with 583,674
checks. Each operator is checked against the `native()` expression, and the
mover primitives and `ScriptRuntime.invokeNative` (IsA) are called directly.
The checks cover NaN payload pairs, signed zeros, signaling NaNs in memory,
the JavaScript paths, receivers, evaluation order, the host faults and the
check reports. 65 of 67 mutants are caught. The two survivors are
semantically identical:
* 214 dividing directly instead of multiplying by the double reciprocal. For
  float32 operands the quotient is never within 2^-48 of a float32 midpoint,
  and a search of 1.8×10^8 pairs found no difference.
* The kernel's vector words quieted a second time.

Digests match the JavaScript VM at all 30 checkpoints under both VMs on
Training (`04f77dc631509ae4`) and Island (`5496f30ee89033fc`), with
`SCRIPT_VM_CHECK=1` and no errors. The 300 timed Island ticks made these
comparisons:

| Check | Count |
|---|---|
| Operator, member and out-native | 99,225 |
| Vector read | 26,179 |
| Rotator read | 7,978 |
| IsA (bool check) | 26,506 |

The 546 unit tests, `validate-script-vm-x87` and `validate-trace-kernel`
pass. `validate-loadmap-gc` under `SCRIPT_VM=rust` grows old space by 0.73
to 1.00 MiB over 19 resets (before: 0.80 to 0.82). Per Island tick, the
JavaScript imports fell from 1,744 to 1,455:

| Import | Before | After |
|---|---|---|
| Statements | 234 | 57 |
| Callee Returns | 156 | 0 |
| VSize | 115 | 3 |
| IsA | 88 | 0 |
| Name compares | 96 | 1 |
| Vector/rotator `!=` | 37 | 0 |
| Struct stores | 80 | 12 |

The bound field reads those nodes contained are now separate imports:
Location 110, Velocity 57 and Rotation 22 per tick. So are the name reads:
GetStateName 50 and name fields 39. The machine was loaded, so the change in
time is small and noisy. Across twelve interleaved headless pairs, the median
`SCRIPT_VM=rust` Island tick was:

| Pair | Before (ms) | After (ms) |
|---|---|---|
| 1 | 24.9 | 23.8 |
| 2 | 46.5 | 23.3 |
| 3 | 21.5 | 20.6 |
| 4 | 22.6 | 25.0 |
| 5 | 24.7 | 19.5 |
| 6 | 20.0 | 19.9 |
| 7 | 20.6 | 20.0 |
| 8 | 19.8 | 18.4 |
| 9 | 19.6 | 18.8 |
| 10 | 19.4 | 19.0 |
| 11 | 20.0 | 19.7 |
| 12 | 20.1 | 20.4 |

The tick was lower after in 10 of the 12 pairs. In the four quietest pairs
(9 to 12), the medians fell from about 19.8 to 19.4 ms.

Left in JavaScript, by cause:
* **Engine natives with native oracles:** LastRendered (723), GetPlayerPawn
  (720), InStasis (721), AICanSee (705), the alliance natives (2105) and
  GetStateName (284).
* **Bound Actor fields:** stage 1e.
* **No byte form yet (R1):** names in variables, strings, generic structs
  (Color, PointRegion) and their Returns.
* **Iterator natives:** a foreach statement.
* **Casts and GetAxes:** vector/rotator casts (0x39, 0x50) and GetAxes (229).
* **Unlowered vector forms:** vector call parameters and results, vector
  array elements and defaults.
* **The one-import policy:** operators that would need two imports.

**R3 — Hot families.** Move native and physics families into Rust as
profiles rank them. Candidates are traces and the collision hash, walking and
falling, AICanSee and alliance, and GetFrame/mesh lighting (already Rust).
Each family keeps its native oracle validators, which run against the Rust
implementation through the same JavaScript API.

A September 29 CPU profile of Island ticks (`--cpu-prof`, 150 ticks after
boot, profiler overhead included) splits the tick by module: the runtime's
services 36%, the VM 18%, value copies and codecs 11%, physics and
collision about 14%, the BigInt x87 model 3%. The largest single cluster,
about 16 ms of a 57 ms profiled tick, is host code reading script
properties by name (`readNamed` → `namedHandle` → `readInstanceField` →
`instance`). Its callers are the per-actor native tick
(`actorTickServices`), pawn physics, the per-tick CleanupDestroyed scan and
AIGetLightLevel's scan of every actor's `LightType`. These are the R3
families: in Rust they read the linked offsets directly.

**R3-a — BSP traces (implemented).** UModel's half of LineCheck runs in Rust
(`native/script-vm/src/trace.rs`): the zero-extent ray traversal (`traceRay`,
with ExtraNodeFlags and owned-brush ToWorld coordinates) and the box trace
(`traceExtent`: hull clipping, supplemental bounds, pair bevels). Each
transcribes its JavaScript body (`traceRayFast`, `traceExtentJs`): the same
double intermediates in the same order, `as f32` at every `Math.fround`, the
same traversal order and visit guard. The JavaScript stays the reference, the
path before loading, and the answer to every case the kernel hands back.

* **Boundary.** Ported: the two model queries, storedSupport's exact 64-bit
  midpoint sum (`u128` in place of BigInt) and `Math.sqrt`/`min`/`max`. The
  Wasm instructions for these are unstable in Rust, so `sqrt` is a Newton
  estimate that an exact integer residual corrects. Left in JavaScript:
  SingleLineCheck's filter, MultiLineCheck's join and qsort, the collision hash
  and the cylinder primitives (they read live actor state), and the point and
  FastLineCheck queries.
* **Model memory.** `trace-kernel.mjs` uploads each model object once into
  the kernel's own ObjectArena: a 32-byte header, 64 bytes per node (the plane
  as the four JavaScript doubles, front, back, ToInt32 flags, collisionBound,
  vertexCount > 0), then the leaf-hull words. Island's BSP (13,212 nodes) is
  1.05 MB, uploaded in 2.7 ms. A FinalizationRegistry frees the range with
  the model. The scratch stacks (2,048 ray and 4,096 extent entries), the
  64-plane hull and the result block are statics.
* **Hand-backs.** A case the JavaScript throws on (an invalid link or hull
  offset, a cyclic tree, a hull over 64 planes, non-finite inputs) or a
  deeper traversal returns to the JavaScript. A model with non-number planes
  is not uploaded.
* **Loading.** `prepareFunction` awaits `loadTraceKernel()` after the VM
  kernel. The instance is the script-vm module with a throwing stub for each
  function it imports. `TRACE_KERNEL=js` keeps the JavaScript path;
  `TRACE_DIFFERENTIAL=1` runs both and throws on any difference, key order
  included.

Verification: `validate-trace-kernel` compares the two on 1,530,665 seeded
cases (1,065,877 rays, 464,788 extents) on the Training and Island BSPs and
every mover brush of both maps, owned at key positions, rotated, scaled,
sheared and through raw coordinates. The cases include plane-grazing,
epsilon, zero-length, in-solid, huge, infinite and NaN inputs. All are
identical, as are 24 million `sqrt` and 4 million storedSupport results (2
million at constructed float32 midpoints). The native oracles pass with the
kernel answering under `TRACE_DIFFERENTIAL=1`: rays (1,070 cases), brush rays
(1,720), extents (3,420), collision (456), level (21,863 kernel rays), world
fitting (6,878), the mover and far-move scenes, player sequence, tick order
and both mesh-lighting validators. Digests are unchanged with no hand-back:
Island `5496f30ee89033fc` (820,892 rays and 28,994 extents compared) and
Training `04f77dc631509ae4` (245,594 and 4,532). The 546 unit tests pass, and
a Chromium Island run shows the kernel in its profile with no runtime error.

Cost: the Island tick median fell from 25.9 to 25.1 ms (three headless A/B
pairs). Under `walking`, the traces fell from 0.83 to 0.24 ms of a profiled
tick, and walking from 9.2 to 8.5 ms. Most of the rest is the JavaScript
around the traces: SingleLineCheck and MultiLineCheck (about 1 ms), the
collision hash, the primitives and property reads. They move once actor state
is in the arena.

**R3-b — Collision hash, line checks and the walking-surface scan
(implemented, stages B0 to B2).** ULevel's actor queries run in Rust
(`native/script-vm/src/hash.rs`, JavaScript side `collision-kernel.mjs`).
Each Rust piece transcribes its JavaScript body the way R3-a does: the same
double intermediates in the same order, `as f32` at every `Math.fround`, and
the same comparisons (NaN, signed zeros). `x ** 2` becomes `x * x`, which
fdlibm's `pow` special case for y == 2 makes exact, and the validator checks
it on 3 million doubles. The JavaScript stays the reference: it runs before
the kernel loads, under `HASH_KERNEL=js`, and for every query the kernel hands
back.

* **What runs in Rust.**
  * The hash buckets: per-cell LIFO link lists, and a removal that unlinks
    every link of the actor and keeps the other links in order.
  * The line-query cells: X's 64-bit x87 expansion is exact through a signed
    `u128` dyadic sum with a jammed sticky bit, in place of BigInt.
  * A visit stamp per registration, in X, then Y, then Z cell order.
  * Level-queries' primitive callback: the cylinder (`primitiveLineHit`), or
    a brush traced through `trace.rs` with its ToWorld.
  * MultiLineCheck: the world trace and clip, the collected hits reversed,
    the 64-hit cap, the movers-only rule, the mover backoff, and the CRT
    qsort with its comparator, its NaN branch and its 44-byte partition test.
  * SingleLineCheck's walk of the sorted hits.
  * The walking-surface prelude's 36 scan queries and its floor query, as one
    call (`lc_scan`).
* **Live reads, never snapshots.** Actor state is read through three imports,
  at the points where the JavaScript reads it:
  * `lc_candidate`: `valuesOf(actor)`, then the brush model and ToWorld or
    the cylinder's Location, CollisionRadius and CollisionHeight.
  * `lc_mover`: `isMover`, for each joined actor hit.
  * `lc_accept`: the whole SingleLineCheck filter body for one examined hit
    (owner chain, class flags, and the live `collisionBits` that script can
    write).
  Inside one `lc_scan` call, every import only reads. So each registration's
  cylinder, isMover and filter answers are cached for the rest of the call
  (brushes are read at every visit, because their ToWorld lives in the trace
  static). The floor query is skipped exactly when the ladder branch will
  not ask for it. The plan's snapshot-at-registration design was not used:
  nothing guarantees that a registered actor's Location or radius is always
  re-registered before it changes, and the JavaScript reads them live.
* **Placement (B0).** The hash and its queries live in the trace kernel's
  instance (`trace-kernel.mjs`), not in a runtime's instance:
  * the BSP models are already uploaded there;
  * `SCRIPT_VM=js` needs no Rust runtime instance;
  * the queries read no script image, since everything live comes through
    the imports until stage 1e moves Location and the collision word into
    images.

  The code is address-based (a header pointer and model pointers). A later
  stage can therefore instantiate the same code on a runtime's arena and
  upload the BSP there.
* **Memory.** Per level queries object:
  * an 80-byte header: table, links, stamps, the scratch, the scan cache,
    and the `querying` and `busy` words;
  * the cell table (open addressing on the packed tag, at most half full);
  * links (registration id and next link, with a free list);
  * per registration id, a stamp, an 80-byte actor-hit scratch slot and an
    80-byte scan cache entry;
  * per texture list, a scan table with one byte per BSP node: whether the
    node's texture stops the scan, and whether it takes the ladder branch.

  JavaScript allocates and grows these ranges between calls, and a
  FinalizationRegistry releases them with the store. Island uses about
  0.3 MB. Registration ids are JavaScript's, and are reused only once no
  query still names them.
* **Re-entrancy.**
  * Rust sets the header's `querying` word (volatile, reached through a raw
    pointer) while candidates are visited. JavaScript's `createCollisionHash`
    shares the same word, so a hash change or a nested query from a getter
    throws the reference's error.
  * `busy` and a module flag send any line check nested inside a Rust call
    to the JavaScript path.
  * When an import throws through the Rust frames, the host puts back the
    shadow stack base and both words.
  * A scratch or scan cache range that is replaced while a call still reads
    it is released after the call returns.
* **Results.** `lineCheck` builds the reference's result object: the same
  keys in the same order, including `next`, `primitive` and `item` (which are
  undefined for cylinders), and the `next` chain of hit objects in their own
  five shapes: world ray, world extent, cylinder, brush ray and brush extent.
* **Hand-backs.** Rust hands a query back, and the JavaScript then runs the
  whole query (errors included), in these cases:
  * non-number inputs;
  * non-finite values;
  * cells outside 0..255, or more than 1,000,000 cells;
  * a model the trace kernel refuses, or a trace it hands back;
  * a negative extent reaching a trace;
  * a query nested inside another.

  Every query only reads, so running it again is not observable.
* **Switches.** `HASH_KERNEL=js` turns the whole kernel off. `SCAN_KERNEL=js`
  turns off only the scan.

  `HASH_DIFFERENTIAL=1` keeps a JavaScript hash beside the Rust one. Every
  add and remove runs on both, with the same result or error, and every
  query's visit order is compared. Every Rust line check and scan is also
  compared with the JavaScript path: keys, numbers by `Object.is`, and
  identities.

  `TRACE_DIFFERENTIAL=1` makes the same line-check and scan comparisons,
  with the JavaScript path's traces checked against the trace bodies.
* **Hooks outside these modules.**
  * `game.mjs` awaits `loadTraceKernel()` before registering the level's
    actors.
  * `script-pawn-physics.mjs` defines the pawn view's `surfaceScan`. It is
    non-enumerable, like `decorate`. An enumerable property changed Island's
    digest from tick 280 without changing the simulation:
    `OfficeChair0.Touching` held UNATCOTroop6's physics *view*, and the
    digest walks a view by its keys. That view-versus-host leak (the plan's
    risk 1) is fixed: see
    [the pawn view's identity](script-map-actor-move.md#pawn-view-identity).
    With it, an enumerable `surfaceScan` leaves Island's digest unchanged
    (`6a178ec7baf98078`), so the digest no longer depends on the view's
    shape. `surfaceScan` stays non-enumerable, like any helper.
  * `instantiateScriptVm` stubs the new imports in interpreter instances.
* **Quick wins (B0).** AvgPhysicsTime (`script-pawn-physics.mjs`) and
  physFalling's refund (`falling.mjs`) use the x87 kernel's `Ext` model
  (`phys_avg_time`, `phys_refund_time`) in place of BigInt. Each is one
  hook, and they are proven equal on 800,000 operand sets. They save about
  0.04 ms per tick. The BigInt x87 left on Island (about 0.6 ms) is AI
  visibility and locomotion.
* **Left in JavaScript, and why.**
  * The registration checks, the bounds and `registrations` (`addActor` and
    `removeActor` are rarer than queries, and their errors stay one piece of
    code).
  * The point and encroachment queries' primitives: their visit order comes
    from `hash_candidates`.
  * The explicit-table hash (fixtures only).
  * The seed-independent hash before the kernel loads.
  * `pointRegion`, which the plan put in B0, is not ported: it is zone.mjs
    work and is worth about 0.15 ms.

Verification:

* `scripts/validate-collision-kernel.mjs` compares each piece with its
  JavaScript body on seeded and edge inputs:
  * 600,000 line-query cell sets (float32 midpoints plus tiny extents, which
    take the 64-bit path, and huge, zero and negative extents);
  * 433,333 cylinder primitives, including boundary starts, thin cylinders
    and NaN and infinite geometry;
  * 40,000 qsorts (ties, NaN, signed zeros);
  * 80,000 joins (160,000 mover backoffs, the 64-hit cap, movers-only, and
    subnormal X);
  * 60,000 hash operations against the JavaScript buckets, with refused
    inputs, re-entrant mutation and nested queries.
* On Training and Island, with the actors registered as `game.mjs` does
  (including twin cylinders for ties), it runs 56,240 `lineCheck` and
  `multiLineCheck` queries through a kernel and a JavaScript
  `createLevelQueries`. The queries cover every flag family, sources with
  owner chains, rays into mover brushes with extra flags 0x10 and 0x20,
  zero, pawn, negative and non-finite extents, and huge and NaN
  coordinates. Between batches:
  * actors move, and are destroyed (0x80) and re-added;
  * collision bits change without re-registration;
  * live cylinders turn NaN, and radii change.
* It also runs 10,424 walking-surface preludes with and without the kernel
  scan: 1,200 take the ladder branch, some use case-variant and null texture
  outer names, some sit beside owned movers, and some have a Location read
  that throws.
* All of these are identical, errors included.
* A mutation pass broke the new Rust 55 ways; every mutant fails the
  validator except one equivalent mutant: the partition test's byte
  arithmetic only chooses which of two disjoint ranges is sorted first.
* The native oracles pass through the kernel:
  * level (3,556 line checks and 465 point checks on both maps), collision,
    world fitting, the mover and far-move scenes and the player sequence;
  * level points, points, encroachment and extents;
  * multiline, line-filter, hash, primitive, move-query, walking,
    walking-surface, ladder and the other movement validators.
* Digests are unchanged at all 30 checkpoints under both VMs: Island
  `5496f30ee89033fc`, Training `04f77dc631509ae4`.
* Under `HASH_DIFFERENTIAL=1` on Island, 757,112 line checks and 19,159 scans
  were compared, with 757,122 visit orders and no hand-back. Under
  `TRACE_DIFFERENTIAL=1`, 820,898 rays and 28,994 extents were compared
  through them.
* The 546 unit tests pass.

Cost: the Island tick median fell from 19.4 to 18.2 ms (four headless A/B
pairs, `SCRIPT_VM=rust`: 19.02/19.16/19.59/19.74 against
17.99/18.37/18.78/17.52). The table gives ms per profiled tick:

| Profiled on Island (ms per tick) | Before | After |
|---|---|---|
| `walkingSurfacePrelude` | 2.45 | 1.08 (0.72 in `lc_scan`) |
| `pawn.walking` | 5.65 | 4.14 |
| `multiLineCheck` | 1.91 | 0.09 |
| JavaScript self time in collision-hash, level-queries, multiline, line-filter, primitive-collision and collision-kernel | 2.22 | 0.32 |

What remains in the scan is Rust arithmetic: the world ray, the cell
conversions (about 60 ns a query) and the software `sqrt` (about 25 ns),
plus about 2.4 candidate reads per scan.

**1e-1 — Actor flag words in the image (implemented).** This is step 1 of
stage 1e ([object memory](object-memory.md#stages)). AActor packs its script
bools into three dwords that native code reads as members (`sdk-layouts.mjs`
AActor):

| Word | Bits the host used | Host members |
|---|---|---|
| `+0x028` | bStatic 0x1, bDeleteMe 0x80, bCollideWhenPlacing 0x20000, bMovable 0x80000 | `actorFlags`, `static`, `movable` |
| `+0x1dc` | bCollideActors, bCollideWorld, bBlockActors, bBlockPlayers, bProjTarget (bits 0-4) | `flags`, `collisionBits`, `collideActors`, `collideWorld`, `blockActors`, `blockPlayers`, `blocking` |
| `+0x1ec` | bSpecialLit … bJustTeleported (bits 0-8; bJustTeleported 0x100) | `motionFlags` |

Before this step a map actor kept these as host copies, and script-doors bound
the script fields onto them (bDeleteMe mirrored its bit into `actorFlags`).
The words are now the image's bytes.

* **Map actors.** `installActorFlagWords` (`actor-flag-words.mjs`) runs when
  script-doors attaches a level export. Every export with a host word gets
  accessors over its image dwords: collidable and non-colliding actors,
  movers, map pawns' hosts, decorations and pickups.
  * `flags` and `motionFlags` are the whole words (masks 0x1f and 0x1ff).
  * `actorFlags` keeps the four bits the level-load word carried (mask
    0xa0081). The spawned-actor view composes the same four. So bHidden
    (0x2) still reads as clear where VisibleActors tests `actorFlags & 2`.
  * The per-bit members are getters.
  * Only a non-pawn, non-brush map actor (`isMapMoveHost`) gets the motion
    word, as only it had the bJustTeleported binding.
  * The accessors are non-configurable. A leftover `delete` or an assignment
    to a derived member throws instead of splitting the storage again.
* **Layout evidence.** The installer checks each class once. The linker must
  have placed all 18 bools of the three words at the SDK offset and mask. At
  install, the host's values must equal the image (level load writes both
  from the same serialized properties). A difference throws; it is not
  reconciled. For a motion word, the image must also start at the
  serialized bJustTeleported.
* **Bindings removed.** bDeleteMe, the five collision bools and bJustTeleported
  (map move hosts and the controlled player) no longer have bindings.
  `boundKeys` no longer holds them, so the Rust interpreter reads and writes
  them as bool cells.
  * `writeCollisionFlags` writes only `flags` on an imaged host.
  * Player start's `prepareActor` restores bJustTeleported in the image
    instead of deleting the host copy. It no longer assigns `static` and
    `movable`, which read the image.
  * OldLocation keeps its binding (step 3).
* **The Player.** `Player.motionFlags` is the +0x1ec word of the linked
  identity (`linkMotionFlags`). The placeholder and each Login identity link
  when they attach. `detachPlayerIdentity` unlinks before the old identity's
  image is purged, keeping the value as host state until the next identity
  links. Linking checks that both agree on bJustTeleported. The physics pawn's
  `justTeleported` and the collision identity's `motionFlags` already went
  through `Player.motionFlags`.
* **Pawn physics views.** A map pawn's view reads `flags`, `collisionBits`,
  `actorFlags`, `deleted` and `collideWorld` from the host's image words.
  Before, it made one `readNamed` per bool.

Not moved, and why:

* **A map pawn's motion word.** Its image word starts at 0x140. That is
  bRotateToDesired (Pawn default) plus bJustTeleported (Actor's
  `bJustTeleported=True` default). The pawn view's host word starts at 0.
  It then holds only what physicsRotation (0x40 set, 0x20 clear),
  FarMoveActor and the physics bodies write. The pawn physics reads
  bJustTeleported from this host word. The original reads the actor's own
  +0x1ec, so this is a fidelity divergence, and moving the word would change
  the simulation. It is recorded here and needs its own evidence and digest
  change.
* **The player's collision and actor words** stay the movement port's host
  state (step 6). Player start assigns the retired identity a composed
  `actorFlags` without bDeleteMe and re-registers it in the hash before
  LoadMap's collection. With the image as the word, that registration would
  follow the destroyed identity's bDeleteMe. In both maps' shadow runs the
  player's words equalled its image at every tick.
* **The collision kernel** still reads a candidate's `collisionBits` through
  `lc_accept` and `lc_candidate`. The hash kernel lives in the trace
  kernel's own instance and memory, not a runtime arena (R3-b B0), so it
  cannot address the image. Rust reads it there only once the kernel runs on
  the runtime's arena.
* VisibleActors (`script-iterators.mjs`) tests bHidden through `actorFlags &
  2`, a bit no host word ever carried. This is unchanged and noted for its own
  fidelity check.

Shadow mode came first (`FLAG_WORDS_SHADOW=1`; the scaffolding was removed
after the proof, and its version is `.work/logs/1e1/shadow-version.diff`):

* The host value stayed the source, and the old bindings stayed.
* Every host write was also written into the image, masked to the bits the
  host modeled (0x100 for a motion word).
* Every host read, and every installed host after each tick and each reset,
  compared the two. The derived members were compared with `flags` and
  `actorFlags`.

| Map | Hosts | Host reads compared | Writes through | Per-tick host checks |
|---|---|---|---|---|
| Training | 311 | 96,826 | 11,810 | 111,960 |
| Island | 2,237 | 907,254 | 39,515 | 805,320 |

The collision and actor words, the map move hosts' and the player's
bJustTeleported, and the derived members had no mismatch. No write had a bit
outside its word, and no host read a released image. Digests were unchanged
under both VMs at all 30 checkpoints. An early short run reported one
mismatch, inside the shadow bDeleteMe binding itself: it wrote the image and
then read the host word. Reading the host word first removed it. The pawn
motion words differed on every pawn, as described above.

Verification:

* Digests are unchanged at all 30 checkpoints under both VMs with
  `SCRIPT_VM_CHECK=1`, with no errors: Training `04f77dc631509ae4`, Island
  `7b23d044fafab37f`.
* Validators: `validate-script-vm-interp`, `validate-collision-kernel`,
  `validate-object-image` and `validate-object-handles`.
* Native oracles: hash, collision, set-collision-size, check-encroachment,
  encroachment, relocation, far-move-scene, line-filter, mover-scene,
  mover-move and player-sequence.
* Play validators: `validate-world-destroy`, `validate-script-lifecycle`,
  `validate-island-falling-water`, `validate-island-swimming`,
  `validate-loadmap-gc` (22 Player starts), `validate-mover-frob`,
  `validate-decoration-settle-roll` and `validate-script-spawn`.
* The 553 unit tests pass.
* A 240-frame Chromium Island walk had no page or runtime error.

Cost, from bench-sim's new `--bound-reads` (host binding calls per timed
tick):

| Run | Before | After | Flag keys |
|---|---|---|---|
| Island, JavaScript VM | 9,504 | 7,276 | 2,229 → 0 |
| Island, Rust VM | 9,020 | 6,792 | 2,229 → 0 |
| Training, Rust VM | 2,117 | 1,789 | 328 → 0 |

The Rust interpreter's `[bound engine.actor.bdeleteme]` fallback (55.7 per
Island tick) is gone; no other stats row changed. Per Island tick, `readNamed`
fell from 31,660 to 30,369 and `instance` from 61,316 to 58,550. The median
`SCRIPT_VM=rust` Island tick over four interleaved pairs:

| Pair | Before (ms) | After (ms) |
|---|---|---|
| 1 | 19.41 | 18.99 |
| 2 | 20.00 | 19.25 |
| 3 | 19.80 | 19.29 |
| 4 | 19.28 | 19.63 |

The tick was lower in three of the four pairs, by about 0.3 ms on average,
which is within noise.

  that subtree with the existing compiled closures on the same frame object.
  Every function can then run in Rust from the start, and coverage grows kind
  by kind without an eligibility cliff.
* **Frames.** JavaScript still creates each frame (`FrameLocals`: the arena
  block and its reference array). Rust reads and writes scalar locals in the
  block and follows object handles; name, string and object writes go
  through an import until R1b and R1c.
* **Objects.** An arena table maps a handle to its object's image base and
  flags (bindings, poisoned values, pending kill). A field of an object with
  bindings, or with a poisoned value, takes the JavaScript path.
* **Calls and natives.** Rust calls one import for a script call or a
  non-primitive native. `evaluateArgument(i)` calls back into Rust to
  evaluate argument `i`'s lowered subtree. A reference comes back as a
  descriptor (frame block or object image, offset, cell), and JavaScript
  wraps it in the same storage classes (`LocalCellStorage`, `CellStorage`).
* **Verification.** `SCRIPT_VM=rust` runs every function body in Rust. The
  bench-sim digests (`--digest-every`) on Training and Island must equal the
  JavaScript VM's at every checkpoint, and the full sweep runs in that mode.

New subsystems still missing (the remaining natives, rendering) are
researched as before and implemented against this core. Swimming
([swimming](swimming.md)) landed in JavaScript on the x87 model, like flying;
its Rust port is a later performance step. A new native
written in JavaScript during the transition uses shared-memory field access,
so it stays valid until its family moves.

## Risks

* **Scale.** 428 runtime modules (about 85,000 lines) sit on today's object
  API. R0 and R1 keep that API and change what is under it. R2 and R3 move
  code only where it is measured hot.
* **Re-entrancy.** A JavaScript native evaluating an argument calls back into
  the VM, which may call another native. Wasm frames must stay valid across
  those calls.
* **Memory growth** detaches every view. Each access derives its view from
  the current buffer, or accesses go through one indirection that is
  refreshed after growth.
* **Tooling.** Cargo is already in the build for the mesh kernel. Debugging
  across the boundary is harder, and lockstep differential runs are the
  mitigation.
