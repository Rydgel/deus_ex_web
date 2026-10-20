/** The adapters of the O3 recorder (src/runtime/o3-record.mjs): for each native physics body Play runs, what it reads when entered, the service calls it
 * makes in order, and what it leaves behind, in the case format the oracle drivers replay (scripts/native-o3-replay.py, "--o3" of the native-*-oracle.py
 * drivers). docs/stage-5-exit-criteria.md "O3: the original's code on Play's inputs".
 *
 * A recorded call is {body, args, config, before, events, after}:
 *   config   the constants the body reads that are not the pawn's tracked state (zone gravity, speeds, the collision extent),
 *   before   the TRACKED STATE at entry, `after` at exit; an event carries it before (`pre`) and after (`post`) the service it names,
 *   events   the body's service calls in order, each {k, args, res?, pre, post}: MoveActor and line checks answer with the `res` Play's world gave,
 *            and a nested native body (prelude, flying, falling, landed, processHitWall) is one event the oracle stubs at its address.
 * The oracle runs the original body from `before`+`config`, answers every service from the recorded event (checking the call it makes is the one Play made, in
 * order) and installs Play's `post` state after it, so the world's answers are the inputs and everything the body itself computes is the original's.
 * The comparison (scripts/validate-stage5-o3.mjs) is bit-exact: the native's events (k, args, pre) and its `after` against Play's. */
import {o3Service} from '../src/runtime/o3-record.mjs';
import {identityOf} from '../src/runtime/actor-touch.mjs';

const f = Math.fround;
const vec = v => [...v];
/** The tracked state: every pawn field the physics bodies write or a service changes, in the oracle's names (native-o3-replay.py STATE). */
export function trackedState(pawn, ids) {
  if (!pawn.self) return hostState(pawn, ids);
  return {
    position: vec(pawn.position), velocity: vec(pawn.velocity), acceleration: vec(pawn.acceleration), oldLocation: vec(pawn.oldLocation),
    physics: Number(pawn.physics), justTeleported: Boolean(pawn.justTeleported), isWalking: Boolean(pawn.isWalking),
    hitSlopedWall: Boolean(pawn.hitSlopedWall), canJump: Boolean(pawn.canJump), moveTimer: pawn.moveTimer, base: ids.ref(pawn.base),
  };
}

/** A serialized map actor or spawned view that has no pawn view (a decoration falling): the fields its non-Pawn physics reads and writes. */
function hostState(host, ids) {
  return {position: vec(host.position), velocity: vec(host.velocity), acceleration: vec(host.acceleration), oldLocation: vec(host.oldLocation),
    physics: Number(host.physics), justTeleported: Boolean(host.justTeleported), landingCounter: host.landingCounter ?? 0, base: ids.ref(host.o3Base)};
}

/** Actor identities across a recording: null, 'world' (the level's LevelInfo) or a small integer per distinct actor, with what the original reads of it. */
export class ActorIds {
  constructor(world) { this.world = world; this.ids = new Map(); this.info = []; }
  ref(actor) {
    if (actor == null) return null;
    if (actor === this.world || actor?.name === 'LevelInfo0') return 'world';
    let id = this.ids.get(actor);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(actor, id);
      this.info[id] = this.describe(actor);
    }
    return id;
  }
  describe(actor) {
    const lineage = actor.lineage ?? [];
    return {name: actor.name, isPawn: lineage.includes('engine.pawn'), isPlayerPawn: lineage.includes('engine.playerpawn'),
      isDecoration: lineage.includes('engine.decoration'), pushable: Boolean(actor.pushableDecoration), mass: actor.mass ?? null};
  }
}

