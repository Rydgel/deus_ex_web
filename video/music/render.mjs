// Renders the score: plays score.mjs into its synth buses and sampled parts (the latter rendered by sfizz_render and
// fluidsynth, to files only, the orchestra's patches first put in tune by retune.mjs), mixes (inserts, sidechain, delay, two plates), masters to -14 LUFS
// under a -1 dB ceiling, and writes video/out/music/: score.wav (48 kHz, 24-bit), score.mp3, a spectrogram, and
// score.json (bars, sections and cue times for the picture).
//   node video/music/render.mjs            the mix
//   node video/music/render.mjs --stems    also each bus, as mixed, to out/music/stems/
//   node video/music/render.mjs --quiet    no per-section meter table
//   node video/music/render.mjs --label "draft 2"   the name on the listening page (out/music/preview.html); also keeps out/music/drafts/draft-2.mp3
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as S from './synth.mjs';
import {compose, SECTIONS, BUSES, PARTS, BARS, BAR, BPM, BEAT, STEP, DURATION, TAIL, at} from './score.mjs';
import {Part, renderParts} from './sampler.mjs';
import {tunedPatch} from './retune.mjs';
import {themeQuote} from './theme-quote.mjs';
import {writePreview} from './preview.mjs';

const {SR} = S;
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..'), outDir = path.resolve(here, '../out/music');
const samples = path.resolve(here, '../samples');
const flags = new Set(process.argv.slice(2));
const N = Math.ceil(DURATION * SR);
const clock = Date.now(), lap = label => console.error(`  ${((Date.now() - clock) / 1000).toFixed(1).padStart(6)} s  ${label}`);

// ------------------------------------------------------------------------------------------------------------ play
const B = Object.fromEntries(BUSES.map(name => [name, S.stereo(N)]));
const P = Object.fromEntries(Object.entries(PARTS).map(([name, {sfz, tuned, ...spec}]) => [name, Object.assign(new Part(name, {...spec, sfz: sfz && path.join(samples, sfz)}), {tuned})]));
const quote = themeQuote(repo);
const cues = compose(B, P, quote);
lap('synth voices');
const retuned = [];
for (const part of Object.values(P)) if (part.tuned && part.events.length) {
  const fixed = await tunedPatch(part.sfz, {dir: path.join(outDir, 'patches'), ...(part.tuned === true ? {} : part.tuned)});
  part.sfz = fixed.sfz;
  retuned.push(`${part.name} ${fixed.corrected}/${fixed.regions} samples, mean ${fixed.mean} c, max ${fixed.max} c`);
}
lap('tuned patches');
Object.assign(B, await renderParts(Object.values(P), {dir: path.join(outDir, 'sampled'), bpm: BPM, duration: DURATION, sampleRate: SR, gain: 0.3}));
const NAMES = Object.keys(B);
lap(`sampled parts (${Object.values(P).reduce((sum, part) => sum + part.events.length, 0)} notes)`);

// ------------------------------------------------------------------------------------------------------------- mix
// Each bus is trimmed to a level of its own (`lufs`: integrated loudness of what it plays; `peak`: its highest sample, for
// the sparse percussive ones), so the balance is this table and not the sum of the voices' gains. Sends are wet/dry ratios.
const MIX = {
  // synthesized
  drone:      {lufs: -31, hall: 0.12},
  pad:        {lufs: -25.5, hp: 150, chorus: {rate: 0.31, depth: 0.0022, mix: 0.35}, duck: 0.32, hall: 0.36},
  bell:       {lufs: -31, hp: 250, hall: 0.65, delay: 0.3},
  arp:        {lufs: -25.5, hp: 260, duck: 0.22, hall: 0.22, delay: 0.38},
  lead:       {lufs: -20.5, hp: 200, chorus: {rate: 0.4, depth: 0.0016, mix: 0.25}, hall: 0.3, delay: 0.26},
  bass:       {lufs: -19, duck: 0.42},
  kick:       {peak: -7.5, room: 0.04},
  snare:      {peak: -15, hp: 130, lp: 10000, room: 0.3},
  fx:         {peak: -10, hall: 0.4},
  blip:       {peak: -27, hall: 0.5, delay: 0.5},
  // sampled
  piano:      {lufs: -22, hp: 70, hall: 0.36, delay: 0.1},
  pianoDbl:   {lufs: -24, hp: 160, hall: 0.25, delay: 0.14},
  rhodes:     {lufs: -26, hp: 110, chorus: {rate: 0.55, depth: 0.0018, mix: 0.4}, hall: 0.4, delay: 0.12},
  celesta:    {lufs: -29.5, hp: 300, hall: 0.6, delay: 0.3},
  celestaDbl: {lufs: -28, hp: 300, hall: 0.4, delay: 0.25},
  vibes:      {lufs: -29, hp: 200, hall: 0.55, delay: 0.2},
  harp:       {lufs: -28, hp: 180, hall: 0.35, delay: 0.25},
  strings:    {lufs: -22.5, hp: 170, hall: 0.4},
  slowstr:    {lufs: -25, hp: 90, duck: 0.15, hall: 0.45},
  horns:      {lufs: -20.5, hp: 110, hall: 0.5},
  voices:     {lufs: -25, hp: 180, duck: 0.15, hall: 0.6},
  kitKick:    {peak: -9, room: 0.05},
  kitSnare:   {peak: -6.5, hp: 110, room: 0.3, hall: 0.1},
  kitHats:    {peak: -14, hp: 400, room: 0.1},
  kitCym:     {peak: -11, hp: 300, hall: 0.3, room: 0.15},
  kitToms:    {peak: -8, room: 0.3, hall: 0.2},
  timpani:    {peak: -9, hall: 0.4, room: 0.2},
  timpRoll:   {peak: -11, hall: 0.4},
  orchSnare:  {peak: -9, hall: 0.35, room: 0.3},
  orchBass:   {peak: -7, hall: 0.35},
  cymbals:    {peak: -11, hp: 250, hall: 0.4},
  orchMisc:   {peak: -13, hp: 150, hall: 0.5},
  kitShake:   {peak: -14, hp: 500, room: 0.15},
};
const HALL = {decay: 0.72, damping: 0.66, size: 1.15, predelay: 0.028, bandwidth: 0.8};
const ROOM = {decay: 0.34, damping: 0.5, size: 0.62, predelay: 0.006, bandwidth: 0.9};
const DELAY = {time: BEAT * 0.75, feedback: 0.42, lp: 3600, hp: 300};

