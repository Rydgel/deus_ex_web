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

**Left.** Every one of these four is a small share of a tick that is spread thin. The bunker's slow tenth is `js_eval` (3.62 against 0.83 ms a frame: the JavaScript calls `AttachDecal`, `DetachDecal`,
`SetHitColor` and the spawns), not these imports. A route to 0.5 ms from this list is translation of whole families, not cuts:
`WalkTexture` and the prelude's inputs in Rust, `GetPlayerPawn` as a Rust node over a host-maintained cell (no crossing), the
`refresh` skip; each is about 0.1 ms.

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
