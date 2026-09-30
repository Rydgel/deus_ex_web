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

## Status and next steps (2026-09-30)

This section is the entry point for continuing the port. The step sections
below hold the evidence for each stage.

### Where it stands

* **The Rust interpreter is the default engine.** `SCRIPT_VM=js`, or
  `?scriptVm=js` in the browser, selects the JavaScript VM, which stays the
  reference (see "Default engine" under R2b).
* **Implemented stages:**
  * R0 (arena), R1a and R1a-2 (handles), R2a (frames).
  * R2b-1 to R2b-7 (the interpreter and its receiver table).
  * R3-a (BSP traces), R3-b B0–B2 (collision hash, line checks and the
    walking-surface scan).
  * R3-c (IsValidEnemy, GetPawnAllianceType, AICanSee).
  * R3-d (the actor tick body and the animation phase).
  * 1e-1 to 1e-3: actor flags, the physics mirror fields, Location,
    Rotation, collision size and OldLocation now live in the image.
* **Headless timing.** On UNATCO Island (bench-sim, 300 ticks), the median
  tick is about 14.4 ms under Rust and about 25 ms under JavaScript.
  `BYPASS_PATCHES` is empty. Island Play now runs about 31 s (tick 1872 of
  the forward-walk workload) before its first unimplemented original code,
  ConSys native 2051 `CreateConCamera` (Stage 4). The 360-tick bench window
  does not reach it.
* **Browser timing.** Headless Chromium, Island forward walk, through
  `profile-play-browser`:

  | Engine | Tick | Frame | Rate |
  | --- | --- | --- | --- |
  | Rust | 15–18 ms | 34–39 ms | about 30 fps |
  | JavaScript | 26–33 ms | 46–57 ms | about 20 fps |

  The rest of the frame does not depend on the engine: actor meshes about
  9.8 ms, render about 4.7, HUD about 3.7, lighting about 1.6.
  120 fps means 8.3 ms per frame.
* **Remaining tick cost.** From the latest Island profiles, approximate:
  * About 4 ms of host code still reads script properties by name
    (`readNamed` and its callees). About 1 ms of that is bench-sim's own
    render-feedback reads, which are not game work.
  * Pawn walking physics is about 4 ms, with the walking-surface scan at
    1.1 ms.
  * Natives that still run in JavaScript: SetLocation about 0.3 ms,
    AttachDecal about 0.18, ScriptSpawn about 0.18.
  * The level loop, DistanceFromPlayer and actor compaction are about 0.5 ms
    together.

### Next steps, in recommended order

1. **R3-b B3–B7: walking and falling in Rust.** Pawn physics is the largest
   remaining simulation cost. The plan:
   * **B3.** Pure kernels: groundVelocity, stepUp via a `PawnOps` trait,
     moveQuery, isOverlapping, processPlayerHitWall and the setBase logic,
     plus a hosted build so the walking, steps, velocity, move-query,
     walking-callbacks and set-base oracles run against Rust.
   * **B4.** MoveActor for pawn views: playerMove, touches, bump, zone, and
     remove/add with primitive bounds. Riders and the per-candidate decorate
     step stay imports. Its gain needs 1e-4.
   * **B5.** The walking loop for NPC map pawns. Falling and flying return
     as tail calls.
   * **B6.** Falling, landing, rotation and the pawn tail.
   * **B7.** The player. It needs 1e-6.

   Keep these rules:
   * No Rust borrow and no bucket iteration across an import. Callbacks can
     SetCollision, Destroy, Spawn or SetLocation mid-move.
   * Copy trace results out at once, because nested script traces reuse the
     static buffers.
   * Re-derive JavaScript views after any import, since a Spawn can grow the
     arena.
   * Keep every order dependency:
     * hash prepend, x→y→z cell order and the final reverse;
     * the unstable qsort and its NaN comparator, and the 64-hit cap;
     * BeginTouch's last-empty-slot choice and eviction order;
     * `level.actors` order and the zone event order.
   * Match V8 numerics exactly: `Math.hypot`, `Math.min`/`Math.max` with NaN
     and −0, and reductions starting from +0.

   **Design question for B4–B5.** The collision hash and the traces live in
   the trace kernel's own Wasm instance (R3-b), while the interpreter and the
   images live in the runtime's arena (R3-c). Either merge the two
   instances, or keep one import per query, as R3-c measured for AICanSee.
   Measure before choosing.
2. **1e-4 to 1e-7.** Move the rest of the host fields into the image:
   * **1e-4, Base and Touching.** `actor-touch` writes the slots explicitly.
     Spawned actors get the same Touching storage. Verify with
     `RIDER_VERIFY=1`, and commit this step alone, since the digest may
     change.
   * **1e-5, movers.** The interpolation object becomes a view of the image,
     with all 8 KeyPos and KeyRot. The binding keeps only 2 of the 8 today.
   * **1e-6, the player.** Player becomes a controller over the image; this
     removes the Login rebinding. It also covers the view fields, Regions
     and the controlled player's Physics, the last bound step-2 key.
   * **1e-7, cleanup.** Plain image cells for Level and NetMode.
3. **A per-object bound-field rule in the interpreter.** R3-d's tick kernel
   masks bound fields per object. The interpreter still hands a bound key to
   JavaScript on every object that has any binding, so NPC reads such as
   BaseEyeHeight still go to JavaScript.
4. **Natives called from scripts that still run in JavaScript:**
   SetLocation/FarMoveActor, AttachDecal and ScriptSpawn. Profile first.
5. **The level loop, DistanceFromPlayer and compaction.** They need a
   Level.Actors list cached on the base epoch. The net gain is about 0.3 ms.
6. **The render side (no plan yet).** Actor meshes, render, HUD and lighting
   are about 20 ms of the browser frame, so 120 fps is out of reach until
   they are profiled and planned. The mesh posing kernel is already in Rust
   ([lodmesh Wasm](lodmesh-wasm.md)).

### How each step is verified

* **Build and kernel validators.** Run `node scripts/build-wasm.mjs`, then
  `validate-script-vm-interp`, `-x87`, `validate-trace-kernel`,
  `validate-collision-kernel`, `validate-perception-kernel` and
  `validate-actor-tick-kernel`. Add a kernel validator and a mutation pass
  for each new Rust body.
* **Digests.** Run bench-sim on both maps under both engines, with
  `SCRIPT_VM_CHECK=1` for Rust, all 30 checkpoints and errors `{}`:
  `--bypass --continue --render-feedback --warm 60 --ticks 300
  --digest-every 10 --json`.
  * The references at this commit are Training `c8eebff5786adf55` and
    Island `b767a7e417fe5968`.
  * A representation step must not change them.
  * A fidelity fix may change them, but only with the first differing
    checkpoint explained, and as its own commit.
* **Differential modes.** Each Rust family has a mode that compares every
  call against the JavaScript path: `HASH_DIFFERENTIAL`,
  `TRACE_DIFFERENTIAL`, `RAY_DIFFERENTIAL`, `PERCEPTION_DIFFERENTIAL`,
  `ACTOR_TICK_DIFFERENTIAL` and `RECEIVER_VERIFY` (each `=1`). The JavaScript paths stay behind
  `TRACE_KERNEL=js`, `HASH_KERNEL=js`, `SCAN_KERNEL=js`,
  `ACTOR_TICK_KERNEL=js` and `SCRIPT_VM=js`.
* **Full sweep.** Run `npm run validate -- --jobs 4` before merging.
  Validators that trace call order through runtime hooks run on the
  JavaScript VM, because Rust calls bypass those hooks
  (`validate-inventory-spawn`, `-weapon-construction`,
  `-window-baseline-play`).
* **Browser check.** Walk Island through `profile-play-browser`: headless
  digests have missed browser-only breakage before. Compare browser timings
  within one session and one measurement method; separate runs can differ by
  a few milliseconds.
* **Working copy.** Work in a separate worktree. Give it a local `.cache`,
  where validators write oracle output, and a local copy of the git-ignored
  `reports/` reference data. Oracle validators need `NATIVE_PROBE_PYTHON` (the
  sweep sets it).

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

**Default engine (2026-09-30).** The Rust interpreter is the default: with
`SCRIPT_VM` unset, Play, bench-sim and the validators run lowered bodies in
Rust, as does the browser without a query parameter. `SCRIPT_VM=js` (in the
browser, `?scriptVm=js`) keeps the JavaScript VM. Any other value throws. The
JavaScript VM stays the reference: it evaluates every node Rust does not
lower, `SCRIPT_VM_CHECK=1` compares Rust against it, and the digest gates run
both engines. Hosts without a class loader (unit tests that compile a body
directly) use the closures, as before.

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