const mix = S.stereo(N), sends = {hall: S.stereo(N), room: S.stereo(N), delay: S.stereo(N)};
const add = (dst, src, g) => { for (let i = 0; i < N; i++) { dst.L[i] += src.L[i] * g; dst.R[i] += src.R[i] * g; } };
const scale = (buf, g) => { for (let i = 0; i < N; i++) { buf.L[i] *= g; buf.R[i] *= g; } };
const trims = {};
for (const name of NAMES) {
  const bus = B[name], m = MIX[name];
  if (!m) throw new Error(`no mix entry for ${name}`);
  if (m.hp) S.eq(bus, [['hp', m.hp, 0.707]]);
  if (m.lp) S.eq(bus, [['lp', m.lp, 0.707]]);
  if (m.chorus) S.chorus(bus, m.chorus);
  const now = m.lufs != null ? S.lufs(bus) : S.db(S.peakOf(bus)), want = m.lufs ?? m.peak;
  trims[name] = Number.isFinite(now) ? want - now : 0;
  scale(bus, S.undb(trims[name]));
  if (m.duck) S.duck(bus, cues.duck, {depth: m.duck});
  add(mix, bus, 1);
  for (const key of ['hall', 'room', 'delay']) if (m[key]) add(sends[key], bus, m[key]);
}
lap('buses');
S.eq(sends.delay, [['hp', 300, 0.707]]);
const echo = S.pingPong(sends.delay, DELAY);
add(sends.hall, echo, 0.3);                                         // the repeats sit in the same hall
// the hall is fed less while the full band plays (the groove sections), so it stays a space and not a wash;
// the quiet scenes and the cut into the Denton scene get all of it
{
  const dense = SECTIONS.filter(sec => /^(work|finale)/.test(sec.name)).map(sec => [at(sec.bar), at(sec.bar + sec.bars)]), ramp = 0.4;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let g = 1;
    for (const [t0, t1] of dense) if (t > t0 - ramp && t < t1) g = Math.min(g, 1 - 0.32 * Math.min(1, (t - t0 + ramp) / ramp, (t1 - t) / 0.05));
    sends.hall.L[i] *= g; sends.hall.R[i] *= g;
  }
}
S.eq(sends.hall, [['hp', 220, 0.707], ['lp', 9000, 0.707]]);
S.eq(sends.room, [['hp', 180, 0.707]]);
const hall = S.plate(sends.hall, HALL), room = S.plate(sends.room, ROOM);
const returns = {echo, hall, room};
scale(hall, 1 / S.plateGain(HALL)); scale(room, 1 / S.plateGain(ROOM));
S.duck(hall, cues.duck, {depth: 0.15});
for (const r of Object.values(returns)) add(mix, r, 1);
lap('effects');

// ------------------------------------------------------------------------------------------------------- metering
const span = sec => [Math.round(at(sec.bar) * SR), Math.round(at(sec.bar + sec.bars) * SR)];
const LABEL = {pianoDbl: 'pnoDb', celesta: 'celes', celestaDbl: 'celDb', strings: 'strng', slowstr: 'slowS', kitKick: 'kKick', kitSnare: 'kSnar', kitHats: 'kHats', kitCym: 'kCym', kitToms: 'kToms', kitShake: 'kShak', timpani: 'timp', timpRoll: 'tRoll', orchSnare: 'oSnar', orchBass: 'oBass', cymbals: 'cymb', orchMisc: 'oMisc'};
const fmt = v => (Number.isFinite(v) && v > -99 ? v.toFixed(1) : '  -- ').padStart(6);
if (!flags.has('--quiet')) {
  console.log(`\nretuned: ${retuned.join(' | ')}`);
  const cols = [...NAMES, ...Object.keys(returns), 'MIX'], src = {...B, ...returns, MIX: mix};
  console.log('\nloudness by section, LUFS (first row: each bus\'s trim, dB)');
  console.log('section '.padEnd(9) + cols.map(c => (LABEL[c] ?? c).slice(0, 5).padStart(6)).join(''));
  console.log('trim'.padEnd(9) + NAMES.map(c => fmt(trims[c])).join(''));
  for (const sec of SECTIONS) console.log(sec.name.padEnd(9) + cols.map(c => fmt(S.lufs(src[c], ...span(sec)))).join(''));
}

