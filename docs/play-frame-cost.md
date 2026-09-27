# Play frame cost from first principles

This September 26, 2026 investigation (commit `5978bf3`) measures real Play in
the Training map, where the user reported an average of about 34 fps with
occasional drops. It replaces the earlier headless CPU numbers in
[play performance](play-performance.md) and [the mesh kernel](lodmesh-wasm.md)
as the current account of where a frame goes. Everything here is host
measurement. No finding in this note is original-game behavior, and no change
it motivated alters an original behavior contract.

## Method

`node scripts/profile-play-browser.mjs --walk --alloc --counts` drives
Chromium with `--use-angle=metal` (Apple M2 Pro Metal renderer) at 1440×960.
It targets the running dev server, waits for the HUD, clicks into Play, holds
W and records 300 animation frames. The CPU profile is bucketed by the direct
callees of `animate()` in `src/viewer/main.mjs`; samples outside it keep their
top frame, such as `(garbage collector)` or `(program)` (browser-native work,
WebGL command encoding and compositing included). Allocation sampling counts
objects later collected by minor and major GC. The counts phase wraps
`ScriptRuntime` methods after the timed phase. Raw profiles go to
`.cache/perf/`, outside Git.

`scripts/benchmark-play.mjs` no longer measures what the player sees. It builds
a game without Play's startup, Login and presentation path and reports 6.2 ms
simulation and 0.6 ms mesh posing per frame, where real Play spends 12.4 ms and
6.8 ms. Use the browser profile for decisions.

## Baseline frame

Median of three walking runs at `5978bf3`:

| Per frame | Cost |
| --- | ---: |
| Frame interval | 29.7 ms mean (≈34 fps); 221 of 300 frames miss vsync |
| `game.tick` (simulation) | 12.4 ms |
| NPC mesh posing and upload | 6.8 ms |
| HUD window tree (Extension/GC natives) | 4.8 ms |
| three.js submit, ~600 draw calls | 2.4 ms |
| Garbage collector | 1.9 ms average |
| Allocation | 22 MB per frame |
| Retained heap after forced GC | 326 MB, stable (no leak) |

The drops are GC and presentation stalls. One captured 92 ms frame was 88 ms
of garbage collector. Another 150 ms gap was main-thread idle, waiting on the
GPU/compositor side; that stall is not yet attributed.

## Work versus cost per unit

A frame's cost is its units of work multiplied by the cost of each unit. The
counts below were taken standing and walking at the Training start:

| Unit of work per frame | Count | Our cost per unit | Native cost, order of magnitude |
| --- | ---: | ---: | ---: |
| Host reads/writes of script properties by name | ~5,400 (`namedReference`) | ~1 µs plus ~1 KB garbage | a struct member load |
| VM property references | ~1,600 | same path | same |
| Map-actor default rebuilds (`defaultValue`) | ~3,000 | full default copy | none: copied once by InitProperties |
| Line checks (`singleLineCheck`) | 647 | ~5 µs | well under 1 µs |
| UnrealScript function executions | ~340 | ~4 µs | well under 1 µs |
| Natives invoked | ~270 | | |
| Posed mesh vertices (30 GetFrame kernel calls) | 10,420 | ~220 ns in Wasm, plus ~3.5 ms of JavaScript around the kernel | a few ns |

The line-check count is original behavior. The DeusEx walking-surface scanner
`103ccc40` ([walking](walking.md)) fires four directions by nine heights plus
a floor trace for every walking-pawn physics step, 37 traces per step. The
workload is faithful and small. The per-unit costs are one to three orders of
magnitude above native. The native column is an order of magnitude, not a
measurement of the original.

## Why the units are expensive

