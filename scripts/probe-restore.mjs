/** Scratch probe (not a validator): open a session on a .dxs file as the level package and compare the live objects with the file. */
import { readdir, readFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createSimSession } from '../src/viewer/sim-session.mjs';
import { ByteWriter } from '../src/runtime/byte-writer.mjs';
import { writeTaggedProperties, TaggedWriteError } from '../src/runtime/tagged-write.mjs';
import { Reader } from '../src/unreal/package.mjs';
import { readObject, readProperties, exportAt } from '../src/unreal/objects.mjs';

const file = process.argv[2], stem = process.argv[3], ticks = Number(process.argv[4] ?? 10);
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const bytes = new Uint8Array(await readFile(file));
const pkg = parsePackage(bytes);
const asset = { name: stem, path: file, bytes, pkg, exportsByPath: new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1])) };
const map = decodeMap(bytes);
const game = await createGame(map, asset, assets, { randomSeed: 1, presentation: true, restore: true,
  travel: { arrival: { map: stem, portal: '', url: `..\\Save\\Current\\${stem}.dxs?Name=Player?Class=DeusEx.JCDentonMale`, options: ['Name=Player', 'Class=DeusEx.JCDentonMale'], travelInfo: [], restore: { file: `${stem}.dxs`, name: stem } }, lastURL: null } });
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
console.log('created; level actors', level.actors.length, 'file actors', map.level.actors.length);

