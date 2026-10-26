/** Which classes the original holds, from the original's own load requests (docs/class-graph-design.md "Loaded in the original's sense",
 * migration step 1; docs/class-lifetime.md). A cold Play load of each map records the requests the original makes: every import of the
 * level package, the class of every object Play instantiates, and every DynamicLoadObject (scripts/original-load-closure.mjs). These are
 * replayed on a load graph of their own, each inside the recovered BeginLoad/EndLoad, which preloads what a load creates transitively. The
 * resulting classes are compared with the original's registry dumps of the same maps (the gc2 capture, `.work/travel/gc2`, outside Git;
 * docs/class-lifetime.md "Frozen arrivals and class defaults: gc2"). Play's own graph is not used: it loads lazily and its readiness passes
 * load classes the original never loads.
 *
 * Checks:
 * - per map, Play's own bookkeeping (the live graph's original-loaded tracker, src/runtime/original-loaded.mjs, which walks the graph's
 *   load edges from the same requests during the load) reaches exactly the closure's classes, without a failed walk;
 * - per map (DX.dx, 00_Training, 01_NYC_UNATCOIsland, each loaded cold): no class of the closure is missing from the original's dump, and
 *   every class only the original holds is a class a DLL registered and never loaded from its package (flags without the 0x70000 load
 *   context bits, e.g. 0x44084044 WinDrv.WindowsClient);
 * - per map change of the dump (DX.dx -> Training -> Island -> Training): the classes the original collected are the first level's closure
 *   minus the second's, and the classes it loaded are the second's minus the first's (a registered class whose script export loads in place
 *   keeps its object, so it is not a new one).
 *
 *   node scripts/validate-original-loaded.mjs [--captures .work/travel/gc2]
 * Each map runs in a child process (`--one <map> --out <file>`): a cold load holds a runtime the process cannot release. */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const NAME = 'validate-original-loaded';
const MAPS = [['DX', 'dx'], ['00_Training', 'training'], ['01_NYC_UNATCOIsland', 'island']];
// The dump stops, in the capture's order, and the map whose closure each one is compared with.
const STOPS = [['dx', 'dx'], ['training', 'training'], ['island', 'island'], ['training2', 'training']];

if (option('one', null)) {
  // child: one cold load, its requests and their closure
  const {readFile, readdir} = await import('node:fs/promises');
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
  const {ScriptRuntime} = await import('../src/runtime/script-runtime.mjs');
  const closure = await import('./original-load-closure.mjs');
  const map = option('one'), root = gameDirectory(), files = [];
  for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
  const assets = new AssetStore(files), asset = await assets.get(map);
  const recorder = closure.recordOriginalRequests(ScriptRuntime);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  recorder.stop();
  // Play's own bookkeeping of the same thing: the live graph's original-loaded tracker (src/runtime/original-loaded.mjs)
  const tracker = game.doors.scriptRuntime.runtime.classLoader.originalLoads;
  const live = {classes: [...tracker.classes()].sort(), failures: tracker.failures.slice(0, 5), marked: tracker.size};
  const level = await closure.levelImportRequests(assets, asset);
  const dynamic = (await Promise.all(recorder.dynamicNames().map(name => closure.pathRequest(assets, name, 'DynamicLoadObject')))).filter(Boolean);
  const result = await closure.originalLoadClosure(assets, [...level, ...recorder.requests(), ...dynamic]);
  writeFileSync(option('out'), JSON.stringify({map, classes: [...result.classes].sort(),
    requests: {level: level.length, instantiated: recorder.requests().length, dynamic: dynamic.length},
    objects: result.objects.size, skipped: Object.fromEntries(result.skipped), failures: result.failures, live}));
  process.exit(0);
}

try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const captures = option('captures', '.work/travel/gc2');
const missing = STOPS.map(([stop]) => join(captures, `${stop}.gflags.txt`)).filter(file => !existsSync(file));
if (missing.length) { console.log(`SKIP ${NAME}: no original capture (${missing.join(', ')}; scripts/travel-probe.sh gc2, docs/class-lifetime.md)`); process.exit(0); }

// the original's classes at a stop: "package.class" -> {ptr, flags}
const dumpClasses = stop => {
  const out = new Map();
  for (const line of readFileSync(join(captures, `${stop}.gflags.txt`), 'utf8').split('\n')) {
    const m = /^slot\s+\d+ index\s+\d+ Class\.(\S+) ptr (0x\w+) flags 0x(\w+) outer 0x\w+ (\S*)/.exec(line);
    if (m) out.set(`${m[4]}.${m[1]}`.toLowerCase(), {ptr: m[2], flags: parseInt(m[3], 16)});
  }
  return out;
};
// a class whose object came from its package carries the load context bits (RF_LoadForClient|Server|Edit); a registered one does not
const LOAD_CONTEXT = 0x00070000;

