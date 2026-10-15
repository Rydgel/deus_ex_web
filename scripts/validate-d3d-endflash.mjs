/** UD3DRenderDevice::EndFlash (D3DDrv.dll 0x10007c90, vtable +0xa4) against its translation (src/runtime/screen-flash.mjs).
 *
 * scripts/native-d3d-endflash-oracle.py runs the unchanged body under a stubbed COM device. Per case the gate (drawn or
 * not), the device calls in order (Lock flags, SetBlending, render states, texture stage states, DrawPrimitiveVB
 * arguments), the four vertices written (every one of the 36 bytes: position, depth, rhw, colour, and the untouched
 * remainder) and the vertex-buffer cursor must equal the translation's. Also pins the body's hash and checks that
 * viewportFlash (UGameEngine::Draw's derivation, read from disassembly only: not executed natively) maps the
 * script-side values the way docs/screen-flash.md says. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { endFlash, viewportFlash, SCREEN_FLASH } from '../src/runtime/screen-flash.mjs';
import { gameDirectory } from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const root = gameDirectory();
const oracle = JSON.parse(execFileSync(python, ['scripts/native-d3d-endflash-oracle.py', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
assert.equal(oracle.bodySha256, 'aa03e44b24f151a44791cc4ed67e3c94e44a465d6851db0840f8d5560e66e98d', 'D3DDrv EndFlash 0x10007c90..0x100080ab is the body this was recovered from');

const f32 = Math.fround;
let drawn = 0, skipped = 0, wrapped = 0;
for (const original of oracle.cases) {
  const scale = original.scale.map(f32), fog = original.fog.map(f32);
  const ours = endFlash({ scale, fog, sizeX: original.sizeX, sizeY: original.sizeY,
    device: { index: original.index, offset: original.offset, normalColorOp: original.normalColorOp, normalAlphaOp: original.normalAlphaOp, z33: original.z33, z43: original.z43 } });
  const label = JSON.stringify({ scale: original.scale, fog: original.fog });
  assert.equal(ours.drawn, original.drawn, `gate ${label}`);
  if (!original.drawn) {
    assert.deepEqual(original.calls, [], label);
    assert.equal(original.outIndex, original.index);
    assert.equal(original.outOffset, original.offset);
    skipped++;
    continue;
  }
  drawn++;
  if (ours.offset === 4 && original.offset + 4 > SCREEN_FLASH.bufferLimit) wrapped++;
  const normalized = original.calls.map(c => {
    if (c.method === 'Lock') return ['Lock', c.args[0]];
    if (c.method === 'Unlock') return ['Unlock'];
    if (c.method === 'DrawPrimitiveVB') return ['DrawPrimitiveVB', c.args[0], 'VB', c.args[2], c.args[3], c.args[4]];
    return [c.method, ...c.args];
  });
  assert.deepEqual(ours.calls, normalized, `calls ${label}`);
  assert.equal(ours.index, original.outIndex, `vertex start ${label}`);
  assert.equal(ours.offset, original.outOffset, `cursor ${label}`);
  const bytes = Buffer.alloc(4 * 36, 0x7e);
  ours.vertices.forEach((v, i) => {
    bytes.writeFloatLE(v.x, i * 36); bytes.writeFloatLE(v.y, i * 36 + 4); bytes.writeFloatLE(v.z, i * 36 + 8);
    bytes.writeFloatLE(v.rhw, i * 36 + 12); bytes.writeUInt32LE(v.color, i * 36 + 16);
  });
  assert.equal(bytes.toString('hex'), original.vertices, `vertices ${label}`);
}
assert.ok(drawn >= 40 && skipped >= 1 && wrapped >= 1, `cases: ${drawn} drawn, ${skipped} skipped, ${wrapped} wrapped`);

// UGameEngine::Draw's derivation (0x1038f36e..0x1038f54e), disassembly only.
assert.deepEqual(viewportFlash({ flashScale: [1, 1, 1], flashFog: [0, 0, 0] }), { scale: [0.5, 0.5, 0.5, 0], fog: [0, 0, 0, 0] }, 'script FlashScale 1 is the neutral plane 0.5');
assert.deepEqual(viewportFlash({ flashScale: [2.5, -1, NaN], flashFog: [1.5, -0.25, NaN] }), { scale: [1, 0, 0, 0], fog: [1, 0, 0, 0] }, 'six components clamped to [0, 1], NaN to 0');
assert.deepEqual(viewportFlash({ flashScale: [0.2, 0.2, 0.2], flashFog: [0.3, 0.1, 0] , screenFlashes: false}), { scale: [0.5, 0.5, 0.5, 0], fog: [0, 0, 0, 0] }, 'ScreenFlashes=False: the neutral flash');
console.log(`PASS validate-d3d-endflash: ${oracle.cases.length} cases equal to D3DDrv.dll 0x10007c90 (${drawn} drawn incl. ${wrapped} buffer discard, ${skipped} skipped by the gate): calls, vertices, cursor`);
