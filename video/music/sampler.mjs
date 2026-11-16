// Sampled instruments for the score: each Part collects notes, is written as a small MIDI file and rendered offline (file
// output only, nothing is played), dry, into a stereo buffer the mixer treats like any synth bus. Two players:
//   - an SFZ instrument (a recorded sample library, see video/music/README.md) through `sfizz_render` (Arch: sfizz-standalone);
//   - a General MIDI program of /usr/share/soundfonts/FluidR3_GM.sf2 through `fluidsynth` (Arch: fluidsynth, soundfont-fluid).
// Renders are cached by content in <dir>/, so only the parts that changed are rendered again.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';

export const SOUNDFONT = '/usr/share/soundfonts/FluidR3_GM.sf2';
const PPQ = 960;

export class Part {
  /**
   * sfz: path of an SFZ instrument; otherwise program: General MIDI program number (0-based), or with drums: the kit
   * (0 Standard, 8 Room, 16 Power, 48 Orchestra). cc: controller values set before the first note, {number: 0..127}.
   */
  constructor(name, {sfz = null, program = 0, bank = 0, drums = false, advance = 0, cc = {}} = {}) { Object.assign(this, {name, sfz, program, bank, drums, advance, cc, events: []}); }
  /** t and dur in seconds, vel 0..1. `advance` starts every note that much early, for samples with a slow attack. */
  note(t, dur, midi, vel = 0.8) { this.events.push({t: Math.max(0, t - this.advance), dur: dur + Math.min(t, this.advance), midi, vel}); }
  /** A gain breakpoint at t seconds: the rendered part is scaled by the line through its breakpoints (held outside them). */
  gain(t, g) { (this.gains ??= []).push([t, g]); }
}

const vlq = n => { const out = [n & 127]; while ((n >>= 7) > 0) out.unshift((n & 127) | 128); return out; };

function midiFile(part, {bpm, duration}) {
  const ch = part.drums ? 9 : 0, tick = t => Math.max(0, Math.round(t * bpm / 60 * PPQ)), end = tick(duration);
  // a key struck again while it sounds: end the first note just before, or its note-off would stop the second
  const notes = part.events.map(e => ({on: tick(e.t), off: Math.max(tick(e.t) + 1, tick(e.t + e.dur)), key: e.midi, vel: Math.max(1, Math.min(127, Math.round(e.vel * 127)))}))
    .sort((a, b) => a.on - b.on);
  const sounding = new Map();
  for (const note of notes) {
    const prev = sounding.get(note.key);
    if (prev && prev.off >= note.on) prev.off = Math.max(prev.on + 1, note.on - 1);
    sounding.set(note.key, note);
  }
  const events = [];
  for (const note of notes) { events.push([note.on, 1, 0x90 | ch, note.key, note.vel]); events.push([Math.min(note.off, end), 0, 0x80 | ch, note.key, 0]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const usPerBeat = Math.round(60e6 / bpm);
  const body = [0, 0xff, 0x51, 3, usPerBeat >> 16, (usPerBeat >> 8) & 255, usPerBeat & 255];
  if (!part.drums) body.push(0, 0xb0 | ch, 0, part.bank, 0, 0xb0 | ch, 32, 0);
  body.push(0, 0xc0 | ch, part.program, 0, 0xb0 | ch, 7, 127, 0, 0xb0 | ch, 91, 0, 0, 0xb0 | ch, 93, 0);
  for (const [number, value] of Object.entries(part.cc)) body.push(0, 0xb0 | ch, Number(number), value);
  let now = 0;
  for (const [at, , status, a, b] of events) { body.push(...vlq(at - now), status, a, b); now = at; }
  body.push(...vlq(Math.max(0, end - now)), 0xb0 | ch, 7, 127, 0, 0xff, 0x2f, 0);       // keep rendering to the end of the piece
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0]);
  head.writeUInt32BE(body.length, 18);
  return Buffer.concat([head, Buffer.from(body)]);
}

