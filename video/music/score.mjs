// The video's score: an original piece in A minor at 116 BPM, written for the film's scenes (SECTIONS). Its own material:
// a four-note rising motif that grows into the crab's theme (study -> work -> finale), a lift progression (F G Am) for the
// moment the world first draws, a descending answer for the middle of the work montage. One borrowed thing: in the scene
// with JC Denton the Deus Ex main theme's opening phrase is quoted once, quietly, on a piano (theme-quote.mjs reads it
// from the local game files; the piece shares that theme's key and tempo so the quote sits in it untouched).
//
// The band is a hybrid: synthesized bass, arpeggio, pads, lead and low end (synth.mjs, buses B) with sampled instruments
// (sampler.mjs, parts P): a Salamander grand piano; strings, horns, choir, harp, celesta, vibraphone, timpani, concert
// snare and bass drum, cymbals and gong from Virtual Playing Orchestra; electric piano and drum kit from the General MIDI
// soundfont. video/music/README.md says where the libraries come from.
import * as S from './synth.mjs';

const {n, rnd, mtof} = S;

export const BPM = 116, BEAT = 60 / BPM, STEP = BEAT / 4, BAR = BEAT * 4, BARS = 76, TAIL = 6;
export const DURATION = BARS * BAR + TAIL;
export const at = (bar, step = 0) => bar * BAR + step * STEP;

export const SECTIONS = [
  {name: 'boot', bar: 0, bars: 8, scene: 'Black. A cursor blinks. The crab wakes in front of a game from the year 2000.',
    music: 'A low drone on A, the cursor as a soft blip every half note, the motif\'s four notes one to a bar on vibraphone and celesta.'},
  {name: 'study', bar: 8, bars: 16, scene: 'Reading the original: packages, bytecode, disassembly. Things start to make sense.',
    music: 'A harp and synth arpeggio and data ticks fade in over Am9, Fmaj7, Dm9, E on electric piano. From bar 17 the motif becomes a question and an answer on piano.'},
  {name: 'light', bar: 24, bars: 8, scene: 'First light: the world draws itself around the crab.',
    music: 'The lift, F G Am: half-time drums, strings and voices, a long rising line on the horns.'},
  {name: 'work-a', bar: 32, bars: 8, scene: 'The long work, map after map.',
    music: 'Full groove. The crab\'s theme on synth lead and piano over Am, C, G, D.'},
  {name: 'work-b', bar: 40, bars: 8, scene: 'Nights, oracles, the Rust core, frame times falling.',
    music: 'The answer phrase on strings over F, G, Em, Am with a syncopated bass, then a two-bar build on E.'},
  {name: 'work-c', bar: 48, bars: 8, scene: 'Everything running at once. Then: cut.',
    music: 'The theme again with strings, piano and celesta on it and voices under it. A tom fill, and everything stops.'},
  {name: 'denton', bar: 56, bars: 8, scene: 'The dock at night. The crab meets JC Denton.',
    music: 'One hit, then space. The crab\'s motif alone on electric piano (bar 58); the Deus Ex theme\'s opening phrase answers on piano (bars 59 to 62); a roll into the finale.'},
  {name: 'finale', bar: 64, bars: 8, scene: 'Together.',
    music: 'The theme in its last form, natural minor: lead, strings and horns in octaves, voices, full kit, climbing to its top note.'},
  {name: 'outro', bar: 72, bars: 4, scene: 'The last chord rings. The cursor blinks.',
    music: 'Am9 held and closing, the motif once more as it began, four cursor blips.'},
];

/** The synthesized buses. */
export const BUSES = ['drone', 'pad', 'bell', 'arp', 'lead', 'bass', 'kick', 'snare', 'fx', 'blip'];
/**
 * The sampled parts. sfz: an instrument under video/samples/ (tuned: run it through retune.mjs first; advance: start its
 * notes that much early, for a slow attack). program: a General MIDI program of the soundfont (drums: the kit).
 */
const VPO = 'vpo/Virtual-Playing-Orchestra3/', SALAMANDER = 'salamander/SalamanderGrandPianoV3_44.1khz16bit/SalamanderGrandPianoV3.sfz';
export const PARTS = {
  piano: {sfz: SALAMANDER, advance: 0.012}, pianoDbl: {sfz: SALAMANDER, advance: 0.012}, rhodes: {program: 4},
  celesta: {sfz: VPO + 'Keys/celesta.sfz', advance: 0.01}, celestaDbl: {sfz: VPO + 'Keys/celesta.sfz', advance: 0.01},
  vibes: {sfz: VPO + 'Percussion/vibraphone-auto-damp.sfz', tuned: true, advance: 0.01}, harp: {sfz: VPO + 'Strings/harp-sustain.sfz'},
  strings: {sfz: VPO + 'Strings/all-strings-SEC-accent.sfz', tuned: true, advance: 0.04},           // lines: an accented sustain
  slowstr: {sfz: VPO + 'Strings/all-strings-SEC-sustain.sfz', tuned: true, advance: 0.22},          // held chords: a slow bow
  horns: {sfz: VPO + 'Brass/french-horn-SEC-accent.sfz', tuned: true, advance: 0.03},
  voices: {sfz: VPO + 'Vocals/choir-MIXED-sustain.sfz', tuned: true, advance: 0.15},
  timpani: {sfz: VPO + 'Percussion/timpani-hit.sfz', tuned: {harmonics: [1]}, advance: 0.012},
  timpRoll: {sfz: VPO + 'Percussion/timpani-roll.sfz', tuned: {harmonics: [1]}},
  orchSnare: {sfz: VPO + 'Percussion/snare.sfz'}, orchBass: {sfz: VPO + 'Percussion/bassdrum.sfz'}, cymbals: {sfz: VPO + 'Percussion/cymbals.sfz'},
  orchMisc: {sfz: VPO + 'Percussion/misc.sfz'},
  kitKick: {program: 16, drums: true}, kitSnare: {program: 16, drums: true}, kitHats: {program: 16, drums: true}, kitCym: {program: 16, drums: true},
  kitToms: {program: 16, drums: true}, kitShake: {program: 0, drums: true},
};
// General MIDI drum keys (the kit)
const KICK = 36, STICK = 37, SNARE = 38, HAT = 42, OPEN_HAT = 46, CRASH = 49, CRASH2 = 57, MARACAS = 70, TOMS = [50, 48, 47, 45, 43, 41];
// Virtual Playing Orchestra's percussion keys, as measured: the snare key that alternates hands, the second bass drum, the
// clashed cymbals, two suspended-cymbal crescendos with the seconds each takes to reach its peak, the gong, the bar chimes
const ROLL_HIT = 49, BASS_DRUM = 38, PIATTI = 61, CYM_SWELL = {short: [65, 1.15], long: [67, 3.56]}, GONG = 46, CHIMES = 90;