**The object model allocates on every access.** A script property lived in
`instance.slots` or a host binding. Each access lowercased the name and walked
the class chain (`lookupMember`), then rebuilt a descriptor (`describe`, with
object spreads). It then allocated a reference with two closures, a state
object with four more, and a `defineProperty`, and copied the value. An
unwritten map-actor property rebuilt its default on every read. Host code
(pawn physics, animation, actor tick, mesh preview) made most of these
accesses by name, so the lookup was repeated thousands of times per frame. The
original reads `*(T*)(Object + Offset)`, with defaults copied once by
`UObject::InitProperties` ([object properties](script-object-properties.md)).

**x87 arithmetic uses BigInt on hot paths.** Every trace computes its
collision-hash X cells through BigInt 64-bit rounding
(`collision-hash.mjs expandedXCell`), and the VM's float natives use the same
BigInt model. These are exact, but each intermediate is a heap allocation.

**The retained heap is millions of small objects.** Of about 290 MB sampled,
lighting arrays hold 62 MB, decoded bytecode trees 31 MB and linker, load-graph
and metadata records about 75 MB. Each major GC marks all of them, which is
why an ordinary collection costs close to 90 ms.

**Presentation repeats per-frame CPU work.** NPC normals and bounding volumes
are recomputed on the CPU every frame (~1 ms). The HUD walks the emulated
window tree (3–5 ms). The sky pass re-renders the scene from the sky camera.

## Direction

The costs are representation, not work, so the order is:

1. **Object memory** ([contract and plan](object-memory.md)). Value access
   without references, then original-layout storage at the recovered UProperty
   offsets. Stages 1a to 1d are below.
2. **Exact x87 fast paths.** A single `+ − × ÷ √` on float32 operands stored to
   float32 is identical with 53- and 64-bit intermediates: double rounding is
   innocuous when the intermediate precision is at least twice the target's
   plus two. Chained 80-bit sequences can use f64 only where an error-free
   transformation proves the result exact, and fall back to BigInt otherwise.
   The argument needs the recorded control word 0x037f (nearest-even, 64-bit
   significand; [collision hash](collision-hash.md)). The existing BigInt code
   is the reference for differential tests, and the native oracle cases stay
   authoritative ([actor physics](actor-physics.md)).
3. **Allocation-free traces.** No per-query `Set`, closures or arrays. Target:
   the 647 traces under 0.5 ms.
4. **A smaller retained heap.** Typed storage for lighting and bytecode, so
   major GCs stay short.
5. **Presentation.** Normals, bounds, the sky pass and the HUD tree.

**Status: stopped after stage 1d (`74e37a3`).** Walking Training went from
29.7 ms per frame (about 34 fps) to 17.3 ms (about 58 fps; the machine's speed
varies between A/B rounds, so these come from different rounds). That meets the
project's current goal of basic playability. Stage 1e, steps 2 to 5 and the VM
rvalue path are deferred. Resume one only when a measurement shows a
playability problem it addresses, and start with a fresh profile.

WebAssembly follows the data. Porting the VM or the natives now would add
marshaling on every native call, because actor state lives in JavaScript
objects. Once objects live in one `ArrayBuffer`, that buffer can be a
`WebAssembly.Memory`, and a measured hot kernel (traces, walking, GetFrame) can
move to Rust without copying, like [the mesh kernel](lodmesh-wasm.md).

## Stage 1a: value access without references

Changes, all host representation:

* `ScriptRuntime.lookupMember` memoizes each prepared node's resolution per
  table and spelling, misses included. The class loader fills member tables
  and base chains before a class is returned, and nothing mutates them later.
* `describe` caches descriptors per metadata and key. It rebuilds if the
  linker later rewrites `arrayDim`, `elementSize`, `structKey`,
  `structFields` or `innerMetadata`, the slots filled by `ScriptRuntime.field`,
  the class loader and struct layout. Normalized struct members are cached per
  `structFields` array.
* References are one `PropertyReference` object. Its `get`/`set` stay own
  functions because callers pass them on detached, and its backing state is a
  private field. Get/set order and returned copies are unchanged.
