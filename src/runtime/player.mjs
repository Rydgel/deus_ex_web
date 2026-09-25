import { groundVelocity } from './velocity.mjs';
import { safeNormal, stepUp } from './steps.mjs';
import { falling } from './falling.mjs';
import { updateWalkingBob, updateEyeHeight, decayWalkBob } from './camera.mjs';
import { moveQuery } from './move-query.mjs';
import { runPlayerPhysics } from './player-physics.mjs';
import { walkingInput, healthyWalkingGroundSpeed } from './player-input.mjs';
import { defaultPawnCollisionHeight } from './stance.mjs';
import { setCollisionSize } from './relocation.mjs';
import { updateCrouch } from './crouch-query.mjs';
import { scriptTrace } from './script-trace.mjs';
import { handleWalkingControls, stanceCrouchRequested, afterStanceControls, afterJumpControls } from './player-controls.mjs';

const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const norm = a => Math.hypot(...a);
const walkable = hit => hit && hit.normal[2] >= .7;

export const FIXED_STEP = 1 / 120;
// ULevel.Tick, Engine.dll VA 0x103a54c8–0x103a54df, caps actor time at 0.4s.
export const MAX_FRAME_TIME = .4;

/** A bounded first-person physics implementation. Script-derived single-player
 * stance/speed rules are kept explicit until the general VM executes them. */
