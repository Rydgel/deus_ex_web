import { coordsTransform } from '../runtime/volumetric-fog.mjs';
import { createCoronaCache, coronaDecay, coronaSeen, coronaIcon, coronaFrame, coronaFrameFromCamera } from '../runtime/coronas.mjs';
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
 * Host choices, noted: the fade clock is the host's (`now`, seconds; the
 * original's appSeconds is the CPU clock too); dynamic lights in the leaf
 * (LeafLights) are not visited. */
export function createCoronaScan(runtime, { model, exportName, player }) {
  const cache = createCoronaCache(), byName = new Map();
  const read = (actor, name) => runtime.readNamed(actor, name);

  // Model.Lights holds export references in null-terminated lists.
  function leafLights(leaf) {
    const start = model.leaves[leaf]?.permeating ?? -1, out = [];
    if (start < 0) return out;
    for (let i = start; i < model.lights.length && model.lights[i]; i++) out.push(model.lights[i]);
    return out;
  }
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

  /** One main frame: `view` {location, rotation, fov}, the render
   * rectangle {width, height} in drawing-buffer pixels, the master frame
   * (visibility().master, or null) and the fade clock. Returns the icons in
   * cache order, each {x, y, size, color, skin}, and the frame's counts. */
  function update(view, rect, master, now) {
    const icons = [], stats = { leafLights: 0, visible: 0 };
    const viewer = player(), level = viewer ? runtime.levelFor(viewer) : null;
    const region = viewer ? runtime.regionValue(viewer) : null;
    if (!level?.hash || !region || region.leaf === -1 || !region.zone) return { icons, stats };
    const delta = coronaDecay(cache, now);
    // The frame DrawFrame reads: the master frame's words when OccludeBsp built
    // one, else Engine's own frame producers on the render rectangle. The line
    // checks end at its Coords.Origin (the helper's `frame + 0x34`).
    const { coords, frame } = master ? coronaFrame(master.words) : coronaFrameFromCamera(view, rect);
    const eye = coords.origin, slot = { next: 0 };
    for (const ref of leafLights(region.leaf)) {
      const light = actorFor(ref, level);
      if (!light) continue;
      stats.leafLights++;
      const location = read(light, 'Location').map(Math.fround);
      let visible = level.hash.lineCheck(eye, location, [0, 0, 0], 6, 0, null).outside;
      if (visible) {
        const hit = level.hash.lineCheck(eye, location, [0, 0, 0], 0x11, 0, null);
        visible = hit.outside || hit.actor === viewer;
      }
      if (visible) stats.visible++;
      coronaSeen(cache, slot, light, { visible, delta,
        qualifies: Boolean(read(light, 'bCorona')) && Boolean(read(light, 'Skin')) && !read(light, 'bDeleteMe'),
        actorIndex: () => level.actors.indexOf(light) });
    }
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
    return { icons, stats, frameWords: master ? [...master.words] : null };
  }
  return { update };
}
