/** Validate UGC::DrawTexture (native 1284) bit-exact vs the oracle.
 *
 * The oracle's captured DrawTile argument stream (20 pushed dwords per call)
 * is replayed through the JS translation on a synthetic heap carrying the
 * same fake canvas (vtable slot +0x5c -> a sentinel the callVirtual service
 * records) and the same fake texture objects.  Comparison is on raw f32 bit
 * patterns — no approximate float equality anywhere in the path.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';
import {buildGc, GcHeap} from './gc-services.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.NATIVE_PROBE_PYTHON || path.join(ROOT, '.cache/native-probe-env/bin/python');
const MODULE = path.join(ROOT, 'src/runtime/script-gc-draw-texture.mjs');
const MODEL = path.join(ROOT, 'src/runtime/script-gc-draw-model.mjs');
const STATE_MODEL = path.join(ROOT, 'src/runtime/script-gc-state-model.mjs');

const DRAW_TILE_SLOT = 0x5c;   // UCanvas vtable slot (see script-gc-draw-model.mjs)
const CANVAS_Z = 0x4c;
const TEX_USIZE = 0x34;
const TEX_VSIZE = 0x38;
const DRAW_STUB = 0xdeadc0de;  // sentinel at the fake vtable slot

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32bits = v => { F32[0] = v; return U32[0]; };
const resolveBits = v => (v && typeof v === 'object' && 'f' in v ? f32bits(v.f) : v >>> 0);

async function loadExtension(root) {
  const extensionBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.u')));
  const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
    path: `System/${name}`,
    read: () => name === 'Extension.u'
      ? extensionBytes : readFile(path.join(root, 'System', name)),
  })));
  return assets.get('Extension');
}

/** First leaf-level difference between two JSON-comparable values. */
function firstDiff(got, expected, path = '') {
  if (Object.is(got, expected)) return null;
  if (typeof got !== 'object' || typeof expected !== 'object' || !got || !expected)
    return {path: path || '$', got, expected};
  for (const key of new Set([...Object.keys(got), ...Object.keys(expected)])) {
    const d = firstDiff(got[key], expected[key], path ? `${path}.${key}` : key);
    if (d) return d;
  }
  return null;
}

/**
 * Replay one case through the JS module on a fresh heap that mirrors the
 * probe: the fake canvas + recording vtable slot, fake textures, and the
 * DrawTile capture service behind services.callVirtual.
 */
function makeRunner(fn) {
  return caseSpec => {
    const heap = new GcHeap();
    const spec = {};
    let texCount = 0;
    for (const [key, value] of Object.entries(caseSpec.spec ?? {})) {
      if (key === 'canvas' && value && typeof value === 'object' && '$canvas' in value) {
        const canvas = heap.allocRaw(0x80);
        const vtable = heap.allocRaw(0x100);
        heap.write(canvas, 'u32', vtable);
        heap.write(vtable + DRAW_TILE_SLOT, 'u32', DRAW_STUB);
        heap.write(canvas + CANVAS_Z, 'u32', resolveBits(value.$canvas.z ?? 0));
        heap.labels.set(canvas, 'canvas');
        spec.canvas = canvas;
      } else if (key === 'fill') {
        spec.fill = value;
      } else if (key === 'hMultiplier' || key === 'vMultiplier') {
        // gc-services GC_FIELDS still carries the pre-identification names.
        spec[key === 'hMultiplier' ? 'unknown9c' : 'unknownA0'] = resolveBits(value);
      } else if (Array.isArray(value)) {
        spec[key] = value.map(resolveBits);
      } else {
        spec[key] = resolveBits(value);
      }
    }
    const {base} = buildGc(heap, spec);
    const args = (caseSpec.args ?? []).map(a => {
      if (a && typeof a === 'object') {
        if ('f' in a) return f32bits(a.f);
        if ('$texture' in a) {
          const tex = heap.allocRaw(0x60);
          heap.write(tex + TEX_USIZE, 'i32', a.$texture.u | 0);
          heap.write(tex + TEX_VSIZE, 'i32', a.$texture.v | 0);
          heap.labels.set(tex, `tex${texCount++}`);
          return tex;
        }
      }
      return a >>> 0;
    });
    heap.events.length = 0;
    const services = {
      mem: heap,
      objectAddress: o => o.base,
      canon: a => heap.canon(a),
      callVirtual: (slot, canvas, cmd) => {
        if (slot !== DRAW_STUB)
          throw new Error(`callVirtual reached unknown slot 0x${slot.toString(16)}`);
        heap.events.push({
          op: 'DrawTile', canvas: heap.canon(canvas), texture: heap.canon(cmd.texture),
          x: cmd.x, y: cmd.y, xl: cmd.xl, yl: cmd.yl,
          u: cmd.u, v: cmd.v, ul: cmd.ul, vl: cmd.vl,
          spanBuffer: cmd.spanBuffer, z: cmd.z,
          color: [...cmd.color], fog: [...cmd.fog], polyFlags: cmd.polyFlags,
        });
        return null;
      },
    };
    fn({base}, ...args, services);
    return heap.events.map(e => ({...e}));
  };
}

const meta = (await import(url.pathToFileURL(MODULE).href)).GC_DRAW_TEXTURE_NATIVE;
const root = gameDirectory();
const extension = await loadExtension(root);

