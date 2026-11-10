// The major collections of a Firefox run (scripts/hitch-run.mjs --browser firefox --profile FILE [--gc-markers]), one line each: when it
// started (seconds of the hitch log, the page's `meta.started` clock as scripts/gecko-gaps.mjs joins them, without its search), its
// reason, the wall time from its first slice to its last, its slices' total and marking time, and the slices whose budget SpiderMonkey
// raised because the collection had run too long. Host measurement (docs/firefox-60fps-plan.md "The collector's window"; Stage 7 row
// 7.2.4).
//
//   node scripts/gecko-gc-windows.mjs PROFILE.json [RUN.json] [--thread page|worker] [--json] [--vsync [--period MS]]
//
// --vsync (page thread): where the frames fall against the refresh driver's idle deadline. Gecko slices in idle time only when
// `now + 5 ms < mostRecentRefresh + period - 1 ms` (IdleTaskRunner, nsRefreshDriver::GetIdleDeadlineHint; 2.5 ms and 0.5 ms at
// 120 Hz: both scale with the rate over 17 ms, nsRefreshDriver::HighRateMultiplier), so an idle slice's budget dates the vsync it
// counted from: vsync = start + budget + limit - period. Printed: the period (the display rate nearest the median spacing of
// RefreshDriverTick starts, or --period), the next tick's start after that vsync (the tick's lag), the ticks' lengths, and per
// collection over 1.4 s how many frames were followed by an idle slice.
//
// SpiderMonkey (js/src/gc/GC.cpp, GCRuntime::maybeIncreaseSliceBudgetForLongCollections) gives every slice of a collection that started
// more than 1.5 s before an uninterruptible minimum budget, rising linearly from 0 ms at 1.5 s to 100 ms at 2.5 s; such a slice's
// budget reads "(started idle but extended)" or has lost its "interruptible" (ExtendBudget). Those are the slices counted as
// `extended`. A collection whose wall time stays under 1.5 s has none.
import {readFileSync} from 'node:fs';
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const [profFile, runFile] = args.filter((a, i) => !a.startsWith('--') && !['--thread', '--period'].includes(args[i - 1]));
const thread = option('thread', 'page'), asJson = args.includes('--json'), vsync = args.includes('--vsync');
const p = JSON.parse(readFileSync(profFile, 'utf8'));
const r = runFile ? JSON.parse(readFileSync(runFile, 'utf8')) : null;
const base = r ? Date.parse(r.dump.meta.started) : null;
const mapAt = r ? (r.dump.events.filter(e => e.kind === 'map').at(-1)?.t ?? 0) : 0;
const name = thread === 'worker' ? 'DOM Worker' : 'GeckoMain';
const majors = new Map(), ticks = [], idleSlices = [];
const walk = q => {
  for (const t of q.threads ?? []) if (t.processName === 'Web Content' && t.name === name) {
    const S = t.stringTable, sc = t.markers.schema;
    for (const row of t.markers.data) {
      const kind = S[row[sc.name]];
      if (kind === 'RefreshDriverTick' && row[sc.startTime] > 0 && row[sc.endTime]) ticks.push([row[sc.startTime], row[sc.endTime]]);
      if (kind !== 'GCSlice' && kind !== 'GCMajor') continue;
      const timings = row[sc.data]?.timings; if (!timings) continue;
      const key = `${t.pid}.${timings.major_gc_number}`;
      const m = majors.get(key) ?? { slices: [], major: null, origin: q.meta.startTime };
      const start = row[sc.startTime], end = row[sc.endTime] || start;
      if (kind === 'GCMajor') m.major = { start, end, timings };
      else {
        m.slices.push({ start, end, pause: timings.pause, budget: String(timings.budget ?? ''), reason: timings.reason,
          mark: timings.times?.mark ?? 0, sweep: timings.times?.sweep ?? 0 });
        const idle = String(timings.budget ?? '').match(/^interruptible ([\d.]+)ms \(idle\)$/);
        if (idle) idleSlices.push({ start, budget: Number(idle[1]), major: key });
      }
      majors.set(key, m);
    }
  }
  for (const c of q.processes ?? []) walk(c);
};
walk(p);
const extendedBudget = b => /extended/.test(b) || (/^\d/.test(b) && !/interruptible|unlimited|work/.test(b));
const rows = [];
for (const m of majors.values()) {
  if (!m.major || !m.slices.length) continue;
  const t = m.major.timings, first = Math.min(...m.slices.map(s => s.start)), last = Math.max(...m.slices.map(s => s.end));
  const ext = m.slices.filter(s => extendedBudget(s.budget));
  rows.push({
    at: base === null ? first / 1000 : (m.origin + first - base - mapAt) / 1000,
    reason: t.reason, zones: `${t.zones_collected}/${t.total_zones}`, wallMs: last - first, totalMs: t.total_time,
    markMs: t.totals?.mark ?? null, slices: m.slices.length, idle: m.slices.filter(s => /idle/.test(s.budget)).length,
    maxPause: Math.max(...m.slices.map(s => s.pause)), extended: ext.length, extendedMs: ext.reduce((n, s) => n + s.pause, 0),
    firstExtendedAtMs: ext.length ? Math.min(...ext.map(s => s.start)) - first : null,
  });
}
rows.sort((a, b) => a.at - b.at);
if (asJson) { console.log(JSON.stringify(rows)); process.exit(0); }
const f = (n, d = 1) => n === null ? '-' : n.toFixed(d);
console.log(`${thread} thread, ${rows.length} major collections (at: seconds ${r ? 'after the map became current, hitch log clock' : 'of the profile'})`);
console.log('at s | reason | zones | wall ms | total ms | mark ms | slices (idle) | longest slice | extended slices (ms, first at ms)');
for (const x of rows) console.log(`${f(x.at)} | ${x.reason} | ${x.zones} | ${f(x.wallMs, 0)} | ${f(x.totalMs)} | ${f(x.markMs)} | ${x.slices} (${x.idle}) | ${f(x.maxPause)} | `
  + (x.extended ? `${x.extended} (${f(x.extendedMs)}, ${f(x.firstExtendedAtMs, 0)})` : '0'));
