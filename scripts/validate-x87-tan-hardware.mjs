/**
 * Core appTan on the scene frame's FOV path (src/runtime/x87-tan.mjs) against
 * REAL x87 FPTAN (docs/x87-tan.md): builds tools/x87-tan-probe.c, runs it under
 * Wine/CrossOver, and checks for every row (FOV, the FLD/FMUL/FSTP argument,
 * the FPTAN qword) that the argument is the one the scene frame computes, that
 * a single candidate equals the hardware and two candidates include it, and
 * that the scene frame admits the FOV at 1440x960 and 1024x768.
 *
 * Skips loudly (exit 0) when the toolchain or Wine is absent.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { x87TanCandidates } from '../src/runtime/x87-tan.mjs';
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { x87load, x87mul, x87double, x87storeDouble } from '../src/runtime/script-vm.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wine = process.env.X87_PROBE_WINE || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const skip = reason => { console.log(`SKIP validate-x87-tan-hardware: ${reason}`); process.exit(0); };
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); } catch { skip(`no ${cc} on PATH`); }
const exe = path.join(root, '.cache', 'x87-tan-probe.exe');
mkdirSync(path.join(root, '.cache'), { recursive: true });
execFileSync(cc, ['-O1', '-o', exe, path.join(root, 'tools', 'x87-tan-probe.c')]);
const csv = execFileSync(wine, [exe], { env: { ...process.env, CX_BOTTLE: process.env.X87_PROBE_BOTTLE || 'DeusEx', WINEDEBUG: '-all' },
  maxBuffer: 1 << 27, encoding: 'utf8' });

const dv = new DataView(new ArrayBuffer(8));
const double = hex => { dv.setBigUint64(0, BigInt(`0x${hex}`), true); return dv.getFloat64(0, true); };
const hex = value => { dv.setFloat64(0, value, true); return dv.getBigUint64(0, true).toString(16).padStart(16, '0'); };
const float = hex => { dv.setUint32(0, parseInt(hex, 16), true); return dv.getFloat32(0, true); };
const HALF_DEGREE = x87double(0.008726646259971648);
const argumentOf = fov => { const r = x87storeDouble(x87mul(x87load(fov), HALF_DEGREE)); return (r.neg ? -1 : 1) * Number(r.sig) * 2 ** r.exp; };

let rows = 0, single = 0, pairs = 0, cw = null;
for (const line of csv.split(/\r?\n/)) {
  if (!line) continue;
  if (line.startsWith('#cw=')) { cw = line.slice(4); continue; }
  const [fovHex, xHex, tanHex] = line.split(','), fov = float(fovHex);
  assert.equal(hex(argumentOf(fov)), xHex, `FOV ${fovHex}: FMUL/FSTP argument`);
  const candidates = x87TanCandidates(double(xHex)).map(hex);
  if (candidates.length === 1) { assert.equal(candidates[0], tanHex, `FOV ${fovHex}: FPTAN`); single++; }
  else { assert.ok(candidates.includes(tanHex), `FOV ${fovHex}: FPTAN ${tanHex} is neither candidate ${candidates}`); pairs++; }
  for (const [width, height] of [[1440, 960], [1024, 768]]) buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width, height, fov });
  rows++;
}
assert.equal(cw, '037f', 'the probe runs with the default x87 control word');
assert.ok(rows > 200000, 'the probe covers the sampled FOVs');
console.log(`appTan: ${rows} real FPTAN results (cw ${cw}); ${single} single candidates equal, ${pairs} pairs include the hardware value; every FOV admitted at 1440x960 and 1024x768.`);
