/** Validate GC.DrawActor (1288) and GC.ClearZ (1295) bit-exact against the
 * real Extension.dll bodies under Unicorn (scripts/native-gc-draw-actor-oracle.py,
 * x87 control word 0x007f, the shipped MSVCRT _ftol): the render-device
 * ClearZ, URenderBase::DrawActor and FSceneNode::ComputeRenderSize leaves
 * are recording stubs that snapshot the actor and frame at the call, so the
 * comparison covers the ordered events and the final byte images of the GC,
 * the actor and the scene frame (a stray write shows). Evidence:
 * docs/gc-draw-actor.md. */
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
const MODULE = path.join(ROOT, 'src/runtime/script-gc-draw-actor.mjs');

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32bits = v => { F32[0] = v; return U32[0]; };
const bits = v => (v && typeof v === 'object' ? ('bits' in v ? v.bits >>> 0 : f32bits(v.f)) : v >>> 0);

const A = {flags: 0x28, lastRender: 0x34, style: 0x165, skin: 0x170, drawScale: 0x17c, scaleGlow: 0x18c, word194: 0x194, multiSkins: 0x1a4};
const FRAME = {x: 0xa8, y: 0xac, xb: 0xb0, yb: 0xb4, size: 0x300};
const ACTOR_SIZE = 0x200;
const hex = (heap, at, size) => Buffer.from(heap.bytes.subarray(at, at + size)).toString('hex');

/** The oracle's images, built on a fresh heap in the same order. */
function buildCase(caseSpec) {
  const heap = new GcHeap();
  const names = new Map();
  const label = (address, name) => { heap.labels.set(address, name); names.set(address, name); };
  const gcSpec = {};
  for (const [key, value] of Object.entries(caseSpec.spec)) {
    if (key === 'canvas') continue;
    gcSpec[key === 'hMultiplier' ? 'unknown9c' : key === 'vMultiplier' ? 'unknownA0' : key] = Array.isArray(value) ? value.map(bits) : bits(value);
  }
  const {base} = buildGc(heap, gcSpec);
  let frame = 0;
  const canvasSpec = caseSpec.spec.canvas;
  if (canvasSpec && canvasSpec.$actorCanvas) {
    const fill = (canvasSpec.$actorCanvas.fill ?? 0x3c) & 0xff;
    const canvas = heap.allocRaw(0x100); heap.bytes.fill(fill, canvas, canvas + 0x100);
    const viewport = heap.allocRaw(0xc0); heap.bytes.fill(0, viewport, viewport + 0xc0);
    const rendev = heap.allocRaw(0x40), rendevTable = heap.allocRaw(0x100);
    heap.bytes.fill(0, rendevTable, rendevTable + 0x100); heap.bytes.fill(0, rendev, rendev + 0x40);
    heap.write(rendevTable + 0x90, 'u32', 0xdeadc001); heap.write(rendev, 'u32', rendevTable);
    heap.write(viewport + 0x64, 'u32', rendev);
    const render = heap.allocRaw(0x40), renderTable = heap.allocRaw(0x100);
    heap.bytes.fill(0, renderTable, renderTable + 0x100); heap.bytes.fill(0, render, render + 0x40);
    heap.write(renderTable + 0x74, 'u32', 0xdeadc002); heap.write(render, 'u32', renderTable);
    frame = heap.allocRaw(FRAME.size); heap.bytes.fill(0x5a, frame, frame + FRAME.size);
    const fs = canvasSpec.$actorCanvas.frame ?? {};
    heap.write(frame, 'u32', 0);
    heap.write(frame + FRAME.x, 'i32', fs.x ?? 640); heap.write(frame + FRAME.y, 'i32', fs.y ?? 480);
    heap.write(frame + FRAME.xb, 'i32', fs.xb ?? 0); heap.write(frame + FRAME.yb, 'i32', fs.yb ?? 0);
    heap.write(canvas + 0x78, 'u32', viewport); heap.write(canvas + 0x7c, 'u32', frame); heap.write(canvas + 0x80, 'u32', render);
    heap.write(base + 0x28, 'u32', canvas);
    label(canvas, 'canvas'); label(viewport, 'viewport'); label(rendev, 'rendev'); label(render, 'render'); label(frame, 'frame');
  } else heap.write(base + 0x28, 'u32', bits(canvasSpec ?? 0));
  const textures = new Map();
  const texture = k => {
    if (!textures.has(k)) { const a = heap.allocRaw(0x40); heap.bytes.fill(0, a, a + 0x40); textures.set(k, a); label(a, `tex${k}`); }
    return textures.get(k);
  };
  let actor = 0;
  const a = caseSpec.actor;
  if (a) {
    actor = heap.allocRaw(ACTOR_SIZE);
    heap.bytes.fill((a.fill ?? 0x77) & 0xff, actor, actor + ACTOR_SIZE);
    heap.write(actor + A.flags, 'u32', (a.flags ?? 0) >>> 0);
    heap.write(actor + A.word194, 'u32', (a.word194 ?? 0) >>> 0);
    heap.write(actor + A.style, 'u8', a.style ?? 1);
    heap.write(actor + A.drawScale, 'u32', bits(a.drawScale ?? {f: 1.0}));
    heap.write(actor + A.scaleGlow, 'u32', bits(a.scaleGlow ?? {f: 1.0}));
    heap.write(actor + A.lastRender, 'u32', bits(a.lastRenderTime ?? {f: 0.0}));
    const skins = a.multiSkins ?? Array(8).fill(0);
    for (let i = 0; i < 8; i++) heap.write(actor + A.multiSkins + 4 * i, 'u32', skins[i] ? texture(skins[i]) : 0);
    heap.write(actor + A.skin, 'u32', a.skin ? texture(a.skin) : 0);
    label(actor, 'actor');
  }
  return {heap, base, frame, actor, texture, names};
}