const hitResult = (hit, ids) => ({time: hit.time, normal: vec(hit.normal), actor: ids.ref(hit.actor)});
const lineResult = (hit, ids) => ({...hitResult(hit, ids), location: hit.location ? vec(hit.location) : null, outside: hit.outside === undefined ? null : Boolean(hit.outside)});
/** The services a body's pawn offers, with the event each makes: `args` from the call's arguments, `res` from its result. */
const SERVICES = {
  move: {k: 'move', args: ([delta]) => [vec(delta)], res: hitResult},
  lineCheck: {k: 'line', args: ([start, end, extent, flags, extra = 0]) => [vec(start), vec(end), vec(extent), flags, extra], res: lineResult},
  hitWall: {k: 'wall', args: ([hit], ids) => [vec(hit.normal), ids.ref(hit.actor)]},
  setPhysics: {k: 'physics', args: ([next, support = null], ids) => [next, ids.ref(support)]},
  setSupportBase: {k: 'base', args: ([actor], ids) => [ids.ref(actor)]},
  farMove: {k: 'farMove', args: ([position, test = 0, noCheck = 0]) => [vec(position), test, noCheck]},
  mayFall: {k: 'event', args: () => ['MayFall']},
  fallingEvent: {k: 'event', args: () => ['Falling']},
  fellOutOfWorld: {k: 'event', args: () => ['FellOutOfWorld']},
  // physRolling's services (the script HitWall and Falling events are ProcessEvent calls in the original).
  eventHitWall: {k: 'event', args: ([normal, wall], ids) => ['HitWall', vec(normal), ids.ref(wall)]},
  eventFalling: {k: 'event', args: () => ['Falling']},
  setBase: {k: 'base', args: ([actor], ids) => [ids.ref(actor)]},
  // physFalling's air-control probe: the pawn's own line check (flags 6, the pawn's extent) reduced to whether it was blocked.
  airControlBlocked: {k: 'line', args: ([delta], ids, pawn) => [vec(pawn.position), pawn.position.map((v, i) => f(v + delta[i])), [f(pawn.radius), f(pawn.radius), f(pawn.height)], 6, 0],
    res: blocked => ({time: blocked ? f(.5) : 1, normal: [0, 0, 0], actor: blocked ? 'world' : null, location: null, outside: null})},
  findSpot: {k: 'findSpot', args: ([position, extent, checkActors, checkFirst]) => [vec(position), vec(extent), checkActors, checkFirst], res: fitted => (fitted ? vec(fitted) : null)},
  landedEvent: {k: 'event', args: ([normal]) => ['Landed', vec(normal)]},
  walkTexture: {k: 'walkTexture', args: ([texture, location, normal]) => [texture != null, vec(location), vec(normal)]},
};

/** The kind a nested body has in its caller's events when it is not its own name. */
const EVENT_KIND = {hitWall: 'wall'};

/** The nested native bodies a body calls: its arguments, as the oracle's stub at the body's address reads them. */
const NESTED_ARGS = {
  hitWall: ([hit], ids) => [vec(hit.normal), ids.ref(hit.actor)],
  rolling: ([dt]) => [f(dt), 0],
  prelude: ([dt, iterations]) => [f(dt), iterations],
  flying: ([dt, iterations]) => [f(dt), iterations],
  falling: ([dt, iterations]) => [f(dt), iterations],
  walking: ([dt, iterations]) => [f(dt), iterations],
  landed: ([hit, remaining, iterations], ids) => [vec(hit.normal), ids.ref(hit.actor), f(remaining), iterations],
};

/** The base adapter: wraps the pawn's services named in `services` (keys of SERVICES) while the body runs. */
function adapter(body, {config, services, holder = pawn => pawn}) {
  return {
    before(pawn, args, rec, recorder) {
      const ids = recorder.context.ids;
      return {args: NESTED_ARGS[body](args, ids), config: config(pawn, args, ids), state: trackedState(pawn, ids), kind: pawn.self ? 'pawn' : 'host'};
    },
    wrap(pawn, rec, recorder) {
      const saved = {}, ids = recorder.context.ids, object = holder(pawn, rec);
      for (const name of services) {
        if (typeof object[name] !== 'function') continue;
        const spec = SERVICES[name];
        saved[name] = object[name];
        object[name] = o3Service(rec, recorder, saved[name], {
          pre: () => trackedState(pawn, ids),
          log: (args, result, pre) => rec.events.push({k: spec.k, args: spec.args(args, ids, pawn), res: spec.res ? spec.res(result, ids) : null, pre, post: trackedState(pawn, ids)}),
        });
      }
      return () => { for (const name of Object.keys(saved)) object[name] = saved[name]; };
    },
    after: (pawn, rec, result, recorder) => trackedState(pawn, recorder.context.ids),
    /** A nested recorded body is one event of its caller; its state and result are filled in when it has run. */
    nested(parent, child, recorder) {
      child.event = {k: EVENT_KIND[child.name] ?? child.name, args: child.before.args, res: null, pre: trackedState(parent.target, recorder.context.ids), post: null};
      parent.events.push(child.event);
    },
    nestedDone(parent, child, recorder) {
      child.event.post = trackedState(parent.target, recorder.context.ids);
      child.event.res = typeof child.result === 'boolean' ? child.result : null;
    },
  };
}