export class Player {
  constructor(collision, defaults, start, zoneAt, checkBob = null, startYaw = 0) {
    this.collision = collision; this.defaults = defaults; this.start = [...start]; this.zoneAt = zoneAt;
    this.checkBob = checkBob;
    this.startYaw = startYaw;
    this.radius = defaults.CollisionRadius;
    this.standingHeight = defaultPawnCollisionHeight(defaults.CollisionHeight);
    this.motionFlags = defaults.bJustTeleported ? 0x100 : 0;
    const player = this;
    this.collisionActor = { controlledPlayer: true, static: Boolean(defaults.bStatic), movable: defaults.bMovable ?? true,
      flags: (defaults.bCollideActors ? 1 : 0) | (defaults.bCollideWorld ? 2 : 0) |
        (defaults.bBlockActors ? 4 : 0) | (defaults.bBlockPlayers ? 8 : 0),
      get motionFlags() { return player.motionFlags; }, set motionFlags(value) { player.motionFlags = value >>> 0; },
      get position() { return player.position; }, set position(value) { player.position = value; },
      get radius() { return player.radius; }, set radius(value) { player.radius = value; },
      get height() { return player.height; }, set height(value) { player.height = value; },
      get base() { return player.physicsPawn ? player.physicsPawn.base : player.spawnBase ?? null; },
      set base(value) { if (player.physicsPawn) player.physicsPawn.base = value; else player.spawnBase = value; },
      get rotation() { return player.bodyRotation; }, set rotation(value) { player.bodyRotation = value; },
      get baseEyeHeight() { return player.baseEyeHeight; }, set baseEyeHeight(value) { player.baseEyeHeight = value; },
      // The viewer's camera integrates look input (the original UpdateRotation
      // is not run), so the script-visible view fields read the live player.
      get viewRotation() { return player.viewRotation; }, set viewRotation(value) { player.viewRotation = value; },
      get eyeHeight() { return player.eyeHeight; }, set eyeHeight(value) { player.eyeHeight = value; },
      // PlayerPawn.WalkBob is the CheckBob state vector; a script write
      // (PlayerPawn.ShowMenu's `WalkBob = vect(0,0,0)`) lands there too.
      get walkBob() { return player.walkBob; },
      set walkBob(value) { player.walkBob = [...value]; if (player.bobState) player.bobState.WalkBob = [...value]; },
      get physics() { return player.physicsPawn?.physics ?? player.spawnPhysics ?? (player.grounded ? 1 : 2); },
      set physics(value) { if (player.physicsPawn) player.physicsPawn.physics = value; else player.spawnPhysics = value; player.grounded = value === 1; },
      get velocity() { return player.velocity; }, set velocity(value) { player.velocity = value; },
      get isCrouching() { return Boolean(player.controls?.isCrouching); },
      set isCrouching(value) { player.controls.isCrouching = Boolean(value); },
      get oldLocation() { return player.physicsPawn?.oldLocation ?? player.spawnOldLocation; },
      set oldLocation(value) { if (player.physicsPawn) player.physicsPawn.oldLocation = value; else player.spawnOldLocation = value; },
    };
    // Preserve only the movement port descriptors, never a prior script identity.
    this.movementDescriptors = Object.getOwnPropertyDescriptors(this.collisionActor);
    this.stancePawn = { defaultCollisionHeight: defaults.CollisionHeight, defaultBaseEyeHeight: defaults.BaseEyeHeight,
      defaultCollisionRadius: defaults.CollisionRadius, netMode: 0, carriedDecoration: null,
      get position() { return player.position; },
      get radius() { return player.radius; }, get height() { return player.height; },
      get prePivot() { return player.prePivot; }, set prePivot(value) { player.prePivot = value; },
      get baseEyeHeight() { return player.baseEyeHeight; }, set baseEyeHeight(value) { player.baseEyeHeight = value; },
      get eyeHeight() { return player.eyeHeight; }, set eyeHeight(value) { player.eyeHeight = value; },
      setCollisionSize(radius,height) { setCollisionSize({ hash: player.actorRegistered ? player.collision.queries : null }, player.collisionActor, radius, height); },
      move(delta) { return player.move(delta).success; },
    };
    this.reset();
  }
  /** Bind the native SpawnActor identity before placement/startup. This only
   * supplies the browser movement storage; SpawnActor owns registration. */
  bindCollisionIdentity(actor, values = this.defaults) {
    Object.defineProperties(actor, this.movementDescriptors);
    this.collisionActor = actor;
    this.physicsPawn = null;
    this.spawnBase = values.Base ?? null;
    this.spawnPhysics = values.Physics ?? 0;
    this.grounded = this.spawnPhysics === 1;
    const fields = { Location:'position', Rotation:'rotation', CollisionRadius:'radius',
      CollisionHeight:'height', OldLocation:'oldLocation', ViewRotation:'viewRotation',
      EyeHeight:'eyeHeight', BaseEyeHeight:'baseEyeHeight', WalkBob:'walkBob', Velocity:'velocity',
      bIsCrouching:'isCrouching' };
    for (const [field, member] of Object.entries(fields)) if (values[field] !== undefined)
      actor[member] = Array.isArray(values[field]) ? [...values[field]] : values[field];
    this.motionFlags = values.bJustTeleported ? 0x100 : 0;
    actor.static = Boolean(values.bStatic);
    actor.movable = Boolean(values.bMovable);
    actor.values = { ...values,
      get Location() { return actor.position; }, get Rotation() { return actor.rotation; },
      get CollisionRadius() { return actor.radius; }, get CollisionHeight() { return actor.height; },
      get Velocity() { return actor.velocity; } };
    actor.collisionValues = actor.values;
    return actor;
  }
  reset() {
    this.spawnBase = null; this.spawnPhysics = undefined;
    this.physicsPawn = null; this.unimplementedPhysicsEffects = new Set();
    this.position = [...this.start]; this.velocity = [0, 0, 0]; this.height = this.standingHeight;
    this.spawnOldLocation = [...this.start]; this.crouchInput = false;
    this.controls = { isCrouching: false, forceDuck: false };
    this.yaw = this.startYaw;
    this.bodyRotation = [0, (this.startYaw * 32768 / Math.PI) | 0, 0];
    this.viewRotation = [...this.bodyRotation];
    this.grounded = false; this.crouched = false; this.forceDuck = false; this.jumpHeld = false;
    this.steps = 0; this.jumps = 0; this.lastHit = null;
    this.eyeHeight = this.defaults.BaseEyeHeight; this.bobTime = 0; this.walkBob = [0, 0, 0];
    this.baseEyeHeight = this.defaults.BaseEyeHeight;
    this.prePivot = (this.defaults.PrePivot ?? [0,0,0]).slice();
    this.justLanded = false; this.joltMagnitude = 0; this.shakeVert = 0;
    this.bobState = { bobtime: 0, WalkBob: [0, 0, 0], Bob: this.defaults.Bob ?? 0, AppliedBob: 0, LandBob: 0, GroundSpeed: this.defaults.GroundSpeed };
    const spawn = this.collision.findSpot(this.position, this.extent);
    if (!spawn) throw new Error('No valid collision placement near player start');
    this.position = spawn;
    this.spawnOldLocation = spawn.slice();
  }
  get extent() { return [this.radius, this.radius, this.height]; }
  get traceEye() { return add(this.position, [0, 0, this.baseEyeHeight]); }
  get eye() { return add(add(this.position, [0, 0, this.eyeHeight]), this.walkBob); }
  move(delta, ignore = null) {
    if (this.nativeMove && !ignore) {
      const result = this.nativeMove(delta);
      if (result.hit) this.lastHit = { normal: result.hit.normal, actor: result.hit.actor?.name ?? null, node: result.hit.node ?? null };
      return result;
    }
    if (this.collision.queries && !ignore) {
      const { position, time, hit, success } = moveQuery({ source: this.collisionActor,
        worldActor: this.collision.queries.levelInfo, start: this.position, delta, extent: this.extent,
        multiLineCheck: query => this.collision.queries.multiLineCheck(query) });
      if (this.actorRegistered) this.collision.queries.changeActor(this.collisionActor, () => { this.position = position; });
      else this.position = position;
      if (hit) this.lastHit = { normal: hit.normal, actor: hit.actor?.name ?? null, node: hit.node ?? null };
      return { hit, time, success };
    }
    // ULevel.MoveActor extends the trace two units, then removes those units
    // from the returned distance (Engine.dll 0x103993bc / 0x103997c9).
    const size = norm(delta);
    if (size < 1e-8) return { hit: null, time: 1, success: true };
    const hit = this.collision.sweep(this.position, scale(delta, (size + 2) / size), this.extent, ignore);
    const time = hit ? Math.max(0, Math.min(1, ((size + 2) * hit.time - 2) / size)) : 1;
    this.position = add(this.position, scale(delta, time));
    if (hit) this.lastHit = { normal: hit.normal, actor: hit.actor?.name ?? null, node: hit.node ?? null };
    return { hit, time, success: time > 0 };
  }
  adjustFloor() {
    // APawn.physWalking uses a MaxStepHeight + 2 extent probe. Distances here
    // include the model trace backoff, not just the geometric feet-to-floor gap.
    const depth = this.defaults.MaxStepHeight + 2;
    const hit = this.collision.sweep(this.position, [0, 0, -depth], this.extent);
    if (!walkable(hit)) { this.grounded = false; return; }
    this.grounded = true;
    const distance = hit.time * depth;
    if (distance > 2.4) this.move([0, 0, -depth]);
    else if (distance < 1.9) this.move([0, 0, 2.1 - distance]);
  }
  stance(duck) {
    const height = duck ? 16 : this.standingHeight;
    if (this.collision.queries) {
      this.forceDuck = updateCrouch(this.stancePawn, duck, this.forceDuck,
        (end,start,extent) => scriptTrace(this.collision.queries,this.collisionActor,end,start,true,extent));
      this.crouched = this.height < this.standingHeight;
      return;
    }
    // Synthetic geometry fixtures retain their former placement adapter.
    const target = add(this.position, [0, 0, height - this.height]);
    if (height < this.height || !this.collision.overlaps(target, [this.radius, this.radius, height])) {
      this.eyeHeight -= height - this.height;
      this.position = target; this.height = height;
      this.baseEyeHeight = this.height - (this.standingHeight - this.defaults.BaseEyeHeight);
    }
    this.crouched = this.height < this.standingHeight;
    this.forceDuck = this.crouched && !duck;
  }
  tick(dt, input = {}) {
    this.steps++;
    if (this.collision.queries) this.controls = handleWalkingControls(this.controls,
      { duck: input.crouch, run: input.walk }, { alwaysRun: true, toggleCrouch: false });
    // PlayerWalking.PlayerMove gets axes and runs CheckBob before UpdateRotation
    // and ProcessMove. Use the incoming velocity, GroundSpeed and body rotation.
    this.updateBob(dt);
    const movementYaw = this.yaw;
    const movementRotation = this.bodyRotation;
    this.yaw = input.yaw ?? this.yaw;
    // Browser controls provide radians. The simulation boundary stores Unreal
    // integer body yaw; GetAxes reads it on the following PlayerMove call.
    this.bodyRotation = [0, (this.yaw * 32768 / Math.PI) | 0, 0];
    this.viewRotation = [input.pitch === undefined ? this.viewRotation[0] : (input.pitch * 32768 / Math.PI) | 0, this.bodyRotation[1], 0];
    this.crouchInput = Boolean(input.crouch);
    this.stance(this.collision.queries ? stanceCrouchRequested(this.controls) : this.crouchInput);
    if (this.collision.queries) this.controls = afterStanceControls(this.controls, this.forceDuck);
    const previousZ = this.position[2];
    const zone = this.zoneAt(this.position);
    const gravity = zone.ZoneGravity ?? [0, 0, -950], friction = zone.ZoneGroundFriction ?? 8;
    if (input.jump && !this.jumpHeld && this.grounded && !this.forceDuck) {
      this.velocity[2] = this.defaults.JumpZ; this.grounded = false; this.jumps++;
    }
    this.jumpHeld = Boolean(input.jump);
    if (this.collision.queries) {
      const transition = afterJumpControls(this.controls, this.grounded ? 1 : 2);
      this.controls = transition.state;
      if (transition.animation) this.unimplementedPhysicsEffects.add(`${transition.animation} animation`);
    }
    const forward = Math.max(-1, Math.min(1, input.forward ?? 0)), right = Math.max(-1, Math.min(1, input.right ?? 0));
    const yaw = movementYaw, magnitude = Math.max(1, Math.hypot(forward, right));
    const direction = [(Math.cos(yaw) * forward - Math.sin(yaw) * right) / magnitude, (Math.sin(yaw) * forward + Math.cos(yaw) * right) / magnitude, 0];
    const groundSpeed = this.collision.queries ? healthyWalkingGroundSpeed(this.defaults.GroundSpeed, forward)
      : Math.max(100, this.defaults.GroundSpeed * (forward < 0 ? .65 : 1));
    this.bobState.GroundSpeed = groundSpeed;
    if (this.collision.queries) {
      // Browser key axes map to the evidenced post-PlayerInput values (6000).
      // Original PlayerMove scales by .4 and uses incoming integer GetAxes.
      const { newAccel } = walkingInput({ rotation: movementRotation, aForward: forward * 6000, aStrafe: right * 6000 });
      const oldZ = runPlayerPhysics(this, dt, { acceleration: newAccel,
        groundSpeed, isWalking: this.controls.isWalking, zone });
      this.updateView(dt, oldZ);
      return;
    }
    if (this.grounded) {
      const acceleration = scale(direction, this.defaults.AccelRate), magnitude = norm(acceleration);
      this.velocity = groundVelocity({ velocity: [this.velocity[0], this.velocity[1], 0], acceleration,
        direction: magnitude ? scale(acceleration, 1 / magnitude) : [0, 0, 0], dt,
        maxSpeed: groundSpeed, accelRate: this.defaults.AccelRate, friction,
        walking: Boolean(input.walk || this.crouched) }).velocity;
    }

    const origin = [...this.position], horizontal = [this.velocity[0] * dt, this.velocity[1] * dt, 0];
    const walkingPhysics = this.grounded;
    let justTeleported = false;
    if (this.grounded) {
      this.velocity[2] = 0;
      const delta = horizontal.map(Math.fround), { time } = this.move(delta);
      if (time < 1) {
        // physWalking at 0x103cb196–0x103cb23c calls stepUp from the first
        // impact, passing the remaining delta and its original desired direction.
        const pawn = {
          maxStepHeight: this.defaults.MaxStepHeight, isPlayer: true, mass: this.defaults.Mass,
          velocity: this.velocity, physics: 1, justTeleported: false,
          move: movement => {
            const { hit, time } = this.move(movement);
            return { time: Math.fround(time), normal: hit?.normal.map(Math.fround) ?? [0, 0, 0],
              actor: hit?.actor && { pushableDecoration: Boolean(hit.actor.values?.bPushable), mass: hit.actor.values?.Mass } };
          },
          // Actor.HitWall is an empty event; none of JC's script ancestors
          // overrides it. Native pawn bookkeeping and object pushing remain
          // outside this adapter's verified scope (see docs/movement.md).
          hitWall() {},
        };
        stepUp(pawn, [0, 0, gravity[2] > 0 ? 1 : -1], safeNormal(delta),
          delta.map(v => Math.fround(v * Math.fround(1 - Math.fround(time)))));
        this.velocity = pawn.velocity; justTeleported = pawn.justTeleported;
      }
      this.adjustFloor();
    } else {
      const f = Math.fround;
      const pawn = {
        position: this.position, velocity: this.velocity, physics: 2,
        // Original keyboard Axis Speed 300 -> ReadInput factor 20 ->
        // PlayerMove factor 0.4. Falling limits the full input itself.
        acceleration: scale(direction, 2400 * magnitude).map(f),
        airControl: this.defaults.AirControl, accelRate: this.defaults.AccelRate,
        groundSpeed, gravity, zoneVelocity: zone.ZoneVelocity ?? [0, 0, 0],
        terminalVelocity: zone.ZoneTerminalVelocity ?? 2500,
        airControlBlocked: delta => Boolean(this.collision.sweep(pawn.position, delta, this.extent)),
        move: delta => {
          this.position = [...pawn.position];
          const { hit, time } = this.move(delta), travel = f(time);
          pawn.position = this.position.map(f);
          return { time: travel, normal: hit?.normal.map(f) ?? [0, 0, 0], actor: hit?.actor };
        },
        hitWall() {}, // Original empty JC HitWall script event; native bookkeeping remains open.
        landed: () => {
          // DeusExPlayer.Landed overrides PlayerPawn.Landed without assigning
          // LandBob. Its audio, animation and damage effects remain separate.
          // processLanded fitting and remaining-time dispatch still need parity.
          this.justLanded = true;
          pawn.physics = 1; pawn.velocity[2] = 0;
        },
      };
      falling(pawn, dt);
      this.position = pawn.position; this.velocity = pawn.velocity; this.grounded = pawn.physics === 1;
    }
    // Infer horizontal speed after obstruction, so walking into a wall does not
    // retain a full-speed impulse on release. Stance changes happen before origin.
    if (walkingPhysics && this.grounded && !justTeleported) for (let i = 0; i < 2; i++) this.velocity[i] = (this.position[i] - origin[i]) / dt;
    this.updateView(dt, previousZ);
  }
  updateView(dt, previousZ) {
    Object.assign(this, updateEyeHeight({ physics: this.grounded ? 1 : 2,
      eyeHeight: this.eyeHeight, baseEyeHeight: this.baseEyeHeight, locationZ: this.position[2], oldLocationZ: previousZ,
      justLanded: this.justLanded, timeDilation: this.timeDilation ?? 1, shakeVert: this.shakeVert,
      bob: this.bobState.Bob, joltMagnitude: this.joltMagnitude }, dt));
  }
  updateBob(dt) {
    // Execute the actual PlayerPawn.CheckBob bytecode loaded from local Engine.u.
    if (this.checkBob) {
      updateWalkingBob(this.bobState, this.checkBob, { deltaTime: dt, velocity: this.velocity,
        rotation: this.bodyRotation, physics: this.grounded ? 1 : 2 });
    } else {
      // Geometry-only test fixtures have no Engine.u script; Play always does.
      this.bobState.bobtime = 0; this.bobState.WalkBob = decayWalkBob(this.bobState.WalkBob, dt);
    }
    this.walkBob = [...this.bobState.WalkBob]; this.bobTime = this.bobState.bobtime;
  }
  status() {
    return { position: [...this.position], velocity: [...this.velocity], eye: this.eye, grounded: this.grounded,
      crouched: this.crouched, forceDuck: this.forceDuck, radius: this.radius, height: this.height,
      steps: this.steps, jumps: this.jumps, lastHit: this.lastHit, eyeHeight: this.eyeHeight, walkBob: [...this.walkBob] };
  }
}

// Retained for synthetic movement fixtures. Play uses the original level
// frame delta (level-tick.mjs), not this former 120 Hz catch-up accumulator.
export class FixedClock {
  constructor(step = FIXED_STEP) { this.step = step; this.accumulator = 0; }
  advance(seconds, tick) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.accumulator += Math.min(seconds, MAX_FRAME_TIME);
    while (this.accumulator + 1e-10 >= this.step) { tick(this.step); this.accumulator -= this.step; }
  }
  reset() { this.accumulator = 0; }
}