* `readField`/`writeField` and `readNamed`/`writeNamed` return exactly what
  `fieldReference(...).get()/.set()` returned, including default
  materialization and binding precedence, without allocating an lvalue.
  Literal `namedReference(...).get()/.set()` sites in `src/` use them. Pawn
  physics, the animation views, actor tick and the mesh preview go through
  value services. An in-range blend element read indexes the copied whole
  value; anything else keeps `arrayReference`'s clamp and warning.
* A map actor's unwritten property keeps its initial value in `record.store`
  on first read, as InitProperties does once at construction. Resets already
  clear the store.

Rejected alternative: caching one reference per (instance, field) removed the
per-access allocation but kept ~23,000 references alive in headless startup
alone. Real Play retained 45 MB more, which lengthens every major GC. Memoizing
`describe` and `lookupMember` alone moved the tick by 0.3 ms, because the cost
moved into reference construction.

Paired A/B, alternating HEAD (a worktree on port 5199) with the working tree
(port 5173), three walking runs each, medians:

| Per frame | `5978bf3` | Stage 1a |
| --- | ---: | ---: |
| Frame interval | 29.7 ms (≈34 fps) | 21.6 ms (≈46 fps) |
| Frames missing vsync (of 300) | 221 | 90 |
| Sampled main-thread CPU | 35.8 ms | 24.7 ms |
| `game.tick` | 12.4 ms | 8.8 ms |
| Mesh update | 6.8 ms | 5.3 ms |
| HUD | 4.8 ms | 3.9 ms |
| Garbage collector | 1.94 ms | 0.68 ms |
| Allocation | 22.1 MB | 14.8 MB |
| Retained heap | 327 MB | 326 MB |
| `namedReference` / `fieldReference` / `defaultValue` calls | 5,391 / 7,033 / 3,019 | 274 / 1,821 / 1 |

Nothing measured here establishes original fidelity. The changes keep every
read, write, default and error path of the previous implementation. The
existing suites show no behavior change:

* All 541 unit tests pass.
* The full sweep (`npm run validate -- --jobs 4`) passed 393 of 397. Every
  failure was checked against `5978bf3`:
  * The Stage 3 Training gate is red by design. Its output is identical to
    HEAD for all 90 probes; it now takes 145 s instead of 203 s and peaks at
    1,760 MiB instead of 2,187 MiB.
  * `validate-npc-mesh-preview` fails with the same assertion on HEAD.
  * `validate-player-tick-order` was killed at the runner's per-validator
    memory cap. Standalone it passes on both trees with identical output and
    the same cost (about 225 s, 2.9 GB peak).
  * `validate-animation-controls` failed because its Unicorn oracle blocked
    with 0.1 s of CPU. Standalone it passes all 37 original cases, which
    exercise the changed animation view.
* The browser suite passed 11 of 17. The six failures are pre-existing:
  Liberty Island's `NativeHeapError`, the instructor conversation, the
  training walk, pointer-lock Escape and the lodmesh fallback's mesh count all
  fail identically on HEAD. The production-build spec runs against a `dist/`
  that predates these changes.

A related finding, not caused by this work: every `createGame` on a shared
`AssetStore` retains about 315 MB after forced GC, on HEAD and here alike
(39 → 403 → 719 → 1,034 → 1,349 MB over four games). Validators that build
many games pay for it in memory.

## Stage 1b: resolved field handles

After stage 1a, Play still made about 5,300 host reads and 260 writes per
frame by name. Pawn physics made about 1,100 of them, NPC mesh admission and
posing about 2,000 (`Mesh` for every level actor), actor tick about 1,000 and
the animation views about 750. In Node, one scalar read cost about 145 ns:
38 ns resolving the name, about 30 ns validating the cached descriptor and
16 ns for an instance lookup that ran twice. The binding lookup and the copy
itself took about 10 ns each.

Changes, all host representation:

* Each class has a table from spelled property name to a handle: the linked
  field, found once through `lookupMember`, and its value codec. Handles for
  a name that does not exist are cached as misses. `readNamed`/`writeNamed`
  look up the instance once and go straight to its class table.
