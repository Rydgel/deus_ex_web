// The Deus Ex main theme (Title_Music, by Alexander Brandon and Michiel van den Bos) as note events, for the promo's re-thinking
// of it. The song is read at build time from the local installation (Music/Title_Music.umx, the IT module UMusic carries), so
// no note of it is stored in this repository. music.mjs takes only each bar's harmony and a few quoted lines from these events
// (its own accompaniment does the rest) and plays nothing of the module's audio.
//
// Each sample's tuning is measured, not assumed (2026-10-25): a harmonic-product spectrum of its sustained part gives the
// pitch class it sounds at C-5, and the consonance of every part with the parts sounding with it confirms it (the song is in A
// minor: the "Straylight" pad and an ENDING.IT voice sound a fifth off their written notes, the bass a whole tone, and so on).
// The octave of each part is the promo's choice, by its role; the pitch classes, the contours and the rhythm are the song's.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../../src/unreal/assets.mjs';
import {musicExports} from '../../src/unreal/music-module.mjs';

// sample -> [pitch class sounding at written C-5 (null: unpitched), role]
export const SAMPLES = {
  1: [0, 'lead'], 2: [5, 'stab'], 3: [4, 'bell'], 4: [0, 'pad'], 5: [2, 'bass'], 6: [7, 'lead2'], 7: [11, 'choir'], 8: [null, 'roll'],
  9: [null, 'perc'], 10: [null, 'crash'], 11: [4, 'pad'], 12: [null, 'hit'], 13: [8, 'pulse'], 14: [0, 'arp'], 15: [4, 'bass'],
  16: [7, 'low'], 17: [3, 'choir'], 18: [0, 'boom'], 19: [null, 'swell'], 20: [null, 'ride'], 21: [null, 'hat'], 22: [null, 'hat'],
  23: [null, 'tom'], 24: [9, 'synth'], 25: [null, 'clap'], 26: [null, 'kick'], 27: [null, 'snare'], 30: [9, 'choir'], 31: [9, 'pad'],
};
// the register each role is placed in (the MIDI note its median lands nearest)
const TARGET = {lead: 69, lead2: 69, stab: 62, bell: 81, pad: 60, bass: 40, pulse: 40, low: 50, choir: 57, arp: 69, synth: 74, boom: 38};

async function readModule(game) {
  const file = path.join(game, 'Music', 'Title_Music.umx');
  const store = new AssetStore([{path: 'Music/Title_Music.umx', read: () => readFile(file)}]);
  return musicExports(await store.get('Title_Music'))[0].bytes;
}

function parse(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u8 = o => b[o], u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
  const ordNum = u16(0x20), insNum = u16(0x22), smpNum = u16(0x24), patNum = u16(0x26);
  let p = 0xc0 + ordNum + 4 * insNum;
  const smpOff = [...Array(smpNum)].map((_, i) => u32(p + 4 * i)); p += 4 * smpNum;
  const patOff = [...Array(patNum)].map((_, i) => u32(p + 4 * i));
  const samples = smpOff.map(o => ({vol: u8(o + 0x13)}));
  const patterns = patOff.map(o => {
    if (!o) return null;
    const len = u16(o), rows = u16(o + 2);
    let q = o + 8; const end = q + len;
    const last = Array(64).fill(null).map(() => ({mask: 0, note: 0, ins: 0, vol: 0, cmd: 0, val: 0}));
    const grid = [...Array(rows)].map(() => []);
    for (let row = 0; row < rows && q < end; row++) for (;;) {
      const cv = u8(q++); if (!cv) break;
      const ch = (cv - 1) & 63, L = last[ch];
      if (cv & 128) L.mask = u8(q++);
      const c = {ch};
      if (L.mask & 1) { L.note = u8(q++); c.note = L.note; }
      if (L.mask & 2) { L.ins = u8(q++); c.ins = L.ins; }
      if (L.mask & 4) { L.vol = u8(q++); c.vol = L.vol; }
      if (L.mask & 8) { L.cmd = u8(q++); L.val = u8(q++); c.cmd = L.cmd; c.val = L.val; }
      if (L.mask & 16) c.note = L.note;
      if (L.mask & 32) c.ins = L.ins;
      if (L.mask & 64) c.vol = L.vol;
      if (L.mask & 128) { c.cmd = L.cmd; c.val = L.val; }
      grid[row].push(c);
    }
    return {rows, grid};
  });
  return {orders: [...b.subarray(0xc0, 0xc0 + ordNum)], speed: u8(0x32), tempo: u8(0x33), samples, patterns};
}

