import { existsSync } from 'node:fs';
import path from 'node:path';

export function gameDirectory() {
  if (process.env.DEUS_EX_GAME_DIR) return path.resolve(process.env.DEUS_EX_GAME_DIR);
  for (const candidate of ['Deus Ex GOTY Edition', 'game']) {
    if (existsSync(path.join(candidate, 'System', 'DeusEx.u'))) return path.resolve(candidate);
  }
  throw new Error('No installed Deus Ex data found. Set DEUS_EX_GAME_DIR to the installation folder.');
}
