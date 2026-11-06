#!/usr/bin/env node
/** UGC::DrawText in Rust (native/script-vm/src/text.rs) against its JavaScript reference (script-gc-draw-text.mjs), on random inputs
 * through the live window host's heap and fonts.
 *
 *   node scripts/validate-gc-draw-text-rust.mjs [--map 00_Training] [--cases 3000] [--seed 1]
 *
 * Boots a map as the HUD digest does and, inside the first window draw of each HUD paint (so the GC has the paint's canvas and
 * multipliers, and the window's own PopGC undoes what a case sets), runs random DrawText calls with GC_NATIVE=verify: each call runs
 * the Rust body, then the JavaScript body from the heap before it, and throws on any difference in the GC image, the GC stack's
 * nodes, the realize cache or the DrawTile commands (script-vm-gc.mjs verifyText). The cases vary the alignments (horizontal and
 * vertical), word wrap, the special-text escapes (`|b`, `|c`, `|p`, `|!`, `|&` in good and truncated forms), both fonts of the
 * host's font images (or none), the clip and the origin, the multipliers, the underline texture, newlines and long words.
 *
 * It tests the translation against the reference (which the native oracle validator, validate-gc-draw-text.mjs, ties to the DLL);
 * it makes no claim about the original beyond that. Host measurement and equivalence only.
 */
process.env.GC_NATIVE = 'verify';
import {readFile, readdir} from 'node:fs/promises';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const map = flag('map', '00_Training'), cases = Number(flag('cases', 3000)), seed = Number(flag('seed', 1));

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {createSimSession} = await import('../src/viewer/sim-session.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {gcDrawText} = await import('../src/runtime/script-gc-draw-text.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const session = createSimSession(game, {assets});

// A small seeded generator (mulberry32): the same cases on every run.
let state = seed >>> 0;
const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = list => list[Math.floor(random() * list.length)];
const between = (low, high) => low + random() * (high - low);
const f32 = Math.fround, bitsOf = v => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, v, true); return view.getUint32(0, true); };

const host = game.hud.host, heap = host.heap, W = host.W, services = W.gc.services;
const WORDS = ['HUD', 'a', 'Credits:', 'Dr. Paul Denton', 'supercalifragilisticexpialidocious_and_more_letters', 'ammo', '1234567890', 'the quick brown fox',
  'iii', 'WWW', ' ', '', 'x'];
const ESCAPES = ['|b', '|!b', '|cff0000', '|c00ff00', '|cFFaa00', '|c12', '|c', '|!c', '|p1', '|p7', '|p9', '|!p', '|p', '|&', '|', '|!', '|z', '|c1', '|b|!b'];
const randomText = () => {
  const parts = [], n = 1 + Math.floor(random() * 9);
  for (let i = 0; i < n; i++) {
    const r = random();
    parts.push(r < 0.5 ? pick(WORDS) : r < 0.75 ? pick(ESCAPES) : r < 0.85 ? '\n' : r < 0.93 ? ' ' : pick(WORDS) + pick(ESCAPES));
  }
  if (random() < 0.05) parts.push('\0tail');
  return parts.join(random() < 0.6 ? ' ' : '');
};
const GC = {canvas: 0x28, originX: 0x2c, originY: 0x30, clipX: 0x34, clipY: 0x38, clipW: 0x3c, clipH: 0x40, flags: 0x48, textFloats: 0x6c, normalFont: 0x7c,
  boldFont: 0x80, underlineTex: 0x84, underlineH: 0x88, baseline: 0x8c, vspacing: 0x90, halign: 0x94, valign: 0x95, textFlags: 0x98, hmult: 0x9c, vmult: 0xa0};

let done = 0, ran = 0, glyphCommands = 0, installed = false;
const fontsOf = () => [...host.resourceImages].filter(([, r]) => r.kind === 'font').map(([address]) => address);
const texturesOf = () => [...host.resourceImages].filter(([, r]) => r.kind === 'texture').map(([address]) => address);