// compare the live objects with the file's tagged values
const byIndex = new Map(); for (const actor of level.actors) if (actor?.index) byIndex.set(actor.index, actor);
const mismatches = new Map(); let compared = 0, missing = 0;
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.fround(a) === Math.fround(b) || (Number.isNaN(a) && Number.isNaN(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return false;
};
for (const actor of map.actors) {
  const live = byIndex.get(actor.index);
  if (!live) { missing++; (mismatches.get('(not in the live level)') ?? mismatches.set('(not in the live level)', []).get('(not in the live level)')).push(actor.name); continue; }
  for (const p of actor.properties) {
    if (!p.decoded || ![1, 2, 3, 4, 6, 13, 11, 12].includes(p.type) && !(p.type === 10 && ['Vector', 'Rotator'].includes(p.struct))) continue;
    let value;
    try { value = runtime.readNamed(live, p.name); } catch (error) { continue; }
    if (Array.isArray(value) && !(p.type === 10 && ['Vector', 'Rotator'].includes(p.struct))) value = value[p.arrayIndex];
    compared++;
    const want = p.type === 6 ? p.value : p.value;
    if (!same(want, value) && !(typeof want === 'string' && String(value).toLowerCase() === want.toLowerCase())) {
      const key = `${actor.className}.${p.name}`;
      const list = mismatches.get(key) ?? mismatches.set(key, []).get(key);
      list.push(`${actor.name}: file ${JSON.stringify(want)} live ${JSON.stringify(value)}`);
    }
  }
}
console.log(`compared ${compared} properties; ${missing} file actors missing; ${mismatches.size} differing (class.property)`);
for (const [key, list] of [...mismatches].sort((a, b) => b[1].length - a[1].length).slice(0, Number(process.env.SHOW ?? 40))) console.log(String(list.length).padStart(5), key, list[0]);

if (process.env.ORDER) {
  // does the class-chain field order of the runtime reproduce the order of the tagged properties in the file?
  const bad = new Map(); let ok = 0;
  for (const actor of map.actors) {
    const live = byIndex.get(actor.index); if (!live) continue;
    let cls = runtime.instance(live).cls;
    const seen = new Set(), order = [];
    for (let node = cls; node; node = node.base) for (const field of node.fields?.values() ?? []) if (!seen.has(field.key)) { seen.add(field.key); order.push(field); }
    const rank = new Map(); order.forEach((field, i) => { const names = rank.get(field.name.toLowerCase()) ?? []; names.push(i); rank.set(field.name.toLowerCase(), names); });
    const fileNames = []; for (const p of actor.properties) if (!fileNames.length || fileNames.at(-1) !== p.name) fileNames.push(p.name);
    let last = -1, inversion = null;
    for (const name of fileNames) { const r = rank.get(name.toLowerCase())?.[0]; if (r === undefined) continue; if (r < last) { inversion = `${name}(${r}) after ${order[last]?.name}(${last})`; break; } last = r; }
    if (inversion) { const key = actor.className; if (!bad.has(key)) bad.set(key, inversion); } else ok++;
  }
  console.log(`order: ${ok} actors in field-chain order, ${bad.size} classes with an inversion`);
  for (const [cls, inv] of [...bad].slice(0, 12)) console.log('  ', cls, inv);
}
if (process.env.META) {
  const live = byIndex.get(Number(process.env.META)); const cls = runtime.instance(live).cls;
  for (let node = cls; node; node = node.base) for (const field of node.fields?.values() ?? []) {
    const m = field.metadata;
    if (['region', 'allianceinfoex', 'simanim', 'location', 'initialinventory', 'tag', 'mesh', 'alliancesex', 'surflist'].includes(field.name.toLowerCase()) || process.env.META_ALL)
      console.log(field.key, m.type, 'dim', m.arrayDim, 'cls', m.className, 'flags', (m.flags >>> 0).toString(16), 'structKey', m.structKey, 'struct', JSON.stringify(m.struct), 'inner', m.innerMetadata?.type, 'members', m.structFields?.map(f => f.name + ':' + f.metadata.type + ':' + (f.metadata.flags >>> 0).toString(16)).join(','));
  }
}
if (process.env.WRITE) {
  const nameIndex = new Map(pkg.names.map((n, i) => [n.name.toLowerCase(), i]));
  const importIndex = new Map(pkg.imports.map((e, i) => [e.path.toLowerCase(), -(i + 1)]));
  const context = {
    nameIndex: text => { const i = nameIndex.get(String(text).toLowerCase()); if (i === undefined) { missingNames.add(String(text)); return 0; } return i; },
    objectRef: v => v === null ? 0 : (v.asset === asset && Number.isInteger(v.index)) ? v.index : typeof v.key === 'string' ? (importIndex.get(v.key.toLowerCase()) ?? (() => { throw new TaggedWriteError('no import for ' + v.key); })()) : Number.isInteger(v.index) ? v.index : (() => { throw new TaggedWriteError('object without index ' + v.name); })(),
    structName: field => field.metadata.struct.name,
  };
  const diffs = new Map(); const missingNames = new Set(); let same = 0, differ = 0, errors = new Map(); const shown = [];
  for (const actor of map.actors) {
    const live = byIndex.get(actor.index); if (!live || actor.className === 'JCDentonMale') continue;
    const cls = runtime.instance(live).cls;
    const seen = new Set(), fields = [];
    for (let node = cls; node; node = node.base) for (const field of node.fields?.values() ?? []) if (!seen.has(field.key)) { seen.add(field.key); fields.push(field); }
    const entry = exportAt(pkg, actor.index);
    const raw = bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
    const r = new Reader(raw); const head = (() => { r.compact(); r.compact(); r.u32(); r.u32(); r.i32(); const node = exportAt(pkg, actor.index) && null; return r.offset; })();
    // the stack header's offset field exists only when Node is non-null
    const stack = actor.stack; const headerLength = (() => { const q = new Reader(raw); q.compact(); q.compact(); q.u32(); q.u32(); q.i32(); if (stack.node) q.compact(); return q.offset; })();
    const w = new ByteWriter();
    try {
      writeTaggedProperties(w, fields, field => runtime.fieldReference(live, field).get(), field => runtime.defaultValue(cls, field), context);
    } catch (error) { const k = error.message.slice(0, 90); errors.set(k, (errors.get(k) ?? 0) + 1); continue; }
    const want = raw.subarray(headerLength), got = w.finish();
    if (Buffer.compare(Buffer.from(want), Buffer.from(got)) === 0) same++; else {
      differ++;
      const key = (() => {
        const A = readProperties(pkg, new Reader(want)).properties, B = readProperties(pkg, new Reader(got)).properties;
        const tag = p => `${p.name}[${p.arrayIndex}]=${Buffer.from(p.data).toString('hex')}`;
        const sa = new Map(A.map(p => [p.name + '[' + p.arrayIndex + ']', tag(p)])), sb = new Map(B.map(p => [p.name + '[' + p.arrayIndex + ']', tag(p)]));
        const out = [];
        for (const [k, v] of sa) if (!sb.has(k)) out.push('missing ' + k); else if (sb.get(k) !== v) out.push('differs ' + v.slice(0, 60) + ' / ' + sb.get(k).slice(0, 60));
        for (const k of sb.keys()) if (!sa.has(k)) out.push('extra ' + k);
        if (!out.length) out.push('same set, different order or encoding of size');
        return out.join('; ');
      })();
      if (process.env.HEX && actor.className === process.env.HEX && !globalThis.hexShown) { globalThis.hexShown = true;
        console.log('WANT', Buffer.from(want).toString('hex')); console.log('GOT ', Buffer.from(got).toString('hex'));
        const A = readProperties(pkg, new Reader(want)).properties, B = readProperties(pkg, new Reader(got)).properties;
        console.log('want order', A.map(x => x.name + ':' + x.type).join(' ')); console.log('got  order', B.map(x => x.name + ':' + x.type).join(' ')); }
      if (process.env.PP && /extra PrunedPaths/.test(key) && !globalThis.ppShown) { globalThis.ppShown = true;
        for (const n of ['OldPos', 'OldRot', 'Location', 'KeyNum', 'BasePos']) { const field = fields.find(f => f.name === n); console.log('PP', actor.name, n, 'live', JSON.stringify(runtime.fieldReference(live, field).get()), 'default', JSON.stringify(runtime.defaultValue(cls, field)), 'file', JSON.stringify(actor.properties.filter(p => p.name === n).map(p => p.value))); } }
      const group = `${actor.className}: ${key}`.slice(0, 220);
      diffs.set(group, (diffs.get(group) ?? 0) + 1);
    }
  }
  console.log(`WRITE: ${same} actors byte-identical, ${differ} differ, errors:`, [...errors].slice(0, 12));
  for (const [k, n] of [...diffs].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(String(n).padStart(5), k); console.log('names missing from the file table:', [...missingNames].join(' '));
}
const sim = createSimSession(game, { assets });
for (let i = 0; i < ticks; i++) { game.tick(1 / 60); sim.sprites(); }
console.log('ticked', ticks);
console.log(game.doors.scriptRuntime.engineLog.slice(0, 60).join('\n'));
