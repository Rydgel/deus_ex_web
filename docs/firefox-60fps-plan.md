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
  level's host work around the batch.
* **Not a port: decals.** They are already Rust. The decal attach is 0.78 of `AttachDecal`'s 0.90 ms in the bunker's slow frames and
  averages 0.55 ms per frame there, 0.11 ms on the Island. Making it faster means changing the Rust algorithm, and only the bunker
  would gain much.
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

  On the synthetic 60 Hz clock, eight maps keep every frame at p95; the Island and the bunker drop to 30 Hz at p95. Four maps are
  still over 16.7 ms at page p95 (the Island, Battery Park, the Airfield and Wan Chai by 1 to 4 ms; the bunker by 6). The row verdicts
  (7.2.2, 7.2.4) need the headed set on a visible window.
* **Sessions late in a pair run slower.** In both bunker A/Bs, each session ran slower than the one before it in its pair, by about
  0.4 ms of tick: compare the arm that ran third with the same arm run first. An A/B that always runs its arms in the same order
  carries that drift into the difference. `hitch-ab.mjs` now alternates the order from pair to pair.
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

## How each step is measured

* **Headed only:** a visible, uncovered window on the 240 Hz display. Headless Firefox and Chromium do not pace frames like a display.
* **Quiet machine:** first check `top` for other sessions' validators and the user's own tabs.
* **Comparison:** `hitch-ab.mjs`, interleaved arms, medians of per-run phase means. Fix the browser at Firefox inline.
* **Profiles:** use the dev server, so the profile names functions. On a production build, run `vite build --minify false` first.

## Open questions

* Whether Battery Park can reach 16 ms inline. Steps 1 to 4 as estimated take its p50 from 26 to 13 to 19 ms. That is not enough
  unless its slow tenth falls by more than half as well. Its tail is mostly perception's light level, half of it the JavaScript line
  checks.
* The Mac: its tick was about 1.35 times this host's in Chrome. Firefox there is unmeasured since October.
