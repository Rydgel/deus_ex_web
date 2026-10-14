// Where the two programs' random draws part on the first unfrozen tick of a live comparison (docs/visual-acceptance.md "Live scenes",
// Divergence 14): the stream index of every StartUp pawn's `Sleep(FRand() + 0.2)` in the original and in Play.
//
// A pawn in state StartUp draws FRand() once, in its first tick, and sleeps 0.2 + that long. The trace (`live-acceptance.mjs original`) and
// Play's rows both carry LatentFloat after the tick, which is the Sleep's remaining seconds, so the draw's value is known, and the stream a
// tick starts from (rngIn, the same on both sides) is a linear congruential sequence, so the value names the draw's index in the tick. Each
// pawn then has an index on each side; a pawn whose index differs by n has n draws more (or fewer) before it in Play than in the original, and
// the first pawn of the actor order where the difference begins brackets the actor that draws on one side only.
//
//   node scripts/live-draw-shift.mjs --map 05_NYC_UNATCOMJ12lab --tag m1 [--all]    # the differing pawns (--all: every pawn)
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
const map = option('map'), tag = option('tag', null), suffix = tag ? `-${tag}` : '';
const dir = path.join(root, '.work/live-acceptance', map);
const parse = line => JSON.parse(line.replace(/-?nan\([a-z0-9]+\)|-?nan\b|-?inf\b/gi, 'null'));
const rows = readFileSync(path.join(dir, `original-trace${suffix}.jsonl`), 'utf8').trim().split('\n').map(parse).filter(row => row.unfrozen >= 1);
const play = JSON.parse(readFileSync(path.join(dir, `play-rows${suffix}.json`), 'utf8')).rows;
const f32 = Math.fround, step = s => (Math.imul(s, 214013) + 2531011) >>> 0;
const drawCount = (a, b) => { let x = parseInt(a, 16) >>> 0, k = 0; const target = parseInt(b, 16) >>> 0; while (x !== target && k < 1e6) { x = step(x); k++; } return k; };
const dt = rows[0].delta;
console.log(`tick 1 draws: original ${drawCount(rows[0].rngIn, rows[0].rngOut)}, Play ${drawCount(play[0].rngIn, play[0].rngOut)}`);
// the FRand values of the tick's draws: appFrand = rand() * 3.0518509447574615e-5 (docs/rng.md), stored as float32
const values = []; for (let x = parseInt(rows[0].rngIn, 16) >>> 0, k = 0; k < 600; k++) { x = step(x); values.push(f32(((x >>> 16) & 0x7fff) * 3.0518509447574615e-5)); }
const indexOf = latentFloat => {
  if (typeof latentFloat !== 'number') return null;
  // the Sleep time is FRand() + 0.2; LatentFloat holds it less the ticks the Sleep has run (0 or 1 of them by now)
  for (const ticks of [0, 1]) { const w = f32(f32(latentFloat + ticks * dt) - 0.2); for (let k = 0; k < values.length; k++) if (Math.abs(values[k] - w) < 2e-6) return k + 1; }
  return null;
};
const table = Object.keys(rows[0].actors).filter(name => name !== '@player' && rows[0].actors[name].LatF !== undefined && String(rows[0].actors[name].State).startsWith('StartUp'))
  .map(name => ({name, original: indexOf(rows[0].actors[name].LatF), play: indexOf(play[0].actors[name]?.LatentFloat)}));
table.sort((a, b) => (a.original ?? 9999) - (b.original ?? 9999));
let previous = 0;
for (const entry of table) {
  const shift = entry.original !== null && entry.play !== null ? entry.play - entry.original : null;
  if (process.argv.includes('--all') || (shift !== null && shift !== previous) || shift === null) console.log(entry.name.padEnd(18), `original draw ${entry.original}`, `Play draw ${entry.play}`, shift === null ? '' : `(Play ${shift >= 0 ? '+' : ''}${shift})`);
  if (shift !== null) previous = shift;
}
if (table.every(entry => entry.original === entry.play)) console.log(`all ${table.length} StartUp pawns drew the same stream index on both sides`);
