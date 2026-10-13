// The AI event manager's traffic of a live capture, Play against the original (docs/visual-acceptance.md "Weapon noise").
//
//   original: live-original.sh <map> ... --extra-config <cfg> --tag T   with the cfg's `call` breakpoints at UEventManager::AISendEvent
//             (0x10382c60), AIStartEvent (0x10382fe0), AIEndEvent (0x103831e0), AIClearEvent (0x103832c0) and AIEvent (0x10384980, the
//             callback delivery) and `fname` on the FName arguments: <trace>.calls.jsonl;
//   Play:     live-acceptance.mjs play ... --event-trace 1:700 --tag T: events-play<T>.json (AiEventHost.trace).
//
//   node scripts/live-events-compare.mjs --map 06_HongKong_WanChai_Underworld --tag T [--show N] [--from U --to U]
//
// Per unfrozen tick (u: the tick's own calls, and the console commands typed after it), the sequences of sends, starts, ends, clears and
// delivered callbacks (receiver, event, callback, state, best sender, score, visibility, volume, smell) must be equal in order and value
// (float32). Objects the two programs create while running are numbered by their own creation order, so those names compare without the
// number (the player JCDentonMale, weapons, ammo).
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const map = option('map', '06_HongKong_WanChai_Underworld'), tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const dir = path.join(root, '.work/live-acceptance', map);
const from = Number(option('from', 0)), to = Number(option('to', 1e9)), show = Number(option('show', 12));
const f32 = Math.fround;
const numbered = /^((?:JCDenton\w*?|Weapon\w+?|Ammo\w+?|Fragment\w*?|Spark\w*?|Shell\w*?|Bullet\w*?))\d+$/;
const norm = name => { const m = numbered.exec(name ?? 'None'); return m ? `${m[1]}#` : (name ?? 'None'); };
const num = x => (x === null || x === undefined ? NaN : f32(x));
const fmt = e => `${e.rng ? `[${e.rng}] ` : ''}${e.fn} ${e.sender ?? e.receiver} ${e.event}${e.callback ? `->${e.callback}` : ''}${e.type !== undefined ? ` type=${e.type} value=${e.value} radius=${e.radius}` : ''}${e.state !== undefined ? ` state=${e.state} best=${e.best} score=${e.score} vis=${e.visibility} vol=${e.volume} smell=${e.smell}` : ''}`;

const callsPath = path.join(dir, `original-trace${suffix}.jsonl.calls.jsonl`), playPath = path.join(dir, `events-play${suffix}.json`);
if (!existsSync(callsPath) || !existsSync(playPath)) { console.error(`need ${callsPath} and ${playPath}`); process.exit(2); }
const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
const original = [];
for (const line of readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)) {
  const r = parse(line);
  if (r.ev !== 'enter') continue;
  const word = i => parseInt(r.args[i], 16) >>> 0;
  if (r.fn === 'aisend' || r.fn === 'aistart') original.push({u: r.u, rng: r.rng, fn: r.fn === 'aisend' ? 'send' : 'start', sender: r.arg0Name, event: r.fnames[0], type: word(2) & 255, value: r.floats[3], radius: r.floats[4]});
  else if (r.fn === 'aiend') original.push({u: r.u, rng: r.rng, fn: 'end', sender: r.arg0Name, event: r.fnames[0], type: word(2) & 255});
  else if (r.fn === 'aiclear') original.push({u: r.u, rng: r.rng, fn: 'clear', sender: r.arg0Name, event: r.fnames[0]});
  else if (r.fn === 'aievent') {
    const d = r.deref?.[0]?.floats ?? [];
    original.push({u: r.u, rng: r.rng, fn: 'event', receiver: r.arg0Name, event: r.fnames[0], callback: r.fnames[1] === 'None' ? 'AIEvent' : r.fnames[1], state: word(2) & 255,
      best: r.argName ?? 'None', score: d[1], visibility: d[2], volume: d[3], smell: d[4]});
  }
}
const play = JSON.parse(readFileSync(playPath, 'utf8'));

const group = list => { const g = new Map(); for (const e of list) { if (e.u < from || e.u > to) continue; if (!g.has(e.u)) g.set(e.u, []); g.get(e.u).push(e); } return g; };
const og = group(original), pg = group(play);
const same = (a, b) => {
  // the CRT rand state at the call (--no-rng: skip): a draw between two manager calls that one side made and the other did not
  if (!process.argv.includes('--no-rng') && a.rng && b.rng && parseInt(a.rng, 16) !== parseInt(b.rng, 16)) return false;
  if (a.fn !== b.fn || norm(a.sender ?? a.receiver) !== norm(b.sender ?? b.receiver) || a.event !== b.event) return false;
  if (a.fn === 'event') return a.callback === b.callback && a.state === b.state && norm(a.best) === norm(b.best)
    && ['score', 'visibility', 'volume', 'smell'].every(k => Object.is(num(a[k]), num(b[k])));
  if (a.fn === 'send' || a.fn === 'start') return a.type === b.type && Object.is(num(a.value), num(b.value)) && Object.is(num(a.radius), num(b.radius));
  if (a.fn === 'end') return a.type === b.type;
  return true;
};
const ticks = [...new Set([...og.keys(), ...pg.keys()])].sort((a, b) => a - b);
let equalTicks = 0, equalEvents = 0, diffs = [];
const kinds = {};
for (const u of ticks) {
  const o = og.get(u) ?? [], p = pg.get(u) ?? [];
  let ok = o.length === p.length;
  for (let i = 0; ok && i < o.length; i++) if (!same(o[i], p[i])) ok = false;
  for (const e of o) kinds[`${e.fn} ${e.event}`] = (kinds[`${e.fn} ${e.event}`] ?? 0) + 1;
  if (ok) { equalTicks++; equalEvents += o.length; } else diffs.push({u, original: o, play: p});
}
console.log(`${map}${tag ? ` ${tag}` : ''}: ${original.length} original events, ${play.length} Play events over ${ticks.length} ticks with events; ${equalTicks} ticks equal (${equalEvents} events), ${diffs.length} ticks differ`);
console.log(JSON.stringify(kinds));
for (const d of diffs.slice(0, show)) {
  console.log(`--- tick ${d.u}: original ${d.original.length}, Play ${d.play.length}`);
  const n = Math.max(d.original.length, d.play.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 14; i++) {
    const a = d.original[i], b = d.play[i];
    if (a && b && same(a, b)) continue;
    console.log(`  #${i} original: ${a ? fmt(a) : '(none)'}\n      Play:     ${b ? fmt(b) : '(none)'}`);
    shown++;
  }
}
process.exitCode = diffs.length ? 1 : 0;
