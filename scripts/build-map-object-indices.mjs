// Build src/runtime/map-object-indices.mjs from the original GObjObjects
// captures (docs/object-index-captures.md): for each map's
// .cache/original-gobjects-<date>-<map>-open.txt, every pre-placed actor of
// the map (its Level's actor list) is matched to the capture by class and
// name; only a unique Class.Name row counts (loadOriginalGObjects.indexFor),
// so an actor whose key also names another loaded object, or that the
// original had already destroyed when the capture was taken, stays
// unmeasured. The table stores, per map, the (export index, global index)
// pairs as base-64 VLQ zigzag deltas.
//
//   node scripts/build-map-object-indices.mjs [--date yyyymmdd] [--check]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadOriginalGObjects } from './original-gobjects.mjs';
import { MAP_NPC_IDENTITIES } from '../src/runtime/map-npc-identities.mjs';
import { TRAINING_NPC_IDENTITIES } from '../src/runtime/training-npc-identities.mjs';
import { ISLAND_NPC_IDENTITIES } from '../src/runtime/island-npc-identities.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const date = flag('--date', '20261001'), check = argv.includes('--check');
const game = gameDirectory(), files = [];
for (const dir of ['Maps']) for (const name of await readdir(path.join(game, dir))) files.push({ path: `${dir}/${name}`, read: () => readFile(path.join(game, dir, name)) });
const assets = new AssetStore(files);
const maps = (await readdir(path.join(game, 'Maps'))).filter(name => /\.dx$/i.test(name) && !/^dxmp_/i.test(name))
  .map(name => name.replace(/\.dx$/i, '')).sort((a, b) => a.localeCompare(b));
// Training uses the 2026-09-11 capture of the map itself
// (.cache/original-gobjects.txt): the session TRAINING_NPC_IDENTITIES and the
// LightSwitch0 channel id (34242, docs/script-sound.md) were measured in. Its
// other captures are separate sessions whose free-slot reuse differs.
const captureFor = map => {
  if (map.toLowerCase() === '00_training') return path.join(root, '.cache', 'original-gobjects.txt');
  return path.join(root, '.cache', `original-gobjects-${date}-${map.toLowerCase()}-open.txt`);
};
const npcTables = { ...MAP_NPC_IDENTITIES, '00_training': TRAINING_NPC_IDENTITIES, '01_nyc_unatcoisland': ISLAND_NPC_IDENTITIES };
const tables = {}, players = {}, report = [];
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (const map of maps) {
  const file = captureFor(map);
  if (!existsSync(file)) { report.push({ map, capture: false }); continue; }
  const capture = await loadOriginalGObjects(file);
  const decoded = decodeMap((await assets.get(map)).bytes);
  const pairs = [];
  let ambiguousOrMissing = 0;
  for (const actor of decoded.actors) {
    const index = capture.indexFor(actor.className, actor.name);
    if (Number.isInteger(index)) pairs.push([actor.index, index]); else ambiguousOrMissing++;
  }
  pairs.sort((a, b) => a[0] - b[0]);
  // The pawn tables were built the same way; they must agree.
  // A map whose pawn table came from another capture session is left out
  // rather than mixing two sessions' index spaces.
  const npcs = npcTables[map.toLowerCase()] ?? {};
  const byName = new Map(decoded.actors.map(actor => [actor.name, actor.index]));
  const disagree = Object.entries(npcs).filter(([name, index]) => {
    const exportIndex = byName.get(name), pair = pairs.find(p => p[0] === exportIndex);
    return !pair || pair[1] !== index;
  });
  if (disagree.length) { report.push({ map, disagreesWithNpcTable: disagree.length }); continue; }
  // Base-64 VLQ (source-map digits) of zigzag deltas: export index from the
  // previous export + 1, global index from the previous index + 1.
  let text = '', previousExport = 0, previousIndex = 0;
  const vlq = value => {
    let v = value < 0 ? (-value << 1) | 1 : value << 1;
    do { let digit = v & 31; v >>>= 5; if (v) digit |= 32; text += DIGITS[digit]; } while (v);
  };
  for (const [exportIndex, index] of pairs) {
    vlq(exportIndex - previousExport - 1); vlq(index - previousIndex - 1);
    previousExport = exportIndex; previousIndex = index;
  }
  tables[map.toLowerCase()] = text;
  // The player the map's open spawned (Login's SpawnPlayActor): the one
  // JCDentonMale instance in the same capture (JCDentonMale1 there; the
  // Entry map's player took 0). Left out unless exactly one.
  const playerRows = capture.rows.filter(row => /^JCDentonMale\.JCDentonMale\d+$/.test(row.key));
  if (playerRows.length === 1) players[map.toLowerCase()] = playerRows[0].index;
  report.push({ map, actors: decoded.actors.length, measured: pairs.length, unmeasured: ambiguousOrMissing, chars: text.length });
}
const body = `// Generated by scripts/build-map-object-indices.mjs from the original
// GObjObjects captures (docs/object-index-captures.md). Per map (lower case),
// the pre-placed actors whose Class.Name is unique in that map's capture, as
// base-64 VLQ zigzag deltas of (export index, global UObject index) pairs.
export const MAP_OBJECT_INDICES = Object.freeze(${JSON.stringify(tables)});
// Per map, the global index of the player the capture's open spawned (its one
// JCDentonMale instance), for the player Login spawns at the same open.
export const MAP_PLAYER_INDICES = Object.freeze(${JSON.stringify(players)});

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const decoded = new Map();
function decode(text) {
  const table = new Map();
  let at = 0, exportIndex = 0, index = 0;
  const next = () => {
    let value = 0, shift = 0, digit;
    do { digit = DIGITS.indexOf(text[at++]); value |= (digit & 31) << shift; shift += 5; } while (digit & 32);
    return value & 1 ? -(value >>> 1) : value >>> 1;
  };
  while (at < text.length) {
    exportIndex += next() + 1; index += next() + 1;
    table.set(exportIndex, index);
  }
  return table;
}

/** The measured global index of the player \`map\`'s open spawned, or null. */
export function mapPlayerIndex(map) {
  return MAP_PLAYER_INDICES[String(map).toLowerCase()] ?? null;
}

/** The measured global index of export \`exportIndex\` of \`map\`, or null. */
export function mapObjectIndex(map, exportIndex) {
  const key = String(map).toLowerCase(), text = MAP_OBJECT_INDICES[key];
  if (text === undefined) return null;
  if (!decoded.has(key)) decoded.set(key, decode(text));
  return decoded.get(key).get(exportIndex) ?? null;
}
`;
const out = path.join(root, 'src', 'runtime', 'map-object-indices.mjs');
if (check) {
  const current = existsSync(out) ? await readFile(out, 'utf8') : '';
  console.log(current === body ? 'map-object-indices: up to date' : 'map-object-indices: differs from a fresh build');
  if (current !== body) process.exitCode = 1;
} else await writeFile(out, body);
console.log(`players: ${Object.keys(players).length} maps`);
const total = report.reduce((sum, r) => ({ actors: sum.actors + (r.actors ?? 0), measured: sum.measured + (r.measured ?? 0) }), { actors: 0, measured: 0 });
console.log(JSON.stringify({ maps: report.length, missingCaptures: report.filter(r => r.capture === false).map(r => r.map),
  skipped: report.filter(r => r.disagreesWithNpcTable).map(r => `${r.map} (${r.disagreesWithNpcTable})`), ...total,
  bytes: body.length, worst: report.filter(r => r.actors).sort((a, b) => a.measured / a.actors - b.measured / b.actors).slice(0, 5) }));
