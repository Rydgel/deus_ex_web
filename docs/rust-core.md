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
    walking-surface scan), and B3 part 1 (walking's numeric kernels, hosted
    for validation and not yet called by Play).
  * R3-c (IsValidEnemy, GetPawnAllianceType, AICanSee).
  * R3-d (the actor tick body and the animation phase).
  * R3-e (SetActorZone's common case).
  * R3-b B4 (the pawn MoveActor body, September 30).
  * 1e-1 to 1e-4: actor flags, the physics mirror fields, Location,
    Rotation, collision size, OldLocation, Base and Touching now live in
    the image.
* **Headless timing.** On UNATCO Island (bench-sim, 300 ticks), the median
  tick is about 13.5 to 14 ms under Rust (interleaved A/B pairs, September
  30) and about 25 ms under JavaScript. `BYPASS_PATCHES` is empty. Island
  Play now runs about 31 s (tick 1872 of the forward-walk workload) before
  its first unimplemented original code, ConSys native 2051
  `CreateConCamera` (Stage 4). The 360-tick bench window does not reach it.
* **Browser timing.** Headless Chromium, Island forward walk, through
  `profile-play-browser`:

  | Engine | Tick | Frame | Rate |
  | --- | --- | --- | --- |
  | Rust | 14–17 ms | 33 ms median | about 30 fps |
  | JavaScript | 26–33 ms | 46–57 ms | about 20 fps |

  The rest of the frame does not depend on the engine: actor meshes about
  10 ms, render about 5, HUD about 3.8, lighting about 1.6. The frame mean
  can read higher than the median: the first NPC bark creates the
  AudioContext, a one-off frame of about 170 ms. 120 fps means 8.3 ms per
  frame, so even a free tick leaves the frame near 20 ms.

  The rAF interval is quantized to the display's vsync (16.7 ms steps at
  60 Hz), so its median stays at 33.3 ms until the whole frame fits under
  16.7 ms. Compare tick gains with `phases.tick` and the headless A/B
  medians, not with the frame interval.
* **After R3-e (September 30, headless profile, ms per Island tick):**
  pawn physics 5.1 (walking 3.4: MoveActor 1.2, the surface prelude 1.1,
  of which 0.64 is the Rust scan itself), Tick events 4.4, state code 1.7,
  rider moves 0.5. The A/B median is about 12.3 ms.
* **What the tick costs (September 30).** Under the actor tick, Rust runs
  about 1.6 ms; the other 12 ms is JavaScript, spread thinly (no function
  above 0.9 ms of self time). Crossings are not the cost: R2b-7 removed
  3,450 of 9,000 Wasm→JavaScript calls per tick and the tick did not change,
  so a bare import costs well under 0.1 µs. What costs is the JavaScript
  behind the imports. Headless profile, Island, ms per tick:
  * Pawn physics about 5.9: walking 4.0, of which MoveActor 2.3 (the rider
    pass 1.3 of it) and the walking-surface prelude 1.1.
  * Tick events about 5.0: interpreter plumbing around JavaScript natives
    and nodes; no native above 0.2.
  * State code about 1.8: resuming state code, and pollPawnLocomotion 0.7.
  * The host object model (readInstanceField, instance, copyScalar,
    readComposite, readNamed and their callees) is about 4.7 of the above,
    spread over many callers.
  * Two costs exist only headless: bench-sim's `--continue` wrapper of
    `invokeNative` (about 0.4) and its render-feedback reads (about 1).
* **The rider moves are original.** About 100 rider MoveActors run per
  Island tick: NPCs carry their initial weapons and ammo with `Base` set to
  themselves (`ScriptedPawn.uc` 594 and 615, `inv.SetBase(Self)`), so every
  NPC move moves them. Each costs about 9.5 µs, mostly SetActorZone (about
  2.6 µs a move, both call sites about 0.65 ms per tick) and the move query
  (about 1.4 µs).
* **Measurement traps.** bench-sim's `--counts` wraps `runtime.invokeNative`
  as an own property, which makes the lowering refuse the Rust perception
  natives. A `SCRIPT_VM_STATS` run with `--counts` therefore shows about 330
  `js value native 2105` per tick that a normal run does not have. Measure
  timing with `.work/tools/ab.sh` (interleaved medians against a HEAD
  worktree), never with instrumented runs.

* **Bound-read census (September 30, Island, 120 ticks, `--bound-reads`).**
  Host bindings served about 500 get/set calls per tick in all: 293 of
  `engine.actor.level`, 61 of `engine.actor.base`, 27 of
  `engine.pawn.viewrotation`, 22 of `engine.decal.surflist`, 19 of
  `engine.actor.binterpolating`, 13 each of the player's Physics and Region,
  and the rest below 10. `boundKeys` holds 325 keys, 293 of them window
  classes. So the 4.7 ms object-model cost is not binding service: it is
  JavaScript reading image cells by name (`readNamed` about 30,000 and
  `instance` about 58,000 per tick), which only moving the reading code to
  Rust removes. Report: `.work/logs/census-bound-reads.json`.
* **JavaScript time behind each import (September 30, Island, 300 ticks,
  `SCRIPT_VM_IMPORT_TIME=1`).** The instrument wraps every import of the
  Rust VM with the real clock (bench-sim publishes it as
  `globalThis.__realNow` before pinning `performance.now`) and reports self
  time, that is with nested imports taken out. The instrumented tick was
  16.9 ms median, of which 15.5 ms self time inside imports over 4,699
  calls per tick, so the JavaScript behind the imports is the tick. Self ms
  per tick, top rows: `js_tick_physics` 5.97 (100 calls, 60 µs each: the
  pawn physics family, R3-b B4–B6), `js_tick_event` 1.97 (382 script events
  dispatched from the tick, 5.1 µs of JavaScript plumbing each before the
  body runs), `js_eval` 1.93 (257 statements the lowering leaves to
  JavaScript, 7.5 µs each), `js_tick_state` 1.31 (702 state-code resumes,
  1.9 µs each), `js_object` 0.86 (164 object-valued JavaScript nodes),
  `js_iterator_next` 0.85 (309 iterator steps), `js_call_begin` 0.59 (849
  calls, 0.7 µs each), `js_step` 0.37, `js_tick_far_move` 0.33, `js_float`
  0.29, `js_bool` 0.23, `js_tick_probing` 0.20; everything else is below
  0.15. Three families therefore hold the tick: pawn physics (about 6 ms),
  event and state dispatch plumbing (about 3.3 ms, `js_tick_event` self plus
  `js_tick_state`), and the JavaScript-valued nodes and natives
  (`js_eval`, `js_object`, `js_float`, `js_bool`: about 3.3 ms). Report:
  `.work/logs/import-time-island.json`. The wrapper itself costs about
  4 ms per tick (two clock reads per call), so its rows rank families; they
  are not A/B savings.
* **Two checks for the 120 fps target (September 30).** Chrome 152 on the
  reference machine's built-in display (120 Hz mode) delivers
  requestAnimationFrame at a median 8.30 ms, so the target is measurable
  in the browser the user plays in. `EXT_disjoint_timer_query_webgl2` is
  present under ANGLE Metal, and `profile-play-browser --gpu` (the viewer's
  `?gpuTimer=1`) measured the Island walk at **1.46 ms of GPU time per
  frame** (300 frames, a result for every frame, no disjoint event) against
  30.6 ms of host work (tick 14.1, actors 9.6, render 3.3, HUD 2.6). The
  frame is CPU-bound on both halves: the presentation cost is preparation
  and submission, not GPU load, so the render-side work is CPU work
  (relighting, poses, HUD tree, draw submission), and moving the vertex
  lighting to the GPU would trade CPU time for a GPU that is idle.

### October 1: where the tick's JavaScript goes

The GPU mesh merge (`d2e493b`) left the tick at about 59 % of the browser
frame (11.35 of 19.3 ms), so the simulation is the larger half again.

**Instrument.** `bench-sim --cpu-profile FILE` records a V8 CPU profile
(`node:inspector`, 100 µs sampling) of the timed ticks only. A whole-run
`node --cpu-prof` also samples the 60 warm-up ticks, whose spawns and
lowering inflate some rows: `js_object` read 1.21 ms per tick over the
whole run and 0.48 over the timed ticks. `.work/tools/prof-imports.mjs FILE
TICKS` attributes each sample under `tickStandaloneLevel` to its innermost
`js_*` import (`[wasm]` marks samples whose leaf is Rust), and
`prof-import-self.mjs FILE TICKS IMPORT [DEPTH]` splits one import's
JavaScript by leaf function or by call path. Unlike `SCRIPT_VM_IMPORT_TIME`,
sampling adds no clock reads per import.

**Island, 300 timed ticks at `d2e493b`** (profiled tick 10.5 ms; JavaScript
behind each import, ms per tick):

| Family | ms | What it is |
|---|---:|---|
| JavaScript-valued nodes | 2.1 | `js_eval` 0.95, `js_object` 0.48, `js_step` 0.23, `js_float` 0.20, `js_bool` 0.14, `js_name` 0.08 |
| Event dispatch | 1.35 | `js_tick_event` 0.95 (2.5 µs per event), `js_call_begin` 0.39 |
| Level loop | 1.16 | outside any import: the Level.Actors loop, DistanceFromPlayer, the cleanup scan |
| Actor physics outside walking | 1.3 | actor falling 0.33, swimming 0.29, flying 0.19, glue 0.25, interpolation 0.06 |
| Locomotion latent polls | 0.74 | `js_tick_state` → `pollLatent` → `pollPawnLocomotion` (`pawnView` 0.17) |
| Iterators | 0.65 | `js_iterator_next` (CycleActors) |
| Walking prelude | 0.52 | JavaScript around the Rust scan (the scan itself 0.55) |
| Moves | 0.55 | riders 0.23, FarMoveActor 0.19, hash 0.12 |

The JavaScript-valued nodes by count (`SCRIPT_VM_STATS`, per tick):
LastRendered 723 167.5, struct member of an instance variable 69.6,
GetPlayerPawn 720 66.8, GetStateName 284 65.1, VirtualFunction effects 52.9,
InStasis 721 41.1, unlowered name variables 40.3, string field lets 36.3,
Context effects 35.2, SetRotation 299 20.0, GlobalFunction 19.8,
SetLocation 267 14.6, Trace 277 14.5.

Order chosen from this: per-handle state words in the arena (needed by
GetStateName, IsInState and any Rust dispatch), then natives 723, 720,
284/281 and 721 in the interpreter, then tick-event dispatch in Rust, then
the locomotion polls, the level loop and CycleActors.

### October 1: state table and small natives (implemented)

**State table.** `script-vm-states.mjs` keeps, per handle, the object's
state as the state queries and probing read it: an entry `[row, probe lo,
probe hi]` in a per-runtime arena table (`STATES = [table, capacity,
verify]`, natives.rs). A row is `[node id, n, name ids]` along the node's
base chain, where the node is `instance.state.stateNode ?? instance.cls`
(the class sentinel `scriptGetStateName` reads) and `n = 0` for an
instance without a ScriptState. Rust reads a filled entry directly and asks
`js_state` for an empty one; `js_state` returns 0 for a handle it does not
describe (released, a class identity, not attached here, a name
`scriptNameToString` rejects), and the native then runs in JavaScript.

* **Invalidation.** `script-state.mjs` reports every state change of an
  identity (`stateChanged`): `setStateNode`, a ProbeMask replacement,
  attachment (`linkInstance`), InitExecution and a restored StateFrame. A
  report clears the handle's entry; a release clears it too. ProbeMask is
  now a frozen array behind an accessor, so Enable/Disable (117/118) replace
  it (`Array.prototype.with`) instead of writing a word in place, and a
  future in-place write throws instead of leaving the table stale.
* **`STATE_VERIFY=1`.** Rust asks `js_state` on every read, and `js_state`
  throws when a filled entry differs from what it computes now. Both maps'
  digests pass with it on.

**Natives (natives.rs).** Each kind transcribes its `invokeNative` case and
is lowered with the perception gate (the runtime's own invokeNative, not a
boundary native), with no arguments; a value the body would not compute with
hands the whole node to JavaScript.

* GetStateName (284) as `STATE_NAME 203 node`: the row's first name id, or
  None.
* LastRendered (723) as `LAST_RENDERED 204 node, offset, key`: the f32
  LastRenderTime in the image, the level clock from `js_level_clock` (mode
  0: `soundField('TimeSeconds')`), then `clock - last`, 0 when negative or
  NaN, else `Math.fround`.
* InStasis (721) as `IN_STASIS 205`: `actorInStasis` over five image cells,
  `js_level_clock` mode 1 (`levelFor(actor).timeSeconds`, a number),
  `js_zone_render_time` only where the body reads it, and
  `js_level_standalone`. On Island every caller's receiver is a BOUND map
  actor and `engine.actor.physics` is a bound key (the player binds it), so
  it still runs in JavaScript there; it needs the per-object bound-field rule
  (step 6 below).
* IsInState (281, 6.7 per tick) stays in JavaScript: it compares with
  `scriptCaps`, which folds ASCII only, while name ids fold with
  `toLowerCase`, so the two can differ on non-ASCII spellings.
* GetPlayerPawn (720) stays in JavaScript: its body is the trigger host's
  viewport walk (`resolveNativeGetPlayerPawn`), reached through the host
  `native` chain, and a shortcut needs that chain's ownership of 720 made
  explicit first.

