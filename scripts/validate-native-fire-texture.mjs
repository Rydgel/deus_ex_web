// Fire.dll's UFireTexture::ConstantTimeTick against fire-texture.mjs. The
// oracle (native-fire-texture-oracle.py) runs the hash-pinned DLL on
// fabricated textures and module state; after every tick the pixels, the
// sparks, the fields and the random generator must match byte for byte.
//
//   node scripts/validate-native-fire-texture.mjs [--only name-regex]
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {fireConstantTimeTick, redrawSparks, drawFlashRamp, fireTables, firePostLoad, calculateWater, waterRedrawDrops,
  waterConstruct, wetPostLoad, wetConstantTimeTick, setRefractionTable} from '../src/runtime/fire-texture.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let seed = 0xf12e;
// An LCG's low bits cycle (bit k with period 2^(k+1)), which starved the
// random-gated branches; the cases draw from its top 24 bits.
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
const bytes = (n, f = () => random() & 255) => Uint8Array.from({length: n}, f);
const hex = array => Buffer.from(array).toString('hex');
const unhex = text => Uint8Array.from(Buffer.from(text, 'hex'));

function makeCase(name, {uBits, vBits, rising = 1, sparks = [], ticks = 4, fields = {}, pixels = null, renderTable = null}) {
  const uSize = 1 << uBits, vSize = 1 << vBits;
  const sine = bytes(256), sineClamped = bytes(256), sineSigned = bytes(256);
  return {name, ticks, pentiumPro: 1,
    sine: hex(sine), sineClamped: hex(sineClamped), sineSigned: hex(sineSigned),
    random: hex(bytes(512)), randomIndex: (random() & 0xff) & 0xfc,
    renderTable: hex(renderTable ?? bytes(1028)), pixels: hex(pixels ?? bytes(uSize * vSize)),
    sparks: hex(Uint8Array.from(sparks.flat())),
    fields: {UBits: uBits, VBits: vBits, USize: uSize, VSize: vSize, UMask: uSize - 1, VMask: vSize - 1,
      GlobalPhase: random() & 0xffff, AuxPhase: random() & 255, FX_Frequency: random() & 255, bRising: rising,
      SparksLimit: Math.max(4, sparks.length), ActiveSparkNum: sparks.length, StarStatus: 0, ...fields}};
}

const cases = [];
for (const [uBits, vBits] of [[3, 3], [4, 3], [3, 5], [5, 5], [6, 4], [4, 7]])
  for (const rising of [1, 0])
    for (const pentiumPro of [1, 0])
      cases.push({...makeCase(`update ${rising ? 'rising' : 'still'} ${pentiumPro ? 'ppro' : 'p5'} ${1 << uBits}x${1 << vBits}`,
        {uBits, vBits, rising}), pentiumPro});
// Spark types: several sparks of one type with random bytes (X, Y inside the
// texture), on random pixels and generator state.
const NAMES = ['Burn', 'Sparkle', 'Pulse', 'Signal', 'Blaze', 'OzHasSpoken', 'Cone', 'BlazeRight', 'BlazeLeft',
  'Cylinder', 'Cylinder3D', 'Lissajous', 'Jugglers', 'Emit', 'Fountain', 'Flocks', 'Eels', 'Organic',
  'WanderOrganic', 'RandomCloud', 'CustomCloud', 'LocalCloud', 'Stars', 'LineLightning', 'RampLightning',
  'SphereLightning', 'Wheel', 'Gametes', 'Sprinkler'];
const TYPES = (option('types', '0-48')).split(',').flatMap(range => {
  const [a, b = a] = range.split('-').map(Number); return Array.from({length: b - a + 1}, (_, k) => a + k);
});
for (const type of TYPES)
  for (const [uBits, vBits] of [[5, 5], [6, 4], [4, 6], [7, 7]])
    for (let variant = 0; variant < 3; variant++) {
      const count = 1 + random() % 12, limit = count + random() % 24;
      const sparks = Array.from({length: count}, () => [type, random() & 255, random() & ((1 << uBits) - 1),
        random() & ((1 << vBits) - 1), random() & 255, random() & 255, random() & 255, random() & 255]);
      const c = makeCase(`spark ${NAMES[type] ?? type} ${1 << uBits}x${1 << vBits} #${variant}`,
        {uBits, vBits, rising: random() & 1, sparks, ticks: 6});
      c.fields.SparksLimit = limit;
      // Room for the temporaries a spark emits: the array is SparksLimit long.
      c.sparks += '00'.repeat(8 * (limit - count));
      cases.push(c);
    }
