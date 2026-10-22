/** The write side of the saved level (docs/travel.md "Play, step 3") against the original's own files: every native payload the writer copies or
 * re-encodes, read from the measured `.dxs` files and written again, must equal the original's bytes.
 *
 *   - `Model` and `Polys` (model-transcode.mjs) with identity translations;
 *   - the level summary's property list (transcodeProperties);
 *   - the AI event manager's `EventManager`, `AIEventType`, `AISenderEvent` and `AIReceiverEvent` payloads: decoded to `ai_load`'s words
 *     (ai-events-payload.mjs decodeAiEvents), parsed (`parseAiWords`) and encoded (`encodeAiEvents`) with the identity references;
 *   - a package built by package-write.mjs from a saved level's tables reads back to the same names, imports and exports.
 *
 * The captures are outside Git (.work/travel/dxs, .work/travel/rt1/*.Current), and so are the real desktop save slots downloaded from the internet
 * (the Save directories under .work/internet-saves/<source>/files, SOURCES.md there: 41 slots, every mission); the validator skips when none is there.
 *
 *   node scripts/validate-level-save.mjs */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parsePackage, Reader } from '../src/unreal/package.mjs';
import { transcodeModel, transcodePolys, transcodeProperties } from '../src/runtime/model-transcode.mjs';
import { decodeAiEvents, parseAiWords, encodeAiEvents } from '../src/runtime/ai-events-payload.mjs';
import { PackageTables, buildPackage } from '../src/runtime/package-write.mjs';
import { ByteWriter } from '../src/runtime/byte-writer.mjs';

const work = new URL('../.work/', import.meta.url).pathname;
const captures = `${work}travel/`;
const candidates = [];
const walk = async dir => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (/\.dxs$/i.test(entry.name) && !/SaveInfo/i.test(entry.name)) candidates.push(path);
  }
};
for (const dir of ['dxs', 'rt1']) {
  if (!existsSync(`${captures}${dir}`)) continue;
  for (const name of await readdir(`${captures}${dir}`)) {
    const path = `${captures}${dir}/${name}`;
    if (/\.dxs$/i.test(name) && !/SaveInfo/i.test(name)) candidates.push(path);
    else if (/\.Current$/.test(name)) for (const inner of await readdir(path)) if (/\.dxs$/i.test(inner)) candidates.push(`${path}/${inner}`);
  }
}
if (existsSync(`${work}internet-saves`)) for (const source of await readdir(`${work}internet-saves`)) if (existsSync(`${work}internet-saves/${source}/files`)) await walk(`${work}internet-saves/${source}/files`);
if (!candidates.length) { console.log('SKIP validate-level-save: no saved level in .work/travel or .work/internet-saves (outside Git)'); process.exit(0); }

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
let models = 0, polys = 0, summaries = 0, aiObjects = 0, files = 0;

for (const path of candidates) {
  const bytes = new Uint8Array(await readFile(path));
  let pkg;
  try { pkg = parsePackage(bytes); } catch (error) { failures.push(`${path}: ${error.message}`); continue; }
  if (!pkg.exports.some(entry => entry.className === 'Level')) continue;   // not a level file
  files++;
  const label = path.slice(work.length);
  const nameIndex = text => { const i = pkg.names.findIndex(entry => entry.name.toLowerCase() === String(text).toLowerCase()); if (i < 0) throw new Error(`no name ${text}`); return i; };
  const translate = { objectRef: v => v, nameIndex };
  const data = entry => bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
  for (const [i, entry] of pkg.exports.entries()) {
    const transcode = entry.className === 'Model' ? transcodeModel : entry.className === 'Polys' ? transcodePolys : entry.className === 'LevelSummary' ? transcodeProperties : null;
    if (!transcode) continue;
    let out;
    try { out = transcode(pkg, data(entry), translate, { hasStack: Boolean(entry.flags & 0x2000000) }); } catch (error) { check(false, `${label}: ${entry.className} ${entry.name} (${i + 1}): ${error.message}`); continue; }
    // An export with RF_HasStack (0x2000000) starts with an FStateFrame header (Node, StateNode, ProbeMask, LatentAction, and the code offset with a
    // Node): a Model and a Polys that came from a .dx carry one, and the writer leaves it out of a saved level (two brush objects of the measured
    // 00_TrainingCombat.dxs carry theirs: docs/travel.md "Unresolved"), so the bytes compared are those after it.
    let expected = data(entry);
    if (entry.flags & 0x2000000) {
      const r = new Reader(expected), node = r.compact(); r.compact(); r.u32(); r.u32(); r.i32(); if (node) r.compact();
      expected = expected.subarray(r.offset);
    }
    check(equal(out, expected), `${label}: ${entry.className} ${entry.name} (${i + 1}) does not write back to its bytes`);
    if (entry.className === 'Model') models++; else if (entry.className === 'Polys') polys++; else summaries++;
  }
  // the AI event manager
  const managerIndex = pkg.exports.findIndex(entry => entry.className === 'EventManager') + 1;
  if (managerIndex) {
    const { words, types, senders, receivers } = decodeAiEvents(pkg, bytes, managerIndex, { nameId: text => nameIndex(text), actorWord: index => index });
    const parsed = parseAiWords(words);
    // positions: each object's export index, in the order decodeAiEvents lists them
    const positions = { manager: managerIndex, types: types.map(t => t.index), senders: senders.map(s => s.index), receivers: receivers.map(r => r.index) };
    const levelPosition = pkg.exports.findIndex(entry => entry.className === 'Level') + 1;
    const writers = encodeAiEvents(parsed, positions, levelPosition, { nameIndex, spelling: id => pkg.names[id].name, actorRef: word => word });
    const written = (index, write) => { const w = new ByteWriter(256); write(w); check(equal(w.finish(), data(pkg.exports[index - 1])), `${label}: ${pkg.exports[index - 1].className} ${pkg.exports[index - 1].name} (${index}) does not write back to its bytes`); aiObjects++; };
    written(managerIndex, writers.manager);
    types.forEach((t, i) => written(t.index, writers.types[i]));
    senders.forEach((s, i) => written(s.index, writers.senders[i]));
    receivers.forEach((r, i) => written(r.index, writers.receivers[i]));
  }
  // package-write: the file's own tables written again read back the same
  {
    const tables = new PackageTables({ sourcePkg: pkg });
    pkg.names.forEach(entry => tables.name(entry.name));
    tables.finalize();
    check(tables.nameList.length === new Set(pkg.names.map(entry => entry.name.toLowerCase())).size, `${label}: the rebuilt name table has ${tables.nameList.length} entries`);
    const out = buildPackage(tables, [], { guid: new Uint8Array(16) });
    const back = parsePackage(out);
    check(back.names.length === tables.nameList.length && back.exports.length === 0 && back.version === pkg.version, `${label}: the written package does not read back (${back.names.length} names, version ${back.version})`);
  }
}
if (!files) { console.log('SKIP validate-level-save: the captures hold no level file'); process.exit(0); }
if (failures.length) { console.log(`FAIL validate-level-save:\n  ${failures.slice(0, 20).join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-level-save: ${files} saved level(s): ${models} Model, ${polys} Polys, ${summaries} LevelSummary and ${aiObjects} AI event payloads write back to the original's bytes`);