const actorState = (heap, actor) => {
  const skins = [];
  for (let i = 0; i < 8; i++) skins.push(heap.canon(heap.read(actor + A.multiSkins + 4 * i, 'u32')));
  skins.push(heap.canon(heap.read(actor + A.skin, 'u32')));
  return {hidden: (heap.read(actor + A.flags, 'u32') >>> 1) & 1, unlit: heap.read(actor + A.word194, 'u32') & 1,
    style: heap.read(actor + A.style, 'u8'), drawScale: heap.read(actor + A.drawScale, 'u32'),
    scaleGlow: heap.read(actor + A.scaleGlow, 'u32'), skins};
};
const frameState = (heap, frame) => ({x: heap.read(frame + FRAME.x, 'i32'), y: heap.read(frame + FRAME.y, 'i32'),
  xb: heap.read(frame + FRAME.xb, 'i32'), yb: heap.read(frame + FRAME.yb, 'i32')});

function makeRunner(mod) {
  return (name, caseSpec, native) => {
    const ctx = buildCase(caseSpec);
    const {heap, base, frame, actor} = ctx;
    const events = [];
    const services = {
      mem: heap, objectAddress: o => o.base,
      actor: {
        read: object => ({...actorState(heap, object.base), skins: [...Array(8).keys()].map(i => heap.read(object.base + A.multiSkins + 4 * i, 'u32'))
          .concat(heap.read(object.base + A.skin, 'u32'))}),
        write: (object, fields) => {
          const at = object.base;
          if ('hidden' in fields) heap.write(at + A.flags, 'u32', ((heap.read(at + A.flags, 'u32') & ~2) | ((fields.hidden & 1) << 1)) >>> 0);
          if ('unlit' in fields) heap.write(at + A.word194, 'u32', ((heap.read(at + A.word194, 'u32') & ~1) | (fields.unlit & 1)) >>> 0);
          if ('style' in fields) heap.write(at + A.style, 'u8', fields.style);
          if ('drawScale' in fields) heap.write(at + A.drawScale, 'u32', fields.drawScale);
          if ('scaleGlow' in fields) heap.write(at + A.scaleGlow, 'u32', fields.scaleGlow);
          if ('skins' in fields) {
            for (let i = 0; i < 8; i++) heap.write(at + A.multiSkins + 4 * i, 'u32', fields.skins[i]);
            heap.write(at + A.skin, 'u32', fields.skins[8]);
          }
        },
      },
      render: {
        clearZ: (renDev, f) => events.push({op: 'ClearZ', renDev: heap.canon(renDev), frame: heap.canon(f), frameState: frameState(heap, f)}),
        drawActor: (render, f, object) => events.push({op: 'DrawActor', render: heap.canon(render), frame: heap.canon(f),
          actor: heap.canon(object.base), actorState: actorState(heap, object.base), frameState: frameState(heap, f)}),
        computeRenderSize: f => events.push({op: 'ComputeRenderSize', frame: heap.canon(f), frameState: frameState(heap, f)}),
      },
    };
    const gc = {base};
    const args = caseSpec.args ?? {};
    if (native === 'clearZ') {
      mod.gcClearZ(gc, services);
    } else {
      const skin = 'skin' in args ? (args.skin ? ctx.texture(args.skin) : 0) : undefined;
      const values = [actor ? {base: actor} : null, args.bClearZ, args.bConstrain, args.bUnlit,
        'drawScale' in args ? bits(args.drawScale) : undefined, 'scaleGlow' in args ? bits(args.scaleGlow) : undefined, skin];
      if (caseSpec.mode === 'method') {
        const D = mod.DRAW_ACTOR_DEFAULTS;
        mod.gcDrawActor(gc, values[0], values[1] ?? D.bClearZ, values[2] ?? D.bConstrain, values[3] ?? D.bUnlit,
          values[4] ?? D.drawScale, values[5] ?? D.scaleGlow, values[6] ?? D.skin, services);
      } else {
        mod.execGcDrawActor(gc, values, services);
      }
    }
    const actorBytes = actor ? Buffer.from(heap.bytes.subarray(actor, actor + ACTOR_SIZE)) : Buffer.alloc(0);
    if (actor) for (const off of [A.skin, ...Array.from({length: 8}, (_, i) => A.multiSkins + 4 * i)]) actorBytes.fill(0, off, off + 4);
    const gcBytes = Buffer.from(heap.bytes.subarray(base + 0x28, base + 0x28 + 0x90));
    gcBytes.fill(0, 0, 4);
    return {events, state: {actor: actorBytes.toString('hex'), actorSkins: actor ? actorState(heap, actor).skins : [], gc: gcBytes.toString('hex'),
      frame: frame ? hex(heap, frame, FRAME.size) : ''}};
  };
}

