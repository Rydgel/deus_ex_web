/** Reads a `dx-live-win.exe weapon` log (the original's third-person weapon draw, event by event:
 * docs/weapon-attachment.md) and prints what it holds, and with `--cases out.json` writes the
 * cases scripts/validate-weapon-attach.mjs compares the translation with.
 *
 *   node scripts/weapon-original-cases.mjs .work/weapon/island-weapon.jsonl [--cases .work/weapon/original-cases.json]
 *
 * Per pawn draw the original's events are, in order: `special` (the three special vertices, camera space, and
 * their outcodes), `coords` (the hand coordinates, stored by a `rep movsd`: the breakpoint sits on the
 * instruction, so it fires once per word moved and only the first of each run holds the whole 12 words),
 * then, for a pawn with a Weapon, `read` and `weapon` (the weapon's DrawMesh call, with the Coords handed to
 * it and the weapon's fields) and, while the muzzle flash shows, `flash`. */
import {readFileSync, writeFileSync} from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: weapon-original-cases.mjs <log.jsonl> [--cases out.json]'); process.exit(2); }
const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const hex = words => words.map(w => parseInt(w, 16) >>> 0);

const draws = [];       // {special, hand, read, weapon, flash}
let current = null, lastSite = null;
for (const event of events) {
  if (event.site === 'special') { current = {special: event}; draws.push(current); }
  else if (event.site === 'coords') {
    // the first event of a run of 12 holds the whole coordinates
    if (current && !current.hand && lastSite !== 'coords') current.hand = event;
  } else if (current) {
    if (event.site === 'read') current.read = event;
    else if (event.site === 'weapon') current.weapon = event;
    else if (event.site === 'flash') current.flash = event;
    else if (event.site === 'item') current.item = event;
  }
  lastSite = event.site;
}
const complete = draws.filter(d => d.special && d.hand && d.read && d.weapon);
// a pawn with no Weapon whose SelectedItem is drawn (the block after 0x10b25cdc)
const items = draws.filter(d => d.special && d.hand && d.read && d.item);
const byPawn = new Map();
for (const d of draws) {
  const key = `${d.special.pawn} (${d.special.mesh})`;
  const entry = byPawn.get(key) ?? {draws: 0, weapon: new Set(), thirdPersonMesh: new Set()};
  entry.draws++; if (d.read) { entry.weapon.add(d.read.weapon); entry.thirdPersonMesh.add(d.read.thirdPersonMesh); }
  byPawn.set(key, entry);
}
console.log(`${events.length} events, ${draws.length} pawn draws with special vertices, ${complete.length} with a weapon drawn, ${items.length} with a selected item drawn`);
for (const [key, entry] of byPawn)
  console.log(`  ${key}: ${entry.draws} draws, weapon ${[...entry.weapon].join(',') || 'none'} ${[...entry.thirdPersonMesh].join(',')}`);
const flashes = draws.filter(d => d.flash).length;
console.log(`muzzle flash draws: ${flashes}; frames: ${new Set(events.map(e => e.frame).filter(Boolean)).size}; mirrors: ${[...new Set(events.map(e => e.mirror))].join(',')}`);

if (rest[0] === '--cases') {
  const hand = [], weapon = [], selected = [];
  for (const d of items) {
    hand.push({vertices: [d.special.v0, d.special.v1, d.special.v2].map(hex), outcodes: [d.special.out0, d.special.out1, d.special.out2],
      indices: d.special.indices, expected: hex(d.hand.w), pawn: d.special.pawn});
    selected.push({hand: hex(d.hand.w), location: hex(d.item.location), mirror: d.item.mirror, expected: hex(d.item.coords), pawn: d.special.pawn, item: d.item.item});
  }
  for (const d of complete) {
    hand.push({vertices: [d.special.v0, d.special.v1, d.special.v2].map(hex), outcodes: [d.special.out0, d.special.out1, d.special.out2],
      indices: d.special.indices, expected: hex(d.hand.w), pawn: d.special.pawn});
    weapon.push({hand: hex(d.hand.w), location: hex(d.weapon.location), mirror: d.weapon.mirror, expected: hex(d.weapon.coords),
      pawn: d.special.pawn, weapon: d.weapon.weapon});
  }
  writeFileSync(rest[1], JSON.stringify({hand, weapon, selected}));
  console.log(`wrote ${hand.length} cases to ${rest[1]}`);
}
