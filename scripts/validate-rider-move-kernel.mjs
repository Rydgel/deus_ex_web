/** Focused original MoveActor reference and image/hand-back boundary checks.
 * SetActorZone is observed as an original virtual-call boundary here; its
 * point-query/body proof is separately established by validate-native-zone.
 * The same Rust point/region helpers are reused, not reimplemented. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {compileScriptVm} from '../src/runtime/script-vm-kernel.mjs';
import {MoveActorHost, MOVE_FIELDS} from '../src/runtime/move-actor-kernel.mjs';
import {playerMove} from '../src/runtime/player-move.mjs';
import {pointRegion, setActorZone} from '../src/runtime/zone.mjs';
import {writeZoneModel} from '../src/runtime/zone-kernel.mjs';
import {handleOf} from '../src/runtime/script-object-handles.mjs';
import {modelFromObjects} from '../src/unreal/bsp-model.mjs';
import {gameDirectory} from './game-directory.mjs';

const module = await compileScriptVm(), memory = new WebAssembly.Memory({initial: 64}), env = {memory};
for (const entry of WebAssembly.Module.imports(module))
  if (entry.kind === 'function') env[entry.name] = () => { throw Error(`Unexpected import ${entry.name}`); };
const x = (await WebAssembly.instantiate(module, {env})).exports;
const base = (x.__heap_base.value + 15) & ~15, modelAt = base + 256;
const view = new DataView(memory.buffer), bytes = new Uint8Array(memory.buffer);
const zone = {name: 'same zone'}, other = {name: 'other zone'};
const source = {levelInfo: zone, zoneActors: [zone, zone], model: modelFromObjects({nodes: [
  {plane: [1, 0, 0, 0], front: -1, back: -1, leaves: [17, 29], zones: [0, 1]},
], zones: []})};
// A deliberately different layout from the original: image offsets must
// come from the host's table. Bool fields share one word at offset 0.
const offsets = [0, 0, 0, 0, 0, 0, 0, 4, 8, 24, 36, 48, 52, 56, 68];
const fields = new Uint32Array(memory.buffer, x.move_rider_fields_ptr(), 33);
offsets.forEach((at, i) => { fields[2 * i] = at; fields[2 * i + 1] = i < 7 ? 1 << i : 0; });
fields.set([0, 4, 8], 30);
const vec = (at, a) => a.forEach((v, i) => view.setFloat32(base + at + 4 * i, v, true));
const rot = (at, a) => a.forEach((v, i) => view.setInt32(base + at + 4 * i, v, true));
function reset(c) {
  bytes.fill(0, base, base + 256);
  view.setUint32(base, 2, true);
  vec(24, c.position); rot(36, c.rotation ?? [0, 0, 0]);
  vec(48, c.extent ?? [17, 42]);
  view.setUint32(base + 56, handleOf(zone), true);
  view.setInt32(base + 60, -99, true);
  view.setUint8(base + 64, 3);
  // Bytes adjacent to the region byte and the move fields must survive.
  bytes.fill(0xa5, base + 72, base + 256);
  assert(writeZoneModel(view, modelAt, source));
}
function snapshot() {
  return {position: [0, 4, 8].map(i => view.getFloat32(base + 24 + i, true)),
    rotation: [0, 4, 8].map(i => view.getInt32(base + 36 + i, true)),
    region: {zone: view.getUint32(base + 56, true), leaf: view.getInt32(base + 60, true), zoneNumber: view.getUint8(base + 64)}};
}
const cases = [
  {position: [1, 2, 3], delta: [5, 6, 7]},
  {position: [-10, 2, 3], delta: [20, -6, 0]},
  ...[0, -0, 0.00009, -0.00009, Math.fround(0.0001), -Math.fround(0.0001),
    0.00010000000474974513, -0.00010000000474974513].map(v => ({position: [1, 2, 3], delta: [v, 0, 0]})),
  {position: [0, -0, 0], delta: [0, -0, 0]},
  {position: [1e8, -1e8, 17], delta: [1, -1, 0.3]},
  {position: [16777216, 16777216, -16777216], delta: [1, 3, -1]},
].map((c, i) => ({...c, rotation: [17, -24, 81], newRotation: i % 2 ? [-2147483648, 2147483647, 42] : [17, -24, 81]}));
const native = JSON.parse(execFileSync('.cache/native-probe-env/bin/python', ['scripts/native-rider-move-oracle.py', gameDirectory()],
  {input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 8 << 20}));
let tiny = 0;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]; reset(c);
  const actor = {scriptView: true, pawn: false, isPawn: false, movable: true, static: false,
    position: c.position.map(Math.fround), rotation: [...c.rotation], oldLocation: [11, 22, 33],
    radius: 17, height: 42, standingCount: 0, flags: 0, touching: [null, null, null, null],
    region: {zone, leaf: -99, zoneNumber: 3}};
  const trace = [], unexpected = () => { throw Error('Unexpected scene work'); };
  const result = playerMove(actor, c.delta, {multiLineCheck: unexpected, moveRiders: unexpected,
    checkEncroachment: () => { trace.push('encroachment'); return false; },
    setActorZone: (a, test, force) => { trace.push('zone'); assert.equal(test, false); assert.equal(force, false);
      setActorZone(a, {pointRegion: p => pointRegion(source.model, p, zone, source.zoneActors),
        actorLeaving: unexpected, zoneChange: unexpected, actorEntered: unexpected}); },
  }, c.newRotation);
  const code = x.move_rider(base, modelAt, ...c.delta, ...c.newRotation);
  assert(code, `case ${i} declined`);
  if (code === 1) tiny++;
  const actual = snapshot(), original = native.results[i];
  // JSON cannot preserve signed zero; native vectors are compared numerically.
  assert(actual.position.every((v, j) => v === original.position[j]), `native position ${i}`);
  assert.deepEqual(actual.rotation, original.rotation, `native rotation ${i}`);
  assert.deepEqual(original.oldLocation, [11, 22, 33]);
  assert.equal(original.success, true); assert.equal(original.time, 1); assert.equal(original.hit, 0);
  assert.equal(original.zones.length, code === 1 ? 0 : 1, `native zone call ${i}`);
  assert.equal(original.encroachments, original.zones.length);
  for (const call of original.zones) {
    assert.equal(call.test, 0); assert.equal(call.force, 0);
    assert.deepEqual(call.rotation, actual.rotation);
    assert(call.position.every((v, j) => v === actual.position[j]));
  }
  assert.deepEqual(actual.position, actor.position, `JS position ${i}`);
  assert.deepEqual(actual.rotation, actor.rotation);
  assert.deepEqual(actual.region, {...actor.region, zone: handleOf(actor.region.zone)});
  assert.deepEqual(result.position, actual.position);
  assert.equal(trace.length, code === 1 ? 0 : 2);
  assert(bytes.subarray(base + 72, base + 256).every(v => v === 0xa5));
}
const c = cases[0];
const guards = [
  ['static', () => view.setUint32(base, 3, true)],
  ['immovable', () => view.setUint32(base, 0, true)],
  ...[2, 3, 4, 5].map(bit => [`collision bit ${bit}`, () => view.setUint32(base, 2 | 1 << bit, true)]),
  ['riders', () => view.setUint8(base + 4, 1)],
  ['brush', () => view.setUint32(base + 68, handleOf(other), true)],
  ['touch', () => view.setUint32(base + 8, handleOf(other), true)],
  ['nonfinite position', () => view.setFloat32(base + 24, Infinity, true)],
  ['nonfinite radius', () => view.setFloat32(base + 48, NaN, true)],
  ['nonfinite height', () => view.setFloat32(base + 52, NaN, true)],
  ['changed zone', () => view.setUint32(base + 56, handleOf(other), true)],
  ['invalid BSP', () => view.setInt32(modelAt + 20 + 8 + 16, 99, true)],
];
for (const [name, change] of guards) {
  reset(c); change(); const before = bytes.slice(base, base + 256);
  assert.equal(x.move_rider(base, modelAt, ...c.delta, ...c.newRotation), 0, name);
  assert.deepEqual(bytes.slice(base, base + 256), before, `${name} stores before hand-back`);
}
reset(c); const before = bytes.slice(base, base + 256);
assert.equal(x.move_rider(base, modelAt, NaN, 0, 0, ...c.newRotation), 0);
assert.deepEqual(bytes.slice(base, base + 256), before);
reset(c); vec(24, [3e38, 2, 3]); const overflowBefore = bytes.slice(base, base + 256);
assert.equal(x.move_rider(base, modelAt, 3e38, 0, 0, ...c.newRotation), 0);
assert.deepEqual(bytes.slice(base, base + 256), overflowBefore, 'finite position overflow');
reset(c); view.setUint32(base, 2 | 64, true); view.setUint32(base + 56, handleOf(other), true);
assert.equal(x.move_rider(base, 0, ...c.delta, ...c.newRotation), 2, 'deleted actor skips zone');
assert.equal(snapshot().region.zone, handleOf(other));
// The host's class/binding admission: adding any observed binding must
// invalidate a cached eligible instance; replacing unrelated keys is safe.
const cls = {record: {key: 'deusex.weaponpistol'}}, cells = MOVE_FIELDS.map(([, key]) => ({key}));
const resolved = new Map(MOVE_FIELDS.map(([name, key]) => [name, {key}]));
const runtime = {lookupMember: (_cls, _kind, name) => resolved.get(name)};
const host = new MoveActorHost({runtime, zone: {enabled: false}});
assert.equal(host.rider(null, {}, null, null), undefined, 'ZONE_KERNEL=js bypass'); host.valid = true; host.cells = cells;
const instance = {cls, cells: new Map(cells.map(cell => [cell.key, cell])), fieldTable: new Map(), bindings: new Map()};
assert.equal(host.eligible(instance), true);
instance.bindings.set('core.object.name', {}); assert.equal(host.eligible(instance), true);
instance.bindings.set('core.object.name', {}); assert.equal(host.eligible(instance), true);
for (const [, key] of MOVE_FIELDS) {
  const bound = {...instance, bindings: new Map(instance.bindings)};
  assert.equal(host.eligible(bound), true);
  bound.bindings.set(key, {}); assert.equal(host.eligible(bound), false, key);
}
const shadow = {...instance, cls: {record: {key: 'example.shadow'}}};
runtime.lookupMember = (_cls, _kind, name) => name === 'Touching' ? {key: 'example.shadow.touching'} : resolved.get(name);
assert.equal(host.eligible(shadow), false);
console.log(`rider-move: ${cases.length} full original MoveActor references (${tiny} tiny), ${guards.length + 2} unchanged hand-backs, deleted-zone skip, and ${MOVE_FIELDS.length} binding guards passed`);
