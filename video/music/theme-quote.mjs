// The one thing the score borrows: the opening phrase of the Deus Ex main theme (Title_Music, by Alexander Brandon), four
// bars, quoted once in the scene where the crab meets JC Denton. It is read at build time from the local installation's
// Music/Title_Music.umx (the Impulse Tracker module inside the package), so the notes are not stored in this repository
// and none of the module's audio is used.
//
// Measured 2026-11-11 on the GOTY module: the phrase is order 3 (pattern 2), the "main title" sample (number 4), first on
// channel 11 with later copies as echoes on other channels; that sample sounds a C at its written C-5 (autocorrelation of
// its looped part: 263.7 Hz, C4 +14 cents), so the written notes are the sounding pitch classes: the song is in A minor.
// Speed 6 at tempo 116 gives four rows to a beat at 116 BPM.
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const ORDER = 3, SAMPLE = 4;

/** -> {bpm, notes: [{step, steps, midi}]} (steps are sixteenths from the phrase's start), or null without the game files. */
export function themeQuote(repo) {
  const file = ['Deus Ex GOTY Edition', 'game'].map(dir => path.join(repo, dir, 'Music', 'Title_Music.umx')).find(existsSync);
  if (!file) return null;
  const raw = readFileSync(file), d = raw.subarray(raw.indexOf('IMPM'));
  const u16 = o => d.readUInt16LE(o), u32 = o => d.readUInt32LE(o);
  const orders = u16(0x20), instruments = u16(0x22), samples = u16(0x24);
  const pattern = d[0xc0 + ORDER], at = u32(0xc0 + orders + 4 * instruments + 4 * samples + 4 * pattern);
  const rows = u16(at + 2), end = at + 8 + u16(at);
  const last = Array.from({length: 64}, () => ({mask: 0, note: 0, ins: 0}));
  const byChannel = new Map();
  for (let q = at + 8, row = 0; q < end && row < rows;) {
    const cv = d[q++];
    if (!cv) { row++; continue; }
    const ch = (cv - 1) & 63, L = last[ch];
    if (cv & 128) L.mask = d[q++];
    let note = null;
    if (L.mask & 1) { L.note = d[q++]; note = L.note; }
    if (L.mask & 2) L.ins = d[q++];
    if (L.mask & 4) q++;
    if (L.mask & 8) q += 2;
    if (L.mask & 16) note = L.note;
    if (note != null && note < 120 && L.ins === SAMPLE) {
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push({step: row, note});
    }
  }
  // the line itself starts on the pattern's first row; its echoes start a few rows later
  const line = [...byChannel.values()].find(list => list[0].step === 0);
  if (!line) return null;
  const notes = line.map((e, i) => ({step: e.step, steps: (line[i + 1]?.step ?? rows) - e.step, midi: e.note + 12}));
  return {bpm: d[0x33], rowsPerBeat: 24 / d[0x32], notes};
}
