/** UGalaxyAudioSubsystem's music (src/runtime/galaxy-music.mjs, reached
 * through galaxy-audio.mjs's Update) against the original bodies run by
 * scripts/native-galaxy-audio-oracle.py --music
 * (docs/galaxy-music/update-transition.md §9).
 *
 * Each case fabricates the subsystem fields, the viewport Actor's music
 * bytes, UMusic objects with their lazy Data and archive, and a program of
 * Update frames (per-frame dt, Actor field changes, the library's order byte),
 * SetVolumes, SetInstantMusicVolume and UMusic::Destroy (UnregisterMusic)
 * calls. The translation replays the same program and must give, after every
 * op, the same ordered event list (every glx* call with its arguments and,
 * tier 1, its scripted result; the voice clears, the break flag, the order
 * read; UnregisterMusic and SetVolumes entries; the lazy Load/Unload entries
 * with SavedPos; every FArray::Realloc with Num/Max; the GLog lines; the
 * Mem block handed to glxLoadMusic) and the same state (MusicFade bits,
 * +0x888, +0x88c, +0x88d, the Actor's SongSection/CdTrack/Transition, the
 * volume bytes, each UMusic's Handle, SavedPos, Data, Num, Max). Faults
 * (appFailAssert) must match by expression and line.
 *
 * Tier 1 makes the glx* functions recording leaves (scripted results) and is
 * swept over Transition 0..6, Latency 10/40/250 and the x87 control words
 * 0x037f/0x027f/0x007f, replayed at the matching precision (64/53/24 bits).
 * Tier 2 runs the real library (glxLoadMusic with the IT loader on DX songs)
 * and also checks the mirror library (galaxy-music-library.mjs): its results
 * and the bytes it models against the library's globals after every op.
 *
 *   node scripts/validate-galaxy-music-update.mjs [--reuse] [--only name-substring]
 *
 * --reuse keeps .cache/galaxy-music/update/oracle.json when its case list is
 * unchanged. Needs NATIVE_PROBE_PYTHON (unicorn 2.1.4) and the extracted
 * modules in .cache/galaxy-music/modules (scripts/native-galaxy-music-oracle.py).
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createGalaxyAudio} from '../src/runtime/galaxy-audio.mjs';
import {createGalaxyMusic, x87Arithmetic} from '../src/runtime/galaxy-music.mjs';
import {x87double} from '../src/runtime/script-vm.mjs';
import {createMirrorMusicLibrary} from '../src/runtime/galaxy-music-library.mjs';
import {loadLazyByteArray} from '../src/runtime/script-lazy-byte-array.mjs';
import {gameDirectory} from './game-directory.mjs';

const DIRECTORY = '.cache/galaxy-music/update', MODULES = '.cache/galaxy-music/modules';
const PRECISION = {0x037f: 64, 0x027f: 53, 0x007f: 24};
const CWS = [0x037f, 0x027f, 0x007f];
const SAVED_POSITION = 0x40;
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const f32view = new DataView(new ArrayBuffer(4));
const bitsOf = value => (f32view.setFloat32(0, value, true), f32view.getUint32(0, true));
const floatOf = bits => (f32view.setUint32(0, bits >>> 0, true), f32view.getFloat32(0, true));

// ---------------------------------------------------------------------------
// Cases.
let seed = 0x2545f491;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const BASE = {useDigitalMusic: 1, useCDMusic: 0, latency: 40, effectsChannels: 16, musicVolume: 153, soundVolume: 204, speechVolume: 255};
const RATE = {3: 1, 5: 0.2, 4: 3}, K = {3: 0.002, 5: 0.0004, 4: 0.006};
const fadeFrames = (transition, latency, dt) => RATE[transition] ? Math.ceil((1 + latency * K[transition]) / RATE[transition] / dt) + 2 : 1;
const sequence = (kind, count) => Array.from({length: count}, () => kind === 'jitter' ? 0.004 + random() * 0.046 : 1 / 60);
const current = {A: {size: 300, loaded: false, handle: -1}};
const families = {
  first: () => ({musics: {A: {size: 300}}, subsystem: {}, actor: {song: 'A', section: 0, cdTrack: 255}}),
  ab: () => ({musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0}, actor: {song: 'B', section: 2, cdTrack: 255}}),
  aa: () => ({musics: {...current}, subsystem: {current: 'A', section: 0}, actor: {song: 'A', section: 3, cdTrack: 255}}),
  none: () => ({musics: {...current}, subsystem: {current: 'A', section: 1}, actor: {song: null, section: 255, cdTrack: 255}}),
  silentNow: () => ({musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 255}, actor: {song: 'B', section: 0, cdTrack: 255}}),
  silentNew: () => ({musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0}, actor: {song: 'B', section: 255, cdTrack: 255}}),
};
const cases = [];
const add = (name, body) => { for (const cw of body.cws ?? CWS) cases.push({name: `${name}@${cw.toString(16)}`, tier: 1, cw, config: BASE, ...body, cws: undefined}); };
for (const [family, make] of Object.entries(families))
  for (const transition of [0, 1, 2, 3, 4, 5, 6])
    for (const latency of [10, 40, 250])
      for (const kind of latency === 40 ? ['c60', 'jitter'] : ['c60']) {
        const base = make();
        const dts = sequence(kind, fadeFrames(transition, latency, kind === 'jitter' ? 0.027 : 1 / 60));
        const ops = dts.map(dt => ({op: 'update', dt}));
        // Then frames with no transition pending: the order write-back.
        for (const order of [0xff, 0, 7]) ops.push({op: 'update', dt: 1 / 60, order});
        add(`${family}/T${transition}/L${latency}/${kind}`, {...base, config: {...BASE, latency},
          actor: {...base.actor, transition}, ops});
      }
const fade = (frames, dt = 1 / 60) => Array.from({length: frames}, () => ({op: 'update', dt}));
// A mid-fade song flip back to the current song: no unregister, no reload.
add('flip-back', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 3}, ops: [...fade(20), {op: 'set', set: {song: 'A'}}, ...fade(60)]});
add('flip-third', {musics: {...current, B: {size: 500}, C: {size: 700}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 3}, ops: [...fade(20), {op: 'set', set: {song: 'C', section: 4}}, ...fade(60)]});
add('flip-transition', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 4}, ops: [...fade(5), {op: 'set', set: {transition: 5}}, ...fade(400)]});
add('digital-off', {config: {...BASE, useDigitalMusic: 0}, musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 3}, ops: [...fade(80), {op: 'setVolumes'}, {op: 'setInstantMusicVolume', value: 77}]});
add('digital-off-first', {config: {...BASE, useDigitalMusic: 0}, musics: {A: {size: 300}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: fade(3)});
for (const code of [1, 2, 3, 0x11])
  add(`load-fails-${code}`, {musics: {A: {size: 300}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
    returns: {loadMusic: [code]}, ops: fade(3), cws: [0x037f]});
add('control-fails', {musics: {A: {size: 300}}, actor: {song: 'A', section: 9, cdTrack: 255, transition: 1},
  returns: {controlMusic: [0x11], stopMusic: [4], startMusic: [3]}, ops: fade(2), cws: [0x037f]});
add('unload-fails', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 1}, returns: {unloadMusic: [2]}, ops: fade(2), cws: [0x037f]});
// Large dt: one frame jumps from a positive fade past the threshold.
for (const [transition, dts] of [[3, [0.95, 0.95]], [4, [0.3, 0.3]], [5, [0.99, 0.99, 0.99, 0.99, 0.99, 0.99]], [3, [1.5, 0.2]]])
  add(`large-dt/T${transition}/${dts[0]}`, {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
    actor: {song: 'B', section: 2, cdTrack: 255, transition}, ops: dts.map(dt => ({op: 'update', dt}))});
// Unordered and out-of-range dt (the prologue clamps to [0, 1]).
add('dt-edges', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 3},
  ops: [null, -0.5, 0, 2, 1e-300, 0.5, -0, 1, 0.25].map(dt => ({op: 'update', dt}))});
// The fade compare near the threshold: dt steps of one double ulp around
// the crossing, where the precision control decides the frame.
// The first frame brings MusicFade to `remaining` (float32); the second dt
// lands the fade on Latency*k within a few ulps either side.
for (const [transition, latency, dt0] of [[3, 40, 1], [3, 250, 1], [3, 10, 1], [4, 40, 0.3], [5, 40, 1]]) {
  const rate = RATE[transition], remaining = Math.fround(1 - dt0 * rate);
  const crossing = (remaining + latency * K[transition]) / rate;
  for (let j = -4; j <= 4; j++)
    add(`threshold/T${transition}/L${latency}/${j}`, {config: {...BASE, latency}, musics: {...current, B: {size: 500}},
      subsystem: {current: 'A', section: 0}, actor: {song: 'B', section: 2, cdTrack: 255, transition},
      ops: [{op: 'update', dt: dt0}, {op: 'update', dt: crossing + j * 2 ** -56}, {op: 'update', dt: 1 / 60}]});
}
// The same UMusic loaded again after an unregister (Load re-reads the archive).
add('reload', {musics: {A: {size: 300}, B: {size: 500}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: [...fade(2), {op: 'set', set: {song: 'B', section: 1, transition: 4}}, ...fade(30),
    {op: 'set', set: {song: 'A', section: 2, transition: 1}}, ...fade(2)]});
// CdTrack steers the transition without UseCDMusic.
add('cdtrack-none', {musics: {}, subsystem: {cdTrack: 5, section: 0}, actor: {song: null, section: 0, cdTrack: 255, transition: 3}, ops: fade(80)});
add('cdtrack-first', {musics: {A: {size: 300}, B: {size: 500}}, actor: {song: 'A', section: 0, cdTrack: 7, transition: 1},
  ops: [...fade(2), {op: 'set', set: {song: 'B', transition: 3, cdTrack: 255}}, ...fade(80)]});
add('transition-high', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 7},
  ops: [...fade(2), {op: 'set', set: {song: 'A', transition: 255}}, ...fade(2), {op: 'set', set: {transition: 200, section: 6}}, ...fade(2)]});
// UMusic::Destroy (UnregisterMusic through vtable +0x70).
add('destroy-current', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 0},
  ops: [{op: 'destroy', music: 'B'}, {op: 'destroy', music: 'A'}, {op: 'update', dt: 1 / 60}, {op: 'set', set: {transition: 3}}, ...fade(2)]});
add('destroy-midfade', {musics: {...current, B: {size: 500}}, subsystem: {current: 'A', section: 0},
  actor: {song: 'B', section: 2, cdTrack: 255, transition: 3}, ops: [...fade(10), {op: 'destroy', music: 'A'}, ...fade(2)]});
add('destroy-not-current', {musics: {...current, B: {size: 500, handle: -1}}, subsystem: {current: 'A', section: 0}, actor: {song: 'A', transition: 0},
  ops: [{op: 'destroy', music: 'B'}], cws: [0x037f]});
add('destroy-none', {musics: {...current}, subsystem: {current: 'A', section: 0}, actor: {song: 'A', transition: 0},
  ops: [{op: 'destroy', music: null}], cws: [0x037f]});
add('same-song-silence', {musics: {...current}, subsystem: {current: 'A', section: 255}, actor: {song: 'A', section: 2, cdTrack: 255, transition: 3}, ops: fade(3)});
// The order write-back alone, every 17th value.
add('order', {musics: {...current}, subsystem: {current: 'A', section: 0}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 0},
  ops: Array.from({length: 16}, (_, i) => ({op: 'update', dt: 1 / 60, order: (i * 17) & 0xff})), cws: [0x037f]});
// SetVolumes and SetInstantMusicVolume grids.
const FADES = [0x3f800000, 0x3f000000, 0, 0x80000000, 0xbdcccccd, 0x3fc00000, 0x00000001, 0x3eaaaaab, 0x7fc00000, 0x3f7fffff, 0x3c23d70a];
for (const useDigitalMusic of [1, 0]) {
  const ops = [];
  for (const music of [0, 1, 128, 153, 254, 255]) for (const sound of [0, 32, 204, 255]) for (const speech of [0, 128, 255])
    for (const fadeBits of FADES) ops.push({op: 'setVolumes', fadeBits, volumes: [music, sound, speech]});
  add(`setvolumes/digital${useDigitalMusic}`, {config: {...BASE, useDigitalMusic}, musics: {}, actor: {transition: 0}, ops});
  const instant = [];
  for (const value of [0, 1, 2, 17, 64, 100, 127, 128, 152, 153, 154, 200, 254, 255, 256, 0x1ff, -1, 0x7fffffff])
    instant.push({op: 'setInstantMusicVolume', value}, {op: 'setVolumes'});
  add(`instant/digital${useDigitalMusic}`, {config: {...BASE, useDigitalMusic}, musics: {}, actor: {transition: 0}, subsystem: {fadeBits: 0x3f000000}, ops: instant});
}
// The reverb tail 0x1060aa15..0x1060ab93: UseReverb, the listener's
// Region.Zone, the block and the cache compare (glxSetSampleReverb a leaf).
const REVERB_ZONE = {reverb: 1, masterGain: 100, cutoffHz: 6000, delay: [20, 34, 0, 0, 0, 0], gain: [150, 70, 0, 0, 0, 0]};
const frame = extra => ({op: 'update', dt: 1 / 60, ...extra});
add('reverb/enter-leave', {config: {...BASE, useReverb: 1}, musics: {}, actor: {transition: 0}, ops: [frame(),
  frame({set: {zone: REVERB_ZONE}}), frame(), frame({set: {zone: {...REVERB_ZONE, masterGain: 101}}}), frame(),
  frame({set: {zone: {...REVERB_ZONE, reverb: 0}}}), frame(), frame({set: {zone: {...REVERB_ZONE, bits: 0xfffffffe}}}),
  frame({set: {zone: {...REVERB_ZONE, bits: 3}}}), frame({set: {zone: null}}), frame()]});
add('reverb/off', {config: {...BASE, useReverb: 0}, musics: {}, actor: {transition: 0},
  ops: [frame({set: {zone: REVERB_ZONE}}), frame(), frame({set: {zone: {...REVERB_ZONE, cutoffHz: 1000}}})]});
const edgeZones = [];
for (const cutoffHz of [-5, -0x80000000, 0, 1, 1000, 8000, 11027, 44099, 44100, 44101, 50000, 0x7fffffff])
  edgeZones.push({...REVERB_ZONE, cutoffHz});
for (const byte of [0, 1, 2, 3, 169, 170, 171, 254, 255]) {
  edgeZones.push({...REVERB_ZONE, delay: [byte, 255 - byte, byte, 1, 0, 255], gain: [byte, 255 - byte, 0, 1, 254, 255], masterGain: byte});
}
add('reverb/edges', {config: {...BASE, useReverb: 1}, musics: {}, actor: {transition: 0},
  ops: edgeZones.flatMap(zone => [frame({set: {zone}}), frame()])});
const randomZone = () => ({reverb: 1, masterGain: Math.floor(random() * 256), cutoffHz: Math.floor(random() * 60000) - 5000,
  delay: Array.from({length: 6}, () => Math.floor(random() * 256)), gain: Array.from({length: 6}, () => Math.floor(random() * 256))});
add('reverb/random', {config: {...BASE, useReverb: 1}, musics: {}, actor: {transition: 0},
  ops: Array.from({length: 60}, () => frame({set: {zone: random() < 0.1 ? null : randomZone()}}))});
add('reverb/result', {config: {...BASE, useReverb: 1}, musics: {}, actor: {transition: 0}, returns: {setSampleReverb: [0x11, 0, 7]},
  ops: [frame({set: {zone: REVERB_ZONE}}), frame({set: {zone: null}}), frame({set: {zone: REVERB_ZONE}})], cws: [0x037f]});
// Tier 2: the real library on DX songs.
const tier2 = (name, body) => cases.push({name: `tier2/${name}`, tier: 2, cw: 0x037f, config: BASE, ...body});
tier2('intro-first', {musics: {A: {module: 'Intro_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: [...fade(3), {op: 'destroy', music: 'A'}]});
tier2('intro-to-training', {musics: {A: {module: 'Intro_Music'}, B: {module: 'Training_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: [...fade(2), {op: 'set', set: {song: 'B', section: 2, transition: 3}}, ...fade(70), {op: 'destroy', music: 'B'}]});
tier2('intro-section', {musics: {A: {module: 'Intro_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: [...fade(2), {op: 'set', set: {section: 5, transition: 4}}, ...fade(30), {op: 'set', set: {section: 40, transition: 1}}, ...fade(2),
    {op: 'set', set: {section: 255, transition: 3}}, ...fade(2)]});
tier2('lebedev-none', {musics: {A: {module: 'Lebedev_Music'}}, actor: {song: 'A', section: 1, cdTrack: 255, transition: 1},
  ops: [...fade(2), {op: 'set', set: {song: null, section: 255, transition: 3}}, ...fade(70)]});
tier2('title-intro-title', {musics: {A: {module: 'Title_Music'}, B: {module: 'Intro_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 1},
  ops: [...fade(2), {op: 'set', set: {song: 'B', transition: 1}}, ...fade(2), {op: 'set', set: {song: 'A', section: 3, transition: 2}}, ...fade(2),
    {op: 'setInstantMusicVolume', value: 40}, {op: 'setVolumes'}]});
tier2('destroy-midfade', {musics: {A: {module: 'Training_Music'}, B: {module: 'Intro_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: [...fade(2), {op: 'set', set: {song: 'B', transition: 3}}, ...fade(10), {op: 'destroy', music: 'A'}, ...fade(3)]});
tier2('digital-off', {config: {...BASE, useDigitalMusic: 0}, musics: {A: {module: 'Intro_Music'}}, actor: {song: 'A', section: 0, cdTrack: 255, transition: 3},
  ops: fade(3)});

// ---------------------------------------------------------------------------
// The oracle.
mkdirSync(DIRECTORY, {recursive: true});
const caseText = JSON.stringify(cases);
const caseHash = createHash('sha256').update(caseText).digest('hex').slice(0, 16);
const casesPath = `${DIRECTORY}/cases.json`, oraclePath = `${DIRECTORY}/oracle.json`, hashPath = `${DIRECTORY}/cases.sha`;
const reuse = argv.includes('--reuse') && existsSync(oraclePath) && existsSync(hashPath) && readFileSync(hashPath, 'utf8') === caseHash;
if (!reuse) {
  writeFileSync(casesPath, caseText);
  const started = Date.now();
  const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
  const run = spawnSync(python, ['scripts/native-galaxy-audio-oracle.py', gameDirectory(), casesPath, '--music', oraclePath,
    '--modules', MODULES], {encoding: 'utf8', maxBuffer: 1 << 26});
  if (run.status !== 0) throw new Error(`music oracle failed: ${run.stderr}`);
  writeFileSync(hashPath, caseHash);
  console.log(`oracle: ${cases.length} cases in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
assert.equal(oracle.hash, '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353');
assert.equal(oracle.cases.length, cases.length, 'the oracle output matches the case list (rerun without --reuse)');

// ---------------------------------------------------------------------------
// Replay.
const moduleCache = new Map();
const moduleBytes = spec => {
  if (!spec.module) return Uint8Array.from({length: spec.size ?? 300}, (_, i) => (i * 37 + 11) & 0xff);
  if (!moduleCache.has(spec.module)) moduleCache.set(spec.module, new Uint8Array(readFileSync(`${MODULES}/${spec.module}.it`)));
  return moduleCache.get(spec.module);
};
const compactLength = value => { let length = 1, a = Math.abs(value); if (a >= 0x40) { a >>= 6; do { length++; a >>= 7; } while (a); } return length; };

/** Update's prologue: dt = appSecondsSlow() - [+0x880] (FSUB, rounded to the
 * precision control, 0x1060959b), stored as a double. The oracle sets +0x880
 * to 0 and the clock to the case's dt, so the original's dt is the clock
 * rounded to the control's width; galaxy-audio.mjs takes the host's elapsed
 * time as that double, which this supplies. */