// ------------------------------------------------------------------------------------------------------ mastering
S.eq(mix, [['hp', 30, 0.707]]);
const before = S.lufs(mix), TARGET = -14;
scale(mix, S.undb(TARGET - before));
const CEILING = S.undb(-1.9);          // sample peak; leaves the true peak under -1 dB
let reduction = S.limit(mix, {ceiling: CEILING});
const after = S.lufs(mix);
if (TARGET - after > 0.15) { scale(mix, S.undb(TARGET - after)); reduction = Math.max(reduction, S.limit(mix, {ceiling: CEILING})); }
const fade = Math.round(2.5 * SR);
for (let i = N - fade; i < N; i++) { const g = (N - i) / fade; mix.L[i] *= g * g; mix.R[i] *= g * g; }
lap('master');

const bands = S.octaveBands(mix, Math.round(at(32) * SR), Math.round(at(56) * SR));
let mid = 0, side = 0;
for (let i = 0; i < N; i++) { mid += (mix.L[i] + mix.R[i]) ** 2; side += (mix.L[i] - mix.R[i]) ** 2; }
console.log(`\nmaster: ${S.lufs(mix).toFixed(2)} LUFS integrated (pre-master mix ${before.toFixed(1)}), peak ${S.db(S.peakOf(mix)).toFixed(2)} dBFS, limiter up to ${reduction.toFixed(1)} dB, side/mid ${(10 * Math.log10(side / mid)).toFixed(1)} dB`);
console.log('by section: ' + SECTIONS.map(sec => `${sec.name} ${S.lufs(mix, ...span(sec)).toFixed(1)}`).join(' | '));
console.log('octave bands over the work sections, dB re 1 kHz: ' + Object.entries(bands).map(([f, v]) => `${f} ${(v - bands[1000]).toFixed(1)}`).join(' | '));

// --------------------------------------------------------------------------------------------------------- output
mkdirSync(outDir, {recursive: true});
const wav = path.join(outDir, 'score.wav');
writeFileSync(wav, S.wav24(mix));
if (flags.has('--stems')) {
  mkdirSync(path.join(outDir, 'stems'), {recursive: true});
  for (const [name, buf] of Object.entries({...B, ...returns})) writeFileSync(path.join(outDir, 'stems', `${name}.wav`), S.wav24(buf));
}
const round = t => +t.toFixed(4);
writeFileSync(path.join(outDir, 'score.json'), JSON.stringify({
  bpm: BPM, beat: BEAT, step: STEP, bar: BAR, bars: BARS, tail: TAIL, duration: round(DURATION), sampleRate: SR,
  sections: SECTIONS.map(sec => ({...sec, start: round(at(sec.bar)), end: round(at(sec.bar + sec.bars))})),
  barTimes: Array.from({length: BARS + 1}, (_, b) => round(at(b))),
  quoted: quote ? {from: 'Title_Music (Deus Ex main theme, Alexander Brandon)', start: round(at(58)), end: round(at(62)), notes: quote.notes.length} : null,
  cues,
}));
const ff = args => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {stdio: 'inherit'}); return r.status === 0; };
ff(['-i', wav, '-codec:a', 'libmp3lame', '-b:a', '224k', path.join(outDir, 'score.mp3')]);
ff(['-i', wav, '-lavfi', 'showspectrumpic=s=1800x700:legend=1:scale=log:fscale=log:color=magma:drange=90', path.join(outDir, 'spectrogram.png')]);
const finalLufs = S.lufs(mix), label = flags.has('--label') ? process.argv[process.argv.indexOf('--label') + 1] : null;
if (label) {                                                        // a named copy, to compare drafts by ear
  mkdirSync(path.join(outDir, 'drafts'), {recursive: true});
  copyFileSync(path.join(outDir, 'score.mp3'), path.join(outDir, 'drafts', `${label.replace(/[^\w.-]+/g, '-')}.mp3`));
}
writePreview(outDir, {label: label ?? 'draft',
  stats: `${Math.floor(DURATION / 60)}:${String(Math.floor(DURATION % 60)).padStart(2, '0')} · A minor · ${BPM} BPM · ${BARS} bars · ${finalLufs.toFixed(1)} LUFS · rendered ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`});
lap('files');
console.log(`\nwrote ${path.relative(repo, wav)} · ${Math.floor(DURATION / 60)}:${(DURATION % 60).toFixed(1).padStart(4, '0')} · ${BARS} bars at ${BPM} BPM${quote ? ` · ${quote.notes.length} quoted notes (bars 58-61)` : ' · no quote (game files not found)'}`);