**Verification.** `validate-script-vm-interp` covers the three kinds (153
kinds, 595,430 checks): GetStateName against rows, an empty entry, a table
that grows inside `js_state`, `STATE_VERIFY`, the JavaScript path and the
CK_NAME check; LastRendered over 13 clocks × 12 float32 patterns on SELF and
a context receiver; InStasis against `actorInStasis` itself over 2,000
field and level combinations, including where the zone time is read. Nine
mutants of natives.rs were all caught. Digests match at all 30 checkpoints
on both maps and both engines with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1`. On
Island, `SCRIPT_VM_STATS` no longer shows JavaScript values for 723
(167.5 per tick) or 284 (65.1). The interleaved A/B (4 pairs) is within
noise: medians 10.17 ms before and 10.25 ms after on a loaded machine. The
expected saving, about 0.2 ms, is below what these runs resolve. Browser
(Island walk, 300 frames): tick 10.95 ms, frame 18.67 ms, no runtime error.

### October 1: tick events in Rust (implemented)

Actor.Tick's events (Tick, Timer, Expired, UpdateEyeHeight, PainTimer,
SpeechTimer, UpdateTactics; tick.rs `event`) now run processEvent in Rust
(dispatch.rs) when the event's function has a Rust lowering. Before, each of
Island's 382 events per tick crossed to JavaScript, ran processEvent and
`executeScript`, and entered Rust again for the body. processEvent's steps,
in order, and where each runs now:

1. `scriptability()` and the Level gate: `js_event_gate`, which runs the
   runtime's `scriptability()` and `eventLevelGate` (the gate processEvent
   now calls too, so both paths share one body). These stay in JavaScript:
   `windowLifecycle` is reassigned in several places and Actor.Level is a
   host binding.
2. Probing: the state table entry. A row with names means a ScriptState,
   whose probe words decide; an event name outside the probe range always
   passes, as `isProbing` does.
3. `lookup(receiver, name)` and the function checks: an event cache keyed
   by (class row, state row, event), filled by `js_event_resolve` with one of
   three decisions. **JavaScript:** anything processEvent throws on (no
   function, the native-hook flag, a result, a parameter count other than
   the event's), a singular function, a function without a call signature
   or a Rust lowering, a receiver that is not an Actor. **No call:** a
   native function, for which processEvent returns false. **Run:** code,
   frame size, the float parameter's offset and a run template. The lookup
   depends only on the class and the state node, so the row pair is the
   key. The cache's epoch advances when a lowering is replaced, when
   operands are relinked (`ScriptObjects.operandEpoch` is now an accessor
   with listeners) and when the field registry changes
   (`onFieldImageCellVersion`).
4. `pendingKill`: bDeleteMe in the receiver's image at its registered cell,
   or JavaScript when the image cannot be read there.
5. The frame and body: a zeroed block from the shared FMemStack, the
   parameter stored by the float codec, and the body as a callee run with
   its own hang budget, as an R2b-3 call runs. The stack, the run count and
   the budget are restored afterwards.

**The body's JavaScript Run.** An import inside the body asks for its run's
`Run` (nodes, frame object). Rust records each run it begins in `RUNS[id] =
[template, SELF handle, locals, serial]`, and `RustScriptVm.run(id)` builds
the Run from that record on first use. A run JavaScript begins clears the
record's serial (`own`), so a stale record is never used. Every import now
looks its run up through `run(id)` instead of indexing `frames`.

**Per tick.** `tick_actor` takes the events word as an argument, sets it
for its tick and puts the previous one back, and records the frame stack,
hang budget and events word it found; when an import throws through the
tick the host calls `tick_unwind(ctx)`, which restores them (up to 32
nested tick contexts). The first version did both in JavaScript per actor
through DataView accessors, about 0.12 ms per Island tick.

**Runaway count.** `js_event_gate` hands JavaScript's runaway count to
RUNAWAY before the body, and `js_tick_refresh` hands it back after (the
interpreter's imports keep the two in step in between), so a body's jumps
count on the same GRunaway as before.

**When it is off.** `RUST_EVENTS=0`; the actor tick's differential log
(`ACTOR_TICK_DIFFERENTIAL`, which records events as callbacks); services
whose processEvent is not the runtime's own (`runtimeEvents`); a runtime
whose `processEvent`, `executeScript`, `eventLevelGate` or `lookup` is not
the function script-runtime.mjs defined (`ScriptRuntime.originalMethods`,
captured when the module loads), so a wrapper on the prototype, as
validate-loadmap-gc and training-probe-lib install, or on the runtime keeps
every event in JavaScript; and the JavaScript VM. (The first version tested
only own properties, which missed prototype wrappers, with `Object.hasOwn`
on every actor tick, 0.12 ms per Island tick.) `DISPATCH_VERIFY=1` resolves
every dispatch again and throws when a filled slot differs.

**Verification.** `validate-script-vm-interp` drives `vm_dispatch_event`
with a mock host: the enable word and gate results, probe bits in both
words and the out-of-range names, a state without names, undescribed
state entries and class rows, the three decisions, a body's parameter
(including -0, NaN and a value that rounds to infinity), its RUNS record,
run id, budget and zeroed block, the restored stack, count and budget, the
cache (one resolve per key, a new epoch, event or state row, verify),
pendingKill on HOST and bound receivers, and the RUNS limit. All 14
applied mutants of dispatch.rs were caught. Digests match at all 30
checkpoints on both maps and both engines with `SCRIPT_VM_CHECK=1
STATE_VERIFY=1 DISPATCH_VERIFY=1`. On Island `js_tick_event` no longer
runs; per tick there are 382 `js_event_gate` calls (about 0.45 µs each),
382 `js_tick_refresh` calls and 17.5 resolves, which follow operand
relinking during play. Interleaved A/B against `225f788`, 4 pairs: medians
10.08, 9.86, 10.18, 10.05 ms before and 9.93, 9.82, 9.76, 9.75 after, about
0.25 ms per tick. Browser (Island walk): tick 10.78 ms, frame 18.70 ms, no
runtime error.

### October 1: script calls through the cache (implemented)

A CALL's begin (`beginCall`: runtime.invoke's resolution and callFunction's
checks, then the callee's frame) now comes from a second cache in
dispatch.rs, keyed by (caller code, call node, receiver class row,
receiver state row). The resolution is the call's operand (final) or
`lookup(receiver, name)` (virtual), which depends only on the receiver's
class and state node; the checks depend on the function and the site.
`js_call_resolve` fills a slot with beginCall's decision, the JavaScript
path or a Rust run (code, frame size, run template). A hit pushes the
zeroed block, writes the RUNS record and raises the run count with no
import; `js_call_begin` remains the path for everything else. Island went
from 848 `js_call_begin` calls per tick to 19.5, with about 1.2 resolves
per tick.

**Invalidation, refined for both caches.**
* Replacing a lowering no longer advances the epoch. `retire` clears the
  slots that run the old code, and the call slots keyed by it as the
  caller, because its address can be reused once released.
* The field registry advances the epoch only when a key's cell is
  withdrawn (two classes disagree; `onFieldImageCellWithdrawn`). A key that
  gains a cell leaves every decision valid: a lowering made without it
  reads that field in JavaScript, which is exact.
* Operand relinking and boundary-function changes still advance it.
  `runtime.boundaryFunctions` is now a Map subclass with listeners, since
  hosts add and remove boundaries during play.

Before this, the epoch advanced about once every three Island ticks (100
times in 300: 34 registry additions, 66 replaced lowerings).

**Sets.** Both caches are 4-way set-associative, with a MurmurHash3
finalizer over the key words and round-robin replacement. The first,
direct-mapped version took the low bits of multiplicative products over
aligned addresses: 50 event keys were resolved 6,956 times in 300 ticks,
and three Tick keys shared one 2-way set. Now 16 event keys resolve 16
times and 335 call keys 353 times.

**Verification.** `validate-script-vm-interp` covers `begin_call`: a hit
(result, run id, RUNS record, run count, zeroed block, the argument, the
restored stack, resolve before the push), resolves after another class,
another state row, a new epoch or a cleared slot, none for the same key,
verify, four keys in one 4-way set, set bounds against a canary past the
table, and the JavaScript path for the JavaScript, empty and unknown
decisions, the cache off, an undescribed receiver or state and the RUNS
limit. All 10 applied mutants of `begin_call` and its interp.rs caller
were caught. Digests match at all 30 checkpoints on both maps and both
engines with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1`.
Interleaved A/B against `02a096b`, 4 pairs: medians 9.53, 9.68, 9.65,
9.72 ms before and 8.94, 9.01, 9.25, 9.33 after, about 0.5 ms per tick (the
event cache's hash fix included). Browser (Island walk): tick 10.18 ms,
frame 18.03 ms, no runtime error. `RUST_CALLS=0` keeps every begin in
JavaScript.

The full sweep at `02a096b` (before this step) passed 443 of 444; the one
failure, `validate-player-tick-order`, crossed the runner's 6 GiB cap with
four jobs running and passes alone (3.7 GB peak).

**Bug found by the next sweep (fixed October 1).** The sweep at `3b48b0e`
failed `validate-training-cadet` and the Training conformance gate: the
cadet's carcass, dropped on the medical table, no longer fired Trigger0.
`vm.run(id)` built a cached callee's JavaScript Run with a null result
field, where `beginCall` passes `fn.result`. A callee whose Return runs in
JavaScript (`js_step`) then returned undefined: Trigger.IsRelevant's
`return ClassIsChildOf(Other.Class, ClassProximityType)` read as false.
The Run now takes the template's `resultField`. Neither the digests nor
`SCRIPT_VM_CHECK`/`DISPATCH_VERIFY` reached it (the values Rust read and
the decisions were right; the return marshalling was not). Bisected with
`RUST_CALLS=0` and by excluding callees from the cache.

### October 1: per-object binding sets (implemented)

Step 6 of the plan below. A BOUND receiver's field reads used to take the
JavaScript path for every key any object binds (the global bound-key
table). On Island this sent each NPC's `HeadRegion.Zone` (57 reads per
tick), InStasis's Physics (41) and AICanSee's BaseEyeHeight (24) to
JavaScript, because the controlled player and moving brushes bind those
keys. Census of September 30 missed HeadRegion: it is read as a struct
member, which `SCRIPT_VM_STATS` filed under `0x36 [of 0x1]`.

* **Binding sets.** The receiver table entry is now `[info, epoch, binding
  set, 0]` (16 bytes). A binding set is `[length, bytes...]`, one byte per
  field key id, set for each key the object binds, shared by every object
  with the same keys (`RustScriptVm.bindingSet`), and 0 when the host gives
  none (the global table then decides, as before). `js_receiver` also
  writes the set to `RECEIVER_BIND` for a handle the table does not cover.
  Bindings only grow, and each addition advances the receiver epoch, so a
  set cached under the current epoch is the object's set.
* **Mirrored bindings stay out.** A binding made through `mirroredBinding`
  (Level, LevelInfo.NetMode) keeps the binding's value in the image cell
  and was never a bound key; the first version put them in the sets, which
  sent 189 Level and 296 NetMode reads per tick to JavaScript. The mirrored
  wrapper is now marked (`mirrored: true`) and left out.
* **Rust.** `Recv` carries `bind` with `info`, SELF's set is fetched with
  its info (`self_info`), `field_addr(info, bind, key, offset)` tests the
  receiver's own set (`bound_key`), and percep.rs's objects carry theirs.
  The level-actor scan's objects (`describe_known`) keep the global table.