const zoneConfig = pawn => ({gravity: vec(pawn.gravity), zoneVelocity: vec(pawn.zoneVelocity), zoneNumber: pawn.zoneNumber, netMode: pawn.netMode});
const bodyConfig = pawn => ({isPlayerPawn: Boolean(pawn.isPlayerPawn), isPlayer: Boolean(pawn.isPlayer), radius: pawn.radius, height: pawn.height, mass: pawn.mass,
  maxStepHeight: pawn.maxStepHeight, groundSpeed: pawn.groundSpeed, airSpeed: pawn.airSpeed, accelRate: pawn.accelRate, desiredSpeed: pawn.desiredSpeed});

/** `textureForHit(hit)` follows the line check that produced `hit`: it joins that query's answer (the texture the original reads through the hit's BSP surface). */
function textureWrapper(rec, recorder, pawn, saved) {
  saved.textureForHit = pawn.textureForHit;
  pawn.textureForHit = function (hit) {
    const texture = saved.textureForHit.call(this, hit);
    if (recorder.top() === rec) {
      const last = rec.events.at(-1);
      if (last?.k !== 'line') throw new Error('O3: textureForHit without the line check that produced its hit');
      last.res.texture = texture ? {outerName: texture.outerName ?? null, friction: texture.friction} : null;
    }
    return texture;
  };
}

/** physFalling for a non-Pawn host (a decoration): the zone and body constants its integration reads. */
function hostFallingConfig(host, dt, iterations, options) {
  if (!options?.nonPawn) throw new Error('O3: a host falling without the nonPawn option');
  if (host.bBounce) throw new Error('O3: a bouncing host (the script HitWall dispatch) is not modelled');
  if (!('landingCounter' in host)) throw new Error('O3: only decoration hosts are modelled (no fragment, projectile or inventory)');
  return {dt: f(dt), iterations, nonPawn: true, ancestry: 'decoration', ...zoneConfig(host), terminalVelocity: host.terminalVelocity, regionWater: Boolean(host.regionWater),
    fluidFriction: host.fluidFriction, mass: host.mass, buoyancy: host.buoyancy ?? 0, bobbing: Boolean(host.bobbing), radius: host.radius, height: host.height,
    zoneNumber: host.zoneNumber, netMode: 0};
}

/** processHitWall (walking-callbacks.mjs processPlayerHitWall / processDecorationHitWall): the pawn's gate fields, whether the state probes HitWall, and the script event. */
const wallState = (target, ids) => (target.self
  ? {position: vec(target.position), acceleration: vec(target.acceleration), destination: vec(target.destination), physics: Number(target.physics), moveTimer: target.moveTimer,
    pawnFlags: target.pawnFlags >>> 0}
  : {});
