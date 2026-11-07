// Classifies the drawn frames over a limit in hitch-log runs (scripts/hitch-run.mjs <out>.json): which phase of the page frame is furthest over
// its median, when the slow frames fall (the first seconds after the map against later; the census route's headings), whether they come in
// runs, and, with a Gecko profile of the run (--profile, Firefox), how much collector time (GCMinor, GCSlice, CCSlice markers on the page's main
// thread) lies inside them. Host measurement only (docs/firefox-60fps-plan.md "Firefox p95 frames").
//
//   node scripts/hitch-slow-frames.mjs RUN.json... [--over 16] [--skip 5] [--early 20] [--profile PROFILE.json (one run)]
//
// The median frame is the frames between the 40th and 60th percentile of `animate`; a phase's excess in a slow frame is its value there minus its
// median over those frames. `allowed` is the number of frames that may exceed the limit for the p95 to be at or under it. The page clock of
// Playwright's Firefox reads whole milliseconds (privacy.reduceTimerPrecision), so `animate` is an integer there. The profile's clock is joined to the
// log's as scripts/gecko-slow-ticks.mjs joins it.
import {readFileSync} from 'node:fs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const over = Number(option('over', 16)), skipMs = Number(option('skip', 5)) * 1000, earlyMs = Number(option('early', 20)) * 1000, profileFile = option('profile', null);
const PHASES = ['tick', 'actors', 'render', 'hud', 'fog', 'lightAnimation', 'textures', 'audio', 'coronas', 'mirrors', 'sprites', 'lighting', 'lightUpload', 'weapon', 'ramp'];
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;

/** The collector markers of a Gecko profile's page thread, joined to the log's clock: [{kind, a, b}] in ms since the log's `meta.started`. */
function collectorMarks(run, rows, ci, profile) {
  const started = Date.parse(run.dump.meta.started);
  let thread = null, base = 0;
  const walk = p => { for (const t of p.threads ?? []) if (t.name === 'GeckoMain' && t.processName === 'Web Content' && (!thread || t.samples.data.length > thread.samples.data.length)) { thread = t; base = p.meta.startTime; } for (const c of p.processes ?? []) walk(c); };
  walk(profile);
  if (!thread) throw new Error('no Web Content main thread in the profile');
  const S = thread.stringTable, ft = thread.frameTable, st = thread.stackTable, ss = thread.samples.schema;
  const clean = s => s.replace(/\[\d+\]$/, '').replace(/https?:\/\/[^/]+\//g, '').replace(/\?[^:)]*/g, '').replace(/:(\d+):\d+\)/, ':$1)');
  const cache = new Map();
  const isTick = stack => { let r = cache.get(stack); if (r !== undefined) return r; r = false;
    for (let x = stack; x !== null; x = st.data[x][st.schema.prefix]) if (/^tick \(src\/viewer\/game\.mjs:/.test(clean(S[ft.data[st.data[x][st.schema.frame]][ft.schema.location]]))) { r = true; break; }
    cache.set(stack, r); return r; };
  const ticks = thread.samples.data.filter(r => r[ss.stack] !== null && isTick(r[ss.stack])).map(r => base + r[ss.time]).sort((a, b) => a - b);
  const lower = (x) => { let lo = 0, hi = ticks.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ticks[m] < x) lo = m + 1; else hi = m; } return lo; };
  // the offset whose per-frame count of level-tick samples inside the frame correlates best with the frame's tick phase
  const corr = offset => { let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const r of rows) { const a = started + r[ci.t] + offset, c = lower(a + r[ci.animate]) - lower(a), y = r[ci['p.tick']]; n++; sx += c; sy += y; sxx += c * c; syy += y * y; sxy += c * y; }
    const v = (n * sxx - sx * sx) * (n * syy - sy * sy); return v > 0 ? (n * sxy - sx * sy) / Math.sqrt(v) : 0; };
  let best = 0, bestR = -2;
  for (let off = -5000; off <= 5000; off += 10) { const r = corr(off); if (r > bestR) { bestR = r; best = off; } }
  for (let off = best - 10; off <= best + 10; off++) { const r = corr(off); if (r > bestR) { bestR = r; best = off; } }
  const ms = thread.markers.schema, marks = [];
  for (const row of thread.markers.data) { const kind = S[row[ms.name]]; if (!['GCMinor', 'GCSlice', 'CCSlice'].includes(kind)) continue;
    const a = base + row[ms.startTime]; marks.push({ kind, a: a - started - best, b: base + (row[ms.endTime] || row[ms.startTime]) - started - best }); }
  return { marks: marks.sort((x, y) => x.a - y.a), offset: best, correlation: bestR };
}