**Verification.** `validate-script-vm-interp`: sets on SELF and a context
receiver (own key, a globally bound key the set lacks, keys beyond the
set's length, an empty set, no set) and SELF's set refreshed after an
import; 4 mutants caught. Digests match at all 30 checkpoints on both maps
and engines with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1
RECEIVER_VERIFY=1` (which compares each cached set with a fresh one).
`validate-perception-kernel`, `-actor-tick-kernel`, `-walk-loop-kernel`
and `-pawn-perception` pass. On Island the JavaScript values for
`HeadRegion.Zone`, InStasis and AICanSee's BaseEyeHeight are gone (`0x36
[of 0x1]` 69.6 → 8.0 per tick, native 721 41.1 → 0). The A/B could not
resolve the change: other work on the machine (load average 5 to 7) spread
paired medians by ±3.5 ms.

### October 1: Sleep in LatentFloat, the frame word (implemented)

The plan was to stop the 650 `js_tick_state` crossings per Island tick
whose ProcessState has no code to run. A CPU profile of 300 Island ticks
priced them first: `process`, `instance` and the refresh under them are
about 0.07 ms per tick together. The other ~1 ms under `js_tick_state` is
the latent polls: `pawnView` alone is 0.23 ms self, because each
MoveToward/MoveTo/TurnTo poll defines 29 accessors over `namedReference`,
and the locomotion bodies run the BigInt x87 model. So the skip went in
as the plumbing the Rust polls need, not as a speed step.

* **Sleep stores Actor.LatentFloat (fidelity fix, its own commit).**
  execSleep and PollSleep address `AActor+0xe0`, which the SDK layout names
  `LatentFloat` ([Sleep](script-sleep.md)). The runtime kept the value in a
  `ScriptInstance` member, so the property never changed. Sleep's remaining
  time is now in the image, where a Rust poll can read it. Digests changed
  at checkpoint 0 on both maps; with `BENCH_DIGEST_SKIP=LatentFloat` all 30
  checkpoints equal the commit before.
* **The frame word.** The state table entry is now `[row, probe lo, probe
  hi, frame]` (16 bytes). The frame word is what `ScriptState.process`
  would do first: `FRAME_NONE` (no execution or a null cursor: return),
  `FRAME_UNSET` (LatentAction never written: throw), `FRAME_NO_STATE`
  (no ScriptState: processState throws), else the LatentAction (0: run
  state code). `ScriptState.latent` is an accessor, and a state frame's
  `cursor` is one too (beside its existing `latent` accessor). A changed
  LatentAction, a cursor moving between null and an offset, or a new
  execution reports `onFrameChange`, which rewrites the word of a filled
  entry in place (`StateTable.frame`) without clearing the row.
* **The skip.** EVENTS[3] (the tick word) is now a bit set: bit 1, events
  dispatch in Rust as before; bit 2, `script_and_timer` skips
  `js_tick_state` when the frame word is `FRAME_NONE`. The host sets bit 2
  for the runtime's own tick services (`runtimeEvents`) with
  `ScriptState.prototype.process` unwrapped, never under the differential
  log; `RUST_STATE=0` keeps every call.

**Verification.** Digests match at all 30 checkpoints on both maps and
engines with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1`; under
`STATE_VERIFY` every read recomputes the entry and compares the frame word,
so a missed report fails at the next tick. `validate-script-vm-interp`
passes (the state bit alone leaves event dispatch off). Island:
`js_tick_state` 702 → 52 crossings per tick, `js_state` 0. Not timed: the
machine's load average was 7.

### October 1: latent polls in Rust (implemented)

`process_state` (tick.rs) reads the frame word and polls Sleep (384) and
the pawn locomotion latent actions (MoveTo 501, MoveToward 503, StrafeTo
505, StrafeFacing 507, TurnTo 509, TurnToward 511, WaitForLanding 528) in
Rust. StrafeTo and StrafeFacing joined on October 1 with their JavaScript
bodies (same hand-backs; Training 3,000 and Island 4,000 kernel cases
identical, about 150 to 270 of each completing in Rust). A poll that keeps its latent
action needs no crossing; one that clears it crosses to `js_tick_resume`,
which writes LatentAction 0 and calls ProcessState, so the state code runs
in the same ProcessState call as before (the JavaScript `process` skips the
poll when LatentAction is 0). A poll Rust does not take crosses to
`js_tick_state` as before.

* **Sleep** (tick.rs `poll_sleep`): pollActorSleep on tick field 42,
  LatentFloat, with the tick's image-or-JavaScript field access.
* **Locomotion** (loco.rs, host `script-vm-locomotion.mjs`): the five
  polls with turnSetup980 and steerArrive200, transcribed from
  `script-pawn-locomotion.mjs` on the x87 model (`Ext`, plus `load_f64`,
  `compare` and `recip` in x87.rs) and percep.rs's vectorToRotator
  (`js_atan2`). Fields are read the way perception reads them: L_FIELDS
  gives each field's offset, mask and key id; a third word after a class
  row's perception words says which spellings the class resolves to those
  keys and cells (`js_loco_class`, computed once per class); the receiver
  info and binding set exclude HOST objects and bound keys. Pawn and
  Inventory tests use the row's folded names, as `locomotionServices.isA`
  compares names.
* **Hand-backs, decided from reads before any write:** a field outside the
  image; a float that is not finite or not below 2^60 in magnitude (the
  JavaScript model throws where an intermediate becomes infinite); a facing
  direction that is not; PHYS_Falling and PHYS_Spider; the
  bAdvancedTactics walking branch (its AlterDestination event); an
  Inventory MoveTarget close enough to fire Touch; MoveToward with a Pawn
  target (its zone read); WaitForLanding's LongFall.
* **Gate.** Bit 4 of the tick word, with the state bit, when
  pollPawnLocomotion, pawnView, locomotionServices, latentFloat, readNamed
  and writeNamed are the runtime's own (`ScriptRuntime.originalMethods`).
  `RUST_POLLS=0` keeps every poll in JavaScript.

**Census** (Island, 360 ticks, per tick, all polls in JavaScript):
MoveToward walking to a non-Pawn target 20.24, MoveTo walking 2.73,
MoveTo/TurnTo swimming while gliding (fish) 3.24, WaitForLanding falling
0.92, TurnTo walking 0.30, the bAdvancedTactics branch 0.28. Gliding was
added the same day: glideAcceleration over percep.rs's `fcoords_axes` in
the TurnTo/TurnToward polls, and steerArrive's glide branches (no zeroing
on arrival, the X axis as direction, no deceleration, 1 past the brake
check); 8 of 8 glide mutants caught. Island `js_tick_state` is then 2
crossings per tick.

**Verification.** New `validate-locomotion-kernel`: on real pawns, cases
aimed at every compare (arrival at horizontal 16 and the height bound,
Touch at CollisionRadius and CollisionHeight with exact equality, the
facing cone's edges, deceleration at speed 100, braking at
AvgPhysicsTime·speed·1.4, the melee bound, NaN payloads, infinities, huge
values) run the Rust poll and the JavaScript poll from the same images;
a hand-back must have written nothing, a completed poll must leave every
image byte of the pawn and its targets as JavaScript does, with the same
latent outcome and no JavaScript event. Training 3,000 and Island 4,000
cases identical. Mutation pass: 22 of 25 mutants caught; the three
survivors cannot change behavior (the restore of an unchanged Destination,
and two that only move a case between Rust and the hand-back: Touch at
exact equality, the tactics gate, whose lookup no shipped class resolves).
Digests match at all 30 checkpoints on both maps and engines with
`SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1`;
`validate-actor-tick-kernel`, `-script-vm-interp` and `-x87` pass. Island:
`js_tick_state` 52 → 6 crossings per tick, `js_tick_resume` 1.

**Timing.** Interleaved A/B against `df5b74a` on Island, 4 pairs (load
average about 5): medians 9.70, 10.15, 10.89, 11.07 ms before and 8.81,
9.70, 9.57, 9.53 after, faster in every pair, about 0.5 to 1.5 ms. Browser
(Island walk, CPU sampling on, loaded machine): tick 10.88 ms, frame
19.47 ms, no runtime error; not comparable with earlier sessions.

### October 3: the tick's IsProbing from the state table (implemented)

[Play CPU plan](play-cpu-plan.md) step 1.5. The Actor.Tick body asks
`IsProbing('Tick')` before the Tick event and `IsProbing('EnemyNotVisible')`
before CheckEnemyVisible; tick.rs crossed to `js_tick_probing` for each, about
700 times per Island tick. With the new tick word bit `TICK_PROBE_BIT` (8),
`probing` reads the state table entry instead, as script-runtime.mjs
`isProbing` decides: an instance without a ScriptState (a row with no names)
probes every name; one with a state probes a name whose index is outside the
64 probe bits or whose ProbeMask bit is set. The probe indices of the two
names come from probe-names.mjs (`tick_probe_names_ptr`). The bit requires
the events bit and an unwrapped `runtime.isProbing` and
`ScriptState.prototype.isProbing`; `RUST_PROBES=0` keeps the import. A
handle the table does not describe still crosses.

