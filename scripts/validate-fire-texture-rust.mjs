// Fire.dll's procedural texture ticks in the Rust core (fire.rs, through
// fire-texture-kernel.mjs) against fire-texture.mjs (docs/fire-texture.md
// "Rust kernel"). For the procedural textures Play acquires on each map (its
// world and actor mesh layer, loaded headless in a child process) and for
// every FireTexture and WetTexture in the game's packages, two texture sets
// are built the way procedural-textures.mjs builds them, one on the
// JavaScript bodies and one on the kernel, from the same seed and in the same
// order, so they share identical generators. Each set ticks every texture in
// order; after every tick the pixels, the fields, drops or sparks (whole
// arrays), the scalars, the generator's 512 bytes and index, and the RGBA
// upload must match byte for byte.
//
//   node scripts/validate-fire-texture-rust.mjs [--maps 00_Training,...] [--ticks 600] [--no-all] [--bench 200]
//   node scripts/validate-fire-texture-rust.mjs --collect <map>   (child: prints the acquired keys)
import {readFile, readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {TextureStore} from '../src/unreal/textures.mjs';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-fire-texture-rust: no installed game data'); process.exit(0); }

async function assetStore(directories) {
  const files = [];
  for (const directory of directories)
    for (const name of await readdir(path.join(root, directory)))
      files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  return new AssetStore(files);
}

// Child: Play's acquisitions on `map` (world, then the game and its actor
// mesh layer, as main.mjs builds them), as keys in acquisition order.
const collect = option('collect', null);
if (collect) {
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const {createWorld} = await import('../src/viewer/world.mjs');
  const {createGame} = await import('../src/viewer/game.mjs');
  const {createActorMeshScene} = await import('../src/viewer/npc-mesh-preview.mjs');
  const {sharedProceduralTextures} = await import('../src/viewer/procedural-textures.mjs');
  const assets = await assetStore(['Maps', 'System', 'Textures', 'Sounds', 'Music']), asset = await assets.get(collect);
  const world = await createWorld(decodeMap(asset.bytes), asset, assets);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  const runtime = game.doors.scriptRuntime.runtime;
  await createActorMeshScene(runtime, assets, asset, {player: game.player.collisionActor});
  process.stdout.write(`${JSON.stringify({map: collect, keys: sharedProceduralTextures().records().map(r => r.key),
    worldErrors: world.errors.length})}\n`);
  process.exit(0);
}

const {loadScriptVmKernel} = await import('../src/runtime/script-vm-kernel.mjs');
const {createProceduralTextures} = await import('../src/viewer/procedural-textures.mjs');
const kernel = await loadScriptVmKernel();
const ticks = Number(option('ticks', 600)), bench = Number(option('bench', 0));
const maps = option('maps', '00_Training,10_Paris_Chateau,15_Area51_Bunker').split(',').filter(Boolean);
const assets = await assetStore(['Maps', 'Textures', 'System']), textures = new TextureStore(assets);

async function load(key) {
  const [name, ...parts] = key.split('.');
  const asset = await assets.get(name), index = asset.exportsByPath.get(parts.join('.').toLowerCase());
  if (!index) throw new Error(`No export for ${key}`);
  return textures.get(asset, index, false);
}
// Each set gets its own copies of the arrays a tick mutates in place (the
// JavaScript wet state keeps the decoded drops array).
const copy = data => ({...data, fire: data.fire && {...data.fire, sparks: data.fire.sparks.slice()},
  wet: data.wet && {...data.wet, drops: data.wet.drops.slice()}});

const bytesOf = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function compare(where, js, rust) {
  const a = js.state, b = rust.state;
  const scalars = js.kind === 'WetTexture' ? ['globalPhase', 'waveParity', 'numDrops', 'uSize', 'vSize']
    : ['globalPhase', 'auxPhase', 'activeSparkNum', 'starStatus', 'sparksLimit', 'uSize', 'vSize'];
  for (const name of scalars) if (a[name] !== b[name]) throw new Error(`${where}: ${name} ${a[name]} != ${b[name]}`);
  const arrays = js.kind === 'WetTexture' ? ['pixels', 'fields', 'drops', 'renderTable', 'waveTable'] : ['pixels', 'sparks', 'renderTable'];
  for (const name of arrays) {
    const x = bytesOf(a[name]), y = bytesOf(b[name]);
    if (x.length !== y.length || x.compare(y) !== 0) {
      const at = x.findIndex((v, i) => v !== y[i]);
      throw new Error(`${where}: ${name} differs (lengths ${x.length}/${y.length}, first at ${at}: ${x[at]} != ${y[at]})`);
    }
  }
  if (bytesOf(js.rgba).compare(bytesOf(rust.rgba)) !== 0) throw new Error(`${where}: RGBA upload differs`);
}
function compareGlobals(where, js, rust) {
  if (js.randomIndex !== rust.randomIndex) throw new Error(`${where}: random index ${js.randomIndex} != ${rust.randomIndex}`);
  if (bytesOf(js.random).compare(bytesOf(rust.random)) !== 0) throw new Error(`${where}: random bytes differ`);
}

/** Two sets over `entries` ({key, data}) ticked `ticks` times. */
function differential(label, entries) {
  const jsSet = createProceduralTextures({kernel: null}), rustSet = createProceduralTextures({kernel});
  for (const {data} of entries) { jsSet.acquire(copy(data)); rustSet.acquire(copy(data)); }
  const js = jsSet.inspect(), rust = rustSet.inspect();
  const backends = rust.records.map(r => (r.expand ? 'rust' : 'js'));
  const notAdmitted = rust.records.filter(r => !r.expand).map(r => r.key);
  if (rust.records.some(r => r.kind === 'WetTexture' && !r.expand && r.state.source))
    throw new Error(`${label}: a ticking wet texture fell back to JavaScript: ${notAdmitted.join(', ')}`);
  for (let i = 0; i < js.records.length; i++) compare(`${label} ${js.records[i].key} load`, js.records[i], rust.records[i]);
  let steps = 0;
  for (let t = 0; t < ticks; t++)
    for (let i = 0; i < js.records.length; i++) {
      js.step(js.records[i]); rust.step(rust.records[i]); steps++;
      const where = `${label} ${js.records[i].key} tick ${t + 1}`;
      compare(where, js.records[i], rust.records[i]);
      compareGlobals(where, js.globals, rust.globals);
    }
  const counts = {};
  for (let i = 0; i < backends.length; i++) { const k = `${rust.records[i].kind}/${backends[i]}`; counts[k] = (counts[k] ?? 0) + 1; }
  console.log(`${label}: ${js.records.length} textures (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}), ` +
    `${ticks} ticks, ${steps} texture ticks byte-exact (pixels, state, generator, RGBA)`);
  return {jsSet, rustSet};
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s[s.length >> 1]; };
function benchmark(label, entries) {
  const rows = [];
  for (const [name, options] of [['js', {kernel: null}], ['rust', {kernel}]]) {
    const set = createProceduralTextures(options);
    for (const {data} of entries) set.acquire(copy(data));
    const {records} = set.inspect(), inspect = set.inspect();
    const times = records.map(() => ({tick: [], upload: []}));
    for (let t = 0; t < bench; t++)
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        let start = performance.now();
        r.constantTimeTick(r);
        const tick = performance.now() - start;
        start = performance.now();
        inspect.upload(r);
        times[i].tick.push(tick); times[i].upload.push(performance.now() - start);
      }
    records.forEach((r, i) => rows.push({name, key: r.key, backend: r.expand ? 'rust' : 'js',
      tick: median(times[i].tick), upload: median(times[i].upload)}));
  }
  console.log(`${label} microbenchmark (median ms over ${bench} ticks; tick | upload):`);
  for (const key of new Set(rows.map(r => r.key))) {
    const [a, b] = ['js', 'rust'].map(n => rows.find(r => r.key === key && r.name === n));
    console.log(`  ${key.padEnd(36)} JS ${a.tick.toFixed(4)} | ${a.upload.toFixed(4)}   ` +
      `Rust(${b.backend}) ${b.tick.toFixed(4)} | ${b.upload.toFixed(4)}   x${((a.tick + a.upload) / (b.tick + b.upload)).toFixed(1)}`);
  }
}

