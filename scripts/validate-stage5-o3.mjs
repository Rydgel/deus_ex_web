#!/usr/bin/env node
/** Stage 5 O3 proof (docs/stage-5-exit-criteria.md "O3: the original's code on Play's inputs"): the native physics bodies a Stage 5 scene runs, replayed
 * through the original Engine.dll in the Unicorn oracles on the inputs Play produced in that scene, bit-exact.
 *
 *   node scripts/validate-stage5-o3.mjs --scene ladder|crate-stack [--keep] [--reuse] [--dir d] [--no-ab]
 *
 * 1. Record: the census scenario of the row runs in Play headless with the recorder on (src/runtime/o3-record.mjs, off by default): every call of the player's
 *    (or a decoration's) physics bodies is captured with its entry state, its constants, each service call it made (MoveActor, line queries, script
 *    events, the nested native bodies) with what the world answered, and its exit state.
 * 2. Replay: each recorded call goes through the oracle driver of its body (`--o3` of scripts/native-*-oracle.py, NATIVE_PROBE_PYTHON): the original code runs
 *    from the entry state, and every service it calls is answered from the recording, in order; a service Play did not call is a divergence.
 * 3. Compare: the native's service calls (kind, arguments, the pawn's tracked state at each) and its final state against Play's, float32 bits included
 *    (Object.is: signed zeros). Report the calls per body and the first mismatch of each. Exit 1 on any mismatch, divergence or call no oracle replays.
 * 4. Controls: the same replay with one input of the first calls of each body changed by 2^-12 (relative) must differ (the comparison is not vacuous).
 * 5. A/B: the scene again with the recorder off and the Rust kernels on (Play's default), a per-tick digest of the player and the decorations compared with the
 *    recorded run's: recording changes nothing, and the Rust bodies the recording replaces (the surface scan, the falling kernel) agree with the reference.
 *
 * Scalars only are compared: a mismatch prints the path of the first differing number, never a runtime object.
 * --keep writes the cases and results under .cache/o3/<scene>/; --reuse replays the cases found there instead of recording again (no A/B). */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const scene = option('scene');
const digestOnly = argv.includes('--digest');
// The recording takes the JavaScript reference bodies where Play runs a Rust kernel (a kernel has no JS service boundary to observe): the decoration
// falling body here; the surface scan switches itself in walking-surface.mjs. The A/B child (--digest) keeps Play's defaults.
if (!digestOnly) process.env.ACTOR_PHYSICS = 'js';
const {o3Start, o3Stop} = await import('../src/runtime/o3-record.mjs');
const {ADAPTERS, ActorIds, resolveCase} = await import('./o3-adapters.mjs');

/** body -> the oracle driver that replays it. */
const ORACLES = {
  flying: 'native-flying-oracle.py',
  walking: 'native-walking-oracle.py',
  prelude: 'native-ladder-oracle.py',
  falling: 'native-falling-oracle.py',
  landed: 'native-landing-oracle.py',
  rolling: 'native-rolling-oracle.py',
  moveQuery: 'native-move-query-oracle.py',
};
/** The tampering of the controls: body -> the path in a case of a constant the body consumes (changed by a relative 2^-12; zero by one). */
const CONTROLS = {
  flying: ['config', 'fluidFriction'],
  walking: ['config', 'maxStepHeight'],
  falling: ['config', 'gravity', 2],
  prelude: ['config', 'radius'],
  landed: ['config', 'radius'],
  rolling: ['config', 'zone', 'groundFriction'],
  moveQuery: ['config', 'extent', 1],
};

// --- encoding ---------------------------------------------------------------------------------------------------------------------------------------
/** JSON that keeps the sign of zero (Python reads -0.0) and refuses a number JSON cannot carry. */
function encode(value) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'number') {
      if (Object.is(v, -0)) return '__neg0__';
      if (!Number.isFinite(v)) throw new Error(`non-finite number ${v} at ${key} in a recorded case: extend the encoder (a NaN travels as bits in the O2 oracles)`);
    }
    return v;
  }).replaceAll('"__neg0__"', '-0.0');
}
/** The first difference of two JSON values, numbers by Object.is, as a path; null when equal. */
function firstDifference(a, b, at = '') {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : `${at}: Play ${Object.is(a, -0) ? '-0' : a} vs native ${Object.is(b, -0) ? '-0' : b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      if (!(key in a) || !(key in b)) return `${at}.${key}: ${key in a ? 'only Play' : 'only native'}`;
      const d = firstDifference(a[key], b[key], `${at}.${key}`); if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${at}: Play ${JSON.stringify(a)} vs native ${JSON.stringify(b)}`;
}
/** A visible change of an input: a relative 2^-12 (rounded to float32), a nonzero step for zero. */
const tweak = value => (value === 0 ? 1 : Math.fround(value * (1 + 2 ** -12)));