function firstDiff(got, expected, where = '') {
  if (Object.is(got, expected)) return null;
  if (typeof got !== 'object' || typeof expected !== 'object' || !got || !expected) return {path: where || '$', got, expected};
  for (const key of new Set([...Object.keys(got), ...Object.keys(expected)])) {
    const d = firstDiff(got[key], expected[key], where ? `${where}.${key}` : key);
    if (d) return d;
  }
  return null;
}

async function loadExtension(root) {
  const bytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.u')));
  const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({path: `System/${name}`,
    read: () => name === 'Extension.u' ? bytes : readFile(path.join(root, 'System', name))})));
  return assets.get('Extension');
}

const mod0 = await import(url.pathToFileURL(MODULE).href);
const root = gameDirectory();
const extension = await loadExtension(root);
const dllBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));

// ---- metadata + body hashes ------------------------------------------------
for (const [meta, params] of [[mod0.GC_DRAW_ACTOR_NATIVE, ['Actor:object', 'bClearZ:bool', 'bConstrain:bool', 'bUnlit:bool', 'DrawScale:float', 'ScaleGlow:float', 'Skin:object']],
  [mod0.GC_CLEAR_Z_NATIVE, []]]) {
  const index = extension.exportsByPath.get(meta.function.toLowerCase());
  assert.equal(index, meta.packageExport, `${meta.function} export index`);
  const md = readFunctionMetadata(extension, index);
  assert.equal(md.nativeIndex, meta.nativeIndex);
  assert.equal(md.functionFlags, meta.functionFlags);
  assert.equal(md.entry.serialSize, meta.serialSize);
  assert.deepEqual(md.parameters.map(p => `${p.name}:${p.type?.name ?? p.type}`), params);
  assert.equal(createHash('sha256').update(dllBytes).digest('hex'), meta.dllSha256, 'Extension.dll hash');
  const bodyHash = (start, end) => createHash('sha256').update(dllBytes.subarray(start - meta.imageBase, end - meta.imageBase)).digest('hex');
  assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256, `${meta.function} exec body`);
  assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256, `${meta.function} method body`);
}

// ---- oracle ------------------------------------------------------------------
const oracle = JSON.parse(execFileSync(PYTHON, [path.join(ROOT, 'scripts', 'native-gc-draw-actor-oracle.py'), root],
  {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}));
assert.equal(oracle.hashes['Extension.dll'], mod0.GC_DRAW_ACTOR_NATIVE.dllSha256);
assert.equal(oracle.hashes['MSVCRT.dll'], mod0.GC_DRAW_ACTOR_NATIVE.msvcrtSha256);
assert.equal(oracle.extensionBase, mod0.GC_DRAW_ACTOR_NATIVE.oracleBase);
assert.equal(oracle.drawActorExec, mod0.GC_DRAW_ACTOR_NATIVE.execBody);
assert.equal(oracle.drawActorMethod, mod0.GC_DRAW_ACTOR_NATIVE.methodBody);
assert.equal(oracle.clearZExec, mod0.GC_CLEAR_Z_NATIVE.execBody);
assert.equal(oracle.clearZMethod, mod0.GC_CLEAR_Z_NATIVE.methodBody);