// Synthetic textures for the branches the game's data leaves out: every drop
// type (and unused ones), drops past the half texture and past the 256 the
// array holds, smaller sources and short palettes. Drawn from an LCG's top
// bits (validate-native-fire-texture's reason).
let seed = 0x5eed;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
const bytes = n => Uint8Array.from({length: n}, () => random() & 255);
const DROP_TYPES = [...Array(0x14).keys(), 0x40, 0x41, 0x14, 0x3f, 0x42, 0xff];
function syntheticWet(k, [uBits, vBits]) {
  const uSize = 1 << uBits, vSize = 1 << vBits, drops = new Uint8Array(2048);
  const types = k % 3 === 0 ? DROP_TYPES : [DROP_TYPES[random() % DROP_TYPES.length], DROP_TYPES[random() % DROP_TYPES.length]];
  for (let i = 0; i < 256; i++) {
    const inside = random() & 1;
    drops.set([types[random() % types.length], random() & 255, inside ? random() % (uSize >> 1) : random() & 255,
      inside ? random() % (vSize >> 1) : random() & 255, random() & 255, random() & 255, random() & 255,
      k % 4 === 1 ? random() & 255 : random() & 31], i * 8);
  }
  const smaller = k % 5 === 2 && uBits > 3 && vBits > 3, su = smaller ? uBits - 1 : uBits, sv = smaller ? vBits - 2 : vBits;
  const palette = bytes(k % 4 === 3 ? 4 * (1 + random() % 200) : 1024);
  return {key: `synthetic.wet${k}`, procedural: 'WetTexture', masked: false,
    values: {USize: uSize, VSize: vSize, UBits: uBits, VBits: vBits, GlobalPhase: random() & 0xffff, WaveAmp: random() & 255,
      NumDrops: k % 6 === 4 ? 300 : 1 + random() % 64},
    wet: {drops, palette: bytes(1024), source: {uBits: su, vBits: sv, pixels: bytes((1 << su) << sv), palette}}};
}
const SIZES = [[3, 3], [4, 5], [5, 3], [6, 6], [7, 7], [8, 8], [5, 7], [8, 6]];