// --- record -----------------------------------------------------------------------------------------------------------------------------------------
async function openAssets() {
  const {gameDirectory} = await import('./game-directory.mjs');
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const gameRoot = gameDirectory(), files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${gameRoot}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${gameRoot}/${directory}/${name}`)});
  return new AssetStore(files);
}

/** A per-tick digest of what the scene's physics moves (the player; the decorations), as raw float bits: equal digests are equal runs. */
function digestTracer(game, read, watched) {
  const hash = createHash('sha256'), words = new Float64Array(10), bytes = Buffer.from(words.buffer);
  let ticks = 0;
  const tick = game.tick.bind(game);
  game.tick = (...args) => {
    const result = tick(...args);
    ticks++;
    for (const actor of watched()) {
      words.set([...read(actor, 'Location'), ...read(actor, 'Velocity'), Number(read(actor, 'Physics')), ...read(actor, 'Acceleration').slice(0, 3)]);
      hash.update(bytes);
    }
    return result;
  };
  return () => ({ticks, digest: hash.digest('hex')});
}

/** Run the scene: with the recorder when `recording`, and the digest of its run either way. */
async function runScene(recording) {
  const {decodeMap} = await import('../src/unreal/map.mjs');
  if (scene === 'ladder') {
    const {createGame} = await import('../src/viewer/game.mjs');
    const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');
    const {ladderScene} = await import('./training-ladder-scene.mjs');
    const assets = await openAssets(), asset = await assets.get('00_Training');
    const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1});
    const input = createPlayerInputFixture(game, {tickSeconds: 1 / 60});
    const player = game.player.collisionActor, runtime = game.doors.scriptRuntime.runtime;
    const digest = digestTracer(game, (actor, name) => runtime.readNamed(actor, name), () => [player]);
    const ids = new ActorIds(runtime.levelFor(player).actors[0]);
    if (recording) o3Start(ADAPTERS, pawn => pawn.self === player, {ids});
    let summary, out = null;
    try { summary = ladderScene(game, input); } finally { if (recording) out = o3Stop(); }
    return {out, summary, ids, run: digest()};
  }
  if (scene === 'crate-stack') {
    await import('./census-stage5-drivers.mjs');   // the census's deterministic clock (Date, performance.now) is installed on import
    const {DRIVERS, openSession} = await import('./census-stage5-session.mjs');
    const session = await openSession('00_Training', await openAssets());
    const {c} = session, player = c.player();
    const tracked = c.actors().filter(a => c.isA(a, 'engine.decoration') && !/^(Plant|Tree|Vase)/.test(a.name));
    const digest = digestTracer(c.game, (actor, name) => c.read(actor, name), () => [player, ...tracked]);
    const ids = new ActorIds(c.level().actors[0]);
    if (recording) o3Start(ADAPTERS, t => (t.self ? t.self === player : Boolean(t.lineage?.includes('engine.decoration'))), {ids});
    let outcome, out = null;
    try { outcome = await session.run('crate-stack', DRIVERS['crate-stack']); } finally { if (recording) out = o3Stop(); }
    if (outcome.status !== 'plays') throw new Error(`the census scenario crate-stack did not play: ${outcome.status} ${outcome.message ?? ''}`);
    return {out, summary: outcome.effect, ids, run: digest()};
  }
  throw new Error(`unknown --scene ${scene}`);
}

if (digestOnly) {
  const {run} = await runScene(false);
  console.log(`DIGEST ${JSON.stringify(run)}`);
  process.exit(0);
}

// --- replay -----------------------------------------------------------------------------------------------------------------------------------------
async function runOracle(driver, casesFile) {
  const {gameDirectory} = await import('./game-directory.mjs');
  const python = process.env.NATIVE_PROBE_PYTHON ?? path.join(root, '.cache/native-probe-env/bin/python');
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [path.join(root, 'scripts', driver), gameDirectory(), casesFile, '--o3'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; }); proc.stderr.on('data', d => { stderr += d; });
    proc.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${driver} exited ${code}: ${stderr.split('\n').slice(-6).join(' | ')}`)));
  });
}

const dir = path.resolve(String(option('dir') ?? path.join(root, '.cache/o3', String(scene))));
mkdirSync(dir, {recursive: true});
const casesFile = (body, suffix = 'cases') => path.join(dir, `${body}.${suffix}.json`);
let cases, recorded = null;
if (option('reuse')) cases = Object.keys(ORACLES).flatMap(body => existsSync(casesFile(body)) ? JSON.parse(readFileSync(casesFile(body), 'utf8')) : []);
else {
  recorded = await runScene(true);
  const {out, summary, ids} = recorded;
  if (ids.info.length > 1) console.log(`actors met: ${ids.info.slice(1).map((a, i) => `${i + 1}=${a.name}`).join(' ')}`);
  console.log(`recorded ${out.calls.length} calls in ${scene} (${recorded.run.ticks} ticks): ${JSON.stringify(summary)}`);
  if (out.errors.length) { console.log(`FAIL recorder: ${out.errors.join('; ')}`); process.exit(1); }
  cases = out.calls.map(rec => resolveCase(rec, ids));
  for (const body of Object.keys(ORACLES)) writeFileSync(casesFile(body), encode(cases.filter(c => c.body === body)));
}

