// The original's sound start latency under Wine (Stage 7 row 7.5.2, docs/audio-latency.md): from a sound's glxStartSample to the
// moment the host's mixer takes its first byte out of Galaxy's DirectSound buffer.
//
// Two inputs, both from the running original:
// - a `dx-live-win.exe galaxy latency` trace (scripts/galaxy-output-capture.sh latency): real starts. Each effect voice start
//   (StartTime or Active changing, glxStartSample) is paired with the timer callback that first renders it (the voice's SmpPtr
//   first moves); the voice must begin at that callback's head B (the B of the callback before), which the first advance
//   confirms (a whole callback's frames, as the next callback's). The play cursor is Wine's own (the buffer object's dword equal
//   to A at every callback, found from the data), read every poll, so the first byte's time is the poll where that cursor
//   passes B. Measured per start: `distance` = (B − play cursor at the start) / 176,400 bytes/s, and `wall` = the time from the
//   start to the poll where the cursor passed B.
// - a `galaxy poll` trace (training-load*.poll.txt, the Mac, 2026-10-16): no voice data, so starts are placed uniformly in
//   time; the play cursor between two callbacks is the line between their A values (the cursor read at each callback).
//
//   node scripts/audio-latency-original.mjs [--trace .work/audio-output/latency-training.txt] [--poll file ...] [--json out]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const BYTES_PER_SECOND = 176400;

export function summary(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = p => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  const r = x => Math.round(x * 100) / 100;
  return { n: v.length, min: r(v[0]), p5: r(q(0.05)), median: r(q(0.5)), mean: r(v.reduce((s, x) => s + x, 0) / v.length),
    p95: r(q(0.95)), max: r(v[v.length - 1]) };
}

/** Unwraps a sequence of ring positions (each step forward by less than `size`). */
function unwrapper(size) {
  let base = 0, last = null;
  return value => { if (last !== null && value < last) base += size; last = value; return base + value; };
}

/** The first index whose `key(item)` is above `value` (items sorted by it), or the length. */
function firstAbove(items, value, key) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (key(items[mid]) > value) hi = mid; else lo = mid + 1; }
  return lo;
}