const script = fileURLToPath(import.meta.url), run = promisify(execFile);
if (!process.argv.includes('--no-synthetic')) {
  const entries = [];
  for (let k = 0; k < 24; k++) { const data = syntheticWet(k, SIZES[k % SIZES.length]); entries.push({key: data.key, data}); }
  differential('synthetic wet', entries);
}
const allKeys = new Set();
for (const map of maps) {
  const {stdout} = await run(process.execPath, [script, '--collect', map], {maxBuffer: 1 << 24, env: process.env});
  const line = stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1);
  const {keys} = JSON.parse(line);
  if (!keys.length) throw new Error(`${map}: no procedural texture acquired`);
  const entries = [];
  for (const key of keys) { entries.push({key, data: await load(key)}); allKeys.add(key); }
  console.log(`${map}: acquired ${keys.join(', ')}`);
  differential(map, entries);
  if (bench) benchmark(map, entries);
}
if (option('no-all', null) === null && !process.argv.includes('--no-all')) {
  const entries = [];
  for (const name of ['Effects', 'BobPage', 'OceanLab']) {
    const asset = await assets.get(name);
    for (let i = 0; i < asset.pkg.exports.length; i++)
      if (['FireTexture', 'WetTexture'].includes(asset.pkg.exports[i].className))
        entries.push({key: `${asset.name}.${asset.pkg.exports[i].path}`, data: await textures.get(asset, i + 1, false)});
  }
  differential('all packages', entries);
  if (bench) benchmark('all packages', entries.filter(e => !allKeys.has(e.key)));
}
console.log('validate-fire-texture-rust: PASS');