const hitWallAdapter = {
  before(target, [hit, options], rec, recorder) {
    const ids = recorder.context.ids;
    return {args: NESTED_ARGS.hitWall([hit], ids), kind: target.self ? 'pawn' : 'host', state: wallState(target, ids),
      config: {variant: target.self ? 'player' : 'decoration', minHitWall: target.self ? target.minHitWall : null, wallIsPawn: Boolean(hit.actor?.isPawn), netMode: 0}};
  },
  wrap(target, rec, recorder) {
    const [hit, options] = rec.args, ids = recorder.context.ids, isProbing = options.isProbing, dispatch = options.dispatch;
    options.isProbing = o3Service(rec, recorder, isProbing, {pre: () => wallState(target, ids),
      log: (args, result, pre) => rec.events.push({k: 'probe', args: [args[1]], res: Boolean(result), pre, post: wallState(target, ids)})});
    options.dispatch = o3Service(rec, recorder, dispatch, {pre: () => wallState(target, ids),
      log: ([to, event, args], result, pre) => rec.events.push({k: 'event', args: [event, vec(args[0]), ids.ref(args[1])], res: null, pre, post: wallState(target, ids)})});
    return () => { options.isProbing = isProbing; options.dispatch = dispatch; };
  },
  after: (target, rec, result, recorder) => wallState(target, recorder.context.ids),
  nested: () => { throw new Error('O3: processHitWall calls no nested body'); },
};

/** MoveActor's query prefix (move-query.mjs): the source's traits and the hits Play's MultiLineCheck returned; the native filters them, selects and does the math. */
function moveQueryCandidate(c, source, world, ids) {
  const actor = c.actor, identity = identityOf(actor);
  const kind = actor === world ? 'world' : identity === identityOf(source) ? 'self' : actor.movingBrush ? 'mover' : actor.controlledPlayer ? 'player' : actor.projectile ? 'projectile' : 'actor';
  let basedOnSource = false;
  if (kind !== 'world' && kind !== 'self') {
    const base = identityOf(actor.base);
    if (base) {
      if (base !== identityOf(source) && identityOf(base.base)) throw new Error('O3: a candidate based on the source through a chain longer than one link is not modelled');
      basedOnSource = base === identityOf(source);
    }
  }
  return {id: kind === 'world' ? 'world' : ids.ref(identity), kind, flags: actor.flags ?? 0, time: f(c.time), location: vec(c.location ?? [0, 0, 0]), normal: vec(c.normal ?? [0, 0, 0]),
    item: c.item ?? 0, basedOnSource};
}
const moveQueryAdapter = {
  standalone: true,
  before(source, [query], rec, recorder) {
    return {args: vec(query.delta).map(f), kind: 'move', state: {start: vec(query.start).map(f)}, config: {extent: [f(query.extent[0]), f(query.extent[2])],
      sourceFlags: source.flags ?? 0, controlledPlayer: Boolean(source.controlledPlayer), projectile: Boolean(source.projectile), static: Boolean(source.static),
      movable: source.movable !== false, ignorePawns: Boolean(query.ignorePawns), ignoreBases: Boolean(query.ignoreBases), hits: []}};
  },
  wrap(source, rec, recorder) {
    const [query] = rec.args, ids = recorder.context.ids, original = query.multiLineCheck;
    query.multiLineCheck = function (q) {
      const hits = original.call(this, q);
      rec.before.config.hits = hits.map(c => moveQueryCandidate(c, source, query.worldActor, ids));
      rec.events.push({k: 'multiLine', args: [vec(q.end), vec(q.start), vec(q.extent), Boolean(q.checkActors), Boolean(q.worldActor), q.extra ?? 0], res: null, pre: null, post: null});
      return hits;
    };
    return () => { query.multiLineCheck = original; };
  },
  after(source, rec, result, recorder) {
    const ids = recorder.context.ids, hit = result.hit;
    return {success: Boolean(result.success), delta: vec(result.delta), position: vec(result.position), time: result.time,
      selected: hit ? (hit.item ?? 0) : null, hitActor: hit ? (hit.actor === rec.args[0].worldActor ? 'world' : ids.ref(identityOf(hit.actor))) : null};
  },
  nested: () => { throw new Error('O3: moveQuery calls no nested body'); },
};

