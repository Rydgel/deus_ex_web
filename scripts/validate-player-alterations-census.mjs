/** The census of the player's alterations (docs/screen-flash.md "Census"): every scenario's outcome, `plays` or the
 * first pause, must equal the list recorded in scripts/census-player-alterations.mjs. This is that script run whole
 * (an 8 GB heap, several minutes); `--only id,id` runs part of it. */
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/census-player-alterations.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