**R2b-2 — The interpreter (implemented; the default engine since
2026-09-30, `SCRIPT_VM=js` for the JavaScript VM).** Counted
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

**R2b-7 — Receiver table (implemented).** A context expression (`a.b`)
and SELF after any import asked JavaScript for the receiver's info
(`js_receiver`: the image base, BOUND or HOST). On Island that was about
3,200 of the 9,000 Wasm→JavaScript calls per tick. Its inputs change only at
a few host events, so the answer is now cached in Wasm memory.

* **Table.** `RECEIVERS` in `interp.rs` holds [table, capacity, epoch,
  verify]. The table has two u32 per handle: the info `js_receiver` returned
  and the receiver epoch it returned it under. Rust uses an entry whose
  epoch is current and asks `js_receiver` otherwise; `js_receiver` enters
  its answer.
* **Epoch.** `receiver-epoch.mjs` counts events that can change a live
  handle's info: an instance attaches (`linkInstance`), a host binding is
  added (`bindProperty`, the window host's `bindNativeFields`), a field is
  poisoned or its last poison cleared, storage is restored (`copyStorage`),
  or an object is freed (the three `freeObject` services). A handle's release
  clears its own entry. An image base never moves after construction.
* **Verification.** `RECEIVER_VERIFY=1` makes Rust ask `js_receiver` on
  every lookup; each answer is compared with a current entry and a mismatch
  throws. Training and Island matched the reference digests at all 30
  checkpoints under `RECEIVER_VERIFY=1 SCRIPT_VM_CHECK=1`, with no mismatch.
* **Result.** Island imports fell from about 9,000 to 5,550 per tick, but the
  tick time did not change measurably (A/B medians 13.5 to 14 ms on both
  sides). A crossing that does little work costs well under 0.1 µs. The
  remaining tick cost is the JavaScript work behind the physics, event and
  state imports, not the crossings themselves.

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
    0xa0081). The spawned-actor view composes the same four. A native test
    of another +0x28 bit reads the whole image word instead ("VisibleActors
    bHidden" below).
  * The per-bit members are getters.
  * A non-pawn, non-brush map actor (`isMapMoveHost`) gets the motion word,
    as only it had the bJustTeleported binding. Map pawns followed in a
    separate change ("Pawn motion word" below).
  * The accessors are non-configurable. A leftover `delete` or an assignment
    to a derived member throws instead of splitting the storage again.
* **Layout evidence.** The installer checks each class once. The linker must
  have placed all 18 bools of the three words, and bHidden, at the SDK
  offset and mask. At install, the host's values must equal the image (level
  load writes both from the same serialized properties). A difference throws;
  it is not reconciled. For a motion word, the image must also start at the
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
* VisibleActors tested bHidden through `actorFlags & 2`, a bit no host word
  ever carried. "VisibleActors bHidden" below fixes that.

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
motion words differed on every pawn; "Pawn motion word" below fixes that.

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

**Pawn motion word (after 1e-1).** A map pawn's physics view kept its own
`motionFlags` host word, which started at 0 while the image (the script
bools) started at the class's 0x140. The physics' writes never reached the
bools. The original reads and writes the pawn's own +0x1ec. Scanning
Engine.dll's `.text` for every `+0x1ec`/`+0x1ed` operand gives the pawn
accesses below. The rest are copy constructors, net replication, non-pawn
physics, the interpolation bit 0x80, execParabolicTrace's bBounce read,
ABrush::PostLoad, and execMoveSmooth's clear (`0x103c8e45`; native 3969,
called only by PlayerPawn's PlayerWaiting and PlayerSpectating states and
not implemented by the port).

| Address | Function | Access |
|---|---|---|
| `0x103ca83e` | physWalking | clears bJustTeleported with `OldLocation = Location`, before the substeps |
| `0x103cbbed`, `0x103cbd3c` | physWalking | test it before each Velocity recompute |
| `0x103ce64e` | stepUp | sets it |
| `0x103d0f04` | physFalling | clears it at each substep |
| `0x103d22ce` | physFalling | tests bBounce, then bJustTeleported |
| `0x103d2d3b` | startSwimming | tests bBounce, then bJustTeleported |
| `0x103d3177`, `0x103d35fb` | physFlying | clears it, then tests it |
| `0x103d3d76`, `0x103d424f` | physSwimming | clears it, then tests it |
| `0x10398db7` | FarMoveActor | sets it when not a test move |
| `0x103c9faa` | APawn::physicsRotation | clears bFixedRotationDir (0x20), sets bRotateToDesired (0x40), after the PlayerPawn ancestry return |
| `0x103c9dde` | fixedTurn | reads 0x20 and 0x40 to pick its mode |

DeusEx.dll touches the word only in AScriptedPawn's copy constructor and
assignment. In the scripts, bJustTeleported is `const` (`Actor.uc:416`), and
only `WarpZoneInfo.Touch` reads it.

The fix:

* script-doors' `installFlagWords` installs the motion word on map pawns
  (`runtime.isMapPawn`) as well as map move hosts. `resetNpcs` no longer
  deletes `motionFlags`: `resetProperties` restores it with the image.
* The pawn view forwards `motionFlags` and `justTeleported` to the host's
  accessor. A map host with installed flag words but no motion word throws
  in `pawnPhysicsView`, so the install cannot silently regress.
* The spawned-actor view's `motionFlags` is the whole image word
  (`flagWord`), not the bJustTeleported bit alone. A spawned pawn's
  physicsRotation write now reaches bRotateToDesired and bFixedRotationDir.
  FarMoveActor's `| 0x100` keeps the word's other bits. A class without
  linked offsets (the isolated harnesses, such as `validate-script-spawn`)
  has no image, so its view composes the same nine bools from their fields.

The physics itself is unchanged. Each body that tests bJustTeleported clears
it first itself, so the old host word's 0 start and the image's 0x100 start
lead to the same moves. What changes is the state scripts, and the digest,
read:

* Digests change from the first checkpoint, under both VMs, which agree at
  all 30 checkpoints with no errors: Training `04f77dc631509ae4` to
  `c8eebff5786adf55`, Island `7b23d044fafab37f` to `b767a7e417fe5968`.
* A per-field dump of every script property of every Level.Actors entry at
  ticks 10, 20, 30, 50, 100 and 300 shows one differing property,
  bJustTeleported. It was True before and is False after on every map pawn
  a physics body ran for: 18 in Training (17 from tick 100, after
  UNATCOTroop2 dies and is replaced by its carcass), 52 on Island (51
  walking and 1 flying).
* Six Island map pawns at PHYS_None keep True, because no physics body runs
  for them. The spawned pawns (22 swimming and 11 flying on Island) and the
  player were already False through their image, and no pawn's
  bRotateToDesired or bFixedRotationDir changed.

`test/pawn-motion-word.test.mjs` runs on Engine's real Pawn layout. It checks
that the view's clear, the physicsRotation mode write and FarMoveActor's set
are the script bools, and that a test move leaves bJustTeleported alone. It
also checks that the word cannot be deleted, that a map pawn without the word
is refused, and that a spawned pawn view writes the whole word.

**VisibleActors bHidden (after 1e-1).** execVisibleActors (`0x103e5260`)
skips a candidate with `test byte ptr [edi+0x28], 2` at `0x103e5394`, where
`edi` is the candidate from `Level->Actors`. Bit 1 of +0x28 is bHidden (SDK
AActor `+0x028:1-1`). The port tested the host `actorFlags`. That word never
carried bit 1: level load composed only bStatic, bDeleteMe,
bCollideWhenPlacing and bMovable, and so do the spawned-actor view and the
1e-1 accessor (mask 0xa0081). A hidden candidate was therefore yielded.

* `actorWordOf` (`actor-flag-words.mjs`) returns a candidate image's whole
  +0x28 dword. The layout check now also requires bHidden at +0x28 mask 0x2.
* The runtime passes it to `createVisibleActorsIterator` as `actorWord`,
  which the iterator requires.
* No other `actorFlags &` test reads a bit outside the four the host word
  carries: collision-hash, relocation, move-query, encroachment-query,
  check-encroachment and the decoration and pawn views test only 0x1, 0x80,
  0x20000 and 0x80000.
* Scanning Engine.dll for `test byte ptr [reg+0x28], 2` finds bHidden tests
  in AActor::Tick (`0x103a2983`; actor-tick.mjs reads the script field),
  GetOptimizedRepList (replication, not ported) and execVisibleCollidingActors
  (native 312, not implemented).

