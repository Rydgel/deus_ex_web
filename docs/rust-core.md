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

New subsystems still missing (swimming, the remaining natives, rendering)
are researched as before and implemented against this core. A new native
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
