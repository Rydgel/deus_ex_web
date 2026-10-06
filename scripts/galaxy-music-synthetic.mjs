/** Synthetic Impulse Tracker modules for the Galaxy loader comparison
 * (validate-galaxy-music-loader.mjs). Each drives IT-loader branches that the
 * 35 DX songs never reach; the original glxLoadMusic (native oracle) and the
 * Rust kernel load the same bytes and must dump the same state. Field
 * offsets follow ITTECH (IMPM 0xc0 header, IMPI 0x226 bytes as read at
 * 0x10628c8a, IMPS 0x50). Authored test data only; no original content.
 *
 * sequencerModules() adds playable modules for the module player comparison
 * (validate-galaxy-music-sequencer.mjs): the effects, slide modes, envelopes
 * and order/row edge cases the songs never play. */

const u16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const u32 = (b, o, v) => { u16(b, o, v & 0xffff); u16(b, o + 2, (v >>> 16) & 0xffff); };
const text = (b, o, s, n) => { for (let i = 0; i < n && i < s.length; i++) b[o + i] = s.charCodeAt(i); };

/** One packed channel entry: cv (channel+1, 0x80 when a mask byte follows),
 * mask, then note, instrument, volume, command+value as the mask selects. */
function entry({ch, mask, note, ins, vol, cmd, val, reuse = 0, noMask = false}) {
  let m = mask ?? ((note !== undefined ? 1 : 0) | (ins !== undefined ? 2 : 0) | (vol !== undefined ? 4 : 0) |
    (cmd !== undefined ? 8 : 0) | reuse);
  const out = [noMask ? ch + 1 : (ch + 1) | 0x80];
  if (!noMask) out.push(m);
  if (noMask) m = mask; // the loader takes lastmask[ch]; the caller passes it to emit the right fields
  if (m & 1) out.push(note);
  if (m & 2) out.push(ins);
  if (m & 4) out.push(vol);
  if (m & 8) out.push(cmd, val);
  return out;
}

/** rows: array of arrays of entries. */
function pattern(rows) {
  const packed = [];
  for (const row of rows) { for (const e of row) packed.push(...entry(e)); packed.push(0); }
  const out = new Uint8Array(8 + packed.length);
  u16(out, 0, packed.length); u16(out, 2, rows.length); out.set(packed, 8);
  return out;
}

