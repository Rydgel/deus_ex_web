import test from 'node:test';
import assert from 'node:assert/strict';
import { depthConstants, floatWord } from '../src/runtime/frame-projection.mjs';
import { canvasTile, spriteIcon, spriteVertices, stageScale } from '../src/runtime/sprite-tile.mjs';

// Two sprites whose numbers the unchanged original produced under Unicorn
// (scripts/validate-sprite-tiles.mjs, 00_Training, a 1280 x 720 frame): the
// pins keep the reference honest without the oracle. The first lies inside the
// frame (a 16 x 16 texture with Scale 2, DrawScale 3.5), the second covers it
// (a 256 x 128 texture with Scale 0.5, DrawScale 0.25, 3 units from the camera).
const word = value => floatWord(value) >>> 0;
const depth = { zBias: Math.fround(depthConstants(32).zBias), zScale: Math.fround(depthConstants(32).zScale) };
const frame = { fx: 1280, fy: 720, xb: 0, yb: 0 };

test('a sprite inside the frame', () => {
  const sprite = { z: 226.52801513671875, screenX: 1113.239501953125, screenY: 205.78736877441406, persp: 2.8252575397491455, drawScale: 3.5 };
  const texture = { usize: 16, vsize: 16, infoUSize: 16, infoVSize: 16, uScale: 2, vScale: 2 };
  const icon = spriteIcon(sprite, texture);
  assert.deepEqual([icon.x, icon.y, icon.xl, icon.yl], [1034.13232421875, 126.68016052246094, 158.21441650390625, 158.21441650390625]);
  const result = spriteVertices(sprite, texture, frame, depth);
  assert.deepEqual(result.tile, { x: icon.x, y: icon.y, xl: icon.xl, yl: icon.yl, u: 0, v: 0, ul: 32, vl: 32 });
  const corner = (x, y, u, v) => ({ x, y, z: 0.9956158995628357, rhw: 0.004414464812725782, u, v });
  assert.deepEqual(result.vertices, [corner(1033.63232421875, 126.18016052246094, 0, 0), corner(1033.63232421875, 284.39459228515625, 0, 1),
    corner(1191.8466796875, 284.39459228515625, 1, 1), corner(1191.8466796875, 126.18016052246094, 1, 0)]);
  assert.deepEqual(stageScale(texture), { uMult: 0.03125, vMult: 0.03125, uSlot: 0, vSlot: 1 });
});

test('a sprite larger than the frame is clipped and its source rectangle moves with it', () => {
  const sprite = { z: 3, screenX: -62.8775634765625, screenY: 320.1546325683594, persp: 213.3333282470703, drawScale: 0.25 };
  const texture = { usize: 256, vsize: 128, infoUSize: 256, infoVSize: 128, uScale: 0.5, vScale: 0.5 };
  const icon = spriteIcon(sprite, texture);
  assert.deepEqual([icon.x, icon.y, icon.xl, icon.yl], [-6889.5439453125, -3093.1787109375, 13653.3330078125, 6826.66650390625]);
  const tile = canvasTile(icon, frame, texture);
  assert.deepEqual([tile.x, tile.y, tile.xl, tile.yl], [0, 0, 1280, 720]);
  assert.deepEqual([tile.u, tile.v, tile.ul, tile.vl].map(word), [64.5894775390625, 28.998550415039062, 12, 6.750001907348633].map(word));
  const [v0, v1, v2, v3] = spriteVertices(sprite, texture, frame, depth).vertices;
  assert.deepEqual([v0.x, v0.y, v2.x, v2.y], [-0.5, -0.5, 1279.5, 719.5]);
  assert.deepEqual([v0.z, v0.rhw], [0.66668701171875, 0.3333333432674408]);
  assert.deepEqual([v0.u, v0.v, v2.u, v2.v], [0.5046052932739258, 0.45310235023498535, 0.5983552932739258, 0.5585711002349854]);
  assert.deepEqual([v1.x, v1.y, v3.x, v3.y], [v0.x, v2.y, v2.x, v0.y]);
});

test('DrawTile draws nothing for an empty, behind or outside rectangle', () => {
  const texture = { usize: 8, vsize: 8, infoUSize: 8, infoVSize: 8, uScale: 1, vScale: 1 };
  assert.equal(canvasTile({ x: 10, y: 10, xl: 0, yl: 5 }, frame, texture), null);
  assert.equal(canvasTile({ x: -20, y: 10, xl: 20, yl: 5 }, frame, texture), null);
  assert.equal(canvasTile({ x: 1280, y: 10, xl: 5, yl: 5 }, frame, texture), null);
  assert.equal(canvasTile({ x: 10, y: 720, xl: 5, yl: 5 }, frame, texture), null);
});

test('a taller than wide texture swaps the stage slots, the logical coordinates stay', () => {
  const stage = stageScale({ infoUSize: 32, infoVSize: 64, uScale: 1, vScale: 1 });
  assert.deepEqual([stage.uSlot, stage.vSlot, stage.uMult, stage.vMult], [1, 0, 0.03125, 0.015625]);
});