* `propertyCodec` in `script-values.mjs` specializes a property's read, store
  and copy operations once from its descriptor. It is cached with the
  validated descriptor entry, and a linked field record reaches that entry
  through one lookup keyed by the record. A single non-bool scalar reads
  through the same per-type copy that `copyScalar` uses. Arrays and bools, whose
  bit mask is read live, keep the general path.
* A class-table handle keeps its codec without validating it again. A field
  enters a class's member table only after `ScriptRuntime.field` and the class
  loader have written the metadata slots the descriptor depends on. A
  headless Training run (startup plus 900 ticks) checked 3,842 handle codecs
  against the validated descriptor 29,373 times and found none stale.
* The per-tick animation view is built once per attached instance. The tick
  phase writes only through the view's accessors. The blend-starting natives
  keep a fresh view per call, because `startAnimation` can add a plain
  `animFlags` property to a blend object.
* Allocations are gone from four paths:
  * bytecode object operand reads;
  * the level's `DistanceFromPlayer` pass;
  * the `pendingKill` getter;
  * the timer state accessors.

  A map actor's generic binding now does one store lookup where it did two.

Every read, write, default and error path is unchanged. In Node, a scalar
`readNamed` now costs about 55 ns; a vector about 100 ns and an `FName[4]`
about 127 ns, because both copy the whole value.

Paired A/B, alternating `3ed84fe` (a worktree on port 5199) with the working
tree (port 5173), three walking runs each, medians. The machine ran slower in
this round than in stage 1a's (HEAD 23.5 ms against 20.8 ms in an earlier
round), so compare within the table:

| Per frame | `3ed84fe` | Stage 1b |
| --- | ---: | ---: |
| Frame interval | 23.5 ms | 21.2 ms |
| Frames missing vsync (of 300) | 125 | 83 |
| Sampled main-thread CPU | 26.6 ms | 23.9 ms |
| `game.tick` | 9.6 ms | 8.4 ms |
| Mesh update | 5.6 ms | 5.1 ms |
| HUD | 4.2 ms | 3.9 ms |
| Garbage collector | 0.74 ms | 0.55 ms |
| Allocation | 14.6 MB | 14.0 MB |
| Retained heap | 325 MB | 326 MB |
| Object-model self time (mean of runs) | 3.9 ms | 2.3 ms |
| `lookupMember` / `fieldReference` / `namedReference` calls | 6,290 / 1,834 / 288 | 782 / 1,438 / 60 |

Verification: all 541 unit tests pass, and the full sweep passed 395 of 397.
The Stage 3 gate (red by design) gives the same 90 probe outcomes as
`3ed84fe`. `validate-npc-mesh-preview` fails with the same assertion recorded
at `5978bf3` ("unchanged poses do not re-upload geometry").

The largest object-model cost left is the VM's own property access. The VM
evaluates every variable operand to an lvalue, so about 1,440
`fieldReference` calls per frame still build a `PropertyReference`, 0.7 MB per
frame, even where the value is only read. An rvalue path in the VM, or 1d's
image addresses, removes it. The rest of the frame is now dominated by work
outside the object model: line checks and their BigInt x87 arithmetic, GetFrame
and normals, the HUD's native heap and three.js submission.

## Stages 1c and 1d: layout tables and object images

Stage 1c reads each class's property table from the linker and checks it
against the recovered Link bodies and retail offsets. Stage 1d stores
script-owned properties in a byte image per object at those offsets
([object memory](object-memory.md) has the contract, the evidence and what
remains). Before 1d, Training's 1,817 attached objects held 45,801 logical
slot entries and 94,885 bindings. Most actor fields were bindings over a map
of stored values. After 1d:

* 1,816 objects hold images, 620 KB in total. The remaining object's class
  has no linked record.
* One slot entry remains.
* Bindings number 18,975, only the host-owned fields and headers.

Changes, all host representation:

