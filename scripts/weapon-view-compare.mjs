/** The first-person weapon's draw at a held frame, the original's against Play's (gate row 4.1.10, docs/weapon-attachment.md
 * "The first-person weapon"). The original's side is the live trace's `fpdraw` call records (tools/dx-live-win.c `call 0x10b262c0 fpdraw 2
 * always namearg 1 -1 deref 1 6 0x114 deref 1 4 0x54 deref 0 12 0x34`: URender::DrawActor, which Canvas.DrawActor reaches from the
 * weapon's RenderOverlays, with the weapon's Location and Rotation, its AnimSequence/AnimFrame/AnimRate/TweenRate and the canvas frame's
 * Coords), the draws made while the tracer held the level after its last tick; Play's is `live-acceptance.mjs play --after-file
 * scripts/weapon-view-probe.js --after-out <file>` at the same held tick (the weapon actor's fields and its binding's frame Coords).
 *
 *   node scripts/weapon-view-compare.mjs --map 00_Training --tag fpw --play .work/live-acceptance/00_Training/weapon-view-play-fpw.json
 *
 * Prints one JSON line: the draws of the hold, whether they all hold the same words, and each field equal or not (bit for bit). */
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const map = option('map', '00_Training'), tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const dir = path.join(root, '.work/live-acceptance', map);
const callsPath = path.join(dir, `original-trace${suffix}.jsonl.calls.jsonl`), tracePath = path.join(dir, `original-trace${suffix}.jsonl`);
const playPath = option('play', path.join(dir, `weapon-view-play${suffix}.json`));
for (const file of [callsPath, tracePath, playPath]) if (!existsSync(file)) { console.log(JSON.stringify({error: `absent: ${path.relative(root, file)}`})); process.exit(1); }

// The level's last unfrozen tick: the draws after it, made while the tracer held the level, are the held frame's.
const ticks = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'))).filter(row => row.unfrozen >= 1);
const last = ticks.at(-1).unfrozen;
const draws = readFileSync(callsPath, 'utf8').split('\n').filter(line => line.includes('"fn":"fpdraw"') && line.includes('"ev":"enter"')).map(line => JSON.parse(line))
  .filter(row => row.u === last && row.inTick === 0);
if (!draws.length) { console.log(JSON.stringify({error: `no fpdraw record after tick ${last}`})); process.exit(1); }
const words = row => ({actor: row.argName, location: row.deref[0].words.slice(0, 3), rotation: row.deref[0].words.slice(3, 6),
  anim: row.deref[1].words.slice(1, 4), coords: row.deref[2].words});
const original = draws.map(words), first = original[0];
const steady = original.every(d => JSON.stringify(d) === JSON.stringify(first));
const play = JSON.parse(readFileSync(playPath, 'utf8'));
const hex = n => (n >>> 0).toString(16).padStart(8, '0');
const norm = list => list.map(w => String(w).replace(/^0x/, '').padStart(8, '0').toLowerCase());
const rows = play.rows.filter(r => r.drawn !== false);
const fields = {
  location: [norm(first.location), norm(play.bits.location)],
  rotation: [norm(first.rotation), play.actor.Rotation.map(hex)],
  anim: [norm(first.anim), [play.bits.animFrame, play.bits.animRate, play.bits.tweenRate]],
  coords: [norm(first.coords), rows.length ? norm(rows[0].coords) : null],
  bindingLocation: [norm(first.location), rows.length ? norm(rows[0].location) : null],
};
const equal = Object.fromEntries(Object.entries(fields).map(([k, [a, b]]) => [k, Boolean(b) && a.join() === b.join()]));
console.log(JSON.stringify({map, tag, tick: last, heldDraws: draws.length, steady, weapon: [first.actor, play.weapon], equal, fields}));
