// The original's draws of the first unfrozen tick per actor and per call site, against Play's per-actor counts (docs/visual-acceptance.md "Live scenes",
// Divergence 14). Needs the original captured with `--actor-trace 1:1` (the stream state at every AActor::Tick entry of tick 1) and the call
// breakpoints on the CRT's draws (`--extra-config` with: call-ticks 1 1 / call 0x101232e0 frand 0 always / call 0x101232d0 rand 1 always), whose
// "ret" is the caller's address (script FRand 0x101362ac, script Rand 0x1013499e, the Engine AI's 0x1036d0de / 0x1036d152), and Play replayed with
// `--draw-trace`.
//
//   node scripts/live-draw-attr.mjs --map 02_NYC_BatteryPark --tag b1 [--actor mib1]   # the actors whose counts differ, and --actor's call sites
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
const map = option('map'), tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const dir = path.join(root, '.work/live-acceptance', map), trace = path.join(dir, `original-trace${suffix}.jsonl`);
const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
const row = readFileSync(trace, 'utf8').trim().split('\n').map(parse).find(r => r.unfrozen >= 1);
const step = s => (Math.imul(s, 214013) + 2531011) >>> 0;
const index = new Map(); let x = parseInt(row.rngIn, 16) >>> 0; index.set(x, 0);
let total = 0; for (const target = parseInt(row.rngOut, 16) >>> 0; x !== target && total < 1e6;) { x = step(x); total++; index.set(x, total); }
const entries = readFileSync(`${trace}.actors.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(parse).filter(e => e.u === 1)
  .map(e => ({actor: e.actor, at: index.get(parseInt(e.rng, 16) >>> 0)}));
const calls = existsSync(`${trace}.calls.jsonl`) ? readFileSync(`${trace}.calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(parse).filter(e => e.ev === 'enter') : [];
const perActor = new Map();
entries.forEach((entry, i) => {
  const to = i + 1 < entries.length ? entries[i + 1].at : total;
  if (entry.at === undefined || to === undefined) return;
  const m = perActor.get(entry.actor) ?? {draws: 0, order: i, sites: new Map()};
  m.draws += to - entry.at; perActor.set(entry.actor, m);
});
const ownerAt = k => { let lo = 0, hi = entries.length - 1, best = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (entries[mid].at <= k) { best = mid; lo = mid + 1; } else hi = mid - 1; } return best === null ? null : entries[best].actor; };
for (const c of calls) {
  const k = index.get(parseInt(c.rng, 16) >>> 0), m = k === undefined ? null : perActor.get(ownerAt(k));
  if (m) { const key = `${c.fn}@${c.ret}`; m.sites.set(key, (m.sites.get(key) ?? 0) + 1); }
}
// Play's per-actor counts by lowercase name (the original's `mib1` is Play's `MIB1`, Divergence 14)
const play = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(dir, `play-rows${suffix}.json`), 'utf8')).rows[0].draws).map(([k, v]) => [k === '-' ? k : k.toLowerCase(), v]));
const wanted = option('actor', null);
console.log(`tick 1: original ${total} draws (${calls.length} CRT calls seen), ${entries.length} AActor::Tick entries; Play ${Object.entries(play).filter(([k]) => k !== '-').reduce((a, [, v]) => a + v, 0)} in actors`);
const original = new Map([...perActor].map(([k, v]) => [k.toLowerCase(), [k, v]]));
for (const key of new Set([...original.keys(), ...Object.keys(play).filter(k => k !== '-')])) {
  const name = original.get(key)?.[0] ?? key, o = original.get(key)?.[1].draws ?? 0, p = play[key] ?? 0;
  if (o !== p || (wanted && key === wanted.toLowerCase())) console.log(`${name}: original ${o} draws (entry ${original.get(key)?.[1].order ?? '-'} of ${entries.length}), Play ${p}  ${original.get(key) ? [...original.get(key)[1].sites].map(([k, v]) => `${k} x${v}`).join(' ') : ''}`);
}