// ---- bit-exact replay ----------------------------------------------------------
const runAll = mod => {
  const run = makeRunner(mod), failures = [];
  for (const [name, caseSpec] of Object.entries(oracle.cases)) {
    const native = caseSpec.native ?? 'drawActor';
    const execEnd = caseSpec.events.find(e => e.op === 'ExecEnd');
    if (caseSpec.mode !== 'method') {
      if (!execEnd || execEnd.codeAdvance !== (native === 'clearZ' ? 1 : 8)) failures.push(`${name}: exec Code advance ${execEnd?.codeAdvance}`);
    } else if (execEnd) failures.push(`${name}: a method run reports an exec end`);
    const expected = {events: caseSpec.events.filter(e => e.op !== 'ExecEnd'), state: caseSpec.state};
    let got;
    try { got = run(name, caseSpec, native); } catch (error) { failures.push(`${name}: threw ${error.stack ?? error.message}`); continue; }
    const diff = firstDiff(got, expected);
    if (diff) failures.push(`${name}: ${diff.path} js=${JSON.stringify(diff.got)} oracle=${JSON.stringify(diff.expected)}`);
  }
  return failures;
};
for (const failure of runAll(mod0)) assert.fail(failure);
const report = {native: 'GC.DrawActor, GC.ClearZ', cases: Object.keys(oracle.cases).length, constrained: Object.values(oracle.cases)
  .filter(c => c.events.some(e => e.op === 'ComputeRenderSize')).length, drawn: Object.values(oracle.cases)
  .filter(c => c.events.some(e => e.op === 'DrawActor')).length, mutations: []};

// ---- adversarial mutation gate ----------------------------------------------------
const source = readFileSync(MODULE, 'utf8');
const MUTATIONS = [
  ['if (!(L.read(L.base + GC.flags, \'u32\') & GC_FLAGS.drawing)) return;', 'void 0;', 'no drawing gate'],
  ['if (!canvas || !actor) return;', 'if (!canvas) return;', 'no actor gate'],
  ['if (!(y0 >= top)) y0 = top;', 'if (y0 < top) y0 = top;', 'NaN top takes the frame top (fcomp unordered)'],
  ['if (left > x0) x0 = left;', 'if (left < x0) x0 = left;', 'left clip direction'],
  ['if (frameRight > clipRight) right = f32(clipRight);', 'if (frameRight < clipRight) right = f32(clipRight);', 'right clip direction'],
  ['if (frameBottom > clipBottom) bottom = clipBottom;', 'if (frameBottom < clipBottom) bottom = clipBottom;', 'bottom clip direction'],
  ['const t0 = f32(r24prod(hm, originX)), t1 = f32(r24prod(vm, originY));', 'const t0 = f32(originX), t1 = f32(originY);', 'origin skips the multipliers'],
  ['const dx = f32(r24sum(x0, -fXB))', 'const dx = f32(x0)', 'XB absolute instead of an offset'],
  ['export const ftolTruncate = v => Math.trunc(v) | 0;', 'export const ftolTruncate = v => Math.round(v) | 0;', '_ftol rounds instead of truncating'],
  ['unlit: bUnlit & 1', 'unlit: bUnlit ? 1 : 0', 'bUnlit uses bit 0 only'],
  ['style: L.read(L.base + GC.style, \'u8\')', 'style: saved.style', 'Style from the GC'],
  ['scaleGlow: scaleGlow >>> 0,', 'scaleGlow: saved.scaleGlow,', 'ScaleGlow argument'],
  ['drawScale: f32Bits(r24prod(bitsToF32(drawScale), bitsToF32(saved.drawScale)))', 'drawScale: drawScale', 'DrawScale multiplies the actor\'s'],
  ['if (skin) restore.skins = saved.skins;', '', 'skins restored'],
  ['hidden: saved.hidden,', 'hidden: 0,', 'bHidden restored'],
  ['if (bClearZ) {', 'if (!bClearZ) {', 'ClearZ gate'],
  ['    L.write(frame + D.frameXB, \'i32\', savedFrame.xb);', '', 'frame XB restored'],
  ['    service(services, \'render\', \'computeRenderSize\')(frame);\n  }\n}', '  }\n}', 'ComputeRenderSize after the restore'],
];
for (const [i, [find, replace, note]] of MUTATIONS.entries()) {
  const hits = source.split(find).length - 1;
  assert.equal(hits, 1, `mutation ${i} (${note}) find string occurs ${hits} times`);
  const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
  try {
    const text = source.replace(find, replace).replaceAll("from './", "from '../");
    writeFileSync(path.join(dir, 'script-gc-draw-actor.mjs'), text);
    const mutated = await import(url.pathToFileURL(path.join(dir, 'script-gc-draw-actor.mjs')).href);
    const failures = runAll(mutated);
    assert.ok(failures.length > 0, `mutation ${i} (${note}) produced identical behavior`);
    report.mutations.push({note, detail: failures[0].slice(0, 160)});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
console.log(JSON.stringify(report, null, 1));