function sampleData(frames, bps, seed) {
  const out = new Uint8Array(frames * bps);
  let x = seed >>> 0;
  for (let i = 0; i < out.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

/** Build an IT file. samples: {sig, flg, vol, cvt, dfp, length, loopStart, loopEnd, c5, data, name};
 * instruments: raw 0x226 IMPI buffers (null in sample mode). */
function buildIT({name, flags = 0x09, gv = 128, speed = 6, tempo = 125, orders, ordNum, pans = [], samples = [],
  instruments = [], patterns = []}) {
  const parts = [];
  const header = new Uint8Array(0xc0);
  text(header, 0, 'IMPM', 4); text(header, 4, name, 26);
  u16(header, 0x20, ordNum ?? orders.length); u16(header, 0x22, instruments.length);
  u16(header, 0x24, samples.length); u16(header, 0x26, patterns.length);
  u16(header, 0x28, 0x217); u16(header, 0x2a, instruments.length ? 0x200 : 0x100); u16(header, 0x2c, flags);
  u16(header, 0x2e, 6); header[0x30] = gv; header[0x31] = 48; header[0x32] = speed; header[0x33] = tempo;
  header[0x34] = 128;
  for (let i = 0; i < 64; i++) { header[0x40 + i] = pans[i] ?? 32; header[0x80 + i] = 64; }
  const orderBytes = Uint8Array.from(orders);
  let offset = 0xc0 + orderBytes.length + 4 * (instruments.length + samples.length + patterns.length);
  const insOff = instruments.map(i => { const o = offset; offset += i.length; return o; });
  const smpOff = samples.map(() => { const o = offset; offset += 0x50; return o; });
  const patOff = patterns.map(p => { if (!p) return 0; const o = offset; offset += p.length; return o; });
  const dataOff = samples.map(s => { const o = offset; offset += s.data?.length ?? 0; return o; });
  const tables = new Uint8Array(4 * (instruments.length + samples.length + patterns.length));
  [...insOff, ...smpOff, ...patOff].forEach((o, i) => u32(tables, 4 * i, o));
  parts.push(header, orderBytes, tables, ...instruments);
  samples.forEach((s, i) => {
    const h = new Uint8Array(0x50);
    text(h, 0, s.sig ?? 'IMPS', 4); text(h, 4, `smp${i}.raw`, 12); h[0x11] = 64; h[0x12] = s.flg; h[0x13] = s.vol ?? 64;
    text(h, 0x14, s.name ?? `Synthetic sample ${i} name text`, 26); h[0x2e] = s.cvt ?? 1; h[0x2f] = s.dfp ?? 32;
    u32(h, 0x30, s.length); u32(h, 0x34, s.loopStart ?? 0); u32(h, 0x38, s.loopEnd ?? 0); u32(h, 0x3c, s.c5 ?? 8363);
    u32(h, 0x40, s.susStart ?? 0); u32(h, 0x44, s.susEnd ?? 0); u32(h, 0x48, dataOff[i]);
    h[0x4c] = s.vib ?? 0; h[0x4d] = s.vib ?? 0;
    parts.push(h);
  });
  parts.push(...patterns.filter(Boolean), ...samples.map(s => s.data ?? new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  if (at !== offset) throw new Error('synthetic IT layout mismatch');
  return out;
}

function impi({name, sig = 'IMPI', fade = 0, keys, vol, pan, pitch}) {
  const b = new Uint8Array(0x226);
  text(b, 0, sig, 4); text(b, 4, 'inst.iti', 12); u16(b, 0x14, fade); b[0x18] = 128; b[0x19] = 0xa0;
  u16(b, 0x1c, 0x217); b[0x1e] = 99; text(b, 0x20, name, 26);
  for (let k = 0; k < 120; k++) { b[0x40 + 2 * k] = (k * 7) % 120; b[0x41 + 2 * k] = keys(k); }
  for (const [at, env] of [[0x130, vol], [0x182, pan], [0x1d4, pitch]]) {
    b[at] = env.flags; b[at + 1] = env.nodes.length; b[at + 2] = env.lpb ?? 0; b[at + 3] = env.lpe ?? 0;
    b[at + 4] = env.slb ?? 0; b[at + 5] = env.sle ?? 0;
    env.nodes.forEach(([y, tick], j) => { b[at + 6 + 3 * j] = y & 0xff; u16(b, at + 7 + 3 * j, tick); });
  }
  return b;
}

const EFFECTS = (() => {
  const c = l => l.charCodeAt(0) - 64; // IT command letters A=1..Z=26
  const rows = [];
  const fx = (cmd, val, more = {}) => rows.push([{ch: 0, cmd, val, ...more}]);
  fx(c('A'), 0x00); fx(c('A'), 0x40); fx(c('A'), 0x00); fx(c('A'), 0x20);
  fx(c('H'), 0x44); fx(c('D'), 0x00); fx(c('D'), 0x3f); fx(c('D'), 0xf3); fx(c('D'), 0xff); fx(c('D'), 0x0f);
  fx(c('D'), 0x30); fx(c('D'), 0xf0); fx(c('D'), 0x00);
  fx(c('E'), 0x10); fx(c('E'), 0xf5); fx(c('E'), 0xe7); fx(c('E'), 0xe0); fx(c('E'), 0x00);
  fx(c('F'), 0x10); fx(c('F'), 0xf5); fx(c('F'), 0xef); fx(c('F'), 0xe1); fx(c('F'), 0x00);
  fx(c('G'), 0x00); fx(c('A'), 0x00); fx(c('G'), 0x21);
  fx(c('J'), 0x37); fx(c('J'), 0x00); fx(c('K'), 0x00); fx(c('K'), 0x05); fx(c('K'), 0x00); fx(c('L'), 0x00);
  fx(c('L'), 0x03); fx(c('M'), 0x40); fx(c('N'), 0x12); fx(c('P'), 0x34); fx(c('I'), 0x11); fx(c('U'), 0x22);
  fx(c('V'), 0x33); fx(c('W'), 0x44); fx(c('O'), 0x10); fx(c('Q'), 0x37); fx(c('R'), 0x12); fx(c('B'), 0x02);
  fx(c('C'), 0x10);
  for (let s = 0; s < 16; s++) fx(c('S'), (s << 4) | 5);
  fx(c('S'), 0x90); fx(c('S'), 0x00);
  fx(c('T'), 0x10); fx(c('T'), 0x80); fx(c('T'), 0x20); fx(c('T'), 0x1f); fx(c('X'), 0x40); fx(c('Y'), 0x12);
  fx(c('Z'), 0x50); fx(0, 0x05); fx(27, 0x33); fx(0xff, 0x01);
  // Notes, volumes, masks and channels.
  const r = e => rows.push(e);
  r([{ch: 1, note: 0, ins: 1}, {ch: 2, note: 0x77, ins: 2, vol: 0x40}, {ch: 3, note: 0x78, vol: 0x20}]);
  r([{ch: 1, note: 0xfd}, {ch: 2, note: 0xfe, vol: 0x30}, {ch: 3, note: 0xff, ins: 3}]);
  r([{ch: 1, vol: 0x41}, {ch: 2, vol: 0x80}, {ch: 3, vol: 0x7f}, {ch: 4, vol: 0xc1}]);
  r([{ch: 1, mask: 0x40}, {ch: 2, mask: 0x40}, {ch: 3, mask: 0x40}, {ch: 4, mask: 0x44, vol: 0x10}]);
  r([{ch: 1, mask: 0x10}, {ch: 2, mask: 0x20}, {ch: 3, mask: 0xb0}, {ch: 0, mask: 0x80}]);
  r([{ch: 1, mask: 0x10, noMask: true}, {ch: 3, mask: 0xb0, noMask: true}, {ch: 5, mask: 0}, {ch: 6, ins: 9}]);
  r([{ch: 33, note: 60, ins: 1}, {ch: 63, cmd: c('A'), val: 3}, {ch: 31, note: 0x7f, cmd: c('H'), val: 0x21}]);
  r([{ch: 30, cmd: c('D'), val: 0x00}, {ch: 31, cmd: c('D'), val: 0x00}, {ch: 0, note: 0xfe, ins: 4, vol: 0x40}]);
  r([]); r([{ch: 7, note: 64, ins: 2, vol: 64, cmd: c('S'), val: 0x91}]);
  return rows;
})();

function sampleModeModule() {
  const samples = [
    {flg: 0x01, cvt: 0, length: 20, data: sampleData(20, 1, 1)}, // unsigned 8-bit, no loop, < 32 frames
    {flg: 0x13, cvt: 0, vol: 128, dfp: 0x80 | 70, length: 100, loopStart: 10, loopEnd: 200, data: sampleData(100, 2, 2)},
    {flg: 0x53, vol: 64, length: 300, loopStart: 40, loopEnd: 250, data: sampleData(300, 2, 3)}, // ping-pong
    {flg: 0x11, length: 80, loopStart: 30, loopEnd: 30, data: sampleData(80, 1, 4)}, // empty loop
    {flg: 0x11, length: 50, loopStart: 3, loopEnd: 8, data: sampleData(50, 1, 5)}, // loop shorter than the padding
    {flg: 0x00, cvt: 0, length: 0}, // no data
    {sig: 'XXXX', flg: 0x01, length: 16, data: sampleData(16, 1, 6)}, // not IMPS: skipped, header uninitialised
    {flg: 0xad, vol: 200, dfp: 0x7f, cvt: 0x05, length: 40, susStart: 2, susEnd: 30, vib: 3, data: sampleData(40, 1, 7)},
    {flg: 0x03, length: 1000, data: sampleData(1000, 2, 8)}, // 16-bit signed, no loop, the last data in the file
  ];
  const p0 = pattern(EFFECTS);
  const p1 = pattern([[{ch: 0, cmd: 4, val: 0}, {ch: 1, note: 50, ins: 1}]]);
  const p3 = pattern(Array.from({length: 200}, (_, i) => i % 3 ? [] : [{ch: i % 32, note: i % 120, ins: 1 + (i % 9), vol: i % 65, cmd: 1 + (i % 26), val: (i * 37) & 0xff}]));
  return buildIT({name: 'Synthetic sample mode', flags: 0x13, gv: 0x7f, speed: 0x30, tempo: 0x20,
    orders: [0, 1, 0xfe, 3, 2, 3, 9, 1, 0xff, 4, 0xff],
    pans: [0, 0x20, 0x40, 0x41, 100, 0x80, 0xa0, 0xff, 0x3f, 1],
    samples, patterns: [p0, p1, null, p3]});
}

function instrumentModeModule() {
  const samples = [
    {flg: 0x13, length: 64, loopStart: 0, loopEnd: 64, data: sampleData(64, 2, 11)},
    {flg: 0x01, dfp: 0xff, length: 33, data: sampleData(33, 1, 12)}, // pan clamp in instrument mode
    {sig: 'XXXX', flg: 0x01, cvt: 0, length: 45, data: sampleData(45, 1, 13)}, // no signature check here
    {flg: 0x01, length: 70, data: sampleData(70, 1, 14)}, // referenced by no key
    {flg: 0x51, length: 90, loopStart: 31, loopEnd: 60, data: sampleData(90, 1, 15)},
    {flg: 0x00, length: 0}, // Length 0: skipped, name only
  ];
  const env = (flags, nodes, more = {}) => ({flags, nodes, ...more});
  const instruments = [
    impi({name: 'Keys and envelopes', fade: 0x400, keys: k => [0, 3, 3, 1, 5, 2, 0, 1][k % 8],
      vol: env(0x07, [[0, 0], [32, 10], [64, 20], [255, 30], [63, 40], [1, 50], [2, 60], [3, 70], [4, 80], [5, 90], [6, 100], [7, 110]], {lpb: 1, lpe: 2, slb: 3, sle: 0x12}),
      pan: env(0x04, [[32, 0], [-32, 5], [-128, 9], [127, 12], [0, 15], [31, 16]], {lpb: 0x11, lpe: 3, slb: 1, sle: 3}),
      pitch: env(0x03, [[-32, 0], [31, 4], [-128, 8], [127, 12]], {lpb: 0, lpe: 3, slb: 2, sle: 0x1f})}),
    impi({name: 'Bad signature', sig: 'XXXX', keys: () => 1, vol: env(1, [[64, 0]]), pan: env(0, []), pitch: env(0, [])}),
    impi({name: 'Fade wrap', fade: 0x800, keys: k => (k & 1 ? 6 : 3), vol: env(0x02, [[16, 0], [8, 1]]),
      pan: env(0x01, [[-1, 0]]), pitch: env(0x80, [[1, 0]])}),
  ];
  const p0 = pattern([[{ch: 0, note: 60, ins: 1, cmd: 19, val: 0x91}], [{ch: 1, note: 61, ins: 3, vol: 32}], [{ch: 0, note: 0xff}]]);
  return buildIT({name: 'Synthetic instrument mode', flags: 0x0d, orders: [0, 0, 0xff], samples, instruments, patterns: [p0]});
}

function ordersModule(ordNum, orders) {
  const p0 = pattern([[{ch: 0, note: 60, ins: 1}], [{ch: 0, cmd: 1, val: 3}]]);
  const p1 = pattern([[{ch: 2, note: 40, ins: 1}]]);
  return buildIT({name: `Orders ${ordNum}`, ordNum, orders, patterns: [p0, p1],
    samples: [{flg: 0x01, length: 40, data: sampleData(40, 1, 21)}]});
}

function patched(bytes, offset, value) {
  const out = bytes.slice();
  u32(out, offset, value);
  return out;
}

/** Inputs on which the original itself faults (so no oracle run): the kernel
 * must stop with the named UNSUPPORTED_* status instead. */
export function faultingModules() {
  const instrument = instrumentModeModule();
  return [
    // Cut inside the IMPS headers: the pattern header comes from the zero
    // slack, Rows 0 makes rowsLeft -1 and the converter writes past its
    // 0xc101-byte event block (Unicorn: unmapped write).
    {name: 'Fault_InstrumentTruncated', bytes: instrument.subarray(0, instrument.length - 1300), status: 0x103},
  ];
}

export function syntheticModules() {
  const sample = sampleModeModule(), instrument = instrumentModeModule();
  return [
    {name: 'Synthetic_SampleMode', bytes: sample},
    {name: 'Synthetic_InstrumentMode', bytes: instrument},
    // 500 of the last sample's 2000 bytes come from the caller's slack (uninitialised).
    {name: 'Synthetic_TruncatedIntoSlack', bytes: sample.subarray(0, sample.length - 500)},
    // Past the slack: the last sample read is short (0x10) and the load stops.
    {name: 'Synthetic_TruncatedShort', bytes: sample.subarray(0, sample.length - 3000)},
    // OrdNum > 255 without 0xff: 255 orders read, the rest skipped.
    {name: 'Synthetic_Orders300', bytes: ordersModule(300, Array.from({length: 300}, (_, i) => (i % 5 === 4 ? 0xfe : i & 1)))},
    // OrdNum 0: base-zero length 0xff, the whole (fresh, zero) order table converts.
    {name: 'Synthetic_Orders0', bytes: ordersModule(0, [])},
    // An instrument-mode sample (IT sample 1, loaded second) whose data pointer
    // is past the stream: an empty read, 0x10 through 0x106295d5.
    {name: 'Synthetic_InstrumentBadOffset', bytes: patched(instrument, 0xc0 + 3 + 4 * 10 + 3 * 0x226 + 0x48, 0x7fffffff)},
    // A sample pointer past the stream: the seek clamps to Length, the read is empty (0x10).
    {name: 'Synthetic_BadSampleOffset', bytes: patched(ordersModule(2, [0, 0xff]), 0xc0 + 2 + 4 + 8 + 0x48, 0x7fffffff)},
    // OrdNum 0x8000 in a short file: the order skip seeks past the end and clamps;
    // the offset tables read nothing and keep their previous (fresh: zero) values.
    {name: 'Synthetic_OrdersPastEnd', bytes: ordersModule(0x8000, [0, 1, 0xff])},
  ];
}

// ---- Module player cases -------------------------------------------------------

/** Rows of a pattern from per-channel scripts {ch: {row: {note, ins, vol, fx}}};
 * fx is an IT effect as text ('J37' = J with 0x37). */
function scripted(rows, channels) {
  const out = Array.from({length: rows}, () => []);
  for (const [ch, script] of Object.entries(channels)) {
    for (const [row, e] of Object.entries(script)) {
      const entry = {ch: Number(ch)};
      for (const k of ['note', 'ins', 'vol']) if (e[k] !== undefined) entry[k] = e[k];
      if (e.fx) { entry.cmd = e.fx.charCodeAt(0) - 64; entry.val = parseInt(e.fx.slice(1), 16); }
      out[Number(row)].push(entry);
    }
  }
  return out;
}

const OFF = 0xff, CUT = 0xfe; // IT === and ^^^

/** Linear slides, sample mode: every effect the songs never play (J, R, K, L,
 * S3x/S4x waveforms 0..7, SBx loops, SCx, SDx including x >= speed, SEx, T < 0x20
 * and T20, C to row > 0 with BCD, A00 recalling a foreign parameter, X/S8x/S9x
 * pans including hard left, O past the end, Q, fine and extra-fine slides),
 * header pans 0 / 64 / surround, a sample default pan, ping-pong and one-shot
 * samples, and 9xx / Q / EAx on a pattern's last row (the pattern-end pass). */
function sequencerLinear() {
  const samples = [
    {flg: 0x13, length: 2000, loopStart: 100, loopEnd: 1900, c5: 8363, data: sampleData(2000, 2, 31)},
    {flg: 0x51, length: 1000, loopStart: 200, loopEnd: 800, c5: 22050, data: sampleData(1000, 1, 32)},
    {flg: 0x01, length: 300, c5: 16000, data: sampleData(300, 1, 33)},
    {flg: 0x13, dfp: 0x80 | 10, vol: 40, length: 600, loopStart: 0, loopEnd: 600, c5: 30000, data: sampleData(600, 2, 34)},
  ];
  const p0 = pattern(scripted(64, {
    0: {0: {note: 60, ins: 1, fx: 'J37'}, 2: {fx: 'J47'}, 4: {fx: 'J00'}, 6: {note: 61, fx: 'J5C'}, 8: {fx: 'JFF'},
      10: {fx: 'A03'}, 11: {fx: 'H11'}, 12: {fx: 'A00'}, 13: {fx: 'A06'}, 14: {fx: 'T10'}, 16: {fx: 'T1F'},
      18: {fx: 'T20'}, 19: {fx: 'A06'}, 20: {fx: 'T96'}, 24: {note: OFF}, 26: {note: 36, ins: 1, fx: 'J12'},
      30: {note: CUT}, 32: {note: 60, ins: 1, vol: 32}, 34: {fx: 'Q03'}, 36: {fx: 'Q00'}, 40: {fx: 'SB0'},
      41: {note: 62, ins: 1, fx: 'J21'}, 44: {fx: 'SB2'}, 48: {fx: 'SC3'}, 50: {note: 64, ins: 1, fx: 'SD3'},
      52: {note: 65, ins: 1, fx: 'SD7'}, 54: {fx: 'SD2'}, 56: {fx: 'SE2'}, 60: {fx: 'S05'}, 61: {fx: 'S15'}, 63: {fx: 'C05'}},
    1: {0: {note: 48, ins: 2, fx: 'R48'}, 2: {fx: 'R00'}, 4: {fx: 'S41'}, 5: {fx: 'R26'}, 8: {fx: 'S42'}, 9: {fx: 'R35'},
      12: {fx: 'S43'}, 13: {fx: 'R4F'}, 16: {fx: 'S47'}, 17: {fx: 'R8F'}, 20: {fx: 'S44'}, 21: {fx: 'RF1'},
      24: {note: 47, ins: 2, fx: 'D0F'}, 26: {fx: 'DF0'}, 28: {fx: 'D1F'}, 30: {fx: 'DF1'}, 32: {fx: 'DFF'}, 34: {fx: 'D00'},
      36: {vol: 64}, 38: {fx: 'M40'}, 40: {note: 50, ins: 2, fx: 'O00'}, 42: {fx: 'OFF'}, 44: {fx: 'O00'},
      46: {note: 50, ins: 2, fx: 'O02'}, 48: {note: 50, ins: 2, fx: 'E01'}, 50: {fx: 'EF2'}, 52: {fx: 'EE5'}, 53: {fx: 'E00'},
      54: {fx: 'F01'}, 56: {fx: 'FF3'}, 58: {fx: 'FE6'}, 59: {fx: 'F00'}, 60: {note: 52, fx: 'G00'}, 62: {fx: 'G08'}},
    2: {0: {note: 55, ins: 1, fx: 'H46'}, 2: {fx: 'H00'}, 4: {fx: 'S31'}, 5: {fx: 'H8A'}, 8: {fx: 'S32'}, 9: {fx: 'H2C'},
      12: {fx: 'S33'}, 13: {fx: 'HF4'}, 16: {fx: 'S37'}, 17: {fx: 'H44'}, 20: {fx: 'S30'}, 22: {fx: 'K05'}, 24: {fx: 'K00'},
      26: {fx: 'U22'}, 28: {note: 50, ins: 1, fx: 'G10'}, 30: {fx: 'L03'}, 32: {fx: 'L00'}, 34: {note: 70, fx: 'G00'},
      36: {fx: 'G20'}, 40: {fx: 'HF0'}, 42: {fx: 'H0F'}, 44: {note: 40, ins: 1, fx: 'S34'}, 45: {fx: 'H33'}, 48: {note: 41, ins: 1}},
    3: {0: {note: 60, ins: 4}, 2: {fx: 'X00'}, 4: {fx: 'X40'}, 6: {fx: 'X80'}, 8: {fx: 'XFF'}, 10: {fx: 'XA0'}, 12: {fx: 'S91'},
      14: {fx: 'S80'}, 16: {fx: 'S8F'}, 18: {fx: 'F10'}, 20: {fx: 'F00'}, 24: {fx: 'E40'}, 28: {note: 30, ins: 4},
      30: {fx: 'FF0'}, 32: {fx: 'X84'}, 34: {fx: 'XC4'}, 36: {fx: 'X81'}},
    4: {0: {note: 72, ins: 3}, 4: {note: 72, ins: 3, fx: 'SD1'}, 8: {fx: 'SC0'}, 12: {note: 84, ins: 3, vol: 10},
      16: {note: 96, ins: 3, vol: 64}, 20: {note: 119, ins: 3}, 24: {note: 0, ins: 3}, 28: {fx: 'SE1'}, 32: {note: 60, ins: 3, fx: 'SC0'}},
    5: {0: {note: 50, ins: 1}, 8: {note: 52, ins: 2}},
    6: {0: {note: 62, ins: 2, fx: 'O10'}, 8: {fx: 'Q31'}},
    7: {0: {note: 64, ins: 1, fx: 'D04'}, 4: {fx: 'D40'}, 8: {fx: 'D00'}, 12: {fx: 'DF4'}, 16: {fx: 'DE0'}},
    // Channels 8..10 have no note on the next pattern's first row, so the
    // pattern-end pass's second run of the ending row's effects shows.
    8: {1: {note: 57, ins: 1}, 63: {fx: 'O20'}},
    9: {1: {note: 59, ins: 2}, 63: {fx: 'Q01'}},
    10: {1: {note: 52, ins: 1, vol: 40}, 63: {fx: 'D3F'}},
  }));
  const p1 = pattern(scripted(64, {
    0: {5: {note: 60, ins: 1}, 10: {fx: 'C12'}},
    1: {6: {note: 48, ins: 2, fx: 'R48'}},
    2: {7: {fx: 'H46'}},
    8: {10: {fx: 'O30'}},
    9: {10: {fx: 'Q02'}},
    10: {10: {fx: 'DF2'}},
  }));
  const p2 = pattern(scripted(32, {
    0: {12: {note: 67, ins: 2}, 14: {fx: 'SB0'}, 16: {note: 66, ins: 1}, 18: {fx: 'SB1'}, 31: {fx: 'B00'}},
    1: {20: {note: OFF}},
    3: {12: {note: 58, ins: 1}, 31: {fx: 'O05'}},
    4: {31: {note: 60, ins: 1, fx: 'Q02'}},
    5: {12: {note: 57, ins: 1}, 31: {fx: 'D1F'}},
    8: {31: {fx: 'O05'}},
    9: {31: {fx: 'Q01'}},
    10: {31: {fx: 'D2F'}},
  }));
  return buildIT({name: 'Sequencer linear', flags: 0x09, speed: 6, tempo: 125, orders: [0, 1, 2, 0xff],
    pans: [32, 32, 32, 32, 32, 0, 64, 100], samples, patterns: [p0, p1, p2]});
}

/** Amiga slides (no linear bit): porta, fine porta, tone porta, vibrato,
 * arpeggio and tremolo on Amiga periods, notes across the whole table
 * (including the 65280 entries below 21), and a C5 speed of 0. */
function sequencerAmiga() {
  const samples = [
    {flg: 0x13, length: 1500, loopStart: 0, loopEnd: 1500, c5: 8363, data: sampleData(1500, 2, 41)},
    {flg: 0x11, length: 800, loopStart: 100, loopEnd: 700, c5: 44100, data: sampleData(800, 1, 42)},
    {flg: 0x51, length: 500, loopStart: 50, loopEnd: 450, c5: 11025, data: sampleData(500, 1, 43)},
    {flg: 0x11, length: 400, loopStart: 0, loopEnd: 400, c5: 0, data: sampleData(400, 1, 44)},
  ];
  const p0 = pattern(scripted(48, {
    0: {0: {note: 60, ins: 1, fx: 'J47'}, 4: {fx: 'E08'}, 8: {fx: 'F08'}, 12: {fx: 'EF4'}, 14: {fx: 'FE8'},
      16: {note: 72, ins: 1, fx: 'G04'}, 20: {fx: 'G00'}, 24: {fx: 'H48'}, 28: {fx: 'S32'}, 29: {fx: 'H6C'},
      32: {note: 5, ins: 1}, 36: {note: 20, ins: 1}, 40: {note: 119, ins: 1}, 44: {fx: 'J3C'}},
    1: {0: {note: 48, ins: 2}, 6: {fx: 'K02'}, 10: {fx: 'L02'}, 14: {note: 36, ins: 2, fx: 'G10'}, 20: {fx: 'E20'}, 24: {fx: 'F20'},
      30: {note: 50, ins: 2, fx: 'SD2'}},
    2: {0: {note: 55, ins: 3, fx: 'R46'}, 8: {fx: 'S41'}, 12: {note: 67, ins: 3}, 20: {note: OFF}},
    3: {0: {note: 60, ins: 4}, 8: {note: 30, ins: 4, fx: 'H22'}},
  }));
  const p1 = pattern(scripted(16, {
    0: {0: {note: 64, ins: 1, fx: 'E04'}},
    1: {8: {fx: 'A03'}},
    2: {4: {note: 50, ins: 3, fx: 'O03'}},
  }));
  return buildIT({name: 'Sequencer Amiga', flags: 0x01, speed: 4, tempo: 140, orders: [0, 1], samples, patterns: [p0, p1]});
}

/** Instrument mode: volume, pan and pitch envelopes with loops, sustain and
 * fade-out, key off with and without a volume envelope, instrument-only rows,
 * note delay on a key-off note (keymap index 0x80 + ...). */
function sequencerEnvelopes() {
  const samples = [
    {flg: 0x13, length: 1200, loopStart: 0, loopEnd: 1200, c5: 8363, data: sampleData(1200, 2, 51)},
    {flg: 0x11, length: 700, loopStart: 100, loopEnd: 600, c5: 22050, data: sampleData(700, 1, 52)},
    {flg: 0x51, length: 500, loopStart: 20, loopEnd: 480, c5: 16000, data: sampleData(500, 1, 53)},
  ];
  const env = (flags, nodes, more = {}) => ({flags, nodes, ...more});
  // IT envelope flags: 1 on, 2 loop, 4 sustain loop (Galaxy: 1 on, 4 loop, 2
  // sustain; the pitch envelope's sustain bit comes from the pan flags).
  // Nodes sharing a tick make a zero-length segment.
  const instruments = [
    impi({name: 'Looped envelopes', fade: 0x40, keys: k => (k < 60 ? 1 : 2),
      vol: env(0x07, [[64, 0], [32, 4], [48, 4], [16, 12], [0, 20]], {lpb: 1, lpe: 3, slb: 2, sle: 2}),
      pan: env(0x07, [[-32, 0], [32, 6], [16, 6], [0, 10]], {lpb: 0, lpe: 3, slb: 1, sle: 2}),
      pitch: env(0x03, [[0, 0], [16, 5], [8, 5], [-16, 10]], {lpb: 1, lpe: 3, slb: 2, sle: 2})}),
    impi({name: 'No volume envelope', keys: () => 2, vol: env(0, [[64, 0]]),
      pan: env(0x03, [[16, 0], [-16, 8], [8, 12]], {slb: 1, sle: 1}),
      pitch: env(0x05, [[-8, 0], [8, 3], [0, 6]], {lpb: 0, lpe: 2})}),
    impi({name: 'Sustain and fade', fade: 0x200, keys: () => 3,
      vol: env(0x03, [[64, 0], [40, 2], [20, 6]], {slb: 1, sle: 1}), pan: env(0, []), pitch: env(0, [])}),
  ];
  const p0 = pattern(scripted(32, {
    0: {0: {note: 60, ins: 1}, 8: {note: OFF}, 14: {note: 62, ins: 1}, 16: {ins: 1}, 20: {note: CUT},
      22: {note: 64, ins: 1, fx: 'SD2'}, 26: {note: OFF, fx: 'SD1'}},
    1: {0: {note: 48, ins: 2}, 6: {note: OFF}, 12: {note: 52, ins: 2}, 16: {note: 55, fx: 'G08'}},
    2: {0: {note: 67, ins: 3}, 4: {note: OFF}, 12: {note: 69, ins: 3}, 18: {note: OFF}},
    3: {0: {note: 72, ins: 1, fx: 'X20'}, 10: {note: 74, ins: 2}},
    4: {0: {note: 60, ins: 3, fx: 'H34'}},
  }));
  return buildIT({name: 'Sequencer envelopes', flags: 0x0d, speed: 3, tempo: 125, orders: [0, 0xff], samples, instruments, patterns: [p0]});
}

/** Branches the other modules miss: a channel whose first note is delayed
 * (SDx without an earlier trigger leaves +0x11 clear, so the mixer takes the
 * effects-voice path), a delayed note on a default-pan sample, tremolo below
 * zero, K and L sliding up and both clamps, tone porta without a note after
 * E/F (the target is left at the porta limit). */
function sequencerReach() {
  const samples = [
    {flg: 0x13, length: 1000, loopStart: 0, loopEnd: 1000, c5: 8363, data: sampleData(1000, 2, 71)},
    {flg: 0x11, dfp: 0x80 | 50, length: 700, loopStart: 0, loopEnd: 700, c5: 16000, data: sampleData(700, 1, 72)},
  ];
  const p0 = pattern(scripted(32, {
    0: {0: {note: 60, ins: 1, fx: 'SD2'}, 12: {note: 62, ins: 1}},
    1: {0: {note: 62, ins: 2, fx: 'SD1'}},
    2: {0: {note: 60, ins: 1, vol: 2}, 1: {fx: 'RFF'}, 2: {fx: 'R00'}, 3: {fx: 'R00'}, 4: {fx: 'R4F'}},
    3: {0: {note: 60, ins: 1, vol: 4}, 1: {fx: 'L0F'}, 4: {vol: 0x3e}, 5: {fx: 'LF0'}, 6: {fx: 'L00'}},
    4: {0: {note: 60, ins: 1, vol: 4}, 1: {fx: 'K0F'}, 4: {vol: 0x3e}, 5: {fx: 'KF0'}, 6: {fx: 'K00'}},
    // Tone porta without a note after E/F: the target stays at the porta limit.
    5: {0: {note: 48, ins: 1}, 2: {fx: 'F10'}, 4: {fx: 'G08'}, 8: {fx: 'E20'}, 10: {fx: 'G00'}},
  }));
  return buildIT({name: 'Sequencer reach', speed: 4, tempo: 150, orders: [0, 0xff], samples, patterns: [p0]});
}

/** One module per order/row edge case. */
function sequencerEdges() {
  const sample = [{flg: 0x11, length: 900, loopStart: 0, loopEnd: 900, c5: 8363, data: sampleData(900, 1, 61)}];
  const notes = rows => pattern(scripted(rows, {0: {0: {note: 60, ins: 1}}, 1: {1: {note: 64, ins: 1}}}));
  return [
    // A00 with no earlier parameter on the channel: F00 stops the song.
    {name: 'Sequencer_A00Stop', bytes: buildIT({name: 'A00 stop', orders: [0, 0xff], samples: sample,
      patterns: [pattern(scripted(16, {0: {0: {note: 60, ins: 1}, 3: {fx: 'A00'}}, 1: {1: {note: 64, ins: 1}}}))]})},
    // SBx on a pattern's last row: the pattern-end pass rearms the loop for ever.
    {name: 'Sequencer_LoopLastRow', bytes: buildIT({name: 'Loop on the last row', orders: [0, 1, 0xff], samples: sample,
      patterns: [notes(8), pattern(scripted(16, {0: {4: {fx: 'SB0'}, 15: {fx: 'SB2'}}, 1: {6: {note: 62, ins: 1}}}))]})},
    // A break to row 40 of an 8-row pattern: the row skip reads past its events.
    {name: 'Sequencer_BreakPastEnd', bytes: buildIT({name: 'Break past the end', orders: [0, 1, 0xff], samples: sample,
      patterns: [pattern(scripted(8, {0: {0: {note: 60, ins: 1}, 2: {fx: 'C40'}}})), notes(8)]})},
    // Every order '+++': the order walk never finds a pattern.
    {name: 'Sequencer_AllSkipped', bytes: buildIT({name: 'All skipped', orders: [0xfe, 0xfe], samples: sample,
      patterns: [notes(4)]})},
    // LoopStart > LoopEnd: the trigger negates the step, and the mixer's runs
    // count backwards from the loop end.
    {name: 'Sequencer_ReversedLoop', bytes: buildIT({name: 'Reversed loop', orders: [0, 0xff],
      patterns: [pattern(scripted(16, {0: {0: {note: 60, ins: 1}, 8: {note: 64, ins: 1, fx: 'SD2'}}, 1: {1: {note: 67, ins: 1}}}))],
      samples: [{flg: 0x11, length: 1000, loopStart: 600, loopEnd: 200, c5: 8363, data: sampleData(1000, 1, 62)}]})},
  ];
}

export function sequencerModules() {
  return [
    {name: 'Sequencer_Linear', bytes: sequencerLinear()},
    {name: 'Sequencer_Amiga', bytes: sequencerAmiga()},
    {name: 'Sequencer_Envelopes', bytes: sequencerEnvelopes()},
    {name: 'Sequencer_Reach', bytes: sequencerReach()},
    ...sequencerEdges(),
  ];
}
