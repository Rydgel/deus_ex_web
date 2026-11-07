/** The ABI the non-Pawn physics host shares with fall.rs (falling, projectile and rolling): the field table's rows (FF_*), the counters
 * (C_*), the import names of the extern block, and the bare-return test the surface prelude relies on (script-empty-body.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FALL_FIELDS, RUST_COUNTS, ActorPhysicsHost} from '../src/runtime/actor-physics-kernel.mjs';
import {bareReturn} from '../src/runtime/script-empty-body.mjs';

const source = readFileSync(new URL('../native/script-vm/src/fall.rs', import.meta.url), 'utf8');
const consts = prefix => Object.fromEntries([...source.matchAll(new RegExp(`const (${prefix}_[A-Z_0-9]+): usize = (\\d+);`, 'g'))].map(m => [m[1], Number(m[2])]));

test('fall field table rows match fall.rs', () => {
  const ff = consts('FF');
  const named = {Velocity: 'FF_VELOCITY', Acceleration: 'FF_ACCELERATION', OldLocation: 'FF_OLD_LOCATION', Physics: 'FF_PHYSICS',
    bJustTeleported: 'FF_JUST_TELEPORTED', bBounce: 'FF_BOUNCE', Mass: 'FF_MASS', Buoyancy: 'FF_BUOYANCY', RotationRate: 'FF_ROTATION_RATE',
    PendingTouch: 'FF_PENDING_TOUCH', ZoneGravity: 'FF_ZONE_GRAVITY', ZoneVelocity: 'FF_ZONE_VELOCITY', ZoneTerminalVelocity: 'FF_ZONE_TERMINAL_VELOCITY',
    ZoneFluidFriction: 'FF_ZONE_FLUID_FRICTION', bWaterZone: 'FF_WATER_ZONE', bBobbing: 'FF_BOBBING', Region: 'FF_REGION_ZONE', MaxSpeed: 'FF_MAX_SPEED',
    Base: 'FF_BASE'};
  FALL_FIELDS.forEach(([name], i) => assert.equal(ff[named[name]], i, `${name} is row ${i}`));
  // (the table's last row after the host's own: Region.ZoneNumber, which only the host reads)
  assert.equal(ff.FF_COUNT, FALL_FIELDS.length + 1);
  assert.equal(new Set(FALL_FIELDS.map(([, key]) => key)).size, FALL_FIELDS.length, 'distinct keys');
});

test('fall counters match fall.rs', () => {
  const counters = Object.values(consts('C')).sort((a, b) => a - b);
  assert.deepEqual(counters, counters.map((_, i) => i));
  assert.equal(counters.length, RUST_COUNTS.length);
  assert.ok(Number(source.match(/static mut FALL_COUNTS: \[u32; (\d+)\]/)[1]) >= counters.length);
});

test('fall imports match the extern block', () => {
  const externs = [...source.matchAll(/^\s*fn (js_\w+)\(/gm)].map(m => m[1]).sort();
  assert.deepEqual(Object.keys(new ActorPhysicsHost({runtime: null, arena: null}).imports()).sort(), externs);
});

test('a function body that is a bare return', () => {
  const fn = (bytes, over = {}) => ({result: null, script: {bytes: Uint8Array.from(bytes), nativeIndex: 0, functionFlags: 0x800, ...over}});
  assert.equal(bareReturn(fn([0x04, 0x0b])), true, 'Pawn.WalkTexture: return _');
  assert.equal(bareReturn(fn([0x04, 0x0b, 0x53])), true, 'with the end of the script');
  assert.equal(bareReturn(fn([0x04, 0x0b, 0x16])), false);
  assert.equal(bareReturn(fn([0x04, 0x1d, 0, 0, 0, 0])), false, 'a returned value');
  assert.equal(bareReturn(fn([0x0b])), false);
  assert.equal(bareReturn(fn([0x04, 0x0b], {functionFlags: 0x400})), false, 'native');
  assert.equal(bareReturn(fn([0x04, 0x0b], {functionFlags: 0x20})), false, 'singular');
  assert.equal(bareReturn(fn([0x04, 0x0b], {nativeIndex: 5})), false, 'numbered native');
  assert.equal(bareReturn({...fn([0x04, 0x0b]), result: {}}), false, 'a result');
});