function prologueDt(clock, precision) {
  if (precision === 64 || !Number.isFinite(clock) || clock === 0) return clock;
  const v = x87Arithmetic(precision).add(x87double(clock), {neg: 0, sig: 0n, exp: 0});
  return (v.neg ? -1 : 1) * Number(v.sig) * 2 ** v.exp;
}

/** Replay a case through galaxy-audio.mjs's Update and galaxy-music.mjs.
 * Tier 1: the library is the case's scripted results (as the oracle's
 * leaves). Tier 2: the library returns what the real library returned (the
 * oracle's results and order reads, in call order), and the mirror library
 * runs alongside: its own results and state are checked separately until it
 * meets a call it cannot know (a refused controlMusic). */
function replay(c, precision, entry) {
  const events = [];
  const scripted = Object.fromEntries(Object.entries(c.returns ?? {}).map(([k, v]) => [k, [...v]]));
  const orderByte = {value: c.order ?? 0xff};
  const mirror = c.tier === 2 ? createMirrorMusicLibrary() : null;
  const real = {results: {}, orders: []};
  if (c.tier === 2) for (const result of entry.results) for (const event of normalize(result.events)) {
    if (event.glx) (real.results[event.glx] ??= []).push(event.result);
    if ('orderRead' in event) real.orders.push(event.orderRead);
  }
  const mirrorState = {desync: false};
  const glx = (name, args, call, extra = {}) => {
    const event = args === null ? {glx: name, ...extra} : {glx: name, args, ...extra};
    events.push(event);
    const queue = c.tier === 1 ? scripted[name] : real.results[name];
    event.result = queue?.length ? queue.shift() : 0;
    if (mirror) {
      const before = mirror.state.uncertain;
      event.mirrorResult = call();
      if (mirror.state.uncertain !== before) event.uncertain = true;
      if (event.mirrorResult !== event.result) {
        if (!event.uncertain) throw new Error(`mirror ${name}(${args}) returned ${event.mirrorResult}, the library ${event.result}`);
        mirrorState.desync = true;
      }
    }
    return event.result;
  };
  const musics = {};
  const library = {
    lock: () => mirror?.lock(), unlock: () => mirror?.unlock(),
    setSampleVolume: (v, mode) => glx('setSampleVolume', [v, mode], () => mirror.setSampleVolume(v, mode)),
    setMusicVolume: (v, mode) => glx('setMusicVolume', [v, mode], () => mirror.setMusicVolume(v, mode)),
    loadMusic: bytes => {
      const owner = Object.values(musics).find(m => m.lazy.data && m.lazy.data.buffer === bytes.buffer);
      const module = owner?.module, slack = owner ? bytes.subarray(module.length) : null;
      const mem = {length: bytes.length, data: owner?.name ?? -1,
        ...(owner ? {moduleEqual: module.every((b, i) => bytes[i] === b), slack: slack.every(b => b === 0) ? slack.length : 'nonzero'} : {})};
      return glx('loadMusic', [2], () => mirror.loadMusic(bytes), {mem});
    },
    unloadMusic: () => glx('unloadMusic', [], () => mirror.unloadMusic()),
    stopMusic: () => glx('stopMusic', [], () => mirror.stopMusic()),
    startMusic: () => glx('startMusic', [], () => mirror.startMusic()),
    controlMusic: (cmd, value) => glx('controlMusic', [cmd, value], () => mirror.controlMusic(cmd, value)),
    clearVoiceActive: (first, count) => {
      for (let i = 0; i < count; i++) events.push({clearVoice: first + i});
      mirror?.clearVoiceActive(first, count);
    },
    setBreakFlag: () => { events.push({breakFlag: 1}); mirror?.setBreakFlag(); },
    setSampleReverb: words => glx('setSampleReverb', null, () => 0,
      {block: Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString('hex')}),
    order: () => {
      const value = c.tier === 1 ? orderByte.value : real.orders.shift();
      if (mirror && !mirrorState.desync && mirror.order() !== value) throw new Error(`mirror order ${mirror.order()}, the library ${value}`);
      events.push({orderRead: value});
      return value;
    },
  };
  for (const [name, spec] of Object.entries(c.musics ?? {})) {
    const module = moduleBytes(spec), loaded = spec.loaded ?? true;
    const lazy = loaded ? {savedPosition: -SAVED_POSITION, num: module.length, max: module.length, data: module.slice()}
      : {savedPosition: SAVED_POSITION, num: 0, max: 0, data: null};
    const archive = {pos: 0};
    const music = {name, module, fullName: `Music ${spec.module ?? name}.${spec.module ?? name}`, handle: spec.handle ?? 0, lazy,
      // Engine Load 0x1030cbb0 (the shared translation) over the case's
      // archive: the compact count at SavedPos, then the module bytes.
      load: () => loadLazyByteArray(lazy, {
        read: (data, key) => key === 'lazyField08' ? data.savedPosition : key === 'archive' ? archive : key === 'array' ? data : data[key],
        write: (data, key, value) => { if (key === 'lazyField08') data.savedPosition = value; else data[key] = value; },
        tell: ar => ar.pos, seek: (ar, position) => { ar.pos = position; },
        serializeArray: (ar, array) => {
          array.num = array.max = module.length;
          events.push({realloc: [array.num, array.max]});
          array.data = module.slice();
          ar.pos += compactLength(module.length) + module.length;
        },
      }),
      realloc: l => {
        const data = l.max ? new Uint8Array(l.max) : null;
        if (data && l.data) data.set(l.data.subarray(0, Math.min(l.data.length, l.max)));
        l.data = data;
      },
      bytes: l => l.data.subarray(0, l.num),
    };
    musics[name] = music;
  }
  const actor = {Song: c.actor?.song ?? null, SongSection: c.actor?.section ?? 0, CdTrack: c.actor?.cdTrack ?? 0, Transition: c.actor?.transition ?? 0,
    Region: {'engine.actor.pointregion.zone': null}};
  // The listener's Region.Zone as the runtime reads a ZoneInfo (bReverbZone is
  // bit 0 of the bitfield dword +0x3bc).
  const setZone = zone => {
    actor.Region = {'engine.actor.pointregion.zone': zone === null ? null : {bReverbZone: Boolean((zone.bits ?? (zone.reverb ? 1 : 0)) & 1),
      MasterGain: zone.masterGain ?? 0, CutoffHz: zone.cutoffHz ?? 0, Delay: zone.delay ?? [0, 0, 0, 0, 0, 0], Gain: zone.gain ?? [0, 0, 0, 0, 0, 0]}};
  };
  if (c.actor && 'zone' in c.actor) setZone(c.actor.zone);
  const volumes = {musicVolume: c.config.musicVolume, soundVolume: c.config.soundVolume, speechVolume: c.config.speechVolume};
  const trace = event => {
    if (event.op === 'setVolumes') events.push({call: 'setVolumes'});
    else if (event.op === 'unregister') events.push({call: 'unregister', music: event.music ?? null});
    else if (event.op === 'lazyLoad' || event.op === 'lazyUnload')
      events.push({call: event.op, music: event.music.name, savedPosition: event.savedPosition});
    else if (event.op === 'realloc') events.push({realloc: [event.num, event.max]});
  };
  const music = createGalaxyMusic({useDigitalMusic: c.config.useDigitalMusic, useCDMusic: c.config.useCDMusic,
    latency: c.config.latency, effectsChannels: c.config.effectsChannels, volumes, precision}, {
    library, music: song => musics[song],
    read: (object, name) => object[name], write: (object, name, value) => { object[name] = value; },
    log: (name, text) => events.push({log: name, text}), trace});
  const sub = c.subsystem ?? {};
  Object.assign(music.state, {current: sub.current ?? null, cdTrack: sub.cdTrack ?? 0xff, section: sub.section ?? 0,
    fade: floatOf(sub.fadeBits ?? 0x3f800000)});
  const audio = createGalaxyAudio({effectsChannels: c.config.effectsChannels, ambientFactor: 0.7, dopplerSpeed: 6500,
    soundVolume: c.config.soundVolume, speechVolume: c.config.speechVolume, useSurround: 0, reverseStereo: 0,
    useReverb: c.config.useReverb ?? 0, precision}, {
    log: (name, text) => events.push({log: name, text}),
    listener: () => ({actor, viewTarget: null}),
    read: (object, name) => name === 'Location' ? [0, 0, 0] : name === 'ShowFlags' ? 0 : object[name],
    library, music});
  const identity = {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]};
  const results = [];
  for (const op of c.ops) {
    events.length = 0;
    if (op.set) for (const [key, value] of Object.entries(op.set)) {
      if (key === 'zone') setZone(value);
      else actor[{song: 'Song', section: 'SongSection', cdTrack: 'CdTrack', transition: 'Transition'}[key]] = value;
    }
    if ('order' in op) orderByte.value = op.order;
    if (op.returns) for (const [k, v] of Object.entries(op.returns)) scripted[k] = [...v];
    const record = {op: op.op};
    try {
      if (op.op === 'update') audio.update(prologueDt(op.dt ?? NaN, precision), identity);
      else if (op.op === 'setVolumes') {
        if ('fadeBits' in op) music.state.fade = floatOf(op.fadeBits);
        if (op.volumes) [volumes.musicVolume, volumes.soundVolume, volumes.speechVolume] = op.volumes;
        music.setVolumes();
      } else if (op.op === 'setInstantMusicVolume') music.setInstantMusicVolume(op.value);
      else if (op.op === 'destroy') music.unregisterMusic(op.music);
    } catch (error) {
      const match = /appFailAssert "(.*)", line 0x([0-9a-f]+)/.exec(error.message);
      if (!match) throw error;
      record.fault = {assert: match[1], line: Number.parseInt(match[2], 16)};
    }
    record.events = events.slice();
    record.state = {fade: bitsOf(music.state.fade), current: music.state.current, cdTrack: music.state.cdTrack, section: music.state.section,
      actor: {section: actor.SongSection & 0xff, cdTrack: actor.CdTrack & 0xff, transition: actor.Transition & 0xff},
      volumes: [volumes.musicVolume, volumes.soundVolume, volumes.speechVolume],
      musics: Object.fromEntries(Object.entries(musics).map(([name, m]) => [name, {savedPosition: m.lazy.savedPosition,
        data: m.lazy.data !== null, num: m.lazy.num, max: m.lazy.max, handle: m.handle}]))};
    if (mirror) record.mirror = mirrorState.desync ? null : {...mirror.state, module: undefined};
    results.push(record);
  }
  return results;
}