if (vsync && ticks.length > 10) {
  ticks.sort((a, b) => a[0] - b[0]);
  const q = (a, p) => { a = a.filter(x => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return a.length ? f(a[Math.min(a.length - 1, Math.floor(a.length * p))], 2) : '-'; };
  // the display rate nearest the ticks' median spacing (late ticks stretch it), or --period MS
  const spacing = ticks.slice(1).map((t, i) => t[0] - ticks[i][0]).filter(d => d > 2 && d < 40), median = Number(q(spacing, 0.5));
  const period = Number(option('period', 0)) || 1000 / [60, 75, 90, 100, 120, 144, 165, 240].reduce((b, hz) => Math.abs(1000 / hz - median) < Math.abs(1000 / b - median) ? hz : b);
  // layout.idle_period.time_limit (1 ms) times nsRefreshDriver::HighRateMultiplier (the rate's interval over round(1000 / 60) ms)
  const limit = Math.min(1, period / 17);
  const lag = idleSlices.map(x => { const v = x.start + x.budget + limit - period, next = ticks.find(([s]) => s >= v - 1); return next ? next[0] - v : null; });
  const len = ticks.map(([s, e]) => e - s);
  console.log(`\nvsync: tick period ${f(period, 2)} ms; idle slices ${idleSlices.length}; the next tick's start after the vsync their budgets imply `
    + `p10/50/90 ${q(lag, 0.1)} / ${q(lag, 0.5)} / ${q(lag, 0.9)} ms; tick with paint p10/50/90 ${q(len, 0.1)} / ${q(len, 0.5)} / ${q(len, 0.9)} ms`);
  for (const [key, m] of majors) {
    if (!m.major || !m.slices.length) continue;
    const first = Math.min(...m.slices.map(s => s.start)), last = Math.max(...m.slices.map(s => s.end));
    if (last - first < 1400) continue;
    let followed = 0, frames = 0;
    for (let i = 0; i + 1 < ticks.length; i++) {
      const [s, e] = ticks[i]; if (s < first || s > last) continue; frames++;
      if (idleSlices.some(x => x.major === key && x.start >= e && x.start < ticks[i + 1][0])) followed++;
    }
    console.log(`  ${m.major.timings.reason}: ${followed} of ${frames} frames followed by an idle slice`);
  }
}