`validate-native-visible-actors` now gives each fixture actor a real
Engine.Actor image holding the oracle's word, and a host `actorFlags` masked
as Play's is. The iterator's direct path reads the oracle word. The runtime
path (`createIterator(311)`) reads the image. With the old `actorFlags & 2`
test, both paths yield the hidden candidate and the validator fails (2
mismatches). `test/visible-actors-hidden.test.mjs` checks on Engine's Actor
layout that a candidate hidden through its script field is skipped before
FastLineCheck, while its host word reads bit 1 clear.

Digests are unchanged: Training `c8eebff5786adf55` and Island
`b767a7e417fe5968` with the pawn motion word, under both VMs at all 30
checkpoints. Neither map calls VisibleActors in the 360 bench ticks. Its
callers are Barrel1's radioactive Tick, Cloud, Gray and AutoTurret, and
counting every iterator native over the run finds 304, 306, 309, 310, 1000
and 1002, never 311.

**1e-2 — Scalar and vector mirrors in the image (implemented).** This is
step 2 of stage 1e ([object memory](object-memory.md#stages)). script-doors'
`makeBinding` bound these properties of every attached map actor, and of the
controlled player, onto plain host members. The physics, pawn-list and mover
code wrote the members, and the image cell under each binding went stale:

| Class | Offset | Field | Host member |
|---|---|---|---|
| AActor | `+0x030` | Physics (byte) | `physics` |
| AActor | `+0x0d8` | StandingCount (byte) | `standingCount` |
| AActor | `+0x144`, `+0x150` | Velocity, Acceleration | `velocity`, `acceleration` |
| APawn | `+0x45c`, `+0x498` | SpecialGoal, nextPawn | `specialGoal`, `nextPawn` |
| AInventory | `+0x398` | MyMarker | `marker` |
| AMover | `+0x4dc`, `+0x4e8` | myMarker, WaitingPawn | `marker`, `waitingPawn` |
| AMover | `+0x4f4` … `+0x530` | SimOldPos, SimOldRotPitch/Yaw/Roll, SimInterpolate, RealPosition, RealRotation, ClientUpdate | `simOldPosition`, `simOldRot*`, `simInterpolate`, `realPosition`, `realRotation`, `clientUpdate` |
| ALevelInfo | `+0x54c` | PawnList | the scene level's `pawnList` |

The members are now accessors over those cells (`actor-mirror-fields.mjs`),
and the bindings are gone.

* **Install.** script-doors' `attach` runs `installMirrorFields` right after
  it snapshots the actor's initial storage, and the Login path does the same
  for each player identity. Each cell first takes the member's current value,
  or the binding's fallback (`values.X`, or None for a pointer) while the
  member is absent. The host member was the field's storage until then, and
  the image cell had been hidden behind the binding. The snapshot comes first,
  so a reset still restores the map's serialized values.
* **Layout evidence.** Each field must be linked at its retail offset
  (`sdk-layouts.mjs` AActor, APawn, AInventory, AMover, ALevelInfo) with its
  kind: byte, int, vector, rotator or pointer. This is checked once per class
  cell, and a different placement throws.
* **Access.** A read goes through the arena's current view, and a vector read
  returns a fresh array, as the binding's getter did. A write stores through
  the field's codec: float32 components, a byte, an int32 or a handle. The
  accessors are non-configurable, so a leftover `delete` throws instead of
  splitting the storage again.
* **Resets.** The `delete actor.velocity`-style resets (resetProperties'
  Acceleration, resetNpcs' NPC_HOST_PROPS, the pickup and decoration
  restores) are `resetMirrorField`, which writes the value the binding showed
  once its host copy was gone. resetProperties keeps LevelInfo.PawnList as the
  host's collidable rebuild left it, since clearStartupPawnList walks that
  list, as before.
* **In-place writes.** The native reach workers restore Velocity component by
  component (`script-pawn-nav.mjs`, `vel[i] = …`). The pawn-nav `velocity`
  service now returns `liveVector`, an array whose element setters store the
  component; before, it returned the live host array. Player.tick's jump
  (`this.velocity[2] = JumpZ`) is a whole-vector store.
* **The Player.** `Player.velocity` is the linked identity's Velocity cell
  (`linkVelocity`, like 1e-1's motion word): the placeholder and each Login
  identity link when they attach, and `detachPlayerIdentity` unlinks before the
  retired identity's image is purged. Linking checks that both agree. The
  player identities' Acceleration, StandingCount, nextPawn and SpecialGoal are
  ordinary mirrors.
* **Bound keys.** `boundKeys` lost 17 keys (347 to 330 in both maps):
  every key in the table except `engine.actor.physics`. The Rust interpreter
  now reads and writes Velocity, Acceleration, StandingCount and the pointers
  as cells. The pawn physics views read them through `readNamed`, which now
  goes straight to the cell.

Not moved, and why:

* **The controlled player's Physics** is the movement port's state
  (`player.mjs`): `physicsPawn.physics`, `spawnPhysics` and `grounded`. The
  legacy Player.tick's physics pawn resets it from `grounded` at every call
  (`validate-gameplay` runs that path on a scripted game), and a script write
  sets `grounded`. Making it one storage is step 6. Its binding keeps
  `engine.actor.physics` a bound key, so the Rust interpreter still sends
  Physics reads on bound receivers to JavaScript. That covers every map actor
  until step 3 removes their Location bindings. Map actors' Physics is
  nonetheless their cell.
* Location, Rotation, the collision size, OldLocation (step 3), Base and
  Touching (step 4) and the mover interpolation fields (step 5) keep their
  bindings.

Shadow mode came first (`MIRROR_FIELDS_SHADOW=1`; the scaffolding was removed
after the proof, and its version is `.work/logs/1e2/shadow-version.diff`):

* The host member stayed the source, and the bindings stayed. Each member
  became an accessor over a host slot that also wrote the image, including the
  install adoption and the fallback write of `resetMirrorField`.
* Every host read, every installed member after each tick and after each
  reset, and every player identity's Velocity binding read compared the
  binding's value with the cell.
* Every host write was checked for exactness in its cell: float32
  components, int32 rotator components, a byte, an int32 or an object.
* Every read of an absent member was counted, and its fallback compared with
  the zero default. Some host readers default to `[0, 0, 0]` rather than
  `values.X`.
* Reads and writes of a released image were counted too.

| Run | Hosts | Mirrors | Host reads | Host writes | Fallback writes | Tick checks | Reset checks |
|---|---|---|---|---|---|---|---|
| Training, 360 ticks | 314 | 1,552 | 270,460 | 58,215 | 494 | 558,720 | 0 |
| Island, 360 ticks | 2,240 | 9,326 | 1,131,351 | 176,880 | 2,972 | 3,357,360 | 0 |
| Island, Player start every 100 ticks | 2,242 | 9,334 | 1,172,751 | 194,576 | 8,918 | 3,358,560 | 18,664 |
| validate-loadmap-gc (22 Player starts) | 336 | 1,640 | 415,409 | 130,688 | 11,384 | 1,054,680 | 35,156 |
| validate-gameplay (legacy Player.tick) | 4,795 | 20,081 | 809,853 | 157,359 | 6,934 | 4,501,428 | 1,547 |

The validate-gameplay row is from the first shadow version, before
Inventory.MyMarker joined the table; the other rows include it.

Results:

* **Writers.** No host write was inexact, in Play or in validate-gameplay's
  legacy Player.tick on a linked identity. The float64 writers the scoping
  report named (`player.mjs`'s `groundVelocity` and its `(position - origin)
  / dt` re-derivation) run only in the synthetic no-collision-queries path,
  whose Player has no identity, so they never reach an image.
* **Other checks.** No mirror was read or written after its image was
  released. Every absent-member read had a fallback equal to the zero
  default. The linked player velocity never differed from its cell
  (12,754 to 83,696 checks per run).
* **Early runs.** The first Training run found one mismatch. The property
  reset restored LevelInfo.PawnList to None while clearStartupPawnList read the
  host's rebuilt list. resetProperties now keeps the list (above).
* **After a Player start.** The only mismatches are reads inside a
  whole-value store: `PropertyReference.set` reads the old value, then
  discards it for a non-bool. The reset restores the serialized values of
  non-selected movers' RealPosition/RealRotation and Island's map GasGrenades'
  Velocity, where the host copy kept the previous session's. The first read
  after the reset is the store that overwrites it: Mover.BeginPlay's
  `RealPosition = Location` and ThrownProjectile.BeginPlay's
  `Velocity = Speed * Vector(Rotation)`. There were 40 such reads
  over two Island resets and 88 over 22 Training resets. Nothing else reads
  them in between, so the restored value is never observed, and it matches
  what a reload holds.

Verification:

* **Digests.** Unchanged at all 30 checkpoints, both VMs, `SCRIPT_VM_CHECK=1`,
  errors `{}`: Training `c8eebff5786adf55` and Island `b767a7e417fe5968`.
  A bench variant with a Player start every 100 ticks also matches the
  unmodified tree at all 30 checkpoints: Training `7d6b963bf807a9bf` and
  Island `fe9b9fa4099571c9`, both VMs.
* **Validators.** `validate-script-vm-interp`, `validate-collision-kernel`,
  `validate-object-image` and `validate-object-handles`.
* **Native oracles.** falling, landing, walking, walking-callbacks, rolling,
  flying, velocity, steps, actor-physics, pawn-list, mover-finish,
  mover-scene, mover-move, mover-interpolation, mover-blocking, set-base,
  relocation and far-move-scene.
* **Play validators.** `validate-decoration-settle-roll`,
  `validate-script-decoration`, `validate-pawn-locomotion`,
  `validate-pawn-nav`, `validate-pawn-perception`, `validate-world-destroy`,
  `validate-loadmap-gc`, `validate-island-swimming`,
  `validate-island-jump-reach`, `validate-island-falling-water`,
  `validate-training-ladder`, `validate-mover-frob`,
  `validate-script-lifecycle` and `validate-script-spawn`.
  `validate-gameplay`'s output is byte-identical to the unmodified tree's.
* **Unit tests.** The 560 unit tests (three new) pass.
  `test/actor-mirror-fields.test.mjs` checks, on Engine's real layouts, the cells at the retail offsets, script and host
  writes as one storage, fresh vector reads, `liveVector`, codec stores, the
  refused `delete`, the reset fallbacks, Inventory.MyMarker,
  LevelInfo.PawnList on the scene level and the Player's velocity link.
* **Browser.** A 240-frame Chromium Island walk had no page or runtime error.

Cost, from bench-sim `--bound-reads` (host binding calls per timed tick):

| Run | Before | After | Mirrored keys |
|---|---|---|---|
| Island, JavaScript VM | 7,276 | 4,596 | 2,694 → 15 |
| Island, Rust VM | 6,791 | 4,112 | 2,694 → 15 |
| Training, Rust VM | 1,789 | 1,043 | 758 → 13 |

What is left of the mirrored keys is the controlled player's Physics.

* **Rust interpreter.** Its `[bound engine.actor.velocity]` (57.8 per Island
  tick) and `[bound engine.actor.acceleration]` (2.3) fallbacks are gone.
  `[bound engine.actor.physics]` (6.8) stays, and `js value 0x36 [of 0x1]`
  (a struct member of a field) fell by 51 over the run. No other stats row
  changed. Two window rows only entered the printed top 60.
* **Call counts.** `readNamed` per Island tick is unchanged at 30,369: the
  same calls, now without a binding. `instance` went from 58,550 to 58,486.
* **Handles.** After 180 Training ticks, `validate-object-handles` counts
  3,085 non-None image pointers instead of 3,067, and 2,732 live handles
  instead of 2,731. The cells now hold the pawn-list, SpecialGoal and marker
  pointers the host members held, and one identity that only a host member
  referenced gets its handle.

The median `SCRIPT_VM=rust` Island tick over four interleaved pairs:

| Pair | Before (ms) | After (ms) |
|---|---|---|
| 1 | 19.41 | 18.60 |
| 2 | 19.39 | 18.97 |
| 3 | 19.12 | 18.70 |
| 4 | 19.15 | 18.39 |

The tick was lower in all four pairs, by about 0.6 ms on average.

**1e-3 — Location, Rotation, collision size and OldLocation in the image
(implemented).** This is step 3 of stage 1e ([object memory](object-memory.md#stages)).
script-doors' `makeBinding` bound these properties of every attached map
actor, and of the controlled player, onto host members, and the image cell
under each binding went stale:

| Offset | Field | Map actor member | Player member |
|---|---|---|---|
| `+0x114` | Location (vector) | `position` | `position` |
| `+0x120` | Rotation (rotator) | `rotation` | `bodyRotation` |
| `+0x12c` | OldLocation (vector) | `oldLocation` (map move hosts only) | `spawnOldLocation` |
| `+0x1d4` | CollisionRadius (float) | `radius` | `radius` |
| `+0x1d8` | CollisionHeight (float) | `height` | `height` |

The members are now accessors over those cells (`actor-pose-fields.mjs`), and
the bindings are gone.

* **Install.** script-doors' `attach` runs `installPoseFields` after the
  initial-storage snapshot and `installMirrors`. Each cell first takes the
  member's current value, or the binding's fallback while the member is
  absent: a mover's interpolation state, then `values.X`, then zero; for
  OldLocation, the image cell itself. The accessors are non-configurable, so a
  leftover `delete` throws. OldLocation is installed only where the binding
  existed (`isMapMoveHost` at attach). Elsewhere it already was the image's:
  pawns' physics views, movers and every other map actor read and wrote the
  cell.
* **Layout evidence.** Each field must be linked at its retail offset
  (`sdk-layouts.mjs` AActor) with its kind: vector, rotator or float. This is
  checked once per class cell, and a different placement throws.
* **Access.** A read goes through the arena's current view and returns a
  fresh array. A write stores through the field's codec: float32 components,
  int32 rotator words, a float32. No code mutated these arrays in place. A
  scan for element stores, `push`/`splice`/`fill`, identity comparisons and
  `in` checks on them found none; every writer replaces the whole value. So
  the aliases the old members allowed carry no state:
  * `player-physics.mjs` `player.position = pawn.position`: the physics
    pawn's array is reassigned, never mutated, before its next use.
  * `decoration-physics.mjs` `host.position = pawn.position`: the falling
    pawn is local to the step.
  * `mover-move.mjs` swaps `mover.position` for the reverse push
    (`0x1039a6f6`–`0x1039a773` writes only Location, +0x114). The swap now
    writes the cell, which is the original's store, and script reads during
    the push saw the swapped value through the binding before too.
  * `prepareActor` assigned `actor.rotation = v.Rotation`, sharing the
    serialized array with `values`, and `doors.mjs` gives a mover's
    interpolation state the same array. The cell is a copy. Neither array is
    ever mutated.
  * The `collisionValues` getters (`linkLiveCollision`,
    `linkDecorationCollision`, game.mjs's mover values, the player identity's
    values) read the members, now the cells, so the collision hash, line
    checks and `lc_candidate` see the same live values.
* **Resets.** `resetProperties` restores the whole image. Location, Rotation
  and the collision size were host members that restore never touched: each
  reset path restores its own actors' pose afterwards, inside the hash's
  remove/re-add for a registered actor. `keepLivePose` puts those four cells
  back after the restore. Otherwise `changeActor`'s removal would find a
  pickup or decoration at its serialized place while the hash still holds it
  at the live one ("Remove actor before changing its registered location").
  OldLocation is restored with the image, as before: prepareActor's `delete
  actor.oldLocation` is now `resetPoseField`, which writes the serialized
  value the binding showed after the delete. resetNpcs' `delete` of a pawn's
  `position` and `rotation` is `resetPoseField` too.
* **The Player.** `Player.position`, `bodyRotation`, `radius`, `height` and
  `spawnOldLocation` are the linked identity's cells (`linkPose`, like
  1e-2's velocity). The placeholder and each Login identity link when they
  attach, and `detachPlayerIdentity` unlinks before the retired identity's
  image is purged, keeping the values as host state. Linking stores the
  members' values into the cells and refuses a value the cell cannot hold
  exactly. The placeholder's image never held the spawn spot, the
  crouch-derived height 43 or the start yaw. Its cells read zero for
  Location, OldLocation and Rotation, and 47.5 for the height, hidden behind
  the binding, which showed the Player's members. Each Login identity's image
  already agrees, because `bindCollisionIdentity` copies it.
  The legacy physics pawn's `oldLocation` forwards to `spawnOldLocation`.
  Before, it was a separate member that the collision identity read once the
  pawn existed. The pawn is created without one and assigns it in the same
  call before any read, so the values seen are the same.
* **Movers.** The Location and Rotation bindings also wrote a mover's
  `interpolation.position` and `.rotation`. Only a write through the script
  field ran that code, and none reaches a mover:
  * Location and Rotation are `const` in `Actor.uc`.
  * SetRotation takes MoveActor for a brush.
  * The map-actor move entries (`mapMoveLevel`) require `isMapMoveHost`,
    which excludes brushes.

  The shadow runs counted zero such writes. `doors.mjs`'s move callback keeps
  `interpolation.position` in step with the moved mover as before. The
  interpolation object itself is step 5.
* **Bound keys.** `boundKeys` lost `engine.actor.location`, `rotation`,
  `collisionradius`, `collisionheight` and `oldlocation` (330 to 325 in both
  maps). The Rust interpreter reads Location, Rotation and the collision size
  of every receiver from its image, the player included.

Shadow mode came first (`POSE_FIELDS_SHADOW=1`; the scaffolding was removed
after the proof, and its version is `.work/logs/1e3/shadow-version.diff`):

* The host member stayed the source, and the bindings stayed. Each member
  became an accessor over a host slot that also wrote the image, including the
  install adoption, the resets' fallback writes and `keepLivePose`. The
  Player's members wrote through to their linked cells.
* Every host read compared the member with its cell, as did every installed
  member after each tick and after each reset. So did every binding read,
  comparing what the script saw with the cell.
* Every host write, and every write of a linked Player member, was checked for
  exactness in its cell: float32 components, int32 rotator words, a float32.
* Absent members were emulated. A read of one was classified as either
  through the binding, which showed the fallback, or direct. A later store
  into one was compared with the fallback.

| Run | Hosts | Members | Host reads | Host writes | Binding reads | Tick checks | Reset checks | Player checks |
|---|---|---|---|---|---|---|---|---|
| Training, 360 ticks | 312 | 1,516 | 411,082 | 7,280 | 328,073 | 545,760 | 0 | 55,030 |
| Island, 360 ticks | 2,238 | 11,112 | 2,362,417 | 54,069 | 1,705,516 | 4,000,320 | 0 | 70,019 |
| Training, Player start every 100 ticks | 312 | 1,516 | 406,550 | 10,968 | 331,525 | 545,760 | 3,032 | 37,056 |
| Island, Player start every 100 ticks | 2,238 | 11,112 | 2,730,945 | 82,015 | 1,938,134 | 4,000,320 | 22,224 | 44,703 |
| validate-gameplay (legacy Player.tick) | 4,788 | 23,740 | 1,349,328 | 28,627 | 945,294 | 4,662,576 | 1,516 | 264,042 |
| validate-loadmap-gc (22 Player starts) | 312 | 1,516 | 737,879 | 46,900 | 490,768 | 1,000,560 | 33,352 | 49,578 |

Both VMs gave the same counts, and every digest equalled the reference.

Results:

* **Writers.** No host write and no linked Player write was inexact. The
  float64 writers in `player.mjs` are the synthetic no-collision-queries path
  (`add(this.position, scale(delta, time))`, the stance target, `adjustFloor`'s
  moves). Their Player has no identity, so they never reach a cell. The
  original stores float32 there (FVector), which only matters for a fixture.
* **Consistency.** No member or binding read ever differed from its cell, no
  member was read or written after its image was released, and the reset
  checks found none either.
* **Absent members.** Only LevelInfo0 had no pose member. Every read of it
  went through the binding and showed the fallback, which equalled the image:
  [0, 0, 0] and a radius and height of 22 on Training; on Island, its
  serialized Location. It gets accessors like any other host. The map move
  hosts' OldLocation was absent until FarMoveActor wrote it; those reads
  showed the attach's image.
* **Pawn resets.** After resetNpcs' deletes, the only direct read of an
  absent member was the pawn view's `actor.rotation ??= get('Rotation')`
  (174 in the Island Player-start run, 414 in validate-loadmap-gc). It
  stored the fallback it would now read, and so did every other store into
  an absent member.
* **Kept across resets.** `keepLivePose` found the restore would have moved
  208 cells in the Island Player-start run (116 pawns, 92 other actors) and
  420 in validate-loadmap-gc (378 and 42). All were Locations. The recorded
  examples were pawns that had walked, and pickups and decorations that had
  settled. The reset paths restore these actors themselves, inside the hash's
  remove/re-add.
* **Player links.** Only the placeholder's cells took a different value
  (above). Every Login link agreed: each run's initial Login, three Player
  starts per Player-start bench run, and 22 in validate-loadmap-gc.
* validate-gameplay's output is byte-identical to the unmodified tree's.

Verification:

* **Digests.** Unchanged at all 30 checkpoints, both VMs, `SCRIPT_VM_CHECK=1`,
  errors `{}`: Training `c8eebff5786adf55` and Island `b767a7e417fe5968`.
  The Player-start-every-100-ticks variant matches the unmodified tree at all
  30 checkpoints: Training `7d6b963bf807a9bf` and Island `fe9b9fa4099571c9`,
  both VMs. Island is unchanged under `HASH_DIFFERENTIAL=1` (829,611 line
  checks and scans and 831,255 visit orders compared, none handed back) and
  under `RAY_DIFFERENTIAL=1`.
* **Validators.** `validate-script-vm-interp`, `validate-collision-kernel`,
  `validate-trace-kernel`, `validate-object-image` and
  `validate-object-handles`. `build-wasm` rebuilds byte-identical modules.
* **Native oracles.** move, move-query, move-smooth, actor-rotation,
  set-rotation-riders, based-actors, zone, player-move, mover-scene,
  mover-move, far-move-scene, relocation, walking and falling;
  `validate-script-set-location` and `validate-pawn-nav`.
* **Play validators.** `validate-world-destroy`, `validate-loadmap-gc`,
  `validate-island-swimming`, `validate-island-jump-reach`,
  `validate-island-falling-water` and `validate-training-ladder`.
  `validate-gameplay`'s output is byte-identical to the unmodified tree's.
* **Unit tests.** The 564 unit tests (four new) pass.
  `test/actor-pose-fields.test.mjs` checks, on Engine's real layouts:
  * the cells at the retail offsets, with script and host writes as one
    storage;
  * fresh reads and codec stores;
  * the refused `delete`;
  * the reset fallbacks, including a mover's interpolation state;
  * OldLocation installed only where it was bound;
  * `keepLivePose` across a restore;
  * the Player's links, including adoption and the refusal of an inexact
    value.
* **Browser.** A 240-frame Chromium Island walk had no page or runtime error.

Cost, from bench-sim `--bound-reads` (host binding calls per timed tick):

| Run | Before | After | Pose keys |
|---|---|---|---|
| Island, JavaScript VM | 4,596 | 1,000 | 3,596 → 0 |
| Island, Rust VM | 4,112 | 516 | 3,596 → 0 |
| Training, Rust VM | 1,043 | 255 | 789 → 0 |

`boundKeys` holds 325 keys at the end of each run, 330 before.

* **Rust interpreter.** Its bound-field fallbacks are gone: Location (110.4
  per Island tick), Rotation (22.2), CollisionRadius (16.7) and
  CollisionHeight (15.7). `VSize` (native 225, 3.5 per tick) now runs in
  Rust, because its operands became memory reads under the one-import
  policy. Five new rows of 1.1 to 1.2 per tick each appear, from statements
  the lowering now admits: natives 193 and 715, a context struct member, a
  local variable and a bound float field fallback. The top 60 JavaScript import rows
  fell from 1,389 to 1,224 per tick.
* **Call counts.** `readNamed` per Island tick is unchanged at 30,369: the
  same calls, now without a binding. `instance` went from 58,486 to 58,303.

The median `SCRIPT_VM=rust` Island tick over four interleaved pairs:

| Pair | Before (ms) | After (ms) |
|---|---|---|
| 1 | 18.40 | 17.99 |
| 2 | 18.49 | 18.59 |
| 3 | 18.64 | 18.57 |
| 4 | 18.64 | 18.28 |

The tick was lower in three of the four pairs, by about 0.2 ms on average,
which is within noise. CPU time per tick fell in all four pairs, from 23.6 to
26.1 ms before to 23.5 to 23.8 ms after.

Left bound or on the host, and why:

* **The collision kernel** still reads a candidate's Location, radius and
  height through `lc_candidate` (`valuesOf(actor)`). It lives in the trace
  kernel's instance, not a runtime arena (R3-b B0). The values it reads are
  now the cells.
* **Map actors without `collisionValues`** register in the hash with their
  serialized `values.Location`. Their cylinder does not follow the live
  position until a native body links it (`linkLiveCollision`,
  `linkDecorationCollision`). This is unchanged, and it is not a binding.
* **The mover interpolation object** (`interpolation.position`, `.rotation`
  and the KeyPos/KeyRot, OldPos and BasePos bindings) is step 5.
* **Base and Touching** are step 4. **The player's view fields, regions and
  Physics** are step 6.
* **Player start** still restores Location only for the actors its reset
  paths name: pawns, patrol points, pickups, decorations and movers.
  `keepLivePose` keeps that exactly. Any other map actor that moves keeps
  its live pose across a Player start, where the original's reload would
  restore it. That is a fidelity question for its own change.

**R3-c — Perception natives (implemented).** ScriptedPawn's IsValidEnemy
(2105) and GetPawnAllianceType (2107), and Pawn's AICanSee (705) with the
AIVisibility and AIGetLightLevel it calls, run in the interpreter
(`native/script-vm/src/percep.rs`; host half `script-vm-perception.mjs`).
Each body transcribes its JavaScript function (`execPawnAlliance`,
`execAICanSee`, `actorVisibilityExtended`, `actorLightLevelExtended`): the
same reads in the same order, the x87 model's operations with its operand
order, `Math.fround` where it rounds. The JavaScript stays the reference, the
path under `SCRIPT_VM=js`, and the answer to every call Rust hands back.

The profile at 17722b8 (Island, `SCRIPT_VM=rust`, 20.8 ms per tick) put the
interpreter's natives at 3.36 ms per tick. AICanSee took 1.07 ms, of which
0.75 ms was AIGetLightLevel's scan: its 0.5 queries per tick each read
LightType and LightBrightness of all 2,618 Level.Actors through `soundField`,
about 580 ns per actor. IsValidEnemy took 0.65 ms over 340 calls per tick;
0.28 ms of it built the 16 AlliancesEx struct objects of each pawn it
compared.

* **The two instances.** The bodies read about 30 fields of up to 2,600
  actors, so they run in the interpreter's instance, on the runtime arena
  where the images are. Their traces stay in the trace kernel's instance
  (R3-b B0), which holds the BSP and the collision hash, through one import
  per check:
  * `js_light_trace`: AIGetLightLevel's SingleLineCheck for a static light
    in range (flags 6);
  * `js_los_trace`: AICanSee's SingleLineCheck wrapper, its hit filter
    included (owner chain, bBlockSight, bHidden).

  Both are small: 0.016 ms per tick of line of sight and about 0.05 ms of
  light traces in the profiles. Moving the hash and the BSP into each
  runtime's arena would save less than that, at the cost of a second copy
  of the queries' memory. So the trace part stays where it is and the rest
  runs in Rust.
* **Names in the image.** The alliance bodies compare names: Pawn.Alliance
  (+0x5c4) and each AllianceInfoEx.AllianceName (+0x7ec, stride 16). A name
  cell (`NAME` in `script-object-image.mjs`) keeps its value in the
  reference array, as before, and now also writes the value's host id into
  its four bytes (`script-name-ids.mjs` `nameCellWord`). None is 0, so a
  zeroed image or frame block reads as None and FrameLocals' zero-bytes
  check still holds. The id is `nameKeyId`, the fold
  `String(v ?? 'None').toLowerCase()` that `nameKey` compares. R2b-6's
  `nameId` folds `String(v || 'None')`; the two differ for the empty name,
  which scripts do store (`PotentialEnemyAlliance = ''`). Snapshots, restores
  and class-image copies move bytes and references together.
* **Reads.** A field is read in the image exactly when `readNamed` reads
  that cell:
  * the object's receiver info is not HOST (attached here, an image, no
    poison, not released);
  * on a BOUND receiver, the field's key is not a bound key (the
    interpreter's own rule);
  * its class row's new field word has the field's bit.

  The host writes the field table once (`P_FIELDS`: offset, bool mask and
  key id from the cell registry, with the cell kind the Rust body reads,
  checked). Each class row gets two more words after its names: a field
  word, whose bit is set when `lookupMember` resolves the spelling to that
  key and the class's cell equals the table's (`sameCell`: tag, offset,
  mask, element and members), and a flag word (ScriptedPawn by record key,
  as the alliance `isA` compares). `js_class_fields` computes them on first
  use.
* **Alliance.** The bodies only read. A read that cannot be made in the
  image hands the whole call to `execPawnAlliance`, with the arguments Rust
  evaluated (`P_ARGS`), before any effect. In the Island run no call was
  handed back.
* **AICanSee.** AIVisibility writes the target's cache (VisUpdateTime,
  CurrentVisibility, LastVisibility) halfway through, between the light
  scan's traces. So Rust makes the writes and the imports in the
  JavaScript order, and an import that throws leaves the same state. A read
  that is not in the image goes through `js_pread`/`js_pread3` (the body's
  own read service at the same point, with script-ai-visibility's
  undefined check where it has one), and a write through `js_pwrite`. The
  call is handed back (`js_aicansee`) only before the first write:
  * a NaN clock, or a NaN CurrentVisibility copied into LastVisibility. The
    stored NaN's bits would be V8's. LLVM folds the float32 widening and
    narrowing and keeps a signaling NaN, and the mutation pass shows JS
    storing `0x7fe…` where Rust stored `0x7fa…`;
  * a nonfinite rotation argument or arc tangent, where the JavaScript
    throws;
  * a host lighting seam (`perceptionLighting`).
* **Transcendentals and tables.** Math.atan (appAtan) and Math.atan2
  (vectorToRotator) are imported directly, so they are V8's. The
  validator's hardware tables (`.cache/pawn-percep`) are a `services` seam
  only the oracle validator sets; the runtime never does. `Math.sqrt` is
  `trace::sqrt`. FCoords uses the sine table the kernel already holds.
* **Level.Actors.** `js_level_actors` builds the list the scan walks, as
  (handle, receiver info) pairs. The list is reused while the array, its
  length and the base epoch (`base-epoch.mjs`) are unchanged. That epoch
  already advances on every structural change of a Level.Actors array and
  on poisoning, bulk restores and releases. `bindProperty` now advances it
  too, since a binding makes a receiver BOUND. A reused HOST entry whose
  object has since become readable only sends its reads to JavaScript.
* **Lowering.** PAWN_ENEMY 200, PAWN_ALLIANCE 201 and AI_CAN_SEE 202 carry
  the call's node, the argument count, and per argument a presence word (0
  for EX_Nothing) and its code. Rust evaluates the arguments in order
  before the body, as `evaluateArgument` does. A call is lowered only when:
  * `runtime.invokeNative` would run the body (the services' invokeNative
    is the runtime's, the native is not a boundary native, and no host has
    replaced `invokeNative` on the runtime instance, as
    `validate-mib-startup-boundary` does to count calls);
  * the table has every field the body reads;
  * IsValidEnemy's optional bool is not a JavaScript leaf, whose undefined
    the body reads as true.
* **PERCEPTION_DIFFERENTIAL=1.** After every call Rust completes:
  * the host restores AICanSee's target cache from a snapshot taken when
    the call began, and runs the JavaScript body on the same arguments;
  * it compares the result bits, the three cache fields and every trace
    (kind, endpoints, answer), and throws on a difference;
  * every reused Level.Actors list is compared with a fresh build.

Exactness hazards met:

* The two name folds (above).
* EX_Nothing arguments: `AICanSee(beamActor, , false, …)` evaluates
  `Number(undefined)`, NaN, and returns 0. `Boolean(undefined)` is false for
  a flag, not its default. Rust does what the JavaScript does.
* `viewRot = f32(base + add)` rounds the integer sum to a float32 before
  fcoordsAxes' `| 0`, which matters for rotators beyond 2^24.
* The JavaScript's `x87sqrt` throws on NaN. The angular-size gate returns
  first for every NaN it could see, and appAtan's finiteness check would
  hand such a call back.
* The FCOM model: a signed zero compares as zero, and unordered sets both
  flags.
* Engine.pawn.baseeyeheight is a bound key (the controlled player's view
  bindings), and every map actor is BOUND, so a viewer's BaseEyeHeight is
  read through JavaScript: 24 reads per Island tick.

Verification:

* `scripts/validate-perception-kernel.mjs` runs each lowered native in Rust
  on random worlds with mock imports, then the JavaScript body on the same
  arguments. It checks result bits, every image byte, host-side values,
  traces and errors. The worlds include HOST and BOUND objects,
  class-less rows and missing field bits, JavaScript leaves and EX_Nothing
  arguments, NaNs with payloads, signed zeros and infinities, a missing
  zone or LevelInfo, and the lighting seam. There are also boundary cases:
  * MinAngularSize equal to the angular size;
  * a yaw on the plateau edge of a zero-extent trapezoid;
  * lights at exactly their radius;
  * a light at distanceSq 275,593 against radiusSq 275,625, where the
    double store before appSqrt changes the attenuation;
  * visibility caches of negative zeros.

  With 100,000 cases (40,000 IsValidEnemy, 20,000 GetPawnAllianceType,
  40,000 AICanSee), all are identical. 81,674 completed in Rust and 18,326
  were handed back. When every field a call reads is in the image, the
  validator requires that an alliance call is not handed back and that
  AICanSee makes no JavaScript read or write (6,118 such AICanSee cases).
* A mutation pass broke `percep.rs` 73 ways (`.work/logs/percep/mutate.mjs`);
  68 fail the validator. The five survivors:
  * the wrap loop's `<=` against `<`, which the following absolute value
    makes equivalent;
  * reading LastVisibility back instead of using the value just written,
    which is the same value;
  * the explicit EX_Nothing test on the target, whose UNDEF bits convert to
    handle 0 anyway;
  * appAtan's finiteness check, unreachable because Math.atan of a non-NaN
    double is finite;
  * the CurrentVisibility NaN hand-back, which the payloads tested store the
    same way in both, and which stays as a guard.
* Under `PERCEPTION_DIFFERENTIAL=1` on Island (360 ticks) the host compared:
  * 118,954 alliance calls and 8,847 AICanSee calls;
  * 1,958 traces and 26,541 cache fields;
  * 151 reused Level.Actors lists (24 were built).

  There was no difference, and the digest is unchanged.
* Digests are unchanged at all 30 checkpoints under both VMs with
  `SCRIPT_VM_CHECK=1`, errors `{}`: Training `c8eebff5786adf55` and Island
  `b767a7e417fe5968`.
* `validate-object-handles` now checks that every name holds its id: 10,165
  names on Training and 40,623 on Island (its new `--map` option).
* Native oracles: pawn-alliance (31 cases), pawn-perception (55 scenes and
  13 mutations), ai-visibility (41), ai-visibility-runtime, pawn-locomotion
  (103 scenes, 21 mutants), pawn-nav (15 scenes, 35 mutants), based-actors,
  set-base and set-rotation-riders.
* `validate-mib-startup-boundary` gives the same output under both VMs, and
  `validate-gm-trench-play-anim` passes under `SCRIPT_VM=rust`.
* `validate-script-vm-interp`, `validate-script-vm-x87`,
  `validate-trace-kernel` and `validate-collision-kernel` pass.
* `validate-loadmap-gc` under `SCRIPT_VM=rust` keeps 2,729 handles across
  its Player starts; old space grew 1.00 MiB over 19 resets.
* The 566 unit tests pass. The new `test/name-cell-ids.test.mjs` checks the
  two folds and, on DeusEx's real ScriptedPawn layout, the Alliance and
  AlliancesEx name bytes through writes, snapshots and restores.
* A 240-frame Chromium Island walk under `?scriptVm=rust` had no page or
  runtime error.

Cost: the median `SCRIPT_VM=rust` Island tick over four interleaved pairs
(HEAD 17722b8 against this change):

| Pair | Before (ms) | After (ms) | CPU before | CPU after |
|---|---|---|---|---|
| 1 | 18.67 | 16.22 | 24.08 | 22.59 |
| 2 | 18.02 | 16.41 | 23.33 | 21.46 |
| 3 | 18.02 | 16.51 | 25.30 | 21.52 |
| 4 | 18.15 | 16.38 | 23.51 | 21.20 |

The tick was lower in all four pairs, by about 1.7 ms. In a `--cpu-prof`
window of 300 Island ticks (after: a build with Wasm names):

| ms per profiled tick | Before | After |
|---|---|---|
| AICanSee | 1.07 | 0.19 |
| AIGetLightLevel | 0.75 | 0.16 (0.03 building the Level.Actors list, 0.05 light traces) |
| IsValidEnemy | 0.65 | 0.05 |

The interpreter's `js value native 2105` (340 per tick) and `native 705`
(24 per tick) fallbacks are gone. What is left of the scan is the list
build when the epoch moved, the light traces and the x87 model's u128
arithmetic.

Left in JavaScript, and why:

* **GetAllianceType (2106)**: no call in the bench runs, and its name
  argument would need the `??` fold for a JavaScript leaf.
* **The other perception natives**: LineOfSightTo, CanSee, PlayerCanSeeMe,
  PickTarget and PickAnyTarget, AIGetLightLevel and AIVisibility called
  from script, and Actor.Tick's ShowSelf and CheckEnemyVisible. None is hot
  in the profiles.
* **The traces**: they stay in the trace kernel's instance (above).
* **Reads of bound keys** on BOUND receivers, until the bound-key rule is
  per object.

**R3-d — Actor tick bookkeeping (implemented).** The per-actor body of
Actor.Tick runs in the interpreter (`native/script-vm/src/tick.rs`; host half
`actor-tick-kernel.mjs`): `tickStandaloneActor` with `actorInStasis`, the
owner test, bTicked, the timer phase (`updateActorTimer`), LifeSpan, the
physics gate and the Pawn tail, and `tickActorAnimation`'s main and blend
loops over the animation tick view ([actor tick](script-actor-tick.md),
[animation tick](script-animation-tick.md)). Each body is transcribed step
for step, as in R3-c: the same reads, writes and callbacks in the same order,
the same double arithmetic, `Math.fround` where it rounds. The JavaScript
stays the reference, the path under `SCRIPT_VM=js` and under
`ACTOR_TICK_KERNEL=js`, and the answer to every tick Rust hands back.

Scope. A `--cpu-prof` window at 3e8d78b (Island, `SCRIPT_VM=rust`, 300
ticks, 19.6 ms per profiled tick) put 3.79 ms per tick in the level tick
outside script, physics and the other services:

| ms per profiled tick | |
|---|---|
| `tickStandaloneActor` (prelude, pawn tail, reads) | 1.11 |
| `tickActorAnimation` and `processActorAnimation` with the view | 1.27 |
| `actorInStasis` | 0.31 |
| `scriptAndTimer` and `updateActorTimer` | 0.24 |
| `compactScriptActors` | 0.31 |
| `tickStandaloneLevel` (the loop and DistanceFromPlayer) | 0.25 |

An Island tick ticks about 770 actors (Level.Actors from FirstDynamicActor),
each with about 15 `readNamed` calls; 700 run the animation phase (630 of
them inactive), 380 get a Tick event and 700 ProcessState. The `readNamed`
cluster was 6.52 ms per tick, 1.92 ms of it inside these bodies. The slice is
the whole per-actor body with its animation phase: it removes those reads
and leaves one call per actor plus one import per callback. The level loop,
DistanceFromPlayer and the compaction stay JavaScript (below).

* **The actor.** `ActorTickHost.run` passes the image base, a 42-bit field
  mask and class flags (Pawn, PlayerPawn, Weapon by record key, as the tick's
  `isA` compares). Field i is set exactly when `readNamed` reads the cell the
  table (`T_FIELDS`: offset, bool mask or fixed-array stride, from the cell
  registry) describes:
  * the class resolves the spelling to the table's key, and the handle
    `readNamed` uses (the class's cached `namedHandle`, which the first
    resolving instance fills, or the cell it will cache) is the table's cell;
  * the instance has no binding for that key. This is per object, not R3-c's
    bound-key rule: `engine.actor.physics` is a bound key (the controlled
    player's binding) and every map actor is BOUND (its remaining host
    bindings, the mirrored Level among them), so that rule would send about
    770 Physics reads per tick to JavaScript;
  * the receiver is not HOST (image here, no poison, not released).

  The mask is cached on the instance (`tickDesc`) while its bindings' count,
  its class's resolved names and the table are unchanged. Bindings are only
  ever added (`bindProperty`), so an unchanged count is an unchanged key set.
* **Hand-back.** Up to the first effect (the bTicked write) every read must be
  in the image; otherwise Rust hands the whole tick back and the JavaScript
  body runs it, errors included (a Role other than 4, a zone render time that
  is not a number). Those reads have no effect. PlayerPawns (the controlled
  player's input and view-target branches) are handed back by the host
  before the call. Owner-deferred ticks return DEFER, and the host allocates
  and links the node as the body does, after the same reads.
* **Callbacks.** Each callback is an import that calls the same service at
  the same point: ProcessState, the events (Tick, Timer, Expired,
  UpdateEyeHeight, PainTimer, SpeechTimer, UpdateTactics, AnimEnd and
  notifies), performPhysics, DestroyActor, FarMoveActor of the weapon,
  ShowSelf and CheckEnemyVisible. A callback can change anything, so it
  writes the actor's fresh receiver info, mask and the level's DemoRecDriver
  test into `T_STATE`, which Rust reads back. Reads without effects are
  imports too: IsProbing, the zone render time, the owner's bTicked, the
  latent action and the notify selection (`selectAnimNotify`, shared with
  the JavaScript body, over the mesh). replicateCompletion's plane write
  stays JavaScript (`js_anim_sim`, with the frame and rate Rust computed).
* **After the first effect**, a field outside the mask is read and written
  through JavaScript at the same point: the tick's `services.read`/`write`,
  or the animation view's accessor (`js_tick_get`/`js_tick_set`,
  `animFlags` as one value). Where a statement uses such a field (the
  ViewRotation copy, the weapon's FarMoveActor) the statement runs in
  JavaScript. If an animation field is outside the mask when the phase
  starts, the whole phase runs in JavaScript (`js_tick_animation`).
* **Shared state.** The kernel keeps nothing in statics across imports;
  nested ticks (a callback that ticks another actor) get their own context.
  An import that throws unwinds past the Rust frames (`tick_actor` keeps the
  actor in the shadow stack), and the host puts back the shadow stack
  pointer. At the top level (no tick in progress and no interpreter run
  active, `vm.depth` 0) no frame of this instance is on the stack, so the
  pointer is the stack's top, read once at attach; nested ticks read the
  global. Reading `WebAssembly.Global.value` per call cost 0.1 ms per Island
  tick (`resume` could use the same shortcut). The trace and x87 kernels are
  other instances with their own stacks.
* **JavaScript refactors** (behavior unchanged): `selectAnimNotify` and
  `named` are exported from `animation-tick.mjs`; `processActorAnimation`
  uses `animationTick`, `animationFunction` and `animationEvent`, which the
  imports share.

Exactness hazards met:

* The namedHandle cache is per class and filled by whichever instance
  resolves first; the mask follows it (above).
* A blend element write is `arrayReference(...).set`: the whole float array
  is read and written back, so the other elements pass through getFloat32
  and setFloat32, which quiets a signaling NaN. Rust rewrites them quieted.
* Loads quiet signaling NaNs explicitly, since LLVM folds a float32 widening
  with a later narrowing (the mutation pass shows a copied sNaN otherwise);
  binary operations take the first NaN operand (`nan_first`).
* `Math.trunc` of the timer's period count is emulated; a NaN count is
  `!== 0`, as in JavaScript.
* `remainder`'s operand order matters: `(end - stop) * rem / (end - start)`
  and `(end - stop) / (end - start) * rem` round to different float32 values
  for inputs a search found (validator case family `tween remainder`).
* The blend passes run only while the main sequence is active.
* The simulated-pawn test is kept, though Role is 4 there on this route.
* ACTOR_TICK_DIFFERENTIAL's replay must take FindFunction and isA as they
  answered during the tick (the state and the release can change after it):
  the first mutation pass was void because its baseline failed on that, and
  the harness now requires a passing baseline.

**ACTOR_TICK_DIFFERENTIAL=1** records every callback with the actor's fields
(`readNamed` of the 42 fields and the SimAnim planes) before and after it,
and every read of state outside the actor. After each tick Rust completes,
the JavaScript body runs again on a virtual copy of the fields, with those
callbacks and reads served from the record: its callbacks must be Rust's, in
order and with the same arguments, its fields must equal the real ones
before each callback and at the end, and its result must be Rust's. A
hand-back must come before any callback and leave the fields as they were.
`ACTOR_TICK_STATS=1` prints the kernel's counters.

Verification:

* `scripts/validate-actor-tick-kernel.mjs` boots a map with
  `SCRIPT_VM=rust`, plays 40 ticks under the differential, then runs cases
  on real actors of every ticked class twice from the same state (through
  the kernel, then the JavaScript body) with scripted services. The cases set
  stasis thresholds (±1 ulp around 5 s, 1200 and the zone clock), timers
  crossing their rate, LifeSpan at 0.0001, NaN payloads, signaling NaNs,
  signed zeros, infinities, AnimRate NaN, 0 and negative (velocity-scaled),
  tweens, notifies, loops and blends; owners ticked, unticked, not attached,
  released and dangling; fields bound or poisoned before or during the tick;
  callbacks that write fields, release the actor, install a DemoRecDriver or
  throw. Results, errors, callbacks with bit-exact arguments, the deferred
  list, every image byte, the reference array and the shadow stack pointer
  must be identical. Training: 14,299 cases on 181 actors of 140 classes;
  Island: 28,914 cases on 366 actors of 224 classes. The JavaScript paths
  ran 6,290 reads, 162 writes, 31 statements and 911 animation phases on
  Island. It joins the validator sweep (about 20 s, one map boot).
* A mutation pass broke `tick.rs` 123 ways
  (`.work/logs/actortick/mutate.mjs`, which first requires the unmutated
  build to pass); 117 fail the validator. The pass ran before the
  constructed cases existed; they are appended after the seeded cases and
  consume no random numbers, so the validator only grew, and the 14
  survivors were run again with them (4 more fail). The six survivors are
  equivalent:
  * the `live()` checks on the owner and weapon handles, which the imports
    repeat (`identityOfHandle` is null, so JavaScript reads None);
  * the PlayerPawn hand-back in Rust, which the host makes first;
  * `less` against `<` on a negative SightCounter: for NaN both write NaN
    and the next store overwrites it before any callback;
  * the explicit quiet on loads, where no reachable path copies a loaded NaN
    to a store without arithmetic;
  * `nan_first` on add, where the current code generation keeps the operand
    order.
* Digests are unchanged at all 30 checkpoints under both VMs with
  `SCRIPT_VM_CHECK=1`, errors `{}`: Training `c8eebff5786adf55` and Island
  `b767a7e417fe5968`.
* Under `ACTOR_TICK_DIFFERENTIAL=1`, Island replayed 279,620 ticks and
  compared 718,237 field states (Training 89,071 and 227,899), with no
  mismatch and the same digest. The kernel handed back only the player's 360
  ticks; no field was read or written through JavaScript. Under
  `PERCEPTION_DIFFERENTIAL=1` the counts are R3-c's (118,954 alliance and
  8,847 AICanSee calls), with no difference.
* `validate-script-vm-interp`, `-x87`, `validate-trace-kernel`,
  `validate-collision-kernel`, `validate-perception-kernel`,
  `validate-object-image` and `validate-object-handles` (also under
  `SCRIPT_VM=rust` and on Island) pass. So do the native oracles
  actor-tick (37 cases), animation-tick (38), animation-controls (37) and
  level-tick (31), and `validate-script-cleanup`, `validate-get-anim-group`,
  `validate-native-finish-anim`, `validate-window-scroll-cleanup`,
  `validate-window-timer-diff`, `validate-mission-timer` (both VMs) and
  `validate-gm-trench-play-anim` (`SCRIPT_VM=rust`).
* `validate-world-destroy`, `validate-loadmap-gc`, `validate-island-jump-reach`
  and `validate-training-ladder` pass under `SCRIPT_VM=rust`; the first two
  also under the JavaScript VM. `validate-loadmap-gc` under
  `SCRIPT_VM=rust` keeps 2,729 handles; old space grew 0.88 MiB over 19
  resets.
* The 566 unit tests pass.
* A 240-frame Chromium Island walk under `?scriptVm=rust` had no page or
  runtime error.

Cost: the median `SCRIPT_VM=rust` Island tick over four interleaved pairs
(HEAD 3e8d78b against this change) on a loaded machine (load average about
6):

| Pair | Before (ms) | After (ms) | CPU before | CPU after |
|---|---|---|---|---|
| 1 | 16.49 | 14.36 | 22.06 | 19.15 |
| 2 | 18.73 | 14.86 | 25.03 | 19.55 |
| 3 | 15.96 | 14.16 | 21.21 | 18.80 |
| 4 | 20.34 | 15.33 | 29.87 | 19.79 |

The tick was lower in all four pairs; in the two quietest (1 and 3) by about
1.9 ms. In a `--cpu-prof` window of 300 Island ticks (after: a build with Wasm
names):

| ms per profiled tick | Before | After |
|---|---|---|
| Level tick outside script, physics and services | 3.79 | 1.24 |
| of it the actor body and animation (JavaScript, or `tick_actor`, the host and its imports) | 3.06 | 0.68 |
| `readNamed` cluster inside that body | 1.92 | 0.13 |
| `readNamed` cluster (all callers) | 6.52 | 4.14 |

`tick_actor` itself is 0.1 ms per tick (about 130 ns per actor), `run` 0.06.
The rest of the actor share is the imports: IsProbing, the owner's bTicked,
the notify selection and the zone clock.

Left in JavaScript, and why:

* **The level loop, DistanceFromPlayer and the compaction scan** (about
  0.27, 0.18 and 0.07 ms per tick after this step). A Rust pass needs the
  Level.Actors list with each entry's mask; rebuilt when the base epoch moves
  (0.6 times per tick on Island, 2,600 entries), it would save about 0.3 ms.
* **PlayerPawn ticks**: one per tick; their input and view-target branches
  call the viewport and the input system.
* **The callbacks themselves** and the reads with host state (IsProbing's
  probe mask, the zone clock, the notify's mesh, the latent action), and
  the SimAnim plane writes (structs).
* **Under `SCRIPT_VM=js`**, which has no interpreter instance.

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
