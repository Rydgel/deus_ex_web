import { coordsTransform } from '../runtime/volumetric-fog.mjs';
import { createCoronaCache, coronaDecay, coronaSeen, coronaIcon, coronaFrame, coronaFrameFromCamera, coronaLineVisible, leafPermeatingLights } from '../runtime/coronas.mjs';
import { movingLightInView, movingLightLeafLists, viewPlanesOf, worldLightRadius } from '../runtime/dynamic-lighting.mjs';
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
    const list = movingLightLeafLists(model, candidates.map(light => ({ location: light.location,
      radius: worldLightRadius(light.values) }))).get(leaf);
    return list ? list.map(k => candidates[k].actor) : [];
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
    const eye = coords.origin, slot = { next: 0 };
    // Level->Model as the tracker left it for this frame (one view of its memory).
    const tracked = lineModel();
    const lineCheck = (start, end, extent, flags, extra, source) => level.hash.lineCheck(start, end, extent, flags, extra, source, tracked);
    // Helper 0x10b1bc00 for one light: the two line checks, then the entry.
    const visit = light => {
      stats.leafLights++;
      visited.push(light.name);
      const location = read(light, 'Location').map(Math.fround);
      const visible = coronaLineVisible(lineCheck, location, eye, viewer);
      if (visible) { stats.visible++; seen.push(light.name); }
      coronaSeen(cache, slot, light, { visible, delta,
        qualifies: Boolean(read(light, 'bCorona')) && Boolean(read(light, 'Skin')) && !read(light, 'bDeleteMe'),
        actorIndex: () => level.actors.indexOf(light) });
    };
    // DrawFrame 0x10b1b6b1-0x10b1b743: the leaf's permeating static lights,
    // then the leaf's LeafLights.
    for (const ref of leafPermeatingLights(model, region.leaf)) {
      const light = actorFor(ref, level);
      if (light) visit(light);
    }
    for (const light of dynamicLights(region.leaf, lights, master)) visit(light);
    for (const entry of cache.entries) {
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
