// The original's registry traffic and Galaxy PlaySound calls against Play's, for one live scene
// (docs/object-index-captures.md "Runtime spawns"). The original's side is the tracer's `call` records of
// UObject::AddObject (0x10157830, `addobj`), UnhashObject (0x10157760, `unhash`) and UAudioSubsystem::PlaySound
// (Galaxy 0x10608100, `gplay`) in original-trace<tag>.jsonl.calls.jsonl; Play's is objects-play<tag>.json and
// sounds-play<tag>.json (`live-acceptance.mjs play --object-trace first:last`, the slot model started from
// registry-start<tag>.txt).
//
//   node scripts/live-sound-compare.mjs --map 06_HongKong_WanChai_Underworld --tag snd1 [--list] [--gate]
//
// --gate (the Stage 4 gate's row 4.3.6, docs/stage-4-exit-criteria.md): the strict comparison. Per tick, the original's calls and Play's are
// lined up in the order they were made and every call must be equal in its sound, emitter class, volume bits, radius, pitch bits and channel
// id (slot and sequence); the last line is `GATE {json}` and the exit status is 1 while any tick differs. The scene's replay is Play's
// (`live-acceptance.mjs play --tag T --no-ghost --object-trace 1:N` after the `population` step); the original's side is the stored calls file.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const map = option('map', '06_HongKong_WanChai_Underworld'), tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const dir = path.join(root, '.work/live-acceptance', map);
const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
const calls = readFileSync(path.join(dir, `original-trace${suffix}.jsonl.calls.jsonl`), 'utf8').split('\n').filter(Boolean).map(parse);
const objectsPlay = JSON.parse(readFileSync(path.join(dir, `objects-play${suffix}.json`), 'utf8'));
const soundsPlay = JSON.parse(readFileSync(path.join(dir, `sounds-play${suffix}.json`), 'utf8'));
const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value); return view.getUint32(0); };
const int32 = word => parseInt(word, 16) | 0;
const word = (list, i) => parseInt(list[i], 16) >>> 0;
const f32 = value => { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, value); return view.getFloat32(0); };
// The number a runtime-created object carries in its name is its class's running counter: it counts what the process loaded
// before, so the two programs' differ (docs/visual-acceptance.md "runtimeNumbered"). Compare the class.
const stem = name => String(name ?? '').replace(/\d+$/, '');

// --- the original's records --------------------------------------------------
const oSounds = calls.filter(r => r.fn === 'gplay' && r.ev === 'enter').map(r => ({u: r.u, inTick: r.inTick, actor: r.arg0Name === 'None' ? null : r.arg0Name,
  id: int32(r.args[1]), sound: r.argName, location: [3, 4, 5].map(i => f32(word(r.args, i))), volume: f32(word(r.args, 6)), radius: f32(word(r.args, 7)),
  pitch: f32(word(r.args, 8)), seq: r.seq}));
const oAdds = calls.filter(r => r.fn === 'addobj' && r.ev === 'ret').map(r => ({u: r.u, cls: r.ecxClass, name: r.ecxName, index: r.ecxIndex, seq: r.seq}));
const oFrees = calls.filter(r => r.fn === 'unhash' && r.ev === 'ret').map(r => ({u: r.u, cls: r.ecxClass, name: r.ecxName, index: r.ecxIndex, seq: r.seq}));
const oHears = calls.filter(r => r.fn === 'hear' && r.ev === 'enter').map(r => ({u: r.u, ecx: r.ecxName, emitter: r.arg0Name, id: int32(r.args[1]), sound: r.argName}));

console.log(`original: ${oAdds.length} AddObject, ${oFrees.length} UnhashObject, ${oSounds.length} Galaxy PlaySound, ${oHears.length} ClientHearSound`);
console.log(`play:     ${objectsPlay.filter(o => o.ev === 'add').length} adds, ${objectsPlay.filter(o => o.ev === 'free').length} frees, ${soundsPlay.length} Galaxy PlaySound`);

