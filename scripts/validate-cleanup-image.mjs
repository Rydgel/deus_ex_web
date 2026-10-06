#!/usr/bin/env node
/**
 * CleanupDestroyed's reference pass read from object images
 * (ScriptRuntime.cleanupReferences, script-cleanup.mjs cleanupImageSites)
 * against the reference traversal (cleanupScriptReferences), on Play's state.
 *
 * Each mode boots 00_Intro in its own process (seed 1, simulated clock,
 * 300 frames with the HUD), plants stale pointers to one live actor in other
 * actors' Target, Touching[1], Touching[3] and Region.Zone (an imaged Region
 * and a bound one), marks that actor bDeleteMe, then runs the pass over every
 * level actor. Both modes must leave the same level digest, clear every
 * planted pointer, and the image mode must answer IsValid once per
 * referenced object rather than once per pointer. Host translation check: the
 * original contract is cleanupScriptReferences (docs/script-cleanup.md).
 *
 *   node scripts/validate-cleanup-image.mjs [--map 00_Intro] [--ticks 300]
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '00_Intro'), ticks = Number(flag('ticks', 300));

if (argv[0] !== 'child') {
  const {gameDirectory} = await import('./game-directory.mjs');
  try { gameDirectory(); } catch { console.log('SKIP validate-cleanup-image: no installed game data'); process.exit(0); }
  const run = mode => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', mode, '--map', map, '--ticks', String(ticks)],
      {encoding: 'utf8', maxBuffer: 1 << 26});
    if (child.status !== 0) throw new Error(`${mode} child failed:\n${child.stderr.slice(-6000)}`);
    return JSON.parse(child.stdout.trim().split('\n').pop());
  };
  const reference = run('reference'), image = run('image');
  assert.equal(image.before, reference.before, 'both modes plant the same state');
  assert.notEqual(reference.after, reference.before, 'the pass clears the planted pointers');
  assert.equal(image.after, reference.after, 'the image pass leaves the reference pass\'s state');
  for (const result of [reference, image]) assert.deepEqual(result.remaining, [], `${result.mode}: no planted pointer survives`);
  assert.ok(image.imaged > image.actors * 0.9, `most actors take the image path (${image.imaged}/${image.actors})`);
  assert.ok(image.isValid * 4 < reference.isValid, `IsValid once per object (${image.isValid} vs ${reference.isValid})`);
  console.log(`validate-cleanup-image: ${map} after ${ticks} frames, ${reference.actors} actors, ${reference.planted} planted pointers ` +
    `(bound Region: ${reference.boundRegion}); digests ${reference.before} -> ${reference.after} in both modes; ` +
    `${image.imaged} actors read from images; IsValid ${reference.isValid} -> ${image.isValid}; PASS`);
  process.exit(0);
}

const mode = argv[1];
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
globalThis.__realNow = performance.now.bind(performance);
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {cleanupScriptReferences} = await import('../src/runtime/script-cleanup.mjs');
const {cleanupPlan} = await import('../src/runtime/script-runtime.mjs');
const {stateDigest} = await import('../src/runtime/state-digest.mjs');
const {gameDirectory} = await import('./game-directory.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime;
for (let i = 0; i < ticks; i++) { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); }

const read = (actor, name) => runtime.readNamed(actor, name);
const player = game.player.collisionActor, level = runtime.levelFor(player);
const live = level.actors.map((actor, index) => ({actor, index}))
  .filter(({actor, index}) => index > 0 && actor && actor !== player && !read(actor, 'bDeleteMe'));
const victim = live.find(({actor}) => !read(actor, 'bStatic')).actor;
const bound = actor => runtime.instance(actor).bindings.has('engine.actor.region');
// Planted pointers: [actor, what] for the check after the pass.
const planted = [];
const holders = live.filter(({actor}) => actor !== victim && !bound(actor)).slice(0, 40).map(({actor}) => actor);
holders.forEach((actor, k) => {
  if (k % 4 === 0 || k % 4 === 2) { runtime.writeNamed(actor, 'Target', victim); planted.push([actor, 'Target']); }
  if (k % 4 === 1 || k % 4 === 2) {
    const ref = runtime.namedReference(actor, 'Touching'), touching = ref.get();
    const slot = k % 4 === 1 ? 1 : 3;
    touching[slot] = victim; ref.set(touching); planted.push([actor, `Touching${slot}`]);
  }
  if (k % 4 === 3) {
    const region = runtime.regionValue(actor);
    runtime.setRegion(actor, victim, region.leaf, region.zoneNumber); planted.push([actor, 'Region']);
  }
});
// One actor whose Region is a host binding, if the level has one.
const boundHolder = live.find(({actor}) => actor !== victim && actor !== player && bound(actor))?.actor ?? null;
if (boundHolder) {
  const region = runtime.regionValue(boundHolder);
  runtime.setRegion(boundHolder, victim, region.leaf, region.zoneNumber); planted.push([boundHolder, 'Region']);
}
runtime.writeNamed(victim, 'bDeleteMe', true);
const before = stateDigest(runtime, level);

const services = runtime.actorLifecycle.references;
let isValid = 0, imaged = 0;
const counted = {...services, isValid: target => { isValid++; return services.isValid(target); }};
runtime.actorLifecycle.references = counted;
const verdicts = new Map();
let actors = 0;
for (const actor of level.actors) {
  if (actor === null) continue;
  actors++;
  if (mode === 'reference') cleanupScriptReferences(runtime.instance(actor).cls.propertyLink,
    field => runtime.fieldReference(actor, field), counted, {editor: false});
  else {
    if (cleanupPlan(runtime.instance(actor))) imaged++;
    runtime.cleanupReferences(actor, {editor: false, verdicts});
  }
}
runtime.actorLifecycle.references = services;
const after = stateDigest(runtime, level);
const remaining = planted.filter(([actor, what]) => {
  if (what === 'Target') return read(actor, 'Target') === victim;
  if (what.startsWith('Touching')) return read(actor, 'Touching')[Number(what.slice(8))] === victim;
  return runtime.regionValue(actor).zone === victim;
}).map(([actor, what]) => `${actor.name}.${what}`);
console.log(JSON.stringify({mode, before, after, actors, imaged: mode === 'image' ? imaged : 0, isValid,
  planted: planted.length, boundRegion: Boolean(boundHolder), remaining}));