/** A `galaxy latency` trace: the real starts. */
export function analyzeLatencyTrace(text, { size = BYTES_PER_SECOND } = {}) {
  const lines = text.split('\n').filter(Boolean), header = lines.find(l => l.startsWith('#')) ?? '';
  const interval = Number(/intervalUs=(\d+)/.exec(header)?.[1] ?? 250) / 1000;
  const heads = [], voices = [], words = new Map(), wordSeries = new Map();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const f = line.split(' '), t = Number(f[1]) / 1000;
    if (f[0] === 'h') heads.push({ t, A: Number(f[2]), B: Number(f[3]), ahead: Number(f[4]) });
    else if (f[0] === 'v') voices.push({ t, slot: Number(f[2]), active: Number(f[3]), start: Number(f[4]), mutex: Number(f[5]), ptr: Number(f[6]) });
    else if (f[0] === 'd') for (const kv of f.slice(2)) {
      const [off, value] = kv.split('='), n = Number(value);
      words.set(off, n);
      if (!wordSeries.has(off)) wordSeries.set(off, []);
      wordSeries.get(off).push({ t, value: n });
    }
  }
  // The callbacks: A changes, with B from a read between callbacks (ahead back at the full ring).
  const callbacks = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (callbacks.length && h.A === callbacks[callbacks.length - 1].A) {
      if (h.ahead === size) callbacks[callbacks.length - 1].B = h.B;
      continue;
    }
    callbacks.push({ t: h.t, A: h.A, B: h.ahead === size ? h.B : null });
  }
  callbacks.shift(); // the first line is the poll's start, not a callback
  // Wine's play cursor: the buffer object's dword whose value at each callback is that callback's A.
  const valueAt = (series, t) => series[firstAbove(series, t, s => s.t) - 1]?.value ?? null;
  let cursor = null, best = 0;
  for (const [off, series] of wordSeries) {
    if (series.length < callbacks.length) continue;
    let hits = 0;
    for (const c of callbacks.slice(0, 200)) if (valueAt(series, c.t) === c.A) hits++;
    if (hits > best) { best = hits; cursor = off; }
  }
  const checked = Math.min(200, callbacks.length);
  // 85 %, not all: under CrossOver on the Mac (2026-11-11) the cursor moves in 2,048-byte steps out of step with Galaxy's callbacks,
  // so a poll reads it one step past A at about 1 callback in 10 (178 of the first 200, 90.4 % of all 58,959); no other dword matched
  // at all (the next best 0 of 200). Wine on Linux matched 195 to 200 of 200. The user accepted 89 % as enough (2026-11-11).
  if (!cursor || best < 0.85 * checked) throw new Error(`no buffer dword follows A (best ${cursor} ${best}/${checked})`);
  const unwrapPlay = unwrapper(size), plays = wordSeries.get(cursor).map(s => ({ t: s.t, play: unwrapPlay(s.value) }));
  // Callback heads unwrapped onto the play cursor's scale.
  const playAt = t => plays[firstAbove(plays, t, s => s.t) - 1]?.play ?? null;
  for (const c of callbacks) {
    const p = playAt(c.t);
    if (p === null) { c.Au = null; continue; }
    c.Au = p - (((p % size) - c.A + size) % size); // the A read with the cursor, on the cursor's lap
    c.D = c.B === null ? null : (c.B - c.A + size) % size;
  }
  const D = mode(callbacks.map(c => c.D).filter(x => x !== null));
  const R = mode(callbacks.slice(1).map((c, i) => c.Au - callbacks[i].Au).filter(Number.isFinite));
  // The starts.
  const bySlot = new Map();
  for (const v of voices) { if (!bySlot.has(v.slot)) bySlot.set(v.slot, []); bySlot.get(v.slot).push(v); }
  const starts = [], skipped = { ordering: 0, noRender: 0, noCursor: 0 };
  let placed = 0, placementChecked = 0;
  for (const [slot, list] of bySlot) for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], v = list[i];
    if (!v.active || (prev.active && prev.start === v.start && prev.mutex === v.mutex)) continue;
    // The first render: the voice's SmpPtr moving after the start (a later restart ends the search).
    let render = null, second = null;
    for (let j = i + 1; j < list.length; j++) {
      const w = list[j];
      if (w.start !== v.start) break;
      if (render === null && w.ptr !== v.ptr) { render = w; continue; }
      if (render !== null && w.ptr !== render.ptr) { second = w; break; }
    }
    if (!render) { skipped.noRender++; continue; }
    const k = firstAbove(callbacks, v.t - 1e-9, c => c.t);
    if (k <= 0 || k >= callbacks.length || callbacks[k].Au === null || callbacks[k - 1].Au === null) { skipped.noRender++; continue; }
    // A callback between the start and its detection (the same poll): its order against the start is not known.
    if (render.t < callbacks[k].t || render.t > callbacks[k].t + 2 * interval) { skipped.ordering++; continue; }
    const B = callbacks[k - 1].Au + D, p0 = playAt(v.t);
    const passed = plays[firstAbove(plays, B, s => s.play)];
    if (p0 === null || !passed) { skipped.noCursor++; continue; }
    if (second && k + 1 < callbacks.length && callbacks[k + 1].Au !== null) {
      const first = render.ptr - v.ptr, next = second.ptr - render.ptr;
      const Rk = callbacks[k].Au - callbacks[k - 1].Au, Rn = callbacks[k + 1].Au - callbacks[k].Au;
      placementChecked++;
      if (Math.abs(first - next * Rk / Rn) <= 2) placed++;
    }
    starts.push({ t: v.t, slot, distance: (B - p0) / size * 1000, wall: passed.t - v.t });
  }
  return { kind: 'trace', interval, cursorField: `+0x${cursor}`, cursorHits: `${best}/${checked}`, D, R, callbacks: callbacks.length,
    starts: starts.length, skipped, placement: { checked: placementChecked, wholeFirstRender: placed },
    distance: summary(starts.map(s => s.distance)), wall: summary(starts.map(s => s.wall)),
    uniform: uniformStarts(callbacks.map(c => ({ t: c.t, A: c.Au })), D, size, playAt),
    uniformWall: uniformWall(callbacks.map(c => ({ t: c.t, A: c.Au })), D, plays) };
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

