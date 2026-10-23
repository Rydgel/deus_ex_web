/** Show how a leg's travel text differs between Play's run (--json from chain-play/validate-stage6-chain) and the original's capture, normalized:
 *   node scripts/chain-diff.mjs --mission 01 --leg leg2 [--play .work/chains/play-m01.json] [--context 3] */
import { readFileSync } from 'node:fs';
import { normalizeTravelText } from '../src/runtime/travel-text.mjs';
import { captureDirectory } from './chain-lib.mjs';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const mission = option('mission', '01'), label = option('leg', 'exit'), context = Number(option('context', 3));
const play = JSON.parse(readFileSync(option('play', `.work/chains/play-m${mission}.json`), 'utf8'));
const original = JSON.parse(readFileSync(`${captureDirectory(mission)}result.json`, 'utf8'));
const a = normalizeTravelText(original.legs.find(l => l.label === label).text, { times: true }).split('\n');
const b = normalizeTravelText(play.legs.find(l => l.label === label).text, { times: true }).split('\n');
// a plain LCS-free diff: walk both with a lookahead resync (the lists differ by whole lines)
let i = 0, j = 0, shown = 0;
while ((i < a.length || j < b.length) && shown < Number(option('max', 60))) {
  if (a[i] === b[j]) { i++; j++; continue; }
  // find the nearest resync within 40 lines
  let found = null;
  for (let d = 1; d < 60 && !found; d++) {
    for (let x = 0; x <= d; x++) { const y = d - x; if (i + x < a.length && j + y < b.length && a[i + x] === b[j + y] && a[i + x + 1] === b[j + y + 1]) { found = [x, y]; break; } }
  }
  const [x, y] = found ?? [a.length - i, b.length - j];
  console.log(`@ original line ${i + 1}, Play line ${j + 1}`);
  for (let k = Math.max(0, i - context); k < i; k++) console.log(`   ${a[k]}`);
  for (let k = 0; k < x; k++) console.log(` - ${a[i + k]}`);
  for (let k = 0; k < y; k++) console.log(` + ${b[j + k]}`);
  i += x; j += y; shown++;
}
console.log(`${shown} difference block(s)`);