/** Oracle events in the translation's terms: allocator and archive traffic
 * dropped, FArray::Realloc as [Num, Max], the Mem block's constants checked. */
function normalize(events) {
  const out = [];
  for (const event of events) {
    if (event.gmalloc || event.archive) continue;
    if (event.realloc) { assert.equal(event.elementSize, 1); out.push({realloc: event.realloc}); continue; }
    if (event.glx === 'loadMusic') {
      const {tag, size, position, ...mem} = event.mem;
      assert.deepEqual([tag, size, position], [0x4f4d454d, 0xc, 0], 'glxLoadMusic Mem header');
      out.push({glx: 'loadMusic', args: [event.args[1]], mem, ...('result' in event ? {result: event.result} : {})});
      continue;
    }
    out.push(event);
  }
  return out;
}
const strip = events => events.map(event => {
  if (event.glx) { const {mirrorResult, uncertain, ...rest} = event; return rest; }
  return event;
});

let opsCompared = 0, eventsCompared = 0, framesCompared = 0, mirrorChecks = 0, uncertainControls = 0;
const failures = [];
const original = new Map(oracle.cases.map(entry => [entry.name, entry]));
for (const c of cases) {
  if (only && !c.name.includes(only)) continue;
  const entry = original.get(c.name);
  if (entry.error) { failures.push(`${c.name}: oracle error ${entry.error}`); continue; }
  const precision = PRECISION[c.cw];
  let ours;
  try { ours = replay(c, precision, entry); } catch (error) { failures.push(`${c.name}: translation threw ${error.stack}`); continue; }
  for (let i = 0; i < c.ops.length; i++) {
    const theirs = entry.results[i], mine = ours[i], label = `${c.name} op ${i} (${c.ops[i].op})`;
    try {
      assert.deepEqual(mine.fault ?? null, theirs.fault ?? null, `${label}: fault`);
      const expected = normalize(theirs.events);
      assert.deepEqual(strip(mine.events), expected, `${label}: events`);
      for (const event of mine.events) if (event.uncertain) uncertainControls++;
      const {library: lib, voices, slots, ...state} = theirs.state;
      assert.deepEqual(mine.state, state, `${label}: state`);
      if (c.tier === 2 && mine.mirror) {
        const m = mine.mirror;
        const byte = v => v === null ? null : v & 0xff;
        assert.equal(m.order, lib.order, `${label}: mirror order`);
        assert.equal(m.breakFlag, lib.breakFlag, `${label}: mirror break flag`);
        assert.equal(m.playing ? 1 : 0, lib.playing, `${label}: mirror playing`);
        assert.equal(m.loaded, lib.channels !== 0, `${label}: mirror module loaded`);
        if (m.loopFlag !== null) assert.equal(m.loopFlag, lib.loopFlag, `${label}: mirror [0x10698200]`);
        for (const key of ['music', 'sample']) for (const part of ['Master', 'Step', 'Target'])
          if (m[`${key}${part}`] !== null) assert.equal(byte(m[`${key}${part}`]), lib[`${key}${part}`], `${label}: mirror ${key}${part}`);
        mirrorChecks++;
      }
      opsCompared++; eventsCompared += expected.length; if (c.ops[i].op === 'update') framesCompared++;
    } catch (error) {
      failures.push(error.message.split('\n').slice(0, 40).join('\n'));
      break;
    }
  }
}