// --- registry events ----------------------------------------------------------
const count = list => list.reduce((m, o) => (m.set(stem(o.cls), (m.get(stem(o.cls)) ?? 0) + 1), m), new Map());
const pAdds = objectsPlay.filter(o => o.ev === 'add').map(o => ({u: o.u, cls: o.cls, name: o.name, index: o.index}));
const histogram = (label, a, b) => {
  const ca = count(a), cb = count(b), keys = new Set([...ca.keys(), ...cb.keys()]);
  const rows = [...keys].map(k => [k, ca.get(k) ?? 0, cb.get(k) ?? 0]).filter(r => r[1] !== r[2]).sort((x, y) => Math.abs(y[1] - y[2]) - Math.abs(x[1] - x[2]));
  console.log(`${label}: classes created (original / play) that differ: ${rows.length}`);
  for (const [k, x, y] of rows.slice(0, 40)) console.log(`   ${String(k).padEnd(32)} ${String(x).padStart(5)} ${String(y).padStart(5)}`);
};
histogram('AddObject', oAdds, pAdds);
// the indices, in order: the first difference of the two sequences
const firstDifference = (a, b, label) => {
  let i = 0; while (i < a.length && i < b.length && a[i].index === b[i].index && stem(a[i].cls) === stem(b[i].cls)) i++;
  console.log(`${label}: the first ${i} of ${a.length}/${b.length} registry takes agree in class and slot${i < Math.max(a.length, b.length) ? `; then original ${JSON.stringify(a[i])} play ${JSON.stringify(b[i])}` : ''}`);
};
firstDifference(oAdds, pAdds, 'AddObject sequence');
if (flag('list')) {
  const n = Math.max(oAdds.length, pAdds.length);
  for (let i = 0; i < n; i++) console.log(`${String(i).padStart(4)}  ${oAdds[i] ? `u${oAdds[i].u} ${oAdds[i].index} ${oAdds[i].cls}.${oAdds[i].name}` : ''}`.padEnd(70) + (pAdds[i] ? `u${pAdds[i].u} ${pAdds[i].index} ${pAdds[i].cls}` : ''));
}