const A = 1, C = 3, D = 4, G = 7, Q = 17, S = 19, T = 20;

/** arrangement: [[section, [order indices]], ...] -> {events, bars, sections, end} (seconds; bars every 16 rows). */
export async function themeScore({game, arrangement}) {
  const song = parse(await readModule(game));
  let speed = song.speed, tempo = song.tempo, t = 0;
  const events = [], bars = [], sections = {};
  const live = new Map();     // channel -> the sounding event
  const memD = new Map();     // channel -> last volume-slide parameter
  const finish = (ch, at, cut = false) => { const e = live.get(ch); if (e) { e.dur = Math.max(0.02, at - e.t); e.cut = cut; live.delete(ch); } };
  for (const [name, orderList] of arrangement) {
    const start = t;
    for (const oi of orderList) {
      const P = song.patterns[song.orders[oi]];
      for (let row = 0; row < P.rows; row++) {
        const cells = P.grid[row];
        let brk = false;
        for (const c of cells) {
          if (c.cmd === A && c.val) speed = c.val;
          if (c.cmd === T && c.val >= 0x20) tempo = c.val;
          if (c.cmd === C) brk = true;
        }
        const tick = 2.5 / tempo, dt = speed * tick;
        if (row % 16 === 0) bars.push(t);
        for (const c of cells) {
          const ch = c.ch;
          if (c.note === 254 || c.note === 255) { finish(ch, t, c.note === 254); continue; }
          if (c.note != null && c.note < 120 && c.ins && SAMPLES[c.ins]) {
            const prev = live.get(ch);
            const [pc, role] = SAMPLES[c.ins];
            const vol = (c.vol ?? song.samples[c.ins - 1]?.vol ?? 64) / 64;
            const porta = c.cmd === G && Boolean(prev);
            finish(ch, t);
            const e = {t, ch, ins: c.ins, role, note: c.note, pc, vol, curve: [[0, vol]], porta, order: oi, section: name};
            // S Cx: cut after x ticks; Q xy: retrigger every y ticks (percussion)
            if (c.cmd === S && (c.val >> 4) === 0xc) e.cutAfter = (c.val & 15) * tick;
            if (c.cmd === Q && (c.val & 15)) e.retrig = (c.val & 15) * tick;
            events.push(e);
            live.set(ch, e);
          } else if (c.vol != null && live.has(ch)) {
            const e = live.get(ch);
            e.curve.push([t - e.t, c.vol / 64]);
          }
          // D: volume slides on the sounding note (fine slides once per row, coarse ones on every tick after the first)
          if (c.cmd === D && live.has(ch)) {
            const e = live.get(ch);
            let v = c.val || memD.get(ch) || 0;
            memD.set(ch, v);
            const x = v >> 4, y = v & 15;
            let level = e.curve.at(-1)[1] * 64;
            if (y === 15 && x) level += x; else if (x === 15 && y) level -= y;
            else if (y === 0) level += x * (speed - 1); else if (x === 0) level -= y * (speed - 1);
            e.curve.push([t + dt - e.t, Math.max(0, Math.min(64, level)) / 64]);
          }
        }
        for (const e of live.values()) if (e.cutAfter != null && t + dt - e.t >= e.cutAfter) finish(e.ch, e.t + e.cutAfter, true);
        t += dt;
        if (brk) break;
      }
    }
    sections[name] = [start, t];
  }
  for (const ch of [...live.keys()]) finish(ch, t + 2);
  // registers: per pitched sample, the octave that puts its median sounding note nearest its role's target
  const bySample = new Map();
  for (const e of events) if (e.pc != null) { const list = bySample.get(e.ins) ?? []; list.push(e.note); bySample.set(e.ins, list); }
  const shift = {};
  for (const [ins, notes] of bySample) {
    notes.sort((a, b) => a - b);
    const median = notes[notes.length >> 1], [pc, role] = SAMPLES[ins];
    // written C-5 (60) sounds pitch class pc: sounding = written + pc (+ 12k)
    const k = Math.round((TARGET[role] - (median + pc)) / 12);
    shift[ins] = pc + 12 * k;
  }
  // a portamento (G) glides from the previous sounding note on its channel
  const lastMidi = new Map();
  for (const e of events) {
    e.midi = e.pc != null ? e.note + shift[e.ins] : null;
    e.glide = e.porta && e.midi != null ? lastMidi.get(e.ch) ?? null : null;
    if (e.midi != null) lastMidi.set(e.ch, e.midi);
  }
  return {events, bars, sections, end: t, shift};
}