// Mixed populations of every authored type, long enough for emitted
// temporaries to live, collide with the limit, die and be replaced.
for (let variant = 0; variant < 8; variant++) {
  const [uBits, vBits] = [[5, 5], [6, 6], [7, 5], [4, 7]][variant % 4];
  const count = 4 + random() % 20, limit = count + 8 + random() % 64;
  const sparks = Array.from({length: count}, () => [random() % 0x1d, random() & 255, random() & ((1 << uBits) - 1),
    random() & ((1 << vBits) - 1), random() & 255, random() & 255, random() & 255, random() & 255]);
  const c = makeCase(`mixed ${1 << uBits}x${1 << vBits} #${variant}`, {uBits, vBits, rising: variant & 1, sparks, ticks: 40});
  c.fields.SparksLimit = limit;
  c.sparks += '00'.repeat(8 * (limit - count));
  cases.push(c);
}
// DrawFlashRamp (0x105022f0) on its own: segments of every sign and
// major-axis combination.
for (let k = 0; k < 160; k++) {
  const small = () => random() % 4 === 0 ? random() & 7 : random() & 63;
  const c = makeCase(`flash ${k}`, {uBits: 5, vBits: 5, ticks: 1});
  c.entry = 'flash';
  c.flash = [random() & 31, random() & 31, small(), small(), random() & 255, random() & 255];
  cases.push(c);
}
// The module tables' construction with MSVCRT rand streams.
for (const seed of [1, 0x1234, 0xdeadbeef, 42]) {
  const rng = createNativeRng(seed);
  cases.push({name: `tables seed ${seed}`, entry: 'tables', rand: Array.from({length: 512}, () => rng.rand())});
}
// PostLoad: RenderTable for heats old and new, and spark arrays trimmed,
// grown and clamped (the array is already Serialize's: at least the raw limit).
for (let k = 0; k < 40; k++) {
  const rawLimit = [2, 3, 4, 9, 40, 9000, 64][k % 7] + (k > 20 ? random() % 5 : 0);
  const serialized = random() % 60;
  const num = Math.max(serialized, rawLimit);
  const sparks = Array.from({length: num}, () => [random() % 3 ? random() % 0x1d : 0x1f + random() % 13,
    random() & 255, random() & 31, random() & 31, random() & 255, random() & 255, random() & 255, random() & 255]);
  const heat = random() & 255;
  const c = makeCase(`postLoad #${k}`, {uBits: 5, vBits: 5, sparks, ticks: 1,
    fields: {RenderHeat: heat, OldRenderHeat: k % 5 === 0 ? heat : random() & 255, SparksLimit: rawLimit,
      ActiveSparkNum: Math.min(num, random() % (num + 4))}});
  c.entry = 'postLoad';
  cases.push(c);
}
// CalculateWater: random fields and tables over sizes, both parities, ticks.
for (const [w, h] of [[16, 16], [32, 32], [64, 32], [32, 64], [128, 128], [256, 256]])
  for (const parity of [0, 1]) {
    const fieldSize = (w >> 1) * (h >> 1) * 2;
    cases.push({name: `water ${w}x${h} p${parity}`, entry: 'water', size: [w, h], parity, ticks: 4,
      field: hex(bytes(fieldSize)), pixels: hex(bytes(w * h)), renderTable: hex(bytes(1028)), waveTable: hex(bytes(1536))});
  }
// WaterRedrawDrops: drops of one type (X, Y within the half-size field).
const DROPS = ['FixedDepth', 'PhaseSpot', 'ShallowSpot', 'HalfAmpl', 'RandomMover', 'FixedRandomSpot', 'WhirlyThing',
  'BigWhirly', 'HorizontalLine', 'VerticalLine', 'DiagonalLine1', 'DiagonalLine2', 'HorizontalOsc', 'VerticalOsc',
  'DiagonalOsc1', 'DiagonalOsc2', 'RainDrops', 'AreaClamp', 'LeakyTap', 'DrippyTap'];