// --- Galaxy PlaySound ---------------------------------------------------------
// Calls are matched by tick, emitter class and sound (the order inside a tick differs where the programs' actors tick in another
// order), then compared in volume, radius, pitch and channel id. An emitter whose slot is at or above the registry's size at the
// frozen start was created during the scene: its id is the model's; the others' is the run's own measured index.
const startCount = Number(/objects=(\d+)/.exec(readFileSync(path.join(dir, `registry-start${suffix}.txt`), 'utf8').split('\n', 1)[0])?.[1]);
const soundKey = c => `${c.u}|${stem(c.actor)}|${String(c.sound ?? '').split('.').pop().toLowerCase()}`;
const buckets = new Map();
for (const call of soundsPlay) { const key = soundKey(call); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(call); }
const matched = [], onlyOriginal = [];
for (const o of oSounds) {
  const list = buckets.get(soundKey(o));
  const at = list ? list.findIndex(p => bits(p.volume) === bits(o.volume) && bits(p.pitch) === bits(o.pitch) && p.radius === o.radius) : -1;
  if (at < 0) { onlyOriginal.push(o); continue; }
  matched.push({o, p: list.splice(at, 1)[0]});
}
const onlyPlay = [...buckets.values()].flat();
const spawned = c => (c.id >> 4) >= startCount;
const summary = label => {
  const rows = matched.filter(({o}) => label === 'all' || (label === 'spawned') === spawned(o));
  const idsEqual = rows.filter(({o, p}) => o.id === p.id).length;
  console.log(`  ${label.padEnd(10)} ${String(rows.length).padStart(4)} calls matched in tick, emitter, sound, volume, radius and pitch; channel id equal in ${idsEqual}`);
};
console.log(`Galaxy PlaySound: original ${oSounds.length} calls, play ${soundsPlay.length}; ${matched.length} matched, ${onlyOriginal.length} only the original's, ${onlyPlay.length} only Play's`);
summary('all'); summary('pre-placed'); summary('spawned');
const fmt = c => `u${c.u} ${c.actor ?? 'None'} id=${c.id} (slot ${c.id >> 4}) ${String(c.sound ?? '').split('.').pop()} vol=${+(c.volume ?? 0).toPrecision(6)}`;
const showN = Number(option('show', 12));
for (const {o, p} of matched.filter(({o, p}) => o.id !== p.id).slice(0, showN)) console.log(`  id differs: original ${fmt(o)}  play id=${p.id} (slot ${p.id >> 4})`);
for (const o of onlyOriginal.slice(0, showN)) console.log(`  only the original: ${fmt(o)}`);
for (const p of onlyPlay.slice(0, showN)) console.log(`  only Play:         ${fmt(p)}`);
// --- the strict comparison (--gate) --------------------------------------------
const strictKey = c => [stem(c.actor), String(c.sound ?? '').split('.').pop().toLowerCase(), bits(c.volume), c.radius, bits(c.pitch), c.id].join('|');
const ticksOf = list => { const m = new Map(); for (const c of list) { if (!m.has(c.u)) m.set(c.u, []); m.get(c.u).push(c); } return m; };
const oByTick = ticksOf(oSounds), pByTick = ticksOf(soundsPlay);
const allTicks = [...new Set([...oByTick.keys(), ...pByTick.keys()])].sort((a, b) => a - b);
let equalCalls = 0, equalTicks = 0, firstDifferentTick = null, orderOnlyTicks = 0;
const differing = [];
for (const u of allTicks) {
  const a = oByTick.get(u) ?? [], b = pByTick.get(u) ?? [];
  let same = a.length === b.length;
  if (same) for (let i = 0; i < a.length; i++) if (strictKey(a[i]) !== strictKey(b[i])) same = false;
  if (same) { equalTicks++; equalCalls += a.length; continue; }
  firstDifferentTick ??= u;
  const sorted = list => list.map(strictKey).sort().join('\n');
  if (a.length === b.length && sorted(a) === sorted(b)) orderOnlyTicks++;
  differing.push({u, original: a.length, play: b.length});
}
const gate = {originalCalls: oSounds.length, playCalls: soundsPlay.length, ticksWithCalls: allTicks.length, equalTicks, equalCalls, differingTicks: differing.length,
  orderOnlyTicks, firstDifferentTick, matchedLoosely: matched.length, idsEqualLoosely: matched.filter(({o, p}) => o.id === p.id).length, firstDifferentRegistryTake: null};
{
  let i = 0; while (i < oAdds.length && i < pAdds.length && oAdds[i].index === pAdds[i].index && stem(oAdds[i].cls) === stem(pAdds[i].cls)) i++;
  gate.registryTakesEqual = i; gate.registryTakes = [oAdds.length, pAdds.length];
  gate.firstDifferentRegistryTake = i < Math.max(oAdds.length, pAdds.length) ? {original: oAdds[i] ? `${oAdds[i].cls}@${oAdds[i].index} u${oAdds[i].u}` : null, play: pAdds[i] ? `${pAdds[i].cls}@${pAdds[i].index} u${pAdds[i].u}` : null} : null;
}
if (flag('gate')) {
  console.log(`strict: ${equalTicks} of ${allTicks.length} ticks with sound calls equal in order, sound, emitter, volume, radius, pitch and channel id (${equalCalls} of ${oSounds.length} calls); first differing tick ${firstDifferentTick ?? 'none'}`);
  console.log(`GATE ${JSON.stringify(gate)}`);
  process.exitCode = firstDifferentTick === null ? 0 : 1;
}
writeFileSync(path.join(dir, `sound-compare${suffix}.json`), JSON.stringify({oAdds, pAdds, oFrees, oSounds, soundsPlay, oHears}, null, 1));