/** One random case on `gc` (the window's GC inside its draw). */
function runCase(gc) {
  const base = gc.base ?? heap.objectAddress(gc), write = (off, kind, value) => heap.mem.write(base + off, kind, value);
  const fonts = fontsOf(), textures = texturesOf();
  if (!fonts.length) return false;
  write(GC.flags, 'u32', 0x2 | (random() < 0.5 ? 1 : 0) | (random() < 0.2 ? 0x20 : 0));
  write(GC.originX, 'f32', f32(Math.round(between(-20, 20))));
  write(GC.originY, 'f32', f32(Math.round(between(-20, 20))));
  write(GC.clipX, 'f32', f32(random() < 0.8 ? 0 : between(-30, 30)));
  write(GC.clipY, 'f32', f32(random() < 0.8 ? 0 : between(-30, 30)));
  write(GC.clipW, 'f32', f32(between(-5, 400)));
  write(GC.clipH, 'f32', f32(between(-5, 200)));
  write(GC.normalFont, 'u32', random() < 0.05 ? 0 : pick(fonts));
  write(GC.boldFont, 'u32', random() < 0.1 ? 0 : pick(fonts));
  write(GC.underlineTex, 'u32', textures.length && random() < 0.5 ? pick(textures) : 0);
  write(GC.underlineH, 'f32', f32(random() < 0.2 ? 0 : between(0, 4)));
  write(GC.baseline, 'f32', f32(between(0, 8)));
  write(GC.vspacing, 'f32', f32(Math.round(between(-2, 6))));
  write(GC.halign, 'u8', Math.floor(random() * 3));
  write(GC.valign, 'u8', Math.floor(random() * 3));
  write(GC.textFlags, 'u32', (random() < 0.6 ? 1 : 0) | (random() < 0.7 ? 2 : 0));
  write(GC.hmult, 'i32', 1 + Math.floor(random() * 3));
  write(GC.vmult, 'i32', 1 + Math.floor(random() * 3));
  for (let i = 0; i < 3; i++) write(GC.textFloats + 4 * i, 'f32', f32(random()));
  write(GC.textFloats + 12, 'f32', 0);
  const dx = f32(Math.round(between(-10, 100))), dy = f32(Math.round(between(-10, 60)));
  const dw = f32(random() < 0.1 ? between(-5, 5) : between(0, 300)), dh = f32(random() < 0.1 ? between(-5, 5) : between(0, 120));
  gcDrawText(gc, bitsOf(dx), bitsOf(dy), bitsOf(dw), bitsOf(dh), randomText(), services);
  return true;
}

const draw = W.v.draw;
W.v.draw = function (win, gc) {
  if (!installed || done >= cases || ran === frameMarker) return draw.call(this, win, gc);
  ran = frameMarker;
  for (let i = 0; i < 25 && done < cases; i++) if (runCase(gc)) done++;
  return draw.call(this, win, gc);
};
let frameMarker = 0;

const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');
const fixture = createPlayerInputFixture(game);
let simulatedMs = 0;
for (let tick = 0; tick < 70 + Math.ceil(cases / 25) + 40 && done < cases; tick++) {
  simulatedMs += 1000 / 60;
  if (tick === 0) fixture.key('KeyW', true);
  game.tick(1 / 60);
  session.sprites();
  installed = tick >= 70;
  frameMarker++;
  const hud = session.hud({width: 1440, height: 960, view: game.view(), stream: true});
  if (hud.errors.length) throw new Error(hud.errors.map(e => e.message).join('; '));
}
if (done < cases) throw new Error(`only ${done} of ${cases} cases ran (the HUD drew no text window?)`);
const verified = game.doors.scriptRuntime.runtime.scriptVm.gc.textVerify;
if (verified.compared < done * 0.9 || verified.commands < done) throw new Error(`verify compared too little: ${JSON.stringify(verified)}`);
console.log(`validate-gc-draw-text-rust: ${done} random DrawText calls on ${map}, Rust against JavaScript: identical (GC image, GC stack, realize cache, commands); compared ${verified.compared}, skipped ${verified.skipped} (a PushGC allocated), ${verified.commands} DrawTile commands`);
process.exit(0);
