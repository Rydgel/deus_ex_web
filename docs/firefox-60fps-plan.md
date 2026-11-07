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
* **Sessions late in a pair run slower.** In both bunker A/Bs, each session ran slower than the one before it in its pair, by about
  0.4 ms of tick: compare the arm that ran third with the same arm run first. An A/B that always runs its arms in the same order
  carries that drift into the difference. `hitch-ab.mjs` now alternates the order from pair to pair.
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
