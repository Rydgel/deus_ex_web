/** ScaleWindow value bodies and ScaleManagerWindow child setters against the
 * unchanged Extension.dll (scripts/native-window-scale-settings-oracle.py):
 * complete receiver/child images, ordered script and reconfigure events.
 * Each listed mutation of the translation must diverge from some case.
 * See docs/script-window-scale-settings.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, rmSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';
import * as SS from '../src/runtime/script-window-scale-settings.mjs';
import * as M from '../src/runtime/script-window-scroll-movement.mjs';
import * as C from '../src/runtime/script-window-scroll-configuration.mjs';
import * as Children from '../src/runtime/script-window-scroll-children.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const revive = v => v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity
  : Array.isArray(v) ? v.map(revive) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) : v;
const cases = revive(JSON.parse(execFileSync(python, ['scripts/native-window-scale-settings-oracle.py', gameDirectory()],
  {encoding: 'utf8', maxBuffer: 1 << 26})));

function replay(c, S) {
  const mem = new Map(c.images.map(i => [i.address, Buffer.from(i.before, 'hex')]));
  const nodes = new Map(c.images.map(i => [i.address, i.node])), events = [];
  const W = {
    u8: (o, k) => mem.get(o).readUInt8(k), u32: (o, k) => mem.get(o).readUInt32LE(k), i32: (o, k) => mem.get(o).readInt32LE(k),
    f32: (o, k) => mem.get(o).readFloatLE(k), ptr: (o, k) => mem.get(o).readUInt32LE(k) || null,
    setU8: (o, k, v) => mem.get(o).writeUInt8(v & 255, k), setI32: (o, k, v) => mem.get(o).writeInt32LE(v | 0, k),
    setU32: (o, k, v) => mem.get(o).writeUInt32LE(v >>> 0, k), setF32: (o, k, v) => mem.get(o).writeFloatLE(v, k),
    setPtr: (o, k, v) => mem.get(o).writeUInt32LE(v ?? 0, k),
    boundary: message => { throw new Error(`boundary: ${message}`); },
    native: {}, v: {},
  };
  W.processScript = (object, op, args) => { events.push({op, object, args: args.map(a => a ?? 0)}); return Boolean(nodes.get(object).handled); };
  const kind = o => nodes.get(o).kind;
  W.v.scaleRangeChanged = (o, ...args) => W.processScript(o, 'ScaleRangeChanged', args);
  W.v.scalePositionChanged = (o, ...args) => kind(o) === 'manager' ? M.managerScalePosition(W, o, ...args) : W.processScript(o, 'ScalePositionChanged', args);
  W.v.scaleAttributesChanged = (o, ...args) => kind(o) === 'manager' ? C.managerScaleAttributes(W, o, ...args) : W.processScript(o, 'ScaleAttributesChanged', args);
  W.native.changeScalePosition = (o, n) => M.changeScalePosition(W, o, n);
  W.native.askParentForReconfigure = o => events.push({op: 'reconfigure', object: o, args: []});
  W.native.getScaleValueString = () => { throw new Error('boundary: GetValueString'); };
  const [a, b] = c.args, root = c.root, obj = v => v || null;
  switch (c.mode) {
    case 'valueRange': S.scaleValueRange(W, root, a, b); break;
    case 'value': S.scaleValue(W, root, a); break;
    case 'getValues': {
      const {from, to} = S.scaleGetValues(W, root);
      if (a) W.setF32(a, 0, from);
      if (b) W.setF32(b, 0, to);
      break;
    }
    case 'valueField': S.managerValueField(W, root, obj(a)); break;
    case 'managerScale': Children.managerSetScale(W, root, obj(a)); break;
    case 'managerButtons': Children.managerSetButtons(W, root, obj(a), obj(b)); break;
    default: throw new Error(`unknown mode ${c.mode}`);
  }
  return {events, images: c.images.map(i => mem.get(i.address).toString('hex'))};
}

const expected = c => ({events: c.events, images: c.images.map(i => i.after)});
for (const c of cases) {
  const got = replay(c, SS);
  assert.deepEqual(got.events, c.events, `${c.name}: events`);
  for (const [i, image] of c.images.entries())
    assert.equal(got.images[i], image.after, `${c.name}: image of ${Object.entries(c.addresses).find(([, v]) => v === image.address)?.[0]}`);
}

const MUTATIONS = [
  ["const sameC3 = (a, b) => { const c = x87cmp(X(a), X(b)); return c === 'eq' || c === 'un'; };",
    "const sameC3 = (a, b) => { const c = x87cmp(X(a), X(b)); return c === 'eq'; };", 'NaN compares unequal'],
  ["if (sameC3(W.f32(win, 0x1d4), from) && sameC3(W.f32(win, 0x1d8), to)) return;",
    "if (sameC3(W.f32(win, 0x1d4), from)) return;", 'SetValueRange checks only the low value'],
  ["const n = I((W.i32(win, 0x1c4) - ((W.u8(win, 0x164) & 16) ? 0 : 1)) | 0);", "const n = I(W.i32(win, 0x1c4) - 1);", 'ValueToTick ignores range mode'],
  ["return T(belowZeroC0(t) ? sub(t, X(0.5)) : A(t, X(0.5)));", "return T(t);", 'ValueToTick truncates'],
  ["D(M(n, sub(X(value), X(from))), sub(X(to), X(from)))", "D(M(n, sub(X(value), X(from))), X(to))", 'ValueToTick divides by the high value'],
  [": W.f32(win, 0x1d4);\n  return {from, to};", ": W.f32(win, 0x1d8);\n  return {from, to};", 'GetValues to = the high value'],
  ["  if (W.ptr(win, 0x154) === field) return;\n", "", 'SetValueField reconfigures when unchanged'],
  ["  if (!isDescendant(W, win, field)) field = null;\n", "", 'SetValueField takes a non-descendant'],
];
const moduleFile = new URL('../src/runtime/script-window-scale-settings.mjs', import.meta.url);
const source = readFileSync(moduleFile, 'utf8');
const caught = [], missed = [];
for (const [i, [find, replace, note]] of MUTATIONS.entries()) {
  if (source.split(find).length !== 2) throw new Error(`mutation ${i} (${note}): find string does not occur once`);
  const file = new URL(`../src/runtime/.mut-scale-settings-${process.pid}-${i}.mjs`, import.meta.url);
  writeFileSync(file, source.replace(find, replace));
  try {
    const Mut = await import(file.href);
    let detail = null;
    for (const c of cases) {
      let got;
      try { got = replay(c, Mut); } catch { detail = `${c.name}: threw`; break; }
      try { assert.deepEqual(got, expected(c)); } catch { detail = c.name; break; }
    }
    (detail ? caught : missed).push(`${note}${detail ? ` -> ${detail}` : ''}`);
  } finally { rmSync(file, {force: true}); }
}
if (missed.length) { console.error(`undetected mutations: ${missed.join('; ')}`); process.exit(1); }
if (process.env.SCALE_VERBOSE) console.log(caught.join('\n'));
console.log(JSON.stringify({cases: cases.length, mismatches: 0, mutations: `${caught.length}/${MUTATIONS.length} detected`}));
