/** Linked property offsets for the original-side dump tools (tools/dump-actor-win.c): node scripts/chain-offsets.mjs <map> <actor> <prop,...>
 * Reads the slots Play's class loader linked (the offsets of the original's own objects: docs/linked-property-offsets in the memory notes). */
import { loadAssets } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';

const [map, actorName, props] = process.argv.slice(2);
const assets = await loadAssets();
const { c } = await openSession(map, assets, { travel: {} });
c.frames(30);
const { slotOf } = c.runtime.classLoader.graph;
const actor = actorName === 'player' ? c.player() : c.actor(actorName);
if (!actor) throw new Error(`no actor ${actorName}`);
for (const name of props.split(',')) {
  const member = c.runtime.lookupMember(c.runtime.instance(actor).cls, 'fields', name);
  console.log(name, member ? `0x${slotOf(member.loadRecord, 0x48).toString(16)} mask ${slotOf(member.loadRecord, 0x5c)}` : 'not found');
}
process.exit(0);
