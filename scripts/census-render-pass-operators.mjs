/** Which Core operator natives depend on the x87 precision control
 * (docs/render-pass-precision.md "UnrealScript in the render pass"): runs
 * each Core operator oracle twice, at the game thread's 0x037f and at the
 * render pass's 0x007f (ORACLE_CW), and counts, per native, the cases whose
 * outputs differ. Every case runs the unchanged Core.dll body under Unicorn.
 *
 *   node scripts/census-render-pass-operators.mjs */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
// VRand and RotRand take seed cases (as validate-native-vrand/-rotrand do).
const dir = path.resolve('reports/render-pass-operators');
mkdirSync(dir, { recursive: true });
let state = 0x6d2b79f5;
const seeds = [0, 1, 42, 32767, 65535, 2147483648, 4294967295, 1700000000,
  ...Array.from({ length: 56 }, () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0))];
writeFileSync(path.join(dir, 'vrand.json'), JSON.stringify(seeds.map(seed => ({ seed }))));
writeFileSync(path.join(dir, 'rotrand.json'), JSON.stringify(seeds.flatMap(seed => [[], [0x27]].map(tokens => ({ seed, tokens })))));
const extra = { vrand: [path.join(dir, 'vrand.json')], rotrand: [path.join(dir, 'rotrand.json')] };
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLES = ['float-vector-operators', 'normal-axes', 'rotator-modulo', 'string-transcendental', 'vrand', 'rotrand',
  'float-approx', 'core-damage-primitives'];
const run = (name, cw) => {
  const env = { ...process.env };
  if (cw) env.ORACLE_CW = cw; else delete env.ORACLE_CW;
  return JSON.parse(execFileSync(python, [`scripts/native-${name}-oracle.py`, root, ...(extra[name] ?? [])], { encoding: 'utf8', maxBuffer: 1 << 28, env }));
};
// The rows that carry a case's outputs, whatever the oracle calls them.
const rowsOf = output => output.cases ?? output.calls ?? output.samples ?? output.results ?? [];
const nativeOf = (row, name) => row.native ?? row.index ?? row.name?.split('-')[0] ?? name;
const table = {};
for (const name of ORACLES) {
  const game = run(name, null), pass = run(name, '0x007f');
  const a = rowsOf(game), b = rowsOf(pass);
  if (a.length !== b.length) throw new Error(`${name}: ${a.length} cases at 0x037f, ${b.length} at 0x007f`);
  if (!a.length) {
    // A single-result oracle: compare the whole output.
    const same = JSON.stringify(game) === JSON.stringify(pass);
    table[name] = { cases: 1, differ: same ? 0 : 1 };
    continue;
  }
  a.forEach((row, i) => {
    const key = `${name}:${nativeOf(row, name)}`, entry = table[key] ??= { cases: 0, differ: 0, examples: [] };
    entry.cases++;
    if (JSON.stringify(row) !== JSON.stringify(b[i])) { entry.differ++; if (entry.examples.length < 3) entry.examples.push(row.name ?? i); }
  });
}
for (const [key, { cases, differ, examples }] of Object.entries(table))
  console.log(`${key.padEnd(56)} ${String(differ).padStart(4)} of ${String(cases).padStart(4)} differ${differ ? `  (${examples.join(', ')})` : ''}`);