for (const file of files) {
  const run = JSON.parse(readFileSync(file, 'utf8')), d = run.dump, ci = Object.fromEntries(d.columns.map((c, i) => [c, i]));
  const mapAt = d.events.filter(e => e.kind === 'map').at(-1)?.t ?? 0;
  const rows = d.rows.filter(r => r[ci.drawn] && r[ci.t] >= mapAt + skipMs);
  const anim = rows.map(r => r[ci.animate]), slow = rows.filter(r => r[ci.animate] > over);
  const mid = rows.filter(r => r[ci.animate] >= q(anim, .4) && r[ci.animate] <= q(anim, .6));
  const med = Object.fromEntries(PHASES.map(p => [p, q(mid.map(r => r[ci[`p.${p}`]]), .5)])), medAnim = q(mid.map(r => r[ci.animate]), .5);
  console.log(`\n${file.split('/').pop()}: ${rows.length} drawn frames from ${skipMs / 1000} s after the map, page p50 ${q(anim, .5)} p95 ${q(anim, .95)} p99 ${q(anim, .99)} ms; `
    + `${slow.length} over ${over} ms (${(100 * slow.length / rows.length).toFixed(1)}%), allowed for p95 <= ${over}: ${Math.floor(rows.length * 0.05)}; median frame ${medAnim} ms`);
  const group = (name, sel) => {
    const all = rows.filter(sel), sl = all.filter(r => r[ci.animate] > over);
    if (!all.length) return;
    const dominant = {}, excess = Object.fromEntries(PHASES.map(p => [p, 0]));
    for (const r of sl) {
      let best = null, bd = -Infinity;
      for (const p of PHASES) { const dl = r[ci[`p.${p}`]] - med[p]; excess[p] += Math.max(0, dl); if (dl > bd) { bd = dl; best = p; } }
      dominant[best] = (dominant[best] ?? 0) + 1;
    }
    const top = Object.entries(excess).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, v]) => `${p} ${(v / Math.max(1, sl.length)).toFixed(1)}`).join(', ');
    console.log(`  ${name.padEnd(22)} ${String(all.length).padStart(5)} frames, ${String(sl.length).padStart(4)} over (${(100 * sl.length / all.length).toFixed(0).padStart(3)}%), slow mean ${mean(sl.map(r => r[ci.animate])).toFixed(1)} ms; `
      + `over its median, ms a slow frame: ${top}; dominant: ${Object.entries(dominant).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p} ${n}`).join(', ') || '-'}`);
  };
  group(`first ${earlyMs / 1000} s`, r => r[ci.t] < mapAt + earlyMs);
  group('later', r => r[ci.t] >= mapAt + earlyMs);
  const starts = (run.headings ?? []).map(h => h.t - d.meta.originMs);
  starts.forEach((t, i) => group(`heading ${i + 1}`, r => r[ci.t] >= t && r[ci.t] < (starts[i + 1] ?? Infinity)));
  // A run with a fine page clock (hitch-run.mjs --ff-prefs '{"privacy.reduceTimerPrecision":false}': 20 us steps instead of 1 ms): the figures a 1 ms
  // clock hides. A frame of d ms reads floor(d) or ceil(d) on a 1 ms clock, so it reads over `over` ms with probability clip(d - over, 0, 1): the expected
  // count of frames the integer p95 sees, and the uniform shift of every frame (ms) that brings that count to the allowance, against the shift the true p95 needs.
  if (new Set(anim).size > 3 * (Math.max(...anim) - Math.min(...anim)) / 2 && anim.some(v => v !== Math.round(v))) {
    const expected = s => anim.reduce((c, v) => c + Math.min(1, Math.max(0, v - s - over)), 0), allowed = 0.05 * rows.length;
    let lo = 0, hi = 5; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (expected(m) > allowed) lo = m; else hi = m; }
    console.log(`  fine clock: true p50 ${q(anim, .5).toFixed(2)} p95 ${q(anim, .95).toFixed(2)} p99 ${q(anim, .99).toFixed(2)} ms; frames over 16.7: ${anim.filter(v => v > 16.7).length}; a 1 ms clock reads over ${over} in `
      + `${expected(0).toFixed(0)} frames on average (${(100 * expected(0) / rows.length).toFixed(1)}%); every frame ${hi.toFixed(2)} ms shorter brings that to the allowance, ${Math.max(0, q(anim, .95) - 16.7).toFixed(2)} ms shorter the true p95 to 16.7`);
  }
  // runs of consecutive slow frames
  const runs = {}; let len = 0;
  for (const r of rows) { if (r[ci.animate] > over) len++; else { if (len) runs[Math.min(len, 8)] = (runs[Math.min(len, 8)] ?? 0) + 1; len = 0; } }
  if (len) runs[Math.min(len, 8)] = (runs[Math.min(len, 8)] ?? 0) + 1;
  console.log(`  runs of consecutive slow frames (length 8 = 8 or more: count): ${Object.entries(runs).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  const upload = (s) => mean(s.map(r => r[ci['gl.uploadMB']])), uploadMs = (s) => mean(s.map(r => r[ci['gl.upload']]));
  console.log(`  uploads: slow frames ${upload(slow).toFixed(2)} MB ${uploadMs(slow).toFixed(2)} ms, median-ish frames ${upload(mid).toFixed(2)} MB ${uploadMs(mid).toFixed(2)} ms; frames over 25 ms: ${slow.filter(r => r[ci.animate] > 25).length}`);
  if (profileFile && files.length === 1) {
    const { marks, offset, correlation } = collectorMarks(run, rows, ci, JSON.parse(readFileSync(profileFile, 'utf8')));
    const inside = r => { const a = r[ci.t], b = a + r[ci.animate], o = { GCMinor: 0, GCSlice: 0, CCSlice: 0 };
      for (const m of marks) if (m.b > a && m.a < b) o[m.kind] += Math.min(m.b, b) - Math.max(m.a, a); return o; };
    const sums = slow.map(r => ({ r, ...inside(r) })), gc = x => x.GCMinor + x.GCSlice + x.CCSlice;
    const restSums = rows.filter(r => r[ci.animate] <= over).map(r => inside(r));
    console.log(`  collector (profile clock offset ${offset} ms, r=${correlation.toFixed(2)}): in slow frames minor ${mean(sums.map(x => x.GCMinor)).toFixed(2)} slice ${mean(sums.map(x => x.GCSlice)).toFixed(2)} cc ${mean(sums.map(x => x.CCSlice)).toFixed(2)} ms; `
      + `in the other frames minor ${mean(restSums.map(x => x.GCMinor)).toFixed(2)} slice ${mean(restSums.map(x => x.GCSlice)).toFixed(2)} cc ${mean(restSums.map(x => x.CCSlice)).toFixed(2)} ms`);
    console.log(`  slow frames holding >= 1 ms of collector: ${sums.filter(x => gc(x) >= 1).length} of ${slow.length}; slow frames at or under ${over} ms without it: ${sums.filter(x => x.r[ci.animate] - gc(x) <= over).length}`);
  }
}
