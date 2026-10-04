/** The simulation side of a Play frame (docs/sim-worker.md). Each step runs
 * where animate() ran it before the split, with the same error gating; the
 * frame's results come back as plain data for the drawing side. Steps not
 * yet moved here still run from main.mjs. */
import { handleOf } from '../runtime/script-object-handles.mjs';

/** A thrown error as plain data: structured clone drops an Error's own
 * properties (`travel`, `partial`). */
export const plainError = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error),
  stack: error?.stack ?? null, travel: error?.travel ?? null, partial: error?.partial ?? null });

export function createSimSession(game) {
  const runtime = game.doors.scriptRuntime.runtime;
  let failed = false, panZones = [], lastViewLocation = null;
  // The live records of this frame's moving-light scan, for the simulation
  // side's own consumers (the mesh lighting frame); the snapshot carries
  // handles instead of actors.
  const live = { lights: null };
  // Each mover's brush-matrix inputs that never change (class defaults
  // merged), shared by every frame's mover states.
  const moverValues = new Map(game.collision.movers.map(mover => [mover.name, {
    MainScale: mover.values.MainScale, PostScale: mover.values.PostScale, PrePivot: mover.values.PrePivot,
    Rotation: mover.values.Rotation }]));
  const movers = () => game.collision.movers.map(mover => ({ name: mover.name, values: moverValues.get(mover.name),
    position: [...mover.position], rotation: mover.rotation ? [...mover.rotation] : null, offset: [...mover.collider.offset] }));
  const plainView = view => ({ location: [...view.location], rotation: [...view.rotation], fov: view.fov });
  const plainLight = light => ({ handle: handleOf(light.actor), name: light.name, location: light.location,
    values: light.values, levelBrightness: light.levelBrightness });
  // Render.dll's sky frame (0x10b18410): only when LevelInfo.SkyZone (+0x384)
  // is set; the frame zone's ZoneInfo (LevelInfo when the zone has none)
  // supplies its SkyZone, whose Location is the sky frame's origin and whose
  // Rotation detransforms the view coords. In Play the zones' SkyZone is what
  // the original LinkToSkybox set at startup.
  function sky(location) {
    const level = runtime.levelFor(game.player.collisionActor), info = level.actors[0];
    if (!runtime.readNamed(info, 'SkyZone')) return null;
    const zone = level.pointRegion(location)?.zone ?? info;
    const sky = runtime.readNamed(zone, 'SkyZone') ?? runtime.readNamed(info, 'SkyZone');
    return { location: [...runtime.readNamed(sky, 'Location')], rotation: [...runtime.readNamed(sky, 'Rotation')] };
  }
  return {
    live,
    /** The zone names whose live pan speeds the world's auto-panned surfaces
     * read (world.pannedZoneNames). */
    setPanZones(names) { panZones = [...names]; },
    /** PlayerCalcView outside a frame (mode changes, Player start). */
    view() { const view = plainView(game.view()); lastViewLocation = view.location; return view; },
    movers,
    reset() { game.reset(); failed = false; },
    /** The frame's first steps: the tick (and lip sync), PlayerCalcView, the
     * render viewport, SetupDynamics' moving-light scan, the sky frame, the
     * frob target and the surface pan inputs. `run` is false while the page
     * pauses the simulation; `halted` while it stopped on an error of its
     * own. A step that throws stops the later gated steps, as
     * pauseForRuntimeError did. */
    begin({ dt, run, halted, width, height, lipSync = null }) {
      const errors = [], stopped = () => halted || failed;
      const fail = error => { failed = true; errors.push(plainError(error)); };
      if (run && !stopped()) {
        try { game.tick(dt); lipSync?.update(dt); } catch (error) { fail(error); }
      }
      const frame = { errors, movers: movers(), view: null, renderRect: null, lights: null, sky: null, target: null, pan: null };
      live.lights = null;
      try { frame.view = plainView(game.view()); lastViewLocation = frame.view.location; } catch (error) { fail(error); }
      if (frame.view && !stopped()) {
        try { frame.renderRect = { ...game.renderViewport(width, height) }; } catch (error) { fail(error); }
      }
      if (!stopped()) {
        try { live.lights = game.movingLights(); frame.lights = live.lights.map(plainLight); } catch (error) { fail(error); }
      }
      const rect = frame.renderRect;
      // The page draws the world (and asks for the sky frame) unless the
      // root window's render viewport is empty.
      if (!rect || (rect.render && rect.width > 0 && rect.height > 0)) {
        try { frame.sky = lastViewLocation ? sky(lastViewLocation) : null; } catch (error) { fail(error); }
      }
      try { const target = game.target(); frame.target = target ? { label: target.label } : null; } catch (error) { fail(error); }
      try {
        const pan = game.surfacePan();
        frame.pan = { timeSeconds: pan.timeSeconds, speeds: Object.fromEntries(panZones.map(name => [name, pan.zoneSpeeds(name)])) };
      } catch (error) { fail(error); }
      return frame;
    },
  };
}
