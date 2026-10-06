// Light coronas (docs/coronas.md): src/runtime/coronas.mjs against unchanged
// Render.dll code (native-coronas-oracle.py) — the visibility helper
// 0x10b1bc00 (line-check answers, bCorona/Skin/bDeleteMe gates, existing and
// new cache slots) and the draw loop's DrawIcon arguments (validity, depth
// cut, projection, size, hue/saturation colour times brightness) over random
// frames, lights and caches. Compared bit-exactly.
import { auditAssert } from './precision-audit.mjs';
import { execFileSync } from 'node:child_process';
import { gameDirectory } from './game-directory.mjs';
import { getAxes } from '../src/runtime/camera.mjs';
import { coordsTransformExtended as coordsTransform } from '../src/runtime/volumetric-fog.mjs';
import { coronaSeen, coronaFade, coronaIcon, CORONA_SLOTS } from '../src/runtime/coronas.mjs';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs).
const assert = auditAssert();

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const f = Math.fround, io = new DataView(new ArrayBuffer(4));
const bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));
const num = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
let seed = 0xc0405a5;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const between = (a, b) => f(a + (b - a) * random());
const int = n => Math.floor(random() * n);

const cases = [];
for (let c = 0; c < 200; c++) {
  const eye = [between(-4000, 4000), between(-4000, 4000), between(-800, 800)];
  const [x, y, z] = getAxes([int(65536) - 32768, int(65536), c % 7 === 0 ? int(65536) : 0]);
  const coords = { origin: eye, x: y, y: z.map(v => -v), z: x };
  const lights = Array.from({ length: 1 + int(4) }, () => ({
    location: [0, 1, 2].map(i => f(eye[i] + between(-1500, 1500))), hue: int(256), saturation: int(256),
    drawScale: between(0.05, 3), flags: random() < 0.1 ? 0x80 : 0, lighting: random() < 0.15 ? 0 : 4, skin: random() > 0.08 }));
  const entries = Array.from({ length: CORONA_SLOTS }, () => null);
  for (let k = 0; k < lights.length; k++) if (random() < 0.4) {
    const slot = int(CORONA_SLOTS);
    entries[slot] = { light: k, index: random() < 0.1 ? 0 : k + 1, brightness: bits(between(0, 1)) };
  }
  if (c % 13 === 5) for (let i = 0; i < CORONA_SLOTS; i++) entries[i] ??= { light: 0, index: 1, brightness: bits(0.5) };
  const delta = c % 17 === 3 ? 0.6 : between(0, 0.2);
  const seen = Array.from({ length: int(5) }, () => {
    const first = random() < 0.75 ? 1 : 0, answers = [[first, 0]];
    if (first) answers.push(random() < 0.6 ? [1, 0] : [0, random() < 0.5 ? 'viewer' : 'other']);
    return { light: int(lights.length), answers };
  });
  cases.push({ coords: [...eye, ...coords.x, ...coords.y, ...coords.z].map(bits), coordsJs: coords, width: 320 + int(1600),
    fx2fy2: [between(100, 900), between(100, 600)].map(bits), projZ: bits(between(100, 1500)), delta: bits(delta),
    lights: lights.map(l => ({ ...l, location: l.location.map(bits), drawScale: bits(l.drawScale) })), lightsJs: lights, entries, seen });
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-coronas-oracle.py', gameDirectory()],
  { input: JSON.stringify(cases.map(({ coordsJs, lightsJs, ...c }) => c)), encoding: 'utf8', maxBuffer: 1 << 28 }));

let icons = 0, seenCount = 0, created = 0, behind = 0;
cases.forEach((c, i) => {
  const expected = reference[i], where = `case ${i}`;
  const cache = { entries: c.entries.map(e => e ? { actor: e.light, index: e.index, brightness: num(e.brightness) }
    : { actor: null, index: 0, brightness: 0 }), last: 0 };
  const slot = { next: 0 }, delta = num(c.delta);
  coronaFade(cache, delta);
  cache.entries.forEach((e, k) => {
    const [light, , b] = expected.faded[k];
    assert.equal(e.actor === null ? -1 : e.actor, light, `${where} slot ${k}: faded light`);
    if (light >= 0) assert.equal(bits(e.brightness), b, `${where} slot ${k}: faded brightness`);
  });
  for (const s of c.seen) {
    const light = c.lightsJs[s.light];
    const visible = s.answers[0][0] === 1 && (s.answers[1][0] === 1 || s.answers[1][1] === 'viewer');
    const qualifies = Boolean(light.lighting & 4) && light.skin && !(light.flags & 0x80);
    const before = cache.entries.filter(e => e.actor !== null).length;
    coronaSeen(cache, slot, s.light, { visible, qualifies, actorIndex: () => s.light + 1, delta });
    if (cache.entries.filter(e => e.actor !== null).length > before) created++;
    seenCount++;
  }
  assert.equal(slot.next, expected.next, `${where}: next free slot`);
  cache.entries.forEach((e, k) => {
    const [light, index, b] = expected.cache[k];
    assert.equal(e.actor === null ? -1 : e.actor, light, `${where} slot ${k}: light`);
    if (light >= 0) {
      assert.equal(e.index, index, `${where} slot ${k}: actor index`);
      assert.equal(bits(e.brightness), b, `${where} slot ${k}: brightness`);
    }
  });
  const drawn = [];
  for (const e of cache.entries) {
    if (e.actor === null) continue;
    if (e.index !== e.actor + 1) continue;   // Level.Actors[index] is not this light
    const light = c.lightsJs[e.actor];
    const camera = coordsTransform(light.location, c.coordsJs);
    const icon = coronaIcon(e, camera, { projZ: num(c.projZ), fx2: num(c.fx2fy2[0]), fy2: num(c.fx2fy2[1]), width: c.width },
      { hue: light.hue, saturation: light.saturation, drawScale: light.drawScale });
    if (!icon) { behind++; continue; }
    // The loop draws the entry's current Skin, null for a prefilled skinless light.
    drawn.push({ texture: light.skin ? e.actor : -0x7000, x: bits(icon.x), y: bits(icon.y), xl: bits(icon.size), yl: bits(icon.size), span: 0,
      z: bits(1), color: [...icon.color.map(bits), 0], fog: [0, 0, 0, 0], flags: icon.polyFlags });
  }
  assert.deepEqual(drawn, expected.icons.map(({ canvas, ...icon }) => icon), `${where}: DrawIcon calls`);
  icons += drawn.length;
});
assert.ok(icons > 100 && created > 50 && behind > 20, 'cases reach drawn icons, new entries and lights behind the eye');
console.log(`Coronas: ${cases.length} frames (fade loop included), ${seenCount} helper calls (${created} new entries), ${icons} DrawIcon calls and ${behind} lights behind the eye match the original Render.dll.`);
if (assert.enabled) assert.report('validate-coronas');
