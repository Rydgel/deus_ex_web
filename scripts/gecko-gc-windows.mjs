// The major collections of a Firefox run (scripts/hitch-run.mjs --browser firefox --profile FILE [--gc-markers]), one line each: when it
// started (seconds of the hitch log, the page's `meta.started` clock as scripts/gecko-gaps.mjs joins them, without its search), its
// reason, the wall time from its first slice to its last, its slices' total and marking time, and the slices whose budget SpiderMonkey
// raised because the collection had run too long. Host measurement (docs/firefox-60fps-plan.md "The collector's window"; Stage 7 row
// 7.2.4).
//
//   node scripts/gecko-gc-windows.mjs PROFILE.json [RUN.json] [--thread page|worker] [--json]
//
// SpiderMonkey (js/src/gc/GC.cpp, GCRuntime::maybeIncreaseSliceBudgetForLongCollections) gives every slice of a collection that started
// more than 1.5 s before an uninterruptible minimum budget, rising linearly from 0 ms at 1.5 s to 100 ms at 2.5 s; such a slice's
// budget reads "(started idle but extended)" or has lost its "interruptible" (ExtendBudget). Those are the slices counted as
// `extended`. A collection whose wall time stays under 1.5 s has none.
import {readFileSync} from 'node:fs';
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const [profFile, runFile] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--thread'));
const thread = option('thread', 'page'), asJson = args.includes('--json');
const p = JSON.parse(readFileSync(profFile, 'utf8'));
const r = runFile ? JSON.parse(readFileSync(runFile, 'utf8')) : null;
const base = r ? Date.parse(r.dump.meta.started) : null;
const mapAt = r ? (r.dump.events.filter(e => e.kind === 'map').at(-1)?.t ?? 0) : 0;
const name = thread === 'worker' ? 'DOM Worker' : 'GeckoMain';
const majors = new Map();
const walk = q => {
  for (const t of q.threads ?? []) if (t.processName === 'Web Content' && t.name === name) {
    const S = t.stringTable, sc = t.markers.schema;
    for (const row of t.markers.data) {
      const kind = S[row[sc.name]]; if (kind !== 'GCSlice' && kind !== 'GCMajor') continue;
      const timings = row[sc.data]?.timings; if (!timings) continue;
      const key = `${t.pid}.${timings.major_gc_number}`;
      const m = majors.get(key) ?? { slices: [], major: null, origin: q.meta.startTime };
      const start = row[sc.startTime], end = row[sc.endTime] || start;
      if (kind === 'GCMajor') m.major = { start, end, timings };
      else m.slices.push({ start, end, pause: timings.pause, budget: String(timings.budget ?? ''), reason: timings.reason,
        mark: timings.times?.mark ?? 0, sweep: timings.times?.sweep ?? 0 });
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
