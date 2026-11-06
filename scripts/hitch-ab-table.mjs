// The figures of a scripts/hitch-ab.mjs run, one row per session, for A/B reports: over the drawn frames from --skip seconds after the
// map, the mean tick (`p.tick`), the mean of the slowest tenth of ticks, and the page's frame work (`animate`): its mean, the mean of
// its own slowest tenth, p50 and p95; then each arm's mean over its sessions. Host measurement only.
//
//   node scripts/hitch-ab-table.mjs DIR PREFIX [--skip 5] [--slow 0.1]     (reads DIR/PREFIX-<arm>-<n>.json)
import {readFileSync,readdirSync} from 'node:fs';
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const [dir, prefix] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const skip = Number(option('skip', 5)) * 1000, slow = Number(option('slow', 0.1));
const files = readdirSync(dir).filter(f => f.startsWith(`${prefix}-`) && /-\d+\.json$/.test(f)).sort();
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const rows = [];
for (const f of files) {
  const [, arm, n] = f.slice(prefix.length).match(/^-(.+)-(\d+)\.json$/);
  const d = JSON.parse(readFileSync(`${dir}/${f}`)).dump, ci = Object.fromEntries(d.columns.map((c, i) => [c, i]));
  const mapAt = d.events.filter(e => e.kind === 'map').at(-1)?.t ?? 0;
  const frames = d.rows.filter(r => r[ci.drawn] && r[ci.t] >= mapAt + skip);
  const tick = frames.map(r => r[ci['p.tick']]).sort((a, b) => a - b), page = frames.map(r => r[ci.animate]).sort((a, b) => a - b);
  const top = tick.slice(Math.floor(tick.length * (1 - slow))), pageTop = page.slice(Math.floor(page.length * (1 - slow)));
  rows.push({arm, n: Number(n), frames: frames.length, tick: mean(tick), slow: mean(top), pageMean: mean(page), pageSlow: mean(pageTop),
    p50: percentile(page, 0.5), p95: percentile(page, 0.95)});
}
const fmt = r => `${r.arm.padEnd(8)} ${String(r.n).padStart(2)} ${String(r.frames).padStart(6)}  tick ${r.tick.toFixed(2)}  slowest tenth ${r.slow.toFixed(2)}  page mean ${r.pageMean.toFixed(2)} slowest tenth ${r.pageSlow.toFixed(2)} p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)}`;
for (const r of rows.sort((a, b) => a.n - b.n || a.arm.localeCompare(b.arm))) console.log(fmt(r));
console.log('means over sessions');
for (const arm of [...new Set(rows.map(r => r.arm))]) {
  const m = rows.filter(r => r.arm === arm), avg = k => mean(m.map(r => r[k]));
  console.log(`${arm.padEnd(8)} ${String(m.length).padStart(2)} ${''.padStart(6)}  tick ${avg('tick').toFixed(2)}  slowest tenth ${avg('slow').toFixed(2)}  page mean ${avg('pageMean').toFixed(2)} slowest tenth ${avg('pageSlow').toFixed(2)} p50 ${avg('p50').toFixed(1)} p95 ${avg('p95').toFixed(1)}`);
}
