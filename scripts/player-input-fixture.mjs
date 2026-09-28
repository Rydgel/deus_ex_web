/** Test-only Play driver for original input bindings and isolated target setup.
 *
 * Keep setup writes separate from input delivery: place() is the only helper
 * that assigns player Location, Rotation or ViewRotation. key/axis/button and
 * driveLegacy() deliver samples through Play's installed InputEvent path, and
 * tick() lets the original Actor.Tick scheduler consume them.
 */
const ROTATOR_UNITS_PER_RADIAN = 32768 / Math.PI;

const angleUnits = radians => Math.trunc(radians * ROTATOR_UNITS_PER_RADIAN);

/** Build a test fixture around the public Play input entry points. */
export function createPlayerInputFixture(game, {tickSeconds = 1 / 60, paint = null} = {}) {
  if (!game?.player?.collisionActor || typeof game.tick !== 'function')
    throw new TypeError('Player input fixture requires a live Play game');
  if (!(tickSeconds > 0)) throw new TypeError('Fixture tickSeconds must be positive');

  const heldKeys = new Set();
  const heldButtons = new Set();
  let yawUnitsPerMouse = null, pitchUnitsPerMouse = null;
  const runtime = game.doors.scriptRuntime.runtime;
  const playerActor = () => game.player.collisionActor;
  const read = (actor, name) => runtime.readNamed(actor, name);

  const key = (code, pressed) => {
    if (pressed) heldKeys.add(code);
    else heldKeys.delete(code);
    return game.inputKey(code, Boolean(pressed));
  };
  const axis = (name, delta) => game.inputAxis(name, delta);
  const button = (name, pressed) => {
    if (pressed) heldButtons.add(name);
    else heldButtons.delete(name);
    return game.inputButton(name, Boolean(pressed));
  };

  function releaseAll() {
    for (const code of [...heldKeys]) key(code, false);
    for (const name of [...heldButtons]) button(name, false);
  }

  function tick(frames = 1) {
    if (!Number.isInteger(frames) || frames < 0) throw new TypeError('Fixture tick count must be a nonnegative integer');
    for (let frame = 0; frame < frames; frame++) {
      game.tick(tickSeconds);
      paint?.();
    }
  }

  const wrapRotator = value => ((Math.trunc(value) + 32768) & 0xffff) - 32768;
  /** Turn the live player through installed MouseX/MouseY InputEvent bindings.
   * Each axis gain is learned from the observed ViewRotation change after a
   * real scheduler tick, then subsequent device deltas are feedback controlled.
   * This is test steering, not a replacement sensitivity or rotation model.
   */
  function steer(yaw, pitch = null, {maxFrames = 100, tolerance = 2} = {}) {
    if (!Number.isFinite(yaw) || (pitch !== null && !Number.isFinite(pitch)))
      throw new TypeError('Mouse steering requires finite yaw and optional pitch radians');
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new TypeError('Steering maxFrames must be positive');
    const targetYaw = angleUnits(yaw), targetPitch = pitch === null
      ? game.interaction.viewRotation[0] : angleUnits(pitch);
    for (let frame = 0; frame < maxFrames; frame++) {
      const before = game.interaction.viewRotation;
      const yawError = wrapRotator(targetYaw - before[1]);
      const pitchError = wrapRotator(targetPitch - before[0]);
      if (Math.abs(yawError) <= tolerance && Math.abs(pitchError) <= tolerance)
        return {frames: frame, yawUnitsPerMouse, pitchUnitsPerMouse};
      const dx = Math.abs(yawError) <= tolerance ? 0 : yawUnitsPerMouse
        ? Math.max(-2000, Math.min(2000, yawError / yawUnitsPerMouse)) : 1;
      const dy = Math.abs(pitchError) <= tolerance ? 0 : pitchUnitsPerMouse
        ? Math.max(-2000, Math.min(2000, pitchError / pitchUnitsPerMouse)) : 1;
      if (dx) axis('MouseX', dx);
      if (dy) axis('MouseY', dy);
      tick(1);
      const after = game.interaction.viewRotation;
      if (dx) {
        const observed = wrapRotator(after[1] - before[1]) / dx;
        if (Number.isFinite(observed) && Math.abs(observed) > 1e-8) yawUnitsPerMouse = observed;
      }
      if (dy) {
        const observed = wrapRotator(after[0] - before[0]) / dy;
        if (Number.isFinite(observed) && Math.abs(observed) > 1e-8) pitchUnitsPerMouse = observed;
      }
    }
    throw new Error(`Mouse-axis feedback did not reach yaw/pitch ${targetYaw}/${targetPitch}; ` +
      `view=${JSON.stringify(game.interaction.viewRotation)}, gains=${yawUnitsPerMouse}/${pitchUnitsPerMouse}`);
  }

  function steerAt(target, {maxFrames = 100, tolerance = 2} = {}) {
    if (!target) throw new TypeError('Mouse steering requires a live target');
    const location = currentLocation(target), position = game.player.position;
    const dx = location[0] - position[0], dy = location[1] - position[1];
    const yaw = Math.atan2(dy, dx);
    const pitch = Math.atan2(location[2] - (position[2] + game.player.baseEyeHeight), Math.hypot(dx, dy));
    steer(yaw, pitch, {maxFrames, tolerance});
    return {target};
  }

  /** Apply a placement pose through the test scene's existing collision path.
   * Angles are radians; Unreal Rotation/ViewRotation fields are integer units.
   * This fixture-only setup does not stand in for input or movement behavior.
   */
  function place(position, {yaw = 0, pitch = 0, zeroVelocity = true} = {}) {
    if (!Array.isArray(position) || position.length !== 3 || position.some(value => !Number.isFinite(value)))
      throw new TypeError('Player placement requires three finite coordinates');
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new TypeError('Player placement angles must be finite');
    const rotation = [angleUnits(pitch), angleUnits(yaw), 0];
    const pawn = playerActor();
    game.collision.queries.changeActor(pawn, () => {
      game.player.position = [...position];
      if (zeroVelocity) game.player.velocity = [0, 0, 0];
      game.player.yaw = yaw;
      game.player.bodyRotation = [...rotation];
      game.player.viewRotation = [...rotation];
    });
    return rotation;
  }

  const currentLocation = target => {
    const location = read(target, 'Location');
    if (!Array.isArray(location) || location.length !== 3 || location.some(value => !Number.isFinite(value)))
      throw new Error(`Cannot aim at ${target?.name ?? 'actor'} without its current Location`);
    return location;
  };

  const anglesFrom = (position, targetLocation) => {
    const dx = targetLocation[0] - position[0], dy = targetLocation[1] - position[1];
    const dz = targetLocation[2] - (position[2] + game.player.baseEyeHeight);
    return {yaw: Math.atan2(dy, dx), pitch: Math.atan2(dz, Math.hypot(dx, dy))};
  };

  /** Place beside a target, keep aiming from the live base eye, and let
   * HighlightCenterObject's real tick cadence populate FrobTarget. A miss is
   * an error: the fixture never writes FrobTarget or FrobTime.
   */
  /** `point` aims at a visible part of the target instead of its Location,
   * for example the exposed edge of an opened sliding panel whose Location is
   * inside the wall pocket. The original trace must still select `target`. */
  function aim(target, {position, point = null, distance = 48, maxFrames = 60, settleFrames = 0} = {}) {
    if (!target) throw new TypeError('Geometry frob requires a target actor');
    if (!(distance > 0) || !Number.isFinite(distance)) throw new TypeError('Aim distance must be positive and finite');
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new TypeError('Aim maxFrames must be a positive integer');
    if (settleFrames) tick(settleFrames);

    if (point && (!Array.isArray(point) || point.length !== 3 || point.some(value => !Number.isFinite(value))))
      throw new TypeError('Aim point requires three finite coordinates');
    const aimPoint = () => point ?? currentLocation(target);
    const firstTargetLocation = aimPoint();
    let initialPosition = position;
    if (!initialPosition) {
      const playerPosition = game.player.position;
      let dx = firstTargetLocation[0] - playerPosition[0], dy = firstTargetLocation[1] - playerPosition[1];
      const horizontal = Math.hypot(dx, dy);
      if (horizontal < 1e-4) { dx = 1; dy = 0; }
      else { dx /= horizontal; dy /= horizontal; }
      initialPosition = [firstTargetLocation[0] - dx * distance,
        firstTargetLocation[1] - dy * distance, firstTargetLocation[2]];
    }
    place(initialPosition);

    for (let frame = 0; frame < maxFrames; frame++) {
      const playerPosition = [...game.player.position];
      const angles = anglesFrom(playerPosition, aimPoint());
      // place() is the only fixture path allowed to set player angles. Passing
      // the live position keeps aim current when either target or pawn moves.
      place(playerPosition, {...angles, zeroVelocity: false});
      tick(1);
      if (game.interaction.frobTarget === target) return {target, frames: frame + 1};
    }
    throw new Error(`View trace did not select ${target.name ?? 'actor'} after ${maxFrames} real ticks ` +
      `(selected=${game.interaction.frobTarget?.name ?? 'None'}, target=${JSON.stringify(currentLocation(target))}, ` +
      `position=${JSON.stringify(game.player.position)}, baseEyeHeight=${game.player.baseEyeHeight}, ` +
      `ViewRotation=${JSON.stringify(game.interaction.viewRotation)})`);
  }

  async function frob(target, options) {
    aim(target, options);
    return game.use();
  }

  /** Step `distance` units from the target along the unit XY `direction` and
   * face further away. The spot must be inside the world: a zone-0
   * placement makes original physFalling dispatch FellOutOfWorld (JC dies). */
  function loseTarget(target, {distance = 400, direction = [-1, 0], maxFrames = 60} = {}) {
    if (!target) throw new TypeError('loseTarget requires the current target actor');
    const at = currentLocation(target);
    place([at[0] + direction[0] * distance, at[1] + direction[1] * distance, at[2]],
      {yaw: Math.atan2(direction[1], direction[0])});
    for (let frame = 0; frame < maxFrames; frame++) {
      tick(1);
      if (read(playerActor(), 'Region')?.['engine.actor.pointregion.zonenumber'] === 0)
        throw new Error(`loseTarget placed JC outside the world (zone 0) ${distance} units from ${target.name ?? 'actor'}; choose another direction`);
      if (game.interaction.frobTarget !== target) return {target: game.interaction.frobTarget, frames: frame + 1};
    }
    throw new Error(`View trace retained ${target.name ?? 'actor'} after moving ${distance} units and looking away`);
  }

  /** Turn away (by default 180 degrees) until HighlightCenterObject clears
   * FrobTarget. Original UpdateRotation copies the view yaw into Rotation, so
   * a caller whose next action uses GetAxes(Rotation), such as DropDecoration,
   * can keep its yaw (`yawOffset: 0`) and clear the target by pitch instead. */
  function clearTarget({maxFrames = 60, yawOffset = Math.PI, pitch = null} = {}) {
    const currentYaw = game.interaction.viewRotation?.[1] ?? 0;
    const currentPitch = game.interaction.viewRotation?.[0] ?? 0;
    place([...game.player.position], {
      yaw: currentYaw / ROTATOR_UNITS_PER_RADIAN + yawOffset,
      pitch: pitch ?? currentPitch / ROTATOR_UNITS_PER_RADIAN,
      zeroVelocity: false,
    });
    for (let frame = 0; frame < maxFrames; frame++) {
      tick(1);
      if (game.interaction.frobTarget === null) return {frames: frame + 1};
    }
    throw new Error(`View trace did not clear its target after ${maxFrames} real ticks ` +
      `(selected=${game.interaction.frobTarget?.name ?? 'None'})`);
  }

  /** Deliver legacy movement booleans as held User.ini keys. Rotation is
   * intentionally omitted; use place/aim for controlled fixture orientation,
   * or provide explicit raw axis samples through drive({axes}).
   */
  function driveLegacy(input = {}) {
    if (input.yaw !== undefined || input.pitch !== undefined)
      throw new Error('Legacy yaw/pitch are fixture placement angles; use place/aim, not tick input');
    const wanted = new Set();
    const forward = Number(input.forward ?? 0), right = Number(input.right ?? 0);
    if (forward > 0) wanted.add('ArrowUp');
    if (forward < 0) wanted.add('ArrowDown');
    if (right > 0) wanted.add('ArrowRight');
    if (right < 0) wanted.add('ArrowLeft');
    if (input.jump) wanted.add('Space');
    if (input.walk) wanted.add('ShiftLeft');
    if (input.crouch) wanted.add('KeyX');
    for (const code of [...heldKeys]) if (!wanted.has(code)) key(code, false);
    for (const code of wanted) if (!heldKeys.has(code)) key(code, true);
    for (const [name, delta] of Object.entries(input.axes ?? {})) axis(name, delta);
    for (const [name, pressed] of Object.entries(input.buttons ?? {})) button(name, pressed);
  }

  /** Generic explicit event batch for validators migrating from simulated
   * per-tick input objects. `keys`/`buttons` hold state; `axes` are samples.
   */
  function drive({keys = {}, axes = {}, buttons = {}} = {}) {
    for (const [code, pressed] of Object.entries(keys)) key(code, pressed);
    for (const [name, delta] of Object.entries(axes)) axis(name, delta);
    for (const [name, pressed] of Object.entries(buttons)) button(name, pressed);
  }

  return Object.freeze({key, axis, button, drive, driveLegacy, tick, steer, steerAt,
    place, aim, frob, loseTarget, clearTarget, releaseAll});
}
