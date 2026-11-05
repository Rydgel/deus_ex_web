# Memory across many maps (Stage 7, rows 7.4.1 and 7.4.2)

The question (2026-11-04): Play's memory grew with every distinct map one browser visited. The first Firefox travel census
([load time](load-time.md#the-stage-7-rows-2026-11-04-linux), one Firefox in inline mode through the 83 single-player maps by the
console's `open`) was killed by the kernel's OOM killer at its 16 GB cap after 80 travels in 12 minutes, and Chromium's run (worker
mode) peaked at 7.5 GB for the browser and the harness. The [one-hour session](long-session.md) did not see this: its warm-up visits
all ten of its maps before the plateau is taken. This note separates what a process keeps because the original's process keeps it
from what Play should release, and records the four faults found and fixed. Host measurement only: nothing here changes what the
simulation computes.

## The harness

`node scripts/map-memory-census.mjs [--browser chromium|firefox] [--count 40] [--gc minimize|report|none] [--no-hitchlog]` (starts its
own dev server; one browser, one page, one script process). The debugging page's first map (Training), then the console's `open` to
each map of the 83 in name order (or `--maps`, `--from`, `--count`), and at each arrival, after three seconds:

* **`--gc minimize`** (the default): the heaps after forced collections, as `session-hour.mjs` reads them. Chromium:
  `HeapProfiler.collectGarbage` three times in the page and in the worker, then `Runtime.getHeapUsage`, each realm's live Wasm
  memories (the hitch log's) added to its buffers. Firefox: a Gecko memory report after its minimize (SIGRTMIN+1, Linux only).
* **`--gc report`** (Firefox): the memory report as it is (SIGRTMIN), no collection forced: what the browser holds when nothing
  forces it, as in a player's session and in the travel census that hit the OOM.
* **`--gc none`**: no reading of the heaps at all, the process tree's RSS only.

Each reading also has the process tree's RSS before and after (split by process kind: Chromium's `--type`, Firefox's content
process kind), the page's asset store (`assetsProbe`), and the simulation side's script process (`processProbe`, process-probe.mjs:
its classes, the asset store's packages and released cache, the packages the class loader's graph prepared, the script-VM kernel's
blocks, the realm's Wasm memories with the line that made each, and the interpreters the process-wide WeakRef walks reach).
`--snapshots i,j` writes Chromium heap snapshots at those arrivals; `--gc-logs i` has Firefox write its GC and CC edge logs
(SIGRTMIN+2). `<out>.json` is written after every arrival; `--summary <out>.json` prints the table.

**`?hitchlog=1` and Firefox.** The hitch log reads every Wasm memory through a `WeakRef` (hitch-wasm.mjs: each second on the page,
each frame in the worker). In SpiderMonkey a `WeakRef.deref()` during incremental marking marks its target, so with the hitch log
Firefox's incremental collections keep every Wasm memory ever made (each left level's object arena) until a non-incremental
collection; the readings after Gecko's minimize are not affected (it collects non-incrementally). `--no-hitchlog` runs the page as a
player opens it; the Wasm memories are then counted by Gecko's report only.

## What the original keeps, and what Play should release

The original loads its startup packages and their classes once per process, and LoadMap's collection
(`UObject::CollectGarbage(RF_Native)`) frees what the level left behind: the level's own objects, the resources only it referenced
(USound, UTexture...), and the packages whose linker no live object or held linker reaches
([class graph design](class-graph-design.md), script-process-collection.mjs). Play models that collection over its script process:
the classes and the packages they hold stay (a class first used on a later map stays from then on, where the original's startup
loads DeusEx.u whole, so Play's process reaches that state over a session instead of at its start), and the packages the collection
unloads leave the asset store for a released cache bounded at 64 MB.

What a level's page and host state hold (its world, textures, GPU objects, the level runtime and its object arena, its occlusion and
collision tables) has no counterpart that outlives the level: Play should release it with the level, and the kernels that outlive
levels should reuse what the levels freed.

## The faults (2026-11-04, Linux)

Measured with the harness above in Chromium (worker mode) and Firefox (inline mode), 40 maps (Training to Hong Kong's VersaLife).

1. **Firefox kept every left level alive.** `script-vm-rust.mjs` keeps each level's interpreter in a process-wide set of `WeakRef`s
   (`interpreters`), walked on every handle release, receiver epoch and state change, and `script-vm-events.mjs` its event hosts the
   same way; a level's host never left them. These walks run many times a frame, so in SpiderMonkey (the read barrier above) each
   left level's interpreter, and with it its runtime and its object arena, was marked by every incremental collection. Without a
   forced collection (`--gc report`), the page's Wasm memories went 5, 6, 7 ... 26 over 22 maps (99 to 1,232 MB) and the tree's RSS
   2.1 to 4.5 GB, every arena kept although Gecko's own collections halved the JS heap twice; without the hitch log the same: the
   Wasm memory 100 to 1,008 MB over 16 maps, RSS 2.2 to 4.7 GB (about 120 MB a map, the OOM's slope). With incremental collection
   turned off (`javascript.options.mem.gc_incremental` false) the arenas went at the next collection (10 memories to 6). Chromium was
   not affected (V8's WeakRef reads do not mark), but its walks still wrote into every left level's tables until V8 collected it.
   Now the host's dispose takes the level's interpreter and event host out of both sets (`RustScriptVm.dispose`), and detaches its
   arena (below).
2. **A left level's arena waited for every one of its objects' finalizers.** Each script object's image token, held by the
   process-wide `imageFinalizer`, referenced the arena, so a left level's memory lived until the last of its objects was collected
   and its cleanup had run, and then until another collection. The token reaches the arena through the arena's owner cell now, which
   `ObjectArena.detach` (the host's dispose) clears: the memory goes with the level's last reference.
3. **The conversation speech packages were never released.** script-conplay-live.mjs prepares, at each level's start, the packages
   holding the speech of the level's conversations, InfoLinks and barks (`DeusExConAudio*.u`, 0.7 to 30 MB each, 200 MB in all),
   because GetSpeechAudio's `StaticLoadObject` runs inside a synchronous native frame. A package the class loader's graph prepared
   stayed prepared for the process's life (`packageAssets`), so LoadMap's collection could unload its linker but not its bytes. In
   Chromium the worker's prepared packages went from 26 (130 MB) to 34 (231 MB) over 40 maps, a mission's speech each. The original
   loads that speech when a conversation plays and its collection unloads the package when nothing holds it, which Play's collection
   already models (it lists the package as unloaded). A package prepared for one level only (`prepare(asset, {level: true})`) now
   leaves the graph when the collection unloads it, and the asset store releases its bytes like any unloaded package's; the next level
   prepares the speech it needs again. Every other prepared package stays (a body prepared once may load from it synchronously).
4. **The trace kernel's arena grew with every distinct map.** The kernel instance holding the BSP models and collision hashes
   (trace-kernel.mjs, one a realm) used `ObjectArena`'s exact-size reuse: a freed range served only a later request of the same
   size, so each map's models, sized by its own BSP, took fresh space at the top (Firefox: 6 to 68 MB over 40 maps; Chromium's worker
   alike). Its arena coalesces now (`new ObjectArena(64, {coalesce: true})`: an address-ordered free list merged with its
   neighbours and given back to the top, best fit with a split, as the script-VM kernel's block allocator since the one-hour
   session). A level's own arena keeps exact-size reuse, so object image bases are unchanged.

Not faults, and kept:

* **The classes and the packages they hold.** 918 classes on the first arrival, 1,173 after 40 maps, the same in both browsers and
  in Node (`validate-process-memory.mjs --maps`), with the worker's JS heap 122 to 171 MB in Chromium: the original's process holds
  its startup packages' classes from the start.
* **The script-VM kernel's high-water mark** (Firefox's page, Chromium's worker): 60 to 148 MB over 40 maps while its live blocks
  stay 45 to 65 MB: a travel builds the next level's occlusion (a 32 MB work block and the model's tables) before the last one goes,
  so the memory holds the largest pair of consecutive levels. A Wasm memory never shrinks.
* **Galaxy's samples.** The effect voices register each sound once per page (galaxy-music-library.mjs `registered`, the worklet's
  sample heap), and Play never runs UnregisterSound (`0x10606cd0`, glxUnloadSample: [effects](galaxy-music/effects.md) §1), as it
  destroys no USound. Bounded by the game's WAV sounds (DeusExSounds, Ambient and MoverSFX: 30 MB in all); a fidelity gap, not a
  growth. Speech records keep 0x48 bytes each; their PCM is released when no voice plays it.
* **Garbage between collections.** Without forced collections both browsers hold the last levels' garbage until their own
  collector runs: in Firefox every five to seven maps (the JS heap 200 to 600 MB and the ArrayBuffers 400 MB to 1 GB between two).

## After the fixes (2026-11-04, Linux, this tree)

The whole census, the 83 maps from Training (`.cache/perf/map-memory/`, outside Git):

| | Chromium (worker) | Firefox (inline) |
| --- | ---: | ---: |
| after forced collections: first arrival, last, highest | 792, 1,148, 1,354 MB | 581, 734, 1,181 MB |
| after forced collections: the tree's RSS, highest | 2,641 MB | 2,762 MB |
| after forced collections: slope over the last 42 maps | 3.8 MB a map | 1.8 MB a map |
| nothing forced: the tree's RSS, highest | 7,393 MB | 9,443 MB |
| before the fixes, nothing forced | 7.5 GB (the load census, with its harness) | killed at 16 GB after 80 travels |

Before the fixes, over the first 40 maps with forced collections, Chromium's total rose from 800 to 1,167 MB (highest 1,285) and the
worker's prepared packages from 26 (130 MB) to 34 (231 MB); after them, 792 to 990 MB (highest 1,110) and 26 packages throughout (24
to 26 over the 83). The page is flat in both browsers (Chromium's 264 to 473 MB by map); Chromium's worker JS heap stays at 160 to 210
MB once the classes stop growing (1,258 classes after the 83, the same count in both browsers). The trace kernel's arena holds 9 to 20 MB
(68 MB at map 40 before).

**Row 7.4.1's sequence in the page** (`--maps` the Island and Training ten times, forced collections): every Training arrival holds
the same process state (990 classes, the same 46 packages and the same page store), and the page's heaps are flat. The total rises
9.6 MB a round trip in Chromium (902 to 988 MB at Training) and 8.1 in Firefox (731 to 804 MB): about half of it the level's object
arena (32 to 76 MB at Training, the same in both browsers) and the rest the purged meshes' lazy arrays, both below. With the meshes
destroyed as the original destroys them (2026-11-05, below) the rise is 6.9 MB a round trip in Chromium (899 to 961 MB) and 5.2 in
Firefox (728 to 775 MB).

**Without forced collections** both browsers now reach the 83rd map. Firefox's content process still climbs (1.2 to 8.5 GB) because
Gecko's collector runs every five to seven maps under a page that never idles (inline mode: the simulation and the drawing on one
thread), and each left level's object arena, the largest part of its garbage, grows over the session (below): from map 56 on it is 150
to 220 MB a level, and Gecko collects them late.

## Left: the handle tables

Handles are never reused (script-object-handles.mjs: a stale one resolves to no object, not another), and each level's interpreter
builds its tables over every handle the process has allocated: the class table (4 bytes a handle), the receiver table (16) and the
state table (16, script-vm-states.mjs), each sized to twice the highest handle when the level starts and doubled again as the level
allocates. A map change allocates about 10,000 handles (825,000 after the 83 maps; about 9,800 a map change over the round trips), and
a level's object arena grows by about 2.4 MB a map change (Training's 32 MB on the first round trip, 76 MB on the tenth; 221 MB for the
smallest maps at the end of the census), with the arena's growth by half and the doubled tables' old copies, which its exact-size free
lists cannot reuse. This is the remaining slope after forced collections in both browsers, and in Firefox it is what makes the late
garbage large. Bounding it touches the Rust interpreter's table lookups (`class_entry`, `receiver`, `state_entry` index flat tables,
and a released handle's RELEASED entry is what makes its pointers read None) or the never-reused rule: paged tables, or tables over
the handles a level can reach, with the process's own handles answered another way. Not done here.