// ------------------------------------------------------------------------------------------------------- harmony
// bass note, pad voicing (close, around middle C, moving by step between chords), arpeggio tones
const CH = {
  Asus2: {bass: 'A1', pad: ['A3', 'B3', 'E4'], arp: ['A4', 'B4', 'E5', 'A5']},
  Am9:   {bass: 'A1', pad: ['A3', 'C4', 'E4', 'B4'], arp: ['A4', 'C5', 'E5', 'B5']},
  Fmaj7: {bass: 'F1', pad: ['F3', 'A3', 'C4', 'E4'], arp: ['F4', 'A4', 'C5', 'E5']},
  Dm9:   {bass: 'D2', pad: ['F3', 'A3', 'C4', 'E4'], arp: ['A4', 'C5', 'E5', 'F5']},
  Esus4: {bass: 'E2', pad: ['E3', 'A3', 'B3', 'E4'], arp: ['E4', 'A4', 'B4', 'E5']},
  E:     {bass: 'E2', pad: ['E3', 'G#3', 'B3', 'E4'], arp: ['E4', 'G#4', 'B4', 'E5']},
  F:     {bass: 'F1', pad: ['F3', 'A3', 'C4', 'F4'], arp: ['F4', 'A4', 'C5', 'F5']},
  G:     {bass: 'G1', pad: ['G3', 'B3', 'D4', 'G4'], arp: ['G4', 'B4', 'D5', 'G5']},
  Am:    {bass: 'A1', pad: ['A3', 'C4', 'E4', 'A4'], arp: ['A4', 'C5', 'E5', 'A5']},
  AmC:   {bass: 'C2', pad: ['C4', 'E4', 'A4'], arp: ['E4', 'A4', 'C5', 'E5']},
  C:     {bass: 'C2', pad: ['G3', 'C4', 'E4', 'G4'], arp: ['G4', 'C5', 'E5', 'G5']},
  D:     {bass: 'D2', pad: ['F#3', 'A3', 'D4', 'F#4'], arp: ['F#4', 'A4', 'D5', 'F#5']},
  Em:    {bass: 'E2', pad: ['E3', 'G3', 'B3', 'E4'], arp: ['E4', 'G4', 'B4', 'E5']},
  G6:    {bass: 'G1', pad: ['G3', 'B3', 'D4', 'E4'], arp: ['G4', 'B4', 'D5', 'E5']},
};
const HARMONY = [];
const prog = (start, names) => names.forEach((x, i) => { HARMONY[start + i] = typeof x === 'string' ? [[x, 16]] : x; });
prog(0, Array(8).fill('Asus2'));
for (let k = 0; k < 4; k++) prog(8 + 4 * k, ['Am9', 'Fmaj7', 'Dm9', [['Esus4', 8], ['E', 8]]]);   // study: i  VI  iv  V
prog(24, ['F', 'G', 'Am', 'AmC', 'F', 'G', 'Esus4', 'E']);                                       // light: the lift
prog(32, ['Am', 'C', 'G', 'D', 'Am', 'C', 'G', 'D']);                                            // work: Dorian, the raised sixth
prog(40, ['F', 'G', 'Em', 'Am', 'F', 'G', 'E', 'E']);
prog(48, ['Am', 'C', 'G', 'D', 'Am', 'C', 'G', 'D']);
prog(56, ['Am9', 'Am9', 'Fmaj7', 'G6', 'Dm9', 'E', 'Esus4', 'E']);                               // denton: the quote over F G | Dm E
prog(64, ['Am', 'F', 'C', 'G', 'Am', 'F', 'G', 'E']);                                            // finale: the same theme, natural minor
prog(72, ['Am9', 'Am9', 'Am9', 'Am9']);
const chordAt = (bar, step) => { let s = 0; for (const [name, steps] of HARMONY[bar]) { if (step < s + steps) return CH[name]; s += steps; } return CH[HARMONY[bar].at(-1)[0]]; };

