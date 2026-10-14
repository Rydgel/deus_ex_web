/** Validation only (scripts/validate-terminals-camera-browser.mjs,
 * docs/script-window-viewport.md "Camera pass"): on whichever side runs the
 * simulation (sim-worker.mjs `call`, or the page with ?sim=inline).
 * `front`: places the player 56 units in front of the named actor (along its
 * Rotation yaw, as validate-terminals-play.mjs approaches a wall terminal)
 * and points the view at it, so the page's own frob input reaches it.
 * Returns the player's FrobTarget, Location and ViewRotation and the last
 * HUD frame's ViewportWindow world frames (sim-session.mjs viewportState). */
export function terminalProbe(game, session, { front = null, placeCamera = null, placePlayer = null, playerPose = null, cameraName = 'SecurityCamera5', iterators = false, placeEmitters = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = (actor, name) => runtime.readNamed(actor, name);
  let placed = null;
  if (front) {
    const target = runtime.levelFor(player).actors.find(actor => actor?.name === front);
    if (!target) throw new Error(`terminalProbe: no actor ${front}`);
    const at = read(target, 'Location'), yaw = read(target, 'Rotation')[1] * Math.PI / 32768;
    const location = [at[0] + Math.cos(yaw) * 56, at[1] + Math.sin(yaw) * 56, at[2]];
    if (Math.hypot(...read(player, 'Location').map((v, i) => v - location[i]).slice(0, 2)) > 8)
      runtime.farMoveActor(player, location, 0, 1);
    const eye = game.view().location, d = at.map((v, i) => v - eye[i]);
    const units = r => (Math.round(r * 32768 / Math.PI) + 65536) % 65536;
    const rotation = [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))), units(Math.atan2(d[1], d[0])), 0];
    runtime.writeNamed(player, 'ViewRotation', rotation);
    placed = { location: [...read(player, 'Location')], rotation };
  }
  // `placePlayer` [x, y, z]: the player stands elsewhere (the corona pass
  // lists the lights of the player's leaf, whatever the camera frame sees).
  if (placePlayer) runtime.farMoveActor(player, placePlayer, 0, 1);
  // `playerPose` {location, rotation, viewRotation, anim}: the player as another capture measured him (the original's
  // security-camera screen, scripts/camera-acceptance.mjs): where he stands, which way his mesh and view face, and the
  // animation fields the mesh's pose follows (GetFrame reads the sequence, the frame, the blend arrays).
  if (playerPose) {
    runtime.farMoveActor(player, playerPose.location, 0, 1);
    if (playerPose.rotation) runtime.writeNamed(player, 'Rotation', playerPose.rotation);
    if (playerPose.viewRotation) runtime.writeNamed(player, 'ViewRotation', playerPose.viewRotation);
    for (const [name, value] of Object.entries(playerPose.anim ?? {})) runtime.writeNamed(player, name, value);
  }
  // `placeEmitters` {location, rotation, count}: the first `count` LaserTriggers (the doorway beams: each
  // trigger's LaserEmitter follows it) and their beam proxies stand at the location pointing along the
  // rotation, one 32 units above the other (a fixture: the beams then lie where a mirror reflects them;
  // the proxy moves too, since an emitter stays frozen while its proxy is far from the player).
  if (placeEmitters) {
    const triggers = runtime.levelFor(player).actors.filter(actor => actor && /^LaserTrigger\d+$/.test(actor.name)).slice(0, placeEmitters.count ?? 1);
    triggers.forEach((trigger, i) => {
      const location = placeEmitters.location.map((v, k) => k === 2 ? v + 32 * i : v);
      runtime.farMoveActor(trigger, location, 0, 1);
      runtime.writeNamed(trigger, 'Rotation', placeEmitters.rotation);
      const emitter = runtime.levelFor(player).actors.find(actor => actor && /^LaserEmitter\d+$/.test(actor.name) && read(actor, 'Owner') === trigger)
        ?? runtime.levelFor(player).actors.filter(actor => actor && /^LaserEmitter\d+$/.test(actor.name))[i];
      const proxy = emitter && read(emitter, 'proxy');
      if (proxy) runtime.farMoveActor(proxy, location, 0, 1);
    });
  }
  const camera = level => level.actors.find(actor => actor?.name === cameraName);
  const cam = camera(runtime.levelFor(player));
  // `placeCamera` {location, rotation}: SecurityCamera5 stands elsewhere and
  // keeps its aim (no swing), to put the view where a map's mirrors, sky,
  // decals or coronas are (a fixture: the original camera does not move).
  if (placeCamera && cam) {
    runtime.writeNamed(cam, 'bSwing', false);
    runtime.writeNamed(cam, 'Location', placeCamera.location);
    runtime.writeNamed(cam, 'Rotation', placeCamera.rotation);
    runtime.writeNamed(cam, 'DesiredRotation', placeCamera.rotation);
  }
  // Actors inside the camera's view cone (angle test only) with their
  // LastRenderTime, to see which the camera frame did not stamp.
  const cone = [];
  if (cam) {
    const at = read(cam, 'Location'), r = read(cam, 'Rotation'), u = Math.PI / 32768;
    const f = [Math.cos(r[0] * u) * Math.cos(r[1] * u), Math.cos(r[0] * u) * Math.sin(r[1] * u), Math.sin(r[0] * u)];
    for (const actor of runtime.levelFor(player).actors) {
      if (!actor || actor === cam || !read(actor, 'Mesh')) continue;
      const p = read(actor, 'Location'), d = p.map((v, i) => v - at[i]), len = Math.hypot(...d);
      if (len > 1 && (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / len > 0.7)
        cone.push({ name: actor.name, hidden: Boolean(read(actor, 'bHidden')), distance: Math.round(len), lastRenderTime: read(actor, 'LastRenderTime') });
    }
  }
  return { placed, cone, camera: cam ? { location: [...read(cam, 'Location')], rotation: [...read(cam, 'Rotation')] } : null, frobTarget: read(player, 'FrobTarget')?.name ?? null, location: [...read(player, 'Location')],
    viewRotation: [...read(player, 'ViewRotation')], viewports: session.viewportState(),
    // The iterator state of the same frame (iteratorState), for the camera frame's items.
    iterators: iterators ? session.iteratorState() : null };
}
