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

**R2b-2 — The interpreter (design).** Counted on Island, one tick runs about
12,100 statements and 41,300 node evaluations. The most frequent nodes are
simple: literals (5,400), local and instance variable reads (5,100 and
4,500), BoolVariable (2,650), assignments (2,350 plus 970 bool), `&&` and
`||` (1,730 and 890), context `Other.X` (1,380), int and byte conversions,
object `!=`, float compares and int increments. Script calls are about 860
(`0x1b` virtual 490, `0x1c` final 370). The design:

* **Lowered code.** Each prepared function's decoded tree is lowered into a
  word array in the runtime's arena: the node kind, then resolved operands
  (a local's cell and frame offset, a field's cell and offset, a literal's
  bits), then the children in evaluation order. Resolution stays in
  JavaScript (`objects.operand`); a new operand epoch relowers.
* **Per-node fallback.** A node kind Rust does not implement yet is lowered
  to a fallback naming the node: Rust calls one JavaScript import, which runs
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
