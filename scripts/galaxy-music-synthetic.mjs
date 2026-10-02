/** Synthetic Impulse Tracker modules for the Galaxy loader comparison
 * (validate-galaxy-music-loader.mjs). Each drives IT-loader branches that the
 * 35 DX songs never reach; the original glxLoadMusic (native oracle) and the
 * Rust kernel load the same bytes and must dump the same state. Field
 * offsets follow ITTECH (IMPM 0xc0 header, IMPI 0x226 bytes as read at
 * 0x10628c8a, IMPS 0x50). Authored test data only; no original content. */

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