const work = mkdtempSync(join(tmpdir(), 'original-loaded-'));
const closures = new Map(), failures = [], notes = [];
try {
  for (const [map, stop] of MAPS) {
    const out = join(work, `${stop}.json`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--one', map, '--out', out], {stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8'});
    if (child.status !== 0 || !existsSync(out)) { failures.push(`${map}: the cold load or its closure failed (${String(child.stderr).trim().split('\n').pop()})`); continue; }
    const result = JSON.parse(readFileSync(out, 'utf8'));
    closures.set(stop, new Set(result.classes));
    const live = new Set(result.live.classes);
    const liveMissing = result.classes.filter(key => !live.has(key)), liveExtra = result.live.classes.filter(key => !closures.get(stop).has(key));
    if (liveMissing.length || liveExtra.length)
      failures.push(`${map}: the live tracker's classes differ from the closure: missing ${liveMissing.slice(0, 8).join(' ') || '-'}, extra ${liveExtra.slice(0, 8).join(' ') || '-'}`);
    if (result.live.failures.length) failures.push(`${map}: the live tracker's walk failed: ${JSON.stringify(result.live.failures[0])}`);
    notes.push(`${map}: the live tracker marks ${result.live.marked} objects, ${result.live.classes.length} classes (the closure's: ${liveMissing.length || liveExtra.length ? 'NO' : 'yes'})`);
    if (result.failures.length) failures.push(`${map}: ${result.failures.length} requests failed to replay, first ${result.failures[0].key}: ${result.failures[0].error}`);
    notes.push(`${map}: requests ${result.requests.level} level imports, ${result.requests.instantiated} instantiated classes, ${result.requests.dynamic} DynamicLoadObject; ` +
      `${result.objects} objects, ${result.classes.length} classes; unrecovered serializers skipped ${JSON.stringify(result.skipped)}`);
  }
  for (const [stop, closureStop] of STOPS) {
    const closure = closures.get(closureStop);
    if (!closure) continue;
    const original = dumpClasses(stop);
    const extra = [...closure].filter(key => !original.has(key));
    const unexplained = [...original].filter(([key, value]) => !closure.has(key) && (value.flags & LOAD_CONTEXT)).map(([key]) => key);
    const registered = [...original].filter(([key, value]) => !closure.has(key) && !(value.flags & LOAD_CONTEXT)).length;
    if (extra.length) failures.push(`${stop}: ${extra.length} classes of the closure the original does not hold: ${extra.slice(0, 12).join(' ')}`);
    if (unexplained.length) failures.push(`${stop}: ${unexplained.length} loaded classes the closure lacks: ${unexplained.slice(0, 12).join(' ')}`);
    notes.push(`${stop}: original ${original.size} classes = closure ${closure.size} + ${registered} registered and never loaded`);
  }
  for (let i = 1; i < STOPS.length; i++) {
    const [fromStop, fromMap] = STOPS[i - 1], [toStop, toMap] = STOPS[i];
    const a = dumpClasses(fromStop), b = dumpClasses(toStop), ca = closures.get(fromMap), cb = closures.get(toMap);
    if (!ca || !cb) continue;
    const loadedIn = map => new Set([...map].filter(([, value]) => value.flags & LOAD_CONTEXT).map(([key]) => key));
    const collected = new Set([...loadedIn(a)].filter(key => !b.has(key))), loaded = new Set([...loadedIn(b)].filter(key => !a.has(key)));
    const predictedCollected = [...ca].filter(key => !cb.has(key));
    // a class registered before the change and loaded in place after it is not a new object
    const predictedLoaded = [...cb].filter(key => !ca.has(key) && !a.has(key));
    const diff = (x, y) => [...x].filter(key => !y.has(key));
    const bad = [...diff(collected, new Set(predictedCollected)), ...diff(new Set(predictedCollected), collected),
      ...diff(loaded, new Set(predictedLoaded)), ...diff(new Set(predictedLoaded), loaded)];
    if (bad.length) failures.push(`${fromStop} -> ${toStop}: collected/loaded differ from the closures: ${bad.slice(0, 12).join(' ')}`);
    notes.push(`${fromStop} -> ${toStop}: collected ${collected.size} (predicted ${predictedCollected.length}), loaded ${loaded.size} (predicted ${predictedLoaded.length})`);
  }
} finally { rmSync(work, {recursive: true, force: true}); }

for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: the original's classes on DX.dx, 00_Training and 01_NYC_UNATCOIsland are the EndLoad closure of its load requests plus the classes the DLLs register, Play's live tracker reaches exactly those, and each map change collects and loads exactly the difference of the closures`);
