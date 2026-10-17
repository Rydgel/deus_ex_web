/** The ?easter=1 mod, page side (docs/easter-egg.md): after a Player start on the Paris club, ask the simulation side to place the two
 * actors (easter-sim.mjs, in the worker by default) and register their skins with the actor mesh draw (easter-skins.mjs). */
import { EASTER, RYDGEL_LOOKS, RYDGEL_LOOK } from './easter-config.mjs';
import { easterSkins } from './easter-skins.mjs';

export async function startEaster({ game, simClient, assets, mapName }) {
  if (mapName !== EASTER.map) return null;
  const info = simClient ? await simClient.call('easter', { op: 'setup' }) : await (await import('./easter-sim.mjs')).easterCall(game, { op: 'setup' });
  const { createEasterSkins } = await import('./easter-skin-art.mjs');
  easterSkins.current = createEasterSkins({ claudia: info.claudia.name, rydgel: info.rydgel.name, rydgelTextures: RYDGEL_LOOKS[RYDGEL_LOOK].textures });
  return info;
}
