// The drawn-frame gaps of a Firefox hitch-run (scripts/hitch-run.mjs --browser firefox --profile FILE), each with the GC and CC pauses
// of the Gecko profile that overlap it: the page's main thread inline, the simulation worker's thread with ?sim=worker. Host
// measurement (docs/hitch-log.md "Firefox"; Stage 7 row 7.2.4).
//
//   node scripts/gecko-gaps.mjs RUN.json PROFILE.json [--gap 50] [--skip 5] [--thread page|worker]
//
// The two clocks are joined by search: the hitch log's rows count from the page's `meta.started` (a system-clock date) plus an offset
// within 3 s, and the profile's markers from each process's `meta.startTime` (system clock too); the offset that puts the most
// gaps over a pause of 15 ms or more wins (inline on the Island, 2026-10-31: -14 ms, so the dates agree to the clocks' precision).
// A 'CC' marker spans the whole collection interval, not a pause, and is not counted.
import {readFileSync} from 'node:fs';
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const [run, prof] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const gapMs = Number(option('gap', 50)), skipS = Number(option('skip', 5)), thread = option('thread', 'page');
const r = JSON.parse(readFileSync(run, 'utf8')), p = JSON.parse(readFileSync(prof, 'utf8'));
const cols = r.dump.meta.columns, T = cols.indexOf('t'), D = cols.indexOf('drawn');
const drawn = r.dump.rows.filter(row => row[D]).map(row => row[T]);
// from --skip seconds after the map became current, as scripts/hitch-summary.mjs counts
const map = r.dump.events.filter(e => e.kind === 'map').at(-1)?.t ?? 0, from = map + skipS * 1000, gaps = [];
for (let i = 1; i < drawn.length; i++) if (drawn[i] >= from && drawn[i] - drawn[i - 1] > gapMs) gaps.push([drawn[i - 1], drawn[i]]);
const pauses = [], name = thread === 'worker' ? 'DOM Worker' : 'GeckoMain';
const walk = q => {
  for (const t of q.threads ?? []) if (t.processName === 'Web Content' && t.name === name) {
    const S = t.stringTable, sc = t.markers.schema;
    for (const row of t.markers.data) {
      const kind = S[row[sc.name]]; if (!['GCSlice', 'GCMinor', 'CCSlice', 'GCMajor'].includes(kind)) continue;
      const start = q.meta.startTime + row[sc.startTime], end = q.meta.startTime + (row[sc.endTime] || row[sc.startTime]);
      // a GCMajor marker spans an incremental cycle; it is a pause only where the cycle had one slice (a worker's non-incremental GC)
      const slices = row[sc.data]?.timings?.slices;
      if (kind === 'GCMajor' && slices !== 1) continue;
      pauses.push({kind, start, end, ms: end - start, reason: row[sc.data]?.timings?.reason ?? ''});
    }
  }
  for (const c of q.processes ?? []) walk(c);
};
walk(p);
const base = Date.parse(r.dump.meta.started), overlap = (s, off, [a, b]) => s.start < off + b && s.end > off + a;
let best = null;
for (let off = base - 3000; off <= base + 3000; off++) {
  let hit = 0; for (const gap of gaps) if (pauses.some(s => s.ms >= 15 && overlap(s, off, gap))) hit++;
  if (!best || hit > best.hit) best = {off, hit};
}
const held = gaps.map(gap => Math.max(0, ...pauses.filter(s => s.kind !== 'GCMinor' && overlap(s, best.off, gap)).map(s => s.ms)));
console.log(`${run}: ${gaps.length} gaps over ${gapMs} ms from ${skipS} s after the map; ${pauses.filter(s => s.ms >= 15).length} ${thread} pauses >= 15 ms;`
  + ` offset ${best.off - base} ms; major-GC or CC slices in ${held.filter(ms => ms >= 15).length} (>= 15 ms), ${held.filter(ms => ms > 0 && ms < 15).length} (< 15 ms),`
  + ` none in ${held.filter(ms => !ms).length}`);
for (const gap of gaps) {
  const inside = pauses.filter(s => s.ms >= 2 && overlap(s, best.off, gap)).map(s => `${s.kind} ${s.ms.toFixed(0)}${s.reason ? ` ${s.reason}` : ''}`);
  console.log(`  ${((gap[0] - map) / 1000).toFixed(1)} s gap ${(gap[1] - gap[0]).toFixed(0)} ms: ${inside.join(', ') || '-'}`);
}