## Purged meshes' lazy arrays (fixed 2026-11-05)

The rest of the round trips' rise (about 1.4 MB a travel) was in the worker's ArrayBuffers outside the Wasm memories and the packages.
Heap snapshots of the worker at the second and the tenth Training arrival (`--snapshots 4,20`, heap-families.mjs) put it under the
level's actors: 1,630 ArrayBuffers (12.9 MB) then 2,046 (35.6 MB), reached through an actor's mesh identity, its load record, a lazy
array there and its `archive`, the linker archive of the mesh's package: `archive.lazyLoaderArray` (ULinkerLoad's LazyLoaders, +0x434)
held more than 396 lazy arrays, each with the bytes it loaded (`array.data`, up to 1.1 MB). The collection purged a level's meshes
(their records detached, and the next visit loads them again from the same held package, DeusExCharacters among them), but nothing
detached the purged meshes' lazy arrays from that archive, so every generation stayed.

In the original the collection destroys the mesh: PurgeGarbage's second pass runs ~ULodMesh and ~UMesh, and each TLazyArray's
destructor calls its archive's DetachLazyLoader; a linker the same collection unloads has already detached every loader in its
Destroy (DetachAllLazyLoaders(0)). [Mesh destruction](mesh-destruction.md) records the trace and how Play now runs both, compared call
by call with the original destructors in Unicorn. In Node the held linkers' lazy-loader arrays went 768, 1,032, 1,092, 1,300, 1,360
loaders over DX, Training and the Island twice (+268 a round trip, all purged LodMeshes'); now 752, 956, 808, 956, 808. In the page
(Chromium, worker, the same 21 arrivals with forced collections, `.cache/perf/map-memory/rt-destroy*`): the actors' family holds 9.3
MB of backing stores in 1,530 ArrayBuffers at the second Training arrival and 10.5 MB in 1,530 at the tenth (12.9 MB in 1,630 and
35.6 MB in 2,046 before); the total at Training goes
899 to 961 MB (902 to 988 before), the worker's buffers 408 to 463 MB (411 to 492), and the slope over the last eleven arrivals is 3.6
MB a map (5.0 before; worker buffers 3.3, 4.7 before). Firefox (inline, the same arrivals): 728 to 775 MB at Training (731 to 804
before), slope 3.5 MB a map (4.9 before), no error in either browser. What is left is the handle tables' growth above, including the
step at the eighth round trip where the level's arena grows by half (in every run).

The other resources the collection purges (textures, sounds, music, fonts) attach no lazy loader in Play: the graph leaves their
records unloaded (RF_NeedLoad), so no other kind accumulates on a held linker.
