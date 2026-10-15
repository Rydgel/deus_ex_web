/** Stage 4: a pawn's third-person weapon attachment against unchanged Render.dll
 * and Core.dll code (docs/weapon-attachment.md). The oracle
 * (scripts/native-weapon-attach-oracle.py) runs DrawLodMesh's hand-coordinate
 * block (0x10b0f1c9..0x10b0f44f) and DrawActorSprite's weapon Coords block
 * (0x10b256e8..0x10b257a2), Core's SafeNormal, FCoords *= and FCoords /=
 * (FRotator) included, at the render pass's precision control; the
 * translation in src/runtime/weapon-attachment.mjs must agree on every word.
 * Cases: random vertices and coordinates, plus every case of
 * `--cases <file>` (the original's own: `.work/weapon/original-cases.json`, built by
 * scripts/weapon-original-cases.mjs from the running game's breakpoints). */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';
import {rotationSineTable} from '../src/runtime/coords.mjs';
import {handCoords, weaponCoords, specialOutcode} from '../src/runtime/weapon-attachment.mjs';

const root = gameDirectory();
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const view = new DataView(new ArrayBuffer(4));
const word = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const float = bits => { view.setUint32(0, bits >>> 0, true); return view.getFloat32(0, true); };
const sines = Array.from(rotationSineTable(), word);
let seed = 0x7ea90;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const between = (low, high) => Math.fround(low + (high - low) * random());

// Random hand cases: a special triangle a few units across, 50..400 in front of the camera.
const hand = [];
for (let i = 0; i < 200; i++) {
  const origin = [between(-200, 200), between(-150, 150), between(40, 500)];
  const vertices = [0, 1, 2].map(() => origin.map(v => Math.fround(v + between(-12, 12))));
  const prj = [between(0.8, 1.6), between(0.8, 1.6), between(0.8, 1.6), between(0.8, 1.6)];
  // a few cases push the triangle past a plane so the outcodes share a bit
  if (i % 17 === 0) vertices.forEach(v => { v[0] = Math.fround(-Math.abs(v[0]) * 40 - 500); });
  hand.push({vertices, prj, indices: [0, 1, 2]});
}
const options = process.argv.slice(2);
// --cases a.json,b.json: the original's own draws (scripts/weapon-original-cases.mjs), compared in situ as well
// without --cases, the captures `.work/weapon/original-cases*.json` when this checkout has them (local files, not versioned)
const casesFiles = options.includes('--cases') ? options[options.indexOf('--cases') + 1].split(',')
  : ['.work/weapon/original-cases.json', '.work/weapon/original-cases-2.json', '.work/weapon/original-cases-3.json'].filter(existsSync);
const original = {hand: [], weapon: []};
for (const file of casesFiles) {
  if (!existsSync(file)) { console.log(`no ${file}`); continue; }
  const loaded = JSON.parse(readFileSync(file, 'utf8'));
  original.hand.push(...loaded.hand); original.weapon.push(...loaded.weapon);
}

const handCases = [...hand, ...original.hand.map(c => ({vertices: c.vertices.map(w => w.map(float)), outcodes: c.outcodes,
  indices: c.indices ?? [0, 1, 2], expected: c.expected}))];
const weaponCases = [];
for (let i = 0; i < 100; i++) {
  const sample = handCoords([[between(-50, 50), between(-50, 50), between(50, 300)], [between(-50, 50), between(-50, 50), between(50, 300)],
    [between(-50, 50), between(-50, 50), between(50, 300)]]);
  weaponCases.push({hand: sample, location: [between(-4000, 4000), between(-4000, 4000), between(-1000, 1000)], mirror: i % 3 ? 1 : -1,
    drawScale: 1, thirdPersonScale: i % 5 ? 1 : 0.5});
}
for (const c of original.weapon) weaponCases.push({hand: c.hand.map(float), location: c.location.map(float), mirror: c.mirror ?? 1,
  drawScale: 1, thirdPersonScale: 1, expected: c.expected});

const oracleInput = {
  sines,
  hand: handCases.map(c => ({
    vertices: c.vertices.map((v, i) => ({words: v.map(word), outcode: c.outcodes?.[i] ?? specialOutcode(v, c.prj)})),
    indices: c.indices,
  })),
  weapon: weaponCases.map(c => ({hand: c.hand.map(word), location: c.location.map(word), rotation: [0x1234, 0x5678, 0x9abc],
    drawScale: word(c.drawScale), thirdPersonScale: word(c.thirdPersonScale), mirror: word(c.mirror)})),
};
const out = JSON.parse(execFileSync(python, ['scripts/native-weapon-attach-oracle.py', root], {input: JSON.stringify(oracleInput),
  encoding: 'utf8', maxBuffer: 1 << 30}));

let failures = 0;
const fail = (what, i, want, got) => { if (failures++ < 8) console.log(`FAIL ${what} case ${i}: original ${want} translation ${got}`); };
const hex = words => words.map(w => (w >>> 0).toString(16).padStart(8, '0')).join(' ');
let produced = 0, skipped = 0, inSitu = 0;
handCases.forEach((c, i) => {
  const outcodes = oracleInput.hand[i].vertices.map(v => v.outcode);
  const mine = handCoords(c.vertices, outcodes), theirs = out.hand[i];
  if (!mine) { skipped++; if (theirs.flag !== 0) fail('hand (skip)', i, 'drawn', 'skipped'); return; }
  produced++;
  const words = mine.map(word);
  if (theirs.flag !== 1) return fail('hand (flag)', i, 'skipped', 'drawn');
  if (words.some((w, k) => w !== theirs.coords[k])) fail('hand', i, hex(theirs.coords), hex(words));
  if (c.expected) { inSitu++; if (words.some((w, k) => w !== c.expected[k])) fail('hand (running original)', i, hex(c.expected), hex(words)); }
});
weaponCases.forEach((c, i) => {
  const mine = weaponCoords(c.hand, c.location).map(word), theirs = out.weapon[i];
  if (mine.some((w, k) => w !== theirs.coords[k])) fail('weapon coords', i, hex(theirs.coords), hex(mine));
  if (theirs.rotation.some(w => w !== 0)) fail('weapon rotation', i, 'zero', hex(theirs.rotation));
  if (theirs.mirror !== 0x3f800000) fail('frame mirror', i, '1.0', theirs.mirror.toString(16));
  if (theirs.savedMirror !== word(c.mirror)) fail('saved mirror', i, word(c.mirror).toString(16), theirs.savedMirror.toString(16));
  if (theirs.drawScale !== word(c.thirdPersonScale) || theirs.thirdPersonScale !== word(c.drawScale)) fail('scale swap', i, 'swapped', 'not');
  if (c.expected) { inSitu++; if (mine.some((w, k) => w !== c.expected[k])) fail('weapon coords (running original)', i, hex(c.expected), hex(mine)); }
});
console.log(`hand ${handCases.length} cases (${produced} drawn, ${skipped} skipped by outcode), weapon ${weaponCases.length} cases, ${inSitu} comparisons with the running original, ${failures} failures`);
process.exit(failures ? 1 : 0);