// How the control words differ in the original: same program, other word.
const scenarios = new Map();
for (const entry of oracle.cases) {
  const at = entry.name.lastIndexOf('@');
  if (at < 0 || entry.error) continue;
  const key = entry.name.slice(0, at);
  if (!scenarios.has(key)) scenarios.set(key, {});
  scenarios.get(key)[entry.name.slice(at + 1)] = entry.results;
}
const differences = {'27f': new Map(), '7f': new Map()};
let compared = 0;
for (const [key, byWord] of scenarios) {
  if (!byWord['37f']) continue;
  compared++;
  for (const word of ['27f', '7f']) {
    const other = byWord[word];
    if (!other) continue;
    const kinds = new Set();
    byWord['37f'].forEach((result, i) => {
      const a = normalize(result.events), b = normalize(other[i].events);
      if (JSON.stringify(a.map(e => e.glx === 'setSampleVolume' ? e.args : null)) !== JSON.stringify(b.map(e => e.glx === 'setSampleVolume' ? e.args : null))) kinds.add('sample volume');
      if (JSON.stringify(a.filter(e => e.glx === 'setMusicVolume').map(e => e.args)) !== JSON.stringify(b.filter(e => e.glx === 'setMusicVolume').map(e => e.args))) kinds.add('music volume');
      if (result.state.fade !== other[i].state.fade) kinds.add('MusicFade bits');
      if (a.some(e => e.call === 'unregister' || e.glx === 'startMusic') !== b.some(e => e.call === 'unregister' || e.glx === 'startMusic')) kinds.add('transition end frame');
    });
    if (kinds.size) differences[word].set(key, [...kinds]);
  }
}

