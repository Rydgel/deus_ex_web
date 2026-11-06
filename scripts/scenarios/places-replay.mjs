/** A bench-sim scenario (--scenario) that replays the slow-spot census' placements in Node (scripts/spot-census.mjs, hitch-run.mjs --places):
 * the player in god mode (the console's `set DeusEx.JCDentonMale bCheatsEnabled True`, `god`) is put at each spot of a places file through
 * placeProbe, the way the browser harness does, and the simulation runs PER ticks before the next one. It exists to reproduce, headless, a
 * stop the census met in a browser (docs/script-pawn-nav.md "A patrol that cannot start"): the NPCs' states depend on the order of the
 * teleports, the tick length and the random seed, and all three are inputs here.
 *
 *   PLACES=.cache/perf/spot-census/firefox-09_NYC_ShipBelow.places.json PER=39 TO=160 FUZZ=11 \
 *     node scripts/bench-sim.mjs --map 09_NYC_ShipBelow --warm 30 --ticks 6300 --dt 0.0333333 --seed 3 --render-feedback \
 *       --scenario scripts/scenarios/places-replay.mjs
 *
 * PLACES the places file; PER ticks a spot (default 77, 1.3 s at 60 Hz); FROM/TO the range of the list (or of the shuffled order); FUZZ=n
 * visits the spots in the order of a seeded shuffle (default: the file's); START_TICK the tick of the first placement (30, god mode one
 * tick before); STOPON a regexp of the tick errors that end the run (default `Runaway`): the pawns' states are then printed to stderr and
 * the process exits 3 (NOEXIT=1 throws instead); other errors are printed as IGNORED and thrown to bench-sim, which counts them. The
 * viewport is given a size (the conversation camera of a pawn that meets the player needs it, as the browser's first frame gives it).
 * Same-mode reproduction only, never a claim about the original: the browser's frames, render feedback and seed are not the same. */
import {readFileSync} from 'node:fs';
import {placeProbe} from '../../src/viewer/decal-probe.mjs';
import {viewProbe} from '../../src/viewer/view-probe.mjs';

export default function ({game, runtime}) {
  const list = JSON.parse(readFileSync(process.env.PLACES, 'utf8'));
  const per = Number(process.env.PER ?? 77), from = Number(process.env.FROM ?? 0), to = Number(process.env.TO ?? list.length);
  const first = Number(process.env.START_TICK ?? 30), stopOn = new RegExp(process.env.STOPON ?? 'Runaway');
  let seed = Number(process.env.FUZZ ?? 0) >>> 0;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const order = list.map((_, i) => i);
  if (process.env.FUZZ) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch (e) { return `<${e.message.slice(0, 30)}>`; } };
  const show = value => Array.isArray(value) ? value.map(x => typeof x === 'number' ? Math.round(x) : x) : (value && value.name ? value.name : value);
  const dump = () => {
    for (const actor of runtime.levelFor(game.player.collisionActor).actors) {
      if (!actor) continue;
      let pawn = false, key = '?', state = '?';
      try {
        const instance = runtime.instance(actor);
        key = instance.cls.record.key; state = instance.state?.stateNode?.record.name ?? 'None';
        for (let c = instance.cls; c; c = c.base) if (c.record.key === 'deusex.scriptedpawn') pawn = true;
      } catch { /* not a script object */ }
      if (pawn) console.error('PAWN', actor.name, key, 'state', state, 'loc', show(read(actor, 'Location')), 'phys', read(actor, 'Physics'),
        'dest', show(read(actor, 'destPoint')), 'move', show(read(actor, 'MoveTarget')), 'enemy', show(read(actor, 'Enemy')), 'health', read(actor, 'Health'), 'orders', read(actor, 'Orders'));
    }
  };
  const tick = game.tick.bind(game);
  let spot = -1, t = 0;
  game.tick = (...args) => {
    try { return tick(...args); } catch (error) {
      const message = error.message.split('\n')[0];
      if (!stopOn.test(message)) { console.error('IGNORED', message); throw error; }
      console.error('TICKERR tick', t, 'spot', spot, message, '\n', String(error.stack).split('\n').slice(0, 14).join('\n'));
      dump();
      if (!process.env.NOEXIT) process.exit(3);
      throw error;
    }
  };
  return index => {
    t = index;
    if (index === 1) game.doors.scriptRuntime.windowHost.resizeViewport(1440, 960);
    if (index === first - 1) viewProbe(game, {exec: ['set DeusEx.JCDentonMale bCheatsEnabled True', 'god']});
    if (index >= first && (index - first) % per === 0) {
      const k = from + (index - first) / per;
      if (k < to) {
        spot = k;
        const place = list[process.env.FUZZ ? order[k] : k];
        console.error(`spot ${k} ${place.location.map(Math.round)} yaw ${place.rotation[1]} tick ${index}`);
        placeProbe(game, {location: place.location, rotation: place.rotation, endConversation: true});
      }
    }
  };
}
