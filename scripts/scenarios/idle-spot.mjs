/** A bench-sim scenario (--scenario) that stands the god-mode player at one spot, as `hitch-run.mjs --mode idle --god --place` does in the
 * browser, with the viewport given the size the page's first frame gives it. Without that size 02_NYC_BatteryPark's HUD stops every tick at
 * "UViewport SizeX/SizeY are unknown before the first frame" (its census used to be unusable in Node).
 *
 *   PLACE='{"location":[2025,-3396,263],"rotation":[0,32768,0]}' node scripts/bench-sim.mjs --map 02_NYC_BatteryPark --warm 120 --ticks 1500 \
 *     --render-feedback --idle --scenario scripts/scenarios/idle-spot.mjs
 *
 * PLACE=none leaves the player where the map starts. DUMP=n prints, every n ticks, the actors whose Physics is not None or Walking, with their
 * class (what rolls, falls, flies or rotates at rest). With scripts/script-vm-fallback-census.mjs: BASE=scripts/scenarios/idle-spot.mjs.
 * Same-mode reproduction only, never a claim about the original: the pawns' states depend on the order of the inputs. */
import {placeProbe} from '../../src/viewer/decal-probe.mjs';
import {viewProbe} from '../../src/viewer/view-probe.mjs';

export default function ({game, runtime}) {
  const place = process.env.PLACE === 'none' ? null : JSON.parse(process.env.PLACE ?? '{"location":[2025,-3396,263],"rotation":[0,32768,0]}');
  const dumpEvery = Number(process.env.DUMP ?? 0);
  const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch { return null; } };
  return index => {
    if (index === 1) game.doors.scriptRuntime.windowHost.resizeViewport(1440, 960);
    if (index === 29) viewProbe(game, {exec: ['set DeusEx.JCDentonMale bCheatsEnabled True', 'god']});
    if (index === 30 && place) placeProbe(game, {location: place.location, rotation: place.rotation, endConversation: true});
    if (dumpEvery && index > 30 && index % dumpEvery === 0) {
      const counts = new Map();
      for (const actor of runtime.levelFor(game.player.collisionActor).actors) {
        if (!actor) continue;
        let key = '?';
        try { key = runtime.instance(actor).cls.record.key; } catch { /* not a script object */ }
        const label = `${read(actor, 'Physics')} ${key}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      console.error(`tick ${index}:`, [...counts].filter(([k]) => !/^(PHYS_None|PHYS_Walking|0|1) /.test(k)).map(([k, n]) => `${k}=${n}`).join(' | '));
    }
  };
}
