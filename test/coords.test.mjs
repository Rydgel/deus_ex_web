import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brushToWorld, rotationSineTable } from '../src/runtime/coords.mjs';

const origin = { Location: [1317.25, -319.75, -77.125], PrePivot: [101, 7.5, -31] };
// Original captures: native-coords cases 27, 28 and 52. The table hash comes
// from all 16,384 original Core FGlobalMath float32 entries in little-endian order,
// entry 8192 the real x87 FSIN's word 0x250d3000 (tools/x87-sintable-probe.c under
// CrossOver; docs/fitting.md), which the host sine (0x250d3132) is not.
test('rotation sine table reproduces every original float32 entry', () => {
  const table = rotationSineTable(), bytes = Buffer.alloc(table.length * 4);
  table.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  assert.equal(bytes.readUInt32LE(8192 * 4), 0x250d3000);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'b8d756044134efb1bbedbe2b842138d6b8d8dc970ef1a69edd0d03cb07ece10c');
});

test('original brush rotations discard two low bits before sine lookup', () => {
  assert.deepEqual(brushToWorld({ ...origin, Rotation: [0, 3, 0] }),
    [-1216.25, 327.25, 46.125, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(brushToWorld({ ...origin, Rotation: [0, 4, 0] }),
    [-1216.1273193359375, 327.755126953125, 46.125,
      0.9999999403953552, -0.0003834951785393059, 0,
      0.0003834951785393059, 0.9999999403953552, 0, 0, 0, 1]);
});

test('original brush composition preserves shear, negative scale and intermediate stores', () => {
  assert.deepEqual(brushToWorld({ ...origin, Rotation: [12345, -7987, 19999],
    MainScale: { scale: [2, .5, -3], shearAxis: 1, shearRate: -1 } }),
  [262.20831298828125, -1623.918212890625, 308.9936218261719,
    -0.12276703119277954, 0.19626034796237946, -2.635568618774414,
    0.9185657501220703, -0.42417359352111816, -1.3805261850357056,
    2.455842971801758, -0.17764748632907867, 0.38461047410964966]);
});
