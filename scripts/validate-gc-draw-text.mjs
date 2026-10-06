/** Validate UGC::DrawText (native 1282) bit-exact vs the oracle.
 *
 * Replays the oracle's captured event stream (PushGC allocations,
 * TextureLock/Unlock realize-cache calls, DrawGlyphTile emits at the
 * render-interface vtable+0x7c) through the JS translation on a mirroring
 * heap.  The text pipeline (scanLine/nextChar/uFontGlyph) is the one
 * GetTextExtent already proves; the new boundary work is the glyph emit
 * block, the five-record realize cache, the underline second-emit, and
 * the PushGC/Intersect/PopGC frame around it.
 */
import { auditAssert } from './precision-audit.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';
import {buildCanvas, buildFont, buildGc, buildTexture, GcHeap,
        makeTexCache, resolveBits, DRAW_STUB, GLYPH_STUB, LOCK_STUB,
        UNLOCK_STUB} from './gc-services.mjs';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs).
const assert = auditAssert();

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.NATIVE_PROBE_PYTHON || path.join(ROOT, '.cache/native-probe-env/bin/python');
const MODULE = path.join(ROOT, 'src/runtime/script-gc-draw-text.mjs');
const RUNTIME = name => path.join(ROOT, 'src/runtime', name);
const SOURCES = {
  module: RUNTIME('script-gc-draw-text.mjs'),
  stateModel: RUNTIME('script-gc-state-model.mjs'),
  drawModel: RUNTIME('script-gc-draw-model.mjs'),
  fontModel: RUNTIME('script-font-model.mjs'),
  textExtent: RUNTIME('script-gc-get-text-extent.mjs'),
  pushGc: RUNTIME('script-gc-push-gc.mjs'),
  popGc: RUNTIME('script-gc-pop-gc.mjs'),
  intersect: RUNTIME('script-gc-intersect.mjs'),
  copyGc: RUNTIME('script-gc-copy-gc.mjs'),
};

const f32bits = v => { const b = new ArrayBuffer(4); new Float32Array(b)[0] = v; return new Uint32Array(b)[0]; };

async function loadExtension(root) {
  const extensionBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.u')));
  const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
    path: `System/${name}`,
    read: () => name === 'Extension.u'
      ? extensionBytes : readFile(path.join(root, 'System', name)),
  })));
  return assets.get('Extension');
}

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

function makeRunner(fn, heap, texCache) {
  return caseSpec => {
    heap.resetCase();
    const spec = {};
    for (const [key, value] of Object.entries(caseSpec.spec ?? {})) {
      if (key === 'hMultiplier') spec.unknown9c = resolveBits(value);
      else if (key === 'vMultiplier') spec.unknownA0 = resolveBits(value);
      else if (Array.isArray(value)) spec[key] = value.map(resolveBits);
      else if (value && typeof value === 'object'
               && ('$canvas' in value || '$font' in value || '$texture' in value))
        spec[key] = value;                    // buildGc's resolve builds it
      else spec[key] = resolveBits(value);
    }
    const {base} = buildGc(heap, spec);
    const args = (caseSpec.args ?? []).map(a => {
      if (a && typeof a === 'object') {
        if ('f' in a) return f32bits(a.f);
        if ('$text' in a) return a.$text;
        if ('$units' in a) return String.fromCharCode(...a.$units);
        if ('$font' in a) return buildFont(heap, a.$font);
        if ('$texture' in a) return buildTexture(heap, a.$texture);
      }
      return a >>> 0;
    });
    const services = {
      mem: heap,
      objectAddress: o => o.base,
      canon: a => heap.canon(a),
      allocateObject: a => heap.allocateObject(a),
      constructUObject: a => heap.constructUObject(a),
      texCache,
      callVirtual: (slot, thisArg, cmd) => {
        if (slot === DRAW_STUB) {
          heap.events.push({
            op: 'DrawTile', canvas: heap.canon(thisArg),
            texture: heap.canon(cmd.texture),
            x: cmd.x, y: cmd.y, xl: cmd.xl, yl: cmd.yl,
            u: cmd.u, v: cmd.v, ul: cmd.ul, vl: cmd.vl,
            spanBuffer: cmd.spanBuffer, z: cmd.z,
            color: [...cmd.color], fog: [...cmd.fog], polyFlags: cmd.polyFlags,
          });
        } else if (slot === GLYPH_STUB) {
          heap.events.push({
            op: 'DrawGlyphTile', ri: heap.canon(thisArg),
            node: heap.canon(cmd.node), record: heap.canon(cmd.record),
            texture: heap.canon(heap.read(cmd.record, 'u32')),
            x: cmd.x, y: cmd.y, xl: cmd.xl, yl: cmd.yl,
            u: cmd.u, v: cmd.v, ul: cmd.ul, vl: cmd.vl,
            spanBuffer: cmd.spanBuffer, z: cmd.z,
            color: [...cmd.color], fog: [...cmd.fog], polyFlags: cmd.polyFlags,
          });
        } else if (slot === LOCK_STUB) {
          heap.events.push({
            op: 'TextureLock', texture: heap.canon(thisArg),
            record: heap.canon(cmd.record),
            b0: heap.canon(cmd.b0), b4: heap.canon(cmd.b4),
            arg3: cmd.arg3, ri: heap.canon(cmd.ri),
          });
          heap.write(cmd.record, 'u32', thisArg);   // Lock fills record+0
        } else if (slot === UNLOCK_STUB) {
          heap.events.push({
            op: 'TextureUnlock', texture: heap.canon(thisArg),
            record: heap.canon(cmd.record),
          });
        } else {
          throw new Error(`callVirtual reached unknown slot 0x${slot.toString(16)}`);
        }
        return null;
      },
    };
    fn({base}, ...args, services);
    return heap.events.map(e => ({...e}));
  };
}