const DROP_TYPES = (option('drops', '0-19,64-65,20')).split(',').flatMap(range => {
  const [a, b = a] = range.split('-').map(Number); return Array.from({length: b - a + 1}, (_, k) => a + k);
});
for (const type of DROP_TYPES)
  for (const [w, h] of [[32, 32], [64, 64], [128, 64], [256, 256]])
    for (let variant = 0; variant < 3; variant++) {
      const hw = w >> 1, hh = h >> 1, count = 1 + random() % 10;
      const drops = new Uint8Array(2048);
      for (let k = 0; k < 256; k++) for (let b = 0; b < 8; b++) drops[k * 8 + b] = random() & 255;
      for (let k = 0; k < count; k++) {
        drops[k * 8] = type; drops[k * 8 + 2] = random() % hw; drops[k * 8 + 3] = random() % hh;
      }
      const c = makeCase(`drop ${DROPS[type] ?? type} ${w}x${h} #${variant}`, {uBits: 5, vBits: 5});
      Object.assign(c, {entry: 'drops', size: [w, h], ticks: 5, globalPhase: random() & 0xffff,
        fx: Array.from({length: 10}, () => random() & 255), numDrops: count, drops: hex(drops),
        field: hex(bytes(hw * hh * 2))});
      cases.push(c);
    }
// UWaterTexture's constructor, UWetTexture's PostLoad and ConstantTimeTick.
cases.push({name: 'water construct', entry: 'construct'});
const wetSource = (w, h, palette = 0x5150) => ({size: [w, h], palette, pixels: hex(bytes(w * h))});
for (const [w, h] of [[32, 64], [64, 64], [128, 128], [256, 256], [8, 16]]) {
  const base = {entry: 'wetPostLoad', size: [w, h], palette: 0x7770, waveAmp: 1 + random() % 255};
  const variants = {
    'same size': {source: wetSource(w, h)},
    'smaller source': {source: wetSource(Math.max(1, w >> 1), Math.max(1, h >> 2))},
    'narrower source': {source: wetSource(Math.max(1, w >> 3), h)},
    'larger source': {source: wetSource(w * 2, h), local: hex(bytes(w * h))},
    'no source': {field: hex(bytes(w * h / 2)), oldWaveAmp: 7},
    'self source': {sourceSelf: true},
    'kept tables': {source: wetSource(w, h), field: hex(bytes(w * h / 2)), renderTable: hex(bytes(1028)), oldSourceSame: true},
    'local freed': {source: wetSource(w, h), local: hex(bytes(w * h))},
    'local rebuilt': {source: wetSource(w >> 1, h >> 1), local: hex(bytes(w * h))},
  };
  for (const [label, extra] of Object.entries(variants)) {
    const c = {name: `wet postLoad ${label} ${w}x${h}`, ...base, ...extra};
    if (label === 'kept tables') c.oldWaveAmp = c.waveAmp;
    cases.push(c);
  }
}
const waveTable = hex(waterConstruct({}).waveTable);
for (const [w, h] of [[32, 64], [64, 64], [128, 128], [256, 256], [4, 64]])
  for (const [label, extra] of Object.entries({
    'game drops': {dropTypes: [16, 2, 6, 1, 12]}, 'mixed drops': {dropTypes: [...Array(20).keys(), 64, 65]},
    'smaller source': {dropTypes: [2, 6], small: true}, 'no source': {dropTypes: [1], noSource: true}})) {
    const hw = w >> 1, hh = h >> 1, count = 1 + random() % 40, drops = bytes(2048);
    for (let k = 0; k < count; k++) {
      drops[k * 8] = extra.dropTypes[random() % extra.dropTypes.length]; drops[k * 8 + 2] = random() % hw; drops[k * 8 + 3] = random() % hh;
    }
    const wet = {waveAmp: 1 + random() % 255, renderTable: new Uint8Array(1028)};
    setRefractionTable(wet);
    const c = makeCase(`wet tick ${label} ${w}x${h}`, {uBits: 5, vBits: 5});
    const sw = extra.small ? w >> 1 : w, sh = extra.small ? h >> 1 : h;
    Object.assign(c, {entry: 'wetTick', size: [w, h], ticks: 6, palette: 0x7770, waveAmp: wet.waveAmp,
      renderTable: random() & 1 ? hex(wet.renderTable) : hex(bytes(1028)), waveTable, parity: random() & 255,
      globalPhase: random() & 0xffff, numDrops: count, drops: hex(drops), field: hex(bytes(hw * h)),
      pixels: hex(bytes(w * h)), time: (random() % 100000) / 64, source: extra.noSource ? null : wetSource(sw, sh)});
    if (extra.small) c.local = hex(bytes(w * h));
    cases.push(c);
  }