// ---------------------------------------------------------------------------------------------------- the melodies
// [note or null, sixteenths], bar by bar. The crab's motif: three steps up into a held note, off the beat.
const THEME_A = [
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]],                            // Am
  [[null, 2], ['E5', 2], ['D5', 2], ['E5', 2], ['G5', 8]],                            // C
  [[null, 2], ['G5', 2], ['A5', 2], ['B5', 2], ['A5', 4], ['G5', 2], ['D5', 2]],      // G
  [['F#5', 6], ['E5', 2], ['D5', 4], ['E5', 4]],                                      // D
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 6], ['A5', 2]],                 // Am
  [['G5', 8], [null, 2], ['E5', 2], ['G5', 2], ['A5', 2]],                            // C
  [['B5', 6], ['A5', 2], ['G5', 4], ['D5', 4]],                                       // G
  [['F#5', 4], ['G5', 2], ['A5', 10]],                                                // D
].flat();
const THEME_B = [
  [['C6', 6], ['A5', 2], ['F5', 4], ['A5', 4]],                                       // F
  [['B5', 6], ['G5', 2], ['D5', 4], ['G5', 4]],                                       // G
  [['G5', 6], ['E5', 2], ['B4', 4], ['E5', 4]],                                       // Em
  [['A5', 10], ['E5', 2], ['A5', 2], ['B5', 2]],                                      // Am
  [['C6', 6], ['A5', 2], ['F5', 4], ['C6', 4]],                                       // F
  [['D6', 6], ['B5', 2], ['G5', 4], ['D6', 4]],                                       // G
  [['E6', 24], [null, 8]],                                                            // E E
].flat();
const THEME_F = [
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]],                            // Am
  [[null, 2], ['E5', 2], ['F5', 2], ['G5', 2], ['A5', 8]],                            // F
  [[null, 2], ['G5', 2], ['A5', 2], ['B5', 2], ['C6', 4], ['B5', 2], ['G5', 2]],      // C
  [['B5', 6], ['A5', 2], ['G5', 4], ['D5', 4]],                                       // G
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 6], ['A5', 2]],                 // Am
  [['A5', 6], ['G5', 2], ['F5', 4], ['C6', 4]],                                       // F
  [['B5', 6], ['C6', 2], ['D6', 8]],                                                  // G
  [['E6', 8], ['D6', 2], ['C6', 2], ['B5', 4]],                                       // E
].flat();
// study: the motif as a question, a falling answer, and the last answer climbing into the lift
const STUDY = [
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]],
  [[null, 2], ['E5', 2], ['D5', 2], ['C5', 2], ['A4', 8]],
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]],
  [[null, 2], ['E5', 2], ['D5', 2], ['C5', 2], ['B4', 8]],
  [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]],
  [[null, 2], ['E5', 2], ['D5', 2], ['C5', 2], ['A4', 8]],
  [[null, 2], ['A4', 2], ['C5', 2], ['E5', 2], ['A5', 8]],
  [[null, 2], ['B4', 2], ['C5', 2], ['D5', 2], ['E5', 8]],
].flat();
const LIGHT = [['A4', 12], ['C5', 4], ['B4', 12], ['D5', 4], ['E5', 16], ['E5', 8], ['D5', 4], ['C5', 4],
  ['A4', 12], ['C5', 4], ['B4', 12], ['D5', 4], ['E5', 24], [null, 8]];
const HEAD = [[null, 2], ['A4', 2], ['B4', 2], ['C5', 2], ['E5', 8]];

// arpeggio shapes: indices into a chord's four tones, 4 and up an octave higher
const ARP_WAVE = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 4, 3, 2, 1];
const ARP_CLIMB = [0, 2, 4, 2, 1, 3, 5, 3, 2, 4, 6, 4, 3, 2, 1, 0];