/** Starts placed uniformly in time (every 0.25 ms): a start between callbacks k−1 and k begins at B(k−1) = A(k−1) + D; the
 * distance to the play cursor at the start, `cursorAt(t)`, or the line between the callbacks' A without one. */
function uniformStarts(callbacks, D, size, cursorAt = null) {
  const cbs = callbacks.filter(c => Number.isFinite(c.A));
  const out = [];
  for (let k = 1; k < cbs.length; k++) {
    const a = cbs[k - 1], b = cbs[k], B = a.A + D;
    for (let t = a.t + 0.125; t <= b.t; t += 0.25) {
      const p = cursorAt ? cursorAt(t) : a.A + (b.A - a.A) * (t - a.t) / (b.t - a.t);
      if (p !== null) out.push((B - p) / size * 1000);
    }
  }
  return summary(out);
}

/** Starts placed uniformly in time (every 0.25 ms), timed to the poll where Wine's cursor passes their first byte B(k−1). */
function uniformWall(callbacks, D, plays) {
  const cbs = callbacks.filter(c => Number.isFinite(c.A)), out = [];
  let j = 0;
  for (let k = 1; k < cbs.length; k++) {
    const a = cbs[k - 1], b = cbs[k], B = a.A + D;
    while (j < plays.length && plays[j].play <= B) j++;
    if (j === plays.length) break;
    for (let t = a.t + 0.125; t <= b.t; t += 0.25) out.push(plays[j].t - t);
  }
  return summary(out);
}

/** A `galaxy poll` trace (no voices, no Wine cursor). */
export function analyzePoll(text) {
  const rows = text.trim().split('\n').map(l => l.split(' ').map(Number));
  const size = rows[0][1], unwrap = unwrapper(size), callbacks = [];
  for (let i = 1; i < rows.length; i++) if (rows[i][2] !== rows[i - 1][2]) callbacks.push({ t: rows[i][0] / 1000, A: unwrap(rows[i][2]) });
  const D = mode(rows.filter(r => r[4] === size).map(r => (r[3] - r[2] + size) % size));
  const R = new Map();
  for (let k = 1; k < callbacks.length; k++) { const r = callbacks[k].A - callbacks[k - 1].A; R.set(r, (R.get(r) ?? 0) + 1); }
  return { kind: 'poll', D, callbacks: callbacks.length, R: Object.fromEntries([...R].sort((a, b) => a[0] - b[0])),
    distance: uniformStarts(callbacks, D, size) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
  const trace = option('trace', '.work/audio-output/latency-training.txt');
  const polls = argv.flatMap((a, i) => a === '--poll' ? [argv[i + 1]] : []);
  if (!polls.length) for (const f of ['.work/audio-output/training-load1.poll.txt', '.work/audio-output/training-load2.poll.txt']) if (existsSync(f)) polls.push(f);
  const result = { trace: existsSync(trace) ? { file: trace, ...analyzeLatencyTrace(readFileSync(trace, 'utf8')) } : null,
    polls: polls.map(file => ({ file, ...analyzePoll(readFileSync(file, 'utf8')) })) };
  const line = s => s ? `median ${s.median} ms, mean ${s.mean}, p5 ${s.p5}, p95 ${s.p95}, min ${s.min}, max ${s.max} (n ${s.n})` : 'none';
  if (result.trace) {
    const r = result.trace;
    console.log(`${r.file}: ${r.starts} starts (skipped ${JSON.stringify(r.skipped)}), D ${r.D}, R ${r.R}, ${r.callbacks} callbacks, ` +
      `Wine's play cursor at ${r.cursorField} (${r.cursorHits}); first render a whole callback: ${r.placement.wholeFirstRender}/${r.placement.checked}`);
    console.log(`  distance: ${line(r.distance)}`);
    console.log(`  wall:     ${line(r.wall)}`);
    console.log(`  uniform:  ${line(r.uniform)}`);
    console.log(`  uniform wall: ${line(r.uniformWall)}`);
  }
  for (const p of result.polls) console.log(`${p.file}: D ${p.D}, ${p.callbacks} callbacks, R ${JSON.stringify(p.R)}\n  uniform:  ${line(p.distance)}`);
  if (option('json', null)) writeFileSync(option('json'), JSON.stringify(result, null, 1));
}