const selected = only ? cases.filter(c => new RegExp(only).test(c.name)) : cases;
// --redraw: RedrawSparks alone (0x105025b0), without the fire update.
const redrawOnly = process.argv.includes('--redraw');
if (redrawOnly) for (const c of selected) if (!c.entry) c.entry = 'redraw';

const dir = path.resolve('reports/rendering');
await mkdir(dir, {recursive: true});
const casesPath = path.join(dir, 'fire-texture-cases.json');
await writeFile(casesPath, JSON.stringify(selected));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-fire-texture-oracle.py', gameDirectory(), casesPath], {maxBuffer: 512 * 1024 * 1024});
const native = JSON.parse(stdout);

const mismatches = [];
selected.forEach((c, i) => {
  if (c.entry === 'tables') {
    const rand = [...c.rand], tables = fireTables(() => rand.shift()), expected = native.results[i];
    try {
      for (const key of ['sine', 'sineClamped', 'sineSigned']) assert.equal(hex(tables[key]), expected[key], `${c.name}: ${key}`);
      assert.equal(hex(new Uint8Array(tables.random.buffer)), expected.random, `${c.name}: random`);
      assert.equal(tables.randomIndex, expected.randomIndex, `${c.name}: random index`);
      assert.equal(expected.left, 0, 'all 512 appRand values used');
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  if (c.entry === 'construct') {
    const expected = native.results[i], water = waterConstruct({});
    try {
      assert.equal(hex(water.waveTable), expected.waveTable, 'WaveTable');
      assert.equal(water.oldWaveAmp, expected.oldWaveAmp, 'OldWaveAmp');
      assert.equal(water.waveParity, expected.waveParity, 'WaveParity');
      assert.deepEqual([water.globalPhase, water.drawPhase, water.auxPhase], expected.phases, 'phases');
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  if (c.entry === 'wetPostLoad' || c.entry === 'wetTick') {
    const [w, h] = c.size, given = c.local == null ? null : unhex(c.local);
    const source = c.source && {uBits: Math.log2(c.source.size[0]), vBits: Math.log2(c.source.size[1]),
      palette: c.source.palette, pixels: unhex(c.source.pixels)};
    const wet = {uBits: Math.log2(w), vBits: Math.log2(h), uSize: w, vSize: h, palette: c.palette, waveAmp: c.waveAmp,
      oldWaveAmp: c.oldWaveAmp ?? -1, renderTable: unhex(c.renderTable ?? '00'.repeat(1028)),
      waveTable: unhex(c.waveTable ?? '00'.repeat(1536)), waveParity: c.parity ?? 0, globalPhase: c.globalPhase ?? 0,
      numDrops: c.numDrops ?? 0, drops: unhex(c.drops ?? '00'.repeat(2048)), fields: c.field == null ? undefined : unhex(c.field),
      pixels: unhex(c.pixels ?? '00'.repeat(w * h)), local: given};
    wet.source = c.sourceSelf ? wet : source ?? null;
    wet.oldSource = c.oldSourceSame ? wet.source : null;
    if (c.entry === 'wetTick') { wet.uMask = w - 1; wet.vMask = h - 1; }
    const name = value => value == null ? null : value === wet ? 'self' : value === source ? 'source' : 'other';
    const lockCalls = () => wet.source && wet.source !== wet && wet.uSize >= 8 && wet.vSize >= 8
      ? [['lock', 'source', c.time ?? 0, 0, 0], ['unlock', 'source']] : [];
    const check = (expected, where) => {
      if (c.entry === 'wetPostLoad') {
        assert.deepEqual([wet.uMask, wet.vMask], expected.masks, `${where}: masks`);
        assert.equal(wet.palette, expected.palette, `${where}: palette`);
        assert.equal(hex(wet.renderTable), expected.renderTable, `${where}: RenderTable`);
        assert.equal(wet.oldWaveAmp, expected.oldWaveAmp, `${where}: OldWaveAmp`);
        assert.equal(name(wet.oldSource), expected.oldSource, `${where}: OldSourceTex`);
        assert.equal(wet.local == null ? null : wet.local === given ? 'kept' : hex(wet.local), expected.local, `${where}: LocalSourceBitmap`);
      }
      assert.equal(name(wet.source), expected.source, `${where}: SourceTexture`);
      assert.equal(wet.fields ? hex(wet.fields) : null, expected.field, `${where}: SourceFields`);
      assert.equal(hex(wet.pixels), expected.pixels, `${where}: pixels`);
      assert.equal(wet.globalPhase, expected.globalPhase, `${where}: GlobalPhase`);
      assert.equal(wet.waveParity, expected.parity, `${where}: WaveParity`);
      assert.equal(hex(wet.drops), expected.drops, `${where}: drops`);
    };
    try {
      if (c.entry === 'wetPostLoad') {
        wetPostLoad(wet);
        const expected = native.results[i];
        check(expected, c.name);
        const calls = expected.calls.filter(([k]) => k === 'lock' || k === 'unlock');
        assert.deepEqual(calls, c.source && !c.sourceSelf ? [['lock', 'source', 0, 0, 0], ['unlock', 'source']] : [], `${c.name}: Lock`);
      } else {
        const globals = {sine: unhex(c.sine), random: new DataView(unhex(c.random).buffer), randomIndex: c.randomIndex};
        native.results[i].steps.forEach((expected, step) => {
          wetConstantTimeTick(wet, globals);
          const where = `${c.name} tick ${step}`;
          check(expected, where);
          assert.equal(hex(new Uint8Array(globals.random.buffer, 0, 256)), expected.random, `${where}: random`);
          assert.equal(globals.randomIndex, expected.randomIndex, `${where}: random index`);
          assert.deepEqual(expected.calls, lockCalls(), `${where}: Lock`);
        });
      }
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  if (c.entry === 'drops') {
    const globals = {sine: unhex(c.sine), sineClamped: unhex(c.sineClamped), sineSigned: unhex(c.sineSigned),
      random: new DataView(unhex(c.random).buffer), randomIndex: c.randomIndex};
    const [w, h] = c.size, fx = c.fx;
    const water = {uBits: Math.log2(w), uSize: w, vSize: h, uMask: w - 1, vMask: h - 1, globalPhase: c.globalPhase,
      dropType: fx[0], waveAmp: fx[1], fxFrequency: fx[2], fxPhase: fx[3], fxAmplitude: fx[4], fxSpeed: fx[5],
      fxRadius: fx[6], fxSize: fx[7], fxDepth: fx[8], fxTime: fx[9], numDrops: c.numDrops, drops: unhex(c.drops),
      fields: unhex(c.field)};
    try {
      native.results[i].steps.forEach((expected, step) => {
        waterRedrawDrops(water, globals);
        const where = `${c.name} tick ${step}`;
        assert.equal(hex(new Uint8Array(globals.random.buffer, 0, 256)), expected.random, `${where}: random`);
        assert.equal(globals.randomIndex, expected.randomIndex, `${where}: random index`);
        assert.equal(hex(water.fields), expected.field, `${where}: field`);
        assert.equal(hex(water.drops), expected.drops, `${where}: drops`);
        assert.equal(water.numDrops, expected.numDrops, `${where}: NumDrops`);
        assert.equal(water.globalPhase, expected.globalPhase, `${where}: GlobalPhase`);
      });
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  if (c.entry === 'water') {
    const water = {uSize: c.size[0], vSize: c.size[1], waveParity: c.parity, fields: unhex(c.field), pixels: unhex(c.pixels),
      renderTable: unhex(c.renderTable), waveTable: unhex(c.waveTable)};
    try {
      native.results[i].steps.forEach((expected, step) => {
        calculateWater(water);
        assert.equal(water.waveParity, expected.parity, `${c.name} tick ${step}: parity`);
        assert.equal(hex(water.fields), expected.field, `${c.name} tick ${step}: field`);
        assert.equal(hex(water.pixels), expected.pixels, `${c.name} tick ${step}: pixels`);
      });
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  if (c.entry === 'postLoad') {
    const f = c.fields, expected = native.results[i].steps[0];
    const t = {uSize: f.USize, vSize: f.VSize, renderHeat: f.RenderHeat, oldRenderHeat: f.OldRenderHeat,
      sparksLimit: f.SparksLimit, activeSparkNum: f.ActiveSparkNum, renderTable: unhex(c.renderTable)};
    try {
      firePostLoad(t, unhex(c.sparks));
      assert.equal(hex(t.renderTable), expected.renderTable, `${c.name}: RenderTable`);
      for (const [key, field] of [['oldRenderHeat', 'OldRenderHeat'], ['sparksLimit', 'SparksLimit'],
        ['activeSparkNum', 'ActiveSparkNum'], ['uMask', 'UMask'], ['vMask', 'VMask']])
        assert.equal(t[key], expected.fields[field], `${c.name}: ${field}`);
      assert.equal(t.sparks.length / 8, expected.sparkNum, `${c.name}: array size`);
      assert.equal(hex(t.sparks.subarray(0, Math.min(t.sparks.length, expected.sparks.length / 2))),
        expected.sparks.slice(0, 2 * Math.min(t.sparks.length, expected.sparks.length / 2)), `${c.name}: sparks`);
    } catch (error) { mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)}); }
    return;
  }
  const globals = {sine: unhex(c.sine), sineClamped: unhex(c.sineClamped), sineSigned: unhex(c.sineSigned),
    random: new DataView(unhex(c.random).buffer), randomIndex: c.randomIndex};
  const f = c.fields;
  const texture = {uBits: f.UBits, uSize: f.USize, vSize: f.VSize, uMask: f.UMask, vMask: f.VMask,
    globalPhase: f.GlobalPhase, auxPhase: f.AuxPhase, fxFrequency: f.FX_Frequency, bRising: f.bRising,
    sparksLimit: f.SparksLimit, activeSparkNum: f.ActiveSparkNum, starStatus: f.StarStatus,
    sparks: unhex(c.sparks), renderTable: unhex(c.renderTable), pixels: unhex(c.pixels)};
  try {
    native.results[i].steps.forEach((expected, step) => {
      if (c.entry === 'flash') drawFlashRamp(texture, globals, c.flash.slice(0, 4), c.flash[4], c.flash[5]);
      else if (redrawOnly) redrawSparks(texture, globals);
      else fireConstantTimeTick(texture, globals);
      const where = `${c.name} tick ${step}`;
      assert.equal(hex(new Uint8Array(globals.random.buffer, 0, 256)), expected.random, `${where}: random`);
      assert.equal(globals.randomIndex, expected.randomIndex, `${where}: random index`);
      if (hex(texture.pixels) !== expected.pixels) {
        const want = unhex(expected.pixels), diff = [];
        for (let k = 0; k < want.length; k++) if (want[k] !== texture.pixels[k]) diff.push(k);
        throw new Error(`${where}: pixels differ at ${diff.length} offsets, first ${diff[0]} (x ${diff[0] & (f.USize - 1)}, y ${diff[0] >> f.UBits}): ${texture.pixels[diff[0]]} vs ${want[diff[0]]}`);
      }
      assert.equal(hex(texture.sparks.subarray(0, expected.sparks.length / 2)), expected.sparks, `${where}: sparks`);
      assert.equal(texture.globalPhase, expected.fields.GlobalPhase, `${where}: GlobalPhase`);
      assert.equal(texture.auxPhase, expected.fields.AuxPhase, `${where}: AuxPhase`);
      assert.equal(texture.activeSparkNum, expected.fields.ActiveSparkNum, `${where}: ActiveSparkNum`);
      assert.equal(texture.starStatus, expected.fields.StarStatus, `${where}: StarStatus`);
    });
  } catch (error) {
    mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)});
  }
});
console.log(JSON.stringify({cases: selected.length, mismatches: mismatches.length, first: mismatches.slice(0, 5)}, null, 1));
assert.equal(mismatches.length, 0);
