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
Firefox (728 to 775 MB); with the handle tables bounded too ([below](#the-handle-tables-2026-11-05-linux)), 1.9 MB a round trip in
Chromium (898 to 915 MB; 0.4 after the script-VM kernel's one step to its high-water mark) and 0.4 in Firefox (729 to 733 MB).

**Without forced collections** both browsers now reach the 83rd map. Firefox's content process still climbs (1.2 to 8.5 GB) because
Gecko's collector runs every five to seven maps under a page that never idles (inline mode: the simulation and the drawing on one
thread), and each left level's object arena, the largest part of its garbage, grew over the session: from map 56 on it was 150
to 220 MB a level, and Gecko collected them late ([the handle tables](#the-handle-tables-2026-11-05-linux) bound it since).

## The handle tables (2026-11-05, Linux)

**The growth.** Handles are never reused (script-object-handles.mjs: a stale one resolves to no object, not another), and each level's
interpreter built its tables over every handle the process had allocated: the class table (4 bytes a handle), the receiver table (16)
and the state table (16, script-vm-states.mjs), each sized to twice the highest handle when the level started and doubled again as the
level allocated, and the mesh-light selection's four tables (script-vm-meshlight.mjs: light slots 40 bytes a handle, fade caches 4,
light indices 4, membership 1), sized the same way when the first lit actor was drawn. A map change allocates about 10,000 handles
(825,000 after the 83 maps; about 9,800 a map change over the round trips), so a level's object arena grew with every map change before
it (Training's 31 MB on the first arrival, 76 MB on the tenth round trip; 221 MB for the smallest maps at the end of the census), with
the arena's growth by half and the doubled tables' old copies, which its exact-size free lists cannot reuse. The interpreter's attach
also walked every handle allocated so far to enter the released ones. The mesh-light tables run in the page only (Node draws no lit
actor), so a headless probe of the interpreter's tables alone showed a flat arena while the browser's still stepped up (31 to 47 MB at
the fifth Training arrival).

**The bound** (interp.rs `handle_slot`, script-vm-handle-slots.mjs). The tables hold an entry per handle *slot*. When a level's
interpreter attaches (before the level allocates its first handle: the handle limit then is the level's start, `first`), two kinds of
handle get slots:

* the level's own, from `first`: the window, slot `old capacity + handle - first`, which a table grows to twice the handle it must
  cover, as before but from the level's start;
* the handles below `first` live at the attach (the script process's, about 820; in Firefox's inline mode also the previous level's,
  about 13,000, whose host is disposed after the next one is built): the old part, an open-addressed table of u32 keys (a power of two
  at least twice their count, linear probing from `handle * 0x9E3779B1 >> shift`) built once in JavaScript and probed in Rust, the slot
  a key's position. It never grows, as no handle below `first` becomes live again.

Any other handle below `first` had been released when the level started and has no slot: `class_entry` returns RELEASED for it, so a
pointer holding it reads None as before (`live`), and its receiver and state lookups ask JavaScript, which describes no released handle.
A handle released since the level started has its slot and its RELEASED entry, and a handle at or beyond the window is live, as before:
the class table's answers are the tables indexed by handle's, entry for entry. All words zero is the table indexed by handle (the
validators' setup). The mesh-light tables use the same slots; a handle without one would take a spare light slot and a cache block of
its own, never reached (each handle the selection reads is a live light's or actor's, or one its caches stored during the level). The
attach now walks the live handles only.

**Checks.** validate-script-vm-interp.mjs's handle-slot section: every handle below `first` reads itself when it is a key and None
otherwise, releases after the attach, casts on an old key's class row decided in Rust, the window's growth keeping both parts, and
GetStateName on an old key's state entry. The state digests are unchanged against f2f1cb6f: bench-sim on the Island
(`15e3720088490242`) and a Node travel flow in one process (DX, Training, the Island, Training, the Island, then 600 frames: the same
five stateDigest values), which also ran with SCRIPT_VM_CHECK, STATE_VERIFY, RECEIVER_VERIFY and DISPATCH_VERIFY set (every object
read, state entry, receiver entry and dispatch decision compared with JavaScript's) without a difference. The page's round trips ran
with `?meshLight=verify` (both selections every frame) without a difference, and the mesh-light validators pass. Speed, interleaved
A/B: bench-sim's Island tick median 7.15 ms before, 7.19 after (three runs each); the travel flow's Island frame median 6.81 and 6.96
before, 6.97 and 6.95 after: no change.

**Row 7.4.1's sequence after** (`--maps` the Island and Training ten times, forced collections): the handle tables alone (on
f2f1cb6f, `rt-*-tables`), then with the purged meshes destroyed too ([below](#purged-meshes-lazy-arrays-fixed-2026-11-05), on
92e56e05, `rt-*`):

| | Chromium (worker) | Firefox (inline) |
| --- | ---: | ---: |
| the level's arena at Training, second arrival to the eleventh (both runs) | 31, 31 MB (before: 32, 76) | 35, 35 MB (before: 32, 76) |
| the level's arena at the Island, first arrival to the tenth (both runs) | 36, 36 MB (before: 37, 59) | 38, 38 MB (before: 37, 59) |
| its handle tables (Training, the Island; both runs) | 1.25, 1.86 MB, every arrival | 3.86, 3.08 MB, every arrival |
| the total at Training, second arrival to the eleventh, the tables alone | 901 to 943 MB: 4.7 MB a round trip (before 9.6) | 733 to 763 MB: 3.3 MB a round trip (before 8.1) |
| the same with the meshes destroyed too | 898 to 915 MB: 1.9 MB a round trip, 0.4 from the fourth arrival on | 729 to 733 MB: 0.4 MB a round trip |

Firefox's tables are larger by the old part holding the previous level's handles (32,768 slots at Training); constant, as each level
starts with the previous one alive. With the tables alone, what still rose was in the ArrayBuffers outside the Wasm memories
(Chromium's worker 4.1 MB a round trip, Firefox's page 3.0): the purged meshes' lazy arrays, which the collection now destroys
(below). With both, the total at Training is flat to 0.4 MB a round trip in both browsers; Chromium's one step (898 to 913 MB by the
fourth arrival) is the script-VM kernel's memory reaching its high-water mark, 72 to 82 MB (a Wasm memory never shrinks: "Not faults"
above). The process-wide handle table itself (script-object-handles.mjs `identities`, one array slot a handle ever allocated, 8
bytes) still grows with the handles, about 0.16 MB a round trip, outside the level.

**The 83 maps after** (the whole census from Training, forced collections, `.cache/perf/map-memory/`):

| | Chromium (worker) | Firefox (inline) |
| --- | ---: | ---: |
| the level's arena, every arrival | 29 to 36 MB (before: 31 to 223) | 29 to 41 MB (before: 31 to 224) |
| its handle tables | 0.30 to 2.60 MB | 0.30 to 7.86 MB |
| the total: first arrival, last, highest | 798, 896, 1,158 MB (before: 792, 1,148, 1,354) | 581, 703, 995 MB (before: 581, 734, 1,181) |
| the total's slope over the last 42 maps | 0.4 MB a map (before 3.8) | 0.8 MB a map (before 1.8) |
| the tree's RSS, highest | 2,511 MB (before 2,641) | 2,658 MB (before 2,762) |

A level's arena is its first-visit size wherever it falls in the session: in Chromium, Training's 31 MB at the first arrival in a
fresh page and the Island's 36 MB at its first arrival are their sizes at every later arrival, and the last maps' arenas are the
smallest maps' (29 MB) in both browsers. The old part grows only with the script process's live handles (about 820 after two maps, 1,730 after the 83: the
classes and package objects the process keeps) and, in Firefox's inline mode, with the previous level's, which is alive when the next
level's interpreter attaches (Training 35 MB from its second arrival on, after the Island; the largest, 7.86 MB of tables).

**Without forced collections** (`--gc none --no-hitchlog`, the runs that set the 2026-11-04 table's last rows): the tree's RSS peaks
at 6,211 MB in Chromium (before 7,393) and ends at 2,887 (before 6,631); in Firefox it peaks at 6,099 MB (before 9,443), the content
process at 5,254 (before 8,539): each left level's arena, the largest part of the garbage Gecko collects late, is now its first-visit
size.

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
before), slope 3.5 MB a map (4.9 before), no error in either browser. What was left then was the handle tables' growth, including the
step at the eighth round trip where the level's arena grew by half (in every run): [bounded since](#the-handle-tables-2026-11-05-linux).

The other resources the collection purges (textures, sounds, music, fonts) attach no lazy loader in Play: the graph leaves their
records unloaded (RF_NeedLoad), so no other kind accumulates on a held linker.

## Row 7.4.2: the frame-time set (2026-11-08, Linux)

`map-memory-census.mjs --maps <the frame-time set, twice>` (scripts/frame-time-maps.mjs): one page, Training first, then the console's
`open` through the ten maps twice, the heaps after forced collections at each arrival (page plus worker: JS heap, ArrayBuffers and
Wasm memories; Firefox's figure leaves out its report's "other", 74 to 110 MB, which the content process's explicit total includes).
Chromium in worker mode, Firefox inline, master dab89bcb (`.cache/perf/map-memory/s742-dab89bcb/`, outside Git).

**Two faults held left levels.** The first pass rose with every map and the second pass's Training read 1,368 MB in Chromium (807 on
its first visit) and 1,149 MB in Firefox (583): at that arrival the worker (or Firefox's page) still held three levels already left,
each one's object arena (32 to 37 MB) and its runtime's JavaScript, and all three went at the next arrival (the Island). Waiting 20 s
instead of 3 changed nothing. A Chromium heap snapshot of the worker at that arrival (`--snapshots 4`, with each WeakMap entry
treated as weak: a WeakMap value lives only while its key does) named the holders:

1. **The rider pass's log of Base changes** (base-epoch.mjs `noted`, process-wide): every identity `bumpBaseEpochFor` notes, kept
   until 4,096 of them, then the older 2,048 dropped. A left level's actors stayed in it, and with them that level's runtime and arena,
   until later levels' notes pushed them out: the batches. The log only serves a rider table's catch-up (move-riders.mjs
   `baseTableFor`, which drops a table more than 64 notes behind), so a level's dispose now clears it (`forgetNoted`, sim-host.mjs):
   a table whose position falls before the log's start is dropped and filled again, as after the log's own trim.
2. **The window host's accessors** (Chromium only). `gcServices`'s `drawText`, `pushGC` and `popGC` were getter closures
   installed with `defineProperty` inside `createWindowHost`. V8 keeps the accessor pair a property was first given in the map
   transition, and the object literal's allocation site keeps that map, so the first level's getter, and through its scope the
   first level's whole host, runtime and arena (31 MB), stayed alive for the session. One getter per name is now shared by every
   host and calls the host's own reader (script-window-host.mjs `defineReaders`; `host.viewportSize` the same way, and
   `editEnv.v` is a plain property: its value was already set). Firefox's census never showed this level.

Neither changes what the simulation computes: the Island's and Training's 300-tick digests (bench-sim.mjs --render-feedback) are
unchanged (5adb254a07b1ed6f, 07816ec472f29b84), validate-native-config passes (70 checks, it reads `host.viewportSize`), and npm test
passes 998 of 998. After the fixes every arrival holds one level arena, the current one, in both browsers.

**The figures** (MB after forced collections, each map's first and second visit; `.cache/perf/map-memory/s742-fix/`), with the
browser's whole process tree while playing: its highest RSS in the frame-time set's sessions, one 60 s scan per map in a new
browser, nothing forced (Chromium at dab89bcb, Firefox at e9ea7a5e: `.cache/perf/frame-time-set/`):

| map | Chromium (worker): pass 1, pass 2 | before the fix | Firefox (inline): pass 1, pass 2 | before the fix | browser tree while playing: Chromium, Firefox |
|---|---:|---:|---:|---:|---:|
| 00_Training | 807, 999 | 807, 1368 | 583, 797 | 583, 1149 | 2.2, 2.5 GB |
| 01_NYC_UNATCOIsland | 1034, 1158 | 1112, 1262 | 824, 936 | 837, 965 | 2.7, 2.8 GB |
| 02_NYC_Bar | 851, 918 | 1051, 1130 | 696, 763 | 839, 923 | 2.2, 2.4 GB |
| 02_NYC_BatteryPark | 1007, 1063 | 1173, 1352 | 820, 883 | 911, 1138 | 2.7, 3.0 GB |
| 03_NYC_Airfield | 1009, 1053 | 1187, 1254 | 825, 871 | 965, 1012 | 2.6, 2.7 GB |
| 06_HongKong_WanChai_Market | 1044, 1070 | 1212, 1261 | 847, 881 | 972, 1014 | 2.5, 2.7 GB |
| 09_NYC_Ship | 1051, 1078 | 1258, 1292 | 818, 852 | 966, 1007 | 2.6, 2.9 GB |
| 10_Paris_Chateau | 986, 1003 | 1167, 1189 | 778, 810 | 899, 941 | 2.3, 2.9 GB |
| 11_Paris_Everett | 969, 981 | 1235, 1168 | 764, 794 | 991, 920 | 2.3, 2.8 GB |
| 15_Area51_Bunker | 1033, 1049 | 1297, 1226 | 826, 852 | 1036, 967 | 2.4, 2.9 GB |

* Chromium: 807 to 1,158 MB (the Island's second visit the highest); the worker's JS heap 123 to 178 MB (243 before). The tree after
  the collections at most 2,352 MB.
* Firefox: 583 to 936 MB (the Island's second visit); the content process's explicit total 778 to 1,175 MB; the tree after the
  collections at most 2,316 MB.
* While playing, nothing forced: the tree at most 2.8 GB in Chromium (the worker's JS heap at most 342 MB used, 399 MB reserved,
  where the row's earlier note had the Island's worker at 1.4 GB before a collection) and 3.1 GB in Firefox (Battery Park).
* Firefox's script-VM kernel memory reaches 153 MB over the 20 arrivals (Chromium 86 MB): its block allocator's high-water mark,
  which row 7.4.1's slope already covers.

**A budget.** The row's bound is the user's to declare (to fit a 16 GB machine). On these figures: page plus worker after forced
collections at most 1.25 GB on every map of the set in a session that has visited them all (the highest 1,158 MB, 8 % under), in
every browser. The Mac is not measured: its Chromium census can run (Firefox's forced collection is Linux only).