/** Reads a WAV (16/24/32-bit PCM or 32-bit float, stereo) into {L, R} of exactly `length` samples. */
export function readWav(file, length) {
  const d = readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= d.length) {
    const id = d.toString('latin1', p, p + 4), size = d.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = {tag: d.readUInt16LE(p + 8), channels: d.readUInt16LE(p + 10), rate: d.readUInt32LE(p + 12), bits: d.readUInt16LE(p + 22), sub: size >= 26 ? d.readUInt16LE(p + 32) : 0};
    if (id === 'data') { data = [p + 8, Math.min(size, d.length - p - 8)]; break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`not a WAV file: ${file}`);
  const float = fmt.tag === 3 || (fmt.tag === 0xfffe && fmt.sub === 3), bytes = fmt.bits / 8, frame = bytes * fmt.channels, frames = Math.floor(data[1] / frame);
  const out = {L: new Float32Array(length), R: new Float32Array(length), rate: fmt.rate, frames};
  const read = float ? o => d.readFloatLE(o) : bytes === 2 ? o => d.readInt16LE(o) / 32768 : bytes === 3 ? o => d.readIntLE(o, 3) / 8388608 : o => d.readInt32LE(o) / 2147483648;
  for (let i = 0, o = data[0]; i < Math.min(frames, length); i++, o += frame) { out.L[i] = read(o); out.R[i] = fmt.channels > 1 ? read(o + bytes) : out.L[i]; }
  return out;
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {stdio: ['ignore', 'ignore', 'pipe']});
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  child.on('error', reject);
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
});

/** Renders every part with notes; -> {name: {L, R}} at `sampleRate`, `duration` seconds long. */
export async function renderParts(parts, {dir, bpm, duration, sampleRate = 48000, soundfont = SOUNDFONT, gain = 0.5}) {
  if (parts.some(part => !part.sfz && part.events.length) && !existsSync(soundfont)) throw new Error(`soundfont not found: ${soundfont} (Arch: pacman -S fluidsynth soundfont-fluid)`);
  for (const part of parts) if (part.sfz && part.events.length && !existsSync(part.sfz)) throw new Error(`${part.name}: SFZ instrument not found: ${part.sfz} (see video/music/README.md)`);
  mkdirSync(dir, {recursive: true});
  const length = Math.ceil(duration * sampleRate), out = {}, kept = new Set(), playing = parts.filter(part => part.events.length);
  for (const part of playing) out[part.name] = null;                        // keep the parts' own order
  await Promise.all(playing.map(async part => {
    const mid = midiFile(part, {bpm, duration});
    const args = part.sfz ? ['--sfz', part.sfz, '-s', String(sampleRate), '-q', '3', '-p', '256', '--use-eot']
      : ['-ni', '-T', 'wav', '-O', 'float', '-r', String(sampleRate), '-g', String(gain), '-R', '0', '-C', '0', '-o', 'synth.polyphony=1024'];
    const key = createHash('sha1').update(mid).update(args.join(' ')).update(part.sfz ? readFileSync(part.sfz) : soundfont).digest('hex').slice(0, 16);
    const wav = path.join(dir, `${part.name}-${key}.wav`);
    kept.add(path.basename(wav));
    if (!existsSync(wav)) {
      const midPath = path.join(dir, `${part.name}.mid`);
      writeFileSync(midPath, mid);
      if (part.sfz) await run('sfizz_render', [...args, '--midi', midPath, '--wav', wav]);
      else await run('fluidsynth', [...args, '-F', wav, soundfont, midPath]);
    }
    const buf = out[part.name] = readWav(wav, length);
    if (buf.rate !== sampleRate) throw new Error(`${part.name}: rendered at ${buf.rate} Hz`);
    if (part.gains) {
      const points = [...part.gains].sort((a, b) => a[0] - b[0]);
      for (let i = 0, k = 0; i < length; i++) {
        const t = i / sampleRate;
        while (k + 1 < points.length && points[k + 1][0] <= t) k++;
        const [t0, g0] = points[k], [t1, g1] = points[k + 1] ?? points[k];
        const g = t <= t0 || t1 === t0 ? g0 : g0 + (g1 - g0) * Math.min(1, (t - t0) / (t1 - t0));
        buf.L[i] *= g; buf.R[i] *= g;
      }
    }
  }));
  for (const file of readdirSync(dir)) if (file.endsWith('.wav') && !kept.has(file)) unlinkSync(path.join(dir, file));
  return out;
}