// Sensitivity: the PC64 cases replayed at another precision must fail somewhere.
let wrongPrecisionFailures = 0, wrongPrecisionTried = 0;
for (const c of cases) {
  if (c.tier !== 1 || c.cw !== 0x037f || !/threshold|setvolumes|instant|first\/T3\/L40\/c60/.test(c.name)) continue;
  wrongPrecisionTried++;
  const entry = original.get(c.name);
  const ours = replay(c, 53, entry);
  const same = ours.every((mine, i) => JSON.stringify(strip(mine.events)) === JSON.stringify(normalize(entry.results[i].events))
    && mine.state.fade === entry.results[i].state.fade);
  if (!same) wrongPrecisionFailures++;
}

const summary = (word, map) => {
  const counts = new Map();
  for (const kinds of map.values()) for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return `${map.size}/${compared} scenarios differ from 0x037f under 0x0${word} (${[...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`;
};
console.log(`cases ${cases.length} (tier 1 ${cases.filter(c => c.tier === 1).length}, tier 2 ${cases.filter(c => c.tier === 2).length}); ` +
  `ops compared ${opsCompared}, Update frames ${framesCompared}, events ${eventsCompared}, mirror state checks ${mirrorChecks} ` +
  `(controlMusic results the mirror cannot know: ${uncertainControls})`);