/** Plays the whole piece: synth voices into the buses B, sampled notes into the parts P; returns the cue times the picture can use. */
export function compose(B, P, quote) {
  S.seed(0xc0ffee);
  const cues = {kick: [], snare: [], crash: [], impact: [], cursor: [], theme: [], quote: [], duck: []};
  const jitter = (amount = 0.003) => (rnd() - 0.5) * 2 * amount;
  const hv = (v, spread = 0.05) => Math.max(0.05, Math.min(1, v + (rnd() - 0.5) * 2 * spread));     // a played velocity: never twice the same

  // ---- building blocks
  function segments(bar0, bar1) {                       // runs of one chord, merged across bar lines
    const out = [];
    for (let b = bar0; b < bar1; b++) {
      let s = 0;
      for (const [name, steps] of HARMONY[b]) {
        const last = out.at(-1), t = at(b, s);
        if (last && last.name === name && Math.abs(last.t + last.dur - t) < 1e-6) last.dur += steps * STEP;
        else out.push({name, t, dur: steps * STEP, bar: b});
        s += steps;
      }
    }
    return out;
  }
  function pads(bar0, bar1, params) {
    for (const seg of segments(bar0, bar1)) {
      const p = params(seg.bar), notes = CH[seg.name].pad;
      for (const [k, name] of notes.entries())
        S.pad(B.pad, {t: seg.t, dur: seg.dur - 0.03, midi: n(name), ...p, gain: p.gain / Math.sqrt(notes.length), pan: (k / (notes.length - 1) - 0.5) * 0.4});
    }
  }
  // held chords on a sampled part: params(bar) -> {vel, top: only that many upper notes of the voicing, low: add the root
  // under it, cut: seconds taken off the end, so the section's long release has faded when the next chord speaks}
  function chords(part, bar0, bar1, params) {
    for (const seg of segments(bar0, bar1)) {
      const p = params(seg.bar), ch = CH[seg.name], dur = seg.dur - (p.cut ?? 0.3);
      for (const name of p.top ? ch.pad.slice(-p.top) : ch.pad) part.note(seg.t, dur, n(name), p.vel);
      if (p.low) part.note(seg.t, dur, n(ch.bass) + 12, p.vel);
    }
  }
  function arp(bar, {shape = ARP_WAVE, gain = 1, bright = 0.5, octave = 0, harp = 0}) {
    for (let s = 0; s < 16; s++) {
      const tones = chordAt(bar, s).arp, k = shape[s], midi = n(tones[k % 4]) + 12 * (Math.floor(k / 4) + octave), t = at(bar, s);
      S.pluck(B.arp, {t: t + jitter(0.0015), dur: STEP * 0.9, midi, gain: gain * (s % 4 === 0 ? 1 : 0.72), vel: 0.8 + 0.2 * rnd(), pan: s % 2 ? 0.55 : -0.55,
        cutoff: 380 + 1500 * bright, env: 900 + 3600 * bright, envDecay: 0.05 + 0.05 * bright, decay: 0.12 + 0.1 * bright});
      if (harp) P.harp.note(t + jitter(0.004), STEP * 3, midi, hv(harp * (s % 4 === 0 ? 1 : 0.82)));
    }
  }
  function melody(bar0, notes, voice) {
    let s = 0, prev = null, prevEnd = -1;
    for (const [name, steps] of notes) {
      if (name) {
        const midi = n(name);
        voice({t: at(bar0, s), dur: steps * STEP, midi, from: prevEnd === s && prev !== midi ? prev : null, steps});
        prev = midi; prevEnd = s + steps;
      }
      s += steps;
    }
  }
  const themeCue = (part, o) => cues.theme.push({part, t: +o.t.toFixed(4), dur: +o.dur.toFixed(4), midi: o.midi});
  // the kit: sampled kick, snare and hats; the synthesized kick and snare sit under them for weight
  function drums(bar, {k = '', s = '', h = '', sh = '', kg = 1, sg = 1, hg = 1, pump = true}) {
    for (let i = 0; i < 16; i++) {
      const t = at(bar, i);
      if (k[i] === 'X' || k[i] === 'x') {
        const g = (k[i] === 'X' ? 1 : 0.78) * kg;
        S.kick(B.kick, {t, gain: g});
        P.kitKick.note(t, 0.2, KICK, hv(0.95 * g, 0.03));
        cues.kick.push(+t.toFixed(4));
        if (pump) cues.duck.push(t);
      }
      if (s[i] === 'X' || s[i] === 'x') {
        const g = (s[i] === 'X' ? 1 : 0.76) * sg;
        P.kitSnare.note(t, 0.3, SNARE, hv(0.95 * g, 0.03));
        S.snare(B.snare, {t, gain: g});
        cues.snare.push(+t.toFixed(4));
      } else if (s[i] === 'g') P.kitSnare.note(t + jitter(0.004), 0.1, SNARE, hv(0.36 * sg, 0.07));
      else if (s[i] === 'r') P.kitSnare.note(t, 0.1, STICK, hv(0.62 * sg));
      if (h[i] === 'X' || h[i] === 'x' || h[i] === '-') P.kitHats.note(t + jitter(), 0.08, HAT, hv((h[i] === 'X' ? 0.86 : h[i] === 'x' ? 0.66 : 0.44) * hg));
      else if (h[i] === 'o') P.kitHats.note(t, STEP * 1.8, OPEN_HAT, hv(0.76 * hg, 0.03));
      if (sh[i] === 'x' || sh[i] === 'X') P.kitShake.note(t + jitter(), 0.1, MARACAS, hv((sh[i] === 'X' ? 0.8 : 0.55) * hg));
    }
  }
  function roll(t0, t1, g0, g1, {fast = t0 + (t1 - t0) * 0.5} = {}) {     // concert snare roll, hand to hand: sixteenths, then thirty-seconds
    for (let t = t0; t < t1 - 1e-6; t += t < fast ? STEP : STEP / 2) {
      const p = (t - t0) / (t1 - t0);
      P.orchSnare.note(t + jitter(0.002), 0.3, ROLL_HIT, hv(Math.sqrt(g0 + (g1 - g0) * p * p), 0.04));
    }
  }
  const timp = (t, midi, vel = 0.7) => P.timpani.note(t, 2.5, midi, vel);
  // a suspended cymbal that swells to its peak exactly at t and rings on
  const cymSwell = (t, size = 'short', vel = 0.7) => { const [key, rise] = CYM_SWELL[size]; P.cymbals.note(t - rise, rise + 2.5, key, vel); };
  function tomFill(bar, from = 8, vel = 0.8) {
    for (let i = from; i < 16; i++) {
      const p = (i - from) / (16 - from);
      P.kitToms.note(at(bar, i), 0.3, TOMS[Math.min(5, Math.floor(p * 6))], hv(vel * (0.78 + 0.22 * p), 0.03));
    }
  }
  function impact(t, {gain = 1, drum = null, length = 3, gong = 0} = {}) {   // sub boom, concert bass drum, clashed cymbals, a kit crash; timpani, gong
    S.boom(B.fx, {t, gain: 0.8 * gain, length});
    P.orchBass.note(t, 2, BASS_DRUM, Math.min(1, 0.95 * gain));
    P.cymbals.note(t, 5, PIATTI, Math.min(1, 0.85 * gain));
    P.kitCym.note(t, 3, CRASH, Math.min(1, 0.8 * gain));
    if (drum) timp(t, n(drum), Math.min(1, 0.9 * gain));
    if (gong) P.orchMisc.note(t, 9, GONG, gong);
    cues.impact.push(+t.toFixed(4)); cues.crash.push(+t.toFixed(4));
  }
  const crashAt = (t, vel = 0.8) => { P.kitCym.note(t, 3, CRASH, vel); cues.crash.push(+t.toFixed(4)); };
  const cursor = (t, gain = 1) => { S.blip(B.blip, {t, freq: mtof(n('E6')), gain: 0.5 * gain, dur: 0.09}); cues.cursor.push(+t.toFixed(4)); };
  // the bell colour: vibraphone at pitch, celesta an octave above, a little FM glass for shimmer
  const bell = (t, midi, vel, {dur = BAR, glass = 0.6, pan = 0} = {}) => {
    P.vibes.note(t, dur, midi, hv(vel * 0.9, 0.02));
    P.celesta.note(t, dur, midi + 12, hv(vel, 0.02));
    if (glass) S.glass(B.bell, {t, midi, vel: vel * glass, decay: 2.2, pan});
  };
  const rhodesChord = (t, name, {vel = 0.6, dur = BAR * 0.9} = {}) => CH[name].pad.forEach((note, k) => P.rhodes.note(t + k * 0.012, dur, n(note), hv(vel * (k === 0 ? 1 : 0.92), 0.03)));
  const rootOf = bar => n(CH[HARMONY[bar][0][0]].bass);
  const bassNote = (t, steps, midi, o = {}) => S.bass(B.bass, {t, dur: steps * STEP, midi, ...o});

  // ============================================================================ boot, bars 0-7
  S.boom(B.fx, {t: at(0) + 0.04, gain: 0.45, length: 4.5, from: 70, to: 34});
  S.sine(B.drone, {t: at(0), dur: at(8), midi: n('A1'), gain: 0.5, attack: 5, release: 2.5});
  for (const name of ['A2', 'E3']) S.pad(B.pad, {t: at(0), dur: at(8) - 0.3, midi: n(name), gain: 0.2, voices: 5, detune: 10, attack: 6, release: 2.2, cutoff: 240, cutoff2: 850});
  for (const name of ['A3', 'B3', 'E4']) S.pad(B.pad, {t: at(4), dur: at(8) - at(4) - 0.3, midi: n(name), gain: 0.14, attack: 4, release: 2.2, cutoff: 420, cutoff2: 1300});
  for (let b = 1; b < 8; b++) for (const s of [0, 8]) cursor(at(b, s), 0.8);
  // the motif's four notes, one to a bar, before it has a rhythm
  [[2, 'A4'], [3, 'B4'], [4, 'C5'], [5, 'E5']].forEach(([b, name], k) => bell(at(b), n(name), 0.5 + 0.05 * k, {dur: BAR * 1.5, pan: -0.2 + 0.13 * k}));
  bell(at(6, 8), n('A5'), 0.42, {dur: BAR * 1.5, pan: 0.3});
  cymSwell(at(8), 'short', 0.42);

  // ============================================================================ study, bars 8-23
  pads(8, 24, b => ({gain: 0.42 + 0.012 * (b - 8), cutoff: 620 + 62 * (b - 8), attack: 0.7, release: 1.1, voices: 7}));
  chords(P.slowstr, 16, 24, b => ({vel: 0.5 + 0.03 * (b - 16), low: true}));
  for (let b = 8; b < 24; b++) {
    const u = (b - 8) / 15, root = rootOf(b);
    if (b < 16) bassNote(at(b), 15.5, root, {gain: 0.42, cutoff: 110, env: 240, envDecay: 0.3, sustain: 0.92, attack: 0.03, release: 0.12, drive: 1});
    else { bassNote(at(b), 9.6, root, {gain: 0.55, cutoff: 150, env: 420, envDecay: 0.2, sustain: 0.85}); bassNote(at(b, 10), 5.6, root, {gain: 0.48, cutoff: 150, env: 420, envDecay: 0.2, sustain: 0.85}); }
    arp(b, {shape: ARP_WAVE, gain: 0.3 + 0.7 * u, bright: 0.12 + 0.55 * u, harp: 0.42 + 0.25 * u});
    for (let s = 0; s < 16; s++) if (rnd() < 0.2)       // data ticks
      S.blip(B.blip, {t: at(b, s), freq: mtof(n(['A6', 'C7', 'D7', 'E7', 'G7', 'A7'][Math.floor(rnd() * 6)])), gain: 0.22 * (0.4 + rnd()), dur: 0.03, pan: rnd() * 1.6 - 0.8});
    if (b < 16) rhodesChord(at(b), HARMONY[b][0][0], {vel: 0.56 + 0.02 * (b - 8)});
    else { rhodesChord(at(b), HARMONY[b][0][0], {vel: 0.56, dur: STEP * 9}); if (HARMONY[b].length > 1) rhodesChord(at(b, 8), HARMONY[b][1][0], {vel: 0.5, dur: STEP * 7}); }
    if (b >= 12 && b < 16) drums(b, {k: 'x.......x.......', kg: 0.5, pump: false});
    if (b >= 16 && b < 20) drums(b, {k: 'x.......x.x.....', s: '....r.......r...', h: 'x.x.x.x.x.x.x.x.', kg: 0.62, sg: 0.9, hg: 0.72, pump: false});
    if (b >= 20) drums(b, {k: 'x.......x.x.....', s: '....r.......r..g', h: 'x-x-x-x-x-x-x-x-', kg: 0.7, hg: 0.8, pump: false});
  }
  melody(16, STUDY, o => {
    P.piano.note(o.t, o.dur + 0.5, o.midi, hv(o.steps > 2 ? 0.76 : 0.68, 0.04));        // held a little over the next note, as under a pedal
    if (o.t >= at(20) - 1e-6) { P.celesta.note(o.t, o.dur, o.midi + 12, hv(0.42)); P.vibes.note(o.t, o.dur, o.midi, hv(0.42)); }
    themeCue('piano', o);
  });
  S.riser(B.fx, {t0: at(22), t1: at(24), gain: 0.14});
  cymSwell(at(24), 'long', 0.75);
  roll(at(23, 8), at(24), 0.1, 0.5);

  // ============================================================================ light, bars 24-31
  impact(at(24), {drum: 'F2', gain: 0.9});
  P.orchMisc.note(at(24) + 0.1, 6, CHIMES, 0.62);                          // bar chimes as the world appears
  crashAt(at(28), 0.75);
  pads(24, 32, b => ({gain: 0.8, cutoff: 1500 + 220 * (b - 24), attack: 0.35, release: 1.0, voices: 7, sub: 0.15}));
  chords(P.slowstr, 24, 32, b => ({vel: 0.66 + 0.03 * (b - 24), low: true}));
  chords(P.voices, 24, 32, b => ({vel: 0.6 + 0.04 * (b - 24), top: 3}));
  for (let b = 24; b < 32; b++) {
    const root = rootOf(b);
    bassNote(at(b), 13.5, root, {gain: 0.75, cutoff: 170, env: 520, envDecay: 0.35, sustain: 0.9, attack: 0.01});
    bassNote(at(b, 14), 1.7, root + 12, {gain: 0.7, cutoff: 200, env: 700});
    arp(b, {shape: ARP_CLIMB, gain: 0.95, bright: 0.75, harp: 0.5});
    if (b < 31) drums(b, {k: 'X.........x.....', s: '........X.......', h: 'x.x.x.x.x.x.x.x.', hg: 0.9});
    else drums(b, {k: 'X.......', h: 'x.x.x.x.', hg: 0.9});
    if (b % 2 === 0 && b > 24) timp(at(b), n({26: 'A2', 28: 'F2', 30: 'E2'}[b]), 0.72);
  }
  tomFill(27, 12, 0.72);
  melody(24, LIGHT, o => {
    P.horns.note(o.t, o.dur - 0.02, o.midi, 0.8);
    P.strings.note(o.t, o.dur - 0.02, o.midi + 12, 0.62);
    P.celesta.note(o.t, o.dur, o.midi + 12, hv(0.5));
    S.lead(B.lead, {t: o.t, dur: o.dur - 0.03, midi: o.midi, from: o.from, gain: 0.5, cutoff: 1400, env: 600, envDecay: 0.5, attack: 0.07, release: 0.25, vib: 9});
    themeCue('horns', o);
  });
  S.riser(B.fx, {t0: at(30), t1: at(32), gain: 0.18});
  cymSwell(at(32), 'short', 0.8);
  roll(at(31, 8), at(32), 0.15, 0.75);

  // ============================================================================ the work, bars 32-55
  const eighths = (b, {gain = 1, busy = false} = {}) => {
    const root = rootOf(b), line = busy ? [[0, 0], [2, 0], [4, 0], [6, 12], [7, 12], [8, 0], [10, 0], [12, 0], [14, 12], [15, 7]] : [[0, 0], [2, 0], [4, 0], [6, 12], [8, 0], [10, 0], [12, 0], [14, 12]];
    for (const [s, up] of line)
      bassNote(at(b, s), busy && [6, 7, 14, 15].includes(s) ? 0.85 : 1.6, root + up, {gain: gain * (s % 8 === 0 ? 1 : 0.86), cutoff: 235, env: s % 8 === 0 ? 1300 : 950, envDecay: 0.1, drive: 1.7, sub: 0.75});
  };
  // --- a: the theme in full, synth lead with a piano an octave above it
  impact(at(32), {gain: 0.8, length: 2.2, drum: 'A2'});
  crashAt(at(36), 0.72);
  pads(32, 40, () => ({gain: 0.72, cutoff: 2000, attack: 0.06, release: 0.45, voices: 7}));
  for (let b = 32; b < 40; b++) {
    eighths(b);
    arp(b, {shape: ARP_CLIMB, gain: 0.9, bright: 0.85});
    drums(b, b % 2 === 0 ? {k: 'X.....x...x.....', s: '....X..g....X..g', h: 'X.x.X.x.X.x.X.o.'} : {k: 'X..x..x...x.....', s: '....X..g.g..X...', h: 'X.x.X.x.X.x.X.o.'});
  }
  roll(at(39, 12), at(40), 0.3, 0.7, {fast: at(39, 14)});
  melody(32, THEME_A, o => {
    S.lead(B.lead, {t: o.t, dur: o.dur - 0.025, midi: o.midi, from: o.from, gain: 1, cutoff: 2500, env: 1700});
    P.pianoDbl.note(o.t, o.dur + 0.1, o.midi + 12, hv(0.68, 0.04));
    themeCue('lead', o);
  });
  // --- b: the answer on the strings, then the build
  crashAt(at(40), 0.72);
  pads(40, 48, b => ({gain: 0.7, cutoff: b < 46 ? 1700 : 1700 + 700 * (b - 45), attack: 0.06, release: 0.45, voices: 7}));
  chords(P.voices, 40, 48, b => ({vel: b < 46 ? 0.6 : 0.66 + 0.14 * (b - 46), top: 3, cut: 0.4}));
  chords(P.slowstr, 46, 48, b => ({vel: 0.64 + 0.16 * (b - 46), low: true}));
  for (let b = 40; b < 48; b++) {
    const root = rootOf(b);
    if (b < 46) {
      [[0, 2.5, 0], [3, 2.5, 0], [6, 1.7, 12], [8, 2.5, 0], [11, 2.5, 0], [14, 1.7, 12]].forEach(([s, len, up]) => bassNote(at(b, s), len, root + up, {gain: s % 8 === 0 ? 1 : 0.88, cutoff: 235, env: 1150, envDecay: 0.1, drive: 1.7, sub: 0.75}));
      drums(b, {k: 'X..x....X..x....', s: b % 2 ? '....X.......X.gg' : '....X.......X..g', h: 'X.x.X.x.X.x.X.o.', sh: 'x.x.x.x.x.x.x.x.'});
    } else if (b === 46) {
      for (let s = 0; s < 16; s += 2) bassNote(at(b, s), 1.6, root, {gain: 0.95, cutoff: 190, env: 1200 + 60 * s});
      drums(b, {k: 'X...X...X...X...', h: 'X.x.X.x.X.x.X.x.', sh: 'x.x.x.x.x.x.x.x.'});
    } else {
      for (let s = 0; s < 16; s++) bassNote(at(b, s), 0.8, root + (s % 2 ? 12 : 0), {gain: 0.8 + 0.012 * s, cutoff: 200 + 25 * s, env: 1400 + 90 * s});
      drums(b, {k: 'X.X.X.X.........', h: 'X.x.X.x.'});
    }
    arp(b, {shape: ARP_WAVE, gain: 0.85, bright: b < 46 ? 0.7 : 0.9, octave: 1});
  }
  melody(40, THEME_B, o => {
    P.strings.note(o.t, o.dur - 0.02, o.midi, 0.84);
    P.strings.note(o.t, o.dur - 0.02, o.midi - 12, 0.72);
    S.lead(B.lead, {t: o.t, dur: o.dur - 0.025, midi: o.midi, from: o.from, gain: 0.6, cutoff: 2000, env: 1200});
    themeCue('strings', o);
  });
  roll(at(47), at(48), 0.12, 0.85, {fast: at(47, 8)});
  S.riser(B.fx, {t0: at(46), t1: at(48), gain: 0.2});
  cymSwell(at(48), 'long', 0.85);
  // --- c: the theme again: lead, strings, piano and celesta on it, voices and strings under it
  impact(at(48), {gain: 0.9, length: 2.4, drum: 'A2'});
  crashAt(at(52), 0.8);
  pads(48, 56, () => ({gain: 0.8, cutoff: 2700, attack: 0.05, release: 0.45, voices: 7}));
  chords(P.voices, 48, 56, () => ({vel: 0.74, top: 3, cut: 0.4}));
  chords(P.slowstr, 48, 56, () => ({vel: 0.68, low: true, cut: 0.45}));
  for (let b = 48; b < 56; b++) {
    eighths(b, {busy: true});
    arp(b, {shape: ARP_CLIMB, gain: 0.95, bright: 1, octave: 1});
    drums(b, b % 2 === 0 ? {k: 'X..x..x...x..x..', s: '....X..g.g..X..g', h: 'X-x-X-o-X-x-X-o-'} : {k: 'X.....x...x.x...', s: '....X..g....X.gg', h: 'X-x-X-o-X-x-X-o-'});
  }
  melody(48, THEME_A, o => {
    S.lead(B.lead, {t: o.t, dur: o.dur - 0.025, midi: o.midi, from: o.from, gain: 1.05, cutoff: 3000, env: 2000});
    P.strings.note(o.t, o.dur - 0.02, o.midi, 0.76);
    P.pianoDbl.note(o.t, o.dur + 0.1, o.midi + 12, hv(0.74, 0.04));
    P.celestaDbl.note(o.t, o.dur, o.midi + 12, hv(0.6));
    themeCue('lead', o);
  });
  tomFill(55, 8, 0.9);

  // ============================================================================ denton, bars 56-63
  impact(at(56), {gain: 1, drum: 'A2', length: 4.5, gong: 0.8});
  S.sine(B.drone, {t: at(56), dur: 2 * BAR, midi: n('A1'), gain: 0.5, attack: 0.3, release: 1});
  pads(56, 62, b => ({gain: 0.3, cutoff: 520 + 70 * (b - 56), attack: b < 58 ? 2.5 : 0.9, release: 1.6, voices: 7, detune: 12}));
  [[58, 'F1'], [59, 'G1'], [60, 'D2'], [61, 'E2']].forEach(([b, name]) => S.sine(B.drone, {t: at(b), dur: BAR, midi: n(name), gain: 0.46, attack: 0.25, release: 0.9}));
  cursor(at(56, 8), 0.7); cursor(at(57), 0.7); cursor(at(57, 8), 0.7);
  // the crab's motif, alone on the electric piano ...
  melody(57, HEAD, o => { P.rhodes.note(o.t, o.dur + 0.2, o.midi, hv(0.66, 0.03)); themeCue('keys', o); });
  // ... and the answer: the Deus Ex theme's opening phrase as the game's own module has it (four bars), on a soft piano
  // with a bass note under each bar and a trace of celesta and glass above
  if (quote) {
    for (const q of quote.notes) {
      const t = at(58, q.step), dur = q.steps * STEP;
      P.piano.note(t, dur + 0.7, q.midi, hv(q.steps > 2 ? 0.64 : 0.58, 0.03));
      P.celesta.note(t, dur, q.midi + 12, 0.32);
      S.glass(B.bell, {t, midi: q.midi, vel: 0.5, decay: 2.3, pan: 0.12, bright: 0.8});
      cues.quote.push({t: +t.toFixed(4), dur: +dur.toFixed(4), midi: q.midi});
    }
    [[58, 'F2'], [59, 'G2'], [60, 'D3'], [61, 'E2']].forEach(([b, name]) => P.piano.note(at(b), BAR * 0.95, n(name), 0.46));
  } else console.warn('no game files: the Deus Ex theme quote in bars 58-61 is left out');
  // the turn into the finale: two bars on the dominant
  pads(62, 64, b => ({gain: 0.45 + 0.3 * (b - 62), cutoff: b === 62 ? 800 : 1500, cutoff2: b === 62 ? 1500 : 3000, attack: 0.5, release: 0.5, voices: 7}));
  chords(P.slowstr, 62, 64, b => ({vel: 0.6 + 0.27 * (b - 62), low: true}));
  chords(P.voices, 62, 64, b => ({vel: 0.55 + 0.3 * (b - 62), top: 3}));
  S.sine(B.drone, {t: at(62), dur: 2 * BAR - 0.1, midi: n('E2'), gain: 0.5, attack: 0.3, release: 0.3});
  timp(at(62), n('E2'), 0.6);
  P.timpRoll.note(at(62, 8), at(64) - at(62, 8), n('E2'), 0.9);            // a timpani roll on the dominant, growing into the finale
  P.timpRoll.gain(at(62, 8), 0.1); P.timpRoll.gain(at(63, 8), 0.45); P.timpRoll.gain(at(64), 1); P.timpRoll.gain(at(64) + 0.35, 0);
  roll(at(63), at(64), 0.1, 0.85, {fast: at(63, 8)});
  S.riser(B.fx, {t0: at(62), t1: at(64), gain: 0.2});
  cymSwell(at(64), 'long', 0.9);

  // ============================================================================ finale, bars 64-71
  impact(at(64), {gain: 1, drum: 'A2', length: 2.6});
  crashAt(at(68), 0.86);
  pads(64, 72, () => ({gain: 0.95, cutoff: 3100, attack: 0.05, release: 0.5, voices: 7, sub: 0.1}));
  chords(P.voices, 64, 72, () => ({vel: 0.88, top: 3, cut: 0.4}));
  chords(P.slowstr, 64, 72, () => ({vel: 0.8, low: true, cut: 0.45}));
  for (let b = 64; b < 72; b++) {
    eighths(b, {busy: true, gain: 1.05});
    arp(b, {shape: ARP_CLIMB, gain: 1, bright: 1, octave: 1});
    drums(b, b % 2 === 0 ? {k: 'X..x..x...x..x..', s: '....X..g....X..g', h: 'X-x-X-x-X-x-X-o-'} : {k: 'X..x..x...x.....', s: '....X..g.g..X.gg', h: 'X-x-X-o-X-x-X-o-'});
    if (b > 64) timp(at(b), rootOf(b) + 12, 0.74);
  }
  melody(64, THEME_F, o => {
    S.lead(B.lead, {t: o.t, dur: o.dur - 0.025, midi: o.midi, from: o.from, gain: 1.1, cutoff: 3300, env: 2100});
    P.strings.note(o.t, o.dur - 0.02, o.midi, 0.88);
    P.strings.note(o.t, o.dur - 0.02, o.midi - 12, 0.76);
    P.horns.note(o.t, o.dur - 0.02, o.midi - 12, 0.78);
    P.pianoDbl.note(o.t, o.dur + 0.1, o.midi + 12, hv(0.78, 0.04));
    P.celestaDbl.note(o.t, o.dur, o.midi + 12, hv(0.62));
    themeCue('lead', o);
  });
  tomFill(71, 8, 0.95);
  roll(at(71, 8), at(72), 0.3, 0.8, {fast: at(71, 12)});

  // ============================================================================ outro, bars 72-75 and the tail
  impact(at(72), {gain: 1, drum: 'A2', length: 5, gong: 0.7});
  S.sine(B.drone, {t: at(72), dur: 3.5 * BAR, midi: n('A1'), gain: 0.55, attack: 0.05, release: 4});
  for (const [k, name] of CH.Am9.pad.entries())
    S.pad(B.pad, {t: at(72), dur: 3.4 * BAR, midi: n(name), gain: 0.5, cutoff: 2600, cutoff2: 420, attack: 0.05, release: 5, voices: 7, pan: (k / 3 - 0.5) * 0.4});
  for (const name of ['A2', 'A3', 'E4', 'B4']) P.slowstr.note(at(72), 2.6 * BAR, n(name), 0.62);
  for (const name of ['A3', 'E4', 'A4']) P.voices.note(at(72), 1.8 * BAR, n(name), 0.6);
  // the motif once more, slow, as it began
  [[72, 8, 'A4'], [73, 0, 'B4'], [73, 8, 'C5'], [74, 0, 'E5']].forEach(([b, s, name], k) => {
    P.piano.note(at(b, s), BAR * 1.2, n(name), hv(0.6, 0.02));
    bell(at(b, s), n(name), 0.42 + 0.04 * k, {dur: BAR * 1.5, pan: 0.2});
    themeCue('piano', {t: at(b, s), dur: 8 * STEP, midi: n(name)});
  });
  for (const [b, s] of [[74, 8], [75, 0], [75, 8], [76, 0]]) cursor(at(b, s), 0.8);
  return cues;
}