* `script-object-layout.mjs` reads each class's table from the linker's own
  records. `script-object-image.mjs` turns it into cells: one hidden class,
  scalar reads and writes small enough to inline, and composite values in a
  separate path.
* Each class has a default image, copied when an object attaches or is
  constructed. It replaces a default rebuild for every property of every
  spawned object and every first read of a map actor property.
* A map actor writes its authored values over the copy, and resets restore a
  snapshot.
* Instance records are one class. The `pendingKill` accessor that
  `bindNativeObject` defined on each actor record had left all 423 Training
  actor records in dictionary mode, so every record property load was a
  hash lookup. That dated from before 1d.
* VM references over an image cell use a storage object with methods, not
  two closures per reference.
* A record copies its class defaults only when some property lacks an image
  cell. That removes 55,010 retained map entries in Training. This change
  came after the A/B below and is not in its numbers.

In Node, per access on a Training pawn, compared with `be02895`:

| Access | `be02895` | 1c + 1d |
| --- | ---: | ---: |
| Scalar read by name (byte, int, float, name, object, bool) | 50–65 ns | 30–39 ns |
| Scalar write by name | 78–97 ns | 46–58 ns |
| `BlendAnimSequence` (`FName[4]`) read | 135 ns | 61 ns |
| `Region` (PointRegion struct) read | 300 ns | 91 ns |
| VM `fieldReference(...).get()` | 125 ns | 108 ns |

Paired A/B, alternating `be02895` (a worktree on port 5199) with the working
tree (port 5173), three walking runs each, medians. This round ran faster
overall than stage 1b's, where HEAD measured 21.2 ms, so compare within the
table:

| Per frame | `be02895` | Stages 1c + 1d |
| --- | ---: | ---: |
| Frame interval | 18.4 ms | 17.3 ms |
| Frames missing vsync (of 300) | 33 | 13 |
| Sampled main-thread CPU | 20.9 ms | 19.9 ms |
| `game.tick` | 7.27 ms | 6.70 ms |
| Mesh update | 4.71 ms | 4.36 ms |
| HUD | 3.25 ms | 3.24 ms |
| Garbage collector | 0.50 ms | 0.45 ms |
| Allocation | 14.1 MB | 13.9 MB |
| Retained heap | 326 MB | 319 MB |
| Object-model self time (median of runs) | 2.06 ms | 1.83 ms |

Verification:

* Both new validators pass. `validate-object-layout` covers 1,474 classes: the
  placement replay, the struct members, 153 retail offsets and 142 window
  offsets. `validate-object-image` checks defaults, writes, byte placements,
  bool words and the timing of unproducible-value errors for one object of
  every class.
* A headless Training run reads every property of every attached object after
  startup (138,725 reads), after 600 idle and walking ticks, and after a
  Player-start reset plus 300 ticks. It gives identical results on `be02895`
  and here, including 2,643, 2,656 and 7,950 error messages.
* All 541 unit tests pass. The full sweep passed 396 of 399:
  * `validate-script-frame-ownership` assigned `pendingKill` on a fixture
    record, which the first version of the record class refused. Records
    other than actors accept the assignment again, and the validator passes.
  * The Stage 3 gate (red by design) gives output identical to `be02895` for
    all 90 probes, in 106 s instead of 153 s.
  * `validate-npc-mesh-preview` fails with the assertion recorded at
    `5978bf3`.

The VM's per-operand references remain the largest object-model cost: about
1,300 per frame, plus the whole-value copies `copyScalar` makes for each. An
rvalue path in the VM would remove most of them. It is deferred with the rest
of the direction (see [Direction](#direction)).

## Reproduce

```sh
npm run dev   # or reuse the running server on 5173
node scripts/profile-play-browser.mjs --walk --alloc --counts --tag mine
```

Frame intervals depend on the display cadence; compare A/B runs on one machine,
alternating builds. Play skips `game.tick` while `document.hidden`, so an
interactive check needs a visible tab; the script's own Chromium page is visible.