console.log(summary('27f', differences['27f']));
console.log(summary('7f', differences['7f']));
// Instruction coverage of the original bodies over every case.
const hex = value => `0x${value.toString(16)}`;
for (const fn of oracle.coverage ?? []) {
  const covered = new Set(fn.covered), insns = fn.instructions.filter(([, text]) => text !== 'nop' && text !== 'int3');
  const runs = [];
  for (const [address] of insns) {
    if (covered.has(address)) continue;
    const last = runs.at(-1), index = insns.findIndex(([a]) => a === address);
    if (last && last.next === index) { last.to = address; last.next = index + 1; last.count++; }
    else runs.push({from: address, to: address, next: index + 1, count: 1});
  }
  console.log(`coverage ${fn.function} ${hex(fn.start)}..${hex(fn.end)}: ${insns.length - runs.reduce((n, r) => n + r.count, 0)}/${insns.length}` +
    (runs.length ? `; unreached ${runs.map(r => r.from === r.to ? hex(r.from) : `${hex(r.from)}..${hex(r.to)}`).join(', ')}` : ''));
}
console.log(`precision sensitivity: ${wrongPrecisionFailures}/${wrongPrecisionTried} PC64 cases fail when replayed at 53 bits`);
if (failures.length) {
  console.error(`${failures.length} case(s) differ:\n${failures.slice(0, Number(process.env.SHOW_FAILURES ?? 8)).join('\n---\n')}`);
  process.exit(1);
}
console.log('validate-galaxy-music-update: PASS');