const bodies = [...new Set(cases.map(c => c.body))];
const failures = [], report = [];
const compare = (c, native) => native.diverged ? `diverged: ${native.diverged}` : firstDifference(
  {events: c.events.map(e => ({k: e.k, args: e.args, pre: e.pre})), after: c.after, result: c.result}, {events: native.events, after: native.after, result: native.result ?? null});
for (const body of bodies) {
  const mine = cases.filter(c => c.body === body);
  if (!ORACLES[body]) { failures.push(`${body}: ${mine.length} recorded calls and no oracle replays them`); report.push(`${body.padEnd(9)} ${String(mine.length).padStart(5)} calls  NOT REPLAYED`); continue; }
  const errored = mine.filter(c => c.error);
  if (errored.length) failures.push(`${body}: ${errored.length} calls threw in Play, first: ${errored[0].error}`);
  const replayable = mine.filter(c => !c.error);
  const results = (await runOracle(ORACLES[body], casesFile(body))).results;
  if (option('keep')) writeFileSync(casesFile(body, 'results'), JSON.stringify(results));
  let equal = 0, events = 0;
  const kinds = {}, firsts = [];
  replayable.forEach((c, i) => {
    events += c.events.length;
    for (const e of c.events) kinds[e.k] = (kinds[e.k] ?? 0) + 1;
    const diff = compare(c, results[i]);
    if (!diff) equal++; else if (firsts.length < 3) firsts.push(`call #${c.index} (${c.args.join(', ')}): ${diff}`);
  });
  report.push(`${body.padEnd(9)} ${String(mine.length).padStart(5)} calls ${String(events).padStart(6)} service calls (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')})  ${equal === replayable.length ? 'equal' : `${replayable.length - equal} DIFFER`}`);
  if (equal !== replayable.length) failures.push(`${body}: ${replayable.length - equal} of ${replayable.length} differ; first: ${firsts[0]}`);

  // Control: one input of the first calls perturbed by one ulp must make the native differ from Play's recorded outputs.
  const where = CONTROLS[body];
  const tampered = replayable.slice(0, 8).map(c => {
    const copy = JSON.parse(JSON.stringify(c));
    let holder = copy;
    for (const key of where.slice(0, -1)) holder = holder[key];
    holder[where.at(-1)] = tweak(holder[where.at(-1)]);
    return copy;
  });
  if (tampered.length) {
    writeFileSync(casesFile(body, 'control'), encode(tampered));
    const controlResults = (await runOracle(ORACLES[body], casesFile(body, 'control'))).results;
    const differing = tampered.filter((c, i) => compare(c, controlResults[i])).length;
    report.push(`          control: ${differing} of ${tampered.length} perturbed calls differ (${where.join('.')} x (1 + 2^-12))`);
    if (differing === 0) failures.push(`${body}: the control (${where.join('.')} x (1 + 2^-12)) changed nothing: the comparison does not see that input`);
  }
}
console.log(report.join('\n'));

// --- A/B --------------------------------------------------------------------------------------------------------------------------------------------
if (recorded && !option('no-ab')) {
  const child = await new Promise((resolve, reject) => {
    const env = {...process.env};
    delete env.ACTOR_PHYSICS;
    const proc = spawn(process.execPath, [path.join(root, 'scripts/validate-stage5-o3.mjs'), '--scene', String(scene), '--digest'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; }); proc.stderr.on('data', d => { stderr += d; });
    proc.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`the A/B run exited ${code}: ${stderr.split('\n').slice(-6).join(' | ')}`)));
  });
  const plain = JSON.parse(/^DIGEST (.*)$/m.exec(child)?.[1] ?? 'null');
  const same = plain && plain.ticks === recorded.run.ticks && plain.digest === recorded.run.digest;
  console.log(`A/B: ${plain?.ticks} ticks recorder off with Play's kernels, ${recorded.run.ticks} recorded: per-tick digests ${same ? 'equal' : 'DIFFER'}`);
  if (!same) failures.push(`A/B: the recorded run and Play's own run differ (digest ${plain?.digest?.slice(0, 12)} vs ${recorded.run.digest.slice(0, 12)})`);
}

if (failures.length) { console.log(`FAIL validate-stage5-o3 ${scene}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-stage5-o3 ${scene}`);
