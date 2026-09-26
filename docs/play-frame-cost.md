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
   offsets. Stage 1a is below.
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

## Reproduce

```sh
npm run dev   # or reuse the running server on 5173
node scripts/profile-play-browser.mjs --walk --alloc --counts --tag mine
```

Frame intervals depend on the display cadence; compare A/B runs on one machine,
alternating builds. Play skips `game.tick` while `document.hidden`, so an
interactive check needs a visible tab; the script's own Chromium page is visible.
