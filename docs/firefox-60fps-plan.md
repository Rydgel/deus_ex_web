# Firefox at 60 fps: plan for rows 7.2.2 and 7.2.4

Written 2026-11-05, after the target moved to 60 fps (AGENTS.md) and row 7.3.3 passed. Firefox is the only browser under the
target. This plan says where its frame goes, which routes could close the gap, and the order of the work. The figures are from the
headed Linux runs of 2026-11-05 ([frame cost](play-frame-cost.md#row-722-headed-2026-11-05-linux), f2f1cb6f, before the level
loop's port) and the hitch log's Firefox runs ([hitch log](hitch-log.md#firefox-the-workers-idle-gc-2026-10-15)). Savings are
estimates until an interleaved A/B measures them.

## The two rows

* **7.2.2:** on every map of the frame-time set, the drawn-frame interval p95 is at most 16.7 ms (with 0.5 ms for timestamp jitter).
  Chrome passes on all ten maps. Firefox, inline (its default), fails on six.
* **7.2.4:** in Firefox inline, from a map's first 5 s on, no gap over 150 ms, and at most two over 50 ms a minute. On the Island
  (2026-10-31) the first half passes, but there are 10 to 18 gaps over 50 ms a minute. A Gecko profile put 12 of 31 such gaps on
  a major collection's incremental slices (5 to 80 ms), and 19 on page frames that ran long with no collection.

## Where Firefox's frame goes

The page thread runs the simulation and the drawing one after the other. Means over drawn frames, from 5 s after the map (ms):

| Map | page p50 | page p95 | tick | actors | HUD | render | of which uploads | fog |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Island | 16 | 23 | 8.0 | 3.1 | 2.4 | 1.8 | 0.5 | 0 |
| Battery Park | 26 | 32 | 8.5 | 3.1 | 2.0 | 8.2 | 4.9 (8.6 MB a frame) | 2.4 |
| Airfield | 19 | 24 | 7.8 | 3.4 | 2.7 | 1.2 | 0.4 | 0 |
| Wan Chai market | 18 | 25 | 9.9 | 3.1 | 2.8 | 1.1 | 0.2 | 0 |
| Ship | 17 | 21 | 6.7 | 2.0 | 3.0 | 3.6 | 2.5 (4.1 MB) | 0.2 |
| Area 51 bunker | 16 | 34 | 7.7 | 3.0 | 3.0 | 1.6 | 0.2 | 0 |

Chrome's worker runs the same tick in about 4 ms (1.8 to 2.4 times less), its actors phase in 2.0 ms and its HUD in 1.1 ms. The
difference is JavaScript: the Rust core's calls back into the host are a third of Firefox's Island frame, and SpiderMonkey runs
that host code about twice as slowly as V8.

**The p95 comes from the tick's slow frames.** In the slowest 10% of drawn frames, the tick takes longer than in the rest by:
* 6.1 ms on the Island;
* 7.4 ms on Battery Park;
* 3.4 ms on the Airfield;
* 6.4 ms in Wan Chai;
* 3.9 ms on the Ship;
* 12.4 ms in the bunker.

Every other phase together adds 2 to 5 ms. So the medians are close to the bound, but the tails are not. The bunker shows it best:
its p50 is 16 ms and its p95 is 34. What the slow ticks hold is in [step 0's results](#step-0-what-the-slow-ticks-hold-2026-11-05):
script work, mostly in the first 20 to 30 s after a map, not collections.

**What has to go, per map**, to bring the page p95 from its value to about 16 ms:
* Island, about 7 ms;
* Airfield, about 8 ms;
* Wan Chai, about 9 ms;
* Ship, about 5 ms;
* bunker, about 18 ms;
* Battery Park, about 16 ms.

On Battery Park the steady cost is too high as well: its p50 is already 26 ms.

## Routes

| Route | What it takes | Verdict |
|---|---|---|
| **A. Stay inline, shorten the page frame** | Cut the tick's spikes and its host JavaScript, plus Battery Park's, the Bar's and the Ship's uploads and fog, plus the HUD and actors. For 7.2.4, fewer and shorter incremental collection slices. | Recommended. Every step also shortens Chrome's worker frame (row 7.2.1 on the Mac), and each is measurable on its own. |
| B. Firefox in worker mode | The page draws while the worker simulates: Battery Park measured 31 → 17 ms p95. A worker's major collection in Gecko is one non-incremental slice over the whole heap: 200 to 250 ms every 25 to 40 s with `?workerBusy=1` (which also keeps a core busy), and 133 to 366 ms every ~5.5 s without it. Passing 7.2.4 needs that pause under 50 ms: if the pause scales with the heap, a JavaScript heap about five times smaller (the simulation's data in Wasm memory). The Island's worker frame (19 ms p95) would also still need cuts. | Not now. It becomes possible as the Rust core takes over the simulation's objects; re-measure it at each large heap cut. |
| C. Draw in a worker (OffscreenCanvas), simulate inline | The main thread keeps the simulation and its incremental collections, and a render worker with a small heap draws. Both run in parallel. This would be a second page architecture for one browser, and the render worker's pauses are unmeasured. | Fallback, only if A stalls on the tails. Measure its collections in a bare prototype before deciding. |

## Plan (route A)

Each step is a family that a measurement names, ported in the Rust core or moved to the GPU (the user's preferences). Each must be
worth at least 5% of Firefox's frame on one failing map, about 0.8 ms, as judged by an interleaved A/B of phase means. Simulation
ports are bit-exact: equal state digests on the five-map set, and the validators of the family touched. Each step is verified in
Chrome's worker mode too.

**0. Baseline and the tails** (measurement only): done 2026-11-05, [results below](#step-0-what-the-slow-ticks-hold-2026-11-05).
The slow ticks are script work, not collections and not JIT warm-up. They are the same families as the steady tick, in larger
doses, mostly in the first 20 to 30 s after a map. The headed set is not re-run here: the profiles are headless, the steps' A/Bs compare
the tick's phase means (which a headless run measures), and the headed set is taken again for the rows' verdict (step 6).

**1 and 2. The tick: its slow frames and its steady cost, one family at a time**, in this order of measured size (corrected
2026-11-05 after [the decals check](#decals-are-already-in-rust-2026-11-05); the figures are the slow tenth's extra per frame, then
the steady frames' cost, from the step 0 profiles):
* **The actor iterators.** `ForEach AllActors`, `CycleActors` and `RadiusActors` statements are lowered to `js_step` and run in the
  JavaScript VM (`stepCompiled`), with `AllActors`' per-actor `isA` and `createIterator` there. The extra is Island +0.8 (of it
  `AllActors`' `isA` scan +0.5), Battery Park +0.6, bunker +0.4 and Wan Chai +0.3. The steady cost is 0.2 to 0.4.
  This family is on all four maps.
* **Perception's light line checks.** The AI event manager's tick (Battery Park +1.1, Wan Chai +0.5) runs perception's light level
  in Rust (`percep::light_level`), whose line checks come back to JavaScript: `lightLineCheck` → `lineCheck` in the JavaScript
  collision kernel, which the Rust trace calls back (`candidate`) for each candidate actor. On Battery Park those JavaScript parts are
  about half of the +1.1.
* **The walking prelude's surface scan** (`walkingSurfacePrelude` → `surfaceScan`, the same collision kernel): Wan Chai +0.5 and
  1.1 steady, 0.24 to 0.55 steady elsewhere.
* **Spawning and destroying actors** (`spawnActor`, `destroyScriptActor` in JavaScript): bunker +1.7.
* **Frequent natives the Rust VM hands back:** `GetPlayerPawn` (native 720, 51,000 calls in 20 s on the Island), `StartConversation`
  calls (Wan Chai, 8,000 in 20 s), and string natives (Wan Chai: one nested string expression, 67,000 calls).
* **What runs outside the Rust batch** (1.1 to 1.3 ms in steady frames): the player's tick, which still runs in JavaScript, and the
  level's host work around the batch. Profiled 2026-11-06 ([table](script-player-tick.md#what-the-players-tick-costs-in-firefox-2026-11-06)):
  the player's tick is 1.20 ms of a flat spread (its two script events 0.60, mostly fallbacks of the Rust VM that NPC scripts share;
  `showSelf` 0.20, `ReadInput` 0.14, walking physics 0.13), so no piece of it reaches 0.5 ms; the level's own host work is
  `playerDistances` 0.22 (Rust already), the event manager 0.16, cleanup 0.14. The profile found the larger cost under the batch itself:
  [three tiny imports the Rust tick made for every actor](rust-core.md#november-6-the-ticks-reads-of-other-objects-in-rust-implemented),
  now in Rust.
* **Not a port: decals.** They are already Rust. The decal attach is 0.78 of `AttachDecal`'s 0.90 ms in the bunker's slow frames and
  averages 0.55 ms per frame there, 0.11 ms on the Island. Making it faster meant changing the Rust algorithm, and only the bunker
  gained much: [done, exactly](#decals-are-already-in-rust-2026-11-05) (2026-11-06, the first Progress entry).
* Expected: the slow tenth's 4.3 to 8.6 ms by more than half, and 2 to 4 ms of the median. Each family's A/B decides its share.

**3. Uploads and fog on the page** (Battery Park, the Bar, the Ship).
* Find what uploads 4 to 9 MB a frame. The hitch log counts bytes but not resources, so give its GL wrapper a per-target count.
* Keep that data on the GPU.
* Move volumetric fog's per-frame map update (2.4 ms on Battery Park) to the GPU if it can stay exact.
* Expected: 4 to 7 ms on Battery Park, about 2 ms on the Bar and the Ship.

**4. HUD and actors** (2 to 3.4 ms each, about twice Chrome's). The actors half is measured (2026-11-05,
[firefox-actors-phase.md](firefox-actors-phase.md)): `p.actors` is the simulation's `w.actors` (2.2 to 2.7 ms) plus the page's 0.5 to 0.6,
and no family reaches 0.5 ms.
* The HUD's script windows, and the actor admission and SetupForActor passes, by profile.
* Expected: 1 to 2 ms.
* **The HUD half is measured (2026-11-05, [below](#the-hud-phase-2026-11-05)): its excess over Chrome is 0.7 to 1.0 ms, not 1.4, and
  it has no family of 0.5 ms.** The largest is 0.3 ms; the work is a flat spread of JavaScript behind the Rust VM's imports.

**5. Collections for 7.2.4.**
* With shorter frames, measure again how many gaps over 50 ms remain and which collections cause them.
* Cut steady-state garbage, and the heap where marking is the cost. This continues the [live heap](live-heap.md) work, which
  was parked for Firefox on 2026-10-28.

**6. The rows.**
* Run the headed set in both browsers and the Firefox roams for 7.2.4 on Linux, then on the Mac.
* After steps 0 to 2, check the route: if the bunker's or Battery Park's tails still miss and are collection-bound, reconsider
  route C.

## Step 0: what the slow ticks hold (2026-11-05)

Headless Firefox 155, inline, the census route (`hitch-run.mjs --mode scan --god --seconds 60 --profile`), master at 9283543f, a quiet
machine. `scripts/gecko-slow-ticks.mjs` joins each drawn frame of the hitch log to the profile's main-thread samples, with
correlations of 0.90 to 0.96 between a frame's tick phase and its samples at clock offsets of 0 to 2 ms. It then compares the slowest
10% of frames by tick with the rest. Profiles and runs are in `.cache/perf/ff-ticks/` (outside Git).

| Map | tick, slow tenth | tick, rest | collector markers in a frame (slow, rest) | What the slow frames add (ms per frame) |
|---|---:|---:|---|---|
| Island | 13.3 | 8.5 | 0.27, 0.14 | `js_eval` +0.9, `js_step` +0.7, `AllActors`' iterator and `isA` +0.6, decals +0.3, HUD root tick +0.3, walking prelude +0.3 |
| Wan Chai market | 13.0 | 8.7 | 0.42, 0.18 | `js_eval` +1.3, Rust +0.6, walking prelude +0.5 |
| Area 51 bunker | 14.3 | 5.7 | 1.02, 0.16 | `js_eval` +3.1, of which `destroyActor` +1.0, decals +0.9, `spawnActor` +0.7; state code +0.8 |
| Battery Park | 12.3 | 7.8 | 0.26, 0.35 | Rust +1.1 (`percep::light_level` under `ai_tick`), `js_tick_resume` +0.4, physics +0.3 |

* **Collections are not the tail.** Their markers hold 0.3 to 1.0 ms of a slow frame, against 4.5 to 8.6 ms more tick.
* **The slow frames come early.** The tick's mean per 5 s falls on all four maps, for example the Island's from 12.1 ms (5 to 10
  s after the map) to 6.5 ms (60 s). Chrome's worker tick falls too, from 5.4 to 3.7 ms on the Island in the headed run.
* **It is not JIT warm-up.** The Island loaded after Wan Chai in the same page, so with its host code already compiled, has the same
  early ticks: 12.3, 10.7 and 10.3 ms at 5, 10 and 15 s, against 12.1, 11.2 and 11.0 cold. Its steady tick is about 1 ms lower (5.6
  against 6.5 to 6.8 ms).
* **What it is, then:** the level's own work after arrival, such as the start-of-mission InfoLink, the mission title's text, NPCs
  setting off, effects spawning, and shadows reattaching their decals while pawns move. That is original behavior, so it stays.
  Its cost is that most of it still runs in JavaScript.
* **The census agrees** (Node, `SCRIPT_VM_STATS`, 5 to 25 s after the map on the scan route). The largest JavaScript fallbacks are
  `AttachDecal` (Island 905 ms, bunker 1,421 ms plus `ReattachDecal` 863 ms, Wan Chai 422 ms over the 1,200 ticks), then global
  function calls (`0x38`, 200 to 320 ms), `StartConversation` in Wan Chai (371 ms), and `GetPlayerPawn` (native 720) by count.
  Battery Park's census is not usable: headless, every tick stops at the viewport size before the first frame.
* **But the census counts time inclusive** of the work under a fallback call, Rust included. Read a `js effect` row as the call's
  whole cost, not as JavaScript; the profiles split it ([decals](#decals-are-already-in-rust-2026-11-05)).

### Decals are already in Rust (2026-11-05)

The census above put `AttachDecal` first, but its `js effect` time is the whole call: the Rust attach under it included. Split by
the Gecko profiles:
* `execAttachDecal`'s JavaScript glue (argument reads, the tracker's mover rotations, the store's IO, the `SurfList` copy) is
  about 10% of the call.
* The Rust `decal_attach` is the rest. In the bunker it averages 0.55 ms per drawn frame: `decal::find_surface` with its x87
  `Ext` arithmetic is 0.5 ms of that, `gather_nodes` the rest. On the Island it averages 0.11 ms.

Porting the glue would save 0.05 to 0.1 ms, under the 5% rule. x87 emulation as a whole is 0.1 to 0.4 ms of a frame on the four
maps. The order above follows these figures.

The Rust attach itself was then made faster without a port: `FindSurface` and `GatherNodes` use their arithmetic for signs only, and
a table of edge planes with an error-bounded f64 filter decides them exactly ([decals](decals.md#fast-surface-finding-2026-11-06),
the first Progress entry).

### Global function calls run in Rust (2026-11-05)

The census's `js effect 0x38` rows are EX_GlobalFunction, `Global.Tick(DeltaTime)` and its siblings in the state-level overrides
(`Standing.Tick`, `Wandering.Bump`, `Fleeing.HitWall`, ...): the shipped bytecode has 95 such sites, 87 in functions inside states
and eight in `Weapon.Finish` and `DeusExWeapon.Finish` (`Global.Fire`, `Global.AltFire`). The calls in the census are
`Global.Tick` (ScriptedPawn, Animal, Robot) and a few `Bump`. The Rust VM had no kind for the node, so
each call was a `js_step` import, `compileCall`, `runtime.invoke` and `callFunction` in JavaScript; the callee's lowered body
then re-entered Rust through `vm.resume`. The callee's body was already Rust, so what moved is the call itself, not the body
(the row's inclusive time held the callee's whole subtree).

* **Original behavior.** `UObject::execGlobalFunction` (Core `0x10130300`) is `execVirtualFunction` (`0x101301e0`) with the
  lookup flag pushed as 1 instead of 0: both disassemble to the same 20 instructions, the only difference being `push 1` at
  `0x10130309` against `push 0` at `0x101301e9` (re-disassembled for this step with capstone). `FindObjectField` (`0x10150b50`)
  skips the state table when the flag is 1 ([function opcodes and lookup order](script-execution.md#function-opcodes-and-lookup-order)).
  `runtime.lookup(receiver, name, true)` is that resolution, and `callFunction` does not look at the call's kind, so the Rust
  `CALL` kind serves a global call after resolving it this way.
* **How.** `script-vm-lower.mjs` lowers a 0x38 node on SELF to `CALL` as it does a virtual one (the function found by
  `lookup(instance, name, true)`, its signature id in the node); `beginCall` and the call cache's `callDecision` resolve it with
  `lookup(receiver, name, true)` (`callRecord`). The cache's key (caller code, node, class row, state row) already covers a
  global lookup. Everything the machinery cannot express stays the JavaScript kind, as for a virtual call: a function with
  out parameters or a non-scalar parameter (`HitWall(vector, actor)`, `Landed`), a native, a singular function, a
  boundary function, a class receiver.
* **Evidence of the resolution** (a 300-tick Island run with `RUST_CALLS=0`, so every begin resolves; `callRecord` wrapped
  by `scripts/scenarios/global-calls.mjs`, which also asks the virtual lookup): `Global.Tick` resolved to `ScriptedPawn.Tick` 5,709 times where
  a virtual lookup would have found the running state's own `Tick` (`Standing` 4,654, `Startup` 455, `Attacking` 301, `Sitting`
  283, `Seeking` 16: a call to itself), to `Animal.Tick` 1,470 times for the fish (`Fishes.Wandering.Tick`), to `Robot.Tick`
  18 times; `Global.Bump` to `ScriptedPawn.Bump` 29 times (`Wandering`, `Sitting`).
* **Switch.** `GLOBAL_CALLS=js|verify|rust` (`?globalCalls=`, default rust). `js` keeps the JavaScript kind; `verify` runs in
  Rust and compares each resolution with the class chain (`lookupMember(cls, 'methods', name)`), throwing on a difference.
* **Checked.** State digests equal in `js`, `rust` and `verify` on the five baseline maps and the long route (Island, Wan Chai,
  bunker); with `SCRIPT_VM_CHECK=1 STATE_VERIFY=1 DISPATCH_VERIFY=1 GLOBAL_CALLS=verify` the five baselines match (5,960, 6,699,
  1,216 and 3,686 global resolutions verified on the four maps that have them) and `RUST_CALLS=0` matches on the Island.
  `validate-script-vm-interp` (539,597 checks), `validate-script-vm-x87`, `validate-scripted-pawn-tick`,
  `validate-pawn-tick-visibility`, `validate-pawn-alliance`, `validate-class-context-static-call`, `validate-script-state-queries` and the
  script-vm, script-state and walking unit tests pass. The two pawn-perception and locomotion Wine validators SKIP on this host.
* **Census** (Node, the census route over 1,200 ticks, inclusive times; before → after):

  | Map | `js effect 0x38` before | after |
  |---|---|---|
  | Island | `Tick` 8,881 calls 208.8 ms, `HitWall` 753 calls 8.6 ms, `BaseChange` 1 | `HitWall` 753 calls 10.3 ms, `BaseChange` 1 |
  | Wan Chai market | `Tick` 12,346 calls 349.0 ms, `Bump` 2 | none |
  | Area 51 bunker | `Tick` 4,698 calls 170.9 ms, `Bump` 12 | none |

  The rows vanish because the call is no longer a JavaScript node; the callee's own JavaScript statements keep their rows. The
  figure that matters is the tick (below).
* **Size.** Small, and unmeasured in the browser. Of a call's 23 µs inclusive in the census (Island: 208.8 ms over 8,881
  calls), almost all is the callee's own subtree, `ScriptedPawn.Tick` and what it calls, which was already running in Rust (the
  JavaScript VM entered it through `vm.resume`); what moved is the call's own overhead, 7 to 10 calls a tick. Node, the census
  route, three interleaved pairs per map without the stats timers (`GLOBAL_CALLS=js` → rust, tick mean / median): Wan Chai
  3.99 → 3.93 / 4.02 → 3.89 ms, Island 6.69 → 6.75 / 6.23 → 6.38 ms: inside the noise on both. With the stats timers on (one
  run each) the mean tick read 7.60 → 7.32 (Island), 4.75 → 4.42 (Wan Chai) and 5.85 → 5.72 ms (bunker), which counts the
  timers' own cost on the JavaScript path. Firefox runs the JavaScript side about twice as slowly; the browser A/B is the main
  session's.
* **Left.** `Global.HitWall` (a vector parameter: the `CALL` kind carries scalar parameters only, so a virtual or final
  `HitWall` call stays in JavaScript too) and `Global.BaseChange`, 754 of the Island's 9,635 calls.

## Progress

* **2026-11-06, the bunker's particle loop in Rust, and FindSpot's point check in the noncolliding FarMoveActor: meets the bar**
  ([below](#the-bunker-particle-loop-2026-11-06)). The slowest tenth of the bunker's actor phase held the ParticleIterator's render-iterator
  protocol, run for the root frame and again for every child frame (`rescan`): 0.85 ms a frame, 0.50 of it FarMoveActor of the
  ParticleProxy, which `far_move` declined because the proxy is `bCollideWorld` (a zero extent: FindSpot is one point check on the world model).
  The point check (`trace.rs point_clear`), the decision (`render.rs far_plan`) and the CurrentItem loop over the iterator's cells
  (`particles.rs particle_items`; a zone change goes back to JavaScript at its step) are in Rust, behind `?particleItems=` and `?farMove=`
  (`js`, `verify`; `nofit` is the baseline), with the proxy's per-record field reads hoisted in `sprite-scan.mjs`. Twelve interleaved Firefox
  pairs: the page's slowest tenth −1.10 ms (the bar is 0.5; 10 of 12 pairs), the mean −0.22, p95 −1.08, `p.sprites` and `p.actors` −0.10 each in
  every pair; digests unchanged; `verify` compared 4,042 runs in Firefox inline and 4,232 in Chromium's worker and 5,196 and 12,954 in Node, with
  129 and 112 particles put in solid refused alike. Code on branch `worktree-agent-a12ad8f2a7c5f5035`, committed and not merged.
* **2026-11-06, what the Rust VM still hands to JavaScript: ranked, no family near the bar, nothing built**
  ([below](#what-the-rust-vm-still-hands-to-javascript-2026-11-06)). `js_eval` is 1.08 ms a frame of the bunker's tick on average (0.90 in the
  rest, 2.65 in the slowest tenth). A per-tick census of what it evaluates (`scripts/script-vm-fallback-census.mjs`: self time by node, native
  and called function, the slowest tenth against the rest) puts 1.45 of the tenth's 2.55 ms gap (Node units) in the bodies of natives (Spawn,
  Destroy, AttachDecal, the pawn-navigation services), which no node translation touches. What is evaluation (calls with out, struct or vector
  parameters, context calls, `let`s the lowering leaves, `foreach` starts, `GetPlayerPawn`, `SetRotation`, small natives' call glue) is a pool of
  0.83 ms a tick on the bunker (1.82 in the tenth) and 1.10 on the Island, in 566 and 394 rows, 14 of them holding half: `GetPlayerPawn` 0.08 to
  0.11 a tick, `SetHitColor` 0.07, the `CycleActors` start 0.06 to 0.07, `SetRotation`, `Trace`, the `let`s of name and struct fields (0.02
  each). The three largest rows are 0.21 (bunker) and 0.25 (Island), in Node's timer-inflated units: 26% of the bunker's pool, where the 0.3 ms
  mean-tick bar is 45% of it. No one family reaches it; the three with the seven unshipped host cuts (0.17) might, at a feature each in the Rust
  interpreter. Nothing built; the census scripts are the commit.
* **2026-11-06, the decal attach's surface finder and node gatherer, exact and cheaper** ([decals](decals.md#fast-surface-finding-2026-11-06)).
  The Rust `decal_attach` was the bunker's biggest single item in the slow tenth (0.8 to 1.1 ms of `find_surface`'s x87 leaves against 0.03 in
  the rest): `FindSurface` walks a coplanar chain of 451 nodes (1,616 vertex tests) an attach on the long route, each test about 31 `Ext`
  operations. Profile split of the bunker (Firefox inline, 60 s): `attachDecalSurfaces` 0.16 ms a drawn frame, `find_surface` and the `Ext`
  operations under it 0.11, `gather_nodes` 0.02, JavaScript glue 0.02. Both functions use their arithmetic for signs only, so a table of
  each polygon edge's plane (keyed on the nine input words, 16,384 entries, hit rate 99.8% on the bunker and 98.6% on the Island) and an
  f64 evaluation with a proven error bound (`|X| > 2^-44 * Q` decides, everything near zero or non-finite takes the x87 expression) replace
  them. `DECAL_FAST=off|on|verify` (`?decalFast=`, default on); the reference bodies are untouched. Firefox inline on the bunker,
  four interleaved pairs: mean tick 6.00 -> 5.51 ms (-0.49), slowest tenth 11.93 -> 10.58 ms (-1.35), page p50 13.0 -> 12.3 ms, p95
  22.3 -> 21.5 ms; all four pairs favor the new body in both figures (tick 5.47/5.83/5.33/5.41 against 6.08/5.90/5.99/6.04; slowest tenth
  10.64/10.95/10.30/10.42 against 12.69/11.58/11.66/11.77). The Island (two pairs) is within noise, 6.96 against 6.90 ms (its attach is 0.11 ms
  a frame). Digests unchanged in `on` and `verify` on the five baselines and both long routes, a Firefox inline `verify` run of 40 s on
  each map is clean, `validate-decal-fast.mjs` (12 million generated cases against the x87 expressions) and `validate-decal-attach`
  pass, and so do the Chromium worker-mode decal validators (`validate-decals-play`, `validate-decal-vertices-play`). Profile after the change
  (Firefox inline, bunker, 60 s, names from a non-stripped build): `attachDecalSurfaces` 0.16 -> 0.10 ms a drawn frame, of which the Wasm
  `decal_attach` 0.07 (the edge-table lookups `fast::edge` 0.02 self, `fast::find_surface` 0.01, trace and the grid's `Ext` operations
  the rest) and JavaScript 0.03 (`followDecalTracker` with its `setRotation` and the tracker's `rotation` reads 0.02). In the slowest tenth
  the decal rows are `fast::edge` 0.18 ms, `fast::find_surface` 0.10, the grid's `Ext::add` and `Ext::rounded` 0.05 each, `setRotation` 0.07,
  `followDecalTracker` 0.03 (about 0.5 ms against 1.2 before). Left, each under the 0.5 ms bar: the table lookup itself (a 1.2 MB table
  read at random; a smaller key compare or a prefetch order is the lever), `setRotation` per mover surface per attach, and the
  16-cell grid's `Ext` work on a Shadow (MultiDecalLevel 4).
* **2026-11-06, the JavaScript imports the batch still calls: profiled, one change built, not merged** ([below](#import-cuts-not-merged-2026-11-06)).
  `js_move_riders`, `js_walk_prelude`, `js_object` and `js_tick_refresh` add up to about 1.1 ms of the Island's tick (the first three 0.5 ms of
  the bunker's, 1.5 ms in its slowest tenth), but each is a different thing and none is an invalidation the way the bunker's receiver epoch was, except
  the rider table (dropped by every `CompactActors` shift). That one and `GetPlayerPawn` (42 calls a tick through the whole native
  chain) were cut exactly (digests equal, verify modes clean); Firefox inline, four interleaved pairs each: bunker mean tick
  5.64 → 5.50 ms, slowest tenth 11.07 → 10.77; Island 6.58 → 6.54 and 9.77 → 9.78. Under the 0.5 ms bar: the code is on branch
  `import-cuts-unshipped` (b1f7e186), master unchanged.
* **2026-11-06, the bunker's slow tenth: seven exact host cuts, under the bar, not merged**
  ([below](#bunker-slow-tick-cuts-seven-switches-not-merged-2026-11-06)). `js_tick_resume` and `js_tick_state` hold no JavaScript around the Rust
  bodies (every frame on the path under 0.02 ms: their +0.8 ms is the state code's content). Cut exactly, behind switches: the rider table and
  `GetPlayerPawn` (b1f7e186), `compactScriptActors`' reads (`level_flagged`), the Errors `PlaySound`'s graph reads threw, `followDecalTracker`'s
  rewrites, `Client.Decals`' field-list rebuilds and `ReadInput`'s. Digests unchanged, verify modes clean in Node and Firefox. Firefox inline,
  four interleaved pairs: mean tick 5.40 -> 5.23 ms, slowest tenth 10.12 -> 9.85, page p95 20.5 -> 20.0: under 0.3 and 0.5 ms. Code on
  `bunker-cuts-unshipped`.
* **2026-11-06, the tick's reads of other objects in Rust** ([rust-core.md](rust-core.md#november-6-the-ticks-reads-of-other-objects-in-rust-implemented),
  [the player's tick](script-player-tick.md#what-the-players-tick-costs-in-firefox-2026-11-06)). The step began as "the player's tick and the
  level's host work" (1.1 to 1.3 ms); the Island profile showed the player's tick spread over many parts of 0.03 to 0.6 ms, and under the
  NPCs' batch three small JavaScript imports (`js_event_gate` 0.37 ms a frame, `js_tick_zone_time` 0.37, `js_tick_owner_ticked` 0.16, mostly
  `runtime.instance()`, the tick's largest leaf at 0.51). They answer from the images and a copied zone table now (`TICK_READS`,
  `?tickReads=`, verify compares every answer). Firefox inline, the Island, six interleaved pairs: mean tick 7.00 → 6.55 ms (-0.45), slowest
  tenth 10.39 → 9.81 ms (-0.58), page p50 13.67 → 13.33 ms, p95 20.67 → 20.00 ms; five of six pairs favor Rust. That is a little under the
  0.5 ms bar for the mean tick. Digests equal on the five maps and the long route, in `js`, `rust` and `verify`.
  What remains in the batch's imports (Island profile after the change): `js_walk_prelude` 0.46, `js_object` 0.32, `js_move_hash` 0.18,
  `js_move_riders` 0.18, `js_tick_refresh` 0.17 (each event the Rust tick runs ends in a state refresh that needs the instance's
  bindings, poison and field table), `js_step` 0.16, `js_tick_physics` 0.12.
* **2026-11-05, global function calls** ([above](#global-function-calls-run-in-rust-2026-11-05)). `Global.Tick(...)` and the
  other EX_GlobalFunction calls run through the Rust call path (`GLOBAL_CALLS`, `?globalCalls=`). Node census: the `0x38` rows of
  the three maps vanish except the Island's 753 `HitWall` calls; digests equal in all modes. Node tick means are
  unchanged within noise (Wan Chai 3.99 → 3.93 ms, Island 6.69 → 6.75 ms, three interleaved pairs each); the browser A/B is open.
* **2026-11-05, the actors phase's host plumbing** ([actors](firefox-actors-phase.md#host-plumbing-2026-11-05-second-pass)). Three of
  the four cheap candidates, behind `?actorPlumbing=` (`js` keeps the reference): plain hidden records that follow a hidden record are
  not sent (97% of the Island's records; the equivalence is now established, with the one case the first pass missed, a binding only the
  child frames draw), the `mesh_reads` pair table is kept between frames, and the moving brushes' reads are one Rust pass that skips
  an unchanged mover (`Update` with the words the tracker holds is a no-op). The Rust pack of the Setup candidates was dropped: the
  candidates live in the occlusion kernel's memory, not the object image's, and the copy is 0.03 ms of `packDynamics`' 0.29. Firefox
  inline, three interleaved pairs each, `p.actors`: Island 2.88 → 2.51 ms, Airfield 2.91 → 2.31 ms (the page's half 0.52 → 0.26 and
  0.56 → 0.21); page p50 about 1 ms lower on both. Snapshots hash the same at every frame on four maps, the five state digests hold, and
  `verify` and the page draw-state and pixel comparisons pass.
* **2026-11-05, the actor iterators** ([iterators](script-iterators.md#the-class-test-in-rust-2026-11-05)). `AllActors`' and
  `RadiusActors`' class tests run in the Rust core's `cycle_scan`. Firefox inline on the Island, three interleaved pairs: the slowest tenth
  of ticks 11.63 → 10.72 ms, the mean tick 7.59 → 7.33 ms, page p95 23 → 22 ms.
* **2026-11-05, DestroyActor's Owner/Touching scan** ([destroy](script-destroy.md#browser-adapter-implementation)) in Rust
  (`destroy_scan`). Area 51 bunker, Firefox inline: run third in its pairs, the mean tick read 6.48 → 6.87 ms and the slowest tenth
  13.26 → 12.88 ms. Run first, they read 6.92 → 6.41 and 14.09 → 13.12 ms. Taken together, the mean tick is about unchanged and the
  slowest tenth is 0.4 to 1.0 ms shorter.
* **2026-11-05, step 3: volumetric fog's uploads** ([fog](volumetric-fog.md#uploads-2026-11-05)). A frame's fog maps go up as
  their tiles, not as whole atlas pages: Battery Park 8.3 MB a frame → 0.14 MB. Firefox inline, three interleaved pairs: Battery
  Park's page frame p50 24 → 20 ms and p95 28 → 24 ms; the Bar's p50 12 → 9 ms and p95 14 → 11 ms. Then the fogged-surface test,
  `texels.some(Boolean)` called back per byte, became a word loop: Battery Park's fog phase 2.45 → 1.25 ms and its page frame p50
  20 → 17 ms.
* **Where the four step 0 maps stand** (2026-11-05 ~21:30, master 6b977252, one headless Firefox session each on the census route,
  against step 0's sessions at 9283543f, which ran under the Gecko profiler, so this leans slightly in the later runs' favor):

  | Map | page p50 | page p95 | tick | slowest tenth of ticks |
  |---|---|---|---|---|
  | Battery Park | 26 → 18 ms | 33 → 22 ms | 8.22 → 7.25 ms | 12.27 → 10.08 ms |
  | Wan Chai market | 17 → 13 ms | 24 → 19 ms | 9.15 → 7.18 ms | 13.04 → 10.22 ms |
  | Island | 19 → 17 ms | 26 → 23 ms | 9.02 → 8.06 ms | 13.34 → 11.19 ms |
  | Area 51 bunker | 14 → 16 ms | 26 → 25 ms | 6.60 → 6.80 ms | 14.31 → 13.72 ms |

  The bunker has not moved: its slow frames are spawning, `js_eval` fallbacks and state code. The headed frame-time set (the rows'
  verdict) is still to be taken.
* **2026-11-05, perception's light checks direct in Rust: tried, not merged.** A worker made `percep::light_level` call
  the collision hash's `lc_line` itself (`hash::light_line`, `LIGHT_CHECK`; branch worktree-agent-a00ec61ffd7da6914, commit
  98a405e9). The light-check imports fell to almost none (Island 4,673 → 0, Wan Chai 17,253 → 2 per 1,500 ticks), digests and verify
  held, and the perception validators passed. Firefox inline, three interleaved pairs:
  * Battery Park: the mean tick 6.95 ms with the imports, 7.27 ms without them, slower in every pair whichever arm ran first;
  * Wan Chai: unchanged (7.18 and 7.22 ms).

  The per-light-level preparation (`js_light_prepare`: the world model and the query's filter context) likely costs more than the
  line checks it saves. Left on its branch. The tail on Battery Park is elsewhere.
* **2026-11-06, spawn and destroy: the cost was the invalidation they cause, not their bodies** ([below](#spawning-and-destroying-the-cost-is-the-invalidation-2026-11-06)).
  Attaching or binding an object that has no handle yet no longer advances the receiver epoch (`?epochScope=global` keeps the
  old behavior: 4,230 of 4,356 advances in 1,200 bunker ticks were of that kind, and each made the next pass re-describe every actor in
  JavaScript), and the three Rust copies of `Level.Actors` are rewritten only where a slot changed (`?handleMirror=js` keeps the full
  rebuild). Firefox inline on the bunker, eight interleaved pairs: the slowest tenth of ticks 12.45 → 11.77 ms (seven pairs of
  eight better), the mean tick (6.15 → 6.18) and the page p50/p95 unchanged within the sessions' spread. Digests, verify modes, the spawn, destroy, cleanup, window and conformance
  validators and `npm test` hold.
* **2026-11-06, the HUD bundle: `w.hud` down 0.47 ms on the Island and 0.78 ms on the bunker** ([below](#the-hud-bundle-2026-11-06)): the window
  tree's walk, the plain window events, the Text and Button draws and `DrawText` run in Rust; the references stay behind `?windowDraw=js`.
* **2026-11-05, the HUD phase: no family reaches 0.5 ms** ([below](#the-hud-phase-2026-11-05)). Firefox's `p.hud` holds the
  simulation's HUD paint as well as the page's draw. Firefox's excess over Chrome is 0.7 to 1.0 ms, spread across about 95 script
  events a frame. No port was made; the profiling tools are in `scripts/` (gecko-phase.mjs, gecko-phase-diff.mjs,
  hitch-phase-means.mjs, wasm-names.mjs, hud-census.mjs).
* **The frame-time set, headless Firefox, 2026-11-05 ~23:00** (master df9dcc3d, `frame-time-set.mjs --browser firefox`, page frame
  from 5 s after the map; headless, so the page frame stands in for the row's drawn interval):

  | Map | page p50 | page p95 | tick | actors | HUD | render |
  |---|---:|---:|---:|---:|---:|---:|
  | Training | 9 | 12 | 3.4 | 1.1 | 2.3 | 0.3 |
  | Island | 16 | 23 | 7.6 | 2.9 | 2.4 | 1.7 |
  | Bar | 9 | 12 | 4.3 | 1.0 | 2.3 | 0.5 |
  | Battery Park | 17 | 21 | 6.9 | 2.6 | 1.5 | 2.6 |
  | Airfield | 18 | 21 | 6.9 | 3.0 | 2.4 | 1.1 |
  | Wan Chai market | 14 | 19 | 7.2 | 2.6 | 2.3 | 0.9 |
  | Ship | 12 | 15 | 5.3 | 1.7 | 2.2 | 0.8 |
  | Chateau | 11 | 13 | 4.3 | 2.0 | 2.2 | 0.9 |
  | Everett | 8 | 10 | 3.7 | 1.8 | 1.2 | 0.7 |
  | Area 51 bunker | 14 | 23 | 6.1 | 2.7 | 2.7 | 1.5 |

  Five maps are still over 16.7 ms at p95: the Island and the bunker by about 6 ms, Battery Park and the Airfield by 4, Wan Chai by 2.
  What is left in the tick is spread thin. A new profile of the Island's and the bunker's slow ticks (master df9dcc3d) shows on the
  bunker spawning (+0.8 ms), the decal attach in Rust (+0.8) and destroying (+0.4); everything else is under 0.3 ms per family. The
  HUD and actors phases have no family at 0.5 ms either ([HUD](#the-hud-phase-2026-11-05), [actors](firefox-actors-phase.md)). The
  remaining gap is a programme of sub-5% steps, the Rust core's long road (the player's tick, window-event dispatch, the
  native-heap path, x87 fast paths), not one more family.
* **The frame-time set again, 2026-11-06 ~04:40** (master 84972800: the actors host plumbing, the laser proxy fix and the HUD bundle
  since the set above; same command and route; headless, indicative). Page frame p95 (p50), ms, with the 23:00 p95:

  | Map | page p95 (p50) | 23:00 p95 | headless interval p95 |
  |---|---:|---:|---:|
  | Training | 11 (8) | 12 | 17.1 |
  | Island | 21 (14) | 23 | 33.2 |
  | Bar | 10 (8) | 12 | 17.1 |
  | Battery Park | 19 (16) | 21 | 17.1 |
  | Airfield | 19 (15) | 21 | 17.1 |
  | Wan Chai market | 18 (12) | 19 | 17.1 |
  | Ship | 13 (10) | 15 | 17.1 |
  | Chateau | 12 (10) | 13 | 17.1 |
  | Everett | 10 (8) | 10 | 17.1 |
  | Area 51 bunker | 23 (13) | 23 | 33.2 |

  On the synthetic 60 Hz clock, eight maps keep every frame at p95; the Island and the bunker drop to 30 Hz at p95. Five maps are
  still over 16.7 ms at page p95 (the Island by 4 ms, Battery Park and the Airfield by 2, Wan Chai by 1, the bunker by 6). The row verdicts
  (7.2.2, 7.2.4) need the headed set on a visible window.
* **The frame-time set at midday, 2026-11-06** (master e43007c9: since the 04:40 set, the tick reads, the receiver epoch per identity
  and the Level.Actors handle mirror, the fog restore and byte copies, and the exact fast decal attach; same command, headless,
  indicative). Page frame p95 (p50), ms, against 04:40, and the headless drawn interval p95:

  | Map | page p95 (p50) | 04:40 p95 | headless interval p95 |
  |---|---:|---:|---:|
  | Training | 11 (8) | 11 | 17.1 |
  | Island | 20 (14) | 21 | 17.1 (was 33.2) |
  | Bar | 10 (8) | 10 | 17.1 |
  | Battery Park | 19 (16) | 19 | 17.1 |
  | Airfield | 19 (15) | 19 | 17.1 |
  | Wan Chai market | 16 (12) | 18 | 17.1 |
  | Ship | 13 (10) | 13 | 17.1 |
  | Chateau | 12 (10) | 12 | 17.1 |
  | Everett | 9 (8) | 10 | 17.1 |
  | Area 51 bunker | 22 (13) | 23 | 33.2 |

  On the synthetic 60 Hz clock nine maps keep every frame at p95; the bunker still drops to 30 Hz at p95. Four maps are over
  16.7 ms of page p95 (the bunker by 5 ms, the Island by 3, Battery Park and the Airfield by 2). The rows' verdicts still need the
  headed set.
* **The frame-time set, 2026-11-07 evening** (master 5303a2d6: since midday 2026-11-06, the combat tick, the actors layer in bulk,
  the Underground fog phase, the tick hand-backs, the moving lights and the Dockyard spawns and js_eval step; same command,
  `frame-time-set.mjs --browser firefox`, headless, indicative; runs in `.cache/perf/frame-time-set/ff-5303a2d6`). Page frame p95 (p50),
  ms, against midday 2026-11-06, and the phase means over drawn frames from 5 s on:

  | Map | page p95 (p50) | 11-06 midday p95 | tick | HUD | actors | render | fog |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | Training | 11 (8) | 11 | | | | | |
  | Island | 19 (13) | 20 | 5.94 | 1.87 | 1.90 | 1.87 | 0 |
  | Bar | 10 (8) | 10 | | | | | |
  | Battery Park | 19 (15) | 19 | 5.73 | 1.23 | 1.63 | 2.91 | 1.03 |
  | Airfield | 17 (13) | 19 | 4.95 | 1.75 | 1.78 | 1.02 | 0 |
  | Wan Chai market | 15 (10) | 16 | | | | | |
  | Ship | 11 (9) | 13 | | | | | |
  | Chateau | 11 (9) | 12 | | | | | |
  | Everett | 9 (7) | 9 | | | | | |
  | Area 51 bunker | 18 (12) | 22 | 4.97 | 2.01 | 1.75 | 1.48 | 0 |

  The headless drawn interval p95 is 17.1 ms on all ten maps (every frame on the synthetic 60 Hz clock, the bunker included, which
  dropped to 30 Hz at p95 before). Four maps are still over 16.7 ms of page p95: the Island and Battery Park by 2 ms, the bunker by 1,
  the Airfield by less than 1. Battery Park is the one whose median is also near the bound (15 ms). The rows' verdicts still need
  the headed set.
* **The frame-time set, 2026-11-07 night** (master 1d1f5758: since 5303a2d6, Battery Park at rest (the world root's matrix walk), the
  Firefox wasm gap (word arrays compared in line) and the HUD remainder (one HUD vertex buffer, string-local frames begun in Rust); same
  command, runs in `.cache/perf/frame-time-set/ff-1d1f5758`). Page frame p95 (p50), ms, against the evening set, and the phase means:

  | Map | page p95 (p50) | evening p95 | tick | HUD | actors | render | fog |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | Training | 10 (7) | 11 | | | | | |
  | Island | 17 (12) | 19 | 5.78 | 1.39 | 1.78 | 1.69 | 0 |
  | Bar | 9 (7) | 10 | | | | | |
  | Battery Park | 17 (13) | 19 | 5.18 | 0.91 | 1.48 | 2.07 | 1.02 |
  | Airfield | 15 (12) | 17 | 4.67 | 1.30 | 1.73 | 0.90 | 0 |
  | Wan Chai market | 14 (10) | 15 | | | | | |
  | Ship | 11 (8) | 11 | | | | | |
  | Chateau | 10 (8) | 10 | | | | | |
  | Everett | 9 (7) | 9 | | | | | |
  | Area 51 bunker | 17 (11) | 18 | 4.79 | 1.56 | 1.75 | 1.31 | 0 |

  Firefox's page clock reads whole milliseconds, so a p95 of 17 is just over the bound and 16 would be under it. The Airfield is under now;
  the Island, Battery Park and the bunker are at 17, one millisecond step over. The tick (4.8 to 5.8 ms) is still the largest phase on all
  three, then the actors layer (1.5 to 1.8) and, at Battery Park, the render (2.1).
* **The frame-time set on the 20 us clock, 2026-11-07 evening** (master e9ea7a5e: since 1d1f5758, the [unshipped bundle](#unshipped-bundle-2026-11-07)
  shipped; `frame-time-set.mjs --browser firefox --ff-prefs '{"privacy.reduceTimerPrecision":false}'`, so the page clock steps by 20 us and the
  figures are true milliseconds, not whole ones; runs in `.cache/perf/frame-time-set/ff-e9ea7a5e-fine`, read with
  `hitch-slow-frames.mjs --over 16.7`; no worker or other job ran on the host). **Every map's drawn-frame p95 is under 16.7 ms.** Page frame p95 (p50), ms:

  | Map | page p95 (p50) | frames over 16.7 (allowed) | tick | HUD | actors | render | fog |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | Training | 9.88 (6.56) | 10 (193) | | | | | |
  | Island | 14.04 (10.16) | 20 (185) | 5.05 | 1.21 | 1.61 | 1.31 | 0 |
  | Bar | 9.38 (6.50) | 7 (177) | | | | | |
  | Battery Park | 13.32 (11.00) | 43 (183) | 4.47 | 0.81 | 1.34 | 1.60 | 0.89 |
  | Airfield | 14.38 (11.26) | 59 (183) | 4.48 | 1.23 | 1.62 | 0.78 | 0 |
  | Wan Chai market | 12.28 (8.92) | 16 (178) | | | | | |
  | Ship | 10.26 (7.60) | 3 (178) | | | | | |
  | Chateau | 9.82 (7.74) | 4 (176) | | | | | |
  | Everett | 8.58 (6.50) | 4 (177) | | | | | |
  | Area 51 bunker | 14.30 (9.34) | 107 (182) | 4.17 | 1.38 | 1.52 | 1.02 | 0 |

  One session a map is one draw: the Island's 14.04 is a fast one. A control right after it on the same quiet host (`ff-e9ea7a5e-control`, the same
  session shape, the bundle's defaults against every bundle switch at its old body in one query, alternating, two pairs a map):

  | Map | arm | page p95 (p50), two sessions | frames over 16.7 | tick | render | audio |
  |---|---|---|---:|---:|---:|---:|
  | Island | bundle | 16.32 (10.92), 16.52 (10.88) | 110, 148 | 5.41, 5.49 | 1.45, 1.41 | 0.24 |
  | | old bodies | 17.14 (11.40), 18.30 (11.72) | 283, 519 | 5.62, 5.89 | 1.58, 1.69 | 0.41 |
  | bunker | bundle | 15.42 (10.06), 15.60 (10.16) | 123, 126 | 4.51, 4.60 | 1.13, 1.14 | 0.24 |
  | | old bodies | 17.32 (10.86), 15.84 (10.64) | 235, 141 | 4.80, 4.60 | 1.40, 1.30 | 0.40 |

  So the Island sits at about 16.4 ms, 0.2 to 0.4 under the bound, and over it in both sessions without the bundle; the early window (the
  first 20 s after the map) holds 11 to 15% of its frames over 16.7 against 30 to 55% before. The bunker is about 1 ms under. Not measured:
  the Mac, headed runs (row 7.2.2's own condition; the user asked for none during this work), more than two sessions a map.
* **Sessions late in a pair run slower.** In both bunker A/Bs, each session ran slower than the one before it in its pair, by about
  0.4 ms of tick: compare the arm that ran third with the same arm run first. An A/B that always runs its arms in the same order
  carries that drift into the difference. `hitch-ab.mjs` now alternates the order from pair to pair.
* **2026-11-07, the HUD remainder: `p.hud` down 0.48 ms on the Island and 0.42 ms on the bunker, page mean down 0.61 and 0.50 ms** ([below](#hud-remainder-2026-11-07)):
  the page's draw of the tile stream from one interleaved buffer (`?hudDraw=js|verify`, -0.40 and -0.36 ms) and Rust-begun script calls and window events with string locals
  (`?stringFrames=js|verify`, -0.09 and -0.06 ms of `w.hud`). Pixel-verified in Firefox and Chromium; digests, validators and `npm test` hold. `TraceLOS`, the three bodies
  that still make a frame, the console's PostRender and the per-run `renderScene` cost are left (0.1 to 0.2 ms each).
### Import cuts: not merged (2026-11-06)

Host measurement, then one exact change that did not reach the 0.5 ms bar. Master 15a7903c, headless Firefox 155 inline, the scan
route (`hitch-run.mjs --browser firefox --mode scan --god --seconds 60 --profile`), joined with `gecko-slow-ticks.mjs`,
`gecko-under.mjs` (`--anchor '^js_...'`) and the Node census (`SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_DETAIL=1`, `RIDER_STATS=1`, a V8
CPU profile of the long route). Runs are in `.cache/perf/imp/` (outside Git).

**What the four imports cost** (ms a drawn frame, from 5 s after the map; the slowest tenth of ticks against the other nine tenths;
the Island's tick is 11.67 against 7.09 ms in those groups, the bunker's 11.82 against 5.13):

| Import | Island rest / slow | Bunker rest / slow | Cause |
|---|---:|---:|---|
| `js_walk_prelude` | 0.41 / 0.83 | 0.15 / 0.27 | below |
| `js_object` | 0.32 / 0.63 | 0.23 / 0.73 | Island: `GetPlayerPawn`; bunker slow tenth: `Spawn` |
| `js_tick_refresh` | 0.16 / 0.16 | | below |
| `js_move_riders` | 0.17 / 0.28 | 0.12 / 0.55 | Island: the riders' own moves; bunker: the table's fill |

* **`js_move_riders` in the bunker is an invalidation.** The slow tenth's extra 0.43 ms is all `fillSlot` → `baseInstance` →
  `riderBaseInstance` / `baseLinkInstance`: the rider scan's table of direct Base reads (move-riders.mjs `baseTableFor`) was dropped at
  every advance of the base epoch and filled again, slot by slot over ~1,250 actors, at the next rider pass. In 1,500 bunker ticks the
  epoch advanced 25,402 times, 22,320 of them by `CompactActors` shifting one actor down (script-cleanup.mjs: one advance per moved
  slot, every tick a destroy leaves a hole), 826 by an attach's `installLinkFields` and 826 by its `restoreStorage`, 252 by
  `freeObject`; the rider pass saw 149 distinct epochs and 1,396 of its 1,423 full scans (1.77 million slots) followed an epoch change.
  The Island's `js_move_riders` is not that: the fill is 0.01 ms of it, the rest is the riders' moves (`moveSpawnedActor`).
* **`js_object` on the Island is `GetPlayerPawn`** (native 720): 50,818 calls in 1,200 ticks, 42 a tick, each through `nodeValue` →
  `rvNode` → the native's closure (a call object and an `evaluateArgument` closure) → `invokeNative`'s branch chain → the window host →
  `hostNative` → the `native` wrappers → `nativeCall` (the conplay layer first, which built the script's lowercased path string for
  every native) → the trigger resolver's five reads. About 5 us a call in Node (`js_object` held 283 ms of the long route's 1,200 ticks), 7.6 us in
  Firefox (0.32 ms a frame). The bunker's extra is `Spawn` and its object result.
* **`js_walk_prelude`** (the Island: 0.41 ms, every walking pawn at every tick) is the original's work done: `surfaceScan`
  (up to 36 line checks and the floor query, in the Rust kernel, about 0.27 ms in Node, memory-bound), then the `WalkTexture` event
  (0.135 ms in Firefox: `Pawn.WalkTexture` is a declaration without a body for these pawns, but the event runs through the JavaScript
  `dispatch` → `processEvent` → `eventLevelGate`'s two `readNamed`s → `lookup`), and the scan's inputs read back through the pawn
  view's named reads (`Location`, `Rotation`, the collision size, 0.05). There is no invalidation or rebuild in it; the cuts would be
  Rust's `WalkTexture` dispatch (dispatch.rs takes the tick's events with scalar arguments, not a texture and two vectors) and the
  scan inputs passed by the walk loop, which changes `js_walk_prelude`'s signature (every harness that instantiates the module lists
  its imports).
* **`js_tick_refresh`** (0.16 ms, every event the Rust tick runs) is `refresh`: `host(instance)` 0.07 (six reads over the instance, its
  poison, its image token and its native object), `bind` 0.04, `describe` 0.01, memory-bound and flat between the slow tenth and the
  rest. A skip needs the actor's receiver epoch and table version unchanged across the event (the invariant the level loop's descriptors
  rely on, checked by `LEVEL_LOOP=verify`), and the runaway count handed back first (`setScriptRunaway` is the import's other job, and
  the tick's JavaScript callbacks read it); not attempted.

**The change** (branch `import-cuts-unshipped`, b1f7e186, three pieces, each behind a switch with `js` the reference and `verify`):

* `RIDER_TABLE` / `?riderTable=` (default `kept`): base-epoch.mjs adds `cellEpoch` (the advances that can change what a read of some
  live actor's Base cell returns), `bumpBaseMoveEpoch` (CompactActors' shifts, a slot nulled or written: no cell changed) and
  `bumpBaseEpochFor(identity)` (a Base link installed by an attach, a storage restore, an image released: one actor's cells). The rider
  lists, the perception list and the Rust mirror follow the old epoch as before. The table follows `cellEpoch`, forgets the slots of
  the identities noted since its last use, and CompactActors moves its entries with the actors (`moveBaseSlot`, `cutBaseSlots`).
  `=verify` compares every slot kept with a fresh `fillSlot` at each scan: 1.76 million slots on the bunker's long route, no
  difference. Bunker, Node: the rider scan 91.3 → 21.2 ms over the long route.
* `PLAYER_PAWN` / `?playerPawn=` (default `direct`): `js_object` answers a zero-argument native 720 with the resolver `nativeCall`
  reaches (`triggerActions.getPlayerPawn`) when `invokeNative` and `hostNative` are the prototype's; the native registry
  (native-registry.mjs, checked in both directions by `test/native-registry.test.mjs`) lists the trigger step as the only dispatcher
  that routes 720. `=verify` also runs the old path and compares the handles. Island, Node: `js_object` 283 → 177 ms over the long
  route, mean tick 6.15, 6.17 against 6.32, 6.22 ms (two interleaved pairs).
* The conplay layer's script path string is built only for `PlaySound` (it was built for every native that reached it).

**Checked:** digests equal on the bunker (`ccd09a24aaaad820`) and the Island (`0b4d06c72afd1c1d`) long routes in the default, `verify`
and `js` modes; `test/rider-cache`, `rider-direct`, `move-riders`, `script-cleanup` and `native-registry` pass (53 tests). Not run
(the change is not merged): the other digests, the validators, `npm test`, a Firefox inline `verify` run, the Chromium worker.

**Firefox inline, four interleaved pairs each** (`hitch-ab.mjs --arms "new:,old:riderTable=js&playerPawn=js"`, 60 s scan route, the
order alternating; `hitch-ab-table.mjs`):

| Map | mean tick new / old | slowest tenth new / old | page p50 | page p95 |
|---|---:|---:|---:|---:|
| Bunker | 5.50 / 5.64 | 10.77 / 11.07 | 12.5 / 12.8 | 21.3 / 21.0 |
| Island | 6.54 / 6.58 | 9.78 / 9.77 | 13.3 / 13.3 | 20.0 / 20.0 |

The bunker's pairs (mean tick new / old): 5.69 / 5.80, 5.71 / 5.60, 5.50 / 5.44, 5.10 / 5.73; slowest tenth 11.06 / 11.41, 11.14 / 10.85,
10.76 / 10.69, 10.11 / 11.34. The Island's: 6.55 / 6.44, 6.46 / 6.69, 6.51 / 6.64, 6.64 / 6.56. Far under the 0.5 ms bar, and inside
the spread of the sessions. Why the profile overstated it: the rider fill is paid in the ~10% of ticks that follow a destroy or an
attach, so 0.4 ms there is 0.04 ms on the mean; and the import's inclusive time for `GetPlayerPawn` counts the resolver's reads and the
handle lookup, which stay.

(The cuts continue in [Bunker slow-tick cuts](#bunker-slow-tick-cuts-seven-switches-not-merged-2026-11-06): both pieces cherry-picked onto
master with five more, still under the bar together.)

**Left.** Every one of these four is a small share of a tick that is spread thin. The bunker's slow tenth is `js_eval` (3.62 against 0.83 ms a frame: the JavaScript calls `AttachDecal`, `DetachDecal`,
`SetHitColor` and the spawns), not these imports. A route to 0.5 ms from this list is translation of whole families, not cuts:
`WalkTexture` and the prelude's inputs in Rust, `GetPlayerPawn` as a Rust node over a host-maintained cell (no crossing), the
`refresh` skip; each is about 0.1 ms.

### Bunker slow-tick cuts: seven switches, not merged (2026-11-06)

The task: a bundle of host-plumbing cuts for the Area 51 bunker, the last map over 16.7 ms at page p95 (22 ms, p50 13). Bar for shipping: at
least 0.5 ms in the slowest tenth of ticks or 0.3 ms in the mean tick, from an interleaved Firefox A/B. The bundle measured 0.27 and 0.17 ms: under
the bar, so master is unchanged and the code is on branch `bunker-cuts-unshipped` (the rider table and `GetPlayerPawn` of `import-cuts-unshipped`
cherry-picked onto master 7db679d4, and the five cuts below in a second commit).

**The slow tenth, again** (Firefox 155 inline, headless, scan route, 60 s, master e43007c9; `gecko-slow-ticks.mjs` on
`.cache/perf/bunker-midday/{run.json,profile.json}`; 345 slow frames at `p.tick` 11.60 ms against 5.48 for the other 3,105). By the Rust core's
import, ms a frame, slow / rest / difference:

| Import | slow | rest | diff |
|---|---:|---:|---:|
| `js_eval` | 2.65 | 0.90 | +1.75 |
| JavaScript with no Wasm under it | 1.79 | 1.11 | +0.67 |
| `js_move_riders` | 0.68 | 0.17 | +0.51 |
| `js_tick_resume` | 0.49 | 0.03 | +0.46 |
| `js_object` | 0.55 | 0.21 | +0.34 |
| `js_tick_state` | 0.36 | 0.03 | +0.33 |
| `js_tick_physics` | 0.44 | 0.27 | +0.17 |

* **`js_tick_resume` and `js_tick_state` hold no JavaScript around the Rust bodies.** Under them the path is `callback` → `js_tick_*` →
  `processState` → `process` → `resumeFrame` → `resumeCompiled` → `resumeState` → `vm_statement`, and the self time of every frame on it is under
  0.02 ms (`gecko-under.mjs --anchor '^js_tick_resume'`). The 0.46 and 0.33 are the state code's content, in a few frames of the tenth: 0.28 of the
  0.46 is `callFunction` → `executeScript` → `resume` (script functions the Rust statements call through JavaScript because their callee has an
  out or struct parameter, or a native body) and the natives under them (`Spawn`, `AttachDecal`). Nothing to cut there but the content.
* **What the tenth adds, by subtree** (inclusive, slow minus rest): `execAttachDecal` +0.60 (the Rust attach 0.41, `followDecalTracker` 0.14),
  `spawnActor` +0.56 (the spawned actor's script events 0.30, construction 0.15), `moveActorRiders` +0.47 (all of it the table's fill),
  `cleanupDestroyed` +0.27 (`compactScriptActors` 0.17), the HUD tick +0.33, first-use lowering +0.17 (`loweringFor`: 286 of the 344 lowerings in a
  1,200-tick Node run are the first use of a function, 58 a missing field cell becoming known, none an operand-epoch advance), `PlaySound` +0.13,
  and collector work inside the frame: `GCSlice` 0.38 against 0.09 ms and `GCMinor` 0.27 against 0.08 (the tenth allocates more).
* The profile's `selectLodMesh` > `axis` > `updateProjectionMatrix` frames under `invokeNative` are mislabelled JIT frames of `spawnActor`'s
  callers (their callees are `processEvent` and `initializeObjectStorage`), not LOD code.

**The cuts**, each behind a switch with the JavaScript reference reachable (`js`) and `verify` (both, compared); the page's `?flag=` reaches the
simulation worker through `init` like the others, and `process-probe.mjs` now returns the worker's `DEUS_EX_*` switches (`switches`).

| Switch (env, `?flag=`) | Cut | Why it is exact |
|---|---|---|
| `RIDER_TABLE`, `riderTable` | b1f7e186: the rider scan's table of Base reads kept across `CompactActors`' shifts and an attach | [Import cuts](#import-cuts-not-merged-2026-11-06); `=verify` compared 1.76 million slots on the bunker's long route |
| `PLAYER_PAWN`, `playerPawn` | b1f7e186: `GetPlayerPawn` answered in `js_object` | as there (Island only) |
| `COMPACT_SCAN`, `compactScan` | `level.rs level_flagged` lists the slots of `Level.Actors` from `FirstDynamicActor` that are null, `bDeleteMe` or not answerable by the image; `compactScriptActors` starts at the first and reads `bDeleteMe` of the flagged slots only | an unflagged slot holds an actor whose image flag reads false, which is what `readNamed` returns (`level_settled`'s premise, `LEVEL_SCAN=verify`); the loop, the shifts, the epoch advances and the warnings are the same code (unit test: 200 random arrays, same result, same advances, reads only at flagged slots) |
| `SOUND_READ`, `soundRead` | `reflectedField` answers `undefined` for an object that is not an attached instance without calling `readNamed`, which threw out of `instance()` and was caught | `attachedInstance(x) === null` is exactly the case `instance(x)` throws; every PlaySound reads the level container's `DemoRecDriver`, `Model`, `Engine`, `Client`, `Viewports`, `Actor` that way, an `Error` and its stack (`SavedStacks::saveCurrentStack` 0.09 ms a frame in the slow tenth, 0.01 in the rest) each |
| `DECAL_FOLLOW`, `decalFollow` | `followDecalTracker` writes a mover's surface rotation words only when its rotation differs from the one last written for that mover to that model handle | nothing else writes the words after the upload (`decal_model_sync` writes words 0 to 2 of a surface record, the attach only reads 6 to 8); `=verify` compares the words in memory at every skip |
| `CONFIG_FIND`, `configFind` | `createNativeConfig`'s `findIn` kept per class and lowered name | the property tables are frozen constants; `Client.Decals` is read three times by every `AttachDecal` (the getter at `script-doors.mjs`), each time building the whole field list of `WinDrv.WindowsClient` (`flatMap`, `reverse`, `map`: 23.7 MB of the 1,000 sampled over the long route in the function alone) |
| `INPUT_FIELDS`, `inputFields` | `inputPropertyFields` (the CPF_Input properties `ReadInput` scales) kept per class | the linked class tables do not change once an object of the class exists; it walked every field of the player's class at every tick (0.05 ms of the rest frames) |

**Checks.** `bench-sim --render-feedback` digests unchanged in the default modes: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield
`46ed0d32ae5b56af`, Wan Chai `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, and the long routes (bunker `ccd09a24aaaad820`, Island
`0b4d06c72afd1c1d`). With `RIDER_TABLE`, `PLAYER_PAWN`, `COMPACT_SCAN`, `SOUND_READ`, `DECAL_FOLLOW` and `LEVEL_SCAN` at `verify`: the same digests
on the short bunker run and both long routes, no tick errors. A 40 s Firefox inline bunker run with those and `CONFIG_FIND` and
`INPUT_FIELDS` at `verify`: 2,507 drawn frames, no page error. `test/script-cleanup`, `script-native-config`, `rider-*`, `move-riders`,
`native-registry` and `script-sound*` pass (70 tests); `cargo` warning-free. **Not run** (the change is not merged): `npm test`, the family
validators, the Chromium worker (the switches reach it through `init`, and `processProbe().switches` reads them there; not exercised).

**Node effect** (V8 profile of the bunker's long route, ms over 1,200 ticks, defaults against every switch at `js`): `moveActorRiders` 170 → 78,
`compactScriptActors` 61 → 23, `cleanupDestroyed` 122 → 78, `soundField` 34 → 28 (V8 captures a stack cheaply, Firefox does not), the native-config
reads about 22 ms before the memo (not measured after it) and 50 MB less allocation.

**Firefox inline A/B**, four interleaved pairs (`hitch-ab.mjs --arms "new:,old:riderTable=js&playerPawn=js&compactScan=js&soundRead=js&decalFollow=js&configFind=js&inputFields=js"
--pairs 4`, 60 s scan route, god mode, order alternating; `hitch-ab-table.mjs`; sessions in `.cache/perf/bunker-cuts/`). ms:

| Pair | mean tick new / old | slowest tenth new / old | page p50 new / old | page p95 new / old |
|---|---:|---:|---:|---:|
| 1 | 5.23 / 5.45 | 9.46 / 10.39 | 12 / 12 | 20 / 21 |
| 2 | 5.20 / 5.39 | 10.80 / 10.21 | 12 / 12 | 20 / 20 |
| 3 | 5.15 / 5.33 | 9.34 / 9.89 | 12 / 12 | 20 / 21 |
| 4 | 5.36 / 5.42 | 9.78 / 9.99 | 12 / 13 | 20 / 20 |
| **mean** | **5.23 / 5.40** | **9.85 / 10.12** | **12.0 / 12.3** | **20.0 / 20.5** |

The mean tick is better in all four pairs (by 0.22, 0.19, 0.18, 0.06: 0.17 on average, the bar 0.3); the slowest tenth in three of four (0.93,
-0.59, 0.55, 0.21: 0.27 on average with a spread of 0.65, the bar 0.5). The page's p50 and p95 move by a half millisecond at most, inside the
sessions' spread. This is the finding of the first rider-table A/B again: the cuts are real, exact and small, and the bunker's gap to 16.7 ms at page p95
(20 ms here) is not host plumbing of this size.

**What is left, each over 0.1 ms and none exact for free:**
* the Rust decal attach (`decal_attach` 0.41 ms in the slow tenth, 53 us an attach in Node; the laser spots re-attach 4 to 6 times a tick: 4,681
  `AttachDecal` and 1,897 `ReattachDecal` in 1,200 ticks), with `fast::edge`'s table fills cold in a region the player has not been in;
* `followDecalTracker`'s per-mover `Rotation` reads (0.07 ms of the tenth: a `readNamed` for every tracked mover at every attach; skipping them
  needs a change signal from the movers' writes, or the image cell address held as the rider table holds the Base word's);
* spawns (377 in the long route, about 300 us each in Node, 54% of it the spawned actor's script events) and destroys (247 at 160 us);
* the HUD's `SetHitColor` (7,200 calls in 1,200 ticks, 11.7 us each in Node, a JavaScript call because of its `out BodyPart` parameter): Rust calls
  with struct out parameters would take it and the player's `ProcessMove` (75 us);
* `js_tick_refresh`: skipping it needs Rust to say that no JavaScript ran inside the event (a counter at the imports), not a key compared in
  JavaScript, which costs what the publication costs.

### What the Rust VM still hands to JavaScript (2026-11-06)

The task: rank the nodes and natives the Rust VM hands back to the JavaScript VM (`js_eval`, `js_object` and friends, then
`nodeEffect`/`evNode` in `script-vm.mjs`) in the bunker's and the Island's frames, and translate the largest exactly if an interleaved
Firefox A/B shows 0.5 ms in the slowest tenth or 0.3 ms in the mean tick. No translation was built: the largest rows are native bodies,
which a node translation does not touch, and the largest evaluation row is 0.08 ms a tick. The ranking and the tools are the product.

**Tools** (measurement only, behind `SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_TIME=1 [SCRIPT_VM_STATS_DETAIL=1]`; the default paths are
unchanged, `vm_run` and `vm_statement` take one `TIMED` test):
* `script-vm-rust.mjs`'s `timedCount` also keeps the **self** time of a key (inclusive minus the timed keys nested in it), and the Rust
  bodies' `vm_run` / `vm_statement` calls are timed keys of their own (`wasm <function>`), so a JavaScript call node's row is the call's
  glue and the callee's Rust statements are not in it.
* `scripts/script-vm-fallback-census.mjs` (a `bench-sim --scenario` that also drives the scan route) differences the tables around every
  `game.tick`, orders the ticks by wall time and prints each key's self time and calls a tick for the slowest tenth against the rest;
  `CENSUS_JSON=file` keeps every row. `scripts/script-vm-fallback-groups.mjs` folds the rows by native index, called function, statement op
  or Rust body (`--by diff|slow|mean`). `scripts/cpuprofile-under.mjs` splits a V8 `--cpu-profile` under one frame, cut at boundary frames.
  Run: `SCAN_WARM=300 SCAN_TICKS=1200 SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_TIME=1 SCRIPT_VM_STATS_DETAIL=1 node scripts/bench-sim.mjs
  --map 15_Area51_Bunker --warm 300 --ticks 1200 --render-feedback --scenario scripts/script-vm-fallback-census.mjs`. The runs'
  digests are the baselines' (bunker `ccd09a24aaaad820`, Island `0b4d06c72afd1c1d`; the short bunker run `764a7bdffd2ebe59`).

**By node kind, in Firefox** (`gecko-slow-ticks.mjs` on `.cache/perf/bunker-midday`, `--children '^evNode '`; ms a frame, slow / rest).
`js_eval` is 2.65 / 0.90. The callees of `evNode`: script calls through JavaScript (`compileCall` > `invoke`) 1.12 / 0.34, natives
(`compileNative` > `invokeNative`) 0.85 / 0.08, calls inside a context (`compileEv` > `compileCall`, `X.Func()`) 0.71 / 0.13, `let`s the
lowering leaves (`compileAssign`) 0.39 / 0.24 (0.19 / 0.18 of it `assignFieldOf`, the same in both groups: stores to fields the image does not
hold, the player's bound ones such as `EyeHeight`), the rest (`byValues`, `compileEv` > `compileNative`) under 0.1. Below them the callees' Rust bodies (`resume` > Wasm, 1.70 / 0.40 inclusive of
their own imports) and, by native: `execAttachDecal` 0.51 / 0.03 (the Rust attach is 0.41 of it), `spawnActor` 0.52 / 0.00 (the frames the profile
labels `selectLodMesh` > `axis` are its JIT code; 0.29 is the spawned actor's script events, in Rust), `destroyActor` 0.19 / 0.02, the
host-native chain (`hostNative` > the `native` callbacks, which `GetPlayerPawn` reaches) 0.22 / 0.06. The leaf `invokeNative` is 0.23 / 0.10.

**By identity, in Node** (the census; self ms a tick, slow tenth / rest, with calls a tick; the tenth is 120 of 1,200 ticks: 8.70 ms against
3.47 on the bunker, 10.18 against 5.13 on the Island, timer cost included; the Firefox `js_eval` is 0.73 to 0.84 of Node's sum). Sorted by what
the tenth adds on the bunker:

| What the Rust VM hands over | Bunker slow / rest | calls | Island slow / rest | calls | Kind |
|---|---:|---|---:|---|---|
| `Spawn` (native 278) | 0.59 / 0.01 | 3.4 / 0.0 | 0.04 / 0.00 | 0.1 / 0 | native body: construction, zone, collision view, the events' glue |
| `AttachDecal` (a native function) | 0.58 / 0.30 | 6.6 / 3.8 | 1.10 / 0.28 | 20 / 5.5 | native body; the Rust attach is 0.29 of the bunker's mean 0.32 |
| `Destroy` (279) | 0.23 / 0.01 | 1.4 / 0.1 | 0.00 / 0.00 | | native body |
| `AIPickRandomDestination` 709, `FindPathToward` 517, `actorReachable` 520 | 0.20 / 0.01 | 0.5 / 0.04 | 0.49 / 0.04 | 0.8 / 0.2 | native bodies (the search is in Rust; the services around it are not) |
| small natives: `Trace` 277, `SetLocation` 267, `IsInState` 281, `FMin`/`FMax` 173, 264, 184, 161, 195, 246, 259 | 0.39 / 0.17 | 46 / 30 | 0.58 / 0.21 | 89 / 39 | bodies of 2 to 12 us plus the call object |
| `let`s the lowering leaves: name fields (`FloorMaterial`), struct targets, strings, bound fields, values of two imports | 0.35 / 0.13 | 33 / 17 | 0.42 / 0.23 | 86 / 53 | evaluation, 40 shapes, none over 0.04 |
| `foreach` starts (statement `0x2f`: `CycleActors` 1002, `AllActors`, the others) | 0.15 / 0.07 | 11 / 9 | 0.30 / 0.11 | 56 / 28 | evaluation: an iterator object a start |
| `SetRotation` 299 | 0.13 / 0.04 | 52 / 15 | 0.06 / 0.03 | 24 / 9 | small native, 2 us a call |
| calls with out, struct or vector parameters and context calls: `ProcessMove`, `CheckBob`, `GetAugLevelValue`, `CalculatePlayerVisibility`, `SetCrosshair`, `SetCurrentValue`, `TakeDamage` | 0.19 / 0.06 | 12 / 7 | 0.14 / 0.08 | 11 / 7 | call glue, 8 to 30 us a call |
| `GetPlayerPawn` 720 | 0.10 / 0.08 | 20 / 18 | 0.18 / 0.10 | 69 / 39 | pure read, 2.5 to 4 us a call |
| `SetHitColor` (`out BodyPart` struct parameter) | 0.08 / 0.07 | 6 / 6 | 0.08 / 0.07 | 6 / 6 | call glue, 11.5 us a call; its body is 1 us |

The Rust bodies called through JavaScript (`wasm PlayerTick` 0.125 / 0.077, `Tick`, `ProcessMove`, the spawned actors' events) are the
content of those calls and are not counted above.

**The pool.** Without the native bodies that are content (Spawn, Destroy, AttachDecal, the navigation, conversation and combat natives)
every other JavaScript-evaluated node is 1.82 / 0.72 ms a tick on the bunker (mean 0.83, gap 1.10) and 2.10 / 0.99 on the Island (mean 1.10,
gap 1.11), in 566 and 394 rows; half of the mass is in 14 rows, whose largest are (bunker, mean ms a tick) `GetPlayerPawn` 0.08, `SetHitColor`
0.07, the `CycleActors` start (`cycleindex`) 0.06, `SetRotation(Rotator(Velocity))` 0.03, `Trace` 0.03, `FloorMaterial = GetFloorMaterial()` 0.02,
`IsInState` 0.02, `beamtrigger.Emitter.SetLocation` 0.02. A V8 profile of the same route (`bench-sim --cpu-profile`, 4.30 ms a tick) agrees:
everything under `nodeEffect` and `nodeValue` is 1.30 ms, 0.67 of it nested work (script calls 0.56, mostly `AttachDecal`'s Wasm; spawn
0.07; destroy 0.04) and 0.6 a flat tail of leaves, the largest `invokeNative` at 0.09 (two functions), then `fieldValue` 0.018, `operand` 0.016,
`byValues` 0.016. The glue of a script call through JavaScript (`callFunction` down to the callee's frame, all leaves) is 0.15 ms a tick,
`AttachDecal`'s JavaScript 0.04 of its 0.33, `spawnActor`'s own JavaScript 0.09 with no leaf over 0.006, as the
[spawn analysis](#spawning-and-destroying-the-cost-is-the-invalidation-2026-11-06) found.

**Why nothing was built.**
* The slow tenth: on the bunker its gap in JavaScript-evaluated nodes is 2.55 ms in Node, 1.45 of it natives' bodies (Spawn 0.58, AttachDecal
  0.29, Destroy 0.22, the navigation natives 0.19, conversation and combat natives 0.17) and 1.10 the whole evaluation pool, which is the glue
  of the tenth's small natives (52 `SetRotation` a tick) and calls. The natives' bodies are not Rust-VM nodes: their host code is already cut
  as far as it goes ([decals](decals.md#fast-surface-finding-2026-11-06),
  [spawning](#spawning-and-destroying-the-cost-is-the-invalidation-2026-11-06)). What a translation can take is the pool's 1.82 ms in the tenth
  (0.8 in Firefox's units at 60% removal, past the 0.5 bar), and that takes the whole of the 14 rows that hold half of it (about a dozen
  distinct features), not one family.
* The mean tick: the three largest evaluation rows, `GetPlayerPawn`, `SetHitColor` and the `CycleActors` start, are 0.21 (bunker) and 0.25 (Island)
  in Node's units. Each is a feature, not a cut: `SetHitColor` needs copy-in and copy-out of a struct lvalue in `call` with the codec's
  exactness (a Window handle and floats: NaN and bool-word bit patterns would go to JavaScript before any argument is evaluated; the other
  scalar `out` and vector parameters ride on the same path); `GetPlayerPawn` a Rust node over a host-maintained cell of the level's first
  viewport actor (`PLAYER_PAWN=direct` of `bunker-cuts-unshipped` already answers it in `js_object`, skipping the `invokeNative` chain); the
  `foreach` start the iterator family the [CycleActors note](rust-core.md#september-30-choosing-the-next-simulation-change) describes. Below
  them each row is under 0.03 on the bunker and 0.05 on the Island. The 0.3 ms bar (0.37 Node ms) is 45% of the bunker's pool, which the
  three do not reach even if they vanished (26%).

**Next, if the bar is to be met** (an experiment, not a step): the seven cuts of the previous entry (0.17 on the mean, 0.27 on the tenth) plus the
three features above, A/B'd as a bundle against all switches at `js`; expected at most 0.17 + 0.15 (Firefox ms) on the mean, which would be at
the bar, and each feature needs its own verify mode. The tenth stays where the natives' bodies put it: 8.70 ms in Node with 3.4 spawns,
1.4 destroys and 6.6 decal attaches a tick.

(That experiment is the next entry: it passed the bar.)

### The bunker bundle (2026-11-06)

The task: the [seven exact host cuts](#bunker-slow-tick-cuts-seven-switches-not-merged-2026-11-06) and the three Rust VM features the
[fallback census](#what-the-rust-vm-still-hands-to-javascript-2026-11-06) ranked largest, measured as one bundle on the Area 51 bunker
(the last map over 16.7 ms at page p95). Bar: 0.3 ms in the mean tick or 0.5 ms in the slowest tenth, from an interleaved Firefox A/B, all
the new switches on against all at `js`.

**What the bundle holds.** The two commits of `bunker-cuts-unshipped` (the shift-proof rider table and direct GetPlayerPawn of
`import-cuts-unshipped`, `compactScan`, `soundRead`, `decalFollow`, `configFind`, `inputFields`) cherry-picked onto master d746b817, and
three Rust VM features, each a lowered kind that transcribes the JavaScript VM's evaluation of the same node, with `js` (the
reference) and `verify` modes:

| Switch (env, `?flag=`) | Feature | How it is exact |
|---|---|---|
| `PLAYER_PAWN`, `playerPawn` (`rust` default, `direct`, `js`, `verify`) | GetPlayerPawn (native 720) as the Rust node `PLAYER_PAWN` 207: the handle comes from `PLAYER_PAWN_CELL` = [graph epoch, epoch the handle is valid for, handle, verify] (natives.rs `player_pawn`); `js_player_pawn` runs the resolver the `js_object` shortcut runs and fills the cell | the walk reads `level.engine.client.viewports[0].actor`, and `watchPlayerPawnGraph` (player-pawn-graph.mjs, installed by script-doors.mjs where it sets `playerPawnShortcut`) turns those five links into accessors that advance the epoch on every write (values, enumerability and identities unchanged; `test/player-pawn-graph.test.mjs`). Premises: `levelFor` is one level for every receiver in Play and no native object has an own `xLevel`; a viewport list changed in place is not seen, a chain that cannot be watched ends the cell's use (`playerPawnGraphWatched`) |
| `OUT_STRUCT`, `outStruct` (`rust` default, `js`, `verify`) | `HUDHitDisplay.SetHitColor(out BodyPart part, ...)` and every script call whose callee has `out` struct parameters of byte, int, bool, float or object members: `CALL_OUT` 208 with `P_STRUCT` arguments (interp.rs `call`, iter.rs) and `callSignature` (script-vm-lower.mjs) beside `functionSignature` | callFunction's order: arguments in turn, the struct copied in from its source (a local, or a SELF field the image addresses) member by member through the codecs (float `float_bits(float_of(w))` = `Math.fround`, object `live(handle)`, bool merged into its word), the callee, the outs back in reverse, also when a probe-masked callee did not run. A source the image cannot address sends the whole call to JavaScript before anything is pushed. `=verify` compares each copy, in and back, with `readCell`/`copyValue` member by member (floats by bits) |
| `FOREACH_START`, `foreachStart` (`rust` default, `js`, `verify`) | `foreach CycleActors(Class'X', out Actor, out int Index)` of a callee run as `S_FOREACH_CYCLE` 10 with the iterator in the run (`Iter`, iter.rs): the start, IteratorNext, IteratorPop and the Return check, over render.rs `cycle_scan_step` (the scan the JavaScript iterator already used) and the actor list `js_cycle_list` returns (`listFor`) | `createCycleActorsIterator`'s creation (cursor from `Index` when in range, bound `Actors.Num()`, steps 0) and `next()` (clear Actor, bound = min, scan, Actor and Index) step for step; an actor without a class row goes to `classIsA`. Lowered for a body with one foreach, in function code, no Return left in JavaScript; any other start is an `S_YIELD` and the JavaScript stack keeps that loop. `=verify` runs a shadow `createCycleActorsIterator` with the pure JavaScript scan beside every step |

**Checked.** `bench-sim --render-feedback` digests unchanged in the default modes: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`,
Airfield `46ed0d32ae5b56af`, Wan Chai `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, and the long routes (bunker `ccd09a24aaaad820`, Island
`0b4d06c72afd1c1d`, Wan Chai `25db7596647e2aeb`). Every long route and the short bunker run are also unchanged with all the bundle's switches
at `js` (bunker, Island) and at `verify` together with `SCRIPT_VM_CHECK=1` and `LEVEL_SCAN=verify` (bunker, Island, Wan Chai), no tick
error. What the verify runs compared (the host's counters, `script-vm-foreach.mjs` `counts`, `script-vm-player-pawn.mjs` `walks`):

| Long route | foreach steps | struct copies | GetPlayerPawn walks (verify) | walks (default) |
|---|---:|---:|---:|---:|
| bunker | 184,633 | 18,012 | 27,411 | 1 |
| Island | 327,750 | 18,012 | 71,252 | 1 |
| Wan Chai | 33,239 | 18,012 | 34,976 | 1 |

(No actor without a class row reached `classIsA` in any of them: the validator below covers that branch.) `cargo` is warning-free.

`scripts/validate-script-vm-interp.mjs` (156 kinds, 539,987 checks) gained the three kinds: the cell (current, stale, the verify word, a context
receiver, `SCRIPT_VM_CHECK`); struct out arguments over a local and over a SELF field for six value sets (a released object, `-0`, a denormal,
infinity, the extremes of the int, bools sharing a word with other bits set), the padding and neighbours untouched, the unaddressable
source going to JavaScript whole, two out parameters over one source copied back last first, an omitted argument, the call's value; and the
foreach against `createCycleActorsIterator` itself over a 11-slot array (null slots, an actor without a class row), five base classes, seven
start indices (in range, at the count, beyond it, negative) and three break points (105 loops), the yields (a re-entered run, no list, a host
receiver) and the Return with an iterator active. The statement kind it used for "unknown" (10) is now 11.
The families' validators pass: iterator-frames-play, play-hud, triggers, trigger-actions, triggerlight-animated, mover-push-play,
native-mover-push, rider-move-kernel, script-sound-* (4), decal-* (7), input-bindings, keypad, flagbase-iterators, native-config(-classes),
console-command; `test/player-pawn-graph.test.mjs` and `test/native-registry.test.mjs` (a new `index` comparison in the lowering had to keep
off the registry scan's pattern) pass.

**In the browsers** (`hitch-run.mjs --mode scan --god --seconds 40 --probe-switches`, which this step added: the DEUS_EX_* switches the
simulation realm holds, from `processProbe`): Firefox inline with every switch of the bundle at `verify`, 2,448 drawn frames and no page error;
Chromium in worker mode with the same switches, 2,657 drawn frames, no page error, and the worker's own `processProbe().switches` lists all nine, so
the page's `?flag=` reaches the worker through `init`; Chromium worker with the defaults, 2,660 drawn frames, no page error.

**Firefox inline A/B, bunker**, four interleaved pairs (`hitch-ab.mjs --arms "new:,old:playerPawn=js&outStruct=js&foreachStart=js&riderTable=js&compactScan=js&soundRead=js&decalFollow=js&configFind=js&inputFields=js"
--pairs 4 --prefix bunker --dir .cache/perf/bunker-bundle -- --browser firefox --map 15_Area51_Bunker --mode scan --god --seconds 60`; the order alternating; `hitch-ab-table.mjs`). ms:

| Pair | mean tick new / old | slowest tenth new / old | page p50 new / old | page p95 new / old |
|---|---:|---:|---:|---:|
| 1 | 4.97 / 5.59 | 9.08 / 10.52 | 12 / 13 | 20 / 21 |
| 2 | 5.47 / 5.38 | 9.96 / 11.03 | 13 / 12 | 21 / 23 |
| 3 | 5.27 / 5.68 | 9.86 / 10.56 | 12 / 13 | 20 / 22 |
| 4 | 5.04 / 5.56 | 10.13 / 10.22 | 12 / 13 | 21 / 21 |
| **mean** | **5.19 / 5.55** | **9.76 / 10.58** | **12.3 / 12.8** | **20.5 / 21.8** |

The bundle gains 0.36 ms in the mean tick (the bar is 0.3) and 0.82 ms in the slowest tenth (the bar is 0.5). The mean tick is better in three of
four pairs (0.62, -0.09, 0.41, 0.52), the slowest tenth in all four (1.44, 1.07, 0.70, 0.09). The page's p50 moves by half a millisecond and its p95 by a millisecond and a
quarter, inside the spread of the sessions (the bunker's p95 is still over 16.7 ms: 20.5 ms headless; the bundle is host plumbing of
one tick, not the whole gap).

**Firefox inline A/B, Island**, the same arms and route (`--prefix island`, `--map 01_NYC_UNATCOIsland`), four pairs. ms:

| Pair | mean tick new / old | slowest tenth new / old | page p50 new / old | page p95 new / old |
|---|---:|---:|---:|---:|
| 1 | 6.17 / 6.60 | 8.81 / 9.57 | 13 / 14 | 19 / 20 |
| 2 | 6.17 / 6.69 | 9.08 / 10.02 | 13 / 14 | 20 / 20 |
| 3 | 6.33 / 6.98 | 9.21 / 10.19 | 13 / 15 | 20 / 21 |
| 4 | 6.11 / 6.77 | 8.66 / 10.01 | 13 / 14 | 19 / 21 |
| **mean** | **6.20 / 6.76** | **8.94 / 9.95** | **13.0 / 14.3** | **19.5 / 20.5** |

The Island gains 0.56 ms in the mean tick and 1.01 ms in the slowest tenth, all four pairs better on both. The seven cuts alone measured
0.17 and 0.27 ms on the bunker in [their own A/B](#bunker-slow-tick-cuts-seven-switches-not-merged-2026-11-06); read across sessions (not
interleaved with this one), the three Rust features add about 0.2 ms to the mean tick and 0.5 to the slowest tenth there, more than the
census's Node units (0.21 ms a tick on the bunker) predicted for the three rows. A Rust CycleActors loop also replaces the JavaScript
iterator's steps (`js_iterator_next`; the host's counter says about 120 steps a tick on the bunker's long route and 220 on the Island's), not
only the start the census ranked. No arm-by-arm split was measured.

**Left.** The foreach still crosses once per step for the actor list (`js_cycle_list`: the level's array, `listFor`'s key test); an actor
epoch word Rust compares would take that import away. Callee runs only: a foreach in a run JavaScript enters again after every
statement stays on the JavaScript stack. `classIsA` for an actor the class table does not describe is a crossing (never taken in these routes).
The other `out` parameter shapes (scalars, vectors) ride on the same `P_*` path and are not lowered.

**Result.** The bundle meets both bars on the bunker (0.36 against 0.3 ms in the mean tick, 0.82 against 0.5 ms in the slowest tenth) and
the Island gains more. It is code on branch `worktree-agent-a53906c07b675a25f`, committed and not merged; the page p95 of the bunker stays over
16.7 ms in headless Firefox (20.5 ms), which the remaining host work (decal attach, spawns, destroys: [the list above](#bunker-slow-tick-cuts-seven-switches-not-merged-2026-11-06)) has to close.

### The collision hash reads the image (2026-11-05)

The perception and walking-prelude line checks ran in Rust, but the hash they ran in could not read the object image, so it
called JavaScript once per candidate actor (`candidate`), per joined hit (`isMover`) and per examined hit (filter). On
Wan Chai's scan route (1,500 ticks) that was 1,022,815, 45,098 and 116,623 crossings; they now number 7,014, 0 and 51
(the player's facade, which stays JavaScript, is 6,264 of the candidates). Details, the actor kinds and what each one
reads are in [the collision hash reads the image](collision-hash.md#the-hash-reads-the-image-2026-11-05).

* **How.** The level queries' hash moves into the runtime's interpreter instance once it exists (`collision.adoptRuntime`, the
  cells re-added in their first-add order, so every visit order is kept), where hash.rs answers: a live cylinder from the
  image's Location, CollisionRadius and CollisionHeight (spawned actors' collision views and map actors with live
  collision), a map actor that never moved from its serialized numbers while the image still holds the same floats, a mover
  brush's ToWorld from a memo keyed by the image's Location and Rotation, `isMover` and the filter's class flag from the
  lineage, and the filter's owner chain from one walk per query. Anything else, or any field the receiver table does not hold
  in the image as `readNamed` reads it, goes to the JavaScript import as before.
* **Switch.** `COLLISION_HOST=js|verify|rust` (`?collisionHost=`, default rust). `verify` runs every import beside the image's
  answer and throws on a difference.
* **Checked.** State digests equal in `js`, `rust` and `verify` on the five baseline maps and on the longer route (Wan Chai,
  Island, bunker; 7.8 million Wan Chai answers compared in `verify`); `validate-collision-kernel` (also with the hash in
  a runtime's instance, and after the move), `validate-trace-kernel`, `validate-tracked-collision`,
  `validate-brush-bounds-kernel`, `validate-native-walking-surface` (17 cases) and the unit tests pass.
* **Size.** The imports took about 0.5 ms a tick on Wan Chai, 0.3 on the Island and 0.2 on the bunker in Node (the figure counts
  the timers' own cost); the Firefox profiles showed 1.10 and 0.64 ms inclusive on Wan Chai's slow tenth and the rest. The
  browser A/B is not part of this step.
* **Left.** The player's cylinder (its facade); the perception light check still enters through
  `lightLineCheck` in JavaScript, which could now call `lc_line` from Rust directly; the filter's collision bits are read
  from the image only for an actor with a live or serialized cylinder.


**In Firefox** (merged on master with the iterator, destroy and fog changes; render fields renumbered: Touching 47, CollisionRadius
48, CollisionHeight 49, bProjTarget 50). Inline, the census route, three interleaved pairs, `?collisionHost=js` against the
default:
* Wan Chai: the mean tick 7.37 → 6.83 ms, the slowest tenth 10.36 → 9.62 ms;
* Battery Park: the mean tick 7.45 → 7.03 ms, the slowest tenth 10.15 → 9.86 ms, page p50 19 → 18 ms.

Chromium's worker mode on Wan Chai ran 60 s without a page error (60 fps headless, no gap over 50 ms). The merged tree's digests are
equal on the five maps, and `COLLISION_HOST`, `ACTOR_SCAN` and `DESTROY_SCAN` together in verify mode match on the long route of the
Island, Wan Chai and the bunker. The collision, trace, tracked-collision, brush-bounds, walking-surface, walk-loop, destroy, load,
travel, Play-frame and fog validators pass.
### The HUD phase (2026-11-05)

Headless Firefox 155, inline, the census route (`hitch-run.mjs --mode scan --god --seconds 60 --profile`), this tree at 6b977252,
Gecko profiles joined to the hitch log by `scripts/gecko-phase.mjs` (the samples under an entry function, ms per drawn frame from
5 s after the map). Runs and profiles are in `.cache/perf/hud/` (outside Git).

**What `p.hud` is.** In inline mode the frame adds the simulation step's time to the page phase of the same name (main.mjs
`drawFrame`: `framePhases[name] += ms`), so `p.hud` is the sum of two things the Chrome worker reports apart: `w.hud`, the
simulation's HUD paint (`sim-session.mjs hud`: `game.hud.commands`, the window tree's DrawWindow and PostDrawWindow script events,
then the console's PostRender; Galaxy's update runs inside it but is booked as `audio`), and the page's drawing of the command
stream (`hudRenderer.render`, hud.mjs, with the flash and console passes). The "about 1.1 ms in Chrome's worker" above is
only the second; the first is Chrome's `w.hud`.

| Map | Firefox `p.hud` | of it `w.hud` | page draw | Chrome `w.hud` + `p.hud` (2026-11-05 set) |
|---|---:|---:|---:|---:|
| Island | 2.48 | 1.84 | 0.64 | 1.00 + 0.43 = 1.43 |
| Bar | 2.47 | 1.81 | 0.66 | 1.18 + 0.53 = 1.71 |
| Ship | 2.27 | 1.73 | 0.54 | 1.05 + 0.50 = 1.55 |
| Area 51 bunker | 2.94 | 2.26 | 0.68 | 1.29 + 0.50 = 1.79 |

The page's drawing is within 0.2 ms of Chrome's (0.1 ms of it is the hitch log's GL wrappers, in both), so Firefox's excess,
0.7 to 1.0 ms, is the simulation half: 1.7 to 2.3 ms against 1.0 to 1.3, 1.6 to 1.8 times, the ratio of its other host JavaScript.

**Where the Island's 1.84 ms of `w.hud` goes** (Firefox, ms a frame, inclusive, so the rows overlap):

| Part | ms | What it is |
|---|---:|---|
| the window tree's draw (`host.draw`) | 1.60 | `paintWindows` → `drawTree` over about 46 windows, 95 script events a frame |
| of it: the script events (`processEvent`) | 1.22 | 70 of the events are `Extension.Window`'s empty DrawWindow and PostDrawWindow (a `return`); the rest are the object belt's ten slots, the augmentation display, hit, damage, compass and ammo windows |
| of those: the Rust VM's JavaScript callbacks (`js_eval`) | 0.64 | GC natives it does not run (`DrawText` 0.24, in the belt slots and labels), script calls it hands back (`DrawTargetAugmentation` with its `TraceLOS`, 0.37 with the other calls), 35 window width and height reads |
| of those: JavaScript around each event | 0.30 | `processScript`'s lookup, `processEvent`'s gates, frame locals and `destroyFunctionLocals`, `resume`'s run bookkeeping |
| of those: other imports and Rust itself | 0.28 | `js_bool`, `js_object`, `js_float` and tile emission 0.22; the bodies' own statements 0.06 |
| the window tree outside the events | 0.38 | native-heap reads and writes (about 15,000 a frame in Node's count; `readAt`, `absolute`, `byteIndex` and `writeAt` 0.2), GC push, pop and copy, the family draws |
| the console's PostRender | 0.22 | the player's and the console's PostRender events, with the canvas natives bound each frame |

On the bunker the same tree plus a computer terminal's text spends 0.55 ms in `gcDrawText` (0.24 on the Island) and 2.26 ms in
all; the rest matches the Island within 0.1 ms. `scripts/hud-census.mjs` counts a paint's events and the Rust VM's JavaScript
fallbacks in Node: the belt slots and the augmentation display's PostDrawWindow are each about 30% of the events' time. The
second is a final call to `DrawTargetAugmentation` that the lowering hands to JavaScript (`foreach Player.TraceActors`, string and
struct locals), run every frame whether or not the augmentation is active.

**Verdict: no family reaches 0.5 ms, so nothing is changed.** The most each could give is the whole of its time (a port saves a
part of it), on the Island and, where it differs, the bunker:
* `DrawText` and the GC state saves under it, in JavaScript: 0.24 (bunker 0.55). A Rust port of `gcDrawText` and `GetTextExtent`
  would save perhaps 0.15 (0.35).
* JavaScript around the events: 0.30, of which the 70 empty-bodied events are about 0.2. Skipping their bodies is the same
  behavior (the body is a `return`) only if the gates, the `scriptRuns` count and the parameter's handle are kept; the rest needs
  Rust dispatch of window events, as the tick events have.
* `DrawTargetAugmentation` as a JavaScript call: 0.24 to 0.37, the largest single script function. Lowering the call needs string
  and struct locals in a Rust frame block.
* The native-heap accessors (a string `kind` switch and a Map lookup per access): 0.2 to 0.3. A typed path saves about 0.1.
* The console's PostRender: 0.22; binding its canvas natives once saves under 0.1.
* The page's three.js draw of about 55 tile batches: 0.55. A direct GL submit (one buffer, one state setup) would save perhaps 0.3.

Together about 1.0 ms of the 1.8 to 2.3, a multi-step program (a Rust window-event dispatch with the GC natives and the tree's field
reads behind it), each step under the 5% rule alone. If the HUD is taken up, start with Rust dispatch of window events plus a
typed native-heap path: 0.3 to 0.4 ms for the two.

**Tools added** (host measurement only): `scripts/gecko-phase.mjs` (a profile's samples under any entry function, by import, child,
leaf, named frame or a top-down tree, over a run's drawn frames, or `--all` when the clock join is weak, as on the Bar),
`scripts/gecko-phase-diff.mjs` (two such results side by side), `scripts/hitch-phase-means.mjs` (a run's phase means),
`scripts/wasm-names.mjs` (a non-stripped module's names for `wasm-function[N]`), `scripts/hud-census.mjs`; and
`globalThis.__scriptVmStats` under `SCRIPT_VM_STATS=1`, the maps the census reads between resets.

### The HUD bundle (2026-11-06)

The HUD phase above found no family at 0.5 ms and named a program: Rust dispatch of the window events with a typed native-heap
path. This bundle took the first, widened it to the window tree's own walk and to `gcDrawText`, and measured the sum. Design,
evidence and checks: [the draw tree, the window events and DrawText in Rust](script-play-hud.md#the-draw-tree-the-window-events-and-drawtext-in-rust-2026-11-06).
Switch: `?windowDraw=js` (`WINDOW_DRAW=js`) keeps the previous path; `WINDOW_DRAW=verify` and `GC_NATIVE=verify` run the new
bodies beside the references.

**Order of the work, and why.** A Gecko profile of the Island after each step (`scripts/gecko-hud-categories.mjs`, ms a frame in
`paintWindows`, profiled, so about 1.2 times the unprofiled figures):

| After | `paintWindows` | JavaScript around events | tree + heap | `gcDrawText` | other |
|---|---:|---:|---:|---:|---:|
| before | 1.52 | 0.32 | 0.26 | 0.26 | 0.68 |
| tree and plain events in Rust | 1.28 | (in other) | 0.09 | 0.24 | 0.95 |
| + `DrawText` and its GC stack in Rust | 1.01 | | 0.09 | 0.04 | 0.88 |

The remaining 0.88 is the families' own draws (now also in Rust, the last commit), the four events whose functions have string
locals, `DrawTargetAugmentation` (a JavaScript call from the augmentation display's PostDrawWindow, 0.23) and the console's
PostRender (0.21, outside `paintWindows`).

**Interleaved A/B**, headless Firefox inline, `hitch-ab.mjs --pairs 3` (order alternating), `--mode scan --god --seconds 60`, the
tree at 6ce549a6 (the same code as the final one apart from `WINDOW_DRAW=verify`, which `log()` and one `verified` counter add),
`new:` against `old:windowDraw=js`. Means of the sessions' per-frame phase means (ms):

| Map | `w.hud` new | `w.hud` old | `p.hud` new | `p.hud` old | page p50 new / old | page p95 new / old |
|---|---:|---:|---:|---:|---:|---:|
| Island | 1.23 | 1.70 | 1.81 | 2.27 | 14 / 14.7 | 20.7 / 21.3 |
| Area 51 bunker | 1.37 | 2.15 | 2.06 | 2.84 | 14 / 15 | 21.7 / 24 |

* **Gain: 0.47 ms on the Island, 0.78 ms on the bunker, in `w.hud` and in `p.hud` alike** (each of the six sessions on the bunker is
  below each of the old arm's; on the Island the per-session ranges, 1.22 to 1.24 and 1.67 to 1.72, do not overlap). The bundle's
  bar was 0.5 ms on one of the two: met on the bunker, 0.03 short on the Island. The bunker gains more because its terminal text is
  drawn through `gcDrawText` (0.55 ms there before).
* The page frame follows by the HUD's share: p50 down 0.7 to 1 ms and p95 down 0.6 to 2.3 ms. Neither map is near 16.7 ms at p95.
* Earlier, after the first commit only (events, tree and DrawText; 2600c7ec), the Island's three pairs gave `w.hud` 1.35 against
  1.71 (a gain of 0.36 ms) and `p.hud` 2.00 against 2.28: the families' draws in Rust added another 0.11.
* In Node (`hud-census.mjs --time-only`, one paint with Galaxy's update): Island 1.95 → 1.30 ms; bunker 2.0 → 1.6 and 2.4 → 1.8 in two pairs run while a validator sweep loaded the machine.

**Not done, and what is left in the HUD** (all below 0.5 ms alone, as before): `DrawTargetAugmentation` and its `TraceLOS` as
JavaScript calls (0.23, they need string and struct locals in a Rust frame block, or a JavaScript cleanup after a Rust-begun body); the
four string-local window events (about 0.2 with their bodies); the console's PostRender (0.21); the bound window fields' reads
(`js_float` and `js_bool` together about 0.1 in the profiles, so the typed native-heap read the HUD phase proposed is worth
less than it looked once the tree left JavaScript: its accesses were the tree's, not the scripts'); the page's three.js tile draw.

### Spawning and destroying: the cost is the invalidation (2026-11-06)

Step 0 put `spawnActor` (+0.7 ms) and `destroyActor` (+1.0, then +0.4 after `destroy_scan`) in the bunker's slow ticks and asked
what JavaScript inside them a port to Rust would remove. A Gecko profile of the bunker (`hitch-run.mjs --mode scan --god
--seconds 60 --profile`, master d64b55bf; `scripts/gecko-slow-ticks.mjs` for the slowest tenth against the rest, and the new
`scripts/gecko-under.mjs` for the time under one named frame, with `--above` for its callers) gives, in ms a frame, slow tenth
minus the rest:

| Under | ms | What it is |
|---|---:|---|
| `spawnActor` | 0.76 | the six script events 0.36 (of which `AttachDecal` 0.16, the decal work, and the spawn the events themselves make), `constructObject` 0.21 (`initProperties` 0.13, the unique name 0.04), zone 0.06, collision view 0.05, gotoState 0.04 |
| `destroyActor` | 0.51 | `destroy_scan` 0.38; the Rust scan is 0.09 of it. The JavaScript under it is `computeReceiverInfo`/`receiverInfo` 0.22 and `handleOf` in `listFor` 0.04 |

The spawn's own JavaScript is a long tail of small bodies, none over 0.13. The destroy's is not in its body at all: it is the
**invalidation the spawns and the windows cause**, paid by whoever asks next.

* The receiver table (`receiver-epoch.mjs`) is valid while one global counter is unchanged, and the counter advanced on every
  `linkInstance` and every host binding. Constructing an actor binds its native header fields and its collision view, building a window one binding per native field.
  On the bunker's census route (Node, 1,200 ticks after 300 of warm-up) the counter advanced **4,722 times, 4,230 of them for an
  object that had no handle yet** (the construction of a spawned actor or of a window) and 126 for a freed one. Each advance made the
  next consumer re-describe every actor in JavaScript: 303,000 `receiverInfo` calls and 67,700 `js_tick_describe` calls in the 1,200
  ticks, among them `destroy_scan`'s walk over every slot and the perception natives' `Level.Actors` list, which also rebuilt
  `receiverInfo` for each slot.
* The three Rust copies of `Level.Actors` (the level loop's list, the render scans' list, the perception list) were rebuilt after every
  spawn or destroy as `handleOf(actors[i])` over the whole array (1,200 slots, 510, 414 and 67 rebuilds in the 1,200 ticks): a Map lookup
  on a cold identity for each slot, 0.26 ms of the slowest tenth against 0.06 for the rest.

**What changed**, both behind switches with the JavaScript behavior as the reference:
* `bumpReceiverEpochFor(identity)` (`receiver-epoch.mjs`): a table entry is per handle and a handle is allocated at the identity's first
  use and never reused, so an identity without one has no entry and no descriptor to invalidate; attaching an instance to it or binding
  one of its fields advances nothing. `EPOCH_SCOPE=global` (`?epochScope=global`) advances at every such event as before. In the 1,200
  ticks: 4,722 advances → 252, `receiverInfo` calls 303,485 → 82,579, `js_tick_describe` 67,681 → 1,935. The proof is by
  construction (entries are keyed by handle); the checks are the digests, `RECEIVER_VERIFY=1` (every entry compared with a fresh
  answer) and `LEVEL_LOOP=verify` (every descriptor).
* `HandleMirror` (`actor-handle-mirror.mjs`): each of the three consumers keeps the handles it last wrote and the identities they
  were for, and a rebuild compares each slot with the identity it held (a pointer compare) and calls `handleOf` for the slots that
  differ; a copy into the arena replaces the per-slot `DataView` write. A release of any handle (`releaseCount`) starts it over. The
  perception list also leaves unchanged slots alone when the receiver epoch has not moved (their `receiverInfo` would be the same
  by the epoch's own contract). `HANDLE_MIRROR=js` (`?handleMirror=js`) rebuilds every slot with `handleOf`; `=verify` checks the
  kept handles after each sync, and the perception list against a fresh build (`PERCEPTION_DIFFERENTIAL`'s `checkScan`).

**Profile after** (same route, one run each, so the slow tenth's workload differs a little; ms a frame in the slowest tenth):
`destroyActor` 0.54 → 0.19, `receiverInfo` 0.38 → 0.03, `handleOf` 0.26 → 0.04, all `listFor` 0.23 → 0.08. `spawnActor` is
0.76 → 0.64: the construction and events are untouched.

**Interleaved A/B**, headless Firefox inline, two runs of `hitch-ab.mjs --pairs 4` (order alternating; the second run started with
the old arm), `--mode scan --god --seconds 60` on the bunker, `new:` against `old:epochScope=global&handleMirror=js`,
`scripts/hitch-ab-table.mjs` (the frames drawn from 5 s after the map; the slowest tenth is by `p.tick`). ms:

| Run, pair | tick new / old | slowest tenth new / old | page p50 new / old | page p95 new / old |
|---|---:|---:|---:|---:|
| 1, 1 | 5.94 / 6.11 | 11.37 / 11.85 | 13 / 13 | 22 / 21 |
| 1, 2 | 6.14 / 5.76 | 11.74 / 11.53 | 13 / 12 | 22 / 21 |
| 1, 3 | 5.90 / 6.26 | 11.42 / 12.31 | 13 / 13 | 22 / 22 |
| 1, 4 | 6.18 / 5.82 | 11.79 / 12.80 | 13 / 12 | 22 / 23 |
| 2, 1 | 6.42 / 6.18 | 12.33 / 12.54 | 14 / 13 | 22 / 22 |
| 2, 2 | 6.57 / 6.58 | 12.42 / 12.75 | 14 / 14 | 23 / 23 |
| 2, 3 | 6.54 / 5.96 | 12.10 / 12.92 | 14 / 12 | 22 / 23 |
| 2, 4 | 5.70 / 6.51 | 10.96 / 12.91 | 12 / 14 | 21 / 23 |
| mean of run 1 | 6.04 / 5.99 | 11.58 / 12.12 | 13.0 / 12.5 | 22.0 / 21.8 |
| mean of run 2 | 6.31 / 6.31 | 11.95 / 12.78 | 13.5 / 13.3 | 22.0 / 22.8 |
| **mean of 8** | **6.18 / 6.15** | **11.77 / 12.45** | **13.3 / 12.9** | **22.0 / 22.3** |

* **The slowest tenth of ticks is 0.68 ms shorter** (run 1: 0.54, run 2: 0.83; seven pairs of eight better, the other 0.21 worse; the
  pair differences average -0.69 with a standard error of 0.23). A first A/B of the epoch change alone (three pairs) read 12.22 against
  12.64 (0.42), with the same sign. This meets the bundle's bar of 0.5 ms on the slowest tenth.
* **The mean tick and the page's p50 and p95 did not move beyond the sessions' own spread** (the mean tick is within ±0.3 ms between
  sessions of one arm; new is better in four pairs and worse in four). The change removes work that only the ticks after a spawn or a
  destroy paid, which is the slow tenth; the profile's rest-of-frames figures fall by only 0.03 to 0.05 ms. The bar's alternative (the
  mean tick) is not met.

**Checks.** Digests unchanged in the default modes on the five maps (Island 5adb254a07b1ed6f, Training 07816ec472f29b84, Airfield
46ed0d32ae5b56af, Wan Chai 80d27b37e0944d88, bunker 764a7bdffd2ebe59) and on the bunker's long route with `--render-feedback`
(`SCAN_WARM=300 SCAN_TICKS=1200 bench-sim.mjs --map 15_Area51_Bunker --warm 300 --ticks 1200 --render-feedback --scenario
.work/perf/scan-scenario.mjs`, ccd09a24aaaad820, both with `EPOCH_SCOPE=global`/`HANDLE_MIRROR=js` and with the defaults; without
`--render-feedback` the same run reads e7035a0b4d1da90a in every mode, so that flag belongs to the baseline). Both bunker runs clean
with `HANDLE_MIRROR=verify RECEIVER_VERIFY=1 LEVEL_LOOP=verify PERCEPTION_DIFFERENTIAL=1 RENDER_SCAN=verify LEVEL_SCAN=verify
DESTROY_SCAN=verify` (the standard run also `ACTOR_PLUMBING=verify`): the digests above, no errors, and 169 perception lists (65 more
than before, the incrementally rewritten ones) equal to a fresh build. A 60 s Firefox inline run with `?handleMirror=verify`: no error.
`npm test` 947 passed, 4 skipped, 0 failed. Validators: the spawn family (7), destroy (4: world-destroy, window-destroy,
property-destroy, cleanup-destroyed-live), cleanup (4), `object-handles`, actor-tick (2), render-scan, perception, the 92 window
validators, `level-tick`, `play-hud`, `stage3-training-conformance`, and 21 of the 22 conversation validators (including
`island-conversation`); `validate-conversations-census.mjs` was stopped after 27 minutes and is not counted.

**Not done, and what is left.** `spawnActor`'s own 0.64 is the construction (`initializeObjectStorage`: a loop over the class's
fields and a copy of the class image, `makeUniqueScriptObjectName`'s lookup), the zone and collision-view setup and the six script
events, whose Rust bytecode and `AttachDecal` are not JavaScript of the spawn; no piece is over 0.13 ms, and porting `construct`
means a Rust owner for `ScriptInstance` and its bindings. The mover rider tables (`move-riders.mjs`, `js_move_riders` +0.5 to
+0.7 ms in the slow ticks) are dropped at every `baseEpoch` advance, which CompactActors' index moves and each `freeObject` cause:
the next candidate here, not measured as spawn-induced.

### The bunker particle loop (2026-11-06)

The task: the Area 51 bunker (`15_Area51_Bunker`) is the last map whose page p95 is over 16.7 ms in headless Firefox inline mode (20 ms; the
[bunker bundle](#the-bunker-bundle-2026-11-06) left it there). A profile of its slowest tenth of frames **by the actor phase** (`p.actors`,
`gecko-slow-ticks.mjs --phase actors --under '^actors \(src/viewer/sim-session'`, `.cache/perf/bunker-actors`: 345 slow frames at 5.54 ms of
`p.actors` against 2.35 for the other 3,106) named the ParticleIterator's render-iterator protocol, run from the occlusion pass's per-frame
dynamics callback (`occ_frame_dynamics` → `childDynamics` → `rescan`), as the largest single addition: 1.21 ms inclusive against 0.27, and
`particleIteratorItems` 0.85 against 0.11. Bar for shipping: 0.5 ms in the mean of the slowest tenth of the page frame work (`animate`) or 0.3
ms in its mean, from an interleaved Firefox A/B with the digests unchanged and `verify` clean.

**Why the proxy's FarMoveActor was declined** ([particles](particles.md#why-the-proxys-farmoveactor-was-declined)). The ParticleProxy is `bMovable`
and `bCollideWorld` with CollisionRadius and CollisionHeight 0 (read from DeusEx.u; the live bunker proxies show the same). CurrentItem's
`FarMoveActor(proxy, Location, 0, 0)` therefore takes the original's FindSpot branch (`!NoCheck && bCollideWorld`) with a zero extent, and
`render.rs far_move` declined every `bCollideWorld` actor with NoCheck clear: each particle's move ran relocation.mjs (FindSpot → a point
check that builds a hit list → the encroachment check → SetActorZone, with the closures `relocationLevel` makes). In the slow tenth,
`particleIteratorItems` was 0.85 ms: FarMoveActor 0.50, `readIteratorState` (64 particle objects with their arrays on each call) 0.20, the
script `Init` 0.09, the Index writes 0.04. A frame on the bunker's scan route (the twelve new-arm sessions below, `--probe-switches`, 45,601
frames): one root scan and one child frame's rescan (`rescans` = `scans`), 1.24 non-frozen iterator runs (MaxItems 64: 64 steps each) and 18.4
particles moved, 0.027 particles deleted by a refused move (1,228 in all), and no step handed back to JavaScript (no zone change on that route).

**What was built** (details and evidence in [particles](particles.md#the-loop-in-rust-2026-11-06)):

| Switch (env, `?flag=`) | Feature | How it is exact |
|---|---|---|
| `PARTICLE_ITEMS`, `particleItems` (`rust` default, `js`, `verify`) | `particles.rs particle_items`: the CurrentItem loop over the iterator's cells and the proxy's image (Index, the proxy's DrawScale and ScaleGlow, FarMoveActor, DeleteParticle, the items); `script-particles.mjs nativeItems` takes a declined step as the reference does and the loop goes on after it; `sprite-scan.mjs` reads the proxy's DrawType, Texture and Style once for a run's records | the reference loop is `referenceItems` (today's code); `=verify` repeats every Rust run from the state before it with the recovered relocation body (`relocateSpawnedActor`) as FarMoveActor and compares the particles, `nextFreeParticle`, Index, the proxy's six written fields and the items; the records are compared with the per-item reads |
| `FAR_MOVE` (`rust` default, `js`, `verify`, `nofit`) | `render.rs far_plan`/`far_commit`: FindSpot's zero-extent case (one SinglePointCheck on the world model, `trace.rs point_clear`, the tracker's model while it lives) in the noncolliding FarMoveActor; returns 1 moved, 2 refused (the original's false, nothing stored), 0 JavaScript | `validate-trace-kernel` (78,798 points, 0 mismatches); `FAR_MOVE=verify` compares every Rust move against the JavaScript body; `nofit` is the core before this step (the A/B baseline) |

A zone change (SetActorZone runs script events), a nonzero extent, riders, collision bits, a Brush, a non-finite destination and a model the core
cannot read still go to JavaScript before any store. The script `Init(Camera)` and the Observer write keep their order. `cargo` is warning-free.

**Checked.** `bench-sim --render-feedback` digests unchanged: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai
`80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, and the long routes (bunker `ccd09a24aaaad820`, Island `0b4d06c72afd1c1d`, Wan Chai
`25db7596647e2aeb`). **bench-sim does not exercise the render iterators** (it calls `game.tick` and never the sprite scan), so these digests
only show that the `far_move` change (the FindSpot case, for other spawned actors' SetLocation) altered nothing; the iterator loop is covered by
the new `scripts/validate-particle-items.mjs`, which boots a map, holds the proxies as drawn, ticks, and after each tick runs SetupDynamics' scan and
rescans through `sprite-scan.mjs` in `js`, `rust` and `verify`, and compares a digest of every sprite record and of the iterators' and proxies'
end state:

| Run | sprite records | iterator runs | steps | particles moved | refused by FindSpot | handed back | verify compared |
|---|---:|---:|---:|---:|---:|---:|---|
| bunker, 240 ticks, 1 rescan | 34,991 | 4,780 | 305,504 | 33,022 | 0 | 416 | 5,196 runs, 33,438 records |
| bunker, 300 ticks, 3 rescans | 101,459 | 11,960 | 764,446 | 98,466 | 20 | 994 | 12,954 runs, 99,460 records |
| bunker, 240 ticks, two particles a tick put in solid every 10 ticks (`--inject 10`) | 3,838 | 4,780 | 305,920 | 2,920 | 129 | 0 | 4,780 runs |
| 02_NYC_Street, 240 ticks | 23,512 | 4,302 | 275,328 | 21,710 | 0 | 0 | 4,302 runs |
| 02_NYC_Street, `--inject 10` | 1,520 | 4,302 | 275,328 | 1,010 | 112 | 0 | 4,302 runs |

The digests of `js`, `rust` and `verify` are equal in every row (`8ef26156a3375408`, `aeb1df1bdd5ee8a2`, `1f85f6dae27349e7`, `0f1d56950a3b8be4`,
`01f196133c5df880`). In the browser, the bunker's scan route for 40 s with `particleItems=verify&farMove=verify` (`hitch-run.mjs --probe-switches`,
which now also prints the loop's counters, `iteratorStats` and the trace kernel's): Firefox inline 2,452 drawn frames, no page error, 4,042 runs and
258,688 steps compared; Chromium in worker mode 2,660 drawn frames, no page error, 4,232 runs and 270,848 steps compared, the worker's own
`processProbe` listing both switches (the page's flags reach it through `init`). `npm test`: 959 tests, 955 pass, 4 skipped, 0 fail
(`test/particle-items.test.mjs` is new). Validators: `validate-particles-play`, `-native-particles` (288 updates), `-native-relocation` (1,316 cases),
`-script-set-location`, `-iterator-frames-play`, `-render-scan-verify-play`, `-sprite-tiles-play`, `-collision-kernel`, `-trace-kernel` (157,117
cases, 0 mismatches), `-native-far-move-scene` (40 cases, 0 mismatches) pass.

**Firefox inline A/B, bunker**, twelve interleaved pairs in two runs (4 pairs on commit b0ca2c4e, 8 on dfc62117, whose runtime differs by counters
only) of `hitch-ab.mjs --arms "new:,old:particleItems=js&farMove=nofit" --prefix bunker -- --browser firefox --map 15_Area51_Bunker --mode scan --god
--seconds 60 --probe-switches` (headless, 60 s, the order alternating; sessions in `.cache/perf/bunker-particles/`; `hitch-ab-table.mjs` now has a
page-work mean and slowest-tenth column). The old arm is the code before this step: the reference loop and per-item reads, and the core without
FindSpot's point check. ms, new / old:

| Pair | mean tick | `p.sprites` + `p.actors` | page mean (`animate`) | **page slowest tenth** | page p95 |
|---|---:|---:|---:|---:|---:|
| 1 | 5.29 / 4.67 | 2.75 / 2.82 | 13.61 / 12.72 | 21.22 / 21.07 | 19 / 19 |
| 2 | 5.22 / 4.96 | 2.70 / 2.85 | 13.42 / 13.21 | 21.78 / 22.27 | 20 / 20 |
| 3 | 4.87 / 5.05 | 2.61 / 2.88 | 12.80 / 13.41 | 20.53 / 22.37 | 19 / 21 |
| 4 | 5.32 / 5.16 | 2.77 / 2.86 | 13.73 / 13.45 | 22.34 / 22.39 | 20 / 20 |
| 5 | 5.22 / 5.17 | 2.69 / 2.89 | 13.36 / 13.55 | 21.75 / 22.75 | 20 / 21 |
| 6 | 5.06 / 5.32 | 2.72 / 2.95 | 13.31 / 13.79 | 21.85 / 23.31 | 20 / 21 |
| 7 | 5.00 / 5.30 | 2.68 / 2.87 | 13.27 / 13.65 | 23.74 / 22.76 | 21 / 21 |
| 8 | 4.90 / 4.95 | 2.60 / 2.85 | 12.84 / 13.23 | 21.03 / 22.42 | 19 / 21 |
| 9 | 5.31 / 5.04 | 2.72 / 2.90 | 13.59 / 13.49 | 21.80 / 23.24 | 20 / 21 |
| 10 | 5.09 / 5.50 | 2.70 / 2.97 | 13.41 / 14.23 | 21.92 / 23.25 | 20 / 21 |
| 11 | 5.34 / 5.46 | 2.80 / 3.02 | 13.72 / 14.17 | 22.14 / 23.50 | 20 / 22 |
| 12 | 4.88 / 5.20 | 2.62 / 2.95 | 12.95 / 13.76 | 20.56 / 24.47 | 19 / 22 |
| **mean** | **5.13 / 5.15** | **2.70 / 2.90** | **13.33 / 13.56** | **21.72 / 22.82** | **19.8 / 20.8** |

Paired differences (new − old, 12 pairs, `.cache/perf/bunker-particles`, mean ± standard error, pairs where new is faster): `p.sprites` −0.10 ± 0.01 (12 of
12), `p.actors` −0.10 ± 0.02 (11), mean tick −0.02 ± 0.09 (7), **page slowest tenth −1.10 ± 0.35, median −1.33 (10 of 12)**, page mean −0.22 ± 0.15
(8), page p95 −1.08 ± 0.29 (8), p50 +0.08 ± 0.23. The second run alone (8 pairs, the final code): page mean −0.43 ± 0.11 (7 of 8), slowest tenth
−1.36 ± 0.46 (7 of 8). The first four pairs alone had read as noise (mean tick 0.22 worse, page mean 0.19 worse, slowest tenth 0.55 better): the
tick's difference is session spread (0.09 over twelve pairs), and only the two phases the change touches move in every pair.

**Inside the frame** (the same sessions, `iteratorStats` of `--probe-switches`, which times the scan and the rescans with `performance.now`): the scan costs
0.444 → 0.332 ms and a child frame's rescan 0.314 → 0.212 ms, 0.758 → 0.544 ms a frame; one child frame a frame (`rescans` = `scans`), 1.24
iterator runs a frame (scan and rescan together), 18.4 particles moved a frame. Gecko profiles of both arms (60 s each, `prof-new`/`prof-old`):
in the slowest tenth of `p.actors` (350 frames) that phase is 5.26 → 4.65 ms, `occ_frame_dynamics` 1.13 → 0.41 (against 0.27 and 0.24 in the other
frames), `particleIteratorItems` 0.88 → 0.14, and the collector work inside those frames halves (0.23 → 0.08 ms of GC frames). The trace
kernel's counters (`traceKernel` in the probe) show one tracked-model import in 60 s in both arms (38,746 nodes): the world base address the Rust
move asks for costs nothing.

**Result: merge-worthy.** The slowest tenth of the page's frame work falls by 1.10 ms (the bar is 0.5; ten of twelve pairs, median 1.33), the
mean by 0.22 ms (the bar is 0.3: reached by the second run alone, 0.43), the digests are unchanged and `verify` is clean in Node, Firefox inline
and Chromium worker mode. The bunker's page p95 falls from 20.8 to 19.8 ms and stays over 16.7 ms (headless Firefox).

**Left** (each under the bar alone):
* The script `Init(Camera)` of every iterator, run in every frame's SetupDynamics, is now the largest part of the protocol: `inRenderPass` +
  `processEvent` is 0.27 ms a frame (LaserIterator 0.16, with its `js_bool` import 0.11, ParticleIterator 0.09). The Rust VM hands a bool read
  back to JavaScript there (the `Owner.bFrozen` context read); lowering that node would take it, and belongs to the
  [fallback census](#what-the-rust-vm-still-hands-to-javascript-2026-11-06).
* `laserIteratorItems` and the laser proxies' own sprite bindings (`updateSprite` 0.52 ms in the slow tenth) are the same family and untouched.
* A handed-back step (a zone change) reads one particle through the arena and takes the reference path: 0.14% of the steps in the bunker's
  Node route (416 of 305,504), none in the scan route's 45,601 frames; a zone-change event for a proxy is the one case the core never decides.
* `trace.rs point_clear` and the Rust move run in doubles, like the JavaScript reference; the original's pass precision (24 bits) for a point
  exactly on a node plane is not measured ([render-pass precision](render-pass-precision.md)).

### Firefox slow-spot census (2026-11-06)

The fixed routes (the census scan, roam) never stood beside the Paris Club's two mirrors, where a Firefox-only upload trap held a player to
about 30 fps. `scripts/spot-census.mjs` looks everywhere instead: for every map it reads the placed navigation points from the map file
(`scripts/map-nav-points.mjs`: PathNode, PlayerStart, PatrolPoint, HidePoint, AmbushPoint, SpawnPoint), takes 40 by farthest-point sampling and
puts the player at each, at four headings 90 degrees apart (yaw 0, 16384, 32768, 49152), through `placeProbe` (`hitch-run.mjs --places`): 0.5 s
to settle, then 0.75 s of drawn frames from the hitch log. One session per map, headless Firefox inline, 1440x960, god mode, under the heavy
lock and an 8 GB scope; `--repair` measures again what a first pass could not. `--summary` and `--figures RUN.json` print the tables.

* **Coverage:** 75 maps, 11,485 views, 11,377 of them valid. Not measured: `00_Intro`, `99_Endgame1..4` (cinematics), `DXMP_*`, `Entry`, `DX`,
  `DXOnly`. Left out (108 views): 52 swimming, 24 dying, 3 paralyzed, 23 in a conversation that survived a second visit, 6 cut off by a stop.
* **Method fixes the first passes needed:** a ScriptedPawn that sees the placed player starts a conversation (`MeetTerrorist` on the Island,
  `MeetTobyAtanwe` in Everett, ...), after which the player is drawn from the conversation camera at every later spot (Everett: all 160 views of
  the first pass). `placeProbe` takes `endConversation`, which runs the script's own `DeusExPlayer.AbortConversation` before the move; a view
  that still ends outside `PlayerWalking` is measured once more and else left out. Esc does not end one (eight presses left the state as it was).
* **Where the slow views are:** 1,649 of the 11,377 are over 16.7 ms (page p50), on 47 of the 75 maps. **1,609 of them are led by `p.tick`**,
  39 by `p.fog` (10 at `02`, 11 at `04`, 18 at `08_NYC_Underground`), 1 by `p.mirrors`. 28 maps have no slow view.
  Table and per-map figures: `.cache/perf/spot-census/firefox-summary.md` (not in Git).

**The twelve worst distinct spots**, Firefox inline against Chromium (worker mode) for the same view (the Chromium census ran on the six
maps that hold them, after the fog fix below; Chromium's frame is the larger of the page's and the worker's p50):

| Map | Place | Yaw | Firefox p50 | Led by | Chromium | Cause |
|---|---|---:|---:|---|---|---|
| 09_NYC_Dockyard | 2623, 6205, 20 | 32768 | 46 | tick 24.2, actors 10.1 | 18.5 (worker) | simulation, also over 16.7 in Chromium |
| 02_NYC_Underground | -3946, 1158, -1000 | 0 | 44 | tick 26.8, hud 6.8 | 6.2 | NPC state: 13 ms in a single placement |
| 02_NYC_Underground | 645, -415, -361 | 32768 | 41 | tick 13.2, fog 12.4 | 16.1 (page) | fog kernel (below) |
| 02_NYC_Underground | -73, 636, -361 | 49152 | 41 | fog 14.6, tick 11.6 | 18.3 (page) | fog kernel (below) |
| 09_NYC_Dockyard | 3785, 6204, 20 | 49152 | 41 | tick 25.8, actors 7.3 | 13.6 | simulation |
| 12_Vandenberg_Cmd | -503, 7221, -2168 | 49152 | 41 | tick 23.3, actors 9.2 | 22.4 (worker) | simulation, over 16.7 in Chromium |
| 02_NYC_Underground | -75, 818, -360 | 49152 | 40 | tick 13.0, fog 11.6 | 16.1 (page) | fog kernel |
| 02_NYC_Underground | -358, 588, -361 | 49152 | 40 | fog 13.7, tick 11.5 | 16.6 (page) | fog kernel |
| 10_Paris_Metro | 4236, -3463, 167 | 32768 | 40 | tick 23.7, actors 6.1 | 13.2 | simulation |
| 09_NYC_Dockyard | 3205, 5639, 20 | 32768 | 39 | tick 22.6, actors 7.3 | 19.8 (worker) | simulation |
| 15_Area51_Page | 7897, -9941, -5675 | 16384 | 38 | tick 17.8, render 5.3 | 6.0 | NPC state |
| 02_NYC_BatteryPark | -4634, 3480, -312 | 32768 | 37 | tick 22.0, actors 5.3 | 9.2 | NPC state: 23 ms in a single placement |

**Classification.**
* **Simulation cost, known (the 1,609 tick-led views).** The tick is the families of the [tail profiles](#step-0-what-the-slow-ticks-hold-2026-11-05)
  in larger doses, and mostly the NPCs' state: a single placement at load (`hitch-run.mjs --mode idle --place`) gave 13 ms at the Market's
  35 ms view, 13 at the Underground's 44, 13 at the MJ12 lab's 31 and 23 at Battery Park's 33, but 43 at the Dockyard's 46 and 28 at the
  Warehouse's 31. So most tick-led views are places visited after the map's NPCs had seen and been hurt by a player teleporting around (god mode
  keeps them shooting); two maps are heavy at load. **09_NYC_Dockyard** is the one to read: its Firefox tick is 25 ms and Chromium's *worker*
  frame there is 18 to 20 ms (`w.tick` 9 to 12.5, `w.actors` 2 to 6) at 143 of 160 views over 16.7 ms in Firefox, and it misses 60 fps in
  Chromium too (87 DeusExMover, 207 lights, 377 BlockPlayer; the Gecko profile: `js_eval` 6.0, `js_move_riders` 2.8, `js_tick_physics` 2.4 ms
  a frame). `12_Vandenberg_Cmd` (41 ms Firefox, worker 22 ms Chromium) is the same kind. No Firefox-only trap showed in the tick.
* **Volumetric fog in the Underground maps (fixed in part, 950917e5).** 39 views, all in `02`, `04` and `08_NYC_Underground`: `p.fog` 8 to 17 ms.
  Chromium pays it too (18 ms of the page's 24 at 02's spots), so it is not a Firefox trap. Of the 14.6 ms a frame under the fog pass at
  (-73, 636, -361): 8.1 ms in the Rust fog loop (`fog::walk`, via `fog_map`; Render.dll's SetupForSurf loop, bit-exact, original per-frame work),
  6.5 ms of JavaScript around it. The redundant part is fixed: `fogMapKernel` sorted and packed the frame's lights (and wrote their 1 KB
  colour tables into the kernel) for every surface, and the pass built its validation notes every frame. Interleaved A/B at the three 02 spots,
  three pairs: `p.fog` 13.93 -> 10.88 ms in Firefox (page p50 37 -> 34), 17.91 -> 11.58 in Chromium (page p50 24.3 -> 17.7). The kernel's
  inputs over 240 frames of Bar, Market, Ship and Battery Park are byte-identical between the two paths (`?fogLights=each` / `FOG_LIGHTS=each`
  keep the old one; `?fogNotes=1` turns the notes on).
* **Actors (`p.actors`).** 25 Dockyard views at 5 to 10 ms, 7 at `12_Vandenberg_Cmd` up to 9.2, 4 at Battery Park up to 7.7, 3 at NSFHQ: `actor-mesh-sim.mjs
  update` (7.2 ms a frame at the Dockyard), proportional to the visible actors; Chromium's worker pays 4 to 6 ms of the same. The plan's
  actors family, not a trap.
* **Moving lights (`p.lightAnimation`, 25 views over 3 ms).** `03_NYC_MolePeople` 10 views (3.0 to 4.2 ms), `12_Vandenberg_Tunnels` 8 (4.3 to
  5.7), the Dockyard 5, Battery Park 2 (up to 5.3). At the Mole People spot (2469, -179, 23) yaw 32768:
  `syncMovingLights` is 3.8 ms a frame in Firefox (2.1 `compose`, 1.5 `light-atlas.mjs update`'s float-to-byte copy of each recomposed light
  map), 2.8 ms of Chromium's page frame of 5.4. Original per-frame work (the moving-light recomposition); the conversion is host code that could
  go to Rust or the GPU. Done 2026-11-07: [Moving lights](#moving-lights-2026-11-07) (`p.lightAnimation` 3.99 -> 1.93 ms at the Mole People spot, 5.1 -> 1.4 ms
  at the Vandenberg alarm light's views).
* **Exceptions as control flow, small.** `soundField` -> `reflectedField` catches the `Object is not attached to script runtime` error
  `instance()` throws for a receiver that is not a script object, at every sound field read: 0.4 to 0.5 ms a frame in Firefox
  (`js::SavedStacks::saveCurrentStack`) at the Warehouse and the Dockyard, 1% of the frame. Under the 5% bar, not changed.
* **Mirrors:** one slow view is led by `p.mirrors`, `10_Paris_Club` (-137, -1344, 7) yaw 0, 6.7 ms (six Club views have 2.5 ms or more; so do
  the Bars at 2.5 to 4.1 and WanChai_Street at 3.5): left to the mirror survey.
* **Not slow, but stops the session** (simulation, not host; run down 2026-11-06, a worker on this branch):
  * `06_HongKong_Storage` at (535, 0, -103), every yaw, and (-7, 555, -103) yaw 0, `Nonfinite FastLineCheck plane distance is unsupported`:
    **a fault of ours, fixed.** The moving brush tracker's scratch arena was never pointed at its block, so building the Storage's tracker
    ran over the module's statics (2,138 sine-table entries, three NaN fragment nodes); no other of the 84 maps with movers was touched. Fixed in
    `tracker.rs` (`scratch_reset`); the new case `storage-nonfinite-fragments` of `validate-brush-tracker` is equal to the original's
    construction ([brush-tracker](brush-tracker.md) "The scratch arena", [fast-line-check](fast-line-check.md) "Nonfinite planes").
    Firefox inline placed at the three spots again: no error.
  * `09_NYC_ShipBelow` at (-506, 894, -361) yaw 16384 (`PickDestination`) and (-6437, -183, -489) yaw 0 (`Patrolling`), `Runaway loop
    detected`: **an original script hazard, reproduced and traced to its cause, no fault of ours found.** `ScriptedPawn.Patrolling` loops
    without yielding when `FindPathToward` finds no path to a route of PatrolPoints with pausetime 0 (WaitForLanding yields only while the
    pawn is PHYS_Falling); the traced instance is a Bay guard standing inside a closing ME_IgnoreWhenEncroach door, every `MoveActor` blocked
    at time 0. Core's counter, limit, `Logf(NAME_Critical)` and GError path are pinned against the DLLs. The pawn-in-the-door state itself
    is not verified against the original; the capture that would settle it is written down
    ([script-pawn-nav](script-pawn-nav.md) "A patrol that cannot start", [script-level-tick](script-level-tick.md) "Core's runaway-loop guard").
  * The player dies in god mode (then DXOnly, whose player is `Paralyzed`) at `03_NYC_Airfield`, `03_NYC_UNATCOHQ` and
    `12_Vandenberg_Computer`: **the census' spots, not the game.** Farthest-point sampling picked navigation points inside the level's solid
    (PointRegion ZoneNumber 0: (698, -4255, 24), (-36, 1, 264), (782, 2657, -2249); 22 such points on 10 maps, tested where the player is placed, 8 units up), and a pawn in zone 0 takes
    physWalking's FellOutOfWorld branch, `Pawn.FellOutOfWorld` -> `Died('Fell')`, which does not go through TakeDamage's god-mode test
    ([walking](walking.md) "Region.ZoneNumber 0"). The listed `Paralyzed` spots (-1578, 34, 23), (1730, -847, -40) and (1884, 2974, -1993)
    are in real zones; the session had reached DXOnly after the death screen (Dying ends in the splash level). `map-nav-points.mjs` now leaves
    solid points out (`{solid: true}` keeps them).

**Fog spots, for the fog work.** `p.fog` before the light-pack fix (the census) and after (a single placement, Firefox inline), the level
surfaces drawn and the mover draw items the pass computed a map for, and the texels, a frame. The pass holds 2092 (02), 809 (08), 804 (04) and
2526 (NSFHQ) fog-zone surfaces.

| Map | Place | Yaw | p.fog before | after | level surfaces + mover items | texels |
|---|---|---:|---:|---:|---|---:|
| 02_NYC_Underground | 638, -191, -361 | 32768 | 16.9 | 10.3 | 68 + 127 | 63,764 |
| 02_NYC_Underground | -73, 636, -361 | 49152 | 14.6 | 11.2 | 84 + 128 | 66,462 |
| 02_NYC_Underground | 234, 605, -361 | 49152 | 14.1 | 10.0 | 86 + 123 | 60,102 |
| 08_NYC_Underground | -768, -402, -361 | 0 | 9.7 | 6.2 | 51 + 125 | 47,893 |
| 08_NYC_Underground | -75, 724, -361 | 49152 | 8.7 | 6.2 | 96 + 131 | 47,421 |
| 04_NYC_Underground | -73, 636, -361 | 49152 | 8.4 | 5.8 | 85 + 118 | 43,412 |
| 04_NYC_Underground | -358, 588, -361 | 49152 | 7.8 | 5.7 | 76 + 116 | 40,945 |
| 04_NYC_NSFHQ | -542, -894, 23 | 49152 | 5.8 | 5.0 | 33 + 0 | 83,052 |
| 04_NYC_NSFHQ | -238, -1777, 48 | 49152 | 5.0 | 3.4 | 23 + 0 | 67,826 |
| 02_NYC_BatteryPark | -3723, -3353, 265 | 0 | 2.6 | 2.1 | 108 + 2 | 68,326 |
| 03_NYC_AirfieldHeliBase | -881, 2510, 23 | 32768 | 2.9 | 2.7 | 103 + 0 | 17,514 |

What is left in the fog phase at the Underground (Gecko profile, before the fix): the loop 8.1 ms; `itemMesh` (a geometry with three new
attributes and a texture write for each of the ~125 mover items, every frame) 1.7 ms; the wrapper around each call 2.3 ms (partly gone now); about
800 `texSubImage2D` calls a frame for 0.7 MB (`gl.upload` 1.2 ms in Firefox, so not the cost). Reproduce: `node scripts/hitch-run.mjs --browser
firefox --map 02_NYC_Underground --mode idle --god --seconds 20 --place '{"location":[-73,636,-361],"rotation":[0,49152,0]}' --profile FILE`,
then `scripts/gecko-phase.mjs RUN FILE --entry 'fog-pass'`; `scripts/wasm-names.mjs` names `wasm-function[175]` on a non-stripped build.
Done 2026-11-07: [Underground fog phase](#underground-fog-phase-2026-11-07) (`p.fog` 10.4-11.4 -> 3.2-3.5 ms at these spots).

**Left open.** The Mac is not measured; these numbers are Linux headless. The tick-led views say little about place (they follow NPC state), so
the census finds the *draw-side* costs of places, and those are few: the Underground fog above, the moving lights at the Mole People, the actors
layer at the Dockyard. No other Firefox-only trap showed in 11,377 views.

### Dockyard tick (2026-11-06)

The task: `09_NYC_Dockyard` misses 60 fps in both browsers at load, with no player history (the census's 143 of 160 views over 16.7 ms in
Firefox; the worker frame 18 to 20 ms in Chromium), so lower the tick's measured largest families by moving them into the Rust core. Method
as the bunker's: baselines on master 0dd477f0, a ranking by measurement, ports behind switches with the JavaScript bodies as references,
interleaved Firefox A/B, bar 0.3 ms in the page mean or 0.5 ms in the slowest tenth. Everything below is headless Linux (Firefox 155
inline, Chromium worker mode, 1440x960, god mode, idle, `--place '{"location":[2623,6205,20],"rotation":[0,32768,0]}'` at load, 25 s
sessions measured from 5 s after the map); the Mac is not measured.

**Baselines (master 0dd477f0).** `bench-sim --map NAME --warm 60 --ticks 300 --render-feedback`: Island `5adb254a07b1ed6f`, Training
`07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59` (the expected ones), and
**Dockyard `e53f348673f1247b`**. Firefox, one unprofiled session: `p.tick` 16.75 ms, `p.actors` 7.07, `p.render` 2.70, `p.hud` 1.98 (of it
`w.hud` 1.37), page `animate` mean 32.7 ms. With the Gecko profiler on (`--profile`, 1 ms interval) the tick reads 20.1 ms: the profile
inflates the tick by about a fifth, so its figures below are for ranking, not for the A/B.

**Ranking (Gecko profile, 482 rest frames and the 54 slowest tenth by `p.tick`; the level tick sampled at 16.9 ms in the rest frames and
30.6 in the slow ones).** By the Rust core's import (the outermost `js_*` call from Wasm; ms a frame, rest / slow):

| Import | rest | slow | What is under it at the Dockyard |
|---|---:|---:|---|
| `js_eval` | 4.05 | 5.70 | nodes the Rust VM hands to JavaScript: flat, no row over 0.5 ms (below) |
| `js_tick_physics` | 2.08 | 2.35 | **1.69 `runActorProjectile`** (PoisonGas, PHYS_Projectile), 0.36 for the 87 DeusExMovers at rest (PHYS_MovingBrush) |
| in Wasm | 1.94 | 2.46 | the actor loop over ~1,960 slots |
| JavaScript, no Wasm under it | 1.64 | 4.41 | `cleanupDestroyed` 0.18 / 2.70, `spawnActor`, `processEvent` |
| `js_tick_resume` | 1.47 | 4.65 | state code resumed through `processState` (NPCs, ProjectileGenerator) |
| `js_move_riders` | 0.56 | 0.74 | the riders' moves (below) |
| `js_step`, `js_tick_state`, `js_iterator_next` | 0.42, 0.41, 0.37 | 1.59, 1.39, 1.70 | the Cloud timers' `foreach VisibleActors` (below) |
| `js_tick_destroy` | 0.38 | 0.65 | |

* **What the Dockyard has that the Island has not** is the poison gas: 20 `PoisonGas` actors (a `Cloud`, `DeusExProjectile`, Physics 6;
  `ProjectileGenerator`s spawn them (native 278 with their `ProjectileClass`), they die in the water at once, `Cloud.ZoneChange`), 15 of them
  in flight a tick.
  Node, `SCRIPT_VM_IMPORT_TIME=1 SCRIPT_VM_IMPORT_CLASS=1` (the import self time by the class of the actor being ticked, 3.2 ms a tick in
  all, placed at the same spot): PoisonGas 0.83 (26%: `js_tick_physics` 0.70, 47 us a call), then Soldier 0.37, Shadow 0.31, DeusExMover
  0.27, TrashPaper 0.18, MilitaryBot 0.18, Barrel1 0.16. 87 `js_tick_physics` calls a tick are the movers' (2.5 us in Node), 15 the gas's.
* **`js_tick_physics` was 82% gas**: of the 2.05 ms in `performActorPhysics`, `runActorProjectile` is 1.69 (the move through
  `playerMove` and its `checkEncroachment` 0.41, `beginTouch` 0.16, the fields by name), the movers' idle `interpolated` body 0.36.
* **`js_move_riders` is 0.56 ms here (0.74 slow), not 2.8, and not the movers'**: the 2.8 came from the census's profile, which is not
  on disk; I could not reproduce it at this placement. The Node class table puts the calls at the pawns (Soldier 4.3 a tick at 11 us,
  MilitaryBot 1.9): a moved pawn with `StandingCount` != 0 moves the inventory based on it (`moveSpawnedActor`, the Island's content, 0.2 ms
  there); a mover at rest never reaches `moveActorRiders` (it does not move). `RIDER_STATS=1` over 900 placed ticks: 9,949 rider passes,
  9,264 of them cache hits, 685 scans (657 after a base-epoch change: 1.35 million slots, 27 ms in Node), 29,492 riders visited (97 ms).
  So it is not the table's fill or invalidation (the bunker's case needed a destroy/spawn storm between scans); the riders' own moves cost
  four times the scans. Not changed.
* **The slow tenth** (39 ms of tick against 16) is the gas's other work: `js_iterator_next` +2.60 and `js_step` +2.36 ms are the
  `foreach VisibleActors(class'Actor', A, cloudRadius)` of `Cloud.Timer` (20 clouds), a JavaScript loop over every slot of `Level.Actors`
  (`script-iterators.mjs` `createVisibleActorsIterator`, 0.67 ms a rest frame and 3.11 ms a slow one, inclusive), `cleanupDestroyed` +2.5 and
  `spawnActor` +1.8 (the puffs' construction and their script events 1.30 of it).
* **`js_eval` is flat** (Node fallback census at the spot, self ms a tick): `AttachDecal` 0.36, `SetRotation` 0.18 (31 calls: the
  LaserTrigger/BeamTrigger/LaserEmitter ticks move their emitter and spot), `SetLocation` of the same ~0.1, `Spawn`/`Destroy` 0.1; everything
  else under 0.06. In the profile `setScriptRotation` is 0.39 ms inclusive, `execSetLocation` 0.13, `execAttachDecal` 0.51 (rest). No
  family is a cut on its own; each is a feature (a context native call in the Rust VM).

**What moved.**
1. **PHYS_Projectile in Rust** (`fall.rs` `perform_projectile`, host `actor-physics-kernel.mjs`, `?projectilePhysics=js` /
   `ACTOR_PROJECTILE=js`). AActor::performPhysics case 6 (physProjectile 0x103d4600) beside the falling body: the same field table, `move_source`
   MoveActor and tail, `projectile.mjs` transcribed on `Ext` (the water factor, `Velocity += Acceleration * remaining` with its float32
   temporaries, an engine.projectile's MaxSpeed clamp from its own table row (optional: the cell exists once a Projectile class is linked),
   the final `(Location - OldLocation) / DeltaTime`); HitWall is `js_fall_bounce`'s event dispatch, a bounce that left the actor falling
   calls `runSpawnedActorFalling` (`js_fall_falling`); Region.ZoneNumber 0 (the destroy) and every other boundary decline to the callback
   before any effect. *Evidence:* `projectile.mjs`'s own oracle record (docs/projectile.md); the Rust body is checked against it by
   `validate-actor-physics-kernel` (two new runs: `scenarios/projectile-branches.mjs` on the Island, decorations and items launched at
   walls, floors and water with pulls and spin, plus spawned Tracers, Rockets and LAMs past their MaxSpeed, bouncing and handed to
   physFalling; and the Dockyard as played): digests equal to `ACTOR_PHYSICS=js` at every checkpoint, all branches reached
   (115,881 projectile calls in the scenario run: 6,857 HitWall events, 243 bounces, 76 physFalling hand-offs, 2,595 MaxSpeed clamps; the
   Dockyard run's gas goes through the water branch, 2,438 substeps in 300 ticks).
2. **RadiusActors' and VisibleActors' loops in Rust** (`render.rs` `area_scan`, `script-vm-render.mjs` `areaScan`,
   `script-iterators.mjs` `scanArea`, `?areaScan=js` / `ACTOR_AREA_SCAN=js`; `?actorScan=verify` runs both and throws on a difference).
   The exec's tests are reads (null slot, bHidden, class ancestry, the radius gates), so where they run is not observable; the Rust scan
   answers them from the image (kind 1: passed; kind 2: the image does not answer for this actor, bound or host field or no class row, so
   JavaScript runs the whole list for it; kind 0: exhausted) and VisibleActors' `FastLineCheck` stays JavaScript's, for the survivors.
   The comparisons are in the same order of operations as the references (`radius * radius > dx*dx + dy*dy + dz*dz` in doubles over float32
   loads, `(Radius + CollisionRadius)^2` for RadiusActors). *Evidence:* Engine.dll execRadiusActors/execVisibleActors (docs/script-actor-queries.md);
   `ACTOR_SCAN=verify` on the Dockyard for 600 ticks (850 scans, 352,018 slots, 713 found, no kind 2, no difference), and
   `test/script-iterators-area.test.mjs` (the iterators with a fake `area` that answers kind 2 for some slots, against the JavaScript loop).

**A/B (Firefox inline, four interleaved pairs each, the arms' order alternating; `hitch-ab.mjs`, `hitch-ab-table.mjs`; ms).**

| Change | tick, new / old | tick, slowest tenth | page mean | page slowest tenth |
|---|---|---|---|---|
| PHYS_Projectile (`projectilePhysics=js`) | 16.64 / 17.65 (-1.01) | 27.48 / 29.46 (-1.98) | 33.39 / 34.45 (-1.06) | 46.09 / 48.47 (-2.38) |
| area scan (`areaScan=js`) | 15.73 / 16.43 (-0.70) | 24.72 / 26.83 (-2.11) | 32.40 / 33.04 (-0.64) | 44.03 / 45.70 (-1.67) |

Both pass the bar. The sessions are noisy (the order inside a pair moved a session by 1 to 3 ms; the pairs of the second table are +0.8,
-2.0, +0.7, -2.3 ms in tick, new minus old, which with the alternating order puts the effect at -0.7 and the order at 1.4 ms; the first table's pairs are -1.7, -0.9, -2.5, +1.1):
the figures above are balanced means, not a claim to a tenth of a millisecond. **Chromium worker mode** (three pairs, `projectilePhysics=js`):
`w.tick` 8.73 / 9.41 ms (-0.68), `w.actors` 5.31 / 5.54, page `animate` 5.15 / 5.13 (the page is not where the frame goes there); the worker frame
`w.tick + w.actors` falls from about 14.9 to 14.0 ms in this headless run. The area scan has not been run in Chromium.

**Checks.** The six digests below are unchanged after both changes, also with `ACTOR_SCAN=verify` (no scan differed), and the Dockyard's
is the same with `projectilePhysics=js`; the 900-tick placed run is `560a7bbad1e78c9a` with `areaScan=js` and with the default.
`validate-actor-physics-kernel` passes (digests equal on all six runs; not reached, as before: a MoveActor handed back, a zone without an
image); `test/script-iterators-area.test.mjs` and `npm test` (below).

**Digests** (`--warm 60 --ticks 300 --render-feedback`, before = after): Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`,
Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`.

**Tried and not shipped.**
* **A Mover at rest in Rust** (`performPhysics` case 9 with `bInterpolating` clear: `OldLocation = Location`, `Velocity = (Location -
  OldLocation) / dt`, the tail). Not built, because the premise fails: for a DeusExMover `engine.actor.binterpolating` (and KeyNum, PhysAlpha,
  PhysRate, BasePos, ...) is a *bound* field (`script-doors.mjs` `binterpolating`, backed by the `actor.interpolation` state object), so the
  image bit the Rust tick would read is stale. It needs the state's `interpolating` mirrored into the image word (the motion word
  0x1ec, bit 0x80) at every write (the physMovingBrush loop, InterpolateTo, saves) and the tick mask to ignore the binding for it. The
  gain is the movers' 0.36 ms (profile), at the bar's edge: left.
* **Skipping the non-Pawn CheckEncroachment call** (`js_move_encroach`, 0.48 ms rest) for a source with none of the
  `bCollideActors|bBlockActors|bBlockPlayers` bits, where `checkActorEncroachment` returns false at once. Written with a verify mode and
  tried: the count of `js_move_encroach` calls did not change (16.7 a tick before and after), because the gas has `bCollideActors`; reverted.
  What the call costs is the hash query (`actorEncroachmentCheck`) and its blocking test, in JavaScript (13 us a call in Node).

**What is left at the Dockyard (rest frames, Firefox profile after the two changes; unmeasured as A/B).** The level tick is 14.6 ms sampled:
`js_eval` 3.59, in Wasm 1.97, JavaScript outside Wasm 1.49, `js_tick_resume` 1.13, `js_move_riders` 0.51, `js_move_encroach` 0.48, `js_fall_bounce`
(the gas's HitWall script event) 0.25; inclusive, `spawnActor` 1.23, `processEvent` 2.33, `checkEncroachment` 0.61, `moveActorRiders`
0.56, `execAttachDecal` 0.51, `setScriptRotation` 0.39, `execSetLocation` 0.13. The next cuts would be the context native calls
(`emitter.SetRotation(Rotation)`, `SetLocation`) as Rust nodes, the encroachment query in Rust (the hash's extent walk exists as
`collision-kernel.mjs`; the blocking test needs the candidates' flags), and the gas's spawn path. Each is 0.3 to 0.6 ms of the profile's
units; none is a family.
* **The actors layer** (`p.actors` 7.4 ms rest, 13 slow; `actor-mesh-sim.mjs update`; moved into the Rust core the same day: [Actors layer in bulk](#actors-layer-in-bulk-2026-11-06)) is flat per function: `occludeMain` 2.65 inclusive (the Rust
  occlusion pass and its glue), `reconcile` 1.5, `updateSprite` 2.0, `updateDrawn` 1.5, `lightIn` 0.85, `refreshSummary` 0.4; no self time
  over 0.5 ms (the largest, `reconcile`, 0.46). The slow tenth adds Major/Minor GC 1.4 and `admit`/`createMeshBindingNow` 2.1 (the gas
  puffs' new bindings). It is the plan's actors family, not a trap, and nothing there is a cut. Not measured as a GPU candidate.
* **The goal is not reached.** The page mean is 32.4 ms against 16.7: the tick is 15.7 of it, the actors layer 7, the render 2.7, the HUD 2.
  Even a free tick would leave 17. At this spot Firefox stays at half the rate; the Dockyard needs the tick and the actors layer both
  to lose a third.

### Combat tick (2026-11-06)

The task: the census found 1,609 of its 1,649 slow views led by the simulation tick, "mostly NPC state" (NPCs that have seen the player and
fought him cost far more than the same spot freshly loaded); find the tick's families in combat and move the largest into the Rust core.
Method as the Dockyard's: reproduce the state headless, rank by measurement, port exactly behind a switch with the old body as reference,
interleaved A/B, bar 0.3 ms in the Firefox page mean or 0.5 ms in its slowest tenth. Everything below is headless Linux (Node 26, Firefox
inline 1440x960, god mode); the Mac is not measured.

**What was found, in short.**
* **The census' slow views are not all one state.** Of the three places the task names (Underground, Battery Park, Market), two did not
  repeat at all in a fresh Firefox run of the same list (below): they were one-offs of the census session. One repeats in Firefox but not in Node (Battery Park). The combat state
  does exist and does repeat, in Node and in Firefox, on the Metro, Vandenberg, Warehouse and Cathedral maps.
* **The largest family of the combat tick is the x87 emulation**: 1.22 ms of the replayed Metro tick's 9.23 (13%), and 0.92 of the 3.99 ms
  that the fight adds over the same spot freshly loaded (23%). It was moved to u64 limb arithmetic (x87.rs) and the pure FCoords(FRotator)
  made a memo; both are bit-exact to the u128 bodies they replace, which stay as the reference. Node tick -1.1 ms (-10.7%) on the Metro
  fight, -0.4 ms (-4%) on Vandenberg's; Firefox below.
* Everything else in the combat tick is flat (ranking below): no other named family reaches 1 ms of self time but the JavaScript
  remainder (2.7 ms in rows under 0.1 ms each), and the biggest JavaScript hand-back is AttachDecal (0.9 ms, the shadows of 16 moving
  pawns, already Rust inside).

**Reproduction.** `scripts/scenarios/places-replay.mjs` replays the census' places in Node (PER 77 ticks a spot, the player in god mode, seed 1,
dt 1/60); `bench-sim --idle` (new: no held W, the harness' idle mode) and `scripts/scenarios/combat-replay.mjs` (new: places-replay plus
`REPORT=1`, one line per spot with the tick time and the pawns by state) make it comparable to the census:

```
PLACES=.cache/perf/spot-census/firefox-10_Paris_Metro.places.json PER=77 FROM=0 TO=55 \
  node scripts/bench-sim.mjs --map 10_Paris_Metro --warm 4208 --ticks 300 --render-feedback --idle --seed 1 \
  --scenario scripts/scenarios/places-replay.mjs
```
(`--warm` is 30 + 77 K + 20 for the last spot K; the same command with `FROM=K TO=K+1 --warm 48` places only spot K at load.) Node tick, mean /
median, the same spot replayed against freshly loaded:

| Map, spot (census index) | replayed | freshly placed | pawns Attacking at the spot |
|---|---:|---:|---:|
| 10_Paris_Metro 54 (2441, -2509, 167 yaw 32768) | 9.86 / 9.54 | 6.20 / 5.79 | 11 |
| 12_Vandenberg_Cmd 98 (-128, 2772, -2025 yaw 32768) | 9.48 / 9.10 | 7.99 / 7.36 | 8 |
| 02_NYC_Underground 104 (-3946, 1158, -1000 yaw 0) | 4.02 / 3.83 | 3.56 / 3.40 | 4 |

The census' own spots and a fresh Firefox run of the same list (`hitch-run --places` cut at the slow spot, same settle and record times, so
a sequence of the census' kind; tick phase `p.tick`, ms) against the Node replay of the same list (tick mean of the spot's second half;
`corr` is the correlation, over all the spots of the list, of the run's tick with the census'):

| Map | census slow spot | census | fresh Firefox run | Node replay | corr: Firefox / Node with the census |
|---|---|---:|---:|---:|---|
| 02_NYC_Underground | 104, yaw 0 | 26.8 | 4.8 (p50 11 ms) | 4.0 | 0.31 / 0.06 |
| 06_HongKong_WanChai_Market | 27, yaw 49152 | 23.2 | 7.3 | 4.2 | 0.48 / 0.24 |
| 02_NYC_BatteryPark | 110, 111 | 22.0, 22.9 | 13.1, 17.1 | 4.5, 5.3 | 0.78 / -0.01 |
| 10_Paris_Metro | 38, 39 | 23.7, 20.2 | 14.2, 15.7 | 4.9, 5.1 | 0.93 / 0.20 |
| 12_Vandenberg_Cmd | 63, 127 | 24.8, 23.3 | 17.4, 17.2 | 6.2, 9.5 | 0.63 / 0.39 |

* **The Underground's 44 ms view and the Market's 35 ms view are not a state.** The Underground's neighbours at the same place (yaws 16384,
  32768, 49152) read 6.4, 6.1 and 9.0 ms in the census itself; the fresh run of the same sequence read 4.8 ms at the slow view, and the
  Node replay 4.0 (3.6 freshly placed): "the tick in Node well above the fresh-load tick" does not hold there. The same for the Market's
  yaw 49152 view (8.3, 7.2, 7.3, then 23.2 in the census; 7.3 in the fresh run). The census ran with other sessions on the machine, which
  the heavy lock does not exclude (the user's tabs, builds): a possible cause, not checked; nothing in the sequence repeats the spike.
* **Battery Park's (-4634, 3480, -312) is a place, not a fight**: 13 to 17 ms in the fresh Firefox run (census 22), 4.5 to 5.3 ms in Node
  with one pawn holding an Enemy; a single placement at load in Firefox reads 10.7 ms with a 20 ms slow tenth (profile below). What it holds that
  Node's replay lacks is not known. Not ported.
* **The fight is the Metro, Vandenberg, Warehouse and Cathedral spots**: in Node the heaviest spots of those lists are the ones with 8 to 11
  pawns in Attacking (Cathedral 132 to 142: 9.0 to 9.7 ms against a map mean of 5.3; Warehouse 75: 9.7; the Metro's 54 and the
  Vandenberg's 98 above), correlation with the census 0.60 and 0.52 on the first two. The fresh Firefox runs repeat the census at Metro
  (0.93) and Vandenberg (0.63), a little lower in absolute terms (14 to 17 ms against 20 to 25).
* The replay is a same-mode reproduction, not the original's: the NPCs' states depend on the order of the teleports, the tick length and the
  seed, and `--render-feedback` stamps LastRenderTime by a 75-degree frustum without occlusion.

**Ranking (Node, V8 CPU profile of 300 ticks, Metro spot 54 replayed against freshly placed; ms a tick of `tickStandaloneLevel`, self time
by family; the profile inflates the tick by about a fifth).** Wasm functions are named from a non-stripped build
(`scripts/wasm-names.mjs`):

| Family | fresh | fight | fight - fresh |
|---|---:|---:|---:|
| **x87 arithmetic (`Ext` add/mul/div/sqrt/rounding, `u128_div_rem`, `__multi3`, FCoords dot products)** | 0.30 | **1.22** | **+0.92** |
| collision traces and the hash (`trace::ray`, `hash::multi_line`, ...) | 0.55 | 0.90 | +0.35 |
| script VM (interp, dispatch, iterators, natives) | 0.54 | 0.90 | +0.36 |
| decals (`AttachDecal`: the pawns' shadows) | 0.41 | 0.58 | +0.17 |
| AI event manager and perception (own code) | 0.19 | 0.51 | +0.31 |
| pawn physics, walking, moving | 0.17 | 0.38 | +0.21 |
| wasm to JS crossing, other wasm | 0.25 | 0.44 | +0.19 |
| JavaScript: object model and lookups (`namedHandle`, `readInstanceField`, ...) | 0.64 | 0.95 | +0.31 |
| JavaScript: move riders, tick glue, collision glue | 0.28 | 0.64 | +0.36 |
| JavaScript: the rest (every row under 0.1) | 1.91 | 2.72 | +0.81 |
| **level tick** | **5.24** | **9.23** | **+3.99** |

By inclusive function the fight adds: `aievent::process` +1.33 (0.14 to 1.47: AIProcess and the AICanSee of every receiver for every event,
`ai_can_see_body` +0.90 of it, half of the manager's time in x87 arithmetic and 0.27 in `fcoords_axes`), `pawn_phys::perform` +0.82,
`walk_loop` +0.78, `move_source` +0.62, `js_eval` +0.79 (the hand-backs), `spawnActor`/AttachDecal and the rest below 0.5. The
JavaScript hand-backs by the fallback census (`script-vm-fallback-census.mjs`, now with `BASE=` to run on a scenario; ms a tick, calls
a tick; the slowest tenth is 14.5 ms against 9.7): `AttachDecal` 0.94 (15.9 calls, 59 us each; 1.02 in the tenth), `Spawn` (278) 0.09 rest
and 0.65 in the tenth (0.43 and 3.3 calls: the fight's hit effects, shells and sparks), `Trace` (277) 0.13 (17 calls), `PlayerTick` 0.14,
`native 518` 0.02 rest and 0.25 in the tenth (a path search, 0.23 calls of 1.1 ms), then rows under 0.2. Apart from AttachDecal no
JavaScript row passes 0.2 ms a tick on the mean, the Dockyard's finding again.

The Firefox profiles agree on the shape and weigh it differently (Gecko, inline): at Battery Park's single placement (10.7 ms rest, 20.0
the slowest tenth of ticks) `js_tick_resume` is 5.6 against 1.7 and `js_tick_state` 2.4 against 0.3 ms a frame in the tenth, inclusive of
the state code they run in Wasm; the leaves are the object-model rows (`describeEntry`, `copyScalar`, `readComposite`, `lookupMember`,
`instance`, `namedHandle`: 1.7 ms a frame together) and `Ext::rounded` is 0.13 ms a frame. See "In Firefox" below for the Metro run.

**In Firefox** (Gecko, inline, the Metro's census places up to spot 39 on the reference arithmetic; 2,951 drawn frames from 5 s after the
map; `gecko-slow-ticks.mjs`): the tick is 6.56 ms in the rest and 15.25 in the slowest tenth (295 frames). What the slow frames add, ms a
frame, by the Rust core's import: `js_eval` +1.99 (under its nodes: natives +1.43, script calls +0.98 and +0.87), `js_tick_resume`
+1.08, `js_tick_state` +0.76, `js_fall_bounce` +0.51, `js_move_riders` +0.46, Wasm itself +0.49, `js_anim_notify_event` +0.27. By named
frame (inclusive): `spawnActor` +1.35, `moveActorRiders` +0.53 (its leaf `nextCandidate` +0.23), `destroyActor` +0.38 and `cleanupDestroyed`
+0.20, `execAttachDecal` +0.28, `execActorPlaySound` +0.27. The x87 functions hardly show (Ion inlines `Ext` into its callers; the named
leaves are `Ext::rounded` 0.045 and `add` 0.026 ms a frame), so the profile understates that family, which the A/B below measures: the
Firefox slowest tenth is the fight's spawns, riders, destroys and sounds in JavaScript with the x87 emulation a smaller part of it than
in Node.

**What moved.**
1. **The x87 model on u64 limbs** (`x87.rs`; the reference bodies are `x87_ref.rs`, the exact u128 code the module shipped with). Same
   operations, same roundings, same fields of the result; what changed is the machine code: `Ext::normalized`/`rounded` take the 128-bit
   result as two words (leading zeros of the high word, one rounding step on the left-aligned remainder), the 64x64 product is four 32-bit
   partial products instead of `__multi3`, the quotient comes from a 128/64 division (Hacker's Delight `divlu` on a normalized divisor,
   the two extra bits and the sticky bit from three comparisons) instead of two `u128_div_rem`, the square root seeds Newton's iteration
   from the high word's 32-bit root and typically needs two 128/64 divisions instead of the power-of-two seed's `u128` loop, add aligns the
   smaller operand with word shifts and `store`/`store_double` round on one word. An `Ext` whose significand is not normalized (lipsync.rs builds those from
   an 80-bit memory word) and the precision-control-24 rounding take the reference bodies.
   *Evidence:* the arithmetic is a pure integer function with an exact reference, so the check is equality over the operands, not a
   tolerance: `scripts/validate-x87-fast.mjs` builds the module with the `selftest` feature (not shipped) and compares every field of the
   result of add, multiply, divide, square root, normalization, `store` and `store_double` against `x87_ref.rs` over generated operands
   (random, all ones, one bit, halfway patterns, runs, zeros, infinities and NaNs of both signs and several payloads, exponents together
   and far apart, unnormalized significands) at precision control 64 and 24: 28,000,000 comparisons per seed and precision control
   (4,000,000 rounds of seven operations; seeds 1 to 3 at both), 0 mismatches. Mutations of each rule (the tie to even, the divide's
   sticky bit, one partial product of the multiply, the square-root seed, the zero sign of a cancelling sum, the guard for a tiny
   unnormalized significand) are each caught within 300,000 rounds, so the generator reaches them. `validate-script-vm-x87` (620,000
   operand sets of 15 operators at both precision controls against the BigInt bodies that the native operator validators check against
   Core.dll) passes on the new module. Micro-benchmark in the same module
   (`--bench`, ns an operation, limbs / reference): add 9.3 / 18.5, multiply 7.4 / 14.7, divide 13.8 / 76.9, square root 56.8 / 248.6, a
   multiply-add chain 15.4 / 37.4. The module is 14% smaller (1,207,828 to 1,038,722 bytes).
   *Switch:* `?x87=ref` / `X87=ref` loads `script-vm-ref.wasm` (`node scripts/build-x87-ref.mjs`, feature `x87_ref`: every `Ext` operation runs
   `x87_ref.rs`; git-ignored like the other `.wasm` files).
2. **FCoords(FRotator) memo** (`percep.rs fcoords_axes`). The 36 dot products of the three rotation passes are a pure function of the
   rotation, the precision control and the sine table; AICanSee asks for the viewer's ViewRotation once per event and receiver and a glide
   for its Rotation's X axis. A direct-mapped table of 32 results answers the repeats (key: the three angles and the precision control;
   `sine_ptr`, which the host calls to load the table, empties it). `?fcoordsCache=off` / `FCOORDS_CACHE=off` computes every call.
   *Evidence:* `test/fcoords-cache.test.mjs` (the kernel's FCoords against `fcoordsAxesReference`, the BigInt body bit-compared with the
   original constructor in Unicorn, for 400 rotations asked once, again, in three orders over a shared table, and at both precision
   controls); the digests below with the cache on equal the runs with it off.

**A/B.** Reference arm: `X87=ref FCOORDS_CACHE=off` (`?x87=ref&fcoordsCache=off`); new arm: defaults. Same commit, same inputs.
* **Node** (five interleaved pairs, order alternating, one lock hold; tick ms of 300 ticks after the replay; the arms' digests are equal in
  all ten runs of each map):

| Replay | tick mean, new / reference | median | slowest tenth | pairs (mean, new - reference) |
|---|---|---|---|---|
| Metro 54 | 9.23 / 10.34 (-1.11, -10.7%) | 8.84 / 9.88 (-1.03) | 13.75 / 15.41 (-1.66) | -1.36 -0.97 -1.66 -1.05 -0.50 |
| Vandenberg 98 | 8.87 / 9.26 (-0.39, -4.2%) | 8.45 / 8.82 (-0.37) | 14.07 / 14.33 (-0.26) | +0.03 -0.25 -0.83 -0.71 -0.19 |

* **In Firefox** (inline, headless, the census' places of the Metro up to spot 60, 500 ms settle, 750 ms recorded, god mode; `hitch-ab.mjs
  --guard ... -- --places`, drawn frames from 5 s after the map; ms; the arms' order alternating):

| Set | tick, new / reference | tick, slowest tenth | page `animate` mean | page, slowest tenth |
|---|---|---|---|---|
| 1: four pairs, new first in the odd pairs | 6.73 / 6.94 (-0.21) | 11.86 / 12.77 (-0.91) | 14.70 / 14.92 (-0.22) | 23.07 / 24.08 (-1.01) |
| 2: four pairs, reference first in the odd pairs | 6.82 / 7.19 (-0.37) | 12.59 / 13.55 (-0.96) | 14.83 / 15.40 (-0.57) | 24.00 / 25.25 (-1.25) |
| **all eight pairs** | **6.77 / 7.07 (-0.29, se 0.07)** | **12.23 / 13.16 (-0.93, se 0.34)** | **14.76 / 15.16 (-0.40, se 0.12)** | **23.53 / 24.67 (-1.13, se 0.42)** |

The pairs' differences (new - reference, pooled from the two `hitch-ab-table.mjs` outputs): tick -0.01 +0.03 -0.35
-0.53 -0.39 -0.49 -0.34 -0.27 (better in 7 of 8), tick slowest tenth -0.05 +0.25 -1.55 -2.29 -1.60 -1.11 -1.33 +0.20, page mean +0.20 +0.07 -0.55
-0.61 -0.60 -0.69 -0.50 -0.53 (6 of 8), page slowest tenth +0.59 +0.14 -2.44 -2.35 -2.08 -0.98 -1.69 -0.26. The first two pairs of set 1 show no
effect at all and the spread between sessions of one arm is 0.2 to 0.3 ms of tick and 1 ms of its slowest tenth, so the single sets are
noisy (set 1 alone misses the mean bar with -0.22); pooled, the mean of the page's frame is -0.40 ms (t = -3.4) and its slowest tenth -1.13
ms. A one-profile-each Gecko run of the same list up to spot 39 (`--profile`, 1 ms interval, so for the shape and not the A/B) reads the
level tick at 6.49 ms a frame on the reference and 6.24 on the new, the same direction and size.

**Digests** (`bench-sim --warm 60 --ticks 300 --render-feedback`, before = after, also with `X87=ref FCOORDS_CACHE=off`): Island
`5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`,
Dockyard `e53f348673f1247b`. Combat replays (PER 77, seed 1, dt 1/60, `--idle --render-feedback`): Metro 54 replayed `09e2d44972cca30a`,
freshly placed `a6011ede7236c1d2`; Vandenberg 98 replayed `ed184bd3eb533bc1`, freshly placed `1db79eb398240a97`; Underground 104 replayed
`4dd5077404683fd4`.

**Result: meets the bar, shipped.** Firefox page mean -0.40 ms (bar 0.3) and page slowest tenth -1.13 ms (bar 0.5), the tick -0.29 mean and
-0.93 in its slowest tenth; Node -1.1 ms (-10.7%) on the Metro fight and -0.4 ms (-4%) on Vandenberg's, where the x87 arithmetic is 5.8% of
the tick against the Metro's 13%. Not measured: Chromium (the worker; a Chromium pair would be the check that the limb arithmetic is
not a Firefox-only gain), the Mac, a fresh placement's A/B (the x87 arithmetic is 0.30 of 5.24 ms in the Metro's profile there, so the
gain is smaller), a Battery Park or Dockyard run. The A/B is of the places run, a mixture of fight and quiet spots, so its mean is below what
a sustained fight would show; the Node figure is nearer to that.

**Checks.** The six baseline digests and the three combat-replay pairs above are unchanged and equal with `X87=ref FCOORDS_CACHE=off`;
`validate-x87-fast` (above), `validate-script-vm-x87`, `validate-event-manager` (98 scenarios, 3,362 operations), `validate-perception-kernel`
(12,000 cases, 4,800 AICanSee: identical), `validate-ai-visibility`, `validate-pawn-tick-visibility`, `validate-pawn-alliance`,
`validate-locomotion-kernel` (3,000 cases), `validate-decal-attach`, `validate-decal-fast` (4,000,000 cases) pass; `validate-pawn-perception`
(the Wine one) skips on this host. `test/fcoords-cache.test.mjs` is new. `npm test`: 965 tests, 961 passed, 4 skipped, 0 failed. The Rust build is warning-free in the
shipped, `selftest` and `x87_ref` configurations.

**Tools added** (measurement only): `bench-sim --idle` and the slowest-tenth mean in its report; `scripts/scenarios/combat-replay.mjs`;
`script-vm-fallback-census.mjs BASE=scenario`; `hitch-ab.mjs --guard` (each session through the heavy lock and the 8 GB scope; `--places`
already passed through); `scripts/build-x87-ref.mjs`; `scripts/validate-x87-fast.mjs`. The V8-profile helpers used for the ranking (families
by function name, differences between two profiles, callers) are scratch scripts, not committed.

**What is left**, in the order of the Firefox slowest tenth (ms a frame, slow minus rest, from the Gecko profile of the Metro run above):
1. `spawnActor` +1.35 inclusive (the fight's hit effects, shells, sparks and smoke: 3.3 spawns a tick in the Node fight's slowest tenth against
   0.5 at rest, 175 us each); the [spawn analysis](#spawning-and-destroying-the-cost-is-the-invalidation-2026-11-06) found no piece over 0.13 ms in it.
2. The mover rider scan: `moveActorRiders` +0.53, its leaf `nextCandidate` +0.23 (the JavaScript pass over the level's ~2,500 slots' Base
   words after each `baseEpoch` advance, `move-riders.mjs`), the visits +0.2. A Rust `nextCandidate` over the level loop's per-slot
   descriptors is the cut; alone it is under the 0.5 bar.
3. `js_fall_bounce` +0.51 (the shells' and rockets' HitWall script events, which carry a vector parameter the CALL kind does not), `js_tick_resume`
   +1.08 and `js_tick_state` +0.76 (state code resumed through JavaScript, inclusive of the Wasm it runs), `js_anim_notify_event` +0.27,
   `destroyActor` +0.38 with `cleanupDestroyed` +0.20, `execActorPlaySound` +0.27.
4. In Node the event manager still costs 0.88 ms a tick after the change (1.48 before): `Ext::add` 0.10, `mul` 0.08 (9 and 7 ns an operation),
   `ai_can_see_body`'s own 0.05, `squared_distance` 0.10 inclusive. A second round of the limb arithmetic, or exact filters in front of
   AICanSee's angle tests (the decal filters' method), are the cuts there.
5. Not found, so not ported: Battery Park's (-4634, 3480, -312) views (Node does not reproduce them; a Firefox single placement is flat), and the
   Underground's and the Market's census views, which did not repeat.

### Actors layer in bulk (2026-11-06)

The task: `p.actors` (in Firefox inline mode the simulation's `w.actors` plus the page's apply/GPU half) is the largest cost after the
tick at the slowest maps, in both browsers, and the [earlier pass](firefox-actors-phase.md) found no function over 0.5 ms in it. The
work is a flat per-binding host loop, so this step moves the loop, not a function: one Rust pass over a table of rows kept with the
binding list reads every binding's fields from the object image and says which bindings need the host at all. Everything below is
headless Linux (Firefox 155 inline, Chromium worker mode, 1440x960, god mode, idle at the spot, 25 s sessions measured from 5 s after
the map); the Mac is not measured. Baseline: master 28fdc8aa.

**What the layer holds at the spots** (`frame-alloc-meter.mjs --place`, 300 frames; the counters were a local patch, not committed): the
Dockyard spot (2623, 6205, 20) yaw 32768 has about 500 bindings (mesh actors bound; 496 to 511 over two windows), 2 to 5 of them drawn
(`view.main`), 39 render-iterator items, no child-frame binding; Level.Actors changes structurally in 40% of the frames (the gas puffs
are spawned and destroyed within frames), so the pair table was written in 0.6 frames a frame. The Island has about 510 bindings and
4.8 drawn. **Cost per binding** (Dockyard, Firefox rest frames, the host loops below / 496): 6.9 us.

**Baseline ranking** (Gecko profile of the Firefox inline session, 669 drawn frames of which 602 are rest frames; ms a frame,
inclusive; the profile inflates the host by about a fifth, so these rank and do not A/B):

| Sub-step (Dockyard) | rest ms | what it is |
|---|---:|---|
| `occludeMain` | 2.93 | the original OccludeBsp pass in Rust 1.55 (of it 1.01 is its child frames' SetupDynamics calling back into JavaScript: the laser and particle iterators' rescans), `packDynamics` 0.86 |
| `reconcile` | 1.55 | membership Set/Map rebuild 0.44 (self), `admit` 0.47 (a call for every bound actor), `retire` 0.27, `meshChanged` 0.23, render scan 0.14 |
| the bindings' `update` | 1.52 | `updateDrawn` 1.05 of it (the 2 to 5 drawn: lighting 0.64); the other ~495 return a plain hidden record |
| `meshReads` | 0.57 | pair table written 0.37 (`get block` 0.2), Rust `mesh_reads` 0.20 |
| `refreshSummary` (in `reconcile`) | 0.34 | the summary lists made from every binding at each take and retire |
| `drawItems`, `newScope`, weapons | 0.35 | |

The per-binding host loops (`reconcile`, `meshReads`, `packDynamics`, the hidden updates, the summary) add to **3.4 ms of the 7.4 ms**.
Other spots, same profile (`p.actors` 4.10 Island, 4.30 Vandenberg_Cmd, 3.76 Battery Park): the OccludeBsp pass is the largest row
(1.34, 1.54, 0.49 ms in Rust), then the bindings' update (0.79, 0.94, 1.17), `reconcile` (0.46, 0.36, 0.49), `packDynamics` (0.27, 0.29,
0.38). The census's 9.2 and 7.7 ms at Vandenberg_Cmd and Battery Park were after a player had teleported around; idle at load they
are 4.3 and 3.8. The slowest tenth at the Dockyard (67 frames, `p.actors` 13.6) adds Major/Minor GC 2.2 and the bindings made for the
puffs (`admitNew`, `createMeshBindingNow`, 0.9).

**Design.**
1. **The roster** (render.rs `roster_reads`, actor-mesh-sim.mjs `rowAdd`/`rowRemove`): one row of eight words in the arena for each
   binding, in `actors` order: the actor's handle, the binding's block, the handle of the Mesh it was made for, its index in
   Level.Actors, its mesh record. The pass makes every block as `mesh_reads` does (the same function, now per block), finds each
   row's index in Level.Actors with a hash of the level's handles (made when the level's array or the rows changed), and returns the
   rows the host must look at as `row << 4 | reasons`: not in the level, Mesh changed, the image does not answer (the block's status
   lacks OK, or no block), handle released. `reconcileRoster` then does what `reconcileJs`'s loop did for those rows alone and in the
   same order (`retire`, `retired.set`); the Set, Map and accessor rebuilds of `reconcileJs` are not made (`syncLive` makes them in a
   frame the pass cannot run in).
2. **The admission scan** (`admit_filter`): the frame's shared walk's mesh entries without those `admit` turns away without effect
   (a row's actor, one `drawnInWorld` rejects in the root frame and, with child frames, in a child frame), so `admit` runs for the few
   that remain instead of ~500. `admit`'s other returns are not moved.
3. **The candidates** (`pack_order`, `pack_words`, dynamics-candidates.mjs `packFromRoster`): the admitted bindings in Level.Actors
   order merged with the iterator items and sprites by order, with the stable tie order `packDynamics` builds, and their 22 Setup words
   from the blocks, in one pass; the host makes the entries' objects, the mesh records in `packDynamics`' order, the items' and sprites'
   words, and the words of a binding whose block holds no current GetAnimSeq answer (the block now keeps the last one). A binding made
   after the pass in the same update, or one the image does not answer for, is decided by the host (`admitted`, `childAdmitted`, as
   `packDynamicsJs` asks) and handed to Rust in the skip list.
4. **Quiet hidden bindings are not updated** (`updateBindings`): in a frame with an occlusion result a binding in neither the main
   frame's nor a child frame's Frame->Sprite returns a plain hidden record with its state at rest; one that did so in the previous such
   frame, whose record the page holds (`hiddenRun`) and that is not an iterator's moved actor, finds the same state and is not updated.
5. **The summary is made when read** (`makeSummary`): a take or a retire marks it dirty instead of making three lists from every binding.

Every piece keeps its JavaScript body as the reference behind `ACTOR_PLUMBING` / `?actorPlumbing=` (`no-roster`, `no-pack`, `no-skip`,
`no-summary`; `js` all of them; `verify` runs the new body and the reference and throws on a difference: the rows against a rewrite, the
positions against a fresh index map, every attention reason against the loop's decision, every dropped admission entry against
`drawnInWorld`, the candidate entries and all 22 words of each against `packDynamicsJs`, a skipped binding against its update, the
summary against the refresh at the change).

**Evidence for fidelity.** The layer's output is what the page draws from, so the check is the output itself: `frame-alloc-meter.mjs`
hashes every snapshot (records, plans, lighting, camera, sprites, HUD; numbers by their exact bits) for 300 frames and `--compare`s
against a run of master:
identical on the Dockyard, Island (roaming), Vandenberg_Cmd, Battery Park and the Airfield, after each commit, with `ACTOR_PLUMBING=verify`
clean on the same five. Nothing in the layer's behavior was invented: the Rust pass is `mesh_reads`' body, `drawnInWorld`'s,
`packDynamics`' order and `packSetup`'s words, moved.

**A/B** (interleaved, `hitch-ab.mjs`, the arms' order alternating; old = `actorPlumbing=no-summary,no-skip,no-roster,no-pack`, the
plumbing master had; ms):

| Spot, browser (pairs) | | `p.actors` | `w.actors` | tick | page mean | page slowest tenth |
|---|---|---:|---:|---:|---:|---:|
| Dockyard (2623, 6205, 20), Firefox inline (4) | new / old | 5.44 / 8.07 (-2.64) | 4.79 / 7.38 (-2.59) | 16.43 / 16.89 | 31.86 / 34.60 (-2.74) | 44.31 / 48.49 (-4.18) |
| Island at load, Firefox inline (4) | new / old | 3.15 / 3.96 (-0.81) | 2.75 / 3.56 (-0.81) | 7.44 / 7.80 | 17.15 / 18.58 (-1.43) | 20.04 / 22.35 (-2.31) |
| Dockyard, Chromium worker (3) | new / old | 0.38 / 0.37 | 3.91 / 5.62 (-1.71) | | `animate` 5.09 / 5.26 | 7.13 / 7.17 |

Both Firefox rows pass the bar (0.3 ms page mean, 0.5 ms slowest tenth). The `p.actors` and `w.actors` differences are the firm ones: every
pair is negative (Dockyard pairs -3.35, -1.83, -3.68, -1.69; Island -1.01, -0.75, -0.63, -0.83). The page-level figures carry the sessions'
noise (the Dockyard page mean per pair: -5.2, -1.0, -5.3, +0.5; the tick moved by -0.5 ms with no change to it, which is session noise or a
secondary effect of the lower allocation, not claimed). An earlier A/B set at the previous commit (9c015524: the roster and the pack
without the host-decided rows; 4 pairs each, Firefox; 3 Chromium) gave the same picture: Dockyard `p.actors` 5.31 / 8.32, page mean
30.51 / 35.71, slowest tenth 41.64 / 49.25; Island `p.actors` 3.09 / 3.82, page mean 16.88 / 17.77; Chromium `w.actors` 3.86 / 5.56. In the
Chromium worker the page half (`p.actors`) is unchanged, 0.4 ms; the worker frame `w.tick + w.actors` falls by the 1.7 ms. The headless
Node frame (`frame-alloc-meter.mjs --time`, the V8 `actors` step, noisy because the host is shared): Dockyard 3.8 and 3.5 ms with the new
switches off, 2.6, 2.4 and 2.7 with them on. Allocation in the `actors` step at the Dockyard, same tool, KB a frame: 966 on master, 731 at
9c015524 (the Level.Actors Set and Map rebuilds and the summary lists were about 170 KB of it); the remainder is mostly the iterators' script
reads in the child frames.

**Checks.** The six `bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback` digests are unchanged
(Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, Area 51 bunker
`764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`). `frame-alloc-meter.mjs --compare` against master: identical snapshots for 300 frames on the five
maps with the final code (digests `bccd360db7639087` Dockyard, `5e021f24dcd1a8ed` Island, `7ddf9e6db3768f2c` Vandenberg_Cmd,
`6b271eec9ac0e72e` Battery Park, `a04d154da0b6a1a0` Airfield), and `ACTOR_PLUMBING=verify` runs clean on the same five (the main frame's
candidates came from the roster in all 1,980 measured and warm-up frames, none declined; 0.1 to 0.4% of the binding entries are packed by
the host). Validators (`run-validators.mjs --filter`, one job): actor-mesh-scene, gpu-mesh, bsp-occlusion, spawn-mesh-binding (its
`levelIndex.has` call is why the roster's index object has the Map's `get` and `has`), npc-mesh-preview, umesh-play, sprite-setup, play-frame,
first-draw-pose, lodmesh-lod-play, dynamic-light-mover, brush-tracker; in the browser `validate-mesh-path-frames.mjs --frames 90 --query
'&actorPlumbing=verify' --plumbing` (the Paris club's mirrors, 1280x720 identical, the plumbing arm identical) and `validate-sim-split.mjs
--draw-state --pixels` default against `actorPlumbing=js`, inline and worker (state digests, every binding's draw state and the pixels
equal). `npm test`: 958 passed, 4 skipped, 0 failed. No Rust warning. Not tested: the Mac; Chromium inline; the Training start (its 18
captured NPC bindings have no block, so the host decides them each frame: covered by actor-mesh-scene, not by a frame-by-frame comparison);
a context loss (`leaveGpu` clears `hiddenRun`, so nothing is skipped after one, by reading, not by a run).

**What is left** (profile of the final code at the Dockyard, rest frames): `update` 4.76 ms (7.35 before) of the profiled p.actors 5.60: `occludeMain` 2.28, of it the OccludeBsp pass in Rust about 1.6 (the child
frames' iterator rescans 1.0 of that, script callbacks that are original behavior and untouched) and `packDynamics` 0.21 (0.86 before); the
bindings' update 1.42 (the 2 to 5 drawn: lighting 0.6, of which the light-membership rebuild `membership` in script-vm-meshlight.mjs
is 0.2 whenever Level.Actors changes, a Rust candidate: the mirror's handle list already exists); `reconcile` 0.35 (1.65), of it the
puffs' bindings 0.17 and the admission scan 0.12; the roster pass 0.21 (`meshReads` 0.59); `drawItems` 0.16; `newScope` 0.12 (the
`itemKey` strings of 39 items, a candidate); weapons 0.13. The slowest tenth still adds Major/Minor GC. Fields: the pass reads only fields that
`RENDER_FIELDS` already holds in the image (bHidden, bDeleteMe, Owner, bOnlyOwnerSee, bOwnerNoSee, Mesh, Style, ScaleGlow, Location,
PrePivot, DrawScale, bAnimByOwner, Rotation, DrawType, bParticles, AnimFrame, BlendAnimFrame, Region, AmbientGlow, the light flags, the
AnimSequence name word); an actor the image does not answer for (a bound or host field, an owner chain over 64) stays with the host
through the attention list. Host-side and kept there: the binding's closures, its mesh record, the GetAnimSeq lookup by name (cached in
the block), the iterator items and sprites. Nothing was moved to a side branch: the pieces passed the bar together and were not measured
one by one in Firefox; the profiles rank them at the Dockyard (rest, inclusive, before / after): `reconcile` 1.65 / 0.35 and the pair
table or roster pass 0.59 / 0.21 (the roster, the lazy summary, whose 0.34 was inside `reconcile`), `packDynamics` 0.86 / 0.21 (the pack),
the bindings' update 1.70 / 1.42 (the skipped hidden bindings).

At the merge (f55eb1fd) the roster's fifth word, the binding's mesh record address in the occlusion kernel, is dropped whenever
packFromRoster sees another occlusion model: a Player start LoadMap makes a new one (sim-host.mjs buildOcclusion) and frees the old
blocks. Read from the code; no run reaches a binding that outlives that rebuild.

### Underground fog phase (2026-11-07)

The task: the census' Underground fog spots (`p.fog` 10 to 11 ms a frame in Firefox inline after the light-pack fix) are the largest cost left
that is tied to a place; make the phase cheaper without changing one output bit. Result, all headless Linux (Ryzen 9 8945HS, Node 26, Firefox
inline 1440x960, god mode, idle at the spot): **`p.fog` 10.4-11.4 -> 3.2-3.5 ms, the page frame mean 28.9-33.0 -> 19.2-23.4 ms** at the three 02
spots (A/B below); the fog maps, the item meshes and the atlas pages are byte-identical to the previous bodies (below). The Mac is not measured.

**Reproduction and the phase before.** `node scripts/hitch-run.mjs --browser firefox --map 02_NYC_Underground --mode idle --god --seconds 20
--place '{"location":[-73,636,-361],"rotation":[0,49152,0]}' --out OUT --profile OUT.gecko.json`, then `node scripts/gecko-phase.mjs OUT.json
OUT.gecko.json --entry 'fog-pass'` (master 61cc9524). The pass is 11.31 ms a frame (`p.fog` 11.90):

| Part (ms a frame, Gecko, inclusive) | before | after |
|---|---:|---:|
| the whole fog pass | 11.31 | 3.41 |
| Rust loop (wasm: `fog::walk` / `light_blocks` 1.79 + `fill_band` 0.16; named with `wasm-names.mjs` on non-stripped builds of each tree) | 7.85 | 2.00 |
| JavaScript around it | 3.46 | 1.41 |
| `fogMapKernel` for the 128 mover items / the 84 level surfaces (wasm included) | 5.17 / 3.45 | 1.33 / 0.93 |
| `itemMesh` (+ `moverBasis`, `moverGrid`) | 1.28 (+ 0.23) | 0.14 (+ 0.01) |
| `writeTile` | 0.33 | 0.05 |
| the kernel's `.slice()` copy of each map | 0.17 | 0 |
| `globalThis` switch reads at each of the 212 calls a frame (master: `lightsEachSurface`, 0.13; a first state of this branch had two more, 0.33 ms together, before they were read once per update) | 0.13 | 0 |
| Minor + major GC samples under the pass | about 0.5 | not in the top 14 |

**Ranking (measured before any change).** 1. the Rust loop, 69% of the pass: 1.33 million texel-lights a frame (66,462 texels, 20 lights) at about
6 ns each; in the captured calls 33% of the texel-lights are `A` (the light is behind the ray), 62% are misses (only the flag is set) and 4.5% hits;
skipping the hits' chord entirely changes the block loop's time by 1.4%, so the cost is the classification. 2. `itemMesh` and the basis it needs,
for 128 mover items that are at rest: a new geometry with three new attributes and a texture write every frame (13%). 3. the wrapper, switches and
copies (10%). 4. `writeTile`, GC (5%). The per-light, per-surface hoisting was the first candidate and is what the block loop does; a geometric cull of
whole (surface, light) pairs is analysed below and not done.

**What changed** (each old body is kept behind a switch; `?fogKernel=` and `?fogPass=` in the page, `FOG_KERNEL=` and `FOG_PASS=` in Node):
* **The block loop** (`fog.rs walk_blocks`, [volumetric-fog](volumetric-fog.md) "Block loop"): the light-independent terms once per surface, four texels
  at a time on wasm simd128, hits on the scalar tail, the reference body for anything outside `Single`'s bounds; bands for surfaces above 8192 texels.
  `?fogKernel=reference` is the old loop, `?fogKernel=verify` runs both and counts the maps that differ.
* **The pass' host side** (`fog-pass.mjs`, `volumetric-fog.mjs`): the kernel's own aligned buffer read through a view instead of `.slice()`
  (valid until the next kernel call; every consumer reads it at once and the child frames' copies are made at the call); the atlas tile and
  the item textures written a 32-bit word at a time (red and blue bytes exchanged); the switches read once per update instead of at every
  call; the grid's nine words made in a scratch array. A mover item keeps its lightmap basis, lattice, geometry attributes and texture across frames
  while the numbers they are functions of (the facet's twelve numbers, the fragments' points, the map's texels) are unchanged: a mover at rest keeps
  all three while the camera moves, and a map equal to the last one written is not written or uploaded again (in the render phase too: `p.render`
  4.1-4.6 -> 2.8-3.1 ms at the same spots). `?fogPass=reference` rebuilds everything every frame; `?fogPass=verify` rebuilds beside the kept ones and counts
  differences (`deusExViewer.fog().stats.verify`).

**Byte identity.**
* *Kernel calls of real sessions, replayed* (`scripts/fog-capture-play.mjs` + `fog-replay.mjs`): headless Firefox inline, the loop on its reference
  path, 240 views around each map's fog spots (movers, mover lattices and the real flag chain included; 244 to 1,470 light packs a map), every distinct
  call's inputs and the hash of its answer kept. The hashes are master's: the export of 61cc9524 with its own wasm module (one loop) reproduces
  all of them, 128,015 distinct calls with the 12-view test capture. Replayed through the block loop and, in the same run, the reference loop: all equal, bytes and final flag.
  02_NYC_Underground 18,433 distinct calls (26,688 made, 362,892,112 texel-lights), 04_NYC_Underground 15,272, 08_NYC_Underground 17,951, 04_NYC_NSFHQ
  12,749 (surfaces up to 65,536 texels: the bands), 02_NYC_BatteryPark 41,476, 03_NYC_AirfieldHeliBase 8,689, 02_NYC_Bar 10,157: **124,727 distinct calls,
  422,331 made, 1.2 billion texel-lights, 0 differences**.
* *In the page* (`?fogKernel=verify&fogPass=verify`, 240 views a map, the same seven maps): 444,000 maps compared block loop against reference loop
  (0 differing; NSFHQ's above-8192-texel maps by two hash lanes), 431,000 atlas tiles word writer against byte writer (0), and where mover items exist
  (the three Undergrounds and Battery Park) 12,300 kept lattices, 11,900 kept geometries and 13,100 skipped texture writes against fresh ones (0 differing).
* `validate-volumetric-fog` (the Rust loop against the unchanged Render.dll at control word 0x007f, 1,620 surfaces), `validate-volumetric-fog-fast`
  (Play's inputs on the Bar, WanChai Market, Ship and Battery Park, 447,910 surface maps: the block loop and the reference loop both equal `Exact`, and
  `fog.verify` finds nothing), the new `validate-fog-blocks` (1,500 random surfaces of every shape the loop has a branch for; block loop = reference loop on
  every byte and flag, and `Exact` on the 1,457 smaller ones) and `validate-volumetric-fog-play` (worker mode: the Bar's mover map and the Club's mirror
  map equal to the unchanged loop, fog pages equal to their pixels on the GPU) pass.
* *Sim digests* (`bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback`) unchanged: Island 5adb254a07b1ed6f, 00_Training 07816ec472f29b84,
  03_NYC_Airfield 46ed0d32ae5b56af, 06_HongKong_WanChai_Market 80d27b37e0944d88, 15_Area51_Bunker 764a7bdffd2ebe59, 09_NYC_Dockyard e53f348673f1247b.

**Node (V8) kernel replay, distinct calls of the captures, reference loop -> block loop** (ms, medians of 3; `fog-replay.mjs --bench`): 02_NYC_Underground
1413 -> 314, 04_NYC_Underground 551 -> 132, 08_NYC_Underground 480 -> 119, 03_NYC_AirfieldHeliBase 304 -> 75, 04_NYC_NSFHQ 2386 -> 1408 (big surfaces, few lights),
02_NYC_BatteryPark 134 -> 87 and 02_NYC_Bar 104 -> 91 (one light each: little to share).

**A/B, Firefox inline, interleaved, three pairs a spot, master 61cc9524 (an export of it, its own wasm) against this branch** (`.work/ab-trees.mjs`,
20 s sessions, 5 s skipped; page = the page's frame work `animate`; the slowest tenth is the mean of the slowest 10% of frames):

| Spot (yaw) | arm | page mean | slowest tenth | p50 / p95 | `p.fog` | `p.render` |
|---|---|---:|---:|---|---:|---:|
| 02 (638, -191, -361) 32768 | master | 28.92 | 37.45 | 27.7 / 35.7 | 10.44 | 4.13 |
| | this branch | 20.08 | 24.32 | 20.0 / 23.7 | 3.20 | 2.81 |
| 02 (-73, 636, -361) 49152 | master | 32.95 | 41.81 | 32.0 / 39.7 | 11.35 | 4.43 |
| | this branch | 23.42 | 29.68 | 23.0 / 29.0 | 3.47 | 3.10 |
| 02 (234, 605, -361) 49152 | master | 29.43 | 37.52 | 28.3 / 35.7 | 10.55 | 4.55 |
| | this branch | 19.17 | 24.54 | 18.7 / 23.7 | 3.21 | 2.95 |

Every session of every pair has the same order: the page mean is 8.8 to 10.3 ms lower in the three spots' means, the slowest tenth 12.1 to 13.1 ms lower
(ship bar: 0.3 and 0.5 ms).

**The view moving.** The idle A/B lets a mover item skip its texture write and a level surface keep its tile; with the view changing every frame the writes and
uploads come back, and what is saved is the loop and the host's copies and rebuilds. `hitch-run.mjs --spin DEG [--spin-sweep AMP]` (new) turns or sweeps the view
through `placeProbe` every 16 ms (the same schedule in both arms). Sweeping 15 degrees either side at a peak of 60 degrees a second, the middle spot, three pairs:
page mean 34.23 -> 26.33, slowest tenth 44.00 -> 35.31, p50 33.3 -> 25.3, `p.fog` 11.43 -> 5.06, `p.render` 4.89 -> 4.50 ms. Turning once round at 90 degrees a
second, three pairs a spot (the view faces the fog surfaces for part of each turn only): page mean 18.53 -> 15.49, 18.68 -> 18.10, 17.45 -> 14.49; slowest tenth
35.10 -> 25.89, 34.95 -> 29.85, 34.94 -> 25.79; `p.fog` 3.25 -> 1.67, 3.29 -> 1.70, 3.06 -> 1.64; `p.render` unchanged (1.6 to 1.8). Roaming
(`--mode roam`, 40 s, three pairs from the middle spot) left the fog zone in most of its frames in both arms (`p.fog` 0 to 1.1 ms) and says nothing about the phase.

**Chromium** (headless, sim worker, the middle spot, two pairs, the same master export): page mean 18.76 -> 7.72, slowest tenth 23.67 -> 9.31, p50 18.3 -> 7.7,
`p.fog` 12.19 -> 2.94, `p.render` 3.68 -> 2.26 ms; the page frame there was above 16.7 ms and is under it now.

**What is left, and what was not done.**
* The fog phase is 3.2-3.5 ms (Gecko: 1.79 ms in `light_blocks`, 0.16 `fill_band`, 1.41 JavaScript). Classification dominates the loop (1.2 ns a texel-light in V8).
* **A cull of whole (surface, light) pairs** was analysed offline and not built: the pairs it would skip (in the 240-view 02_NYC_Underground capture 94.7% of the
  (surface, light) pairs have no hit at all, exactly) are decided by a geometric test whose margins need their own proof, and the gain is about 1 ms of 3.5 (under the 5%
  bar for a frame of 20 ms). The prototype test (a bounding cap of the surface's texel directions, a light missed when the cap and the light's sphere are apart by a margin on its
  angular radius, in doubles; `.work/exp-cull.mjs`, not kept) skipped 58% of the texel-lights of that capture (41.6% of its pairs) with no pair wrong; by raster chunks of
  256 down to 32 texels, on 08_NYC_Underground's capture, 49% up to 66% of the texel-lights (the exact bound there: 90% to 95%). A tighter bound needs the pyramid of the
  surface's side planes.
* **A memo of a call's answer across frames** (the kernel is a pure function of the lights' words and tables, the nine grid words, the incoming flag and the size)
  would remove the loop when the view does not change (a player standing still), and nothing when it does; the idle A/B would show it far larger than play
  would, so it was not built. The spin A/B above (the view turning at 90 degrees a second) is the case with no reuse across frames.
* The new module needs wasm simd128 (Chrome 91, Firefox 89, Safari 16.4) and carries 31 KB more code and 165 KB more statics (`__heap_base` 0x1b21b0 -> 0x1da9e0 of the
  0x200000 reserve).
* Not measured: the Mac, headed runs. The sim worker's Chromium path pays the same fog pass on the page (below).

### Tick hand-backs (2026-11-07)

The task: after the Dockyard, combat and actors-layer merges the simulation tick is still the largest part of Firefox's frame at the
Dockyard spot (2623, 6205, 20) yaw 32768 (page mean about 31.9 ms, tick about 15.7) and in the Metro and Vandenberg fights; what is left
is where the Rust VM hands control back to JavaScript. Each candidate had been measured below the ship bar alone; this is the bundle.
Master 61cc9524, headless Linux (Firefox 155 inline, Chromium worker mode, 1440x960, god mode, idle at the spot, 25 s sessions measured
from 5 s after the map); the Mac is not measured. Bar: 0.3 ms in the Firefox page mean or 0.5 ms in its slowest tenth.

**Reproduction.**
* Dockyard at load: `hitch-run.mjs --browser firefox --map 09_NYC_Dockyard --mode idle --god --seconds 25 --place '{"location":[2623,6205,20],"rotation":[0,32768,0]}' --profile FILE`,
  read with `gecko-slow-ticks.mjs`, `gecko-under.mjs` (`--anchor '^js_tick_resume'`, `'^cleanupLevelDestroyed'`, `--above` for callers).
* The same place in Node: a one-spot places file and `PLACES=FILE PER=100000 FROM=0 TO=1 bench-sim --map 09_NYC_Dockyard --warm 100 --ticks 900
  --render-feedback --idle --seed 1 --scenario scripts/scenarios/places-replay.mjs` (digest `eba45015fec39e3f`), with
  `scripts/script-vm-fallback-census.mjs` as the scenario (`BASE=scripts/scenarios/places-replay.mjs`, `SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_TIME=1
  SCRIPT_VM_STATS_DETAIL=1`) for the hand-back census, `--cpu-profile` for a V8 profile. The Metro fight is the Combat tick's command.

**Ranking on master (Firefox, one Gecko profile, 691 drawn frames; ms a frame by the Rust core's import, rest 622 frames / slowest tenth
69 frames; the tick is 16.9 ms in the rest, 32.0 in the tenth, 15.2 and 28.3 sampled).**

| Import | rest | slow | note |
|---|---:|---:|---|
| `js_eval` | 3.83 | 5.36 | flat in the rest (spawn, AttachDecal, SetRotation, Destroy, PlaySound, small natives) |
| in Wasm | 1.73 | 1.87 | |
| JavaScript, no Wasm under it | 1.63 | 4.38 | the slow tenth's `cleanupDestroyed` is 2.90 against 0.17 |
| `js_tick_resume` | 1.38 | 6.68 | **+5.3: one call, `ScriptedPawn.GetProjectileList` (`js_int` 4.57 against 0.19)** |
| `js_move_riders` | 0.62 | 1.09 | its leaf `nextCandidate` 0.36 / 0.62 |
| `js_move_encroach` | 0.52 | 1.41 | the hash query; 0.72 of the tenth's extra is a major GC slice landing in it |
| `js_walk_prelude`, `js_tick_state`, `js_tick_destroy` | 0.49, 0.38, 0.38 | 0.55, 1.09, 0.52 | |
| `js_fall_bounce` | 0.30 | 0.49 | the gas's HitWall event |

* **The slowest tenth is two things.** (1) `GetProjectileList` (the pawns' dodge list): the poison gas is a `DeusExProjectile`, so the
  `RadiusActors` loop in `GetProjectileList` finds a dozen dangerous projectiles and calls `AddProjectileToList(out NearbyProjectileList
  projList, ...)` for each. Both functions ran in JavaScript's `callFunction`: the callee has an `out` struct parameter (an array of eight
  structs of an object, a vector and two floats, and a vector: 51 scalar leaves), a vector parameter, and its statements read and wrote
  `projList.List[i].member`, which the lowering left to the closures (each copied the whole array of structs: `describeEntry`,
  `copyScalar`, `copyGenericStruct`). Node, census at the same place: the family is 1.24 ms a tick of self time in the slowest tenth and
  none in the rest, `GetProjectileList` 3.4 ms a call inclusive, `AddProjectileToList` 318 us a call. (2) `CleanupDestroyed`: once 128
  destroyed actors are pending the original walks every actor of the level and clears each object pointer that names a pending-kill
  object (9 passes in 900 ticks, 16,936 actor scans, 5 pointers cleared). These are the 25 to 80 ms ticks of the tail: 1% of the frames,
  2.9 ms of the tenth's average. Its pieces: `cleanupImageSites` 1.34 (the site loop 0.74 self; bound fields' sites read through
  their bindings 0.4), `release` 0.73 (createLevelCollection.release filtered the whole object registry before and after each release).
* **The rest frames** are flat (above). Node mean at the spot, self ms a tick: AttachDecal 0.32 (the Rust attach inside), SetRotation
  0.24, Spawn 0.24, Destroy 0.11, SetLocation (context) 0.10; Firefox: `spawnActor` 1.22 inclusive (0.77 spawns a tick, 1.6 ms each in
  Firefox against 170 us in Node), `processEvent` 0.60, `checkEncroachment` 0.66, `moveActorRiders` 0.61, `destroyActor` 0.53.
* Metro fight (spot 54 replayed, Node census): the tenth is 12.6 against 8.2 ms; Spawn 0.49, `FindPathToward` 0.17, `AttachDecal`,
  the player's tick, small natives; the NearbyProjectile family is 0.15 (the fight has few projectiles near the pawns). Nothing in it is a
  hand-back family; the three changes below are the Dockyard's and do not move the Metro (below).

**What moved** (three switches, the JavaScript bodies kept as the references).
1. **Struct arrays in the Rust VM** (`STRUCT_ARRAYS` / `?structArrays=`, `rust` default, `js`, `verify`; script-vm-lower.mjs,
   script-object-image.mjs `flatStructMembers`, interp.rs `LOCAL_ELEM_VECTOR` 209, `SET_LOCAL_ELEM` 210, `P_VECTOR` 7, `P_ROTATOR` 8,
   `P_STRUCT_IN` 9, iter.rs). A fixed-array member of a struct local (`projList.List`) is a local array at the struct's offset plus the
   member's, so the existing element reads serve it (the lowering only had to compose the offsets) and the new kinds add the vector
   element read, the store to a scalar or vector element (the target's reference first, then the value, then the codec copy of the
   value into the element's bytes; an index outside the array runs the whole Let in JavaScript with the value unevaluated) and a vector
   member of a struct local as a local vector (`projList.center = Location`). A call can pass a vector or rotator argument (stored as
   `SET_LOCAL_VECTOR` stores one) and a struct by value (copied in like an out one, not copied back: `IsLocationDangerous(projList, ...)`),
   and a struct out argument is copied by its flattened leaves (nested structs, fixed arrays, vector components: 51 leaves for
   NearbyProjectileList) instead of scalar members only. *Evidence:* every piece is a transcription of the closure for the same node
   (compileEv 0x1a / 0x36, compileAssign's generic path, callFunction's copies), and the output is the digest of every actor of the level:
   see Checks. Not the original's bit-for-bit memcpy: a store through the closures rewrites the whole struct through the codecs and a
   store here writes the member's bytes, which differs only for a signaling NaN in another member or an object handle already
   released there (reads go through `live`/`identityOfHandle`); the vector codec's NaN canonicalization in a V8 array is not reproduced
   (the Rust copy is the original's float copy).
2. **SetRotation statements** (`SET_ROTATION` / `?setRotation=`; interp.rs `SET_ROTATION` 211). A statement `SetRotation(R)` or
   `X.SetRotation(R)` (native 299) is `setScriptRotation` (docs/script-set-rotation.md, ULevel::MoveActor with a zero Delta) over the five
   Actor fields in the image: a static or immovable actor and an unchanged rotation are left alone, riders (`StandingCount`, a byte) or a Brush run
   the native in JavaScript, else the three ints are stored; the context object is evaluated first with SELF. Premises (checked when
   lowering): the runtime's own `invokeNative` reaches the 299 branch and the level is not an editor level. `=verify` decides every
   statement again from `readNamed` before storing.
3. **CleanupDestroyed's pointer scan** (`CLEANUP_SCAN` / `?cleanupScan=`; cleanup.rs, script-vm-cleanup.mjs). The inner loop of
   `cleanupImageSites` is `vm_cleanup_scan` over the class plan's offsets (copied into the arena once per plan) and a table of the
   pass's verdicts keyed by handle; the scan stops at a handle with no verdict (the host asks IsValid and IsPendingKill exactly as the
   loop did at the first site that names the object, and enters the verdict) and at a site that names a pending-kill object (the
   host clears it through the property reference as before). Every actor has host bindings (Class, Outer, Name, Level), whose sites are
   read through the binding; they are looked at per actor (one `Map.get` per binding) and read first, before the scan, which passes
   them: the clears are the same, in another order, and only an error would name another invalid reference first. The release log:
   `createLevelCollection.release` found the objects a release freed by filtering the registry before and after; `freeObject` now
   logs them and the call sorts the log by registry index (`=verify` compares the two lists).

**A/B.** The new arm is the defaults, the old arm `structArrays=js&setRotation=js&cleanupScan=js` (the JavaScript references; same commit, same
inputs). Firefox sessions are pinned to CPUs 4-7 and 12-15 (`hitch-ab.mjs --cpus`, new). The first A/B, of the struct arrays alone with four
unpinned pairs, was inconclusive and is not used: tick 15.59 new / 15.27 old, page mean 30.58 / 29.90, while the sessions' `p.render`, which
nothing there touched, ranged from 2.7 to 3.6 ms (another worker's jobs share this host). The A/B below is two sets of six pairs of the
whole bundle, the arms' order alternating inside a set, from 5 s after the map; ms.

| Firefox inline, Dockyard (12 pairs) | new | old | new - old (pairs) | se | better in |
|---|---:|---:|---:|---:|---:|
| tick `p.tick`, mean | 15.75 | 17.03 | -1.28 (median -0.57) | 0.55 | 9 of 12 |
| tick, slowest tenth | 24.30 | 27.89 | -3.59 (median -3.19) | 1.26 | 10 of 12 |
| page `animate`, mean | 30.85 | 32.83 | **-1.98** (median -0.71) | 0.96 | 9 of 12 |
| page `animate`, slowest tenth | 41.69 | 46.41 | **-4.72** (median -4.55) | 1.53 | 10 of 12 |
| `p.render` (not touched: the drift control) | | | -0.18 | 0.13 | 8 of 12 |

The pairs' page-mean differences (new - old): -4.3 -1.0 +0.2 -0.4 +1.9 -6.9 | +2.8 -3.1 -0.2 -0.1 -5.2 -7.3; the slowest tenth of ticks: -3.8
-6.5 0.0 -0.8 +2.3 -8.4 | +2.7 -6.3 -2.6 -0.8 -10.1 -8.7. The mean's spread is wide (the old arm has the heavier tail: its sessions with a
cleanup pass in a slow stretch read 18 to 19.4 ms of tick in four pairs, the new arm's worst is 17.5), so the figure to lean on is the slowest
tenth (10 pairs of 12) and the median of the mean; the mean's t is -2.1 on 12 pairs.
The profile-based expectation was smaller (about 1 ms of page mean): one Gecko profile of the new code (not an A/B) reads the slowest tenth
of ticks at 26.7 ms against 32.0 on master, `js_tick_resume` 2.17 against 6.68 in the tenth, `cleanupLevelDestroyed` 2.2 against 3.0.

| Firefox inline, Metro places run (spots 0 to 60, 4 pairs) | new | old |
|---|---:|---:|
| tick mean | 6.70 | 6.72 |
| tick, slowest tenth | 12.44 | 12.48 |
| page `animate` mean / slowest tenth | 14.13 / 23.18 | 14.02 / 22.96 |

No effect on the Metro (pair differences of the tick mean -0.12 +0.18 +0.02 -0.16): its places run is mostly quiet spots, and the fight
spots hold little GetProjectileList work and no cleanup pass (the census above). **Node** (interleaved pairs, order alternating, one lock hold each;
tick ms of 900 placed ticks / 300 ticks after the replay; the digests of all runs equal):

| Node | new | old | new - old (pairs) |
|---|---:|---:|---|
| Dockyard placed, tick mean (5 pairs) | 8.52 | 8.87 | -0.35 (-0.60 -0.41 -0.58 -0.09 -0.08) |
| Dockyard placed, median | 7.98 | 8.15 | -0.17 |
| Dockyard placed, slowest tenth | 14.38 | 16.34 | **-1.96** (-2.73 -2.13 -2.33 -1.02 -1.58) |
| Metro 54 replayed, tick mean (5 pairs) | 8.98 | 9.34 | -0.36 (-0.47 +0.39 -2.33 +0.38 +0.23: one old-arm outlier; the medians of the ticks are 8.67 / 8.68) |
| Vandenberg 98 replayed, tick mean (3 pairs) | 8.62 | 8.97 | -0.35 (-1.29 -0.04 +0.28) |

**Result: meets the bar at the Dockyard, shipped on this branch** (page mean -1.98 ms against 0.3, slowest tenth -4.7 ms against 0.5; Node
-0.35 ms and -1.96 ms in the tick's slowest tenth). The Metro fight does not move. The page mean at the Dockyard stays near 31 ms: this is a 6%
step, not the goal.

**Checks.**
* `bench-sim --map NAME --warm 60 --ticks 300 --render-feedback`: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield
  `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, Dockyard `e53f348673f1247b` unchanged (also at
  `STRUCT_ARRAYS=verify` for the Island, bunker and Wan Chai). Combat replays: Metro 54 replayed `09e2d44972cca30a`, freshly placed
  `a6011ede7236c1d2`; Vandenberg 98 replayed `ed184bd3eb533bc1`, freshly placed `1db79eb398240a97`: unchanged (the replays also at
  `STRUCT_ARRAYS=verify`). The 900-tick placed Dockyard run: `eba45015fec39e3f` for the default, each switch at `js`, and all three at `verify`,
  and, on the struct arrays change alone, with `SCRIPT_VM_CHECK=1` (1,004,454 reads compared with the closures, 80,697 of them array elements).
* What the verify runs compared at the Dockyard (counters of the hosts): 5,583 stored elements read back through the closure of the
  target (1,057 vector elements), 13,014 struct copies compared leaf by leaf with the codec copy, 30,013 SetRotation statements
  decided again from `readNamed` (all agree), 16,936 actors scanned against the JavaScript loop (27,301 scans, 10,360 verdicts
  decided by the host, 46,059 bound sites read first, 5 pointers cleared, the same sites in every actor), no tick error.
* `validate-script-vm-interp` (159 kinds, 542,434 checks; new cases: SET_LOCAL_ELEM for five value kinds and seven indices, in and out of
  range, order of the index and the value, the verify read-back; LOCAL_ELEM_VECTOR with a signaling NaN component; P_VECTOR/P_ROTATOR in
  order with other arguments; P_STRUCT_IN; SET_ROTATION in all its branches on SELF and on a context, the unaddressable field, None and
  the order; `vm_cleanup_scan`/`vm_cleanup_insert` against a model over random tables with probe collisions, skipped sites and clears),
  the validators of the cleanup, destroy, loadmap, plant-push, spawn, play-hud, trigger, decal and rotation families (the rotation
  family's `validate-native-set-rotation-riders` needs `reports/movement/mover-move/scene.json`, an ignored report this worktree does not
  have: not a result), `test/script-cleanup.test.mjs` (the dry run and the shared verdict), `test/native-registry.test.mjs` (299 is in the
  Rust-lowered list; a local named `call` with `.index` in the lowering is a dispatcher to that test). Chromium worker mode and Firefox
  inline with the three switches at `verify` (`hitch-run.mjs --probe-switches`: the worker lists all three): 2,009 and 994 drawn frames, no
  page error. `npm test`: 966 tests, 962 passed, 4 skipped, 0 failed. The Rust build is warning-free.

**Tried and not shipped, and what is left.**
* **The mover rider scan in Rust** (`nextCandidate`, 0.41 ms a rest frame in Firefox, 0.13 in Node): not built. Node counts 40,938 calls
  and 9.56 million slot visits in 900 ticks (45 calls and 10,600 slots a tick, 12 ns a slot in V8): the cost is the number of visits,
  not a slow loop, and a Rust loop needs the level's current actor handles, which the mirror syncs with an O(N) pass after every spawn,
  destroy and compaction (the scans follow those): the pass it would remove is the pass it would need. The exact cut is a rider list kept
  as identities across CompactActors' stable shifts, not a faster loop; it changes `baseEpoch`'s contract and is not attempted.
* **`js_fall_bounce`** (0.30 ms a rest frame): the HitWall event's JavaScript hop. `wasm HitWall` is 2.5 calls a tick at 61 us each
  inclusive; the body is content (spawn, AttachDecal), the hop is not separable in the profile. This step adds the CALL half of an event
  with a vector argument (P_VECTOR); dispatch.rs's event cache still stores one scalar parameter.
* **SetRotation** moved 12 of 14 local-rotator statements a tick; the other two (riders or a Brush: a Mover's) and `SetRotation(
  Rotator(Velocity))` (the gas, 7.7 a tick: the cast's x87 atan2 is not a Rust node) stay in JavaScript; the Node saving is 0.04 ms a tick.
* **Encroachment** (`js_move_encroach` 0.52 ms rest, 1.41 in the tenth, 0.72 of the tenth's extra a major GC slice landing there): the
  hash query's blocking test needs the candidates' flags; not built.
* **Spawns**: `spawnActor` is 1.22 ms of the rest frame (0.77 spawns a tick, 1.6 ms each in Firefox against 170 us in Node), the largest
  JavaScript item left at the Dockyard; its pieces are the construction (`initProperties`, `Object.defineProperties`), the six script
  events and the invalidation, none over 0.13 ms in Node. The next cut is a Rust owner for the spawned instance.
* Bound sites in the cleanup pass (three a actor, 46,059 in the run) are still read through their bindings in JavaScript; they are the
  cleanup scan's remaining cost, about half of it.

### Moving lights (2026-11-07)

The task: the moving-light recomposition (`p.lightAnimation`) was the largest draw-side cost left that is tied to a place; make it cheaper without
changing one output bit. Result, all headless Linux (Ryzen 9 8945HS, Node 26, Firefox inline 1440x960, god mode; the Mac is not measured):
**`p.lightAnimation` 3.99 -> 1.93 ms and `p.lightUpload` 0.91 -> 0.51 ms at the Mole People spot (page mean 17.33 -> 14.10 ms), and 5.14 -> 1.40 ms at the
Vandenberg Tunnels' alarm-light views (page mean 19.13 -> 14.76 ms, slowest tenth 27.7 -> 19.8 ms)**; the light-map floats and the atlas bytes are
identical to master's (below). Three changes did it: the composition and the atlas conversion in the Rust core, a turning spotlight keeping its reach,
and contributions that cannot write a texel left out.

**Reproduction and the phase before.** Spot: `node scripts/hitch-run.mjs --browser firefox --map 03_NYC_MolePeople --mode idle --god --seconds 20
--place '{"location":[2469,-179,23],"rotation":[0,32768,0]}' --out OUT --profile OUT.gecko.json`, then `node scripts/gecko-phase.mjs OUT.json
OUT.gecko.json --entry syncMovingLights` (master bc32e5a9). Two findings about the phase itself:
* `p.lightAnimation` is not only `syncMovingLights`. The mark `phase('lightAnimation')` in main.mjs closes the building of the frame's drawn sets, and
  the one in `updateTextureAnimation` closes `syncMovingLights` and the class 1 light animation (`lighting.animate` and its atlas writes); `p.lighting` is
  `relightMovers`, `p.lightUpload` is `flushLighting`. At the Mole People `syncMovingLights` is 3.75 of the 4.12 ms; at Battery Park it is 0.39 of
  1.9 ms (the class 1 merge and its atlas writes are the rest, see below).
* The census' hot views are *states*, not places. A fresh idle run at the Vandenberg spot costs 1.7 ms, the census 4.3 to 5.7: the extra is the
  AlarmLight (`LE_Spotlight`, turning) near spots #48 to #55 of the census' list, which `hitch-run.mjs --places` reproduces from the census' own list
  (spots 40 to 59 are enough: 4.4 to 5.6 ms at the eight views in master, in each of the runs). The Dockyard's hot views reproduce the same way (2.1 to 2.9 ms
  at the census' spots #140 to #144, `.cache/perf/spot-census/firefox-MAP.places.json`). **Battery Park's 5.3 ms at (2025, -3396, 263) did not reproduce**: its
  spots cost 1.6 to 2.3 ms in two places runs and at rest, most of it the class 1 light animation. `gecko-phase.mjs` takes `--spot N,N` (a --places run's spots) and `--where
  'p.lightAnimation>3'` for this; `hitch-run.mjs --eval EXPR` saves a page expression at the end of a run.

**Ranking (measured before any change; Gecko, ms a frame).**

| Place | Phase | Parts |
|---|---|---|
| Mole People (27 barrel fires, FireWaver, 878 light maps) | `syncMovingLights` 3.75 | the atlas conversion (`light-atlas.mjs update`) 1.45; the composition 1.95 (`addDirect` 0.80 self, the modulation lookup 0.34, `setMoving`'s restore 0.29 and its `subarray` calls 0.28); bookkeeping about 0.3 |
| | `flush` (`p.lightUpload` 0.91) | `texSubImage3D` 0.42; `rectangle()` repacking each rectangle's rows 0.42 |
| Vandenberg Tunnels, the alarm light's views | `syncMovingLights` 4.3 (build with the Rust composition, before the reach change) | `reachLight` 3.13 (`reachRecord` 1.88: `movingLightRect` 1.0, the grid and facet 0.7; `filterMovingLight` 0.4; `recordsFor` 0.3; `reachOwned` 0.2), the composition 0.54 |
| Dockyard, hot views | `syncMovingLights` 2.06 (master) | composition 1.07 (the addends of a light that turns, `spotLightSpatial`), `reachOwned` 0.39, `contributionsOf` 0.13 |
| Battery Park, at rest (Gecko of the build with the Rust composition) | `syncMovingLights` 0.39 of `p.lightAnimation` 1.9 | the class 1 merge 0.30 and its atlas `update` 0.63 (not moving lights) |

The per-texel work at the Mole People is 83,000 texels a frame in the page (about 166 light maps of 500 texels, from the counters of the verify run
below), so the cost there is the per-texel loops and the per-rectangle JavaScript around them; at the Vandenberg spots it is the per-frame rebuild
of a light that turns: a light whose inputs change is reached again from scratch (the BSP filter, a rectangle and a facet for each of ~1,700 light
maps), 3 ms, where the surfaces and rectangles do not depend on the axis.

**What changed** (each old body stays behind `?movingCompose=js|rust|verify`, `MOVING_COMPOSE=` in Node; [dynamic lighting](dynamic-lighting.md#rust-composition-and-the-atlas-conversion-2026-11-07)):
* **The composition and the atlas conversion in Rust** (`moving.rs`, `moving-compose-kernel.mjs`): `addDirect`'s saturating add on the float32 texels
  (the double sum rounded to float32, `min(127/255)`), the modulation entries on demand, and `LightAtlas.update`'s float to byte conversion with the
  padding, for every light map recomposed in a frame in one call, the conversion four texels at a time on wasm simd128 (the same operations). JavaScript
  keeps the reach, the spatial bytes, the colours and the pages; a light map keeps a kernel block with its contributions' rectangles and spatial bytes
  while its list of contributions is the same (a list that lives one frame is copied into the batch's scratch). The light atlas copies the packed texels
  into the page a word at a time (`writePacked`), and a deferred rectangle uploads from the packed texels themselves while they are intact (the
  upload no longer repacks the page's rows: `flush` 0.91 -> 0.51 ms).
* **A turning spotlight keeps its reach.** When only a spot light's Rotation changed, the surfaces it reaches, their rectangles, incidence and grids do
  not (none reads the axis); only the spatial bytes are made again. The mover light maps placed again since are reached on their new facets, as for
  an unchanged light. `?movingCompose=verify` makes the reach in full beside it and compares (`stats.verify.reaches`).
* **Dead contributions.** A contribution whose spatial bytes are all 0 writes no texel in any frame (the loop skips a 0 byte before and after the
  modulation); it is left out of the job, and a light map with nothing else to recompose is not recomposed (master recomposes it unchanged every frame:
  at the Vandenberg spot 299,000 of the 379,000 composition requests of a 300-frame run in the Node driver had no live contribution).
* **Byte sources a word at a time:** `LightAtlas.update` with `bytes` (the class 1 merge's texels) copies a word a texel; the byte loop stays under
  `?movingCompose=js`.
* Smaller: the batch's job objects are reused, the atlas rectangle of a kept block is kept with it.

**Byte identity.**
* *Against master, in the Node driver* (`scripts/moving-lights-bench.mjs`, which boots the map through `createGame` and `createWorld`, puts the player at the
  spot, and each frame hands the world the light frame, the movers and `game.movingLights()`, with the light maps in the view's frustum as the drawn ones):
  60 frames of warm-up and 240 frames, after every frame a sha1 over the float bits of every moving light map and a sha1 over every atlas page, for the export
  of master bc32e5a9 (`git archive`, its own wasm) and this branch. **Equal at all six spots and in the Training AugLight room** (F12, the player turning, every
  light map drawn; 41.6 moving light maps on average):

  | Map, place | moving light maps, recomposed a frame, texels written | texels sha1 (master = branch) | atlas sha1 (master = branch) |
  |---|---|---|---|
  | 03_NYC_MolePeople (2469, -179, 23) | 878, 785, 90,628 | 559c9df4a528edd1 | e561a012fa128cc5 |
  | 12_Vandenberg_Tunnels (-2621, 2725, -2589) | 2,105, 253, 7,385 | fe90000ea315554a | 051ca55a367096ae |
  | 12_Vandenberg_Tunnels (-2100, 2709, -2589) | 72, 0, 270 | 51a69237a8a4b9d4 | 5b448ea11d5a8e95 |
  | 09_NYC_Dockyard (2623, 6205, 20) | 513, 0, 371 | e78e6cf1d5711fab | 7bbb098e02db44cb |
  | 09_NYC_Dockyard (3785, 6204, 20) | 345, 34, 686 | 60aa7341a33ba8b4 | 259c5261a124b852 |
  | 02_NYC_BatteryPark (2025, -3396, 263) | 575, 193, 26,796 | a6228e218c1f5a65 | 38dc1b9caa96cfc4 |
  | 00_Training, AugLight | 42, 30, 3,519 | 49e6754830de9681 | 93ee166691f88c5a |

* *In the page* (`?movingCompose=verify`, Firefox inline, idle 20 s at the spot, `deusExViewer.movingLights().stats.verify` read at the end with
  `hitch-run.mjs --eval`; every job of the Rust composition compared with the JavaScript bodies' result on the same inputs: the rows of floats as bits, the
  texels written, and after the atlas update the page bytes of the rectangle; every carried-over reach of a turning spotlight against the reach made in full):

  | Run | jobs compared | floats, counts, atlas bytes differing | reaches compared (differing) |
  |---|---:|---:|---:|
  | Mole People spot | 207,903 (104 M texels) | 0 | 0 |
  | Vandenberg spot | 106,781 | 0 | 455 (0) |
  | Vandenberg, census views 40 to 59 (the alarm light) | 72,781 | 0 | 493 (0) |
  | Dockyard spot | 260 | 0 | 0 |
  | Dockyard, census views 132 to 149 | 57,201 | 0 | 684 (0) |
  | Battery Park spot | 51,604 (33 M texels) | 0 | 0 |

* `validate-moving-convert` (the atlas conversion for all 2^32 float32 bit patterns, and the integer step the bytes follow), `test/moving-compose.test.mjs`
  (random light maps, colours, steps from -2^31 to 2^31-1, effects 1 to 3; the core against a copy of `addDirect` and the real `LightAtlas.update`; the word
  copy against the byte loop) and `validate-moving-lights-incremental` with `MOVING_COMPOSE=verify` (Training with the AugLight, Island and Airfield with seeded
  perturbations: lights leaving and returning, swapped and repeated entries, mover offsets, probe lights on the Strobe/WateryShimmer, NonIncidence, Flicker/
  FireWaver and turning spotlight bodies; 240 frames each) (Training 270 frames with the AugLight, Island and Airfield 240 each: 15,408, 160,116 and 215,515 jobs verified against the JavaScript bodies and 390 and 406 carried-over reaches against the full reach, no difference; the incremental world equal to the full-mode world, light maps, floats, static copies, moving regions and atlas pages, in 475,795 light-map states, and to the gated world's in every drawn one).
* Validators, with the new composition on: `validate-dynamic-lighting` and `validate-normal-moving-lighting` (the JavaScript bodies against the original Render.dll under Unicorn), `validate-auglight-lighting` (the AugLight's light maps in Play against it), `validate-moving-light-effects`, `validate-dynamic-light-mover`, `validate-mover-light-maps` and `validate-light-spatial` (the native ones with `NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python`), and in the browser `validate-moving-light-effects-play` (Chromium, worker mode: the Island's BarrelFire3 light maps equal the oracle's for each frame) and `validate-mover-light-maps-play` pass. `validate-light-atlas-upload --map 03_NYC_MolePeople --place <the Mole People spot> --packed` (new options): after 240 flushes with the player at the fires the GPU array layers equal the CPU pages in Chromium and in Firefox, with 39,381 and 39,428 rectangle uploads taken from the core's packed texels, no page texture uploaded and no whole-array upload owed. `npm test`: 968 tests, 964 pass, 4 skipped, 0 fail.
* Sim digests (`bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback`) unchanged: Island 5adb254a07b1ed6f, 00_Training 07816ec472f29b84, 03_NYC_Airfield 46ed0d32ae5b56af, 06_HongKong_WanChai_Market 80d27b37e0944d88, 15_Area51_Bunker 764a7bdffd2ebe59, 09_NYC_Dockyard e53f348673f1247b.

**A/B, Firefox inline, interleaved, three pairs a case, the export of master bc32e5a9 (its own wasm) against this branch** (`.work/ml/ab.mjs` runs one
`hitch-run.mjs` session per arm in turn, the order reversed in every second pair, each under the heavy lock; 20 s idle sessions at a spot, or the census'
list of views cut around the hot ones; the frames from 5 s after the map; the slowest tenth is the mean of the slowest 10% of frames; the `p.` columns are
means over the frames counted; every pair has the same order unless said):

| Case | arm | page mean | slowest tenth | p50 / p95 | `p.lightAnimation` | `p.lightUpload` |
|---|---|---:|---:|---|---:|---:|
| Mole People (2469, -179, 23) yaw 32768, idle | master | 17.33 | 21.41 | 17.0 / 20.0 | 3.99 | 0.91 |
| | this branch | 14.10 | 18.10 | 14.0 / 17.0 | 1.93 | 0.51 |
| Vandenberg Tunnels, the alarm light's eight census views (#48 to #55), within a run of views #40 to #59 | master | 19.13 | 27.67 | 18.7 / 25.7 | 5.14 | 0.12 |
| | this branch | 14.76 | 19.75 | 14.7 / 19.3 | 1.40 | 0.07 |
| the same run, all twenty views (frames from 5 s) | master | 15.24 | 25.35 | 14.3 / 23.3 | 2.08 | 0.06 |
| | this branch | 14.18 | 21.42 | 13.3 / 20.3 | 0.74 | 0.04 |
| Dockyard, census views #140 to #144 ((3785, 6204, 20) and (2623, 6205, 20)), within views #132 to #149 | master | 27.52 | 43.49 | 26.3 / 42.3 | 2.88 | 0.11 |
| | this branch | 24.23 | 40.70 | 22.7 / 39.0 | 1.14 | 0.08 |
| the same run, all eighteen views (frames from 5 s) | master | 23.54 | 39.82 | 22.0 / 37.7 | 1.60 | 0.07 |
| | this branch | 21.53 | 35.52 | 20.3 / 33.3 | 0.74 | 0.06 |
| Dockyard (2623, 6205, 20) yaw 0, idle | master | 27.08 | 37.10 | 26.3 / 34.3 | 0.46 | 0.05 |
| | this branch | 27.95 | 38.19 | 27.3 / 36.0 | 0.48 | 0.04 |
| Battery Park (2025, -3396, 263) yaw 32768, idle | master | 19.42 | 22.39 | 19.3 / 22.0 | 2.01 | 0.49 |
| | this branch | 18.20 | 20.95 | 18.0 / 21.0 | 1.50 | 0.43 |
| Chromium (sim worker), Mole People, two pairs | master | 5.49 | 6.66 | 5.5 / 6.4 | 2.81 | 0.44 |
| | this branch | 4.45 | 5.35 | 4.4 / 5.1 | 1.97 | 0.23 |

Ship bar (0.3 ms off the page mean, or 0.5 ms off the slowest tenth): passed at the Mole People (3.2 and 3.3 ms off), the Vandenberg views (4.4 and 7.9), the
Dockyard views (3.3 and 2.8; those views are tick-led and noisy, `p.lightAnimation` 2.88 -> 1.14 is the figure to read), Battery Park (1.2 and 1.4) and in
Chromium (1.0 and 1.3). **Not passed, and not a regression: the Dockyard spot at rest**, where the phase is 0.46 ms in both trees (page means 27.08 and 27.95
are the sessions' tick, 14.4 to 15.0 ms, not the phase); the census' 3.5 ms there is the busy state of the hot views above. The page mean falls by more than
the two light phases together at the Mole People (3.2 ms against 2.5): the tick is 0.5 ms lower in the branch's sessions, which I attribute to less garbage
(the batch's arrays and the per-rectangle views are gone) and did not isolate.


**What is left.**
* A light that turns still has its spatial bytes made again every frame in JavaScript: the spot body (`spotLightSpatial`, x87 at 24 bits) is 0.3 to 0.5 ms
  in the views above, and `updateIncremental`'s own loops over the 1,700 light maps it dirties 0.36 ms. The spot and normal bodies and `movingLightRect` are the
  next Rust port (they have oracles: validate-dynamic-lighting, validate-normal-moving-lighting); a light that *moves* (the AugLight's beams, a drone) still pays the
  whole reach, 3 ms for 1,700 light maps.
* At the Mole People: the Rust call is 0.67 ms (83,000 texels a frame, 8 ns a texel in Gecko), the word copy into the page 0.31 ms, `copyBand` 0.11 ms. Moving the
  atlas pages into the kernel's memory would remove the copy (views over a growing memory need re-deriving, so it was not done); a persistent job list per light map
  would remove most of the per-rectangle JavaScript.
* Battery Park's `p.lightAnimation` is mostly the class 1 merge (`lighting.animate`) and its atlas writes, not moving lights (1.5 ms left of 2.0).
* The Dockyard spot (2623, 6205, 20) at rest costs 0.46 ms in both trees: the census' 3.5 ms there is the busy state, and only the census' own list reproduces it.
* The Mac and headed runs are not measured. Master's `outdated` recomposes a light map whose contributions are all dead each frame; here it is not
  (`record.movingFrame` is not refreshed for those, a validation field only).

### Dockyard spawns and js_eval (2026-11-07)

The task: at the Dockyard spot (2623, 6205, 20) yaw 32768 the Firefox inline page is about 31 ms a frame. The previous step left
`spawnActor` (1.22 ms a rest frame, "1.6 ms each in Firefox against 170 us in Node", the largest JavaScript item), `checkEncroachment`,
`processEvent`, `destroyActor` and AttachDecal's host side in `js_eval`'s flat 3.8 ms, and asked for the Firefox-only traps first (a tenfold
engine gap suggests a SpiderMonkey slow path), then exact ports where a measurement says they pay. Master 617bad22, headless Linux (Firefox 155
inline, Chromium not run, 1440x960, god mode, idle at the spot, 25 s sessions measured from 5 s after the map); the Mac is not measured.
Bar: 0.3 ms in the Firefox page mean or 0.5 ms in its slowest tenth.

**Reproduction.**
* Profile: `hitch-run.mjs --browser firefox --map 09_NYC_Dockyard --mode idle --god --seconds 25 --place '{"location":[2623,6205,20],"rotation":[0,32768,0]}'
  --out RUN --profile PROFILE` (give `--out` and `--profile` different names: the profile is written at shutdown to the path it is given and
  replaces a dump of the same name), read with `gecko-slow-ticks.mjs`, `gecko-phase.mjs --entry REGEX`, `gecko-under.mjs --anchor REGEX`.
  Wasm frames are `wasm-function[N]`: `CARGO_PROFILE_RELEASE_STRIP=none cargo build --release --target wasm32-unknown-unknown --target-dir
  .cache/wasm-names` gives a module with the same indices and a name section (551 is `destroy_scan`, 682 `render_scan`, 617 `level_distance`,
  537 `decal_attach`).
* Node, the same place: a one-spot places file, `PLACES=FILE PER=100000 FROM=0 TO=1 bench-sim --map 09_NYC_Dockyard --warm 100 --ticks 900
  --render-feedback --idle --seed 1 --scenario scripts/scenarios/places-replay.mjs` (digest `eba45015fec39e3f`, as before), with
  `--cpu-profile` for a V8 profile.
* Spawn timing by part: a temporary patch (not committed) of `ScriptRuntime.spawnActor` with exclusive-time accounting by part (a stack of
  timers: the construction, the zone, the collision view, each of the six events, AttachDecal's native; counters on `instance`,
  `readInstanceField`, `namedHandle` and `processEvent`), printed every 10 s through `console.error`, which `hitch-run` keeps in the dump's
  `errors`; the same in Node with `globalThis.__realNow` (bench-sim's `performance.now` is a virtual clock).
* Single constructs in Firefox and in Node from one source file: a loop with n doubled to 40 ms in `page.evaluate`.

**Why a spawn looked ten times dearer in Firefox: it is not; the two figures were not the same quantity.**
* "1.6 ms each in Firefox" is `spawnActor`'s inclusive time (1.22 ms a frame) divided by 0.77 spawns a tick. Counted in the page, a Firefox
  frame holds **3.15 spawns** (2.60 outermost) at the spot, 97 a second (blood drops, bloodsplats, shell casings, tracers and gas puffs of
  the fights going on there); inclusive time 1.38 ms a frame, **0.53 ms a spawn** (a 10 s window: 974 spawns, 802 outermost, 427 ms).
  A Node tick holds 1.9 spawns.
* "170 us in Node" is the fallback census' self time of the Spawn node, which leaves out the six events (their Rust bodies are other rows),
  AttachDecal and everything nested. Like for like, the V8 profile has `spawnActor` inclusive at 0.53 ms a tick (0.28 ms a spawn), and the
  timed run 0.42 to 0.47 ms a spawn (its 1,444 outermost spawns include the 130 of the map's start). Firefox 0.53 against Node 0.42 to 0.47:
  a ratio of 1.1 to 1.3, where the whole tick's ratio at the spot is 1.7 (15.3 ms against 8.4 to 9).
* The parts (exclusive, ms a spawn; Firefox over 10 s of the page, Node over its 1,000 ticks):

| Part | Firefox | Node |
|---|---:|---:|
| `construct` (name, image copy, `initProperties`, header bindings, registry) | 0.079 | 0.085 |
| `setActorZone` | 0.043 | 0.032 |
| the body of `spawnActor` and the collision hash | 0.039 | 0.034 |
| `installCollisionView` | 0.025 | 0.026 |
| `initExecution`, `setRegion`, `setOwner` | 0.013, 0.007, 0.002 | 0.005, 0.006, 0.002 |
| the six events (Rust bodies, their natives excluded) | 0.116 | 0.096 |
| AttachDecal's native (`decal_attach` in Rust), per call (555 calls in 974 spawns) | **0.341** | 0.101 |

  So no SpiderMonkey slow path is in the spawn's host code: the construction (`Object.defineProperties` of the collision view's 36 members,
  the `FinalizationRegistry`, the symbol link, object spreads) costs the same in both engines (single constructs: the collision view's shape
  6.5 us in Firefox, 7.0 in Node; `FinalizationRegistry.register` 0.35 to 0.5 us against 0.19; a spread of 40 members 0.45 us against 4.3). What
  is Firefox-only in a spawn is the Rust attach of a decal (bloodsplats, bullet holes): 3.4 times slower in Firefox's wasm, at a constant
  rate over the session (16.5 ms a second of the first 6 s, 15.7 of all 25: not a tier-up lag). It calls `decal::fast::edge` (the x87 model's
  `make` on a table miss) and `gather_nodes`; why Firefox's wasm is slower on them I did not find, and did not change them.

**What is Firefox-only, and the ranking.** Rest = the 728 frames outside the slowest tenth by `p.tick` (81 frames) of one profile of master
(p.tick 15.3 / 25.3 sampled; 809 drawn frames from 5 s). Self times against the same function's self time in the V8 profile ("ratio"):

| Item (ms a frame in Firefox) | rest | slow | all | ratio to V8 | verdict |
|---|---:|---:|---:|---:|---|
| the switch readers: 17 functions, `farMoveMode` 0.19, `renderScanMode` 0.09, `laserMode` 0.04, `cleanupScanMode` 0.04 (**0.40 in the slowest tenth**), `particleItemsMode`, `levelScanMode`, `tickReadsMode`, `meshLightMode` 0.03 each, ... | | | 0.57 | 6 | Firefox trap |
| `surfacePan` self: the zone-name map rebuilt from 2,000 actors | | | 0.37 | (viewer) | invalidation |
| `levelMembership` self: the mesh lighting's name map and set | | | 0.24 | (viewer) | invalidation |
| `spawnActor`, inclusive | 1.19 | 2.69 | 1.34 | 1.1 a spawn | not Firefox-specific; the host is 0.21 ms a spawn, 0.67 a frame |
| `destroyActor` | 0.50 | 1.31 | 0.58 | 2.6 | `destroy_scan` (Rust) 0.29 of it: `Obj::has` looped 51 positions a slot |
| `checkEncroachment` (the hash query's JavaScript, per candidate) | 0.60 | 0.80 | 0.62 | 1.7 | flat |
| `execAttachDecal` | 0.48 | 0.59 | 0.49 | 1.4 (JS), 3.4 (Rust attach) | 0.34 is the Rust attach |
| `processEvent`, all (the scripts' own work included) | | | 3.5 | 2.9 | content |
| `instance()` self (10,700 calls a frame) | 0.31 | 0.74 | 0.76 | 3.1 | 70 ns a call in the page against 12 to 15 ns in a loop |
| `sameDefaults` (a walk over the class's defaults at each construction) | 0.054 | 0.06 | 0.05 | 5.5 | exact cut |
| `cleanupDestroyed` (the passes) | 0.17 | 2.07 | | | `cleanupScanMode` called twice for each of 17,000 actors |
| `render_scan` / `destroy_scan` / `level_distance` in Rust | | | 0.45 / 0.29 / 0.23 | | `Obj::has` |

**What changed** (each behind a switch with the old body as the reference; defaults first, `js` the old body, `verify` both):
1. **Switch readers** (`switch-reader.mjs`, `?switchCache=js|verify`, `SWITCH_CACHE`). The 36 readers `() => (typeof process !== 'undefined' &&
   process.env?.X) || globalThis.DEUS_EX_X || 'rust'` were called on hot paths (`farMoveMode` up to three times a far move,
   `cleanupScanMode` twice for each of 17,000 actors in a pass, `epochScopeMode` for each binding of a spawned actor). In Firefox `typeof process`
   of an undeclared global costs 150 ns and a missing property of the global 200 ns, 400 ns for the pair (V8: 8 and 4 ns; 165 ns in Node
   for the whole, with `process.env`). A browser realm's switches are set once, before the runtime loads (main.mjs for the page,
   sim-worker.mjs for the simulation worker): it now reads each at its first call and keeps it. Node keeps the full read at every call
   (validators set the environment between runs of one process); `SWITCH_CACHE=on` makes Node cache too and `=verify` checks every call
   (`test/switch-reader.test.mjs`).
2. **The name maps kept across spawns and destroys** (`actor-names.mjs`, `?actorNames=js|verify`). `surfacePan` (the texture pans' zone
   names) rebuilt a map from all of Level.Actors, reading 2,000 actors' names, whenever the actors epoch advanced; `levelMembership`
   (the mesh lighting) did so for every destroy. A first form compared the slots by index and followed appends and nulled entries: it
   changed nothing at the Dockyard (the profile put the cost in `rebuild`), because **84 percent of the epoch's advances are
   compactions** (596 advances in 1,000 ticks: 93 appends, 244 shorter arrays, 257 shifted slots, none a bare null), and a compaction
   shifts every slot. The map depends only on the sequence of the non-null entries, which a compaction keeps: `update` walks the array
   against the sequence it saw last, finds what left it and what joined it at the end, and applies both (a name's holder that shares it
   with another, a reordering, an entry seen again: a rebuild, as before). Over 1,000 real ticks at the spot: 1 rebuild (the first), 595
   updates (1,766 appended, 975 removed), at `verify` (compared with a fresh build at each) without a difference. `js` is each user's old
   code (a rebuild at every advance for `surfacePan`; the append-only rule for the mesh lighting).
3. **`Obj::has` walks the set bits** (render.rs, loco.rs; `?hasScan=js|verify`, exported as `vm_has_mode`). Every actor is BOUND
   (its header fields are bound), so each slot of every scan asked the binding set about its field mask by a loop over all 51 positions
   (22 in loco.rs); a question has two to seven bits. `js` is the position loop; `verify` runs both and traps on a difference.
4. **The class image's currency by version** (`defaults-map.mjs`, `?imageCheck=js|verify`). A class's `defaults` is a `DefaultsMap`
   counting its `set`, `delete` and `clear`; `classImage` took the image as current by walking every default of the class (hundreds for
   an Actor class) at each construction. An image made at the version the class has now is current without the walk; after a change the
   walk decides as before and the version is taken again. A class whose defaults are a plain Map (fixtures) keeps the walk.

**Profile after** (one Gecko profile of the code before the roster rewrite, so the maps' cost is still in `rebuild`; mean of 709 frames,
p.tick 18.4 sampled with the profiler on): all the switch readers 0.57 -> 0; `surfacePan` 0.37 -> 0 (its cost moved into `rebuild`,
0.34, which the rewrite then removed); `sameDefaults` 0.05 -> 0; `render_scan` 0.45 -> 0.35, `level_distance` 0.23 -> 0.11,
`destroy_scan` 0.29 -> 0.24.

**A/B.** Firefox inline, headless, `hitch-ab.mjs --guard --cpus 4-7,12-15` (sessions pinned, the arms' order alternating from pair to
pair), the new arm the defaults, the old arm `switchCache=js&actorNames=js&hasScan=js&imageCheck=js` of the same tree (the old arm's
readers pay `typeof process` as before the change; `js` of the maps is each user's old rule), 25 s sessions from 5 s after the map; ms.
Pair differences new - old, with the standard error of their mean and the pairs better.

| Dockyard | new | old | new - old | se | pairs better |
|---|---:|---:|---:|---:|---:|
| **Final code, 8 pairs** page `animate` mean | 29.93 | 31.27 | **-1.33** | 1.12 | 6 of 8 |
| page slowest tenth | 40.81 | 42.71 | **-1.89** | 1.74 | 4 of 8 |
| tick `p.tick` mean | 15.03 | 15.98 | -0.95 | 0.57 | 6 of 8 |
| tick slowest tenth | 23.33 | 24.81 | -1.48 | 0.88 | 6 of 8 |
| `p.render` (not touched: the control) | 3.28 | 3.13 | +0.15 | 0.17 | |
| **Before the roster rewrite (readers, `has`, image check), 12 pairs** page mean | 29.06 | 30.90 | **-1.84** | 0.65 | 10 of 12 |
| page slowest tenth | 39.19 | 42.22 | **-3.03** | 1.13 | 9 of 12 |
| tick mean | 14.64 | 15.83 | -1.19 | 0.34 | 10 of 12 |
| tick slowest tenth | 22.46 | 24.73 | -2.26 | 0.79 | 9 of 12 |
| `p.render` (control) | 3.02 | 3.06 | -0.04 | 0.09 | |
| Both sets, 20 pairs: page mean / its slowest tenth / tick | | | -1.64 / -2.58 / -1.09 | 0.58 / 0.95 / 0.29 | 16 / 13 / 16 of 20 |

The pairs of the final set, page mean new - old: -0.3 -5.0 -3.6 -0.2 -4.6 +1.3 +4.2 -2.5 (the sessions' spread is +-1.5 ms, as the previous
step found; the slowest tenth of the page is the noisier figure); the 12 of the earlier set: +1.9 +0.5 -3.9 -1.4 0.0 -1.3 -2.7 -3.6 -1.9
-0.2 -6.3 -3.3. The control, which nothing here touches, moves by +-0.15. The profile-based expectation (readers 0.57, maps 0.6 less what
a rebuild still costs, `has` 0.3, image 0.05) is about 1.2 to 1.5 ms, which the three sets bracket; the sets differ in a code change
(the roster) that the final one has and the earlier one lacked, and their results do not separate it.

| Firefox inline, Metro places run (spots 0 to 60, 4 pairs) | new | old | new - old | se |
|---|---:|---:|---:|---:|
| tick mean | 6.65 | 6.74 | -0.09 | 0.24 |
| tick slowest tenth | 12.17 | 11.90 | +0.27 | 0.72 |
| page mean / slowest tenth | 14.06 / 22.67 | 14.20 / 22.36 | -0.14 / +0.31 | 0.43 / 1.07 |

No effect at the Metro (as the previous step's: its places run is mostly quiet spots). **Node**, one pair at the placed spot (900 ticks
after 100 warm; the pair was meant to be five and the others were not run): tick mean 8.37 new, 8.47 old (a second old run 8.73), slowest
tenth 13.59 against 14.24 (14.60); the digests all `eba45015fec39e3f`. Not an A/B.

**Result: meets the bar at the Dockyard** (page mean -1.3 to -1.8 ms against 0.3, its slowest tenth -1.9 to -3.0 against 0.5; the control
unmoved); shipped on this branch. The Metro run does not move. The page mean at the spot stays near 29 ms: this is a 4 to 6 percent step.

**Checks.**
* `bench-sim --map NAME --warm 60 --ticks 300 --render-feedback`: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield
  `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`: unchanged, by default and
  with `SWITCH_CACHE=verify HAS_SCAN=verify IMAGE_CHECK=verify ACTOR_NAMES=verify` (Node cached with every read checked; the Rust scans at
  `verify`, which traps on a difference). Combat replays (`PER=77`): Metro 54 replayed `09e2d44972cca30a`, freshly placed
  `a6011ede7236c1d2`; Vandenberg 98 replayed `ed184bd3eb533bc1`, freshly placed `1db79eb398240a97`: unchanged (the two replays also with
  the verify set). The 900-tick placed Dockyard run `eba45015fec39e3f` by default and with the verify set. The six-map and
  combat runs were made on a frozen copy of the tree before two later edits (the `js` reference of the readers made whole, the
  `reference` option of the maps); the verify set on the Dockyard and the Island, the default Dockyard and the placed run were made again
  on a copy that has them, with the same digests. The sequence-based roster is the viewer's and no digest reaches it: its evidence is the
  unit test, the 1,000-tick check against a fresh build above, and the Firefox runs at `verify` below.
* Validators (`run-validators.mjs --jobs 1 --filter`, `NATIVE_PROBE_PYTHON` set): spawn 7, destroy 4, cleanup 4, loadmap 2, decal 6 and
  `validate-decal-fast` (0 mismatches in 12 million cases; it builds the selftest module from `native/`, which the snapshot lacked, so it
  ran in the full tree), encroach 3: all passed. `npm test`: 977 tests, 973 passed, 4 skipped, 0 failed (11 new: `actor-names`, a random walk of spawns,
  destroys, compactions in place, duplicate names and array swaps against a fresh build, 30 seeds each for the two kinds of map, and the
  compaction, reordering and reference cases; `switch-reader`, the Node, browser, `js`, `verify` and `on` behaviors in child processes);
  the Rust build is warning-free.
* Firefox inline with every new switch at `verify` (`hitch-run.mjs --query 'switchCache=verify&actorNames=verify&hasScan=verify&imageCheck=verify'`):
  the Dockyard 1,204 drawn frames and the Metro places run 4,859, final code, no page error; the earlier tree 1,282 and 4,896.

**Tried and not shipped, and what is left.**
* **A Rust owner for the spawned instance** (the previous step's next cut): not started. The host's own work is 0.21 ms a spawn, 0.67 ms a
  frame at 3.15 spawns (2 percent of the page), the same in V8 per spawn; a port has to take the construction, the bindings, the zone, the
  collision view and the six events together (they share the instance's bindings and the epochs), and would at best remove half of it. The
  measurement does not show it clearing the bar by a margin that pays for the risk.
* **AttachDecal's Rust attach** is 3.4 times slower in Firefox's wasm than in V8 (0.34 against 0.10 ms a call, 1.8 calls a frame, 0.6 ms a
  frame): the one place where a spawn is Firefox-specific. Cause not found; a tier-up lag is excluded (flat rate).
* `destroy_scan` is still one pass over every slot for each destroy (Owner and the four Touching words, a cache miss per actor); only the
  per-slot `has` got cheaper. The Base children scan of `destroyScriptActor` (when `StandingCount` is not zero) is a JavaScript loop of
  `readNamed` over every actor, 0.21 ms in the slowest tenth only.
* `invokeNative` is one function of 1,000 lines with 137 `if` statements in a row (Spawn, SetRotation, Destroy are 85 to 130 deep): its
  self time is 0.27 ms a frame in Firefox against 0.08 in V8. A dispatch on the index needs a proof that no earlier branch matches; not done.
* `instance()` (0.76 ms self, 10,700 calls a frame), `handleOf` (0.35: a `Map` keyed by object; on 20,000 cold objects `Map.get` is 25 ns
  and `WeakMap.get` 12.5 ns in Firefox, 52 and 56 in Node), `readInstanceField`, `namedHandle`: the JavaScript host's per-access cost.
  Fewer accesses, not faster ones, is the cut: each hot reader (sprite scan, laser state, galaxy audio's object index, `physMovingBrush`)
  is its own step.
* The rider table's `fillSlot` (0.33 ms in the slowest tenth, `riderBaseInstance` for each slot after every base-epoch change) and
  `checkEncroachment`'s per-candidate reads stay as the previous step left them.

### Battery Park at rest (2026-11-07)

The task: Battery Park (`02_NYC_BatteryPark`) at rest in Firefox inline, 60 fps. Result, all headless Linux (Ryzen 9 8945HS, Node 26, Firefox
inline 1440x960, god mode, master 2534cbfb; the Mac and headed runs are not measured): **one family reached the ship bar and is merged: the
world root no longer takes part in the renderer's per-render matrix walk (`p.render` 3.40 -> 2.83 ms at the rest spot, 8 pairs of 8 lower;
page mean 18.13 -> 17.72 ms there).** Three more families (class 1 light animation, the light atlas' rectangles, the fog tiles' rectangles) were built
and are exact, but are 0.13 ms or less each and are on the branch `batterypark-unshipped` (commit 1df307a3), described below with their A/B.
**Battery Park at rest is still over 16.7 ms at its heavy spot (page p95 20 ms)**: its profile is flat and nothing left reaches 0.5 ms alone. The
four-heading frame-time route is under 16.7 ms at p95 already, and the map start is 0.8 ms over (p95 17.5 before, 16.75 with the bundle below).

**Reproduction.**
* `node scripts/frame-time-set.mjs --browser firefox --maps 02_NYC_BatteryPark` on the quiet machine: 3,665 drawn frames, page mean 12.81 ms, p50 13, p95 16
  (the slowest tenth 16.80). The route passes 16.7 ms at p95 today; the "p95 about 19" of the earlier sets was taken before the actors, HUD,
  moving-light and light-pack merges, and with other sessions on the machine.
* The two idle places that are over: the map start (`hitch-run.mjs --browser firefox --map 02_NYC_BatteryPark --mode idle --god --seconds 25
  --profile FILE`: page mean 14.5 ms and p95 17.5 unprofiled in the A/B, 15.6 and 19 with the Gecko profiler on) and the rest spot of the earlier notes, (2025, -3396, 263) yaw 32768
  (`--place '{"location":[2025,-3396,263],"rotation":[0,32768,0]}'`: mean 19.1 ms profiled, 18.1 unprofiled in the A/B, p95 20 to 22). The spot is 3
  to 4 ms dearer than the start: HUD 1.9 against 0.9 ms (cause not found), fog 1.7 against 1.0, `p.lightAnimation` 1.5 against 0.8, and two
  PHYS_Rolling TrashPapers near the player (below).
* Node could not run this map's census as it stood (every tick stops at "UViewport SizeX/SizeY are unknown before the first frame");
  `scripts/scenarios/idle-spot.mjs` gives the viewport its size, stands the god-mode player at the spot and can list the actors by Physics.

**Ranking (Gecko profile of the idle session at the spot, ms a frame; in brackets the slowest tenth minus the rest, from the hitch log's phases).**

| Family | Spot | Map start | What is in it |
|---|---:|---:|---|
| Level tick (`p.tick`) | 6.2 (+1.4) | 5.8 (+2.0) | Rust batch 2.9 inclusive; the hand-backs: `js_eval` 0.84 (spread over natives), `js_tick_physics` 0.48 (+0.18; 0.27 of it two TrashPapers in `physRolling`, whose cost is `playerMove`), the AI event manager 0.44 (+0.32; perception's `lineCheck` 0.06 -> 0.20), walking prelude 0.29 (+0.14), minor GC +0.16 |
| three.js passes (`p.render`) | 3.4 (+0.4) | 3.0 (+0.6) | main pass 1.58, the sky pass 1.29, the HUD overlay 0.51; `updateMatrixWorld` 0.49 of the first two, `setProgram` 0.19, `projectObject` 0.14; 190 draw calls |
| Actors layer (`p.actors`) | 2.2 (+0.3) | 2.0 (+0.3) | `occludeMain` 0.94 (Rust), `updateBindings` 0.54 |
| HUD (`p.hud`) | 1.9 (+0.4) | 0.9 (+0.3) | script windows' draw 1.0 (Rust `drawTree`, `js_eval` 0.2 under it), tick 0.5, the overlay's 144 `bufferSubData` calls (48 tile batches x 3 attributes) |
| Fog (`p.fog`) | 1.7 (+0.1) | 1.0 (+0.2) | `levelMaps` 0.89 (the Rust loop 0.38), 90 tile uploads 0.3 |
| Class 1 light animation + atlas (`p.lightAnimation`, `p.lightUpload`) | 1.5 + 0.4 (0) | 0.8 + 0.2 | `lighting.animate` 0.46 (the modulation tables 0.15, `inView` 0.10), the atlas writes 0.40, `syncMovingLights` 0.42, the atlas flush 0.40 (35 light maps change a frame) |
| Audio, textures | 0.4 + 0.4 | 0.5 + 0.4 | lip sync 0.13, ambient scan 0.13; fire and water ticks 0.26 |

By source file the page frame's self time at the spot is three.js 2.35 ms, `script-runtime.mjs` (the object model behind the Rust VM's imports) 1.62,
`fog-pass.mjs` 0.73, `script-vm.mjs` 0.61, the `texSubImage2D`/`3D` natives 0.52 + 0.25, `light-atlas.mjs` 0.50, with a tail of rows under 0.35. The slowest
tenth is the tick (about 40% of its extra), then the render and the HUD; collections are 0.16 ms of it. The GL uploads of a frame at the spot (one
run with a wrapper on the upload calls): 340 calls and 1.0 MB: 144 `bufferSubData` of the HUD's tile batches (555 bytes each), 90 fog tiles
(328 KB), 70 atlas rectangles (239 KB), 23 three.js texture updates (the fire and water textures, 352 KB), 17 world index buffers.

**Shipped: the world root's matrix walk** (`world.mjs`; `?sceneWalk=full` keeps the old behavior, `?sceneWalk=verify` checks it).
`renderer.render` calls `scene.updateMatrixWorld()` for each pass (the sky frame, then the main frame). main.mjs already keeps the scene and the
world root at identity without auto-update, and the actor layer's root already skips the walk; the world root still walks its 2,721 objects
twice a frame to find nothing to do. A hot walk of the whole scene takes 63 us in an isolated loop, but `updateMatrixWorld` took 0.17 + 0.34 ms
inside the frame (cold caches): the largest single self time in the page frame, 0.49 to 0.52 ms at both places. Nothing under the world root is
ever flagged for an update: its meshes are world-space with identity local matrices and `matrixAutoUpdate` false, a mover's group and meshes are
updated at once (`syncMovers`, the load), and the fog, markers and batching add no auto-updating object. So the root's `updateMatrixWorld` now returns at
once unless it is forced; a forced cascade still walks everything.
* *Exactness* (host drawing only, no original behavior is involved): `validate-scene-matrices` snapshots every object's `matrixWorld` after the
  renderer's update and compares it with a forced full cascade, bit for bit, on every update: it passes on the Island, Smug (movers moved and
  rotated, a mirror on a mover), Training and, added, Battery Park (915 updates, 1,660 objects each). `?sceneWalk=verify` does the same in the page,
  after every skipped walk (the walk is skipped, a forced cascade runs beside it and each object's `matrixWorld` is compared as bits): Firefox inline sessions of
  40 s at the rest spot (3,914 walks, 10.6 million objects), roaming Battery Park (4,334 walks, 11.8 million) and roaming the Island (4,964 walks, 0.66 million) found
  0 objects differing and no page error.
* *A mover shortcut* (`world-visibility.mjs`): `select` made a `Set` and looped a mover's faces for each of the 65 movers in each of its two calls a
  frame (130 empty sets a frame at Battery Park) when no polygon of the mover was drawn; it skips that, with the same result (count 0).
  `stats` also counts selects, index rebuilds and uploads: the main and the sky pass each rebuild all the world meshes' index buffers every
  frame (2 rebuilds and 18 index uploads a frame at rest), because their node sets alternate.

**A/B, Firefox inline, interleaved, the final tree, `?sceneWalk=full` (the old walk) against the default** (sessions of 25 s idle, the frames from 5 s after
the map, four pairs to a hold of the heavy lock and an 8 GB scope, pinned to CPUs 8-11, `hitch-ab.mjs` with the guard moved around the holds so that a pair's
sessions run back to back; `.work/bp/agg.mjs`; the slowest tenth is the mean of the slowest 10% of frames; "lower" counts the pairs where the default was lower):

| Case | pairs | arm | page mean | slowest tenth | p50 / p95 | `p.render` | pairs lower (page / render) |
|---|---:|---|---:|---:|---|---:|---|
| Battery Park (2025, -3396, 263) yaw 32768, idle | 8 | `sceneWalk=full` | 18.13 | 20.94 | 18.25 / 20.5 | 3.40 | |
| | | default | 17.72 | 20.98 | 17.63 / 20.0 | 2.83 | 6 of 8 / 8 of 8 |
| the same, the view turning 45 degrees a second (`--spin 45`) | 3 | `sceneWalk=full` | 14.41 | 19.53 | 14.0 / 19.0 | 2.24 | |
| | | default | 13.90 | 18.99 | 13.0 / 19.0 | 1.74 | 3 of 3 / 3 of 3 |
| 01_NYC_UNATCOIsland, map start, idle (control) | 8 | `sceneWalk=full` | 16.64 | 19.71 | 16.9 / 19.4 | 2.25 | |
| | | default | 16.58 | 19.52 | 16.6 / 19.4 | 2.22 | 4 of 8 / 4 of 8 |
| 03_NYC_Airfield, map start, idle | 4 | `sceneWalk=full` | 13.60 | 17.17 | 13.3 / 16.3 | 1.14 | |
| | | default | 13.60 | 17.22 | 13.5 / 16.8 | 1.12 | 2 of 4 / 2 of 4 |

Ship bar (page mean -0.3 ms or slowest tenth -0.5 ms, the Island not worse): passed at the spot on the mean (-0.41 ms, median of the pairs -0.34;
`p.render` -0.56 ms in every pair) and with the view turning (-0.51 mean and -0.53 tenth, 3 of 3); the Island and the Airfield do not move (their worlds have few
meshes to walk: `p.render` -0.03 and -0.02). The slowest tenth at the spot is not shorter (+0.04, median of the pairs -0.31): the sessions' spread is
about 0.7 ms in either direction, so the mean carries the result.

**Built, exact and not shipped** (the bundle, 9 pairs at the spot, 4 at the map start and 3 turning, `sceneWalk=full&lightModulation=table&lightPack=js&uploadBands=off`
against the defaults; commit 1df307a3 on `batterypark-unshipped`, with their own notes in `docs/static-lighting.md` and `docs/volumetric-fog.md`
there). The bundle as a whole read: spot page mean 18.13 -> 17.44 (-0.63, 9 of 9 pairs lower), slowest tenth 20.96 -> 20.27 (-0.61), map start 14.51 -> 13.68
(-0.83, 4 of 4), 15.62 -> 14.11 turning (-1.51, 3 of 3); the Island +0.10 (noise). By phase, which tells the families apart:

| Family | what it does | phase, spot | phase, map start | phase, turning |
|---|---|---|---|---|
| the world root's matrix walk (shipped) | above | `p.render` -0.49 (9 of 9) | -0.60 (4 of 4) | -1.01 (3 of 3) |
| class 1 light animation | the modulation tables of the three noise effects made when a merge reads an entry (they were rebuilt whole, 3 x 65,536 entries, on every frame's first merge: 0.15 ms); the changed region's atlas words made by `light_pack` in Rust (simd128) and copied into the page a row at a time, in place of the clamped three-byte-load loop of `LightAtlas.update` (2.46 ns a texel; 35 light maps change a frame) | `p.lightAnimation` -0.13 (9 of 9) | -0.12 (4 of 4) | -0.22 (3 of 3) |
| the light atlas' rectangles | the flush sends rectangles that lie side by side on a page's shelf as one (`upload-bands.mjs`: 78 rectangles in 8 calls a frame at the spot), the bytes between them being the page's own | `p.lightUpload` -0.08 (9 of 9) | -0.03 | -0.07 |
| the fog tiles' rectangles | the same for the 90 tiles a frame | `p.fog` +0.08 (0 of 9: worse) | +0.01 | -0.16 |

The two light families are under the bar (0.13 and 0.08 ms; 0.21 together) and the fog bands lose. Upload calls fell by 150 a frame (345 -> 207) while `gl.upload` stayed
at 1.0 ms: in Firefox the bytes cost what the calls cost, so a band that sends the gap between two tiles pays as much as it saves, and the fog's sparse tiles pay
more (`rectangle()` copies a wider view, `p.fog` 1.64 -> 1.72). Exactness of the bundle: `validate-light-animation-rust` (7,200 map frames of 12 maps, 2.2 million
merges, 10,265 modulation tables compared with the reference's, four script brightness changes a map) passes with the entries made on demand; the
`moving-lights-bench.mjs` hashes (floats and atlas pages after 240 frames) are equal in `LIGHT_MODULATION=table|lazy` and `LIGHT_PACK=js|rust|verify` at the Battery Park spot,
and equal to the Mole People, Vandenberg and Island figures of "Moving lights" (master's); 22,719 regions (5.7 M texels) of the Node run and 32,410 (3.9 M) of a Firefox
inline `?lightPack=verify` session were compared word for word with `LightAtlas.update`'s, 0 differing; `validate-light-atlas-upload` (GPU array layers equal the CPU
pages after 240 flushes with the bands on) passes in Chromium and Firefox at the Mole People (39,821 dirty rectangles in 10,932 calls), Battery Park (18,682 in 2,017) and
Training; the four fog pages of a Firefox inline session read back equal (`deusExViewer.fogPages()`); `validate-volumetric-fog-play` passes.

**Checks of the merged change** (the final tree, under the heavy lock): the six sim digests (`bench-sim.mjs --warm 60 --ticks 300 --render-feedback`) unchanged:
Island 5adb254a07b1ed6f, 00_Training 07816ec472f29b84, 03_NYC_Airfield 46ed0d32ae5b56af, 06_HongKong_WanChai_Market 80d27b37e0944d88, 15_Area51_Bunker
764a7bdffd2ebe59, 09_NYC_Dockyard e53f348673f1247b (the change is in the page's world, not in the simulation, and no Rust changed; the bundle's run held them too);
`validate-scene-matrices` (Island, Smug, Training, Battery Park: every `matrixWorld` equals the forced cascade on every update), `validate-page-movers-play` and
`validate-mover-vertices-play` pass; the three Firefox `?sceneWalk=verify` sessions above; `npm run build:wasm` is warning-free; `npm test`: 969 tests, 965 pass, 4 skipped,
0 fail.

**What is open.**
* **The slowest tenth** is the tick: +1.4 ms at the spot, +2.0 at the map start, spread over the Rust batch's hand-backs, the event manager (perception's
  line checks come back to JavaScript, `lineCheck` 0.06 -> 0.20) and the walking prelude; no family is above 0.35 ms.
* **TrashPaper's PHYS_Rolling** (`rolling.mjs`, Engine.dll 0x103d4b80, Unicorn oracle `validate-native-rolling`): two papers rolling near the player cost 0.27 ms a frame
  at the spot (0.01 at the map start), 0.21 of it `playerMove`, the generic JavaScript MoveActor. `fall.rs` runs falling and projectiles on `move_source`; a rolling body
  there is the next port of this kind, and the street maps have papers. Not started.
* **The HUD overlay** uploads 144 tiny buffers a frame (48 draw batches x position, uv and tint): one interleaved buffer for the frame's tiles would be one call
  (about 0.15 ms of `projectObject` + `bufferSubData` at the spot). The batches keep the window order, so the draw order would not change. Not started.
* **The BSP selector** rebuilds every world mesh's index buffer for the sky pass and again for the main pass, each frame (2 rebuilds, 18 uploads at rest): one
  index buffer with a region per pass (`drawRange.start`) would keep both; a second index object per mesh would make three.js set up each vertex-array
  object twice a frame, so it is the region, not the object. About 0.1 to 0.2 ms; moving, the sky's region stays. Not started.
* **Bytes, not calls, are the upload cost in Firefox** (above): the fire and water textures (23 updates, 352 KB a frame, RGBA) are the largest source; an 8-bit index
  texture with the palette on the GPU would send a quarter of it, but changes the shader of every animated texture.
* The Mac and headed runs are not measured.

### Firefox wasm gap (2026-11-07)

The task: the previous step measured the Rust decal attach (`decal_attach`) at 0.34 ms a call in Firefox against 0.10 ms in Node, flat over the
session, and asked whether SpiderMonkey runs our module slower in general (tiering, codegen constructs, build profile), which would slow every
Rust path in Firefox. **Answer: no general slowdown exists. Replaying the same recorded calls against the same `.wasm`, Firefox runs 0.9 to 1.3
times V8's time on every export measured except one, and that one was a `memcmp` call in the decal edge table, now compared in line (0.51 times
its old time in Firefox, 0.69 in V8, and the A/B below).** The 3.4 times of the previous step compared a Firefox page with a Node process; V8 inside
a page is as far from Node as Firefox is (below). Master dbc3c047 (the Dockyard spawns step merged), headless Linux (Ryzen 9 8945HS, Firefox 155,
Chromium 153, Node 26), the Mac is not measured.

**Tools** (all measurement only; the snapshots are in `.work/`, outside Git):
* `scripts/wasm-gap-hook.mjs` (`node --import`): wraps every instance's exports in a real Node run. `GAP_STATS=FILE` writes calls and inclusive ms of
  each export with the ordinals of the calls at the 50th, 75th, 90th and 99th percentile of their duration; `GAP_SNAP=DIR GAP_SNAPS=name:n,...`
  keeps, at the n-th call of an export, the whole linear memory before it, the arguments, the shadow stack pointer, the imports the call made (name,
  arguments, result) and the memory's hash after it; `GAP_SMAPS=FILE` the big anonymous mappings' size, resident set and transparent huge pages.
* `scripts/wasm-gap-replay.mjs` (+ `wasm-gap-core.mjs`): loads a snapshot into a fresh memory after instantiating the module (its data segments
  rewrite the statics at instantiation), checks that one replayed call gives the recorded result and memory hash, finds the pages the call changes
  and restores only them before each timed call, then times the call for some seconds, in Node, Firefox or Chromium (a static server, `page.evaluate`)
  against any `.wasm` (`--wasm`), with Firefox preferences (`--prefs`), a cache-cold mode (`--cold MIB` reads that much other memory before each
  call) and a Gecko profile (`--profile`). Firefox's clock steps by 20 us even with `privacy.reduceTimerPrecision` off, so a call shorter than
  that is timed in batches (the difference of K calls with their restores and K restores).
* `scripts/wasm-gap-page.js` with `hitch-run.mjs --init-script FILE --ff-prefs JSON --eval 'window.__gapStats()'` (both new): the same inclusive
  per-export timer in a live page, counted from 6 s after the HUD shows 100 health.
* The cases: the Dockyard spot (2623, 6205, 20) yaw 32768 in `bench-sim` (`PLACES=one-spot file PER=100000 ... --scenario places-replay.mjs`, digest
  `eba45015fec39e3f`, unchanged by the hook), 12 calls at the 50th to 90th percentile of their durations, and 3 `fog_map` calls of a
  `fog-capture-play.mjs` capture of 02_NYC_Underground (2,616 distinct calls) replayed through `fog-replay.mjs`.

**Identical inputs, each export replayed in a loop** (mean us per call; `replay exact` = the call gave the recorded memory hash; ratio = Firefox over
Node):

| Case (HEAD module) | Node (V8) | Chromium (V8) | Firefox | Firefox / V8 |
|---|---:|---:|---:|---:|
| `decal_attach` (1,633 edge-table hits, 8 misses) | 61.1 | 61.1 | 86.6 | **1.42** |
| `decal_attach` (another decal) | 58.6 | 58.2 | 83.6 | **1.43** |
| `area_scan` | 12.9 | 12.4 | 15.5 | 1.20 |
| `destroy_scan` (two calls) | 9.9, 16.8 | 9.5, 16.6 | 9.6, 17.1 | 0.97, 1.02 |
| `lc_scan` / `lc_line` | 12.5 / 0.64 | 12.8 / - | 13.4 / 0.62 | 1.08 / 0.97 |
| `level_distance` / `level_settled` / `level_desc_carry` | 40.9 / 11.4 / 6.8 | 40.0 / 11.5 / 7.0 | 39.1 / 12.1 / 6.2 | 0.96 / 1.07 / 0.91 |
| `nav_scout` | 19.2 | 19.1 | 18.5 | 0.96 |
| `ai_tick`, with the 253 and 265 imports of its recorded call stubbed (their results and memory writes replayed) | 184.3, 215.5 | 185.5, 227.8 | 200.8, 233.7 | 1.09, 1.08 |
| `move_pawn` (8 imports) | 10.8 | 14.8 | 13.7 | 1.27 |
| `fog_map`, the simd128 block loop (three calls of 8, 63, 73 us) | 7.4, 62.5, 73.4 | 7.3, 61.4, 72.5 | 8.5, 71.1, 83.5 | 1.15, 1.14, 1.14 |

On master 2534cbfb, before `Obj::has` walked the set bits (the previous step's change), `destroy_scan` was 27.6 (Node) against 49.1 us (Firefox) and
`area_scan` 22.9 against 36.9: the 51-position loop was the other Firefox-specific cost, and it is gone. The interpreter's `vm_run` calls recorded here are
nanoseconds (a script that returns at once) and `vm_statement` calls an import that runs the module again (the hook marks such a case `nested` and
the replayer skips it), so **the interpreter's own match functions are not covered by a replay: open** (below).

**The same exports live** (Dockyard spot, 25 s, us per call, inclusive; the call mixes differ a little between runs):

| Export | Node `bench-sim` | Chromium inline page | Firefox inline page (two runs) | Firefox / Chromium |
|---|---:|---:|---:|---:|
| `decal_attach` | 82 | 133 | 169, 183 | 1.32 |
| `destroy_scan` | 62 | 55 | 71, 76 | 1.33 |
| `level_distance` | 109 | 268 | 318, 274 | 1.10 |
| `area_scan` | 12.8 | 15.8 | 19.7, 19.2 | 1.23 |
| `lc_scan` / `lc_line` | 12.4 / 1.7 | 16.2 / 3.0 | 17.9, 16.3 / 3.9, 3.5 | 1.06 / 1.21 |
| `render_scan` | - | 8.3 | 10.4, 9.7 | 1.21 |

Both browsers' pages run these exports 1.2 to 2.5 times slower than Node does, `level_distance` most (109 us in Node, 268 in Chromium, 274 to
318 in Firefox, while a replayed loop takes 41 in all three): the surroundings of the call in a page (the software GL threads of this host share
the cores and the caches, the rest of the frame evicts the actors the scan walks), not the engine, which is why comparing a Firefox page with a Node
process measured an engine gap that Chromium shows too. The Firefox pages ran at 1.0 to 1.4 times Chromium's on the wasm-only exports. The wasm
function bodies are about a tenth of the main thread in a Firefox profile of the spot (6.5 s of 58.7 s sampled, with the collector's lines in it): a
uniform 1.4 times on all of them would be 1.5 ms of a 30 ms frame, and nothing like it exists.

**Function by function in situ** (the Dockyard spot, one name-section build of HEAD; V8: the simulation worker's profile in Chromium, 2,634 frames;
Gecko: the Firefox page, 1,206 frames; self time in us a frame; V8 inlines wasm callees into their callers, so self time moves between functions
and only the order of magnitude means anything):

| Function | V8 | Gecko | ratio |
|---|---:|---:|---:|
| `decal::fast::edge` | 24 | 107 | **4.55** |
| `render::Obj::of` | 59 | 128 | 2.15 |
| `destroy_scan` | 95 | 163 | 1.72 |
| `render_scan` (the page's thread in Chromium's worker mode; compare with care) | 215 | 294 | 1.37 |
| `level_distance` | 87 | 127 | 1.46 |
| `hash::multi_line` | 104 | 149 | 1.44 |
| `trace::ray` | 67 | 105 | 1.57 |
| the interpreter's `Run::statements`, `boolean`, `object`, `call`, `effect`, `int`, `float` (together) | 333 | 597 | 1.79 |

`edge` is the outlier by far, and the cause below is its. The interpreter's match functions come out 1.8 times, which no replay confirms (its
recorded calls are either nanoseconds or nested, above) and which may be the two profilers' attribution: **open**.

**Ruled out** (Firefox replay of six cases on the 2534cbfb module, mean us per call, 2.5 s each, flat in time from the first second; the live
runs under the same preferences differ by less than the 15 percent spread between sessions):

| Case | default | baseline only | Ion only | lazy tiering off | unroll loops | no AVX | inlining level 4 | no huge memory |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `area_scan` | 37.1 | 45.8 | 26.7 | 37.3 | 37.3 | 36.8 | 36.9 | 42.1 |
| `decal_attach` | 88.6 | 147.3 | 71.7 | 71.6 | 87.6 | 86.7 | 87.0 | 99.9 |
| `destroy_scan` | 43.7 | 63.8 | 44.0 | 44.5 | 49.6 | 40.9 | 49.4 | 48.5 |
| `lc_scan` | 13.8 | 30.0 | 13.8 | 13.8 | 13.6 | 14.0 | 14.2 | 14.8 |
| `level_distance` | 95.0 | 135.9 | 82.7 | 82.2 | 94.9 | 82.6 | 95.4 | 87.6 |
| `nav_scout` | 34.8 | 88.7 | 41.7 | 41.4 | 34.7 | 35.1 | 34.8 | 37.9 |

* *Tier-up lag*: the default is lazy tiering on Ion, flat from the first second (Ion code, not baseline: baseline only is 1.2 to 2.5 times slower); Ion
  only or no lazy tiering are 0 to 28 percent faster on three cases and 20 percent slower on `nav_scout`, which the live runs under each preference
  (`hitch-run --ff-prefs`, 5 to 9 percent either way, inside the sessions' spread) do not show. Nothing a page can set; a warm-up has nothing to tier.
* *Bounds checks*: disabling huge memory (explicit bounds checks) costs 5 to 15 percent, so the module runs with guard pages.
* *Transparent huge pages*: the big anonymous mappings are mostly huge pages in Node (26 to 54 of 36 to 77 MiB) and in Firefox's content process
  (6 to 28 of 9 to 32 MiB); a fresh 50 MiB memory is 100 percent huge in Node and 96 in Firefox.
* *Module shape*: 623 functions, the largest 40 KB, no function Ion could decline; no i128 (the x87 limbs are u64: `Ext` add and multiply are
  6 and 3 percent of `decal_attach`, 4.1 and 2.0 us in Firefox against 3.8 and 1.8 in V8); `lto`, `codegen-units = 1`, `opt-level = 3`, `panic = abort`
  already. LLVM inline thresholds of 1,000 and 5,000 change the statics' layout (every snapshot of the module fails its hash), so they would need
  new snapshots; not pursued after the cause below.
* *Timer*: Playwright's Firefox rounds `performance.now` to 1 ms; with `privacy.reduceTimerPrecision` off it steps by 20 us.

**The cause: a `memcmp` call.** Gecko and V8 profiles of the replayed `decal_attach` on 2534cbfb, self time per call (us): V8 `gather_nodes` 22.5,
`edge` 13.6, `find_surface` 11.0; Firefox `edge` **47.2**, `gather_nodes` 17.3, `find_surface` 14.3. `edge` (`decal/fast.rs`) looks up the edge table
and compares the 36-byte key with `e.key == key`, and Rust's `==` on `[u32; 9]` is a call to `memcmp`, which `compiler_builtins` implements as a
byte loop. A decal attach makes 1,633 such calls (`decal_fast_stats`: 1,633 hits, 8 misses): 29 ns each in Firefox, 8 ns in V8. The wasm asm
(`cargo rustc ... -- --emit asm`) has eleven `call memcmp` sites: this one, the FCoords cache's key compare (`percep.rs`, 12 bytes), the
rotator `==` and `!=` of the interpreter (`Run::boolean`, `Run::effect`), `move_source` and `pawn_phys::perform` (12 bytes), the verify-mode
compare of `gather` and `light_merge`'s texel rows.

**The change** (`interp.rs` `words_eq`, `ints_eq`): the XOR of all words ORed, one inlined branch-free test, at `decal/fast.rs edge`, `percep.rs
fcoords_axes`, `move_pawn.rs`, `pawn_phys.rs perform` and the interpreter's rotator `==`/`!=`; `light_merge` (a texel row, tens of bytes, 35 calls a tick,
0.007 ms) and the verify-mode compare keep `memcmp`. Equality of the same words, so every result is the same bits. The old `==` is the cargo
feature `eq_ref` (not in the shipped module), loaded in a page by `?wordEq=ref` (`WORD_EQ=ref` in Node) from `script-vm-eq-ref.wasm`
(`node scripts/build-eq-ref.mjs`, git-ignored), like `?x87=ref`.

**Replay after the change** (HEAD module, `head` = shipped before, `eqref` = the old `==` rebuilt, `eqfix` = the change; mean us per call; the
`*` is the hash of the whole memory, which differs in the shadow stack's frames; below, the same call run by `head` and `eqfix` leaves every byte
outside the first MiB equal, and the same result):

| Case | Node head | eqref | eqfix | Firefox head | eqref | eqfix |
|---|---:|---:|---:|---:|---:|---:|
| `decal_attach` | 62.7 | 61.0 | **43.0*** | 86.9 | 86.6 | **44.0*** |
| `decal_attach` (another) | 58.8 | 58.6 | **41.0*** | 84.0 | 84.3 | **41.5*** |
| every other case (10) | | | within 2 % | | | within 3 % |

Firefox over Node on `decal_attach`: 1.42 before, 1.02 after.

**A/B.** Firefox inline, headless, interleaved pairs (the arms' order alternating, each pair's two sessions under one hold of the heavy lock,
pinned to CPUs 4-7,12-15, 25 s sessions counted from 5 s after the map, god mode, idle), new = the change, old = `?wordEq=ref` of the same tree
(the pairs 1 to 3 at the Dockyard ran through `hitch-ab.mjs --guard --cpus`, the rest through a script holding the lock for a pair); ms, pair
differences new - old with the standard error of their mean and the pairs better:

| 8 pairs | new | old | new - old | se | pairs better |
|---|---:|---:|---:|---:|---:|
| **Dockyard** (2623, 6205, 20) yaw 32768: page `animate` mean | 27.28 | 28.11 | **-0.83** | 0.84 | 7 of 8 |
| page slowest tenth | 36.81 | 38.31 | **-1.50** | 1.35 | 6 of 8 |
| tick `p.tick` mean | 13.68 | 14.21 | -0.53 | 0.44 | 6 of 8 |
| tick slowest tenth | 21.03 | 22.10 | -1.07 | 0.84 | 6 of 8 |
| `p.render` (not touched: the control) | 2.89 | 3.00 | -0.11 | 0.13 | 5 of 8 |
| **Island** (the start, idle): page mean | 16.26 | 16.84 | **-0.58** | 0.32 | 5 of 8 |
| page slowest tenth | 19.39 | 20.36 | **-0.98** | 0.79 | 6 of 8 |
| tick mean | 6.76 | 7.07 | -0.31 | 0.15 | 5 of 8 |
| tick slowest tenth | 9.01 | 9.47 | -0.45 | 0.32 | 6 of 8 |
| `p.render` (control) | 2.32 | 2.38 | -0.06 | 0.06 | 4 of 8 |

Page-mean differences by pair: Dockyard -2.5 -0.5 -0.2 -0.5 -2.5 -2.3 -2.6 +4.4 (the last pair is a slow session of the new arm; the sessions'
spread is +-1.5 ms, as in the previous steps); Island -1.8 -1.1 +0.4 +0.2 +0.3 -0.2 -0.8 -1.7. Both spots meet the bar (0.3 ms of the page mean or
0.5 of its slowest tenth) on their point estimates, with standard errors as large as the effects: **shipped on that evidence, not as a
measured significance**. The export timer in three sessions of each arm at the Dockyard (2,408 and 2,320 ticks) puts the identified part at
`decal_attach` 126 against 177 us a call (0.275 against 0.359 ms a tick), `ai_tick` 275 against 291 us (the FCoords cache's compare) and
`level_tick_batch` 10.30 against 11.00 ms a tick; the other exports within 5 percent. The decal and AI parts are about 0.1 ms a tick; the rest of
the 0.5 to 0.8 ms of tick the pairs show is not attributable to a timed export (the sessions' spread covers it).

**Checks** (on the final source; `.work/gap/` scripts under the heavy lock):
* `npm run build:wasm` and `node scripts/build-eq-ref.mjs`: no warnings. `npm test`: 980 tests, 976 passed, 4 skipped, 0 failed.
* The six sim digests unchanged: Island 5adb254a07b1ed6f, 00_Training 07816ec472f29b84, 03_NYC_Airfield 46ed0d32ae5b56af, 06_HongKong_WanChai_Market
  80d27b37e0944d88, 15_Area51_Bunker 764a7bdffd2ebe59, 09_NYC_Dockyard e53f348673f1247b; the `WORD_EQ=ref` build gives the Island's (and, in an earlier
  build of the same change, the Dockyard's); the one-spot Dockyard run of the study (`eba45015fec39e3f`) is the same with the hook, before and after.
* Validators (`run-validators.mjs --filter`): the seven decal ones (`decal-fast`, `decals-play`, `decal-attach`, `decal-vertices-play`, `decal-render`,
  `decal-startup`, `decal-order`), `perception-kernel`, `pawn-move-kernel`, `pawn-physics-kernel`, `locomotion-kernel`, `ai-visibility` and its runtime one,
  `scripted-pawn-tick`, `script-vm-interp`, `native-pawn-rotation`, `native-actor-rotation`, `native-mover-move` and `native-set-rotation-riders`
  (which reads the mover-move report, absent in a fresh worktree): all pass; the runner skips `pawn-perception` and `pawn-locomotion` as before.
* The recorded `decal_attach` (two), `level_distance`, `destroy_scan` and `area_scan` calls run by the module before and the module after the change from
  the same snapshot: the same result and the same bytes everywhere outside the shadow stack (the first MiB), 0 bytes differing.


**Open.**
* The interpreter's match functions (above): 1.8 times in the profiles, no replay. A replay of `vm_statement` needs the imports that run the module
  again (`nested` in the hook) to be replayed too.
* Why a page is 1.2 to 2.5 times slower than Node on the same exports in both browsers (`level_distance` 41 us hot, 109 live in Node, 270 to 320 in
  the pages). My guess, not tested: the host's software GL threads and the frame's other work share the cores and evict the actors the scans walk.
  `hitch-run --size` 800x500 and 360x240 never made the map current (300 s timeout) on this tree, so the check with a small canvas was not made.
* `light_merge`'s texel-row compare (35 calls a tick, 0.007 ms) and `gather`'s verify-mode compare still call `memcmp`; the 184 `memory.fill` and
  `memory.copy` sites are builtin calls in SpiderMonkey (0.4 us of a `decal_attach`'s 96 in its profile); no replay case was slow because of them.
* The Mac (Apple M2 Pro, Safari and Firefox there) is not measured.

### HUD remainder (2026-11-07)

The task: the HUD phase (`p.hud`, 1.2 to 2.0 ms a frame on the four maps still over 16.7 ms at p95) after [the HUD bundle](#the-hud-bundle-2026-11-06),
whose open list named four items under 0.5 ms each. Result, headless Linux (Ryzen 9 8945HS, Node 26, Firefox 155 inline 1440x960, scan route, god mode, tree
cdd8b459; the Mac and headed runs are not measured): **two families shipped, both behind `=js` switches: the page's draw of the tile stream
(`?hudDraw=js|verify`, `p.hud` -0.40 ms) and Rust-begun script calls and window events with string locals (`?stringFrames=js|verify`, `w.hud` -0.09 ms).
Island, six interleaved pairs: `p.hud` 1.86 -> 1.37 ms, page mean 13.13 -> 12.52 ms (-0.61, se 0.11, lower in 6 of 6), slowest tenth 18.86 -> 18.36 ms (-0.49,
5 of 6).** Area 51 bunker, six pairs: `p.hud` 2.00 -> 1.58 ms, page mean 12.37 -> 11.87 ms (-0.50, se 0.14, lower in 6 of 6). The sim digests, the HUD command streams, the validators and `npm test` hold. Design and checks:
[the page's tile draw and string-local frames](script-play-hud.md#the-pages-tile-draw-and-string-local-frames-2026-11-07).

**Ranking** (Gecko profile, `hitch-run.mjs --mode scan --god --seconds 60 --profile`, joined to the hitch log by `gecko-phase.mjs` and `gecko-hud-categories.mjs`; ms a
drawn frame from 5 s after the map, profiled, so about 1.2 times the unprofiled figures; `.cache/perf/hud/`). The rows overlap by under 0.05 ms:

| Part | Island | Bunker | What it is |
|---|---:|---:|---|
| the page's draw of the tile stream (`hudRenderer.render`, hud.mjs) | 0.53 | 0.53 | about 73 tiles in 50 runs of one material a frame on the Island (130 in 56 on the bunker: terminal text); three.js `renderScene` 0.18, `projectObject` 0.14 (a mesh and three attribute buffers per run: 144 `bufferSubData` calls), `updateMatrixWorld` 0.05, the command objects and `draw` 0.08 |
| window events with string locals (`processEvent` under the hud step) | 0.39 | 0.38 | `ActorDisplayWindow`, `DamageHUDDisplay`, `HUDMultiSkills`, `FrobDisplayWindow` DrawWindow: 0.28 the Rust bodies, 0.06 `destroyFunctionLocals`, the rest the JavaScript dispatch |
| script functions Rust hands to JavaScript (`callFunction` under the hud step) | 0.37 | 0.34 | `DrawTargetAugmentation` (a final call every frame), `TraceLOS` and small calls (`SetCrosshairColor`, `GetBarColor`, `PlayerIsClient`) |
| the console's PostRender | 0.23 | 0.20 | 0.18 in `withCanvasNatives`, of it 0.13 in a `callFunction` from a Rust body |
| `p.hud` / `w.hud` (unprofiled, the run's hitch log) | 1.98 / 1.31 | 2.17 / 1.43 | |

The page's draw was the largest and the one with a plain remedy; the second row, and `DrawTargetAugmentation` in the third, share one cause (a function with a string
local was sent to the JavaScript path whole, for `destroyFunctionLocals`).

**Shipped 1: one interleaved buffer for the tile runs** (`hud.mjs`; `?hudDraw=js` keeps a mesh and three attribute buffers per run and the command objects,
`?hudDraw=verify` draws like the default after checking each segment against them). A frame's tiles are written as the same float32 vertices ([x, y, 0, u, v, r, g, b], six
a tile, in the reference's order) into one `InterleavedBuffer`; a run of one material is a group of the one geometry, the material list a mesh's array; the
render list's sort is stable and the groups share an object id, so the runs draw in the order they were added, as the reference's meshes drew by `renderOrder`. The
simulation's command stream (`script-window-command-stream.mjs`) is read directly: no `expandHudStream` objects, no `{...command, image}` copy and no template string
per tile for the material key (the image keeps its styles' materials). The Island's page part of `p.hud` went 0.64 -> 0.23 ms (six pairs, each 0.37 to 0.42 lower).

**Shipped 2: Rust-begun bodies with locals to destroy** (`?stringFrames=js|verify`; script-vm-lower.mjs `frameDestruction`, script-vm-events.mjs `runEnd`, interp.rs
`call`, dispatch.rs `dispatch_window_event`). `functionSignature` and `callSignature` refused any function with a CPF_NeedCtorLink field. They now refuse one with such
a parameter or result and admit one with such locals (`signature.destroys`); the event and call caches mark it K_RUN_D (js_call_begin's CALL_BLOCK a destroy word)
and Rust calls `js_run_end(run, template)` when the body returns, where callFunction / processEvent ended with `destroyFunctionLocals` (after the out copy-back, before the
frame stack is put back). The JavaScript run a Rust body needs for a JavaScript step is built on first use (`Run.frame`); `runEnd` runs the destruction only for a frame so made.
A frame no step made holds the locals Rust zeroed it with, and DestroyValue of a zero string only writes the empty string back to a frame about to be popped (the next push zeroes the
block): nothing observable. That is checked, not assumed: `STRING_FRAMES=verify` runs the loop on the unmade frames too, over the same block, and compares the block. On the
Island a frame has five such bodies; `ActorDisplayWindow` and `FrobDisplayWindow` run whole in Rust (unmade), `DrawTargetAugmentation`, `DamageHUDDisplay` and
`HUDMultiSkills` make a frame (they store strings through JavaScript steps) and still run the loop. In Node (V8) the family is worth little: the paint 1.37 -> 1.28 and
0.99 -> 1.01 ms on the Island (two pairs), 1.21 -> 1.14 and 1.18 -> 1.14 on the bunker; in Firefox, `w.hud` -0.09 ms in all six Island pairs.

**Exactness.**
* `hud-stream-digest.mjs` (600-frame roams, the HUD command stream per frame, with the switches at their defaults and `STRING_FRAMES=verify`): Island df48c15010687dd1,
  bunker 4cd8392aff85151c and 00_Training 702be5968d3bcafb, each equal to the previous tree's, frame by frame.
* The six sim digests (`bench-sim.mjs --warm 60 --ticks 300 --render-feedback`): Island 5adb254a07b1ed6f, 00_Training 07816ec472f29b84, 03_NYC_Airfield 46ed0d32ae5b56af,
  06_HongKong_WanChai_Market 80d27b37e0944d88, 15_Area51_Bunker 764a7bdffd2ebe59, 09_NYC_Dockyard e53f348673f1247b: unchanged.
* The page draw in a browser, `?hudDraw=verify` (every segment's vertices bit for bit and the two scenes drawn into render targets over one ground and read back, every byte
  equal): Firefox inline, Island 960 segments (70,384 tiles, 47,630 runs, 1.3 G pixels), bunker 911 (118,001 tiles, 51,142 runs, 1.26 G pixels, with `stringFrames=verify`);
  Chromium worker mode, Island 1,844 segments (140,660 tiles, 92,688 runs, 2.55 G pixels, with `stringFrames=verify`); no difference, no runtime error.
* `validate-script-vm-interp` (542,442 checks; new cases for the destroy word: one `js_run_end` per begun callee that has it, with its run id and template, while its block is on the
  stack), `validate-play-hud`, `validate-console-play`, `validate-viewport-console`, `validate-gc-draw-actor-play` (the wrapper counts a stream's kinds) and
  `validate-scope-view-play` pass; `test/hud-compositor.test.mjs` runs the former compositor's expected tiles through `js`, `single` and the stream (four forms); `npm run build:wasm`
  is warning-free; `npm test`: 983 tests, 979 pass, 4 skipped, 0 fail.
* `STRING_FRAMES=verify` in Node (`hud-census.mjs --time-only`, 360 frames): 1,804 bodies, 1,084 with a frame a JavaScript step made, 720 unmade frames checked, none changed.

**Interleaved A/B** (`hitch-ab.mjs --guard --cpus 4-7,12-15`, from a frozen copy of the tree, order alternating, 60 s scan route, Firefox inline), `new:` (defaults) against
`js:hudDraw=js&stringFrames=js`; per-session means over the drawn frames from 5 s after the map (ms), paired differences new minus js:

| Map (pairs) | p.hud new / js | of it page part | of it `w.hud` | page mean | page p95 | slowest tenth |
|---|---:|---:|---:|---:|---:|---:|
| Island (6) | 1.37 / 1.86 (-0.48, 6 of 6) | 0.23 / 0.63 (-0.40) | 1.14 / 1.23 (-0.09) | 12.52 / 13.13 (-0.61, se 0.11, 6 of 6) | 17.83 / 18.17 (-0.33) | 18.36 / 18.86 (-0.49, 5 of 6) |
| Area 51 bunker (6) | 1.58 / 2.00 (-0.42, 6 of 6) | 0.31 / 0.67 (-0.36) | 1.27 / 1.33 (-0.06) | 11.87 / 12.37 (-0.50, se 0.14, 6 of 6) | 18.00 / 18.33 (-0.33) | 19.71 / 20.07 (-0.36, 4 of 6) |

Ship bar (0.3 ms off the page mean or 0.5 off the slowest tenth on one of the two maps, no regression on the other): **met** on both maps: the page mean is 0.61 ms lower on the Island and 0.50 ms on the bunker (every pair of both), the slowest tenth 0.49 ms lower on the Island (5 of 6 pairs; the bunker's 0.36 is 4 of 6, its first pair 0.51 higher and its fourth 0.09); no column's mean is higher on either map, and `p.tick`, which the change does not touch, is within the sessions' spread (-0.07 and -0.05). The page p50 and p95 are whole milliseconds (the hitch log's resolution), so their pair differences are 0 or -1.

**What is still open** (ms a frame, Firefox, profiled, Island after the change; the HUD is `p.hud` 1.37):
* **The page's draw of the runs**: 0.21, of it three.js `renderScene` 0.13 (about 50 runs, each a `setProgram`, uniforms and a texture bind). Fewer runs would need a texture
  atlas or a direct GL submit, which has to keep the draw order and the blend state; a single run draws the same pixels, so it is the number of material changes, not tiles.
* **`TraceLOS`** (0.09 ms in Node): `DrawTargetAugmentation`'s call has an `out vector` parameter and a `foreach Player.TraceActors`; Rust runs neither (its iterators are
  `CycleActors`, the actor scans and the like). `js value 0x1b TraceLOS` stays a JavaScript call.
* **Three bodies a frame still make a frame** (`DrawTargetAugmentation`, `DamageHUDDisplay.DrawWindow`, `HUDMultiSkills.DrawWindow`): their statements that store strings
  (`targetplayerhealthstring = ""`, text fields) are JavaScript steps, so the frame and its destruction loop remain. Lowering string literals to string fields needs the object
  image's string cells in Rust.
* **The console's PostRender** is unchanged (0.20): the Rust body's call goes to JavaScript (a callee that is still not eligible, not named here); `withCanvasNatives` binds three natives
  and swaps `runtime.native` each frame, which binding once would change for every other Canvas native call.
* **DrawText with a string argument** (14 a frame: `js effect 0x19(... native 1282(..., string))`) and the window width and height reads (35 a frame) are JavaScript nodes of 1 to 3 us each.

### Tick slowest tenth (2026-11-07)

The task: cut the slowest tenth of the simulation tick in Firefox inline on the four maps still over budget (master 4951bc30, headless Linux,
page p95 / tick mean: Island 19 ms / 5.94, Battery Park 19 / 5.73, Area 51 bunker 18 / 4.97, Airfield 17 / 4.95). **Result: three families
were found in Gecko profiles, ported to Rust exactly and verified; none reaches the ship bar. In the interleaved A/B the tick mean moves by
+0.07 ms (Battery Park rest spot) and -0.11 ms (Island scan route), the tick's slowest tenth by +0.03 and -0.29 ms, the page mean by +0.26 and
-0.02 ms. The code is on the branch `tick-tail-unshipped` (commit d8d74a4e); this branch carries these notes only.** The profiles over-promised: they
put the three families at 0.4 to 0.6 ms a frame at both places, the A/B finds at most 0.1 ms of the tick mean (below).

**Reproduction.** Profiles: `hitch-run.mjs --browser firefox --map 01_NYC_UNATCOIsland --mode scan --god --seconds 60 --profile FILE` and `--map
02_NYC_BatteryPark --mode idle --god --seconds 40 --place '{"location":[2025,-3396,263],"rotation":[0,32768,0]}' --profile FILE`, read with
`gecko-slow-ticks.mjs`, `gecko-under.mjs` and `gecko-phase.mjs` (all pinned to CPUs 4-7,12-15 under the heavy lock). The Node census of the events
the Island sends through `ProcessEvent` is a bench-sim scenario that wraps `runtime.processEvent` (300 ticks, `.work`, not kept).

**Ranking** (Gecko profile, ms a drawn frame by the Rust core's import: rest frames / slowest tenth of ticks; the Island run 3,549 drawn
frames with a tick of 6.17 ms in the rest and 9.59 in the tenth, the Battery Park run 1,892 with 5.85 and 8.74):

| Family | Island rest / tenth | Battery Park rest / tenth | note |
|---|---:|---:|---|
| `js_eval` (flat: natives, field assignments, calls the Rust VM does not lower) | 0.79 / 1.26 | 0.73 / 0.94 | no family above 0.15 |
| `js_walk_prelude` (the walking pawns' surface prelude) | **0.39 / 0.64** | 0.28 / 0.35 | the scan 0.17 (Rust 0.08), the WalkTexture event 0.14 |
| the player's ShowSelf (`tickStandaloneActor` > `showSelf`) | **0.20 / 0.22** | 0.16 / 0.21 | a JavaScript walk over about 75 pawns, two generic reads each |
| `js_tick_physics`: PHYS_Rolling of two TrashPapers | 0 | **0.21 / 0.33** | `playerMove` 0.18; PHYS_Interpolating 0.10 / 0.13 |
| `js_bool` (AttachDecal's glue, shadows reattaching) | 0.16 / 0.43 | 0.16 / 0.22 | the decal families of earlier steps |
| `js_move_riders`, `js_move_hash`, `js_move_hits` | 0.17, 0.16, 0.07 | 0.13, 0.11 | the collision hash and rider scans stay JavaScript |
| `js_anim_notify_event`, `js_object`, `js_tick_resume` | 0.06, 0.07, 0.02 / 0.19, 0.15, 0.08 | 0.07, 0.10, 0.02 / 0.25, 0.27, 0.15 | NPC state changes (the tenth) |
| `js_tick_refresh` (the host's refresh after hand-backs) | 0.18 / 0.19 | | proportional to the number of hand-backs |
| in Wasm (the Rust core itself) | 0.98 / 1.41 | 1.06 / 1.56 | at the Battery Park spot +0.4 of the tenth is the event manager's perception |
| JavaScript with no Wasm under it | 1.10 / 1.43 | 0.97 / 1.21 | the player's Tick script 0.56 (Island), `tickActor` 1.08 in all |

The Island's tick structure (`tickStandaloneLevel`): the actor batch 3.36 ms, the player's own tick 1.10 (its Tick event script 0.58, ShowSelf 0.20,
physics 0.13, input 0.07), the event manager 0.16, player distances 0.14. At the Battery Park spot: batch 2.83, the player 1.07, **event manager
0.50**. Two items of the task's list were looked at and are not hand-back families: the AI event manager's growth in the slow ticks (0.46 to 0.87 ms) is
Rust time (`percep` under `ai_tick`: 0.22 to 0.62 ms in Wasm); its JavaScript imports total 0.12 to 0.17 ms (`js_ai_in_stasis` 0.05 / 0.08, `js_ai_owner`
0.01 / 0.03, `js_ai_float` 0.02). The interpreter's `Run::*` match functions were not taken: no replay covers them (the previous step's open item), so
there is nothing to measure a change against.

**The families built** (each: original behavior first, a switch `?name=js|verify` with an environment variable in Node, wired through main.mjs's
switch list and `switch-reader.mjs`; the JavaScript bodies stay the references).

1. **The walking prelude up to the scan** (`WALK_PRELUDE` / `?walkPrelude=`; walk_loop.rs `scan_fast`, walk-loop-kernel.mjs `scanFast`,
   script-empty-body.mjs). *Original:* physWalking calls the surface prelude (Engine.dll 0x103cc450) every tick: the scanner 0x103ccc40, the
   Ladder test, the floor query 0x103ccb70, then ProcessEvent of WalkTexture (0x103cc81d, [walking.md](walking.md#surface-prelude-boundary)).
   `Pawn.WalkTexture` is `event WalkTexture(...);` in Engine.u, bytecode `return _` (`scripts/dump-script-function.mjs Engine Pawn.WalkTexture`;
   `04 0b`, flags 0x800), and no function of that name exists in Engine, Extension or DeusEx, in a class or a state (`'*WalkTexture*'`). The Island
   sends it 59.3 times a tick, the fourth most frequent ProcessEvent of the census (after the AI score callbacks and the weapon and decoration
   Ticks). ProcessEvent of a bare return builds a frame, copies three parameters and returns; the runaway counter is Jump's, so nothing outlives it.
   *Built:* Rust makes `fillScanInputs`'s inputs over the pawn's image (the scan's four segments turn from Rotation.Yaw by the sine table) and calls
   `js_walk_scan`; the host answers 1 when the prelude would return false having changed nothing (no Ladder on the last hit, a floor the walk may
   stand on, WalkTexture reaching a bare return, cached by class and state node) and 0 otherwise, when the JavaScript prelude runs the whole call.
   `=verify` compares the Rust inputs with `fillScanInputs`'s bit for bit and runs the JavaScript prelude after every fast answer, which must
   return false.
2. **PHYS_Rolling of a non-Pawn in Rust** (`ROLLING_PHYSICS` / `?rollingPhysics=`; fall.rs `perform_rolling`, actor-physics-kernel.mjs; the
   pattern of the falling port; docs/rolling.md "The Rust body (2026-11-07)", on the branch). rolling.mjs statement for statement on the image
   (`move_source` for MoveActor, the zone from the host once, the events and SetPhysics/SetBase as imports, `Base` a new row of the fall field
   table). `=verify` runs the Rust body for real with every service call and the actor's fields around it recorded, then runs `rolling.mjs` on a mock
   host answering from the record, and compares the services, the fields before each and the end state.
3. **The player's ShowSelf pawn-list walk** (`SHOW_SELF` / `?showSelf=`; showself.rs `showself_scan`, show-self-kernel.mjs, script-pawn-perception.mjs
   `showPawnSelf`). *Original:* APawn::ShowSelf (0x103c0410, [script-pawn-tick-visibility.md](script-pawn-tick-visibility.md)) walks PawnList for the
   player each tick and looks at a pawn only when its SightCounter is below zero (or NaN) and it is probing SeePlayer. Rust reads SightCounter and
   NextPawn from the images and returns the first pawn the body must look at, or one whose cells it cannot read (host bindings of those keys, no image);
   the body, the SeePlayer probe and the LOS worker stay JavaScript. `=verify` walks the pawns in JavaScript from the same place after each answer and
   throws on a skipped pawn that the body would have looked at.
4. *Built and dropped:* `lc_scan` tracing only the last of the prelude's 36 scan segments where no surface can stop the scan. Exact where no node of
   the model has a Ladder texture, but the Island's model has 251 such nodes and Battery Park's 104 (the texture lists hold the Ladder group on every
   map), so it never applied where it was to be measured; a spatial test of the ladder nodes would be needed.

**Exactness evidence.**
* The six sim digests (`bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback`) unchanged: Island `5adb254a07b1ed6f`, 00_Training
  `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`; also with
  all three switches at `verify` on the Island, Wan Chai and the bunker (same digests).
* Walk prelude: 20,133 (Island), 10,190 (Wan Chai) and 22,254 (Battery Park) prelude calls, all answered fast, every input compared bit for bit with
  `fillScanInputs`, the JavaScript prelude returning false after each; `WALK_PRELUDE=js` gives the same digests. ShowSelf: 2,469 (Island), 1,663 (Wan Chai),
  680 (bunker) and 4,941 (Battery Park) scans verified against a JavaScript walk (27,201, 15,291, 5,453 and 39,937 pawns skipped; none unreadable).
* Rolling: at the Battery Park spot (two papers, 900 ticks) 2,040 calls, 6,398 services and 8,438 state comparisons; with `scripts/scenarios/rolling-branches.mjs`
  (every movable decoration and item set rolling at three speeds with an Acceleration, bBounce or a RotationRate, thrown up and set rolling in the air)
  on the Island 32,134 calls (4,076 HitWall events, 1,206 bBounce refunds, 2,596 slides, 2,045 falling transitions, 243 SetBase calls; 77,174 services and
  109,308 states compared) and in Training 6,088 calls (941, 271, 623, 281, 69): digests equal between the default, `verify` and `ACTOR_PHYSICS=js`
  (Island `34491fc786a07d0b`, Training `d0bfa32ee03790d7`). `validate-actor-physics-kernel` now runs those two scenarios on three paths and requires the
  rolling branches to be reached. The reference's own evidence is unchanged: `validate-native-rolling` (Unicorn oracle of Engine.dll 0x103d4b80) passes.
* Firefox inline (`?walkPrelude=verify&rollingPhysics=verify&showSelf=verify`, `deusExVerifyCounts` read from the page) and a Chromium worker session: the Island scan route (35,441 preludes, 62,284 ShowSelf scans, 136,635 pawns skipped) and the Battery Park rest spot (19,004 preludes, 31,100 scans, 67,566 pawns skipped) ran 40 s each with no difference and no page error; the Chromium worker session lists all three switches in the simulation realm (`--probe-switches`) and ran 2,061 drawn frames with no error. **No rolling call ran in the Firefox session at the spot (0 of 0 verified; Node's run has 2,040)**: the papers' state depends on the session's timing, so the 0.21 ms of rolling in the old-code profile is not there in every session, and the A/B at the spot measures the rolling port only where the papers roll.
* Validators that pass: `actor-physics-kernel`, `native-rolling`, `walk-loop-kernel`, `walk-loop-branches`, `pawn-physics-kernel`, `native-walking-surface`,
  `native-walking-callbacks`, `plant-push` (and the swimming ones that use the same prelude: `native-swimming`, `pawn-swimming-reach`, and `pawn-tick-visibility` for ShowSelf); `test/actor-physics-kernel.test.mjs` (field table,
  counters, imports and `bareReturn`) and `test/show-self-kernel.test.mjs` are new. `npm test`: 987 tests, 983 passed, 4 skipped, 0 failed. `npm run build:wasm` is warning-free.

**A/B.** Firefox inline, headless, 25 s idle sessions at the spot and 60 s scan sessions on the Island, frames from 5 s after the map, god mode, six
interleaved pairs each (`hitch-ab.mjs --guard --cpus 4-7,12-15`, the arms alternating), new = the defaults, old =
`walkPrelude=js&rollingPhysics=js&showSelf=js` on the same tree; ms, pair differences new - old with the standard error of their mean:

| Island scan route (6 pairs) | new | old | new - old | se | pairs lower |
|---|---:|---:|---:|---:|---:|
| page `animate` mean | 12.66 | 12.70 | -0.04 | 0.11 | 3 of 6 |
| page `animate`, slowest tenth | 18.43 | 18.62 | -0.19 | 0.34 | 4 of 6 |
| tick `p.tick` mean | 5.57 | 5.68 | -0.11 | 0.05 | 5 of 6 |
| tick, slowest tenth | 8.23 | 8.52 | -0.29 | 0.15 | 5 of 6 |
| `p.render` (untouched: the control) | 1.63 | 1.60 | +0.03 | 0.02 | 1 of 6 |

| Battery Park rest spot (6 pairs) | new | old | new - old | se | pairs lower |
|---|---:|---:|---:|---:|---:|
| page `animate` mean | 17.20 | 16.94 | +0.26 | 0.43 | 2 of 6 |
| page `animate`, slowest tenth | 20.56 | 20.09 | +0.47 | 0.28 | 2 of 6 |
| tick `p.tick` mean | 5.23 | 5.16 | +0.07 | 0.07 | 2 of 6 |
| tick, slowest tenth | 7.29 | 7.26 | +0.03 | 0.14 | 4 of 6 |
| `p.render` (untouched: the control) | 3.06 | 2.86 | +0.20 | 0.11 | 1 of 6 |

Pair differences new - old, in the order of the pairs (the order of the arms alternates). Island: page mean 0.2 0.2 -0.4 0.2 -0.4 -0.1 ms; tick mean: -0.01 -0.03 -0.29 0.02 -0.24 -0.15 ms; tick's slowest tenth: -0.67 -0.39 -0.50 0.31 -0.49 -0.00 ms. Battery Park: page mean 0.1 1.6 0.9 -1.4 0.7 -0.2 ms; tick mean: 0.03 0.40 0.11 -0.13 -0.05 0.04 ms; tick's slowest tenth: -0.44 -0.13 -0.03 0.18 -0.00 0.58 ms.

Ship bar (0.3 ms of the page mean or 0.5 of its slowest tenth on one of the two, no regression on the other): **not met**. The Island's tick improves
(mean -0.11, slowest tenth -0.29; 5 of 6 pairs lower on both) but the page does not follow (the sessions' spread is 0.7 ms either way, `p.render`, which no
family touches, moves by up to 0.2); the Battery Park rest spot shows nothing in the tick and +0.26 in the page mean, which is the spread.

**What is left in the new code** (a Gecko profile of the defaults, ms a frame, rest / tenth; "was" is the old code's figure of the ranking): Island `js_walk_scan` 0.25 /
0.37 (was `js_walk_prelude` 0.39 / 0.64; the Rust scan is 0.13 of it, the scan's JavaScript glue `start` / `describeQuery` / `surfaceScan` about 0.09), ShowSelf 0.12 (was
0.20: the six or so pawns a tick with SightCounter below zero, each a SeePlayer probe and the LOS worker); Battery Park `js_walk_scan` 0.20 / 0.25 (was 0.28 /
0.35), ShowSelf 0.14 (was 0.16). The sampled tick of those sessions fell from 6.17 / 9.59 to 5.73 / 9.20 ms on the Island, which is not the A/B's -0.11 / -0.29:
two different sessions, and a profile that charges frames.

**Why the profiles over-promised.** A sampling profile charges the cost of every JavaScript frame it walks to the code under it. The families here are
short JavaScript hand-backs called a hundred times a tick (59 WalkTexture events, 75 pawns of ShowSelf, two papers): their sampled share grows with
the number of calls and frames, where a call's real cost in an unprofiled page is a fraction of it. The previous steps' families were single heavy
bodies (a spawn, a cleanup pass, a decal attach), and their A/B matched their profiles. For hand-backs of this kind the A/B has to come first, on the
switches, before a port is built. Node says the same: the Battery Park spot's tick mean is 5.41 ms with the switches on and 5.47 with them off.

**Open.** The same ranking, with its caveat: the player's Tick script (0.56 ms a frame on the Island, run by the Rust VM with `js_eval` field
assignments and calls under it), the collision hash maintenance around every pawn move (`js_move_hash` 0.16, `js_move_riders` 0.17: the hash is a
JavaScript structure, the port is a Rust owner of the registrations), the event manager's perception in Rust at the Battery Park spot (+0.4 ms in the
slow ticks), NPC state changes in the tenth (`js_anim_notify_event`, `js_object`, `js_tick_resume`), and the decals of the Island's slow ticks
(`js_bool` +0.27). PHYS_Interpolating at the Battery Park spot (0.10 ms, `physPathing` through `playerMove`) is the next of the rolling kind.

### Firefox p95 frames (2026-11-07)

The task: bring the Firefox inline page frame p95 from 17 to 16 ms on UNATCO Island, Battery Park and the Area 51 bunker (master 4316b4d3,
headless Linux, Ryzen 9 8945HS, Firefox 155 inline 1440x960, god mode, sessions pinned to CPUs 4-7,12-15 under the heavy lock; the Mac and headed
runs are not measured). **Result: the slow frames are classified; no change was built, because nothing found reaches the ship bar, and the code
added is measurement only** (`scripts/hitch-slow-frames.mjs`, and `frame-time-set.mjs --ff-prefs`). Three findings change the picture:
1. **The frames over 16 ms are not spikes and not the collector.** On the Island 94% of them fall in the first 20 s after the map (the census
   route's first heading), in runs of consecutive frames, and the tick leads in 66 to 88% of them on every map. Collections and uploads explain
   2 to 7% of them.
2. **The harness clock exaggerates the distance.** Playwright's Firefox rounds `performance.now` to 1 ms, so a frame of 16.4 ms reads 17 with
   probability 0.4. With `privacy.reduceTimerPrecision` off (20 us steps) the same sessions give a true p95 of **17.0, 16.6 and 17.3 ms**
   (Island, Battery Park, bunker): the true bound of 16.7 ms is 0.30, 0.00 and 0.58 ms away, and the integer "16" reading is a uniform
   **0.50, 0.14 and 0.78 ms** per frame away (below). Battery Park is already under 16.7 ms at p95 in that session.
3. **The early tick is the original's own view and time dependence.** The Node tick with render feedback is 7.4 ms and without it 2.1 ms on
   the Island; the idle Island at the authored view needs 50 s to settle. It is spread over 20 hand-backs, none over 0.4 ms.

**Reproduction** (profiles and runs in `.cache/perf/p95/`, outside Git):
* The runs: `hitch-run.mjs --browser firefox --map MAP --mode scan --seconds 60 --god [--profile FILE] [--ff-prefs '{"privacy.reduceTimerPrecision":false}']`
  (the frame-time set's command), two unprofiled sessions per map beside the set's own (`.cache/perf/frame-time-set/ff-1d1f5758`), one profiled, one
  with the 20 us clock; an idle Island session of 60 s with and without a profile.
* The classification: `node scripts/hitch-slow-frames.mjs RUN.json... [--over 16] [--profile PROFILE.json]` (new): per window and heading the frames
  over the limit, the phase furthest over its median, the runs of slow frames, the uploads, the collector markers inside the slow frames (the
  Gecko profile joined as `gecko-slow-ticks.mjs` joins it) and, on a 20 us clock, the true p95 and the shift to the allowance. The profiles were
  read with `gecko-slow-ticks.mjs`, `gecko-phase.mjs` (`--where 'p.tick>8'`), `gecko-under.mjs`; the major collections with a join of the
  profile's `GCMajor` markers.

**Where the p95 sits** (one session per map with the 20 us clock, frames from 5 s after the map; "allowed" is 5% of the frames):

| Map | frames | true p50 / p95 / p99 (ms) | over 16.7 (allowed) | 1 ms clock: frames expected to read over 16 | uniform cut for the 16 reading | for the true bound |
|---|---:|---|---:|---:|---:|---:|
| Island | 3,644 | 11.28 / 17.00 / 18.58 | 226 (182) | 283 (7.8%) | **0.50 ms** | 0.30 ms |
| Battery Park | 3,645 | 12.56 / 16.60 / 19.72 | 164 (182) | 204 (5.6%) | 0.14 ms | 0 |
| bunker | 3,600 | 10.92 / 17.28 / 23.46 | 233 (180) | 255 (7.1%) | **0.78 ms** | 0.58 ms |

A frame of d ms reads over 16 on the 1 ms clock with probability clip(d - 16, 0, 1); the "uniform cut" is the shift of every frame that brings the
expected count to the allowance. The sessions differ by about 0.5 ms from one another (Battery Park's integer sessions counted 264, 213 frames over 16 for an
allowance of 181), so the table is one draw, not a verdict.

**The classification** (frames over 16 ms on the 1 ms clock; two unprofiled sessions per map, the frame-time set's and a new one; the first number is the
set's). "Early" is 5 to 20 s after the map, which on the census route is its first heading, the authored view.

| Class | Island | Battery Park | bunker | What it is |
|---|---:|---:|---:|---|
| frames over 16 ms | 442 / 538 (12.0 / 14.7%) | 264 / 213 (7.3 / 5.8%) | 235 / 291 (6.5 / 8.1%) | allowed for p95 16: 184, 181, 181 |
| A: early window | **416 / 506** | 149 / 116 | **204 / 264** | 94 / 94%, 56 / 54%, 87 / 91% of the frames over 16; 48 / 59%, 17 / 13%, 24 / 32% of the window's frames |
| B: later, tick-led events | 26 / 32 | 115 / 97 | 31 / 27 | scripted events: Battery Park's heading 3 second half (HUD +0.6 as well) and its 42 to 46 s, the bunker's 42 to 48 s |
| of A and B, the tick leads in | 83% / 84% | 79% / 66% (A), 68% / 69% (B) | 88% / 88% (A) | the phase furthest over its median; the actors layer leads in 10 to 18%, the render pass in 7 to 12% (Battery Park) |
| C: collector in the frame | 9% hold >= 1 ms; 2% would be <= 16 without it | 16%; 7% | 12%; 3% | profiled sessions (a profile makes more frames slow: 915, 658, 482); mean in slow frames: minor 0.11 + slice 0.05 ms, 0.21 + 0.18, 0.23 + 0.40 |
| D: uploads | +0.19 ms of `gl.upload`, +0.27 MB | +0.26 ms, +0.08 MB | +0.22 ms, +0.20 MB | slow minus median-ish frames: under 5% of the excess |
| E: isolated hitches (> 25 ms) | 3 to 5 | 10 to 14 | 17 to 28 | 0.1 to 0.8% of the frames, in clusters at 40 to 43 s on all three maps (the Island's scan profile has Firefox's `FULL_GC_TIMER` major collection at 39 s: 58 slices over 2.1 s, 4 zones, largest slice 41 ms; the other two maps were not profiled there) and the bunker's at 11 to 17 s, a scripted event |

Phase excess in the slow frames of class A (ms over the median frame, mean per slow frame):

| Map | tick | actors | render | HUD | audio | other |
|---|---:|---:|---:|---:|---:|---|
| Island | **3.0** | **2.1 to 2.2** | 0.4 | 0.7 | 0.5 | |
| Battery Park | **2.1 to 2.3** | 1.0 to 1.2 | 0.9 to 1.1 | | 0.6 to 0.7 | textures 0.4 |
| bunker | **5.0 to 5.1** | 2.3 to 2.6 | 1.5 | 1.0 to 1.1 | 0.8 | sprites 0.6 |

**Clustering.** The slow frames come in runs: the autocorrelation of the slow-frame indicator peaks at lags 1 to 5 (0.5 to 0.6 on the Island and
bunker, 0.3 on Battery Park) and decays; there is no period. Per second of the run, 41 of 66 seconds on the Island hold none, 4 hold one and the other 20 hold 6 to 51. The scan route's
headings make the structure: the Island's heading 1 has 49 to 60% of its frames over 16 ms, the others 0 to 3%; the bunker's heading 1 26 to 35% (its second half 41 to 48%) and the others 1 to 3%;
Battery Park's heading 1 13 to 18% and heading 3 9 to 11% (its second half 12 to 20%).

**Why the early window is slow, in order of what was measured.**
* *The view and the five-second rule.* The idle Island at the authored view (no scan, 60 s, unprofiled): tick 8.7 ms at 5 s, 7.5 at 10 s, 7.2 at 30 s,
  6.4 at 45 s and 5.0 from 51 s; the page mean is 17 to 19 ms until 50 s and 13 after. On the scan route the heading change at 20 s drops the tick by 0.8 ms
  and the actors layer by 0.9 within a second. `actorInStasis` (actor-tick.mjs; the Rust `tick.rs` `start`) puts an actor to sleep only after 5 s without a
  render and only for `Physics` None or Rotating, or `bForceStasis`; the scripted pawns (walking) never sleep, but what a rendered pawn runs differs a lot.
* *Render feedback in Node.* `bench-sim` (idle-spot scenario, 300 warm and 600 timed ticks, Island): tick 7.57 and 7.33 ms with `--render-feedback`, 2.08 and 2.21
  without it (digests `26f13a97bdefbac1` and `4f8740c1f31a992a`); the bench stamps every drawn mesh actor, so this is the upper bound for a view. A V8 profile of
  both (the level tick 6.67 against 2.43 ms; the bench's own stamping, 0.88 ms, is outside it): the batch's `dispatch_event` 2.43 against 0.39 ms, `walk_loop` 1.58 against 0.57,
  `execAttachDecal` 0.77 against 0.02, `js_walk_prelude` 0.83 against 0.23 (ms a tick, inclusive).
* *Where the slow tick differs, in Firefox* (Gecko profile, slowest tenth of ticks minus the rest, ms a frame): Island (tick 9.79 against 6.16) JavaScript with no
  Wasm under it +0.56, Wasm +0.47, `js_eval` +0.38, `js_walk_prelude` +0.31, `js_bool` +0.20, `js_move_riders` +0.16, `js_anim_notify_event` +0.13, `js_move_hash` +0.11;
  Battery Park (8.26 against 5.46) JavaScript +0.42, Wasm +0.30, `js_tick_resume` +0.29, `js_eval` +0.20, `js_tick_physics` +0.19, `js_walk_prelude` +0.13; bunker
  (10.16 against 4.73) `js_eval` +1.40, JavaScript +0.64, `js_tick_resume` +0.37, `js_bool` +0.30, `js_object` +0.27, Wasm +0.29, `js_tick_physics` +0.23,
  `js_tick_state` +0.22. `js_tick_resume` is the JavaScript state machine (`script-state.mjs` `process`) stepping the pawns that change state: ten times more in the slow
  ticks at Battery Park and the bunker, and content. The bunker's `js_eval` is the natives its state code calls: spawns, destroys, decal attaches ([the bunker bundle](#the-bunker-bundle-2026-11-06)).
* *Not warm-up of the sim, but of the engine.* Under the level tick the innermost named JavaScript frame is in baseline code for 0.71 ms a frame in 5 to 25 s after the map
  and 0.27 in 50 to 70 s (idle Island profile; Ion code 4.92 against 4.09, native and Wasm 1.93 against 1.60). The baseline time is a long tail (no function over
  0.075 ms; `instance`, `bind`, `invokeNative`, `levelFor` and `attachedInstance` stay in baseline in the late window too), and the
  share rises again in the 35 to 45 s bins (74, 202, 303, 159 ms a 5 s bin of the idle profile); the scan profile's full collection lies at 39 s, and a collection that
  discards JIT code would do that, not verified (the idle profile's collections were not listed). A page cannot set Firefox's thresholds; the cross-map test of step 0 (Island after Wan Chai, same early ticks) stands.
* *Workload that decays.* Node's counts a tick fall 10 to 14% from 5 s to 50 s (`processEvent` 850 to 738, `invokeNative` 1,227 to 1,075; tick 22.8 to 19.7 ms with the
  instrumentation of `--tickstats --counts`), the 28 terrorists of the Island being 24% of it (190 us each at 5 s, 152 at 50 s).

**What the flat per-frame cost is** (Island Gecko profile, ms a frame, every frame, not tied to the early window; each is the kind of cut that moves the whole distribution, and the
table above says the Island needs 0.5 ms of it and the bunker 0.8): Galaxy's `Update` 0.46 (`ambientActors` 0.18 of which the Rust scan 0.08, the named reads 0.12, the batch post
to the worklet 0.07), texture animation 0.38 (`texSubImage2D` 0.25), the sky pass 0.84 and the main `renderer.render` 0.76, the player's Tick script 0.56, the HUD root tick
0.48 (JavaScript glue 0.22), the recorder's own GL wrapper and clock reads about 0.07. The object model's leaves (`instance`, `readInstanceField`, `namedHandle`, `readNamed`)
are 0.9 ms of a frame over all callers, each call a few tens of ns.

**Why nothing was built.**
* The tick's early excess is 1.5 to 3 ms spread over 20 hand-backs and the Rust core itself, none over 0.4 ms; the last step's lesson applies: Gecko charges short
  hand-backs more than they cost, and the three families built for it (`tick-tail-unshipped`: the walking prelude, PHYS_Rolling, ShowSelf; exact and verified) measured
  -0.11 ms of the Island's tick mean, -0.29 of its tenth and -0.04 / -0.19 of the page (6 pairs, standard error 0.11 / 0.34).
* The bar (0.5 ms of the slowest tenth or 0.3 of the page mean on one map, no regression on the other) is the size of the sessions' spread: nothing in the flat list is
  over 0.2 ms to remove exactly, and the actors layer, the largest early addition after the tick (2.1 to 2.6 ms), is the other worker's.
* A bundle is what would do it (the Island's 0.5 ms is the trio 0.2 to 0.3 on its early frames plus the audio scan 0.1 to 0.15 plus the actors layer), at the cost of
  re-verifying every family together; it was not started on the evidence above, and the bunker's 0.78 is not within it.

**A/B.** None was run: no change exists to compare. The measurements above stand where an A/B would, and they are single sessions (the sessions differ by 0.5 ms); the
Island's early window is reproducible (506 and 416 frames over 16 ms in the early window of two sessions, 94% of all).

**Checks.** No file under `src`, `native` or `test` changed, so `npm test` and the validators were not rerun. The six sim digests of this tree (`bench-sim.mjs --warm 60 --ticks 300
--render-feedback`) are the expected ones: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`, Wan Chai market `80d27b37e0944d88`, bunker
`764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`, no tick error; `npm run build:wasm` is warning-free. The two scripts changed are measurement: `hitch-slow-frames.mjs` ran on the
sessions above, `frame-time-set.mjs --ff-prefs` was syntax-checked and passes the preferences to `hitch-run.mjs --ff-prefs`, which the 20 us sessions used.

**What is open.**
* The two things that decide the p95 reading are the early tick (view and time dependent, Rust-core and hand-back bound) and a flat 0.5 to 0.8 ms; both are exact-work problems
  of 0.1 to 0.3 ms items. Order of the candidates, with their measured ceilings (Firefox, a frame): the walking pawns' hand-backs (prelude 0.73 in the slow tenth against 0.42; riders 0.31
  against 0.15 and hash 0.26 against 0.16 need a Rust owner of the registrations; the prelude port exists), the audio scan and reads in Rust (about 0.15), the animated textures'
  bytes (0.12, changes the shader), the JIT-tier tail (0.44, not settable).
* The frame-time set should be run with the 20 us clock (`frame-time-set.mjs --ff-prefs '{"privacy.reduceTimerPrecision":false}'` then `hitch-slow-frames.mjs`): the integer p95 of 17 hides
  that Battery Park is 0.1 ms under the bound and the Island 0.3 ms over.
* Firefox's periodic full collection at about 60 s of page time (40 to 43 s after the map) makes 10 to 25 frames of 25 to 85 ms in every session; it is outside the p95 and inside the
  slowest tenth and p99 (bunker p99 23.5 ms).
* Not measured: the Mac, headed runs, more than one 20 us session per map.

### Actors phase (2026-11-07)

The task: `p.actors` (1.78 ms Island, 1.48 Battery Park, 1.75 bunker in the frame-time set on master 7e501a2a) is the second phase after the tick, and the
Island, Battery Park and the bunker sit at a page p95 of 17 ms, one step over 16.7. Re-rank the phase on those three maps, port the largest families
exactly, and ship if an interleaved Firefox A/B takes 0.3 ms off the page mean or 0.5 ms off the slowest tenth on one of the two scan maps without
regressing the other. **Result: the bar is not met. The phase has no family left that is worth a port: its two large parts are the original OccludeBsp
pass in Rust (which is the algorithm) and the drawn bindings' update, and everything the Dockyard ranking named is now 0.00 to 0.06 ms.** The two
ports that the ranking supports (about 0.05 ms between them) are exact and are on branch `actors-phase-unshipped` (`ad271713`); this section is the only change on the
worktree branch. Everything below is headless Linux (Firefox 155 inline, 1440x960, god mode, pinned to `taskset -c 4-7,12-15`, one heavy job at a time); the Mac is not measured.

**Ranking** (Gecko profile of a Firefox inline session on master 7e501a2a: `hitch-run.mjs --browser firefox --profile`, Island and bunker `--mode scan --god`
40 s, Battery Park `--mode idle --god --place '{"location":[2025,-3396,263],"rotation":[0,32768,0]}'` 30 s; read with `gecko-phase.mjs --entry '^actors \(src/viewer/sim-session'`
from 5 s after the map, 1 ms samples; the profiler inflates the host by about a fifth, so this ranks and does not A/B; ms a frame, inclusive):

| Part | Island | bunker | Battery Park |
|---|---:|---:|---:|
| `p.actors` / `w.actors` of the profiled run (all drawn frames) | 1.93 / 1.64 | 1.93 / 1.73 | 2.25 / 1.94 |
| the `actors` step (simulation half) | 1.59 | 1.69 | 1.63 |
| `occludeMain` | 0.90 | 1.10 | 0.86 |
| - the OccludeBsp pass in Rust (`occ_run`), its own wasm | 0.47 | 0.50 | 0.49 |
| - the child frames' SetupDynamics, script callbacks out of that pass (`occ_frame_dynamics`: the laser and particle iterators' rescans) | 0.12 | 0.23 | 0.09 |
| - JavaScript around the pass (`packDynamics` 0.04 / 0.06 / 0.03, output decode 0.03, Setup 0.03, detail block 0.01 to 0.03, decal block 0.02 / 0.06 / 0.03, `lightFramesOf` 0.02, ...) | 0.31 | 0.37 | 0.28 |
| the bindings' update (`updateBindings`) | 0.43 | 0.34 | 0.56 |
| - SetupForActor lighting (`lightFrame`) | 0.20 | 0.14 | 0.26 |
| - `planGpu` | 0.07 | 0.04 | 0.09 |
| `meshReads` (the roster's Rust pass) / `reconcile` / weapons | 0.07 / 0.05 / 0.06 | 0.06 / 0.06 / 0.05 | 0.07 / 0.04 / 0.04 |
| the page's half (`apply`: the GPU mesh pass, texSubImage2D 0.07 of it) | 0.26 | 0.19 | 0.26 |
| `membership` (script-vm-meshlight), `newScope` with its `itemKey`, `drawItems`, `drawExtras`, `retire`, `compactRecords` | 0.00 each | 0.00 each (`admit` 0.01) | 0.00 each |

The rows the Dockyard ranking carried to the next pass are not in these maps' profiles: Level.Actors is not rewritten in most frames here, so the light-membership rebuild
does not register (0.00), the few iterator items (lasers, particles) make `newScope` and `itemKey` 0.00, and the bulk passes of [Actors layer in bulk](#actors-layer-in-bulk-2026-11-06) made `reconcile` 0.04 to 0.06.
Inside the pass (wasm names from a non-stripped build, `wasm-names.mjs`; self time under `visibility`): `occlude` 0.31 / 0.34 / 0.33, `SpanBuffer::copy_from_raster` 0.08 /
0.08 / 0.07, `occ_setup` 0.02 / 0.03 / 0.04, `setup::rotate` 0.02 / 0.02 / 0.03, `bound_visible_box` 0.02 / 0.03 / 0.03, `SpanBuffer::merge_with` 0.02, `detail_run` 0.02.
A V8 CPU profile of the same pass in Node with the pass' helpers marked `#[inline(never)]` in a scratch build (not committed; Island roaming, 660 frames,
`node --cpu-prof`, 1.01 ms a frame under `occ_run`) splits `occlude` further: its own body 0.26, `clip_bsp_surf` 0.20, `copy_from_raster` 0.12, `rasterize` 0.06,
`filter_chunks` 0.04, `bound_visible_box` 0.03, `detail_run` 0.03, `merge_with` 0.03, `occ_setup` 0.02, `rotate` 0.02, `setup_sprites` 0.02. These are the original's polygon clip, span and BSP loops,
already one pass of straight Rust at `opt-level = 3` with LTO, bulk memory and saturating conversions on; nothing in them is host plumbing, and there is no `perf` or `wasm-opt` on this host to go below function level.

**The slowest tenth is the same code, with more of it.** In the profiled runs the slowest tenth of page frames has `p.actors` 3.50 (Island), 3.65 (bunker), 2.61 (Battery Park)
against 1.93, 1.93, 2.25. The Island's frames with `p.actors` over 3 ms (the `actors` step 2.81 against 1.59): `occlude` 0.79 self (0.31), `copy_from_raster` 0.17 (0.08), the bindings' update 0.77 (0.43; lighting
0.37 against 0.20: more drawn actors, more of the same per-actor work), Minor GC 0.05. The bunker's (3.70 against 1.69): `occlude` 0.55, and a Major GC mark slice of 0.56 ms landing in the
phase (0.03 on average). Nothing in the slow frames is a spike of one function; the view has more geometry and more drawn actors in it.

**What the long tail is.** The JavaScript left in the simulation half is about 1.0 ms of the Island's 1.59, in pieces of 0.01 to 0.07 ms, none from a loop over the ~500 bindings any more
(`updateBindings` itself 0.02 self, `isPawn` over all bindings 0.01, `rosterReads` 0.06 and `admitScan` 0.05 are Rust). Reads of actor fields through `readNamed` add up to 0.11 ms at
the Island but come from a dozen callers (`lightRecord` 0.015, the sprite scan's `read` 0.011, `finishSetup`'s ambient reads 0.007, `readLaserState` 0.006, `zoneSkies` 0.005, ...).
Allocation in the step is 268 KB a frame (`frame-alloc-meter.mjs --sites`): `readComposite` 24, `decode` 17, the laser reads 18, `updateDrawn` 8, no site above 24 KB.

**What changed** (each body is kept behind `?actorTail=js|verify`, `ACTOR_TAIL=` in Node; default `on`; `src/viewer/actor-tail.mjs`, listed in main.mjs' switch list):
* **`candidateWords`** (dynamics-candidates.mjs): the root frame's packed SetupDynamics candidates, kept for the child frames' `patchDynamics`, were a `.slice()` of 25 to 30 KB at every
  occlusion run (0.022 ms a frame in the Firefox profile at the Island and the bunker, an off-heap typed array each time). They are copied into a scratch kept per call site (`slot`: the main frame's run, a
  viewport window's planning) and handed out as a view of exactly their length; the child frames read them and nothing keeps them past the run (`verify` compares each with a fresh slice).
* **`permeatingRun`** (mesh-lighting-view.mjs): a BSP leaf's permeating static lights as handles (`exportName`, the name map's lookup and `handleOf` per light) were made again for
  every leaf of every frame (0.03 to 0.05 ms in `rustSetup`). They are kept across frames while the model, the actor name map object and `actorsEpoch()` are the ones they were made for (the
  bound `levelMembership` itself uses); `verify` makes the run again at every reuse and compares refs and handles.

**Evidence for fidelity.** Neither body touches the simulation or any original-game computation (they change how the host holds a copy and a lookup), so the check is the output:
* The six `bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback` digests are unchanged: Island `5adb254a07b1ed6f`, Training `07816ec472f29b84`, Airfield `46ed0d32ae5b56af`,
  Wan Chai market `80d27b37e0944d88`, bunker `764a7bdffd2ebe59`, Dockyard `e53f348673f1247b`.
* `frame-alloc-meter.mjs` (every snapshot hashed with its numbers' exact bits, 300 frames, warm-up 60): the reference bodies (`ACTOR_TAIL=js`) write the hashes and `ACTOR_TAIL=verify` and
  the defaults `--compare` against them: identical on the Island (`5e021f24dcd1a8ed`), bunker (`e79f8ee485bbfd2a`), Battery Park (`2619df1a6eed0e52`), Airfield (`a04d154da0b6a1a0`) and Dockyard
  (`35a4f60ce160360e`), with no `verify` error. (The Island and Airfield digests are the ones the previous section recorded; Battery Park and Dockyard have moved with later commits.)
* Validators (`run-validators.mjs --jobs 1 --filter`, one at a time): actor-mesh-scene, gpu-mesh, bsp-occlusion, spawn-mesh-binding, npc-mesh-preview, umesh-play, sprite-setup, play-frame,
  first-draw-pose, lodmesh-lod-play, dynamic-light-mover, brush-tracker, leaf-lights, mesh-lighting, mesh-light-types: 18 passed, 0 failed (the last two filters match two validators each).
* In the browser: `validate-mesh-path-frames.mjs --frames 90 --query '&actorTail=verify' --plumbing` PASS (the Paris club's mirrors, 1280x720 identical); `validate-sim-split.mjs --draw-state --pixels --query-b 'actorTail=js'`
  PASS in worker mode and with `--query 'sim=inline'` (Island, 240 frames, 4 digests, every binding's draw state and the pixels equal); Firefox inline sessions with `actorTail=verify`
  (`hitch-run.mjs --browser firefox --mode scan --god --seconds 40 --query actorTail=verify`): Island 2,623 drawn frames, bunker 2,664, no page error, so no `verify` throw.
* `npm test` on the branch's tree: 983 tests, 979 passed, 4 skipped, 0 failed. No Rust changed, so `npm run build:wasm` is as warning-free as it was.

**A/B** (`hitch-ab.mjs --guard --cpus 4-7,12-15 --arms "tail:,js:actorTail=js" --pairs 6 -- --browser firefox --map M --mode scan --god --seconds 60`, the arms' order alternating, six pairs a map;
`.work/ab-pairs.mjs` for the paired figures; ms; the `/` is the defaults against `actorTail=js`):

| Map (6 pairs) | | `p.actors` | `w.actors` | tick | page mean | page slowest tenth |
|---|---|---:|---:|---:|---:|---:|
| Island, scan route | tail / js | 1.80 / 1.84 | 1.52 / 1.56 | 5.91 / 5.87 | 12.66 / 12.68 | 18.72 / 18.70 |
| | difference (se; pairs lower) | -0.03 (0.01; 5 of 6) | -0.04 (0.01; 6 of 6) | +0.05 (0.05; 2 of 6) | -0.02 (0.09; 4 of 6) | +0.02 (0.41; 4 of 6) |
| Area 51 bunker, scan route | tail / js | 1.71 / 1.73 | 1.51 / 1.53 | 4.71 / 4.82 | 11.68 / 11.79 | 19.82 / 19.20 |
| | difference (se; pairs lower) | -0.02 (0.03; 4 of 6) | -0.02 (0.03; 3 of 6) | -0.11 (0.10; 4 of 6) | -0.10 (0.19; 4 of 6) | +0.61 (0.71; 2 of 6) |

By pair (tail minus js): Island `p.actors` -0.02, -0.07, -0.03, -0.02, -0.07, +0.01; page mean -0.05, -0.11, -0.15, +0.08, -0.23, +0.35; slowest tenth 0.00, -0.21, -0.78, +0.09, -0.89, +1.91.
Bunker `p.actors` -0.10, +0.07, +0.08, -0.09, 0.00, -0.07; page mean -0.34, +0.68, +0.13, -0.34, -0.14, -0.62; slowest tenth -1.10, +3.54, +0.70, +1.38, +0.14, -0.98. Page p95 (whole ms), tail / js by pair:
Island 18/18, 18/19, 18/18, 18/17, 18/19, 19/18; bunker 17/18, 19/17, 17/17, 18/17, 17/17, 18/18.

Ship bar (0.3 ms off the page mean or 0.5 ms off the slowest tenth on one of the two maps, no regression on the other): **not met**. The phase figures move by what the profile said
they would (`w.actors` -0.04 ms, every Island pair), and the page figures do not separate from the sessions' noise (the Island's slowest-tenth difference has a standard error of 0.41 ms).
The code is therefore not on this branch: `actors-phase-unshipped` carries `actor-tail.mjs`, the two bodies and the switch.

**What is still open** (ms a frame, Firefox, profiled; a port's ceiling is its whole row, and none is likely to be cut whole):
* **The OccludeBsp pass itself**, 0.47 to 0.50 ms and 0.8 to 1.0 in the slow frames: `occlude` 0.31 to 0.34, `copy_from_raster` 0.07 to 0.08. It is the original's loops; a cut needs a line-level
  profile of the wasm (counters in a scratch build, or a tool this host lacks) and is bit-exact work on `occlude.rs`.
* **The child frames' iterator rescans**, 0.09 to 0.23 (bunker): original script runs through the VM. At the bunker 0.05 of them is `js_bool` for `0x2d(0x36:bool(0x1a))` (a `bool` member of a
  struct-array element, eight per laser iterator's `Init`, 38 a frame) and each `Init` reads `Outer` in JavaScript; lowering those two nodes is VM compiler work (script-vm-lower.mjs), not this layer's.
* **The glue around the pass**, 0.28 to 0.37, in pieces: `packDynamics` 0.03 to 0.06, output decode 0.03 (17 KB of arrays a frame), the detail and decal blocks 0.04 to 0.09, Setup 0.03, `lightFramesOf` 0.02.
* **SetupForActor's bookkeeping**, 0.14 to 0.26 of the bindings' update: the Rust selection (`select`) is 0.03 to 0.04; the rest is `lightRecord` field reads, `finishSetup`, `setupAmbient`, the per-leaf moving-light lists
  (`get` 0.03 to 0.05) and `lodMeshCameraMatrix` 0.02 to 0.04.
* **`planGpu`** 0.04 to 0.09 (`planLodMeshFrame`, `frameContext` 0.03) and the page's `uploadDirty` (texSubImage2D 0.07).

### Unshipped bundle (2026-11-07)

The task: the Island, Battery Park and the bunker sit at a Firefox inline page p95 of 17.0, 16.6 and 17.3 ms on a 20 us clock ([Firefox p95
frames](#firefox-p95-frames-2026-11-07)); five branches held exact, verified families that each measured under the ship bar alone. Combine them on
master ff493674, add two small items, and measure the bundle as a whole (headless Linux, Ryzen 9 8945HS, Firefox 155 inline 1440x960, god mode,
`taskset -c 4-7,12-15`, one heavy job at a time under the lock; the Mac and headed runs are not measured). **Result: the bundle meets the ship bar and is on this branch.** Against the same tree with every switch at its old behavior (6 pairs a map, interleaved) the Island's page mean is **-0.62 ms** and
its slowest tenth **-0.79 ms** (every pair lower), the bunker's page mean -0.52 and Battery Park's -0.40; no map is worse beyond its noise. Against the master snapshot the net gains are smaller (Island -0.34, bunker -0.10,
Battery Park -0.51 ms of page mean, each with an error of 0.2 in 4 pairs). **The Island's true p95 stays at 17.0 ms, 0.3 ms over 16.7**; the bunker's (16.6) is at the bound and Battery Park's (15.3) under it. Two of the five
branches had nothing left to take (`bunker-cuts-unshipped` and `import-cuts-unshipped` are on master already), and the fog tile bands were left out. Two small items were built: the BSP selector's index regions and Galaxy's ambient scan
in Rust. One finding of the exactness pass was fixed: the walking prelude's fast answer moved host handle numbers (below).

**What went in** (each default on, with its old behavior one switch away and a verify mode where the family had one; the page's `?name=` reaches the
simulation through the switch list in main.mjs, `NAME=` in Node):

| Switch (`?flag=`, env) | Family | Old behavior | Source |
|---|---|---|---|
| `walkPrelude` `js` `verify` | the walking surface prelude up to the scan (Rust makes the scan inputs; the host answers 1 when the prelude would return false having changed nothing) | every prelude in JavaScript | `tick-tail-unshipped` d8d74a4e |
| `rollingPhysics` `js` `verify` | PHYS_Rolling of a non-Pawn on the image (fall.rs `perform_rolling`) | `rolling.mjs` | same |
| `showSelf` `js` `verify` | the player's ShowSelf pawn-list walk (showself.rs) | JavaScript walk | same |
| `actorTail` `js` `verify` | the root frame's candidate words in a kept scratch; permeating light runs kept across frames | `.slice()` / rebuilt per frame | `actors-phase-unshipped` ad271713 |
| `lightModulation` `table` | class 1 light modulation entries made when a merge reads them | the whole 3 x 65,536 tables each frame | `batterypark-unshipped` 1df307a3 |
| `lightPack` `js` `verify` | the changed region's atlas words made by `light_pack` (simd128) and copied a row at a time | `LightAtlas.update`'s byte loop | same |
| `uploadBands` `off` | the light atlas' rectangles side by side sent as one (`upload-bands.mjs`) | one `texSubImage3D` per rectangle | same |
| `indexRegions` `single` `verify` | **new**: one index buffer per world mesh with a region per node set the BSP selector has drawn lately | the one region, rebuilt when the set differs from the previous select's | this step |
| `ambientScan` `js` `verify` | **new**: Galaxy Update's ambient scan with its range test in Rust (render.rs `ambient_scan`) | `ambientActors` and the per-actor reads and `ambientInRange` | this step |

**What was dropped, and why.**
* **The fog tile bands** of 1df307a3 (`fog-pass.mjs`, `docs/volumetric-fog.md`'s paragraph): `p.fog` +0.08 ms, 0 of 9 pairs lower in its own A/B (90 sparse tiles pay for
  the gap bytes). `upload-bands.mjs` is the helper of the light atlas alone here.
* **The same commit's world-root matrix walk (`sceneWalk`) and the mover shortcut in `world-visibility.mjs`**: both are on master already (the cherry-pick's conflicts
  in `world.mjs` and `main.mjs` were that text; the master text was kept).
* **`bunker-cuts-unshipped` (377a1dd3, 30f851fa) and `import-cuts-unshipped` (b1f7e186): every item is on master already, nothing was taken.** `git cherry master` lists
  377a1dd3 and 30f851fa as present; the merged [bunker bundle](#the-bunker-bundle-2026-11-06) (c73abe2d) carries `RIDER_TABLE` (base-epoch.mjs `cellEpoch`,
  `moveBaseSlot`, `cutBaseSlots`), `COMPACT_SCAN` (level.rs `level_flagged`), `SOUND_READ` (script-runtime.mjs `reflectedField`), `DECAL_FOLLOW` (decal-kernel.mjs),
  `CONFIG_FIND`, `INPUT_FIELDS`, and `PLAYER_PAWN` as the Rust cell (`rust` default, `direct` the old `js_object` answer b1f7e186 added), each with its switch in
  main.mjs. b1f7e186 is the older form of the same rider table and `GetPlayerPawn` shortcut.
* The families' own notes came with their commits: `docs/rolling.md`, `docs/walking.md` and `docs/static-lighting.md` (the last two gained a paragraph each in this step: the bands, and the handle numbering).

**The two new items.**
* **`indexRegions` (world-visibility.mjs).** The main pass and the root sky pass select different node sets, and a mesh's one index buffer was rebuilt whenever
  a select's set differed from the previous select's: two rebuilds and their index uploads every frame (the [Battery Park section](#battery-park-at-rest-2026-11-07)'s
  "What is open": 2 rebuilds, 18 uploads at rest). Each world mesh now holds three regions (`REGIONS`) in one `BufferAttribute`; the selector keeps the node set each was
  built for, and a select whose set a region holds draws that region through `drawRange.start` and rebuilds and uploads nothing; a new set takes a free region or the one
  drawn longest ago. One index object per mesh, not one per pass (a second object would make three.js set up the vertex array object twice a frame). A rebuilt region's
  range is *added* to the attribute's pending update ranges (one per region start, replaced in place): three.js uploads an attribute only when a mesh is drawn and clears
  the ranges then, so clearing them at the next rebuild, as the one-region code did, would leave a region built while its mesh was culled stale on the GPU for the pass that
  hits it later (`test/world-visibility.test.mjs` builds a GPU copy from the pending ranges and fails with `clearUpdateRanges` back in). Exactness (host drawing, no original
  behavior): a region holds the indices a rebuild writes, `3t, 3t+1, 3t+2` for the mesh's triangles in order whose node is in the set; `?indexRegions=verify` rebuilds the
  indices of every select's set aside and compares each mesh's drawn range value by value (Firefox: 370,904 mesh ranges on the Island, 378,140 at the bunker, 393,236 at
  Battery Park, no difference; the three sessions made 9, 60 and 25 rebuilds in about 5,300 selects). `validate-sim-split --draw-state --pixels --query-b indexRegions=single`
  passes in worker mode and inline (Island, 240 frames, same pixels).
* **`ambientScan` (render.rs `ambient_scan`, script-audio-live.mjs `ambientNear`, galaxy-audio.mjs).** Galaxy Update's ambient scan took every actor with a live
  AmbientSound from the render scan (`ambientActors`: 107, 108 and 65 actors on the Island, the bunker and Battery Park, `measured()` on each), then read `AmbientSound`, `Location` and `SoundRadius` of each
  through `readNamed` and decided `ambientInRange` (the doubles screen with the extended fallback), and only a handful pass (3,233 in reach in 360 Island scans: 9 a scan; 8 at the bunker, 9 at Battery Park).
  `ambient_scan` does the same in one walk in Rust, from the image: the AmbientSound pointer, then Location and `SoundRadius` (a new render field, 51) and
  `galaxy::ambient_in_range`, the transcription of `ambientInRange` (the same operations on the same float32-as-double values in the same order; its fallback is the body
  `galaxy_in_range_exact` already had), writing only the actors in reach, in array order; an actor whose fields the image does not answer is written as `RENDER_JS` and the host
  reads and tests it as before. The update loop skips the three reads and the test for a decided actor and reads them only when it needs a channel for it (the same reads, made once;
  Update changes nothing in the world). Only the host's `notes` differ: an actor out of reach without a measured index is no longer noted. `?ambientScan=js` keeps `ambientActors` and the
  per-actor reads; `=verify` runs the full scan beside the Rust one and compares the lists and the decisions. Exactness: `scripts/audio-channel-digest.mjs` (new: the channel table's
  id, sound, volume, radius, pitch, priority, time, occlusion and location with exact bits after each frame of a fixed roam) is identical in `js`, `rust` and `verify` on the Island
  (`d097f0fb1d8d8a60`), the bunker (`7516d16de5345b06`), Battery Park (`5416b07d39ea50ed`), the Paris metro (`968983062887e4d8`), the Wan Chai market (`4042b7f8a6a7afbf`) and
  Training (`bf476008ddc7e57e`), 300 to 400 frames each, `verify` compared 3,233, 3,707, 4,140, 644, 3,283 and 0 decided actors; `validate-galaxy-audio-kernel` now also compares the
  core's decision (`galaxy_in_range`, exported for it) with `ambientInRangeExact` over its 20,008 range cases (values at, around and far from the radius, within 1e-12 of it, non-finite).
  Not reached by any of the roams: an actor handed back as `RENDER_JS`, and a decided actor whose AmbientSound reads falsy (the loop keeps the old test for both).

**A finding of the exactness pass: the walking prelude's fast answer moved the handle numbers.** `frame-alloc-meter.mjs` digests (every field of the posted frame snapshot) were
the master tree's on the bunker, Battery Park, the Airfield and the Dockyard and not on the Island (`2416e922a1f9ef7e` against `5e021f24dcd1a8ed`); `WALK_PRELUDE=js` alone restored
it, and the new `--keys` and `--dump` options of the meter found the difference in `events` (the posted `mesh-create` records, 20 of 300 frames), in one field: an actor's
`handle` (Fish0: 13177 against 13178). The skipped WalkTexture dispatch used to be where a floor texture got its object handle (`handleOf` allocates at first use), so every handle made
after it was one lower. Handles are host identifiers (no original meaning; `bench-sim` digests carry none), but the digests are the harness' evidence, so `scanFast` now asks
for the texture's handle when it answers 1 ([walking.md](walking.md#the-surface-prelude-in-rust-up-to-the-scan-2026-11-07)); all five meter digests are then the master tree's.
The A/B below was run again on the final tree after that change (the first, on the tree before it, is in the second table of each map).

**A/B** (Firefox inline, headless, `hitch-ab.mjs --guard --cpus 4-7,12-15 --arms "new:,old:<every switch above at its old behavior>" --pairs 6`, the arms alternating, the frame-time set's
session shape `--mode scan --seconds 60 --god` with `--ff-prefs '{"privacy.reduceTimerPrecision":false}'` (the 20 us clock), frames from 5 s after the map; "new" is the defaults on the final
tree, "old" is `walkPrelude=js&rollingPhysics=js&showSelf=js&actorTail=js&lightModulation=table&lightPack=js&uploadBands=off&indexRegions=single&ambientScan=js`; `.work/ab-agg.mjs`
for the paired figures, ms; "true p95" is the 95th percentile of the 20 us page frame; the `/` is new / old; the second line of a map is the difference with the standard error of the
pair differences and the pairs where new was lower):

| Map (6 pairs) | | page mean | slowest tenth | p50 | true p95 | frames over 16.7 | `p.tick` | `p.render` | `p.audio` | `p.lightAnimation` + `p.lightUpload` |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Island, scan route | new / old | 11.88 / 12.50 | 17.60 / 18.39 | 11.08 / 11.63 | 17.01 / 17.90 | 247 / 450 | 5.60 / 5.81 | 1.49 / 1.66 | 0.24 / 0.42 | 0.16 / 0.16 |
| | difference | **-0.62** (0.14; 6 of 6) | **-0.79** (0.24; 6 of 6) | -0.54 (0.11; 6) | -0.89 (0.25; 6) | -204 (61; 6) | -0.20 (0.06; 6) | -0.17 (0.03; 6) | -0.17 (0.00; 6) | 0.00 |
| Area 51 bunker, scan route | new / old | 11.03 / 11.55 | 18.38 / 18.80 | 10.12 / 10.59 | 16.61 / 16.70 | 177 / 187 | 4.61 / 4.73 | 1.17 / 1.29 | 0.24 / 0.40 | 0.46 / 0.55 |
| | difference | **-0.52** (0.13; 6 of 6) | -0.42 (0.51; 4) | -0.47 (0.14; 6) | -0.09 (0.32; 3) | -11 (18; 3) | -0.11 (0.09; 4) | -0.13 (0.02; 6) | -0.16 (0.00; 6) | -0.09 (light animation -0.10 in 6 of 6, upload +0.01 in 0 of 6) |
| Battery Park, scan route | new / old | 12.32 / 12.72 | 16.49 / 17.29 | 12.06 / 12.32 | 15.33 / 16.31 | 90 / 145 | 4.92 / 4.97 | 1.85 / 1.95 | 0.32 / 0.42 | 0.73 / 0.90 |
| | difference | -0.40 (0.17; 5 of 6) | -0.79 (0.42; 4) | -0.26 (0.13; 5) | -0.98 (0.33; 5) | -55 (24; 5) | -0.05 (0.04; 5) | -0.10 (0.06; 5) | -0.09 (0.01; 6) | -0.17 (-0.13 and -0.04, 6 of 6 each) |

Pair differences (new - old), page mean: Island -0.32 -0.68 -0.38 -0.68 -1.27 -0.40; bunker -0.11 -0.36 -0.75 -0.93 -0.24 -0.73; Battery Park -0.51 -0.41 -0.49 -0.80 +0.38 -0.57. Slowest tenth: Island -0.57 -0.95
-0.44 -0.42 -1.94 -0.42; bunker +0.35 +1.75 -0.81 -0.86 -1.40 -1.55; Battery Park -0.85 +0.09 -1.41 -2.23 +0.65 -1.00.

The same A/B on the tree before the handle change (first run; same arms, same shape, 6 pairs, the Island's fifth old session lost to a Firefox content-process crash at load, 5 pairs): page mean
Island **-0.60** (0.14; 5 of 5), bunker -0.53 (0.12; 6 of 6), Battery Park -0.60 (0.16; 6 of 6); slowest tenth -1.10 (0.26; 5), -0.16 (0.64; 5 of 6), -1.18 (0.32; 5 of 6); true p95 17.07 / 18.04, 16.60 / 17.03,
14.75 / 15.97; frames over 16.7 264 / 486, 172 / 205, 62 / 132. The two runs agree within their errors on every map, and the tick, render and audio phases move as above in both.

**Against the master snapshot** (the tree of ff493674 extracted beside this one, four interleaved pairs per map, the same session shape; `.work/ab-master.sh`; ms; new / master): Island page mean
12.06 / 12.39 (**-0.34**, 0.22; 3 of 4), slowest tenth 18.00 / 18.26 (-0.26, 0.53), true p95 17.28 / 17.88 (-0.60, 0.32; 4 of 4), frames over 16.7 292 / 441; bunker 11.27 / 11.38 (-0.10, 0.24; 3 of 4),
18.42 / 18.76 (-0.34, 0.89), 16.69 / 16.81 (-0.12, 0.44), 180 / 196 (its tick +0.19, 0.14, 1 of 4 lower: the bunker's tick sessions differ by 0.2 ms from one another); Battery Park 12.31 / 12.81 (**-0.51**, 0.17;
3 of 4), 16.38 / 17.57 (-1.19, 0.22; 4 of 4), 15.37 / 16.19 (-0.83, 0.58), 90 / 143. These sit inside the new-against-old figures' errors but are smaller on the Island and the bunker, and four pairs carry
an error of 0.2 ms: the bundle's net gain over master is about 0.3 to 0.5 ms of page mean on the Island and Battery Park and not distinguishable from 0 on the bunker. A single session differs by about 0.5 ms from another in its p95 (the master snapshot's true p95 reads 17.88, 16.81 and 16.19 here, and 17.00, 17.28 and 16.60
in [Firefox p95 frames](#firefox-p95-frames-2026-11-07) for the Island, the bunker and Battery Park), so the absolute p95 figures belong to the session they were taken in.

**Ship bar** (page mean -0.3 ms or slowest tenth -0.5 ms on one of the maps, no map worse beyond its noise): **met** on the Island (-0.62 and -0.79 against the same tree's old behaviors, every pair lower) and,
on the page mean, on the bunker (-0.52) and Battery Park (-0.40); nothing is worse beyond its noise (the bunker's and Battery Park's p99 and `p.lightUpload` +0.01 at the bunker are inside it). The bundle is therefore on this branch.
**The Island is not under the bound**: its true p95 is 17.0 ms (0.3 ms over 16.7) and 247 of 3,650 frames are over 16.7 where 182 are allowed; the bunker's true p95 is 16.6 (at the bound, 177 of 3,600 frames over where 180 are
allowed); Battery Park's is 15.3. By phase, what moved (new - old on the Island, `p.` columns of the hitch log): the tick -0.20 (the walking prelude, ShowSelf and
rolling), the three.js passes -0.17 (the index regions; -0.13 and -0.10 at the bunker and Battery Park), Galaxy's Update -0.17 (the ambient scan: 0.42 to 0.24 ms a frame; 0.40 to 0.24 at the bunker, 0.42 to 0.32 at
Battery Park), the actors layer -0.06 (`actorTail`), and at the bunker and Battery Park the class 1 light maps -0.09 and -0.17 (`p.lightAnimation` -0.10 and -0.13, `p.lightUpload` +0.01 and -0.04). The Gecko
profiles of the earlier sections charged these families 0.4 to 0.6 ms (the trio) and 0.3 (the audio scan); the A/B finds -0.20 for the whole trio and -0.17 for the audio scan, the same order for the
audio and a third for the trio.

**Exactness evidence** (the final tree, `8606187b` and the commit of this section on top; every run under the heavy lock, each family also in its own section above):
* The six `bench-sim.mjs --map NAME --warm 60 --ticks 300 --render-feedback` digests are the expected ones, with no tick error: Island `5adb254a07b1ed6f`, 00_Training `07816ec472f29b84`, 03_NYC_Airfield
  `46ed0d32ae5b56af`, 06_HongKong_WanChai_Market `80d27b37e0944d88`, 15_Area51_Bunker `764a7bdffd2ebe59`, 09_NYC_Dockyard `e53f348673f1247b`; also with `WALK_PRELUDE=verify ROLLING_PHYSICS=verify SHOW_SELF=verify` on the
  Island, Wan Chai and the bunker. **Battery Park** (`--scenario scripts/scenarios/idle-spot.mjs`, same options): `a465f2c1fa7b58e8`, with the bundle, with the three tick switches at `verify`, and on the unmodified master
  snapshot ff493674; the brief's `ec87274562d24df6` does not come out of master with these options (with `--idle` it is `8bfe45203405e675`), so it belongs to another configuration, and the
  comparison that counts, bundle against master, is equal.
* The four combat replays (`PER=77 ... --ticks 300 --render-feedback --idle --seed 1 --scenario scripts/scenarios/combat-replay.mjs`, `PLACES=.cache/perf/spot-census/firefox-10_Paris_Metro.places.json` on `10_Paris_Metro`,
  `firefox-12_Vandenberg_Cmd.places.json` on `12_Vandenberg_Cmd`): FROM=0 TO=55 `--warm 4208` `09e2d44972cca30a`, FROM=54 TO=55 `--warm 48` `a6011ede7236c1d2`; FROM=0 TO=99 `--warm 7596` `ed184bd3eb533bc1`,
  FROM=98 TO=99 `--warm 48` `1db79eb398240a97`.
* `frame-alloc-meter.mjs` (every field of the posted frame snapshot with its numbers' exact bits, 300 frames, warm-up 60): the bundle's digest equals the master snapshot's on all five maps (Island `5e021f24dcd1a8ed`,
  bunker `e79f8ee485bbfd2a`, Battery Park `2619df1a6eed0e52`, Airfield `a04d154da0b6a1a0`, Dockyard `35a4f60ce160360e`), and `ACTOR_TAIL=js` (written) against the defaults and `ACTOR_TAIL=verify` (compared) are identical on each. The
  Island's first bundle run was `2416e922a1f9ef7e`; see the handle finding above.
* `moving-lights-bench.mjs --map 02_NYC_BatteryPark --place 2025,-3396,263 --yaw 32768 --frames 240 --hash --anim`: the moving light maps' floats (`a6228e218c1f5a65`) and the atlas pages (`38dc1b9caa96cfc4`) are equal in
  `LIGHT_MODULATION=table LIGHT_PACK=js`, `LIGHT_MODULATION=lazy LIGHT_PACK=rust` and `LIGHT_PACK=verify`.
* Firefox inline sessions with every verify switch on (`hitch-run.mjs --browser firefox --mode scan --god --seconds 40 --probe-switches --query 'walkPrelude=verify&rollingPhysics=verify&showSelf=verify&actorTail=verify&lightPack=verify&indexRegions=verify&ambientScan=verify'`,
  the counters read with `--eval` from `deusExVerifyCounts` and `deusExViewer`): the Island 2,586 drawn frames, the bunker 2,675 and Battery Park 2,631, **no page error and no `verify` throw**. Compared: walking preludes 34,543 (Island), 8,442 (bunker), 17,351
  (Battery Park), ShowSelf scans 50,225, 14,306, 35,891 (148,303, 31,630 and 78,379 pawns skipped), ambient decisions 15,672, 14,354, 23,913, index ranges 370,904, 378,140, 393,236, light atlas regions at the two light maps 13,402 (bunker) and 53,421 (Battery Park), 0 differing. No rolling call
  ran in these sessions (0 of 0; the papers' timing, as in the tick section), so rolling is covered by Node: `validate-actor-physics-kernel` with `scripts/scenarios/rolling-branches.mjs` and `validate-native-rolling`. A Chromium **worker** session with the same switches (40 s each, the Island 2,658 drawn frames and the bunker 2,660): `processProbe().switches` lists
  all seven in the simulation realm and neither page logs an error.
* Validators, one at a time (`run-validators.mjs --jobs 1 --filter`: 51 validator runs passed, 0 skipped, 0 failed, with the filters matching more than one script and 10 of them repeated after the handle change): the tick families' `actor-physics-kernel` (also again after the handle change), `native-rolling`, `walk-loop-kernel`,
  `walk-loop-branches` (again after it), `pawn-physics-kernel`, `native-walking-surface`, `native-walking-callbacks`, `plant-push`, `native-swimming`, `pawn-swimming-reach`, `pawn-tick-visibility`; the lighting families'
  `light-animation-rust`, `light-atlas-upload` (Chromium at Training and Battery Park, Firefox at Battery Park: 17,451 dirty rectangles in 1,069 calls and 20,320 in 1,431, GPU layers equal the CPU pages), `mesh-lighting`, `mesh-light-types`,
  `leaf-lights`; the actor layer's `actor-mesh-scene`, `gpu-mesh`, `bsp-occlusion`, `spawn-mesh-binding`, `npc-mesh-preview`, `umesh-play`, `sprite-setup`, `play-frame`, `first-draw-pose`, `lodmesh-lod-play`, `dynamic-light-mover`,
  `brush-tracker`, `world-batches`, `page-movers-play`; the audio's `galaxy-audio-kernel` (20,008 range cases), `native-galaxy-audio`, `galaxy-effects` (the filter matches three), `galaxy-volumes`, `galaxy-reverb`, `native-client-hear-sound`;
  and `script-vm-interp` (the render field table grew to 52 fields). Beside them: `validate-sim-split.mjs --draw-state --pixels --query-b indexRegions=single` in worker mode and inline, and with `--query-b` set to
  *every* bundle switch at its old behavior: PASS each (Island, 240 frames, 4 digests, same pixels); `validate-mesh-path-frames.mjs --frames 90 --query '&indexRegions=verify&actorTail=verify' --plumbing`: PASS (the bar and restroom mirrors, 1280x720 identical).
* New or extended tests: `test/world-visibility.test.mjs` (4: the drawn triples of each mode over a run of passes, the rebuild counts, replacement of the oldest region, and a GPU copy built from the pending ranges
  with meshes culled in some passes, which fails with `clearUpdateRanges` back in), `test/upload-bands.test.mjs`, `test/actor-physics-kernel.test.mjs`, `test/show-self-kernel.test.mjs`. `npm test`: 998 tests, 994 passed, 4 skipped, 0 failed. `npm run build:wasm` is warning-free.

**What is open.**
* **The Island's true p95 is 17.0 ms**: 0.3 ms over the bound and 65 frames over the allowance. The early window is still where it is (the tick leads in the slow frames, [Firefox p95 frames](#firefox-p95-frames-2026-11-07)); of the flat list, the
  audio scan's reads for the 9 or so actors in reach (`measured()`'s index lookups, the channel scan, `kernel.ambient` per actor every frame: kept across frames while the epoch and the listener's cell stand would be the next cut, about
  0.05 to 0.1), texture animation 0.38, the sky and main passes' own 0.8 each and the player's Tick script 0.56 remain.
* **The selector's mover loop** still visits every mover at each select (about 65 empty ones at Battery Park: 345,000 `moverRebuilds` in 5,300 selects in the verify session); a mover with no drawn polygon in two selects running could be skipped (about 0.02 to 0.05 ms).
* **`scanFast` pays `handleOf` per fast answer** (a `Map` lookup after the first): measured inside the final-tree A/B, not apart; cheaper would be one kept texture per pawn and floor node.
* **Not measured**: the Mac, headed runs, Chromium's frame times (a Chromium worker session ran the switches at `verify` only), a rolling call in a Firefox page (Node covers it), and an `ambient_scan` entry marked `RENDER_JS` (no roam met one; the host's old path takes it).

### Row 7.2.4 on master (2026-11-08)

Stage 7's row 7.2.4 ([exit criteria](stage-7-exit-criteria.md), decision D3) asks of Firefox inline: from a map's first 5 s on, no drawn-frame gap
over 150 ms and at most two over 50 ms a minute. It last failed on 2026-10-31 (d01854c9: 10 to 18 over 50 ms a minute on the Island). Measured
again on master `8e34e66a`, the Linux host: `hitch-run.mjs --browser firefox --map 01_NYC_UNATCOIsland --seconds 100 --mode roam --ff-prefs
'{"privacy.reduceTimerPrecision":false}'`, one at a time under the heavy lock and an 8 GB scope, `hitch-summary.mjs` (and `--gaps 50`) on each;
runs in `.cache/perf/hitch/s724-8e34e66a`.

| Roam | Gaps over 50 ms | A minute | Over 100 ms | Longest | fps |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 1.2 | 0 | 83.5 ms | 59.1 |
| 2 (host busy) | 13 | 7.8 | 0 | 82.8 ms | 58.2 |
| 3 | 3 | 1.8 | 0 | 66.4 ms | 58.8 |
| 4 | 3 | 1.8 | 0 | 66.5 ms | 58.7 |
| 5 | 2 | 1.2 | 0 | 50.3 ms | 59.1 |
| profiled (`--profile`) | 6 | 3.6 | 0 | 83.4 ms | 57.7 |

* **Roam 2** lost 1.4 s at about 102 s: the page frame's median rose from 12 to 39 ms with every phase (tick, actors, render, HUD) about three
  times its usual cost and no GL event, and 9 of its 13 gaps fall there (one more at 99.6 s, in the same window). The system journal has a
  package operation (`sudo pacman -Rns`, with a boot snapshot) and the desktop shell restarting at 06:04:20 to 06:04:33 UTC, which the page clock
  puts the window inside (`meta.started` 06:02:30.705 plus 122.3 s). Outside it the roam has 3 gaps, 1.9 a minute. Roams 4 and 5 replace it.
* **The profiled roam** runs Firefox's sampler at 1 ms. Two of its gaps are at 5.3 and 6.2 s, the window's start (the map's opening ticks,
  35 to 37 ms in every run).
* **What the gaps are** (the hitch log's phases; `gecko-gaps.mjs` and `gecko-slow-ticks.mjs --slow 0.0002` on the profiled roam):
  * at 19.3 to 20.4 s in every roam, one tick of 51 to 68 ms, then the gap (66 to 83 ms). The profile's slowest tick (68 ms, 65 ms sampled under
    the level tick) is an actor's script tick (`scriptAndTimer`) calling ConBindEvents: `bindEventsNative` 23 ms, of it the conversation event
    walk (`walkConversationEvents`, `bindEventsToActor`) 15 ms, and a new actor's base link (`baseLinkInstance`) 18 ms, all JavaScript under
    the Rust VM's `js_bool` and `js_int` hand-backs (33 and 15 ms). The conversation is MeetPaul (the 5 s tick is DL_StartGame's), and the
    base link is a profile label, not a call ([BindEvents in the 20 s tick](#bindevents-in-the-20-s-tick-2026-11-10), 2026-11-10);
  * at 38.9 to 43.2 s, one or two gaps of 50 to 83 ms where every phase of the frame is two to three times its median: the incremental
    collector (GCSlice markers, INTER_SLICE_GC, inside the profiled roam's pair at 40.7 and 41.2 s).
* **Reading:** four clean roams pass both halves (1.2 to 1.8 a minute, none over 100 ms), against 10 to 18 a minute on 2026-10-31, when the
  page frame's median was 17 to 20 ms (now about 12). The margin is thin: the two recurring events are most of the allowance, and a busy host or the
  profiler takes a roam over it. A cheaper conversation binding (the event walk and the base link out of JavaScript) would take away the one
  that is not the collector. Not measured: the Mac, other maps, a headed window.

#### BindEvents in the 20 s tick (2026-11-10)

The one recurring gap that is not the collector (above) was identified and cut, but not removed: its tick is still about 40 ms.

**The case** (`scripts/bench-sim.mjs --map 01_NYC_UNATCOIsland --warm 60 --ticks 2000 --render-feedback` with a scenario that logs every native
2052; the headless run reproduces both slow ticks of the profile, at its ticks 36 and 1,419):

| | the 5 to 8 s tick | the 20 s tick |
| --- | --- | --- |
| conversation | `DL_StartGame` (owner JCDenton) | `MeetPaul` (owner PaulDenton), radius-invoked |
| started by | `DataLinkTrigger.Touch`, `DeusExPlayer.StartDataLinkTransmission`, `DataLinkPlay.StartConversation` | PaulDenton0's `ScriptedPawn.Tick`, `DeusExPlayer.StartConversation(Self, IM_Radius)`, `ConPlay.StartConversation` (the roam's route moves it between 19.6 and 29.3 s) |
| `invokeActor` | None | PaulDenton0 (BindName `PaulDenton`) |
| events | 3 (speech, trigger, end) | 54 (21 speech, 16 move camera, 6 jump, 4 transfer object, 3 add goal, 2 end, choice, trigger) |
| GObjObjects (the level's actors) | 2,598 | 2,638 |
| Pawn pass: candidates (BindName set) | 74 (59) | 93 (78) |
| Decoration pass | 166 (10) | 167 (11) |
| PlayerPawn pass | 1 (1) | 1 (1) |
| BindActor calls | 210 (70 candidates x 3) | 4,860 (90 x 54), 360 of them ConEventTransferObject |
| StaticLoadObject calls | 0 | 360 (one per candidate and transfer event; 4 names) |
| bindEventsNative, Node cold first call | 5.5 ms | 16.2 ms (the tick: 49.4 ms) |
| bindEventsNative, Firefox, profile of 8e34e66a (1 ms samples) | 8 ms of a 37.5 ms tick | 23 ms of a 68.4 ms tick |

Each pass of the reference visits the whole list (7,794 and 7,914 entries for the three passes): `reference` (an `instance()` lookup of a
dictionary-mode host object, about a microsecond in Firefox) and `isA` on every entry, and after every candidate it binds the list is made
again (`conversationActors`, 2,600 compares each: 261 times in the MeetPaul call). The event walk is 90 walks of the chain with a
`Set` and two link reads per event, and each pair of candidate and event is a dispatch on the event's class, two to eight `readNamed`
and two to four `scriptCaps` folds; a transfer event adds a `CreatePackage` and a recovered `StaticLoadObject` per candidate
(`findExportIndex`, `exportRecord`, a services object and a copy of it each time). Node's V8 profile of 62 calls (31 of each) puts
`conversationActors` at 21 % of the call under the reference and the StaticLoadObject path at 15 %.

**What `baseLinkInstance` was.** Nothing in this call: the 18 ms are a label. `baseLinkInstance` (actor-link-fields.mjs) only reads
`host[LINKS]`, its one caller is the MoveActor rider scan (`riderBaseInstance`), and no actor is linked while BindEvents runs (every
actor of the level is attached when it enters Level.Actors; `reference` throws for one that is not). In the Gecko profile the
label sits above unrelated leaves (`lookupMember`, the lowering, window natives) in 17 samples of the slow tick and 216 of the run (132 of
them in the 20 to 30 s of profile time, the map's load and first seconds), the same way `isPointerCell` and a three.js material appear above `invokeNative` there: the profiler's names for
frames the JIT inlined into the Rust VM's `js_object` hand-back, not a call. The profile was taken at 8e34e66a and its line numbers are
that revision's.

**The rest of the tick.** The 20 s tick is the first conversation start of the run. In the profile taken after the change (the 76 samples under
the level tick in a 120 ms window around it): the original scripts building the conversation window (`script-window-*`, 23 ms), the Rust VM itself (23), ConPlay's host
services (`script-conplay-live`, speech audio, 9), the first lowering of the callee functions (8), BindEvents (6), the rest 7. None of
it is BindEvents' and none is cheap to remove here.

**The change** (`BIND_EVENTS=rust|js|verify`, `?bindEvents=`; [Rust core](rust-core.md#november-10-bindevents-class-passes-over-the-images-class-rows-implemented),
[conversation events](script-conversation-events.md#host-fast-paths-in-play-bind_events-2026-11-10)): the three class passes run on render.rs
`cycle_scan` over the image's class rows (no new Rust); the strings are not in the image, so the repeated reads, loads and walks of the
call are kept in script-conversation-bind-scope.mjs for the call only: names read once per object and field, folded once per text,
the event chain walked once, one StaticLoadObject per item name, one dispatch per event. The reference stays under `js`.

**Verification.**
* `verify` over the Island run above (both calls): no difference; the world digest after 2,000 ticks is `64a52f060ba42031` in `js`, `rust`
  and `verify` (`bench-sim.mjs`, same seed and flags).
* Unit tests (test/script-conversation-events.test.mjs: the scan against the reference passes, a kind 2 entry, a list change during a
  pass, a lying scan under verify; test/script-conversation-bind-scope.test.mjs).
* Validators, `rust` mode: validate-script-conversation-events, validate-native-conversation-events (Unicorn oracle of the three-pass
  body), validate-conversation-binding, -wrapper, -speech, -action-bind, -base-bind, -check-object-bind, -transfer-object-bind,
  validate-script-datalink-transmission, validate-island-conversation (MeetPaul to its choice and the GEP gun's transfer: the output is
  byte-identical in `js`, `rust` and `verify`), validate-instructor-conversation; `verify`: validate-island-conversation, -binding,
  -transfer-object-bind, -check-object-bind. All pass.

**Measured** (Node, headless; the call's own time, first and cold): `DL_StartGame` 5.5 to 2.2 ms, `MeetPaul` 16.2 to 5.0 ms, the 20 s tick
49.4 to 35.5 ms. Warm (62 calls under a V8 profile): 294 to 71 ms, 4.7 to 1.1 ms a call.

Firefox inline, Island roam, 100 s, five interleaved pairs on the Linux host (`hitch-run.mjs --browser firefox --mode roam --seconds 100
--ff-prefs '{"privacy.reduceTimerPrecision":false,"media.volume_scale":"0.0"}' --query bindEvents=js|rust`, one at a time under the heavy lock;
runs in `.cache/perf/hitch/bind-2026-11-10`):

| | `js` (mean, five roams) | `rust` (mean, five roams) |
| --- | ---: | ---: |
| `DL_StartGame` tick (4 to 8 s) | 30.7 ms (29.3, 31.0, 30.7, 30.8, 31.6) | 25.8 ms (25.4, 26.1, 24.5, 25.8, 27.2) |
| `MeetPaul` tick (slowest of 15 to 38 s) | 58.5 ms (56.1, 62.0, 57.8, 54.3, 62.2) | 40.5 ms (39.5, 37.2, 40.7, 43.3, 41.9) |
| the gap at the MeetPaul tick | 66, 67, 66, 67, 84 ms | 50, 49, 50, 49, 50 ms |
| gaps over 50 ms a minute | 2.5 (1.2, 2.4, 3.5, 1.8, 3.6) | 3.2 (8.3, 1.8, 2.3, 1.8, 1.8) |
| longest gap | 70 ms | 87 ms (84, 100, 50, 117, 83) |
| fps, page frame p50 / p95 | 58.4, 12.7 / 18.8 ms | 58.9, 11.7 / 18.1 ms |

* Roam 1 of `rust` (8.3 a minute) has 11 gaps between 12.2 and 13.1 s with every phase of the frame two to four times its cost, a host
  disturbance (this session was parsing a 100 MB Gecko profile beside it); without it the arm is 2.0 a minute. Its ticks are unaffected.
* The longer gaps of the `rust` arm (100 and 117 ms) are in the collector's window (40.8 and 42.9 s, one tick of 88 ms): the same window
  has ticks of 60, 50, 53, 52 and 64 ms in the master roams of 2026-11-08 and the `js` roams of this session; the arms do not differ in
  how often it happens (ticks of 50 ms or more at 36 to 47 s: master 2 of 5 roams, `js` 2 of 7, `rust` 3 of 7).
* The gap count is the sum of this window and the two BindEvents ticks; the change removes the second of the three ("the MeetPaul gap
  66 to 84 ms" becomes 49 to 50 ms, on the line, since a 40 ms tick is followed by a normal render), not the collector's.
* One Chromium worker roam (60 s, `bindEvents=rust`): 0 gaps over 50 ms, 60.0 fps, worker tick p50 7.2 and p95 10.0 ms.
* A Gecko profile of the changed code (`ff-rust-p.profile.json`): `bindEventsNative` is 6 ms of the 76 sampled in the 20 s tick (23 of 97
  before) and 2 ms of the 5 s tick (8 of 42).

**Reading.** BindEvents is no longer the largest part of either tick (23 to 6 ms and 8 to 2 ms in Firefox; 18 and 5 ms off the ticks), but
the 20 s tick is still 40 ms, over the 30 ms this work set as the bar for a clear win: what is left is the original scripts
building the conversation's window, the Rust VM and ConPlay's services, the first time the session runs them. The row counts (7.2.4) are
unchanged within the noise of the collector's window; the gap that follows the 20 s tick is now at the 50 ms line instead of 66 to 84 ms.
Left unexplained: why the long ticks (64 to 88 ms) in the collector's window show in `rust` roams 2, 4 and 5 (three of seven roams against two
of seven, of 52 and 53 ms, in `js`; the cause is the incremental collector, which this change does not touch, and the sample is small). Not measured: the Mac, a
headed window, other maps (the same call is every conversation's start; Battery Park's and the other maps' conversations are not in the
frame-time set).

### The collector's window (2026-11-10)

The other recurring gaps of row 7.2.4 (above: one or two of 50 to 117 ms at 39 to 48 s of every Island roam) are two major
collections that run past 1.5 s, after which SpiderMonkey makes every slice uninterruptible and longer. Traced in Gecko's and
SpiderMonkey's source (`mozilla-firefox/firefox` main, fetched 2026-11-10) and measured on the Linux host; nothing is changed in Play yet.

**What Firefox does** (source, then the measurement that matches it):

* **The collections.** The load's allocation-triggered zone collections schedule a full one `javascript.options.gc_delay.full`
  (60,000 ms) later: `FULL_GC_TIMER`, all four zones, at 39 to 41 s of the roam (60 s after the one at -20 s). About six seconds
  later a cycle collection pokes another (`CC_FINISHED`, three zones): `CCGCScheduler.h` asks for it when the cycle collector freed
  more than 250 GC things, or more than 2,500 DOM events were made since the last collection (`LikelyShortLivingObjectCreated`).
  Each has 140 to 210 ms of work (marking 120 to 180 ms; the full one also sweeps 36 ms, 12 of it the atoms table).
* **How the work is spread.** `CCGCScheduler::EnsureGCRunner` runs slices from an `IdleTaskRunner` with a minimum useful budget of
  5 ms (`mActiveIntersliceGCBudget`, 1 ms only after a cycle collection that freed over 10,000 objects) and a 250 ms maximum delay
  (`javascript.options.gc_delay.interslice`), after which it forces a 10 ms slice. The idle deadline is the refresh driver's
  `mostRecentRefresh + period - 1 ms` (`GetIdleDeadlineHint`, `layout.idle_period.time_limit`). `IdleTaskRunner::Run` slices
  only when `now + 5 ms < deadline`; between that and the deadline it waits for the next painted tick; past the deadline it
  queues itself for the next idle moment. Allocation during the mark adds 5 ms slices inside the frame (`TOO_MUCH_MALLOC`,
  `TOO_MUCH_JIT_CODE`).
* **Where our frames fall.** The idle slices' budgets place the vsync: the page's tick starts a median 2.65 ms after it (p10 1.7,
  p90 4.2; headless), and the tick with its paint takes 11 to 13 ms, so it ends near `vsync + 15`: inside the band where the
  runner only waits. A slice runs when a tick ends past `vsync + 15.67` (then for the ~2.6 ms before the next tick interrupts it)
  or when the 250 ms timer forces one. An idle slice of 5 ms or more needs the tick, paint included, at 8 ms or less.
* **The escalation.** `GCRuntime::maybeIncreaseSliceBudgetForLongCollections` (js/src/gc/GC.cpp) gives every slice of a
  collection started more than 1,500 ms earlier an uninterruptible minimum budget rising linearly from 0 to 100 ms at 2,500 ms.
  The profile matches it to the millisecond (slices of 23, 29 and 35 ms at 1,736, 1,787 and 1,852 ms). The gaps are those slices
  plus the frame.

**Measured** (`hitch-run.mjs --browser firefox --mode roam --seconds 100 --gc-markers --profile`, Island, master c15e2923, one roam
each; `gecko-gc-windows.mjs`; runs in `.cache/perf/gc-pauses`):

| Roam | Collection at | Wall | Work (mark) | Work in the first 1.5 s | Extended slices (ms, first at) |
| --- | --- | ---: | ---: | ---: | --- |
| as shipped | `FULL_GC_TIMER` 40.7 s | 2,145 ms | 206.0 (161.4) | 95 | 6 (101.6, 1,834 ms) |
| | `CC_FINISHED` 47.3 s | 2,274 ms | 138.1 (123.2) | 45 | 4 (83.3, 1,879 ms) |
| `idle_period.cross_process_scheduling` off | `FULL_GC_TIMER` 40.5 s | 2,256 ms | 162.4 (120.0) | 49 | 5 (107.5, 1,752 ms) |
| | `CC_FINISHED` 47.0 s | 2,039 ms | 194.7 (175.1) | 124 | 4 (55.0, 1,784 ms) |
| `gc_incremental_slice_ms` 2 (minimum budget 2 ms) | `FULL_GC_TIMER` 41.0 s | 2,194 ms | 180.0 (138.0) | 44 | 7 (115.3, 1,672 ms) |
| | `CC_FINISHED` 47.5 s | 1,585 ms | 198.5 (183.1) | 187 | 1 (0.1, 1,585 ms) |
| profiled roam of 8e34e66a (2026-11-08) | `FULL_GC_TIMER` 38.9 s | 1,928 ms | 182.6 (139.9) | 74 | 6 (93.8, 1,652 ms) |
| | `CC_FINISHED` 44.8 s | 2,172 ms | 166.3 (149.2) | 90 | 5 (74.4, 1,732 ms) |

* With a 2 ms minimum budget (a stand-in for frames that leave idle time) the `CC_FINISHED` collection took 71 idle slices and
  finished at 1.59 s; the full one, at a stretch where frames ran 14 to 20 ms, took 21 slices in its first 1.5 s and escalated
  as before. Idle time is what the collector lacks; the preference is not something a page can set.
* The work done in the first 1.5 s ranges from 44 to 187 ms with the frames' position against the vsync. What a collection gets
  without idle slices is about 60 ms (forced slices) plus 25 to 30 ms (allocation slices) in 1.5 s.

**What is marked.** Gecko's memory report of the Island at 30 s (`map-memory-census.mjs --browser firefox --sim inline
--keep-reports`): 141.7 MB of GC heap (Object 58.1, Array 28.4, strings 10.1, Function 9.5, Map 7.5 MB). By owner, from a Chromium
snapshot of the same inline page (`heap-families.mjs --sm`, which counts what a SpiderMonkey heap would hold as cells: objects,
closures and their environments, strings; V8's element arrays and heap numbers have none): 1.93 M cells, 40% of them the page's own
render data. The largest families (depth 4, thousands of cells):

| Family | Cells | What |
| --- | ---: | --- |
| `map.model` (a `WeakMap` value) | 307 | lighting.mjs light-map records: per surface `staticGeometry` (3 objects, 8 arrays), `uv`, `basis`, `lightEntries`, `lightMap`, `surface` |
| `simHost.actorSim` | 84 | the actor mesh layer's per-actor closures and their contexts |
| `NameSpelling.spellings` | 79 | name strings |
| `map.triangles` | 74 | the BSP triangle list, read only by the world build |
| `npcPreview.root`, `.draw` | 72, 29 | three.js objects of the NPC meshes |
| `ScriptProcess.packageObjects.loadRecord`, `.data` | 66, 21 | load records |
| `ScriptProcess.packageObjects` | 65 | package objects |
| `ScriptProcess.packageObjects.function.body.built`, `.tree` | 62, 33 | function bodies that ran |
| `sim.sprites` | 53 | sprite state |
| `ScriptClassLoader.graph.buildLinker.objectHash` | 35 | strings |
| `map.actors` | 33 | the decoded actors and their property tags |

**Reading.** Cheaper frames do not help until the tick and paint fit in about 8 ms (a frame 2 ms cheaper still ends in the band
where the runner waits). What does help is less work per collection: done by about 1.75 s, the slices stay under about 25 ms and the
gaps under 50 ms. With the 60 to 90 ms a collection gets in 1.5 s when idle slices are scarce, that is about 100 ms of work, half of
today's. If the work follows the cells (unverified), that is about 1.0 M cells instead of 1.93 M. The families above are the
candidates, the page's light-map records first. Not measured: a headed window (the tick's lag behind the vsync may differ), the Mac
(at 120 Hz the minimum budget is 2.5 ms and the period 8.3 ms).

Tools: `gecko-gc-windows.mjs` (one line per major collection: wall, work, extended slices), `hitch-run.mjs --gc-markers` (a
markers-only Gecko profile, no stack sampling), `heap-families.mjs --sm`, `map-memory-census.mjs --keep-reports`.

#### The page's light maps and triangles in compact form (2026-11-10)

The first cut at the two largest families of the table above: the light-map records of `lighting.mjs` and the BSP triangle list. Host
data layout only; every value is the one it was (the digests below).

**What was cut** (6,960 light-map records on the Island, 190 of them a brush's; about 44 cells a record before):

* `lighting.mjs`: a record is a `LightMapRecord` that holds what is the light map's own (the texels `texels`, the float samples
  `pixels`, the indices and the zone, `model`, `transform`/`transformNormal`, the mover's pose and header) and makes the rest where it is read,
  from the model's tables and those indices: `surface`, `lightMap`, `basis` and `uv` (`lightmapBasis`, the last one asked for in a model kept in a
  one-entry memo, which is what world.mjs's per-vertex `uv` and per-texel `basis.point` ask for), `lightEntries` and `lightRefs` (the model's
  list for the light map; `invalidate` tests `listsAny` against it without building them), and a level record's `normal`. The brush's
  records keep them (moving-lights.mjs reads their `surface` and `normal` for every moving light, every frame). A level record is now a
  record, its `pixels` and its `texels`: three cells.
* The facet and texel grid (`staticGeometry`: 3 objects and 8 arrays) are built by `refill` and dropped for a level record; `geometryFor`
  and `gridFor` keep theirs for the records moving lights and the fog pass ask about (`reachRecord` asks every frame).
* A light map with no animated light has no copy of its base texels (`texels` is `baseTexels`: nothing writes it without `animated`), a
  shared frozen empty `animated`, and no `animationMemo`.
* The cache's key is a number (`surfaceIndex * 65536 + zone`) instead of a string per record, and a surface's records are a chain
  (`nextOfSurface`) instead of an array a surface; `recordsFor` still returns an array, `firstRecordFor` is what world.mjs's per-frame drawn
  list and moving-lights.mjs's reach walk use.
* `light-atlas.mjs`: a tile's `bounds` array is a getter on `AtlasTile` (world.mjs reads it once a surface).
* `main.mjs`: `map.triangles` is released after `createWorld` (nothing else reads it: world.mjs `addModel` is the one reader, and the
  count is kept in `map.summary.triangles`; no later `createWorld` runs on the same decoded map).

**Measured** (Chromium inline Island, 30 s after the arrival, `map-memory-census.mjs --snapshots 1`, `heap-families.mjs 4 40 --sm`; the
snapshots were deleted, the family tables are in `.cache/perf/heap-a/{base,a1,a2}-families.txt`):

| | before (c5809462) | after |
| --- | ---: | ---: |
| SpiderMonkey-like cells, whole page | 1.93 M | 1.60 M (-17%) |
| `map.model` | 307 k | 45 k |
| `map.triangles` | 74 k | 0 |
| `map.actors` | 33 k | 33 k (not touched) |
| `world.lightMaps` | 13 k | 11 k |
| JS heap objects / edges / MB | 3.11 M / 22.1 M / 201 | 2.57 M / 20.4 M / 188 |
| page JS heap after forced GCs (census) | 199.2 MB | 186.3 MB |

The 45 k left in `map.model` are, per record, the record, its `pixels` and its `texels` (6,770 each) and the 13,557 `ArrayBuffer` objects
V8 makes for the two typed arrays (SpiderMonkey makes none of its own), so about 31 k SpiderMonkey cells; the atlas tiles (about 7,000) are in their own family.

**Verification.**
* `scripts/validate-light-map-digest.mjs` (new; `light-map-digests.json` recorded on c5809462 before any change): a SHA-256 of every BSP triangle,
  of every light-map record in surface order (texels, base texels, float pixels, the surface and light-map values, normal, light lists, facet
  and grid, `basis` and `uv` sampled at five texels, transforms) and of every attribute array of every mesh `createWorld` makes
  (positions, normals, uvs, light-map coordinates and bounds, layers), on 01_NYC_UNATCOIsland (6,960 records, 2.74 M texels, 36,803
  triangles) and 00_Training (5,212 records, 435 animated, 25,674 triangles): identical.
* `npm test` files for what is touched (lighting, script-light-cache, moving-compose, world-batches, world-visibility, bsp-model, objects,
  level-queries-world-model, map-property-tags, moving-light-leaf-list, mesh-lighting-view: 40 tests) pass.
* The validators with `light` in their name (25: static, dynamic, moving, mover, animation (JS and Rust), spatial, leaf, atlas upload,
  script light cache, TriggerLight, AugLight, mesh lighting, the `-play` ones in the browser's worker mode; 24 passed, 1 skipped:
  validate-original-light-tables), the world ones (world-batches, world-batch-gpu, world-destroy, native-world-fitting, underworld-panes-play),
  texel-sphere, scene-matrices, viewer, fog-blocks and the volumetric-fog ones, corona-tiles (and `-play`), bsp-model, page-movers-play: all pass.
* Play in Chromium on the Island, 25 s roam each (`hitch-run.mjs`): worker mode 2,388 frames, 1,821 drawn, no errors; `?sim=inline` 1,983
  frames, 1,808 drawn, no errors; the screenshots show the level and its conversation scene. Firefox inline, 100 s (below): 6,150 frames drawn, no errors.

**Firefox's collector** (one roam, inline, Linux host, `hitch-run.mjs --browser firefox --mode roam --seconds 100 --profile --gc-markers`,
`gecko-gc-windows.mjs`, runs in `.cache/perf/ff`), against the two shipped-configuration roams of the table above (as shipped, and the
profiled roam of 8e34e66a):

| | `FULL_GC_TIMER` work (mark) | `CC_FINISHED` work (mark) | extended slices |
| --- | ---: | ---: | --- |
| before (mean of 2 roams) | 194.3 (150.7) ms | 152.2 (136.2) ms | full 6 and 6, CC 4 and 5 |
| after (1 roam) | 160.7 (118.0) ms at 40.5 s | 129.2 (114.8) ms at 47.0 s | full 5 (100.5 ms, first at 1,685 ms), CC 5 (77.6 ms, 1,683 ms) |

The work fell by about the share of the cells (17% and 15%), and the roam had 6 gaps over 50 ms (3.5 a minute) with the longest at 66 ms,
but the collections are still 130 to 160 ms of work, over the 100 ms this section asked for, and the extended slices still start at about
1.7 s and are as long as before: **the window is not closed**. One roam against two is inside the spread of the table's other rows (138 to
206 ms), so the cells-to-work ratio is an indication, not a measurement; no interleaved A/B was run.

**Left.** The families of the table not touched here are the larger part: `simHost.actorSim` 84 k and the NPC and sprite families
(another change), `NameSpelling.spellings` 79 k strings, the script process's `packageObjects` families (about 280 k together). In the
light-map family: the typed arrays (`pixels`, `texels`: one cell each a record, which pooling into one buffer per level with views made on
demand would remove, at the price of a view per access in the atlas, moving lights and fog), the atlas tile (one object a record), the
`staticGeometry` (11 cells) each record moving lights reach keeps, a `THREE.Sphere` (2 cells) for each record world.mjs `inFrustum` tests
(Play passes the drawn set, so it is not made there), and the `fogGrid` closure of a fog-zone record. `map.actors` (33 k: each actor's
`values` and its saved `stack`) is read by the script attach and kept by the host accessors for the life of the level, so releasing it was
not clearly safe and was left; `map.level.reachSpecs` (13 k) is a decoded copy beside the `playerScene.level.reachSpecs` game.mjs makes
from it, a candidate for the simulation side. Frame times were not A/B measured: this changes allocation at load and the cost of a refill, not a per-frame body.

#### The actor mesh layer's closures (2026-11-10)

Host data layout only, from master c5809462; one commit on branch `worktree-agent-a82d4f859659ab8ee`. Measured as the families above
were (`map-memory-census.mjs --browser chromium --sim inline --maps 01_NYC_UNATCOIsland --settle 30 --snapshots 1`, then
`heap-families.mjs <snapshot> 4 40 --sm`), the same tree before and after.

**What the named families were.** `simHost.actorSim` and `npcPreview.draw` were mostly closures (`npcPreview.root` is the three.js
objects, below): 305 bindings on the Island, each of `meshBindingSteps` (`actor-mesh-sim.mjs`: one generator whose 62 helpers and members and 81 variables closed over each other: about 70
closures and 6 contexts a binding) and `createMeshDraw` (`actor-mesh-draw.mjs`: 33 helpers and members, about 35 closures a binding), with
the cache, the plan's context and the LOD each binding keeps (about 15 closures more). `sim.sprites` (53 k) is not sprite state: the first
path to it is the session's `sprites` method, and what hangs off its scope is the script runtime's actor hosts (1,745 `MapActorHost`, about
30 cells each: their `ScriptState`, field sets and maps, `live-heap.md` "Actor hosts and mesh bindings"). `gpuMesh.allocate` (20 k) is the
mesh payload views (86 meshes, 232 cells each, shared by every binding of a mesh) and `game.start` (19 k) is `level.reachSpecs` (12.7 k plain
objects, a copy of the decoded `map.level.reachSpecs`). Neither is a layer of its own, so neither is cut here.

**Cut** (every value computed is the same; the page's objects and the simulation's records are the same):
* `meshBindingSteps` makes a `MeshBinding`: the variables are fields, the helpers and the returned object's members methods of the class
  (one `new` and the same code for every binding). The generator keeps its two `yield`s and builds the fields in the order it built the
  variables. `createMeshDraw` makes a `MeshDraw` the same way, `createMeshLod` a `MeshLod`, and `createLodMeshFrameCache`,
  `createPublisher` and `frameContext` (`lodmesh-frame.mjs`: the GetFrame cache, its vertex loops and a plan's context, which a binding
  keeps for its last plan) a `LodMeshFrameCache`, a `Publisher` and a `FrameContext`. The binding is the `services` object GetFrame reads
  (`cache`, `kernel`, `read`, `objectIndex`). A name a member and a variable shared became `_block`, `_groups`, `_gpuHandle`, `_ready`,
  `_source`, `_vertexCount`. The conversion was made by a one-off codemod over the AST (scope analysis, every reference to a captured variable
  rewritten, each function moved out unchanged; not kept), and the result was read.
* One function for every binding where a closure was made for each: a group's shader hook and program keys (`groupBeforeCompile`, three
  key functions; three.js calls both as methods of the material, which carries its binding's `deusOwner`, the group's `deusEnvironment` and
  `deusModulated`), the draw layer's `onError`, a mirror frame's admission (`drawnInChildFrame`: made in `admitNew` it held that call's
  context, the closures `take` and `fail` and the options for the life of the binding), the pooled texture's lease (`TextureLease`, 770
  closures), the cache's default allocation function (`newBytes`) and a `MeshLod`'s float to word scratch pair (used at once).
* Not allocated until used: a `MeshLod`'s JavaScript-morph alphas and its lighting-topology map (the kernel path uses neither).

**Numbers** (Island at 30 s, inline, Chromium; cells as `heap-families.mjs --sm` counts them):

| | Before | After |
| --- | ---: | ---: |
| SpiderMonkey-like cells, whole page | 1,932,373 | 1,886,036 (-46,337, -2.4%) |
| closures | 151,018 | 112,680 (-38,338) |
| contexts | 58,839 | 52,375 (-6,464) |
| `simHost.actorSim` | 84 k | 55 k |
| `npcPreview.root` + `.draw` + `gpuMesh.allocate` | 72 + 29 + 20 = 121 k | 59 + 43 + (in `.draw`) = 102 k |
| `sim.sprites`, `game.start` | 53 k, 19 k | 53 k, 19 k |

(The first-reach attribution moves the mesh payload views between the three families of the second row as their owners change; the whole
page's figures are the ones to compare.) The simulation host's frame (`frame-alloc-meter.mjs --time`, Island, 600 frames, three interleaved runs
of each tree): `actors` step mean 1.48, 1.61, 1.51 ms before and 1.41, 1.43, 1.42 ms after; the whole frame's allocation 1,413 KB before, 1,410 after.

**Checks.** `frame-alloc-meter.mjs --compare` against the unchanged tree: identical frames on the Island (`cebe25dcbba1f08a`, 600), 00_Training
(`398be1b404124a61`) and 03_NYC_747 (`8dbcbfae1f441921`); `hud-stream-digest.mjs --frames 1500 --stream`: identical (`16bfe2bd08ed1653`);
bench-sim 300 ticks: Island `15e3720088490242`, 00_Training `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`, as before (the layer is
not in its path). Validators, each exit 0 (`run-validators.mjs --filter`, one at a time; `lodmesh-lod` runs two): actor-mesh-scene,
npc-mesh-preview, gpu-mesh, lodmesh-frame, lodmesh-lod(-play), mesh-lighting-play, mesh-path-frames, mesh-environment, sprite-setup,
sprite-tiles-play, sim-split, first-draw-pose, weapon-gpu-play, weapon-play, umesh-play, context-loss-play, mirrors-play, scene-matrices,
spawn-mesh-binding, training-cadet, render-mesh-bounds, lasers-play, weapon-lod; the unit tests (1,003) pass. One harness change:
`validate-lodmesh-frame.mjs` held the cache's `create` and `flush` away from the cache to wrap them (`create(key,size)`), which a method
of a class does not allow; it calls them on the cache now (`create.call(cache,key,size)`), the only place that did. Play on the Island in
Chromium, worker mode and `?sim=inline` (25 s roams, `hitch-run.mjs`): no runtime or render error, 305 and 325 mesh actors drawn on the
GPU path (`status().npcPreview`), two characters and a bot in the worker run's screenshot.

**What is left, and why.** The page's three.js objects are most of it: 1,430 `Object3D` (a binding's group and its meshes: about 25 cells
each, two of them closures and a context three.js makes for the rotation and quaternion callbacks), 786 geometries with five attributes
each, 1,433 materials (6 to 7 cells each after the cut). They are what three.js allocates for an object; fewer of them means not
creating the meshes of the opaque groups the draw batches draw instead (their geometries are read when a batch is rebuilt, so the
attributes would have to move to plain typed arrays and the meshes be made when a group turns transparent, which changes the objects'
ids, the tie-break of three.js's transparent sort; the number of such groups was not measured). Not done. Elsewhere: the pawn physics
views' accessors (`defineCallAccessor` in `script-actor-physics.mjs`: 4,750 closures, each a per-key `()=>get(name)`), the 1,745 actors'
`initialProperty` closures (`script-map-properties.mjs`), `reachSpecs` (12.7 k) and the mesh payload views' 20 arrays a mesh. The Firefox
roam (`hitch-run.mjs --browser firefox`, `gecko-gc-windows.mjs`) was not run: 2.4% of the cells is about 3 to 4 ms of a collection's 140 to
210 ms, which one roam cannot tell from the spread between roams (the table above). The goal of about half the work (1.0 M cells) is not
reachable from these families: together they are 277 k of the 1.93 M cells, and 46 k are cut.

#### Both cuts against the base, interleaved (2026-11-10)

Four interleaved pairs of 100 s Firefox inline Island roams, each with a markers-only profile, on a quiet host: the base 036d848a (the
tools of this section, Play as at c5809462) from its own checkout against master b52cb98f (both cuts: 1.93 M to 1.55 M cells); the order
reversed in every second pair. Runs and scripts in `.cache/perf/gc-pauses/ab` (`run-ab.sh`, `summary.mjs`).

| Run | Page p50 | Gaps over 50 ms (a minute) | `FULL_GC_TIMER`: wall, work (mark), extended slices (ms) | `CC_FINISHED`: wall, work (mark), extended (ms) |
| --- | ---: | --- | --- | --- |
| base 1 | 12.2 | 3 (1.9) | 2,128 ms, 143 (107), 4 (86) | 2,037 ms, 117 (104), 6 (68) |
| base 2 | 12.3 | 4 (2.5) | 1,999 ms, 149 (109), 6 (84) | 2,073 ms, 116 (105), 4 (68) |
| base 3 | 11.0 | 2 (1.2) | 1,940 ms, 152 (113), 5 (93) | 1,774 ms, 133 (121), 3 (12) |
| base 4 | 10.9 | 1 (0.6) | 1,904 ms, 150 (111), 4 (69) | 1,465 ms, 132 (119), 0 |
| master 1 | 12.1 | 4 (2.5) | 2,470 ms, 186 (108), 4 (120) | 1,957 ms, 110 (97), 4 (52) |
| master 2 | 12.0 | 3 (1.9) | 2,157 ms, 187 (155), 5 (133) | 2,024 ms, 123 (96), 4 (65) |
| master 3 | 12.1 | 6 (3.7) | 2,042 ms, 149 (97), 4 (90) | 1,819 ms, 110 (97), 5 (58) |
| master 4 | 12.0 | 4 (2.5) | 1,928 ms, 144 (106), 6 (84) | 1,955 ms, 111 (97), 3 (42) |

* **Marking.** `CC_FINISHED` marks 96 to 97 ms against 104 to 121 (-8 to -20%); `FULL_GC_TIMER` 97 to 108 ms against 107 to 113, with one
  run at 155 (-3% by the medians). The 20% of cells cut is not 20% of the marking. The totals spread more than the marking: master 1's
  full collection waited 40 ms for the background sweeping thread (`wait_background_thread`).
* **Gaps.** Inside the collectors' window (42 to 51 s) the base has 2, 3, 1 and 0 gaps over 50 ms and master 3, 2, 4 and 3, the longest
  83 ms (master 1 and 3). Elsewhere both arms have the gap at 26 to 29 s and, in two base runs, MeetPaul's at 20.5 s. No improvement is
  measurable at this sample.
* **Frames.** The phases are the same in both arms except base 3 and 4, whose level tick ran 5.3 ms against 6.3 to 6.6 (a simulation
  phase neither cut touches: run-to-run spread). Those two runs got the most idle slices (`CC_FINISHED` 32 and 29 against 11 to 19) and
  the fewest gaps; base 4's `CC_FINISHED` finished at 1.47 s without an extended slice. The frame's position against the vsync moves the
  result more than the heap cut did.
* **The marking earlier in this section** (161 and 123 ms on the same base tree) was measured while the two workers ran their censuses
  and validators beside it: SpiderMonkey marks in parallel on helper threads, and a busy host makes it slower. Only interleaved runs on a
  quiet host compare.

**What marking visits.** SpiderMonkey's marker visits every value slot of a marked object (fixed slots, its slots and elements buffers;
a double in an array is a boxed value it still visits), so the time follows slots more than objects: Gecko's report has 34 MB of
elements and 19 MB of slots buffers (about 6.6 M slots) beside the objects' own fixed slots. `heap-families.mjs --slots` estimates the
slots per family from the Chromium snapshot of master (V8's element and property stores, and each object's named fields): 13.9 M on
the Island page, with no family over 9%. The largest (thousands): `packageObjects.loadRecord` 1,156 (the load records' native slot
words), the script runtime's actor hosts (`sim.sprites`) 624, `LoadEdges.records` 569, `npcPreview.draw` 430, the package identities
408, `ScriptRuntime.instances` 403, `actorSim` 369, `map.actors` 360, the function trees 356, the property metadata 351, `map.model` 343,
`linkedClasses.fields` 331 and `.defaults` 323, `npcPreview.root` 304, `linkedOperands` 253. The first ten are 36% of the slots, most of
them the script process's object model.

**Reading.** Half the marking is not in a few page families: it is spread over the script process's objects (load records, identities,
instances, linked classes, function trees, metadata) and the page's mesh and actor state. Halving it means moving that object model
out of JavaScript objects (the Rust core's object image in Wasm memory, which the collector does not trace) rather than more cuts of
this kind. The two cuts stay: they are output-identical, the light-map one takes 13 MB off the page and the closure one makes the actor
step a little cheaper; neither changes the row.

#### The script runtime's instance state (2026-11-10)

The second cut at the script process's object model, in the families that are the runtime's own per-object and per-class state (the
actor hosts' collision values, `ScriptRuntime.instances`, the per-class cell, field and name tables). Host representation only: every
value is the one it was (the checks below). Commit `e199ecf4`, from master 13ce5312.

**What was cut** (slots from the Chromium heap snapshots of the same Island, `heap-families.mjs --slots`):

| Structure | Was | Is |
| --- | --- | --- |
| A class that declares no property (145 of the 289 classes the Island attaches: pawn and decoration subclasses that differ in defaults and script) | its own `cells` Map (230 entries on average), `fields` Map, name table, name memo and cleanup plan | the nearest ancestor's with the same `propertyLink` and PropertiesSize (`layoutOwner`, script-object-image.mjs): 176 layouts for 289 classes |
| The cells of strings, names, arrays, structs and fixed arrays | one object of twelve slots for each class and property (11,300 on the Island) | equal cells (tag, offset, mask, reference position, parts, key, flags) are one object (2,400) |
| `layout.fields` (key to linked field) | a Map for each class layout (345 K slots) | one index for the class graph |
| Property name handles `{field, codec, cell}` | one for each class and name (40,500 objects) | one for each field and cell (about 540) |
| `ScriptInstance` (12,458 on the Island) | 31 own slots | 16: runtime, arena, cells, size, field table and bDeleteMe are the class's (`InstanceClass`, read through accessors); the measured index, the Rust VM's binding set cache, `singular`, `pendingKillValue`, the text parser, the random labels and the defaults snapshot are in an `InstanceExtra` made on first write (the map actors have one for the first two); a loaded object's `loadedReference` is its `receiver` |
| `ScriptState` (11,634) | 11 slots | 7: services and locals kind shared by the runtime's states, `execution`, `codeNode` and locals in a frame made when the state runs code (166 do), the two booleans in one word |
| `collisionValues` of a decoration or pawn host (428 on the Island) | a copy of all the host's `values` (90 to 280 members) and three closures | an object that inherits `values`, with the three live members (shared getters) |
| A map actor's `store` Map | one for each of 1,745 hosts | made when a property without an image cell is first stored |

**Slots** (value slots of the heap snapshot; the families of this section are `ScriptRuntime.instances.*`, `instanceClasses`,
`fieldTables`, `memberCaches.fields`, `classImages.layout.fields`, `CollisionWorld.actors.collisionValues` and the name handles):

| Snapshot | Base 13ce5312 | After | |
| --- | ---: | ---: | --- |
| headless Island, 600 ticks, forced GCs (`bench-sim`, `v8.writeHeapSnapshot`) | 15.64 M slots, 1.31 M cells | 14.26 M (-1.38 M, -8.8%), 1.25 M | the families of this section: 2,848 K to 1,534 K |
| Chromium inline Island at 30 s (`map-memory-census.mjs --sim inline --snapshots 1`) | 13.88 M slots, 1.55 M cells | 12.79 M (-1.09 M, -7.9%), 1.48 M | the owner's families, thousands of slots: `ScriptRuntime.instances` 403 to 236 (+27 of `extra`); the per-class cell, name and plan tables (`CollisionWorld.actors.<symbol>.fieldTable` 205, `.cells` 146, `instances.cells` 144 with its members and elements about 100, the cleanup plans `.cells.sites` 92 and 20) to `instanceClasses.cells` 88 and its plans 62; `instances.state` 133 to 89; `collisionValues` 115 to 2; `sim.sprites` 624 to 602 |

Families (thousands of slots, headless snapshot, before to after): `ScriptRuntime.instances.cells` 408 and `classImages.layout.fields`
345 to `instanceClasses.cells` 197 (the cells Maps of the 183 layouts and their 2,400 cells); `fieldTables` 367 to 118; `memberCaches.fields`
284 to 147 (the memo is shared by the classes of a layout; the rest are the layouts' own); `ScriptRuntime.instances` 388 to 253 (with the
WeakMap's table); `.state` 128 to 70; `CollisionWorld.actors.collisionValues` 195 to 2. Unchanged: `instances.loadedResource` 158 (the
resource records, held by nothing else), `.bindings` 142, `.refs` 94, `imageToken` 37, `nativeObject` 29.

What the metric counts, for the next reader: it counts V8's words. An empty `Map` is 18 words of table there and, in SpiderMonkey, an
object whose marker visits no entry, so the 7,000 Maps of the actor hosts' families (`store`, `authored`, `rest`) and the hosts'
null-prototype pending tables (105 words each in V8's dictionaries) are overcounted; the per-class tables above are counted by their
entries and are real.

**Checks** (all against the base 13ce5312, built from `git archive` in a separate tree):

* `bench-sim --ticks 300` digests: Island `15e3720088490242`, 00_Training `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`, the same before and after.
* `frame-alloc-meter.mjs --compare`: identical 600 frames on the three maps (`cebe25dcbba1f08a`, `398be1b404124a61`, `8dbcbfae1f441921`).
* `hud-stream-digest.mjs --frames 1500 --stream --compare`: identical (`16bfe2bd08ed1653`).
* `npm test`: 1,007 tests, 1,003 pass, 4 skipped, 0 fail (`test/instance-class-sharing.test.mjs` is new: layout owners and their shared
  cells, field table, handles and cleanup plan on DeusEx's real ScriptedPawn and decoration families, the instance's shared and extra
  parts, the state's frame and bits, the live cylinder's values; `test/host-members.test.mjs` and `test/script-bindings.test.mjs`
  take the accessors).
* Validators (`run-validators.mjs --filter F --jobs 1` for each of 34 filters, in an 8 GB scope): 44 pass, 1 skips (save-game: no Wine
  saves), 0 fail, for actor physics (native-actor-physics: 114 oracle cases, 0 mismatches; native-walking, walk-kernel, walk-loop,
  native-falling, native-rolling, native-swimming, native-encroachment, native-check-encroachment, collision-kernel, collision-hulls,
  pawn-move-kernel, pawn-physics-kernel, actor-tick), the cleanup and class-image ones (cleanup, property-destroy, object-image,
  object-layout, class-loader, native-goto-state, native-door-state, native-process-internal), spawn and decorations (script-spawn,
  script-decoration, plant-push, decoration-settle-roll, island-falling-water, island-swimming) and save and travel (save-snapshot,
  travel, travel-restore, save-load-play). `validate-script-process` fails with "levels left that a GC does not free (their runtimes
  stay alive): 01_NYC_UNATCOIsland", and it fails the same way, with the same output, on the untouched base 13ce5312 (a tree made
  from `git archive`): not this change's, and not looked at. `validate-load-saves` (all 41 internet save slots, one process each, in an 8 GB scope): 41 of 41 load, 0 stop by name.
* Tick cost, interleaved `bench-sim` pairs (Island, 120 warm and 300 ticks, four pairs, base first, on a host running the other
  worker's `validate-load-saves`): median of the tick medians 7.45 ms for both arms (base 7.19, 7.65, 7.80, 7.26; after 7.27, 7.62,
  7.56, 8.14), the CPU per tick 9.13 to 9.68 against 9.29 to 11.36 (the last pair's second arm met a load spike). No difference
  beyond the host's noise; the accessors read through one more object on the Rust glue's reads of `instance.cells` and `.arena`.
* Play once in Chromium worker mode and once inline (`?sim=inline`) on the Island (`hitch-run.mjs --mode roam --seconds 25`, the status read
  at the end): worker 2,451 frames, inline 1,981 frames, `runtimeError` null, no render errors, no errors in either; 305 props drawn.

**Not done, and why.**
* `ScriptProcess.linkedClasses.propertyLink` (143 K slots in the browser snapshot) holds a copy of the base's list for each class that
  declares no property; one shared array there would halve it (script-class-loader.mjs: `cls.propertyLink = [...cls.propertyOrder,
  ...base.propertyLink]`; `destructorLink` the same). It is in the class loader the other worker is changing, so it was left.
* The actor hosts' own state (the `sim.sprites` family, 624 K): `values` (a copy of the class defaults and the authored values for each host, which
  `...values` spreads in player.mjs, doors.mjs and the mover's collision values read as plain members, so a prototype chain is not
  transparent), the `initialProperty` closure with its `authored` Maps, `initialStorage` (an ArrayBuffer and a refs array for each
  host, for a property reset) and the four per-host state sets. Cutting them needs the readers audited one by one.
* The falling adapters (`script-actor-physics.mjs`, about 60 K slots, 13 K cells: 45 closures for each of the decorations that landed)
  as a class with prototype accessors, the instance's `imageToken` and its `FinalizationRegistry` entry (12 K of each: one record for
  each registration in SpiderMonkey) and `refs` (only 172 of 2,425 actors hold the class image's values, so a shared copy-on-write
  array saves nothing).
* The effect on Firefox's marking is not measured: the slots are the Chromium snapshot's estimate (the measure of "What marking visits"
  above).

#### Native slots out of the collector's marking (2026-11-10)

Step 1 of moving the script process's object model out of JavaScript objects (the families, their order and their checks are in
[object-model-plan.md](object-model-plan.md)). Host data layout only: every method of the structures keeps its results, and the output is
identical (the checks below).

**What was cut** (the load graph of the Island: 34,583 records, 820,000 native slots; 63% int32, 19% records, 11% null, 4.6% the package's
linker object, 1.1% byte arrays, 0.5% arrays, 0.3% uint32; no double, `-0` or NaN):

* `NativeSlots` / `LoadRecord` (`native-slots.mjs`, `load-record.mjs`): a slot that holds an int32 keeps it in an `Int32Array`, the others
  stay indexed elements of the record (304,000 of them, dense). The words are a block of a shared 4,096-word chunk, so a record has no
  typed array of its own (that would have been 35,000 more cells): the block is a header (its room and the elements used) and one word a slot
  position, either the int32 or `MIN + the element's rank` (so a read is one typed load and a compare; an int32 in the lowest 2^24 of the
  range is an element like any other value that is not a plain int). The kind of a slot is the store's, not the shape's, so the shapes stay
  the 304 of the write orders. A slot is an int slot until it is given a value that is not an int32 (a `-0`, a uint32, a double, a BigInt,
  a string, an object, a null) and an element slot from then on. The record has 16 named fields (a SpiderMonkey object has 16 fixed
  slots): `address` is an alias of `nativeAddress`.
* `record.instanceValues` and `record.defaults.data` (a `Map` each, 2,140 and 1,103 on the Island) are an `OffsetMap`: a `Map` subclass with
  the same API and `instanceof Map`, over the same chunks (the offsets and a word each in one block, a lookup a scan: the maps are read at
  class link and resource construction). A key that is not an offset, or a `delete`, makes it an ordinary Map for good.
* The graph's address -> record table keeps the synthetic addresses (every record's) as the elements of an array by ordinal.
* Left (see the plan): the 1,339 hash tables (229,000 record references: a lifetime question), `objectHash` (35,000 string cells), the
  named fields' numbers, `LoadEdges.records` (one element a held record, the strong hold the edges' lifetimes are defined by).

**Measured** (Chromium inline Island, 30 s after the arrival, `map-memory-census.mjs --snapshots 1`, `heap-families.mjs 4 40 --slots`; base
13ce5312 against the branch, same host and method; the snapshots were deleted):

| | Base | Branch |
| --- | ---: | ---: |
| Value slots (whole page) | 13.87 M | 13.23 M (-0.64 M, -4.6%) |
| SpiderMonkey-like cells | 1.55 M | 1.55 M |
| Objects / edges | 2.52 M / 20.1 M | 2.52 M / 19.7 M |
| `packageObjects.loadRecord` (slots) | 1,156 k | 919 k |
| `LoadEdges.records` | 569 k | 438 k |
| `loadRecord.instanceValues` | 164 k | 85 k (its OffsetMaps' elements and the objects they hold) |
| `loadRecord.defaults.data` | 127 k | gone (its maps are blocks; what they hold is counted under the first family that reached it) |
| `buildLinker.recordsOfAddress` | 115 k | gone |
| `loadRecord.hashBuckets` | 156 k | 156 k |
| `loadRecord.data` (the class FArrays' entries) | 123 k | 123 k |

The family figures are a first-reach attribution (an object goes to the first path the walk met), so a cut moves objects between families;
the whole-page sum is the figure to compare. It fell by less than the 2.3 M slots of the six families: the estimator counts V8's element
capacity, and the records' named fields (16 a record, 550,000 slots) are what is left of them, with the 304,000 elements and the other
families above. The int words are not in the figure at all: they are in chunks (about 250 of them), outside the heap's objects.

**Checks** (output identical to the base; on a572e084):
* bench-sim digests, 300 ticks: Island `15e3720088490242`, Training `148077479825af78`, 747 `ad8e591a01434df5`; `frame-alloc-meter --compare`:
  Island 600 frames, 747 and Training 400, identical; `hud-stream-digest --frames 1500 --stream --compare` identical (`16bfe2bd08ed1653`).
* `npm test`: 1,013 tests pass (the new ones: the slot store against the Map it replaced for every kind of value and the edges of the int
  range, `OffsetMap` against `Map`, stores sharing chunks while they grow past the chunk size, a record's named fields).
* Validators (`run-validators --filter`, 8 GB scopes, the captures of `.work/travel` and the saves of `.work/internet-saves` linked in): 68
  validators in 42 filters, 66 pass, 1 is skipped (a `validate-save-game` case that needs the Wine capture `wc1`), covering the load graph (font, mesh, sound, music, texture, static, dynamic), class loader and link, linker, state,
  defaults and class-default-travel, config, property, process-collection, original-loaded, object layout and image, save-game,
  save-load-play, save-snapshot, save-directory, save-info-corpus (41 files), load-saves (41 of 41), root-snapshot, process-memory,
  travel (all ten), island and instructor conversations, inventory-spawn, weapon-construction and play-hud. One fails: `validate-script-process`,
  identically on the unchanged base 13ce5312 ("levels left that a GC does not free: 01_NYC_UNATCOIsland"); it is not from this change.
* Play in Chromium on the Island, 40 s roam each: worker mode 3,386 frames, `?sim=inline` 2,927 frames, no errors.
* Two mistakes the checks caught on the way: a store field named `base` that a record already had (the class-link validators failed
  at the first class), and a first version that kept each slot's kind in the shape: 6,935 shapes and 25 MB of position tables against 304
  (the census's `heap-families --inside` showed the shapes). A third was a unit test whose failing `assert.equal(shapeA, shapeB)` made
  node inspect the whole shape graph without a depth limit (75 GB, the app's OOM kill of 2026-11-10); the tests compare shapes and
  records with `assert.ok(a === b)` now.

**Load time** (headless boot of the map and the player's login, `bench-sim --ticks 3`, interleaved base and branch, six rounds an arm; the
base is a clean copy of 13ce5312): the first layout (a code a slot and the ints by rank) cost 447 ms on the Island (+6.9%); the profile put
178 ms of it in `NativeSlots.value`, which became one typed load a read. On a quiet host the Island's boot is 5,525 ms against 5,557
(+0.6%; process CPU +0.3%), the 747's 3,817 against 3,898 ms (+2.1%; CPU +2.6%), Training's 3,841 against 3,910 (+1.8%; CPU +1.5%). Measured
with other jobs running (four to six rounds, wall only) the Island read +3.3% to +5.0% and the 747 +2.4%: the spread is the host's. Taking
`OffsetMap` back to `Map` in a scratch copy, and the old slot store back with the new `OffsetMap`, each put the Island within 1% of the
branch (the spread of the runs); the profile's remaining difference is `value` (247 ms of self time against 335), `assign`/`put` (27 against 58) and the
offset map's scan (17). So the load costs 30 to 90 ms on a boot of 3.8 to 5.5 s; the 7.3.x rows' margins are not re-measured here.

**Marking.** Not measured: the interleaved Firefox A/B is run on master with the other worker's cut. What this change gives the marker is
0.64 M fewer value slots by the estimator, 0.4 M fewer edges, and no change in the cell count (1.55 M): if the marking follows cells, it
moves little; if it follows slots, about the 4.6% of them.

#### All four cuts against the base, interleaved (2026-11-11)

The method of "Both cuts against the base": four interleaved pairs of 100 s Firefox inline Island roams with markers-only profiles,
the base 036d848a against master 0da32296 (the light maps and triangles, the actor mesh closures, the runtime's instance state and the
native slots: about 1.93 M to 1.48 M cells and 13.9 M to about 12.2 M value slots, the last summed from each cut's own measurement).
Runs in `.cache/perf/gc-pauses/ab/r2-*`. Pair 1 ran on a disturbed host (page p50 16.3 and 14.0 ms against 10.7 to 12.7 in the other
pairs) and is left out of the reading.

| Run | Page p50 | Gaps over 50 ms (a minute) | `FULL_GC_TIMER`: wall, work (mark), extended (ms) | `CC_FINISHED`: wall, work (mark), extended (ms) |
| --- | ---: | --- | --- | --- |
| base 2 | 12.4 | 3 (1.9) | 2,150 ms, 165 (125), 6 (93) | 1,858 ms, 116 (104), 6 (68) |
| base 3 | 11.1 | 1 (0.6) | 1,838 ms, 150 (111), 6 (80) | 1,869 ms, 134 (121), 4 (11) |
| base 4 | 10.8 | 2 (1.2) | 2,390 ms, 196 (115), 3 (116) | 1,923 ms, 137 (122), 6 (19) |
| master 2 | 12.7 | 3 (1.9) | 2,069 ms, 164 (135), 6 (127) | 1,852 ms, 124 (95), 5 (63) |
| master 3 | 10.7 | 3 (1.9) | 1,893 ms, 133 (96), 5 (78) | **747 ms**, 111 (98), 0 |
| master 4 | 10.7 | 0 (0) | 1,779 ms, 136 (99), 6 (73) | **951 ms**, 112 (99), 0 |

* **`CC_FINISHED`** marks 95 to 99 ms against 104 to 122 (-19% by the medians), and in two of three clean master runs it finished in
  under a second with no extended slice, which no base run here or in the earlier A/B did.
* **`FULL_GC_TIMER`** marks 96 to 135 ms against 111 to 125 (about -9%) and still runs past 1.5 s in every run, with five or six
  extended slices.
* **Gaps:** 1.9, 1.9 and 0 a minute on master against 1.9, 0.6 and 1.2 on the base: no difference this sample can show.

**Reading.** About 12% of the slots out of the heap took a fifth off the second collection's marking and sometimes brings it in before
the escalation; the full collection (all four zones, the atoms zone's sweep with it) stays over. The row is unchanged. The next steps
are the ones `docs/object-model-plan.md` orders (hash buckets, the load records' remaining fields, linked classes and operands,
function trees, identities), each measured the same way.

#### The linked classes' defaults and property links (2026-11-11)

Step 3 of [object-model-plan.md](object-model-plan.md): the script process's per-class tables (`linkedClasses.defaults`, `.propertyLink`, `.destructorLink`, and
the copies of the defaults that class images and attached objects held). Host data layout only: every method of the structures keeps its results, and the
output is identical (the checks below). Code: `defaults-map.mjs`, `class-link-lists.mjs`, the class loader's link loop, `class-defaults-snapshot.mjs` and
the class image in `script-runtime.mjs`. **Status: done and checked on the final code (the checks below); not yet measured in Firefox.**

**What the Island held** (a scenario of `bench-sim` read at tick 30 on the headless Island, base 29168214; 967 classes linked):

* `cls.defaults`: 85,437 entries in 967 tables; 75,126 of them (88%) are the base's entry again (the same value Map), 4,286 differ from it and 6,025 are
  fields the base has no default for. Only 97 classes' tables equal the base's whole. The value Maps: 10,311 different ones for 13,324 entries; 9,782 have one
  entry (6,986 a scalar at index 0, with 1,873 different values; 2,793 an object or array at index 0, 2,324 different), 529 have more (463 different
  contents). The plan's guess of 25,000 inner Maps (made from the browser snapshot's 24,000 objects) was 10,300; most of the redundancy was in the outer tables, not in
  the inner Maps.
* Every one of 302 class images and each class's attached-object snapshot was a flat copy of the whole table (`new Map(cls.defaults)`): `classImages.defaults`,
  77 K slots, and the snapshot copies.
* `propertyLink`: 455 of the 967 classes declare no property and held a copy of their base's list (219,386 entries over the 967 lists; 512 different
  contents). `destructorLink`: 8,588 entries, 145 empty lists, 221 different contents among 967 arrays.

**What was cut:**

| Structure | Was | Is |
| --- | --- | --- |
| A class's defaults table (`DefaultsMap`) | a `Map` of every field with a default, the base's entries copied at the link | its own entries (10,311 on the Island: the ones that differ from the base's, plus the class's own fields) over a frozen layer; a base's entry the class has no values for is hidden. `get`, `has`, `size` and the entries are those of the flat table holding the same writes (a randomized model test); `version` counts `set`, `delete` and `clear` as before |
| A class image's `defaults` and an attached object's snapshot | `new Map(cls.defaults)` each | `cls.defaults.snapshot()`: the table's entries become a frozen layer the table stands on (a later write is an overlay on it), so the image, the objects and the classes linked from this one share it; a table nobody wrote since returns the layer it has, and `sameDefaults` is true at once for it. A table with more than 24 layers is flattened (a default rewritten between snapshots again and again) |
| A default's values (index -> value) | a `Map` each, 10,311 | `DefaultValues`, a `Map` whose `set`, `delete` and `clear` throw: the Maps are shared, and a writer would change every class that shares one. A scalar at index 0 (7,000 of them) is one object a value (1,873): the table holds only values with no reference, so it keeps nothing of a purged class, and a NaN is not merged (`Object.is` does not tell its bits apart); `-0` is its own |
| `propertyLink` and `destructorLink` of a class that declares no property | a copy of the base's arrays (219,386 entries over the 967 lists) | the base's arrays themselves; `destructorLink` is also the base's when none of the class's own properties has a destructor (512 arrays were 221 contents) and is otherwise `[...own with a destructor, ...base's]`, which is the filter of `[...own, ...base's list]` |

What a reader sees is unchanged, with one exception: the order of the entries when a table is iterated (its own entries, then the layers'; the flat table's was
the property list's). Nothing depends on it: the class loader's collection of the class-valued defaults, the one reader that did, takes the values while it makes
the entries, in the property list's order. A changed default replaces the class's entry as before (nothing writes a value Map in place: the grep of every
`defaults.get`/`set` site found none, and `DefaultValues` throws if one appears). A class links against its base's table as it is at the link loop, as it
copied it then. The class image is rebuilt exactly when it was (the version check), or not at all when the table is provably equal: with the value Maps shared, a
`refreshConfigDefaults` that rewrites equal values, or a default written back to what the image has, is no longer a change by `sameDefaults` (the image built from
equal contents is equal). Link arrays: nothing changes one (grep of every `propertyLink`/`destructorLink` reader); `FREEZE_LINKS=on` (Node's environment) freezes
them and checks each class's `destructorLink` against the filter, and the digests and validators run with it. `layoutOwner` and the Rust VM's chain check read
the lists by their members, as before (`layoutOwner` answers at once for an identical array).

**Slots** (Chromium inline Island 30 s after the arrival, `map-memory-census.mjs --browser chromium --sim inline --maps 01_NYC_UNATCOIsland --settle 30
--snapshots 1`, `heap-families.mjs 4 300 --slots`/`--sm`; the base's snapshot (29168214) against the final code's, same host and method):

| | Base | Branch |
| --- | ---: | ---: |
| Value slots (whole page) | 12,133,600 | 11,684,788 (-448,812, -3.7%) |
| SpiderMonkey-like cells | 1,485,826 | 1,480,334 (-5,492, -0.37%) |
| Objects / edges / JS heap | 2.45 M / 18.7 M / 175 MB | 2.44 M / 18.1 M / 171 MB |
| Page JS after forced collections (census row) | 173.3 MB | 168.8 MB |
| `linkedClasses.defaults` (all its subfamilies) | 322 K slots, 13 K cells | 59 K slots, 6 K cells (`.own` 40 K, `.parent.own` 12 K, the table objects 7 K) |
| `ScriptRuntime.classImages.defaults` | 77 K, 0 K cells | 24 K, 2 K cells (`.own` 22 K) |
| `linkedClasses.propertyLink` | 142 K (0.45 M edges) | 59 K (0.18 M edges) |
| `linkedClasses.destructorLink` | 9 K | 2 K |
| `ScriptRuntime.lastLinkedInstance.cls.defaults` | 3 K | gone |
| The five families | 553 K slots, 15 K cells | 144 K slots, 9 K cells |

The structure afterwards
(the same `bench-sim` scenario probe on the branch at tick 30, taken before the last cut, that of `destructorLink`): 967 tables, 413 frozen layers reached, 881 own Maps
with 10,311 entries in all (the 4,286 + 6,025 above, counted from the other side), the visible entries unchanged at 85,437, at most 8 layers under a table; 5,198
value Maps (from 10,311: the 1,873 scalar ones, the 2,793 with an object, 529 with more entries); 512 `propertyLink` arrays holding 92,459 entries (from 967
arrays and 219,386). The cells moved little: about 5,100 value Maps and 455 arrays went, and the layers and own Maps cost about 1,300 new objects (413 and 881); the
cut is in the references (449 K slots, 0.6 M edges), which is what the plan expected of a step that keeps the objects' lifetimes.

**Checks** (all on the final code, commit of this section, against the base 29168214 and the reference files of `.cache/perf/heap-d/ref/`; every heavy run under the flock
and an 8 GB scope):

* **Output identical.** `bench-sim --ticks 300`: Island `15e3720088490242`, 00_Training `148077479825af78`, 03_NYC_747 `ad8e591a01434df5`, the same as the base, plain
  and (an earlier run of the same code) with `FREEZE_LINKS=on IMAGE_CHECK=verify`, where the class image's version and the full walk agree at every construction.
  `frame-alloc-meter.mjs --compare`: identical, Island 600 frames (`cebe25dcbba1f08a`), 00_Training 400 (`17bd229a3923df21`), 03_NYC_747 400 (`246552d18332b537`).
  `hud-stream-digest.mjs --frames 1500 --stream --compare`: identical (`16bfe2bd08ed1653`). The ten tick-A/B runs below (warm 120, 300 ticks) all end at the digest
  `611cd27609ddab78`, base and branch alike.
* **`npm test`**: 1,028 tests, 1,028 pass, 0 fail, 0 skipped.
* **Unit tests** new in this change: `defaults-map.test.mjs` (60 seeds of 500 random `set`/`delete`/`clear`/`snapshot`/derive steps against a flat Map model: contents, size,
  version and every earlier snapshot; frozen layers throw; a derived table keeps its base as it linked; layers that pile up; `DefaultValues` immutable; scalar
  interning and its edges: `-0`, NaN, kinds, objects, index 1) and `class-link-lists.test.mjs` (shared and own arrays, own-first order, the filter's equality).
* **Validators**, `npm run validate -- --jobs 2 --filter F` for each of 38 filters with `FREEZE_LINKS=on` (links frozen: no writer; `destructorLink` checked against
  the filter at every link): 172 pass, 2 skip, 0 fail. The filters: class-loader, class-default-travel, class-import, config (8), object-image, object-layout,
  object-properties, object-handles, state (3), linker (3), property (4), spawn (7), decoration, cleanup (4), save-game, save-load-play, save-snapshot,
  level-save, load-game, load-saves (all 41 internet slots), travel (10), island (10), instructor, play-hud, script-process, process-collection, process-memory,
  original-loaded, inventory-spawn, weapon-construction, window (92 pass, 1 skip: `validate-window-scene-frame`), gc-underline, loadmap (2), script-class-bind,
  native-process-internal, world-destroy, end-load, npc-weapon-startup. The other skip was `validate-save-game`'s case C, which needs `.work/play-saves` (not linked in
  the worktree at first); with it linked the validator passes with no skip.
* **Tick cost**, interleaved `bench-sim` pairs (Island, `--warm 120 --ticks 300`, five pairs, the first of a pair alternating, the base a `git archive` of 29168214,
  under the flock): tick medians base 4.34, 4.54, 4.48, 4.40, 4.34 ms and branch 4.27, 4.55, 4.34, 4.31, 4.34 ms; **median of the medians 4.40 ms against 4.34 ms
  (-1.4%)**, mean of the means 4.648 against 4.572 ms (-1.6%), CPU a tick (median) 5.91 against 5.76 ms (-2.5%): no difference beyond the spread of one run.
* **Boot time** (`bench-sim --ticks 3 --warm 0`, five rounds an arm interleaved, the host loaded, load about 5): base 5,438, 5,181, 5,180, 5,430, 5,262 ms (median 5,262),
  branch 5,148, 5,168, 5,133, 5,336, 5,280 ms (median 5,168): -1.8%. The boots of the tick pairs (quiet host): base 5,732, 5,804, 5,758, 5,724, 5,763 ms (median 5,758),
  branch 5,653, 5,853, 5,751, 5,751, 5,529 ms (median 5,751): -0.1%. The link loop reads the base's entry for every field through the layers (a probe: 26 ns a read
  at 8 layers against 4.7 ns in a flat Map, about 220,000 reads at the boot), which the boot does not show; in the steady state the table is read about 44 times a tick.
* **Play**, Chromium, Island, `hitch-run.mjs --mode roam --seconds 25`, the status read at the end: worker mode 2,413 frames (1,812 drawn), `?sim=inline` 1,967 frames
  (1,794 drawn); `runtimeError` null, not paused, no page error, no error event in either. The worker run's longest gap between drawn frames after the load is 83 ms
  once (1 gap over 50 ms); the inline run has four gaps over 50 ms, 350 ms and 5,583 ms at 5 s and 683 ms at 11 s of the page's clock (the map load, which inline mode runs
  on the page's thread) and one of 83 ms at 11.6 s; the base's inline roam has the same load gaps (317 ms, 5,666 ms and 683 ms) and two small ones (67 and 83 ms) at about 11.8 s: no gap over 83 ms after the load in either.

**Left.** Classes that declare properties still hold their own `propertyLink` (512 arrays, 92 K entries): a persistent list would change the readers' array API.
The 2,793 value Maps with an object or array at index 0 are not merged (a table keyed by identity would keep a purged class's references; 2,324 different
identities, so at most 470 Maps). The class tables' own Maps (881) and layers (413) are separate objects from the table that holds them; folding them into one
would save up to 1,300 cells. Marking time is not measured here: the interleaved Firefox A/B runs on master.

## How each step is measured

* **Headed only:** a visible, uncovered window on the 240 Hz display. Headless Firefox and Chromium do not pace frames like a display.
* **Quiet machine:** first check `top` for other sessions' validators and the user's own tabs.
* **Comparison:** `hitch-ab.mjs`, interleaved arms, medians of per-run phase means. Fix the browser at Firefox inline.
* **Profiles:** use the dev server, so the profile names functions. On a production build, run `vite build --minify false` first.

## Open questions

* Whether Battery Park can reach 16 ms inline. Steps 1 to 4 as estimated take its p50 from 26 to 13 to 19 ms. That is not enough
  unless its slow tenth falls by more than half as well. Its tail is mostly perception's light level, half of it the JavaScript line
  checks. (2026-11-07, [Battery Park at rest](#battery-park-at-rest-2026-11-07): the four-heading route is under 16.7 ms at p95 today, the
  map start is at 17.5 ms p95 (16.75 with the unshipped bundle) and the rest spot at 20 ms (17.7 ms mean) with the matrix-walk family; the profile there is flat.)
* The Mac: its tick was about 1.35 times this host's in Chrome. Firefox there is unmeasured since October.