export const ADAPTERS = {
  moveQuery: moveQueryAdapter,
  hitWall: hitWallAdapter,
  flying: adapter('flying', {
    services: ['move'],
    config: (pawn, [dt, iterations]) => ({dt: f(dt), iterations, ...bodyConfig(pawn), ...zoneConfig(pawn), fluidFriction: pawn.fluidFriction, collideWorld: Boolean(pawn.collideWorld)}),
  }),
  prelude: (() => {
    const base = adapter('prelude', {
      services: ['lineCheck', 'walkTexture'],
      config: (pawn, [dt, iterations]) => ({dt: f(dt), iterations, ...bodyConfig(pawn), rotation: vec(pawn.rotation), viewRotation: vec(pawn.viewRotation), netMode: pawn.netMode}),
    });
    return {...base, wrap(pawn, rec, recorder) {
      const restore = base.wrap(pawn, rec, recorder), saved = {};
      textureWrapper(rec, recorder, pawn, saved);
      return () => { pawn.textureForHit = saved.textureForHit; restore(); };
    }};
  })(),
  falling: adapter('falling', {
    services: ['move', 'airControlBlocked', 'fellOutOfWorld'],
    config: (pawn, [dt, iterations, options]) => pawn.self
      ? {dt: f(dt), iterations, ...bodyConfig(pawn), ...zoneConfig(pawn), airControl: pawn.airControl, terminalVelocity: pawn.terminalVelocity,
        regionWater: Boolean(pawn.regionWater), footWater: Boolean(pawn.footWater), fluidFriction: pawn.fluidFriction, buoyancy: pawn.buoyancy ?? 0,
        footFluidFriction: pawn.footWater ? pawn.footFluidFriction : 1.2, nonPawn: false}
      : hostFallingConfig(pawn, dt, iterations, options),
  }),
  landed: adapter('landed', {
    services: ['lineCheck', 'findSpot', 'farMove', 'landedEvent', 'setPhysics'],
    config: (pawn, [hit, remaining, iterations, zone]) => pawn.self
      ? {remaining: f(remaining), iterations, ...bodyConfig(pawn), ...zoneConfig(pawn)}
      : {remaining: f(remaining), iterations, ancestry: 'landingCounter' in pawn ? 'decoration' : 'inventory', radius: pawn.radius, height: pawn.height,
        isCarcass: Boolean(pawn.isCarcass), slidingCarcass: Boolean(pawn.slidingCarcass), zone: {bBounceVelocity: Boolean(zone.bBounceVelocity), velocity: vec(zone.ZoneVelocity)}, netMode: 0},
  }),
  rolling: adapter('rolling', {
    // The services are the members of the object physRolling is handed (its second argument).
    holder: (host, rec) => rec.args[1],
    services: ['move', 'eventHitWall', 'eventFalling', 'setPhysics', 'setBase'],
    config: (host, [dt, services]) => {
      if (host.bBounce) throw new Error('O3: a bouncing host (the script HitWall dispatch) is not modelled');
      const zone = services.zone;
      return {dt: f(dt), iterations: 0, ancestry: 'decoration', zone: {gravity: vec(zone.ZoneGravity ?? [0, 0, -950]), velocity: vec(zone.ZoneVelocity ?? [0, 0, 0]),
        groundFriction: f(zone.ZoneGroundFriction ?? 8), fluidFriction: f(zone.ZoneFluidFriction ?? .02)}, netMode: 0};
    },
  }),
  walking: adapter('walking', {
    services: ['move', 'lineCheck', 'setPhysics', 'setSupportBase', 'farMove', 'mayFall', 'fallingEvent', 'fellOutOfWorld'],
    config: (pawn, [dt, iterations]) => ({dt: f(dt), iterations, ...bodyConfig(pawn), ...zoneConfig(pawn), friction: pawn.friction}),
  }),
};

/** A resolved case: what the oracle reads (`config`, `before`, the events with the nested bodies filled in) and what Play left (`after`). */
export function resolveCase(rec, ids) {
  return {body: rec.name, index: rec.index, depth: rec.depth, args: rec.before.args, config: rec.before.config, kind: rec.before.kind, before: {state: rec.before.state}, events: rec.events, actors: Object.fromEntries(ids.info.map((info, id) => [id, info]).filter(([id, info]) => id > 0 && info)), after: rec.after, result: typeof rec.result === 'boolean' ? rec.result : null, error: rec.error};
}