Under `STATE_VERIFY=1` Rust also asks JavaScript and stops the tick on a
different answer (`js_tick_error` code 2); inverting the bit test makes the
first Island tick fail. Digests match at all 30 checkpoints on both maps and
engines with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1` (references
at `b3b16f8`: Island `fcd924498a0882c8`, Training `44267cb4460ab7b3`).
`validate-actor-tick-kernel` (its differential runs with the events word 0,
so it keeps the import), `validate-actor-tick` and
`validate-locomotion-kernel` pass. Island `js_tick_probing` crossings over 180
ticks: 126,751 → 0. Timing (Linux host, bench-sim, 8 interleaved pairs):
median pair delta −0.24 ms, inside this machine's ±1.9 ms pair noise.

### October 3: walking and flying pawns' performPhysics in Rust (B6a, B6b, implemented)

The first part of B6. The walk loop (B5) and the pawn MoveActor (B4) already
ran in Rust, but every walking pawn still reached them through the tick's
`js_tick_physics` callback: ScriptRuntime.processActorPhysics, a fresh
`pawnPhysicsServices` object, runScriptPawnPhysics, the view's `walking`,
WalkLoopHost.walk, and after the loop physicsRotation, MoveTimer,
AvgPhysicsTime and the PendingTouch read, each field through `readNamed`.
On Island that was about 0.63 ms of JavaScript per browser frame around the
loop, for about 50 walking pawns per tick.

`pawn_phys.rs` runs APawn::performPhysics for Physics = PHYS_Walking from
tick.rs, in the reference's order: the walk loop, the physicsRotation gate
(not PHYS_Spider; Rotation differs from DesiredRotation or RotationRate.Roll
is positive), physicsRotation itself (bFixedRotationDir cleared and
bRotateToDesired set in the +0x1ec word; Yaw and Pitch stepped by
`fixToward` with `Math.trunc` of the double products; the Pitch clamp;
`move_pawn` with a zero delta and the new rotation when it changed), then
`MoveTimer = f(MoveTimer - dt)` and AvgPhysicsTime through `phys_avg_time`.
Its host (`pawn-physics-kernel.mjs`) admits a non-player Pawn when the
callback would reach runScriptPawnPhysics unchanged (the runtime's own
processActorPhysics, no tick differential log), the walk loop host would run
the loop in Rust, and DesiredRotation, RotationRate, AvgPhysicsTime,
PendingTouch and the two motion bools are image cells `readNamed` uses
(PHYS_FIELDS), the bools bits 0x20 and 0x40 of one word and the actor's
`motionFlags` that image word. It pushes the walk contexts as WalkLoopHost.walk
does. Where Rust hands a step back, an import runs the reference's own code:
the `walking` body (`js_pawn_walk`), the rotation's MoveActor
(`js_pawn_rotate`), and the body's rest from a stage (`js_pawn_tail`:
`pawnPhysicsTail`, now split out of runScriptPawnPhysics). A PendingTouch
target runs its PostTouch tail there too. After the walk and after the
rotation's move, Rust reads the pawn's receiver info again; when its image
changed hands, the rest of the body runs in JavaScript from that point. An
import that throws pops the contexts in the tick kernel's unwind.

B6b, in the same change: Physics = PHYS_Flying (Island's GeneratorScouts,
about 12 per tick) runs `fly.rs`, physFlying and calcVelocity's
accelerating path transcribed from flying.mjs on `Ext` (the x87 model
validate-script-vm-x87 compares with script-vm.mjs's), with walk.rs's
`step_up` and `two_wall_adjust` and the walk loop's image pawn for the
moves and HitWall. A non-PlayerPawn in a standalone level never reaches
calcVelocity's walking clamp or network boundary. AirSpeed, DesiredSpeed
and Region.ZoneNumber joined PHYS_FIELDS and ZoneFluidFriction the walk
table's zone fields; the reference's two boundaries (a nonpositive
timestep, a colliding pawn in zone 0) run the JavaScript body
(`js_pawn_fly`), which raises them.

`PAWN_PHYSICS=js` (`?pawnPhysics=js`) keeps the callback;
`PAWN_PHYSICS_STATS=1` prints the admissions, hand-backs and Rust's branch
counts. Digests match at all 30 checkpoints on both maps and engines
(Island `fcd924498a0882c8`, Training `44267cb4460ab7b3`; 22,649 and 5,524
calls, no declines, no hand-backs). The maps alone fly without hitting
anything, so `validate-pawn-physics-kernel` runs both maps with
scripts/scenarios/fly-branches.mjs (every map pawn flies into walls,
floors, ceilings and corners while DesiredRotation turns) and
walk-branches.mjs, Rust against `PAWN_PHYSICS=js`: equal digests at every
checkpoint, and on Island alone 18,810 flights with 1,427 blocked moves,
582 stepUps, 845 HitWall slides, 138 TwoWallAdjusts and 10,306 rotation
moves. Never reached: the PostTouch tail and every JavaScript hand-back
(the walk loop handing back, a flight boundary, a rotation move handed
back, a changed image). Timing (Linux host, bench-sim, three interleaved
pairs against `PAWN_PHYSICS=js`, walking only): median tick 14.07 →
13.46 ms. In the browser (Island at Player start, three interleaved pairs
against 80a0384): tick 12.91 → 12.25 ms, no errors. The validator groups
pawn-physics-kernel, walk, flying, pawn, island-falling, island-swimming,
actor-tick and training-ladder pass.

### October 3: a falling non-Pawn's performPhysics in Rust (B6c, implemented)

Island's breakable crates sit in WaterZone1 in PHYS_Falling: every tick each
one integrates through the water branch, slides along a wall (HitWall, no
probe) and, when it reaches the floor, takes processLanded's bBounceVelocity
branch, so it never settles. A census of the JavaScript path put them at
168 µs a call, 4 calls a tick, 0.67 ms of a headless tick: the
field-backed host `runSpawnedActorFalling` builds for every call (about 15
accessors over `readNamed`), the integration on script-vm.mjs's x87 model,
and `playerMove` with its moveQuery and CheckEncroachment.

`fall.rs` runs AActor::performPhysics for Physics = PHYS_Falling from
tick.rs for any non-Pawn: falling.mjs's body with `nonPawn` (the water,
bBobbing and dry integrations and their apex copies on `Ext`, the apex
subdivision, the per-substep ZoneVelocity, the bBounce branch with its
refund and counter, the floor landing's velocity, the HitWall slide,
TwoWallAdjust and its ditch test, the end-of-substep velocity with the
terminal clamp), then performActorPhysics's tail. MoveActor is B4's body,
`move_source` (move_pawn.rs), which for a non-Pawn source adds playerMove's
CheckEncroachment test after the rider pass (`js_move_encroach`; a
rejection returns the query unmoved). The imports are the reference's own
functions: processDecorationHitWall, the bBounce HitWall event, the host's
`landed` (decorationLanded or actorLanded, with zoneBounceLanding), the zone
reads for a zone without an image, `playerMove` where the Rust MoveActor
hands back, and `actorPhysicsTail` (split out of performActorPhysics) when
RotationRate or PendingTouch is set. Its host (`actor-physics-kernel.mjs`)
admits the actor when the callback would reach the services the Play host
linked (`linkedActorPhysics`, set beside `runtime.actorPhysics` in
script-doors.mjs), the actor is a map move host (through `mapMoveLevel`, as
the reference) or a spawned collision view, and every MOVE_FIELDS and
FALL_FIELDS spelling (Decoration's bBobbing for a Decoration) is an unbound
image cell. Region.ZoneNumber 0 (FellOutOfWorld) and a static or immovable
source stay the reference's.

The reference had a gap, fixed in the same change: the non-Pawn host had no
`oldLocation`, so `pawn.oldLocation = origin` landed on the adapter object
and the actor's OldLocation was never written. physFalling stores it at
every substep for every source (0x103d0ee2-0x103d0f01, `Location` +0x114 to
`OldLocation` +0x12c, no Pawn test; disassembled for this change). Island's
digest changes with it on both paths.

`ACTOR_PHYSICS=js` (`?actorPhysics=js`) keeps the callback;
`ACTOR_PHYSICS_STATS=1` prints the declines and Rust's branch counts.
bench-sim gained `--dt` (seconds a tick; the default keeps the clock's
arithmetic), because the apex subdivision needs a substep above 0.03 s.
`validate-actor-physics-kernel` runs Island as played and both maps with
scripts/scenarios/fall-branches.mjs (every movable Decoration and Inventory
launched into PHYS_Falling each phase: rising, fast, bouncing, bobbing,
spinning), once at 20 ticks a second, Rust against `ACTOR_PHYSICS=js`.
Digests equal at every checkpoint on every run; on Island as played all
2,062 calls run in Rust (1,616 water substeps, 963 HitWall slides, 173
landings) with no decline, and the scenario runs add bobbing, bounces,
two-wall adjustments, the terminal clamp, the tail and, at 20 Hz, the apex
subdivision. Only Region.ZoneNumber 0 declines. Never reached: a
destroyed source (bDeleteMe after the move), a MoveActor handed back, a
zone without an image, and the image check after an event. Timing (Linux
host): bench-sim, three interleaved pairs against `ACTOR_PHYSICS=js`,
median tick 13.22 → 12.84 ms; browser (Island at
Player start, six interleaved pairs against 510aefe) tick 12.41 → 11.82 ms,
total 27.9 → 27.0 ms, no errors. The validator groups actor-physics-kernel,
falling, landing, crate, decoration, plant, rolling, encroach, native-move,
native-player-move, projectile, rider-move, pawn-move, pawn-physics-kernel,
actor-tick, script-spawn, inventory-spawn, island-swimming, island-blowitup,
island-tracer and native-actor-physics pass.

### October 3: a swimming pawn's performPhysics in Rust (B6d, implemented)

Island's swimmers are its GeneratorScouts and the fish their generators
spawn: about six PHYS_Swimming pawns a tick. Their performPhysics went
through the physics callback to swimming.mjs `physSwimming` over the pawn
view (about 0.5 ms of a headless tick).

`swim.rs` runs physSwimming, Swim and findWaterLine on the pawn's image,
transcribed from swimming.mjs on the `Ext` model, and pawn_phys.rs now
admits Physics = PHYS_Swimming beside walking and flying (tick.rs), with the
same rotation and timer tail. The pieces it shares:
* calcVelocity is fly.rs's, which gained the buoyant term (0x103cdf33:
  Velocity += f(ZoneGravity*dt) * f(1 - Buoyancy/Mass)), read after the
  surface prelude's script as the reference reads it;
* stepUp and TwoWallAdjust are walk.rs's, MoveActor `move_pawn` through the
  walk loop's `ImagePawn`;
* the surface prelude, HitWall, setPhysics and the physFalling tail are the
  walk imports; the physFlying tail is `js_swim_fly`.

bWaterZone is read on the zone actor's image (ZoneInfo's bool, a new row of
the pawn table): Region.Zone for `regionWater`, HeadRegion.Zone (a new row,
HeadRegion's Zone member) for `headWater`, and zone.rs `point_region`'s zone
at each findWaterLine midpoint. A zone without an image, or a level without
the zone model, asks the view (`js_swim_water`). findWaterLine's
non-convergence raises the reference's own error (`waterLineBoundary`,
exported from swimming.mjs); its endpoint test compares floats, as the
reference's `===`. A nonpositive timestep stays the callback's. The pawn
table gained WaterSpeed, Buoyancy and HeadRegion (eligibility as before) and
the bWaterZone row; PP_COUNTS gained physSwimming's branches.

`validate-pawn-physics-kernel` adds Island with
scripts/scenarios/swim-branches.mjs: every swimming pawn, rescanned each
phase (the fish are spawned), is driven along turning headings through its
Velocity with DesiredSpeed 1, made buoyant every third phase and given a
current every fourth. Digests equal at every checkpoint, no decline. The
Rust counts reach the blocked move, stepUp, the HitWall slide, the current,
the head-out damping, Swim's exit with findWaterLine and its air time, the
kept Velocity.Z, the exit into PHYS_Falling and its falling tail. Never
reached: TwoWallAdjust after a slide, the slow-rise Velocity.Z, the
physFlying tail and a zone without an image. Island as played: 1,827
swimming calls in 330 ticks, all in Rust. The validators now run each
Rust/JavaScript pair concurrently. `validate-island-swimming` counted the
view's `swimming` calls; it now also counts the host's admissions of a
PHYS_Swimming pawn, which the Rust path takes instead. Timing (Linux host,
three interleaved pairs against c5499df): bench-sim median tick 13.03 →
12.50 ms, same digest; browser (Island at Player start, where few fish
have spawned yet) tick 12.02 → 11.88 ms, total 27.33 → 26.98 ms, no errors.
The validator groups pawn-physics-kernel, swimming (native-swimming,
pawn-swimming-reach, island-swimming), flying, walking, walk-loop,
walk-kernel, pawn-move, actor-tick, falling, zone, pawn-locomotion and
pawn-nav pass.

### October 21: classic UMesh in the mesh kernel (implemented)

The page now opens on DX.dx ([boot](boot.md)), so the five classic `UMesh` meshes (the boot logos and the Fly,
[classic UMesh](umesh.md)) draw on every load, through a JavaScript-only binding that merged the same day. Measured
first (the worker's `framePhases`, per-section timers in the binding, a Node run of the actor mesh layer; the
tables are in umesh.md "Where the time went"): the merge's 9 ms was the Node run that lights all five actors an update;
in the page, one logo in view cost 0.75 to 1.4 ms of the sim worker's frame. The split was DrawMesh's per-face work 61 %
(a script-runtime texture read **per triangle** 8 %, the environment reflection 8 %, `Light` 5 %), the packing of the
colours and environment UVs 21 %, the camera-space publication 11 %, SetupForActor 5 %; `GetFrame` and the record clone
(0.02 to 0.04 ms) were not the cost.

What moved, following the LodMesh kernel (a bulk Rust call over typed scratch, the control flow in JavaScript, the
JavaScript body kept as the reference and the fallback):

* `GetFrame`'s vertex loops and the camera publication run in the LodMesh kernel's `pose` (`services.kernel` in
  `umesh-frame.mjs`; the Fly's tween and blends included). `validate-umesh-frame` (each call through the
  JavaScript translation and through the kernel): the unchanged original in the oracle, 79 calls, every output byte and
  cache byte equal.
* `DrawMesh`'s classic body, `Light` (the LodMesh kernel's `light_vertex`) and the packing of per-corner colours and
  environment UVs are one call, `umesh_draw` (`native/lodmesh-kernel/src/umesh.rs`; the topology uploads once per mesh,
  the JavaScript side is `umesh-wasm.mjs`). `validate-umesh-wasm` compares it with the JavaScript translation, which is
  compared with the original (`validate-umesh-draw`): 666 calls (the 22 oracle cases at three light counts, 600 seeded
  random ones), 11.3 million words, all equal; `UMESH=verify` runs both inside Play (`validate-umesh-play`).
* Stays in JavaScript: SetupForActor (its light choice is already `meshlight.rs`), the texture and environment-map
  reads (once per call, in a table by `TextureIndex`), the coordinate matrix, GetFrame's cache control flow and the
  record. `?meshBackend=javascript` (or `UMESH=js`) selects the reference for all of it.

Interleaved A/B against the merge (`fbf4930`, 7 pairs, the default page, medians of per-second samples, ms per drawn
frame): the worker's `actors` phase 1.52 → 0.72 (Eidos in view), 1.79 → 0.70 (Ion Storm), 1.93 → 1.30 (the end pose and
the menu); the worker's total 4.37 → 3.29, 4.23 → 3.06, 4.94 → 4.10. Node, five lit per update: 4.2 to 4.6 → 1.0 to
1.1 ms. The classic bindings' own time is left at 0.43 to 0.55 ms per frame.

No GPU path: the classic faces differ from the LodMesh passes in the face epsilon (a double), the cull and outcode
planes, the order of the vertex sums, Fatness and a correctly rounded square root in the environment reflection that the
GPU arithmetic does not have; it could be made exact, and would save 0.1 to 0.2 ms of a 3 to 4 ms worker frame on the
boot screens ([umesh.md "GPU path"](umesh.md#gpu-path-decided-2026-10-21)).

### October 22: a brush's world box in the trace kernel (implemented)

Measured first ([rotating-brushes](rotating-brushes.md), "Cost"): the three spinning AC fans of `09_NYC_ShipFan` cost 1.0 to 1.4 ms of the tick in JavaScript, 41 % of it in
`brushCollisionBounds` (the BigInt x87 emulation of the eight corners over `brushToWorld`), once per fan per tick for the encroachment query. Nothing else in the installed game turns a brush every tick.

* `native/script-vm/src/bounds.rs`: `ABrush::ToWorld` (float32 stores, binary64 sums as `coords.mjs` computes them, the Core sine table uploaded from `rotationSineTable`) and the eight-corner expression on `Ext`
  (64-bit significand, one float32 store). One call per box: 25 doubles in, six out; a case the JavaScript throws on or rounds twice on goes back to it. The host side is the trace kernel instance
  (`trace-kernel.mjs brushBounds`); `brush-bounds.mjs brushCollisionBounds` calls it once the kernel is loaded and keeps the JavaScript body as `brushCollisionBoundsReference`.
  `TRACE_KERNEL=js` / `BRUSH_BOUNDS=js` keep the reference, `TRACE_DIFFERENTIAL=1` compares every answer.
* Verified: `validate-brush-bounds-kernel` (18,634 answered cases equal by `Object.is`, real brushes and seeded random records; 9,520 reference throws all handed back), against the original with the kernel
  answering (`validate-native-bounds` 377 cases, `validate-native-encroachment` 308 cases, the 72-case fan chain), `TRACE_DIFFERENTIAL=1` through live Play (mover frob, BlowItUp, the push scenes).
* Interleaved A/B (six process pairs, medians of 400-tick blocks, the fans on): 1.36 ms per tick in JavaScript, 1.10 ms with the kernel, -0.26 ms.
* Left: the encroachment query's per-candidate brush `PointCheck` (a JavaScript callback from the Rust hash) and `moveTranslatingMover`'s push services, about 0.25 ms for three fans.

### November 5: ULevel::Tick's actor loop in Rust (implemented)

Measured first: a Gecko profile of Firefox's inline Island frame (docs/play-frame-cost.md "Row 7.2.2 headed") put about 8% of
the frame in the JavaScript each of the 780 actors a tick passed before Rust's tick (processLevelTick's `tickActor`,
`aroundActorTick`, two `withLifecycle` pass-throughs, `processActorTick`, `run`'s instance lookup, gates, `describe` and argument
writes), about 1.8 µs an actor there.

* `native/script-vm/src/level_loop.rs` ticks a run of Level.Actors with tick.rs `tick_actor`, from a per-slot descriptor
  (`run`'s image base, masks and flags, valid under the receiver epoch and the tick table's version) beside the kernel's copy
  of the array; the host chain runs for the actors JavaScript ticks, and after a run the host links its deferred actors and
  collects what it spawned (docs/script-level-tick.md "The actor loop in Rust"). `LEVEL_LOOP=js|verify`, `?levelLoop=`.
* Verified: `bench-sim` digests equal across js, Rust and verify on six maps; `validate-level-tick`, `validate-actor-tick-kernel`;
  `?levelLoop=verify` for 40 s on the Island (both browsers) and Battery Park (Chromium).
* Interleaved A/B, three 40 s scan runs per arm on the Island, headless, with another session's validators loading the
  machine (absolute times are high): Firefox inline page frame 22.16 → 21.36 ms (tick 10.97 → 10.25), Chrome worker frame
  10.65 → 10.38 ms (tick 6.38 → 6.08). 98.3% of the kernel's ticks now run inside Rust runs.
* Left in the tick, by a profile of the new loop: `AllActors` (native 304) testing `isA` in JavaScript for every actor of the
  level (rare, about 0.7 ms a call in Node, so it lands in single frames), the tick's event gate (`js_event_gate`, which reads
  Level and bBegunPlay in JavaScript), the zone render time (`js_tick_zone_time`) and reflected field reads.

### Next steps, in recommended order

The order changed on September 30, after the crossing calibration, the
rider census and the bound-read census. Judge each step by A/B tick medians,
not by crossings removed. The target is the whole browser frame (AGENTS.md:
8.3 ms), so simulation steps and presentation steps interleave.

0. **Two instruments before the next port: done (September 30).**
   `SCRIPT_VM_IMPORT_TIME=1` (bench-sim `importTimes`) attributes the
   JavaScript behind each import; `profile-play-browser --gpu` reads the
   frame's GPU time through `EXT_disjoint_timer_query_webgl2`
   (`phases.gpu`). Their results are under "Where it stands". The
   attribution sets the simulation order below: pawn physics (about 6 ms),
   then event and state dispatch plumbing (about 3.3 ms), then the
   JavaScript-valued nodes and natives (about 3.3 ms), then iterators
   (about 0.85 ms).

1. **LastRendered (723) and InStasis (721): deferred.** All the small
   natives still in JavaScript (these two, GetStateName, GetPlayerPawn and
   the like) cost at most about 0.3 ms per tick together, bench-sim's
   wrapper included. LastRendered needs the level clock, which Play keeps
   in a closure that the Player start resets directly, so a Rust copy would
   have to be scoped to the actor tick. Not worth it yet.
2. **The SetActorZone family: done (R3-e).** The common case runs in Rust
   on the runtime's arena, with its own copy of the zone BSP; calls that
   change a zone keep the JavaScript body and its events. About 0.6 ms.
3. **Event and state dispatch in Rust (after B4–B6).** `js_tick_event`
   spends 5.1 µs of JavaScript per script event before the body runs, and
   `js_tick_state` 1.9 µs per state-code resume: together about 3.3 ms per
   Island tick of plumbing (`host.callback` → `services.dispatch` →
   `runtime.invoke` → frame setup → the interpreter's run entry). The
   interpreter already resolves final and virtual calls (R2b-3); a Rust
   ProcessEvent for an event whose function the class row resolves, and a
   Rust state resume, would keep those 1,084 calls per tick inside the
   module. The JavaScript dispatch stays the reference and the path for
   events the row cannot resolve.
3b. **CycleActors in Rust.** The iterator workload on Island is almost all
   CycleActors (1002) from ScriptedPawn: `CycleActors(Class'Pawn',
   candidate, CycleIndex)` in its enemy check (`ScriptedPawn.uc` 1875) and
   `CycleActors(Class'DeusExCarcass', body, BodyIndex)` in its carcass
   check (2032). Per Island tick: about 37 iterators, 340 steps and 10,600
   class tests over Level.Actors (Terrorists 8,400, ThugMale2 1,500); the
   scan costs about 0.4 ms in JavaScript, where each class test is an
   instance lookup and cached class-membership lookup (`classIsA` already
   caches the fixed ancestry result). AllActors, RadiusActors and
   VisibleActors are negligible there. The out variables are one shape: a
   local actor and an int field of SELF. The design question: a foreach's
   Iterator statement runs in JavaScript and nested loops share one
   iterator stack, so a Rust CycleActors needs Rust-owned entries on that
   stack. Its class test is then a class-table row lookup, and Level.Actors
   comes from the perception host's list.
4. **R3-b B4–B7: MoveActor, walking and falling in Rust.** B3's numeric
   kernels are done (below). MoveActor's own body is cheap; its cost is in
   SetActorZone, the move query, the hash updates and the rider moves, which
   are the families to port. Keep separate Wasm instances with one import
   per query: imports are cheap (R2b-7). B4 starts with 1e-4: a map actor's
   Base and Touching become image cells (the 1e-2/1e-3 pattern), so the
   IsBasedOn walks and the Touching slots are image loads and `boundKeys`
   loses both keys. The plan:
   * **B4: done (September 30, "R3-b B4" below).** MoveActor for pawn
     views runs in Rust on the pawn's image; the query, the candidate
     tests, riders, touches, bumps, the hash and the zone update are the
     reference's functions behind one import each. The
     [noncolliding spawned rider slice](rider-move-kernel.md) already ran
     against the image. **B4b: done (September 30, "R3-b B4b" below).**
     The rider pass's cost was its scan cache's global invalidation, not
     the pass: the invalidation is per mover now and the scans are gone;
     the pass stays in JavaScript over the rider kernel.
   * **B5: done (September 30, "R3-b B5" below).** The dry walking loop
     runs in Rust on the pawn's image over B3's kernels and calls B4's
     MoveActor directly; Island's median tick 13.13 → 11.66 ms. Falling
     and swimming return as tail calls.
   * **B6.** Falling, landing, rotation and the pawn tail. B6a to B6d
     are done (October 3, above): a walking, swimming or flying pawn's
     performPhysics, physicsRotation and tail, and a falling non-Pawn's
     performPhysics, run in Rust. A pawn's physFalling is only map-start
     settling on Island. Measured next (October 3 profile, per tick): the
     surface prelude (`js_walk_prelude`, about 1.35 ms of JavaScript and
     0.7 ms in the collision instance), the per-actor JavaScript around
     `tick_actor` (about 776 calls a tick, 0.6–0.8 ms: a level loop in Rust),
     and the collision instance's JavaScript host (about 1.35 ms, with the
     candidate callbacks), which merging it into the interpreter's instance
     would remove.
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
5. **1e-4 to 1e-7.** Move the rest of the host fields into the image. Only
   1e-4 is a prerequisite for the steps above: B4's IsBasedOn walks and
   Touching slots must be image loads. 1e-5 and 1e-6 are needed by B7 and
   the mover paths, not by NPC movement. The September 30 census below shows
   that host bindings serve few reads; what costs is the JavaScript that
   reads image cells through `readNamed`, which each B stage removes for its
   family.
   * **1e-4, Base and Touching.** `decorate`
     creates a host `touching` array lazily (`??=`), and whether it exists
     gates `isMapMoveHost`. The spawned actor's stale script copy is now
     corrected separately in `125e401` (see "Touching comparison" below).
     Bound map/player arrays still need migration to the image, preserving
     their already-live script view and the admission predicate.
   * **1e-5, movers.** The interpolation object becomes a view of the image,
     with all 8 KeyPos and KeyRot. The binding keeps only 2 of the 8 today.
   * **1e-6, the player.** Player becomes a controller over the image; this
     removes the Login rebinding. It also covers the view fields, Regions
     and the controlled player's Physics, the last bound step-2 key.
   * **1e-7, cleanup.** Plain image cells for Level and NetMode.
6. **A per-object bound-field rule in the interpreter: low priority.** R3-d's tick kernel
   masks bound fields per object. The interpreter still hands a bound key to
   JavaScript on every object that has any binding, so NPC reads such as
   BaseEyeHeight still go to JavaScript. The focused September 30 census
   below finds too few such accesses to justify another per-object table
   before the larger physics and presentation costs.
7. **Natives called from scripts that still run in JavaScript:**
   SetLocation/FarMoveActor, AttachDecal and ScriptSpawn. Profile first.
8. **The level loop, DistanceFromPlayer and compaction.** They need a
   Level.Actors list cached on the base epoch. The net gain is about 0.3 ms.
9. **The render side (work alongside simulation).** Actor meshes, render, HUD and lighting
   are about 20 ms of the browser frame, so 120 fps is out of reach until
   they improve. The [September 30 profile and priorities](play-frame-cost.md#september-30-the-120-fps-budget-after-the-rust-port)
   quantify the remaining kernel cost and submissions. HUD batching is
   verified; original visibility and resource/batch fragmentation are the
   next larger renderer opportunities.
10. **Moving the simulation off the render thread.** This could overlap
   simulation and presentation: ideally the frame
   would cost the larger of tick and render, plus handoff overhead, instead
   of their sum. Both still exceed 8.33 ms today. It needs a contract for render
   feedback (LastRenderTime is an input the original reads from the
   previous frame) and on `SharedArrayBuffer`, which needs COOP/COEP headers
   on the dev server and the host.

### Touching comparison (September 30)

`.work/tools/touching-compare.mjs` (a bench-sim preload) compared, after
every level tick, each actor's host `touching` array (the slots
`actor-touch.mjs` writes) with the Touching slots in its image and with what
script reads. Both maps, 360 ticks each:

| | Training | Island |
|---|---|---|
| Actor-ticks with a host array | 156,580 | 935,124 |
| Image differs from the host, bound map actors | 491 | 1,749 |
| Image differs from the host, spawned actors | 559 | 122 |
| Script read differs from the host | 222 (spawned) | 22 (spawned) |

* **Bound map actors.** makeBinding's `touching` entry serves script
  reads from the host array, so script sees the live slots and only the
  image is stale. 1e-4 can install image slots that adopt the host values,
  as 1e-3 did for Location.
* **Spawned actors: a divergence to decide.** `installActorCollisionView`
  gives a spawned actor a host-only `touching` array
  (`script-actor-collision.mjs`), while its script field, and so the
  DestroyActor scan (`script-destroy.mjs` `touchSlot`), reads the image,
  which never changes. The script-visible cases were Island's Fish12 and
  Fish16 touching each other (11 ticks) and Training's UNATCOTroopCarcass0
  touching UNATCOTroop2 (222 ticks); script reads and a Destroy of those
  actors see empty slots where the original holds the other actor. Making
  the spawned actor's slots the image's is a fidelity fix: it may change
  the digests, and it belongs in its own commit with the first differing
  checkpoint explained.

**Corrected September 30:** spawned collision views now read and write the
same four slots as scripts. The focused original-DLL checks, DestroyActor
integration, and both-map comparison are recorded in
[spawned Touching](script-spawn-touching.md). Script/host mismatches are zero
on both maps. Island checkpoint 230 changes only the two fish's Touching
fields; Training's dead-troop reference is now cleared during DestroyActor,
so its script digest stays unchanged. Bound map/player image mirrors remain
the separate representation step above.

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
  * The references at this commit are Training `44267cb4460ab7b3` and
    Island `fcd924498a0882c8` (JavaScript and Rust agree). They were
    Training `bc332ff7595aae8a` and Island `42e0401534a54b3a` until the
    player took its measured global index from the map's capture (October 2,
    [galaxy audio](galaxy-audio.md#play)): the DataLink speech
    `playingSoundId` is now the original channel id (41639·16 + slot on
    Training) instead of the host registry slot's; with that one assignment
    disabled, all 30 checkpoints of both maps equal the earlier references.
    They were Training `7d5804dd8ad9a9d4` and
    Island `d99a97de6f21893f` until every mover's native interpolation
    fields were seeded from its own storage (October 1, [doors](doors.md#play-wiring)):
    OldPos and OldRot now read the serialized values rather than Location
    and Rotation, and KeyRot/KeyPos past slot 0 the authored keys rather than
    zeros (Island's DeusExMover7 KeyRot[1]). With
    `BENCH_DIGEST_SKIP=OldPos,OldRot,KeyRot,KeyPos` all 30 checkpoints of
    both maps equal the commit before it. They were Training `1725cf61fe25d423` and
    Island `604901ddf66b4614` until IsAnimating (282) stopped inverting its
    tween branch (October 1, [animation
    controls](script-animation-controls.md#isanimating)): NPCs that land at
    startup while tweening into their idle now skip Pawn.Landed's
    `PlayLanded`, which sets `bIsWalking` (16 landings in Training, 45 on
    Island; the final states differ only in `bIsWalking`, on 14 and 19
    pawns). Before that they were Training `f217d0b162ab0189` and
    Island `3f390b4c79796dd7` until the live registry gained DeusEx.u's
    package record before Login (October 1, [conversation
    camera](conversation-camera.md)): the player's host registry slot, and with
    it `DataLinkPlay0.playingSoundId` (a channel id from that slot), moved by
    one; with `BENCH_DIGEST_SKIP=playingSoundId` all 30 checkpoints of both
    maps equal the commit before it. Before that they were Training `c8eebff5786adf55` and
    Island `b767a7e417fe5968` until Sleep's remaining time moved into
    `Actor.LatentFloat` (October 1, [Sleep](script-sleep.md)); with
    `BENCH_DIGEST_SKIP=LatentFloat` all 30 checkpoints of both maps equal
    the commit before it.
  * A representation step must not change them.
  * A fidelity fix may change them, but only with the first differing
    checkpoint explained, and as its own commit.
* **Differential modes.** Each Rust family has a mode that compares every
  call against the JavaScript path: `HASH_DIFFERENTIAL`,
  `TRACE_DIFFERENTIAL`, `RAY_DIFFERENTIAL`, `PERCEPTION_DIFFERENTIAL`,
  `ACTOR_TICK_DIFFERENTIAL`, `ZONE_DIFFERENTIAL` and `RECEIVER_VERIFY`
  (each `=1`). The JavaScript paths stay behind
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
  BigInt bodies on edge and seeded random operands, as float32 words (see
  "V8 NaN instability" under R2b-2). Its first run found a
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
(except `Actor.Base`, whose store also counts the change for the rider lists
in JavaScript, base-epoch.mjs) or
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
  (`onHandleRelease`). Since 2026-11-05 the class, receiver and state tables
  are indexed by handle slot (interp.rs `handle_slot`,
  script-vm-handle-slots.mjs): the level's own handles from the handle limit
  when its interpreter attached, and the handles live below it then, in an
  open-addressed old part; any other handle below it reads RELEASED. Tables
  indexed by handle grew with every handle the process had allocated, each
  level's again ([memory across many maps](map-memory.md#the-handle-tables)).
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
  and arithmetic results, which are quiet. (Since 2026-10-01 both VMs use
  the original's x87 NaN result instead, `x87_nan` and x87-nan.mjs:
  docs/script-float-vector-operators.md "Host-arithmetic operators".)
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
    Unoptimized code does too: the store that moves an Array literal from
    Smi to double elements writes 0x7fc00000 (2026-10-07). A bare
    `(x, y, z) => [x, y, z]` given three 0xffc00000 NaNs loses element 0's
    sign on call 10 by default, call 5 with
    `--invocation-count-for-feedback-allocation=3` and call 1 with
    `--no-lazy-feedback-allocation` (also with `--jitless`), and keeps it on
    every other call. That made `X87_CASES=5000 validate-script-vm-x87` fail
    on MirrorVectorByNormal's 10th call, whose x is a NaN only at that case
    count. The BigInt bodies are
    therefore `x87OperatorWords`, which return float32 words, and pass words
    between steps (SafeNormal's normal in 300). `x87Operators` turns the words
    into numbers. The validator compares those words with the kernel's
    (`resultWords()` for vectors). It checks both number forms only up to
    NaN-matches-NaN.
  * Optimized code may fold a float32 widening with a later narrowing,
    keeping a signaling NaN.

  Rust keeps one rule: quiet loads, the first NaN operand (since
  2026-10-01 the x87's NaN, `x87_nan`, shared with the JavaScript VM's
  x87-nan.mjs), the kernel's words. The validator checks that rule with references computed as scalars
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

**R3-b B3, part 1 — Walking's numeric kernels (implemented, not wired
into Play).** `native/script-vm/src/walk.rs` transcribes the JavaScript
bodies that physWalking calls between moves:

* `js_hypot`: V8's two-argument Math.hypot (`builtins/math.tq`
  MathHypot: normalize by the larger magnitude, Kahan-sum the squares, scale
  the root back). Walking uses it for its progress ratios.
* `safe_normal`, `two_wall_adjust`, `step_projection` and `step_up`
  (`steps.mjs`).
* `ground_velocity` (`velocity.mjs`, calcVelocity's walking path).

`step_up` reaches the world only through a `PawnOps` trait, one method per
pawn view access in the reference's order: MaxStepHeight, the moves,
HitWall, Physics, the player and pushable-decoration tests, the masses and
the velocity. `walk-kernel.mjs` hosts the kernels on their own instance, with
one import per view access, for validation. Play still runs the JavaScript;
stage B5 will implement `PawnOps` on the pawn's image and MoveActor.

Verification:

* `validate-walk-kernel` compares each kernel with its reference. It covers
  6 million `hypot` pairs (against V8's own, in a hot loop, including
  subnormals, huge exponents and specials), 1 million each of safeNormal,
  twoWallAdjust and groundVelocity (1 in 16 is an error case, compared by
  message), and 200,000 stepUp scenarios. Each scenario has a scripted pawn
  whose moves answer from a seeded script. The same accesses get the same
  answers, and all 1.44 million logged accesses, the returned hit, the final
  pawn state and every error (scripted MoveActor and HitWall errors, the
  1,024-call recursion budget) are identical.
* The native oracles run on the Rust kernel with `WALK_KERNEL=rust`:
  `validate-native-velocity` (820 cases) and `validate-native-steps` (1,486
  cases) match exactly.
* Mutation pass: 24 mutants (`.work/tools/mutate-walk.py`, built into a
  separate module through `WALK_KERNEL_WASM`), of which 17 are killed. Four
  of the rest are equivalent: the Kahan compensation after the last term,
  `> 0.03` against a float32 that never equals 0.03, `2 * friction * dt`
  regrouped, and `>=` on an equal maximum. Three are exact-equality
  boundaries the inputs do not reach: a squared length of exactly 1e-8, a
  zero dot product during braking, and a braked speed of exactly 10.

Left for stage B4, where their inputs come from actor images: the move
query's candidate selection, IsOverlapping, processHitWall and SetBase.

**R3-b B4 — Pawn MoveActor on the image (implemented, September 30).**
The import attribution puts about 6 ms of each Island tick behind
`js_tick_physics`, the pawn physics family; MoveActor is the body every
walking, falling and rotation step calls (about 2.3 ms of it, 1.3 ms in
the rider pass). `native/script-vm/src/move_pawn.rs` transcribes
`playerMove` (`player-move.mjs`, ULevel::MoveActor `0x103990e0` with test 0,
ignorePawns 0, noFail 0, ignoreBases per caller) over `moveQuery`
(`move-query.mjs`) for a **Pawn source**, on the pawn's image; the host is
`move-pawn-kernel.mjs` (`MovePawnHost` on the interpreter), reached from
the map pawn view's `moveActor` (`script-pawn-physics.mjs`) through the
`movePawn` physics service. It follows 1e-4, so Base and Touching are image
loads. Non-pawn sources (`moveMapRider`, `rotateMapActor`, the spawned
rider kernel), `testMoveActor` and FarMoveActor keep their JavaScript
bodies, which stay the references.

* **Reads of the source are image loads** through the move field table
  shared with the rider kernel (move-actor-kernel.mjs MOVE_FIELDS): the
  bStatic and bMovable bits, the four collision bits of `+0x1dc` (the
  reference's `source.flags`, bProjTarget never tested), StandingCount,
  Location, Rotation, CollisionRadius and CollisionHeight, and the four
  Touching slots (released handles read None, as `identityOfHandle`).
  Every read after an import is a fresh load, as the reference reads
  `source.flags`, `source.position` and `source.touching[i]` again.
* **Effects and candidate tests are the reference's own functions, called
  from one import each at the reference's point:** `js_move_hits` runs the
  same `multiLineCheck` service (with `decorate` on each hit's actor),
  keeps the hit objects on the host and hands Rust only their times;
  `js_move_cand` makes, per candidate and in the reference's order, the
  `ignoreBases` IsBasedOn test, the IsBasedOn(other, source) test and the
  type tests (world, moving brush, controlled player or projectile) and
  returns the candidate's collision word, so Rust makes the block decision
  and the displacement arithmetic; `js_move_eligible` is `hits.some(h =>
  !basedOn(h.actor, source))`; `js_move_riders`, `js_move_hash` (remove or
  add), `js_move_bump` (BumpWall with the hit's location and normal, or the
  Bump pair after the reference's IsBasedOn test), `js_move_touch_facts`
  (IsBasedOn, then `isBlockedBy` only when that failed, as the reference
  short-circuits) and `js_move_begin_touch`, `js_move_overlap` and
  `js_move_end_touch` per occupied slot, and `js_move_zone`
  (`setActorZone(false, false)`, the zone kernel first). Rust makes the
  Location and Rotation stores itself. Nested moves (an event that moves
  another pawn) get their own host context by depth.
* **Order kept:** query, tiny-delta short path (rotation store only), the
  rider pass before the commit, hash remove, Location then Rotation, hash
  add, BumpWall or the Bump pair, the Touch pass over the hits in order
  while `f(hit.time) < query.time`, the EndTouch pass over the four slots,
  SetActorZone(false, false). The result object is the reference's: the
  host builds `{success, delta, position, time, hit}` from an IO block, with
  `hit` the spread copy of the selected hit object and the adjusted time.
* **Hand-backs, before the first store:** a source the host does not admit
  (not a Pawn, a brush, no image, a poisoned or bound MOVE_FIELDS key: on
  Island and Training only the controlled player, whose Base and Touching
  stay bound until 1e-6), malformed arguments, a nonfinite start, delta or
  extent (the reference's error) and the reference's "changed rotation with
  riders and nonzero sub-threshold Delta" error. The JavaScript body then
  runs the whole move; the query is pure, so a repeated `js_move_hits` is
  not observable. An error thrown by an import (a cyclic Base chain, a
  script error in an event) propagates through the Rust frames at the
  reference's point, and the host puts the shadow stack back.
* **Arithmetic:** `length` as a double square root of the float32
  products in the reference's order, `size` and `reciprocal` as float32,
  `direction` and `extended` per component as float32, the `distance <= 2`
  test in double, the displacement `f(f(extended*time) - f(direction*2))`
  and `time = f((storedDistance - 2) / size)`; the commit adds each delta
  component to the float32 Location and rounds.
* **Switches.** `MOVE_PAWN_KERNEL=js` (Node) or
  `DEUS_EX_MOVE_PAWN_KERNEL='js'` (browser) keeps every call in JavaScript.
  `MOVE_PAWN_DIFFERENTIAL=1` compares each completed Rust move's time,
  displacement, success and selected hit (actor, location, normal, item)
  with `moveQuery` on the same hits, and counts calls, tiny moves, blocked
  moves, hand-backs and declines by reason and actor.

Verification (September 30):

* `MOVE_PAWN_DIFFERENTIAL=1`, 60 warm and 120 measured ticks with
  headless render feedback: Island 8,459 Rust moves (3,252 tiny, 52
  blocked), Training 268 (27 tiny, 19 blocked), no mismatch, no hand-back;
  every declined call is JCDentonMale0's (123 of 5,977 calls in a 60-tick
  Island run).
* Digests equal at every checkpoint with the kernel on and off
  (`MOVE_PAWN_KERNEL=js`): Island `ed406143f3137782`, Training
  `f997e8d935cae886` (120 ticks, 12 checkpoints); and with the documented
  300-tick command under `SCRIPT_VM_CHECK=1`, Island `b767a7e417fe5968`
  and Training `c8eebff5786adf55`, unchanged from before 1e-4.
  `validate-pawn-move-kernel` repeats the 120-tick comparison on both
  maps for the sweep.
* The native oracles on this path, with `NATIVE_PROBE_PYTHON`:
  `validate-native-move`, `-player-move`, `-walking`,
  `-walking-callbacks`, `-set-rotation-riders`, `-far-move-scene`,
  `-steps`, `-move-smooth`, `-based-actors`, `-actor-physics` and
  `validate-rider-move-kernel` pass; and the 578 unit tests.
* Browser, with the kernel live on the dev server: Training reaches HUD
  health 100 headlessly with no runtime error; Island plays to its first
  unimplemented boundary (the latent native 506 StrafeFacing in
  `ScriptedPawn.Attacking`, a known Stage 4 item, not a kernel error), and
  after Player start the pawn moves on with no second error; the Island
  walk profile (300 frames, `--no-profile`) runs with no error at a 13.5 ms
  tick phase, against 14.1 ms measured before B4 on the same tree.
* **Cost: no stable whole-tick change.** Island, 300 measured ticks with
  headless render feedback, medians in ms per tick, interleaved pairs:

  | Pair | `MOVE_PAWN_KERNEL=js` | kernel on |
  |---|---|---|
  | 1 | 13.23 | 13.24 |
  | 2 | 12.93 | 12.41 |

  and HEAD before 1e-4 (`.work/base` at 69c8ca2) against the tree with
  1e-4 and B4: 13.27/13.81, 12.58/12.49, 13.19/13.16 (base/main). This
  is the expected result of the design: the hits, the candidate tests, the
  touches, the riders and the zone are still JavaScript behind imports, so
  what B4 removes is the source side of one call (the pawn view's getters
  and the result and service allocations), well under 1 ms across the
  roughly 100 MoveActors per tick and inside the run-to-run noise. Its
  value is structural: B5 can call `move_pawn` directly from the walking
  loop on the image instead of building the view and the services per
  call, and B4b can move the rider pass next to it.
* **Then:** B5 and B4b (done, next sections); B6 falling, landing and
  rotation waits for the rethink recorded after B4b.

**R3-b B5 — The walking loop on the image (designed and implemented,
September 30).** B4's
A/B shows that MoveActor's own body was not the cost; the pawn view is.
`walking()` (walking.mjs, APawn::physWalking's dry path) reads about 30
view properties per iteration through `pawn.position`, `pawn.velocity`,
`pawn.acceleration`, the zone fields and the flags, each a `readNamed` and
an array, and builds the move services per call; stepUp and the floor
queries do the same. B5 runs the loop in Rust on the pawn's image, with
B3's kernels (`ground_velocity`, `safe_normal`, `step_up`, `two_wall_adjust`,
`js_hypot`) implemented over an image `PawnOps` whose `move_by` is
`move_pawn` called directly, so a walking tick makes no JavaScript call
except for its effects.

* **Entry.** `runScriptPawnPhysics`'s `case 1` (`pawn.walking(delta, 0)`)
  tries the kernel first, with the same admission as B4 plus the Pawn
  fields the loop reads (GroundSpeed, AccelRate, MaxStepHeight, bCanJump,
  bIsWalking, MoveTimer, Destination, Base, Region and the motion word's
  bJustTeleported), the level's zone fields for the pawn's Region.Zone
  (gravity, zone velocity, friction), and bHitSlopedWall. That last one is
  a declared Pawn field (`Pawn.uc` 21, `var const bool bHitSlopedWall`, "used
  by Physics"), so it has an image bit; the host `hitSlopedWall` member
  script-pawn-physics.mjs keeps beside it is a stale copy, and B5 makes the
  member an accessor over the bit (the 1e pattern) so the Rust loop and the
  JavaScript reference read one storage.
* **Effects as imports at the reference's points:** the surface prelude
  (`walkingPrelude`, already one Rust scan plus its WalkTexture callback
  and the ladder branch), `lineCheck` for the stopped-pawn floor probe and
  the floor query (the trace kernel's instance), `setSupportBase`,
  `setPhysics`, `farMove`, `fallingEvent`, `mayFall`, `hitWall`
  (processPlayerHitWall, with its IsProbing read), `landed`, `falling` and
  `startSwimming` as tail calls. Each may change Physics, so the loop
  re-reads the Physics byte where the reference reads `pawn.physics`.
* **Kept exactly:** the iteration and time-step arithmetic (`remaining >
  .05 ? f(min(remaining*.5, f(.05)))`), the `hitSlopedWall` re-probe with
  its three directions, the `Math.hypot` progress ratios, the
  `distance` floor tests (4.1..4.6, 2.4, 1.9, 2.1), the slide when
  `normal.z * friction < 3.3`, bCanJump and MayFall once per call, the
  velocity recomputation from `(position - old) / dt` unless
  bJustTeleported, and every `f` placement of walking.mjs.
* **Verification:** `validate-walk-kernel` extended to the loop on a
  scripted image pawn (the R3-d log-and-replay method for the effects),
  digests on both maps, the native oracles `validate-native-walking`,
  `-walking-callbacks`, `-walking-surface`, `-steps` and `-velocity` on
  the Rust path, and the interleaved A/B, which is what B4 lacked.

**R3-b B5 — implemented (September 30).** `walk_loop.rs` is walking.mjs
line for line over an `ImagePawn`: walk-loop-kernel.mjs's 22-row field
table holds the 19 Pawn and Actor cells the loop reads or writes and the
zone actor's ZoneGravity, ZoneVelocity and ZoneGroundFriction, read from
that actor's image (a zone actor without one falls back to the view's
`zoneFields`; no run has taken it). B3's `ground_velocity`, `safe_normal`
and `step_up` run over its `PawnOps`; `move_by` is `move_pawn` on the pawn
MoveActor host's context at the same depth (a MoveActor nested in an event
gets the next one), falling back to the view's `move` where that body
hands the call back (no run has). The 17 imports are the reference's
effects and reads at its points: the surface prelude, the line checks, the
fallback move, HitWall, stepUp's two reads on the hit actor
(`pushableDecoration` and Mass), the Falling and MayFall events,
SetSupportBase, setPhysics, FarMoveActor, the physFalling,
startSwimming and (2026-10-02) Falling-event physFlying (`js_walk_fly`,
walking.mjs `flyFrom`) tail calls, the two zone fallbacks and the error
throws. Since 2026-10-02 neither path stops when a script event leaves a
Physics other than Swimming after the move; the original continues the
body (docs/walking.md). Two changes to the reference itself: the pawn view's
`hitSlopedWall` is an accessor over the bHitSlopedWall bit (Pawn +0x318,
0x20; `Pawn.uc` "used by Physics"), so both paths read one storage and
the host member left the NPC reset list; and `move_pawn` calls
`js_move_eligible` only when the call ran the query, which is the
reference's `hits = []` and lets one host context serve a whole walking
call. `moveOps` is MoveActor's service builder, shared with the walking
hook, and `pawn.walking` tries `services.walkLoop` first.

* **Admission:** B4's (`eligiblePawn`) plus the walk table on the class
  and no binding on its 19 pawn keys. The controlled player is the only
  decline on both maps (its Base and Touching stay bound until 1e-6).
* **Verification** (what ran, in place of the design's bullet above):
  * `validate-walk-loop-kernel`: both maps as they are, the kernel with
    `WALK_LOOP_DIFFERENTIAL=1` against `WALK_LOOP_KERNEL=js`, 120 ticks:
    digests equal at 12 checkpoints and equal to the digests before this
    change (Island `ed406143f3137782`, Training `f997e8d935cae886`);
    9,012 and 2,842 Rust walking calls, no hand-back, no error. Island at
    300 ticks `b767a7e417fe5968` on both paths (6 checkpoints); Battery
    Park at 300 ticks `527070c787cd1d8e` on both.
  * **Branch coverage is counted, not assumed.** Six Rust counters in the
    loop's state block (direct MoveActor bodies, the sloped-wall re-probe,
    the floor nudge, the friction slide, the retreat, stepUp) and a count
    per effect import are printed by the validators. The maps as they are
    reach only the flat-ground path in 300 ticks: moves, floor nudges,
    line checks and one SetSupportBase (Training). So
    `validate-walk-loop-branches` runs both maps under the walk-branches
    scenario (bench-sim `--scenario`, scripts/scenarios/walk-branches.mjs):
    every walking pawn is pushed along a heading that rotates over time
    into walls, steps, other pawns and off ledges, jumping is forbidden on
    a third of the phases, and the sloped-wall flag is raised
    periodically. The inputs are the same on both paths and say nothing
    about the original game; the digests must agree, and do, at 12
    checkpoints on both maps. Training reaches stepUp 2,201 times,
    HitWall 2,450, the slope re-probe 103, the retreat 19 (with its
    FarMoveActor), the fall transition 4 (MayFall, Falling, setPhysics)
    and the nudge 39, with no boundary. Island reaches stepUp 753, HitWall
    923, the slope re-probe 56, the nudge 125 and the fall transition
    twice; its one retreat ends in a boundary that is not the kernel's:
    FarMoveActor's encroachment check dispatches `EncroachingOn`, a
    return-value event the runtime cannot dispatch from native code yet
    (`Return-value ProcessEvent requires a caller result reference`, the
    same 250 ticks on both paths, digests still equal). Still at zero in
    every run, and therefore covered only by the reference's own oracles,
    not by a Rust differential: the physFalling tail call (`remaining >
    0.01` after a fall does not occur at 60 Hz), startSwimming (no pawn
    walked into water), the friction slide (it needs `0.7 <= normal.z < 1`
    and `normal.z * friction < 3.3`, so ZoneGroundFriction below 4.71;
    every zone here has 8), the zone fallback, and a MoveActor hand-back
    inside the loop.
  * The reference is unchanged where the oracles look: `validate-native-
    walking`, `-walking-callbacks` (102 cases), `-walking-surface` (17),
    `-steps`, `-velocity` and `validate-walk-kernel` pass; 581 unit tests,
    three of them the ABI checks in `test/walk-loop-kernel.test.mjs`
    (field table order, import names, record widths). `validate-pawn-move-kernel` after the
    `queried` change: digests equal; 3,768 Rust moves on Island, since
    the loop's moves no longer pass through that host.
  * Full sweep on the final tree: 442 of 443 validators pass.
    `validate-player-tick-order` was killed at the runner's 6 GiB
    footprint cap (exit 137, no assertion) while a browser tab held
    Island in Play. Solo it passes four times, peak RSS 2.9 to 3.8 GB with
    the kernels on and 3.2 to 3.4 GB with them off, inside its own
    run-to-run spread; Island's heap after a forced GC is the same 517 MB
    on both paths, so B5 retains nothing.
  * Browser, kernel live on the dev server: Training to HUD health 100
    with no runtime error; Island plays to the StrafeFacing boundary at
    76 s, Player start resets, and the player then moves 677 units in
    10 s with no second error (headless Chromium,
    `.work/tools/player-start-check.mjs`).
* **Cost: a stable gain.** Island, 300 measured ticks with headless
  render feedback, medians in ms per tick, interleaved pairs on an idle
  machine (measured before the branch counters were added; those are six
  stores per walking call):

  | Pair | `WALK_LOOP_KERNEL=js` | kernel on |
  |---|---|---|
  | 1 | 13.27 | 11.52 |
  | 2 | 12.95 | 12.48 |
  | 3 | 13.13 | 11.75 |
  | 4 | 14.44 | 11.66 |

  The kernel side is lower in every pair; medians 13.13 against 11.66,
  a 1.5 ms tick. This is the first pawn-physics step with a measured
  gain, and it is the design's prediction: the per-iteration view getters
  and the per-call services were the cost, not MoveActor's body.
* **Browser, Island walk profile** (300 frames, `--walk --no-profile`,
  idle): tick phase 12.85 ms, against 13.5 after B4 and 14.1 before it
  on the same tree; actors 9.65, render 3.33, HUD 2.57, 29.4 ms of host
  work per frame in all, no error.
* **Attribution with the loop in Rust** (Island, 300 ticks,
  `SCRIPT_VM_IMPORT_TIME=1`, idle), self ms per tick: `js_tick_physics`
  2.31 (100 calls, 23 µs each; 5.97 before B4), `js_tick_event` 2.14,
  `js_eval` 1.86, `js_walk_prelude` 1.36 (52 calls, 26 µs each: the
  surface prelude, still JavaScript), `js_tick_state` 1.25,
  `js_move_riders` 1.18 (27 calls, 44 µs each: the rider pass),
  `js_iterator_next` 0.94, `js_object` 0.80, `js_move_hash` 0.22,
  `js_walk_line` 0.18. The instrument wraps 5,004 calls per tick, so its
  own cost inflates the high-count rows; read the split. What is left of
  the pawn-physics family is the tick body outside the walking loop
  (physicsRotation, falling, flying, swimming, the player), the surface
  prelude and the rider pass: B4b (riders, next section) and the prelude
  were the next targets.

**R3-b B4b — The rider pass (implemented, September 30).** The plan had
the rider pass (`moveActorRiders`, move-riders.mjs) going to Rust. The
measurement said otherwise. `RIDER_STATS=1` on Island (60 warm and 300
measured ticks): 10,373 calls, about 29 per tick, visiting 85 riders per
tick; 1,372 full `Level.Actors` scans reading 3.55 million Base cells,
1.06 ms per tick, against 0.25 ms per tick in the visits (the rider
kernel's entry and the x87 rotation term). The pass was the scan, and the
scan ran because the cache's one global epoch advanced on events that
cannot change a rider list: every Base write anywhere (a pawn changing
base invalidated the lists of all 28 movers), every SpawnActor append and
DestroyActor removal, and every host binding of any property
(`bindNativeObject` on a spawned native object binds five). Each
invalidation cost about nine scans of 2,590 actors.

* **The change** (base-epoch.mjs, move-riders.mjs, and the Base storage
  paths). A Base write counts on the old and the new base only
  (`noteBaseChange`), from the four places a Base is stored: the image
  cell (`writeCell`, so a script store, a native store and the map actor's
  `base` accessor all count), the host binding's setter (script-doors), the
  player's movement port, and the recovered SetBase. A mover's rider list
  records that count beside the epoch, so a Base change elsewhere leaves it
  in use. The epoch keeps the events that can move an index or change what
  a read returns: compaction, a reinsertion, a slot written from script,
  bulk restores, poisoning, releases, a binding of Actor.Base. SpawnActor's
  append and DestroyActor's removal move no index, and the cached pass
  skips a nulled slot as the original loop does (the removed actor's Base
  changes were counted when they happened), so they advance only a second
  counter, `actorsEpoch`, that the perception natives' Level.Actors list
  follows (it must see every spawn and every binding). Exactness holds: a
  list is the list a scan would produce while no index moved and no actor's
  Base changed to or from the mover, and every Base store passes through a
  counting path.
* **Result** (same run, same digest `b767a7e417fe5968`): 90 scans instead
  of 1,372, 229 thousand Base reads instead of 3.55 million, 0.10 ms per
  tick in scans instead of 1.06; 45 of the remaining scans are first calls
  of a mover and 45 follow the two epoch advances of the run. The visits
  stay at 0.25 ms. `RIDER_VERIFY=1` finds no cached list different from a
  scan on Island (300 ticks) or Training (120); `PERCEPTION_DIFFERENTIAL=1`
  finds all 157 reused perception lists equal to a fresh build; the digests
  are unchanged on both maps; `test/rider-cache.test.mjs` fixes the
  invalidation rules.
* **Cost, interleaved A/B** (Island, 300 measured ticks, `.work/base` at
  f006def against this tree, medians in ms per tick): 13.19/13.01,
  12.22/10.85, 11.99/14.04, 13.30/11.64 (base/tree). Three pairs favour
  the tree by 0.2 to 1.7 ms; the third reverses with an 83 ms maximum on
  the tree side, an outside disturbance. Four pairs were the budget at
  this gate, so the gain is recorded as about 1 ms with that reservation,
  consistent with the 0.96 ms the scan counters removed.
* **Why not Rust.** The original scans Level.Actors linearly on every
  rider pass; a Rust scan of 2,590 image Base cells would still cost about
  30 µs per call, 0.8 ms per tick over 29 calls, more than the cache it
  would replace. What the family has left is the 0.25 ms of visits, most
  of it already in the rider kernel. The family is closed at 0.35 ms.

**Where the frame stands after B4b, and the question for the rethink
(September 30, evening).** The per-family Rust moves of R3-b returned
about 1.5 ms per tick each (B5) or less (B4, B4b), for about a day each.
The target is 8.3 ms of host work per frame; the Island walk profile
(idle, `--walk --no-profile`, 300 frames) is 29.4 ms:

| Phase | ms per frame | What it is |
|---|---:|---|
| tick | 12.9 (11.9 with B4b) | the script tick: Rust interpreter about 3, JavaScript behind imports about 9 (dispatch plumbing 3.3, JavaScript-valued natives 3.3, pawn physics tail 2.3, surface prelude 1.4) |
| actors | 9.7 | the NPC mesh update: per-vertex lighting 2.35 and GetFrame 1.44 in the lodmesh Wasm kernel, about 3.5 of JavaScript around them (npc-mesh-preview 2.0, mesh-lighting-view 1.1, mesh-environment 0.35), about 2 of three.js state and buffer uploads |
| render | 3.3 | three.js draw submission (642 main calls) |
| HUD | 2.6 | the original window system's per-frame draw |
| lighting, mirrors, rest | 1.0 | moving lights, mirror planes, animate |

The GPU is idle at 1.46 ms per frame (the timer instrument above). No
family is larger than 4 ms, and the frame must shrink 3.5 times, so the
family-by-family path reaches about 60 fps (a 16.7 ms frame) and not 120.
The options that change the equation, each the user's call:

1. **The tick on a worker.** The frame becomes max(tick, the rest) instead
   of the sum: about max(12, 17) = 17 ms today, so 60 fps at once, and the
   render side then needs its own halving for 120. Cost: the render side
   reads actor state (Location, Rotation, Mesh, AnimFrame, lighting) that
   the tick writes, so the tick must publish a frame snapshot (a copy of
   the image cells the renderer reads, one memcpy per frame from the
   arena) and input must be queued to the worker. The original game is
   single-threaded; a snapshot boundary is host structure, not behaviour.
2. **Mesh animation and lighting on the GPU.** GetFrame's keyframe
   interpolation and FLightManager's per-vertex lighting are vertex-shader
   work; the GPU has 15 ms of idle time per frame. Removes most of the
   9.7 ms actors phase (the kernel's 3.8, the JavaScript glue and the
   uploads) and leaves the per-actor decisions (visibility, style, light
   selection) in JavaScript. Fidelity: the CPU kernels are oracle-exact
   against Render.dll's x87 arithmetic; a GPU version computes in float32
   in a different order and must be validated against the CPU reference
   to a stated tolerance per vertex. It is a rendering substitute of the
   kind AGENTS.md admits for visuals when the reference stays beside it.
   Design, tolerances and results: [GPU mesh](gpu-mesh.md).
3. **Continue the tick in Rust, in blocks not families.** Event and
   state dispatch (3.3 ms, step 3 of the next-steps list) and the
   JavaScript-valued natives (3.3 ms) are the remaining tick blocks; each
   is a multi-day step and each is worth about 2 to 3 ms. With B6 and the
   prelude the tick could reach about 5 ms; without 1 or 2 the frame stays
   above 20 ms.
4. **A 60 fps target.** 16.7 ms per frame is reachable on the current path
   (about 3 ms of tick work away after B4b), with no structural change.

A rethink decides between these before B6.

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

* **The player's actor word** stays the movement port's host state (step
  6). Player start assigns the retired identity a composed `actorFlags`
  without bDeleteMe and re-registers it in the hash before LoadMap's
  collection. With the image as the word, that registration would follow the
  destroyed identity's bDeleteMe.
* **The player's collision word** moved on 2026-10-02, the way its motion
  word had: `Player.collisionFlags` is the attached identity's +0x1dc image
  word while linked (`linkCollisionFlags` in installFlagWords), host state
  before attach and after `detachPlayerIdentity` unlinks it. The
  retired-identity concern above is the actor word's; the collision word is
  unlinked before the old image is purged. The host word starts from the
  class default word, bProjTarget included (0x1f for JCDentonMale). Training
  and Island never write the player's collision bools, so their digests are
  unchanged. 00_Intro does: `CameraPoint.Idle` sets `Player.bCollideWorld =
  False`, and FarMoveActor's FindSpot gate must see it, or the cut to the
  clone's tank is refused ([conversation camera](conversation-camera.md)).
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
* **Base and Touching** are step 4 (1e-4, below). **The player's view
  fields, regions and Physics** are step 6.
* **Player start** still restores Location only for the actors its reset
  paths name: pawns, patrol points, pickups, decorations and movers.
  `keepLivePose` keeps that exactly. Any other map actor that moves keeps
  its live pose across a Player start, where the original's reload would
  restore it. That is a fidelity question for its own change.

**1e-4 — Base and Touching in the image (implemented).** This is step 4
of stage 1e, and the first part of R3-b B4: the recovered IsBasedOn walks
(`move-query.mjs`, `player-move.mjs`), the rider pass (`move-riders.mjs`),
SetBase (`walking-callbacks.mjs`, `decoration-physics.mjs`) and
BeginTouch/EndTouch (`actor-touch.mjs`) read and write a map actor's `base`
member and `touching` array, which script-doors' makeBinding served to
script as `Base` and `Touching`, while the image cells under the bindings
went stale (the "Touching comparison" above: 1,749 stale actor-ticks on
Island). `actor-link-fields.mjs` makes the two host members accessors over
the cells, at the retail AActor offsets `+0xc4` Base (object pointer) and
`+0xe8` Touching[4] (four object pointers, 4-byte stride; sdk-layouts.mjs,
checked once per class cell against the linked layout).

* **Install.** `attach` installs the links after the mirrors and poses, so
  the property snapshot a reset restores is taken before the host values
  move in, as for 1e-2 and 1e-3. `base` adopts the member's current value,
  or None while the member is absent: makeBinding read `host.base ?? null`,
  so the script-visible value is unchanged. `touching` is installed only
  where the host already carries its four live slots (every level-load
  actor: `prepareActor` builds them from the serialized Touching before
  attach), and the slots move into the cells; `isMapMoveHost`'s admission
  predicate (`Array.isArray(host.touching)`) is therefore unchanged. The
  array is one Array of length 4 per host with accessor elements, so
  `slots()` in actor-touch.mjs (Array.isArray, length, indexOf, element
  stores, `fill`) and the binding-era `host.touching = [...]` assignments
  (the Player start reload, `prepareActor`) store into the cells. Every
  `base` store counts the Base change for the rider lists (`noteBaseChange`
  in `writeCell`, base-epoch.mjs), as the binding's setter does.
* **Bindings.** makeBinding returns null for both keys on every attached
  actor except the controlled player, whose `base` is the movement port's
  (player.mjs) and stays bound with its Touching until 1e-6. `boundKeys`
  therefore still holds `engine.actor.base` and `engine.actor.touching` for
  the player's sake, so the Rust interpreter reads them in the image on
  receivers without bindings and hands them to JavaScript on bound
  receivers, as for the player's Physics (1e-2).
* **Resets.** `restoreStorage` now returns Base and Touching to the
  property snapshot (the serialized values), where the host members were
  untouched by the restore before; the NPC and decoration reset paths then
  re-seed both from the serialized values through the accessors, as they
  did on the host members. Any other map actor that was SetBase'd during
  play now returns to its serialized Base on a Player start, where it kept
  the live Base before; that is the original reload's result.
* **Open, not changed here: serialized Base at first load.** A map actor
  whose serialized Base is set reads None until a Player start reload,
  because makeBinding read the absent host member (`prepareActor` builds
  `touching` but never `base`) and this step preserves that value; the
  reload paths then seed `base` from the serialized value. The original
  keeps the serialized Base from load. On Island 71 of 3,658 actors carry
  one, every one `LevelInfo0` (export 1): 29 Terrorists, 5 ThugMales, 4
  UNATCOTroops, Gunther, Paul, 7 SecurityCameras, 2 SecurityBots, 2
  AutoTurrets, the boat, the buoys, the trees and bushes, the statue
  parts; Training has none. For a pawn, physWalking's stopped-floor
  shortcut compares the floor hit's actor with Base, so the first ticks
  differ until SetBase lands on the world. The fix is one line here (adopt
  the image cell, which `applyInitialProperties` filled, instead of None
  when the member is absent); it is its own change, with its first
  differing Island checkpoint explained.

Verification (`.work/tools/verify-1e4.sh`, September 30):

* `test/actor-link-fields.test.mjs` (the cells at the retail offsets, both
  ways of access, the array surface, the NPC startup reset, the refusals),
  and the 578 unit tests.
* Digests unchanged on both maps under both engines with the documented
  command (`--bypass --continue --render-feedback --warm 60 --ticks 300
  --digest-every 10`, 30 checkpoints): Island `b767a7e417fe5968`, Training
  `c8eebff5786adf55`, errors `{}`, with `SCRIPT_VM_CHECK=1`.
* `touching-compare.mjs`, 360 ticks per map: image and host slots differ
  on no map actor (1,749 and 491 stale actor-ticks before), and script
  reads differ from the host nowhere. The only remaining image/host
  difference is the controlled player's (100 actor-ticks on Island, 337 on
  Training, its Touching bound until 1e-6).
* `validate-rider-move-kernel`, `-native-zone`, `-native-based-actors`,
  `-native-set-rotation-riders`, `-script-spawn-touching`,
  `-native-far-move-scene`, `-zone-kernel` and `-native-walking-callbacks`
  (102 cases, with `NATIVE_PROBE_PYTHON`) pass.
* Bound reads per Island tick fell from 501 to 441: the 61 `Base` reads
  are image reads now. `boundKeys` keeps both keys for the player.
* The first Play run after the install paused Training at the NPC startup
  reset (`delete actor.base` on the new accessor); `resetLinkField` now
  returns the member to the binding-era value, and Training runs to HUD
  health 100 headlessly.

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
  binary operations take the first NaN operand (`nan_first`; since
  2026-10-01 the x87's NaN result, `x87_nan`, as the JavaScript bodies do
  through x87-nan.mjs).
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

**R3-e — SetActorZone's common case (implemented).** Every MoveActor ends
with SetActorZone, about 180 calls per Island tick counting the rider moves
(see "The rider moves are original" above). In JavaScript each call built an
adapter object, walked the BSP and read and wrote the PointRegion structs
through the generic struct path, about 2.6 µs.

* **Rust.** `native/script-vm/src/zone.rs` transcribes zone.mjs
  `pointRegion` (the side test in the reference's z, y, x order, `>= 0`, the
  `zoneActors[zoneNumber] || levelInfo` fallback, the visit bound and its
  errors) and the no-event path of `setActorZone`. `zone_update` reads
  bDeleteMe, Location, CollisionHeight, EyeHeight, the three regions and
  PlayerReplicationInfo from the image. It completes a call only when the
  body would make no event, no PlayerReplicationInfo store and no error:
  the actor is deleted, or no region changes zone (or `test` is set). Then
  its only effects are the region stores, which it makes. Anything else
  returns before the first store, and the JavaScript body runs the call;
  its point queries are pure.
* **Host.** `zone-kernel.mjs` (the `ZoneHost` on the interpreter) admits a
  call when every field is the image cell `readNamed` and the field
  references use: the R3-c/R3-d rule (registry cell, name resolution per
  class, no bound key on the receiver, not HOST). `force` always runs the
  JavaScript. The level's zone model (`level.zoneModel`, player-scene.mjs,
  not enumerable) is uploaded once per level into the runtime's arena: a
  header, the zone handles and 40-byte nodes (float32 planes; a plane that
  is not a float32, or a child, leaf or zone of the wrong width, keeps the
  level in JavaScript). A zone actor released later hands every call back.
* **Call sites.** `ScriptRuntime.setSpawnActorZone` (spawned actors,
  including the rider moves) and the map pawn view's `setActorZone`
  (`services.zoneUpdate`). The LoadMap pass keeps the JavaScript.
* **Switches.** `ZONE_KERNEL=js` keeps every call in JavaScript.
  `ZONE_DIFFERENTIAL=1` checks each call completed in Rust: the stored
  regions against the JavaScript point queries, no zone change without
  `test`, no PlayerReplicationInfo, and a deleted actor's regions
  untouched.

Verification:

* `validate-zone-kernel`: 480,090 points on the Training and Island BSPs
  with four zone lists each (all zones, every third missing, half, none)
  and on synthetic models (empty, a leaf, an invalid or negative child, a
  cycle, a deep chain), identical to `pointRegion`, errors included. The
  points sit around the maps' actors, on node planes, within a few float32
  steps of oblique planes, far outside, and at specials.
* Digests are unchanged on both maps under both engines (Training
  `c8eebff5786adf55`, Island `b767a7e417fe5968`, 30 checkpoints, errors
  `{}`), with `ZONE_DIFFERENTIAL=1 SCRIPT_VM_CHECK=1`: 1,271 (Training)
  and 65,525 (Island) Rust calls, all matching.
* `validate-native-zone`, `-based-actors`, `-far-move-scene`,
  `-set-rotation-riders`, `validate-script-spawn`,
  `-script-scripted-actor-spawn`, `-inventory-spawn` and
  `-script-pawn-spawn-binding` pass, and the 566 unit tests.
* The hand-back path runs in Play: on Island, 16 of the calls in 300
  ticks changed zone and ran the JavaScript body with its events, and about
  4 calls per tick were declined (receivers the host does not admit).
* Mutation pass (`.work/tools/mutate-zone.py`): 9 mutants, 6 killed. Two
  are equivalent (the visit bound, since a path without a cycle is shorter
  than the node count; `next < -1` after -1 is handled). One is not
  reachable: the side test summed x, y, z instead of z, y, x. A search of
  48 million float32 points within four steps of the two maps' 6,907
  oblique planes found no point whose side depends on the order.

Cost: Island tick medians 12.92/13.01/13.01 ms at HEAD against
12.58/12.16/12.28 with the kernel (three interleaved pairs), about 0.6 ms.

New subsystems still missing (the remaining natives, rendering) are
researched as before and implemented against this core. Swimming
([swimming](swimming.md)) landed in JavaScript on the x87 model, like flying;
its Rust port is a later performance step. A new native
written in JavaScript during the transition uses shared-memory field access,
so it stays valid until its family moves.

## September 30: choosing the next simulation change

A focused census (`SCRIPT_VM_STATS=1 node scripts/bench-sim.mjs --warm 60
--ticks 60 --render-feedback`) helps distinguish opportunities from labels in
the plan. It is an instrumented workload count, not an A/B timing result.
The Island run completed with no runtime errors.

* The interpreter handed **328 Physics reads to JavaScript over 60 ticks**
  (5.5 per tick). That is an upper bound on the reads a per-object bound-key
  rule could remove: the controlled player's Physics really is bound.
  Base had 480 reads (8 per tick), but Base is still host-owned. The
  perception kernel's separate BaseEyeHeight path made 1,602 JavaScript
  reads (26.7 per tick); changing the interpreter alone would not remove
  them. A proposed bitmap per binding set therefore was not retained:
  refreshing those tables on receiver epochs adds work, and the candidate
  saving is small. There is no claimed speedup from this investigation.
* **CycleActors is still a better simulation candidate**, but it should be
  treated as an iterator-family change, including resume and out-parameter
  publication. In the existing `island-zone.cpuprofile` browser capture,
  `next` and iterator creation account for about 0.56 sampled ms/frame,
  with another 0.32 in `js_iterator_next`. These are attribution estimates,
  not an additive guaranteed saving. `classIsA` already caches ancestry;
  adding another ancestry cache does not remove the scan or its lvalue and
  iterator-stack work. A replacement must retain the original cursor,
  shrinking-array bound, wrap, null entries and out-slot write order from
  execCycleActors `0x1036e9d0` ([actor queries](script-actor-queries.md)).
* **Walking is a family, not one expensive formula.** The same capture
  attributes about 3.9 ms/frame to walking, including about 0.9 to its
  surface prelude, about 2 to the main move path, plus step-up and floor
  queries. The prelude already batches its 37 original traces in Rust.
  Its remaining cost is not grounds to skip traces or reuse results across
  frames: moving actors and doors can change them. The next substantial
  simulation step remains B4–B6 above, preserving callbacks and the live
  object image while removing the surrounding host field and view work.

These smaller opportunities do not change the browser budget stated above:
simulation alone already exceeds 8.3 ms, and presentation exceeds it again.
Moving another isolated scalar helper to Rust cannot produce 120 fps. Measure
and remove repeated presentation work alongside the physics-family work;
only consider a worker once render feedback and deterministic handoff have
an explicit contract.

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