const mod = await import(url.pathToFileURL(MODULE).href);
const meta = mod.GC_DRAW_TEXT_NATIVE;
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
  ['DestX:float', 'DestY:float', 'destWidth:float', 'destHeight:float', 'textStr:string']);

const dllBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
assert.equal(createHash('sha256').update(dllBytes).digest('hex'), meta.dllSha256,
  'Extension.dll hash');
const bodyHash = (start, end) => createHash('sha256').update(
  dllBytes.subarray(start - meta.imageBase, end - meta.imageBase)).digest('hex');
assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256, 'exec body');
assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256, 'method body');
for (const [name, b] of Object.entries(mod.GC_DRAW_TEXT_BODIES))
  assert.equal(bodyHash(b.body, b.end), b.sha256, `${name} body`);

// ---- oracle ------------------------------------------------------------------
const oracle = JSON.parse(execFileSync(PYTHON, [
  path.join(ROOT, 'scripts', 'native-gc-draw-text-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
assert.equal(oracle.hashes['Extension.dll'], meta.dllSha256);
assert.equal(oracle.hashes['MSVCRT.dll'], meta.msvcrtSha256);
assert.equal(oracle.extensionBase, meta.oracleBase);
assert.equal(oracle.execBody, meta.execBody, 'exec body address');
assert.equal(oracle.methodBody, meta.methodBody, 'method body address');

// ---- bit-exact replay ----------------------------------------------------------
const report = {native: meta.function, cases: {}, mutations: []};

const runAll = async fn => {
  // One shared heap + realize cache per run — the oracle's cache is
  // process-global .bss that persists across cases, so prior-case textures
  // still occupy records when the next case runs (the Unlock events).
  const heap = new GcHeap();
  const texCache = makeTexCache(heap);
  const run = makeRunner(fn, heap, texCache);
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

for (const failure of await runAll(mod.gcDrawText)) {
  assert.fail(failure);
}
for (const name of Object.keys(oracle.cases)) report.cases[name] = 'pass';

// ---- adversarial mutation gate --------------------------------------------------
const sources = {};
for (const [key, file] of Object.entries(SOURCES)) sources[key] = readFileSync(file, 'utf8');
const basenames = {};
for (const [key, file] of Object.entries(SOURCES)) basenames[key] = path.basename(file);

const MUTATIONS = [
  {file: 'module',
   find: 'if (!(lineMaxH >= 1) && curFont !== 0)',
   replace: 'if (!(lineMaxH >= 2) && curFont !== 0)',
   note: 'line-height floor compares against 2 instead of the 1.0f constant'},
  {file: 'module',
   find: 'lineY = f32(lineMaxH + L.read(base + GC.textVSpacing',
   replace: 'lineY = f32(2 * lineMaxH + L.read(base + GC.textVSpacing',
   note: 'line advance doubles the line height'},
  {file: 'module',
   find: 'u2 = f32(-d);',
   replace: 'u2 = f32(d);',
   note: 'underline left-clip UV shift has the wrong sign'},
  {file: 'module',
   find: 'if (penX) penX.v = f32(w + penX.v);',
   replace: 'if (penX) penX.v = f32(h + penX.v);',
   note: 'pen advance adds glyph height instead of width'},
  {file: 'module',
   find: 'const forceTail = next === 0 && st.count >= TEXT_DRAW.cacheSize;',
   replace: 'const forceTail = next === 0 && st.count >= TEXT_DRAW.cacheSize - 1;',
   note: 'realize cache force-evicts the tail at four records, not five'},
  {file: 'module',
   find: 'const ri = L.read(L.read(sceneNode, \'u32\') + TEXT_DRAW.viewportRI, \'u32\');',
   replace: 'const ri = L.read(L.read(sceneNode, \'u32\') + 0x68, \'u32\');',
   note: 'glyph boundary reads *sceneNode+0x68 instead of +0x64'},
];

for (const [i, mutation] of MUTATIONS.entries()) {
  const source = sources[mutation.file];
  const hits = source.split(mutation.find).length - 1;
  assert.equal(hits, 1, `mutation ${i} find string occurs ${hits} times`);
  const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
  try {
    for (const [key, text] of Object.entries(sources))
      writeFileSync(path.join(dir, basenames[key]),
        // The copies import x87-pc24.mjs from src/runtime itself.
        (key === mutation.file ? source.replace(mutation.find, mutation.replace) : text)
          .replaceAll("from './x87-pc24.mjs'", "from '../x87-pc24.mjs'"));
    const mutated = await import(url.pathToFileURL(path.join(dir, path.basename(MODULE))).href);
    const failures = await runAll(mutated.gcDrawText);
    assert.ok(failures.length > 0,
      `mutation ${i} (${mutation.note}) produced identical behavior`);
    report.mutations.push({note: mutation.note, detail: failures[0]});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

console.log(JSON.stringify(report, null, 1));
if (assert.enabled) assert.report('validate-gc-draw-text');