// ---- metadata + body hashes ------------------------------------------------
const exportIndex = extension.exportsByPath.get(meta.function.toLowerCase());
assert.equal(exportIndex, meta.packageExport, `${meta.function} export index`);
const md = readFunctionMetadata(extension, exportIndex);
assert.equal(md.nativeIndex, meta.nativeIndex);
assert.equal(md.functionFlags, meta.functionFlags);
assert.equal(md.entry.serialSize, meta.serialSize);
assert.deepEqual(md.parameters.map(p => `${p.name}:${p.type?.name ?? p.type}`),
  ['DestX:float', 'DestY:float', 'destWidth:float', 'destHeight:float',
   'srcX:float', 'srcY:float', 'tX:object']);

const dllBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
assert.equal(createHash('sha256').update(dllBytes).digest('hex'), meta.dllSha256,
  'Extension.dll hash');
const bodyHash = (start, end) => createHash('sha256').update(
  dllBytes.subarray(start - meta.imageBase, end - meta.imageBase)).digest('hex');
assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256, 'exec body');
assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256, 'method body');
const {GC_DRAW_BODIES} = await import(url.pathToFileURL(MODEL).href);
for (const [name, b] of Object.entries(GC_DRAW_BODIES))
  assert.equal(bodyHash(b.body, b.end), b.sha256, `${name} body`);

// ---- oracle ------------------------------------------------------------------
const oracle = JSON.parse(execFileSync(PYTHON, [
  path.join(ROOT, 'scripts', 'native-gc-draw-texture-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
assert.equal(oracle.hashes['Extension.dll'], meta.dllSha256);
assert.equal(oracle.hashes['MSVCRT.dll'], meta.msvcrtSha256);
assert.equal(oracle.extensionBase, meta.oracleBase);
assert.equal(oracle.execBody, meta.execBody, 'exec body address');
assert.equal(oracle.methodBody, meta.methodBody, 'method body address');

// ---- bit-exact replay ----------------------------------------------------------
// The oracle folds each case's spec back into its output, so the identical
// input table drives both sides — there is no second source of truth.
const cleanMod = await import(url.pathToFileURL(MODULE).href);
const report = {native: meta.function, cases: {}, mutations: []};

const runAll = async fn => {
  const run = makeRunner(fn);
  const failures = [];
  for (const [name, caseSpec] of Object.entries(oracle.cases)) {
    let got;
    try {
      got = run(caseSpec);
    } catch (error) {
      failures.push(`${name}: threw ${error.message}`);
      continue;
    }
    const diff = firstDiff(got, caseSpec.events);
    if (diff) {
      failures.push(`${name}: ${diff.path} js=${JSON.stringify(diff.got)}`
        + ` oracle=${JSON.stringify(diff.expected)}`);
    }
  }
  return failures;
};

for (const failure of await runAll(cleanMod.gcDrawTexture)) {
  assert.fail(failure);
}
for (const name of Object.keys(oracle.cases)) report.cases[name] = 'pass';

// ---- adversarial mutation gate --------------------------------------------------
const sources = {
  module: readFileSync(MODULE, 'utf8'),
  model: readFileSync(MODEL, 'utf8'),
  stateModel: readFileSync(STATE_MODEL, 'utf8'),
};
const MUTATIONS = [
  {file: 'module',
   find: "L.read(L.base + GC.flags, 'u32') & GC_FLAGS.drawing",
   replace: "L.read(L.base + GC.flags, 'u32') & GC_FLAGS.smoothing",
   note: 'drawing-enabled gate tests bit0 (smoothing) instead of bit1'},
  {file: 'model',
   find: 'vtable + GC_DRAW.drawTileSlot',
   replace: 'vtable + 0x60',
   note: 'boundary reads vtable slot +0x60 instead of DrawTile +0x5c'},
  {file: 'model',
   find: 'L.read(L.base + GC_DRAW.tilePlane + 4 * i',
   replace: 'L.read(L.base + GC.textFloats + 4 * i',
   note: 'DrawTile color sourced from textFloats +0x6c instead of tilePlane +0x58'},
  {file: 'model',
   find: 's.x = f32(readF(GC.originX) + s.x);',
   replace: 's.x = f32(s.x);',
   note: 'clip drops the originX add (origin/scale transform site)'},
  {file: 'model',
   find: 'Math.trunc(v + GC_DRAW_FTOL_BIAS)',
   replace: 'Math.trunc(v + 0.5)',
   note: 'coord conversion biases +0.5 instead of the recovered +0.1 constant'},
  {file: 'model',
   find: 'Math.imul(ftolBiased(s.x), hMult)',
   replace: 'Math.imul(ftolBiased(s.x), vMult)',
   note: 'X dest coord multiplies by vMultiplier instead of hMultiplier'},
];

for (const [i, mutation] of MUTATIONS.entries()) {
  const source = sources[mutation.file];
  const hits = source.split(mutation.find).length - 1;
  assert.equal(hits, 1, `mutation ${i} find string occurs ${hits} times`);
  const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
  try {
    for (const [key, text] of Object.entries(sources)) {
      const name = {module: path.basename(MODULE), model: path.basename(MODEL),
                    stateModel: path.basename(STATE_MODEL)}[key];
      writeFileSync(path.join(dir, name),
        key === mutation.file ? source.replace(mutation.find, mutation.replace) : text);
    }
    const mutated = await import(url.pathToFileURL(path.join(dir, path.basename(MODULE))).href);
    const failures = await runAll(mutated.gcDrawTexture);
    assert.ok(failures.length > 0,
      `mutation ${i} (${mutation.note}) produced identical behavior`);
    report.mutations.push({note: mutation.note, detail: failures[0]});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

console.log(JSON.stringify(report, null, 1));
