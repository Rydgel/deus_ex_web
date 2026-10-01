/** Check src/runtime/map-npc-identities.mjs against the original GObjObjects
 * captures it was built from (scripts/build-npc-identities.mjs,
 * docs/object-index-captures.md): every map key is a shipped map, and every
 * Pawn name's index is a row of that map's capture holding an object of that
 * name. Rebuilding the module (`build-npc-identities.mjs --check`) also
 * proves no pre-placed Pawn is missing; that loads every map, so it is not
 * part of the sweep. The captures are local (.cache); without them this skips. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_NPC_IDENTITIES } from '../src/runtime/map-npc-identities.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const header = readFileSync(path.join(root, 'src/runtime/map-npc-identities.mjs'), 'utf8');
const date = /original-gobjects-(\d{8})-<map>-open/.exec(header)?.[1];
assert.ok(date, 'the module names its capture date');
const maps = new Set(readdirSync(path.join(gameDirectory(), 'Maps')).filter(n => /\.dx$/i.test(n)).map(n => n.replace(/\.dx$/i, '').toLowerCase()));
const missing = Object.keys(MAP_NPC_IDENTITIES).filter(map => !existsSync(path.join(root, '.cache', `original-gobjects-${date}-${map}-open.txt`)));
if (missing.length === Object.keys(MAP_NPC_IDENTITIES).length) {
  console.log(`SKIP validate-map-npc-identities: no ${date} captures in .cache (docs/object-index-captures.md)`);
  process.exit(0);
}
assert.deepEqual(missing, [], 'every map in the module has its capture');
let pawns = 0;
for (const [map, table] of Object.entries(MAP_NPC_IDENTITIES)) {
  assert.ok(maps.has(map), `${map} is a shipped map`);
  const names = new Map();
  for (const line of readFileSync(path.join(root, '.cache', `original-gobjects-${date}-${map}-open.txt`), 'latin1').split(/\r?\n/)) {
    const row = /^slot\s+\d+\s+index\s+(\d+)\s+\S+\.(\S+)$/.exec(line);
    if (row) names.set(Number(row[1]), row[2]);
  }
  for (const [name, index] of Object.entries(table)) {
    assert.equal(names.get(index), name, `${map}: ${name} is object ${index} in the capture`);
    pawns++;
  }
}
console.log(`map-npc-identities: ${Object.keys(MAP_NPC_IDENTITIES).length} maps, ${pawns} pawn indices equal to their captures.`);
