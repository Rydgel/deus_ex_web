import { coordsTransform } from '../runtime/volumetric-fog.mjs';
import { createCoronaCache, coronaDecay, coronaSeenAt, coronaIcon, coronaFrame, coronaFrameFromCamera, coronaLineVisible, leafPermeatingLights } from '../runtime/coronas.mjs';
import { movingLightInView, movingLightLeafList, viewPlanesOf, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
import { actorsEpoch } from '../runtime/base-epoch.mjs';

/** The simulation side of Play's light coronas (docs/coronas.md "Play",
 * docs/sim-worker.md step 6): DrawFrame's corona pass each main frame (top
 * level only, D3D's default Coronas=True). The lights permeating the
 * player's leaf go through the original visibility helper with Play's
 * SingleLineCheck; the live entries become screen icons the page draws
 * (corona-pass.mjs).
 *
 * The pass reads the frame DrawWorld hands to DrawFrame, the master frame
 * OccludeBsp read (docs/coronas.md "The frame"): `update` takes its words
 * (sim-session visibility().master), the render pass's Coords, X, FX2, FY2
 * and Proj.Z in the drawing buffer's pixels.
 *
 * The lights it visits are the viewer's leaf's permeating static lights
 * (`Model.Lights`) and then its LeafLights, the moving lights SetupDynamics
 * took (the gate and the frame's ViewPlanes test) and OccludeBsp's Filter
 * left on that leaf (docs/coronas.md "Leaf lights").
 *
 * The helper's first line check (TRACE_Level|TRACE_Movers) runs over
 * Level->Model as the moving brush tracker left it this frame (`lineModel()`,
 * bsp-occlusion.mjs lineModel; docs/coronas.md "Lights behind a mover's
 * fragments"): the movers' polygons are ordinary solid nodes of it, so a
 * fan's blades block a lamp the static BSP lets through. Without the tracker
 * (`lineModel()` null) it is the level's own model.
 *
 * Host choices, noted: the fade clock is the host's (`now`, seconds; the
 * original's appSeconds is the CPU clock too); with no master frame the leaf
 * lists take every candidate (no ViewPlanes to test). The map's static model
 * gives the lists the tracked BSP would (validate-leaf-lights.mjs). */
export function createCoronaScan(runtime, { model, exportName, player, lineModel = () => null }) {
  const cache = createCoronaCache(), byName = new Map();
  const read = (actor, name) => runtime.readNamed(actor, name);

  // Level.Actors membership changes only when actorsEpoch advances
  // (base-epoch.mjs), so its set is rebuilt only then.
  let membership = null;
  const live = level => {
    const epoch = actorsEpoch();
    if (membership?.actors !== level.actors || membership.epoch !== epoch)
      membership = { actors: level.actors, epoch, set: new Set(level.actors) };
    return membership.set;
  };
  function actorFor(ref, level) {
    const name = exportName(ref);
    let actor = byName.get(name);
    if (!actor || !live(level).has(actor)) {
      actor = level.actors.find(candidate => candidate?.name === name) ?? null;
      byName.set(name, actor);
    }
    return actor;
  }
  const plainRef = reference => ({ key: reference.key, package: reference.asset?.name, index: reference.index });

  /** The viewer's leaf's LeafLights, head first: `lights` are this frame's
   * moving-light candidates (game.movingLights(), in Level.Actors order;
   * SetupDynamics' gate already applied); each must also pass the ViewPlanes
   * sphere test of the master frame (all of them without one). */
  function dynamicLights(leaf, lights, master) {
    if (!lights?.length) return [];
    const planes = master?.planes ? viewPlanesOf(master.planes) : null;
    const candidates = planes ? lights.filter(light => movingLightInView(light.location, light.values, planes)) : lights;
    const list = movingLightLeafList(model, candidates.map(light => ({ location: light.location,
      radius: worldLightRadius(light.values) })), leaf);
    return list ? list.map(k => candidates[k].actor) : [];
  }

  // The scan's frame state in one object and the line check's answer in another, so that `update` and `visit` hold no closure: a
  // function with an inner function that reads its variables makes a context object at every call below TurboFan
  // (docs/live-heap.md "Cut: tick and actors"). `probed` is what the helper reads of a line check (level-queries.mjs lineProbe),
  // `place` the light's float32 Location, read into one array.
  const state = { level: null, viewer: null, eye: null, slot: { next: 0 }, delta: 0, stats: null, visited: null, seen: null };
  const probed = { outside: true, actor: null }, place = [0, 0, 0];
  // Helper 0x10b1bc00's two line checks: level-queries.mjs lineCheck's `outside` and `actor`.
  const lineCheck = (start, end, extent, flags, extra, source) => {
    state.level.hash.lineProbe(probed, start, end, extent, flags, extra, source, lineModel);
    return probed;
  };
  // Helper 0x10b1bc00 for one light: the two line checks, then the entry.
  function visit(light) {
    const stats = state.stats, level = state.level;
    stats.leafLights++;
    state.visited.push(light.name);
    const location = read(light, 'Location');
    place[0] = Math.fround(location[0]); place[1] = Math.fround(location[1]); place[2] = Math.fround(location[2]);
    const visible = coronaLineVisible(lineCheck, place, state.eye, state.viewer);
    if (visible) { stats.visible++; state.seen.push(light.name); }
    // qualifies is bCorona && Skin && !bDeleteMe, which coronaSeen reads only for a light that passed the line checks.
    if (visible && Boolean(read(light, 'bCorona')) && Boolean(read(light, 'Skin')) && !read(light, 'bDeleteMe'))
      coronaSeenAt(cache, state.slot, light, state.delta, level.actors);
  }

  /** One main frame: `view` {location, rotation, fov}, the render
   * rectangle {width, height} in drawing-buffer pixels, the master frame
   * (visibility().master, or null), the frame's moving-light candidates and
   * the fade clock. Returns the icons in cache order, each
   * {x, y, size, color, skin}, and the frame's counts. */
  function update(view, rect, master, lights, now) {
    const icons = [], stats = { leafLights: 0, visible: 0 }, visited = [], seen = [];
    const viewer = player(), level = viewer ? runtime.levelFor(viewer) : null;
    const region = viewer ? runtime.regionValue(viewer) : null;
    if (!level?.hash || !region || region.leaf === -1 || !region.zone) return { icons, stats };
    const delta = coronaDecay(cache, now);
    // The frame DrawFrame reads: the master frame's words when OccludeBsp built
    // one, else Engine's own frame producers on the render rectangle. The line
    // checks end at its Coords.Origin (the helper's `frame + 0x34`).
    const { coords, frame } = master ? coronaFrame(master.words) : coronaFrameFromCamera(view, rect);
    const eye = coords.origin;
    // Level->Model as the tracker left it for this frame is one view of its memory (lineModel), built where a line check needs it.
    state.level = level; state.viewer = viewer; state.eye = eye; state.slot.next = 0; state.delta = delta;
    state.stats = stats; state.visited = visited; state.seen = seen;
    try {
      // DrawFrame 0x10b1b6b1-0x10b1b743: the leaf's permeating static lights,
      // then the leaf's LeafLights.
      const permeating = leafPermeatingLights(model, region.leaf);
      for (let i = 0; i < permeating.length; i++) {
        const light = actorFor(permeating[i], level);
        if (light) visit(light);
      }
      const moving = dynamicLights(region.leaf, lights, master);
      for (let i = 0; i < moving.length; i++) visit(moving[i]);
    } finally {
      state.level = state.viewer = state.eye = state.stats = state.visited = state.seen = null;
    }
    for (let slot = 0; slot < cache.entries.length; slot++) {
      const entry = cache.entries[slot];
      if (entry.actor == null || level.actors[entry.index] !== entry.actor) continue;
      const light = entry.actor;
      const icon = coronaIcon(entry, coordsTransform(read(light, 'Location').map(Math.fround), coords), frame,
        { hue: read(light, 'LightHue'), saturation: read(light, 'LightSaturation'), drawScale: Math.fround(read(light, 'DrawScale')) });
      const skin = icon ? read(light, 'Skin') : null;
      if (!skin) continue;
      icons.push({ x: icon.x, y: icon.y, size: icon.size, color: [...icon.color], skin: plainRef(skin),
        // The inputs of the icon's placement, for validation (validate-coronas-play.mjs).
        light: { location: read(light, 'Location').map(Math.fround), hue: read(light, 'LightHue'),
          saturation: read(light, 'LightSaturation'), drawScale: Math.fround(read(light, 'DrawScale')) } });
    }
    return { icons, stats, visited, seen, frameWords: master ? [...master.words] : null };
  }
  return { update };
}
