import { brushCollisionBounds, primitiveCollisionBounds } from './brush-bounds.mjs';
import { createCollisionHash } from './collision-hash.mjs';
import { brushToWorld } from './coords.mjs';
import { singleLineCheck } from './line-filter.mjs';
import { multiLineCheck } from './multiline.mjs';
import { primitiveLineHit } from './primitive-collision.mjs';
import { traceRay, traceRayFast } from './ray.mjs';
import { createLevelPoints } from './level-points.mjs';
import { actorEncroachmentCheck } from './encroachment-query.mjs';
import { traceExtent } from './extent-trace.mjs';
import { TRACE_DIFFERENTIAL } from './trace-kernel.mjs';
import { kernelHashStore, createKernelLineChecks, createDifferentialHash, checkLineKernel, HASH_DIFFERENTIAL } from './collision-kernel.mjs';

// ABrush.ToWorld of a mover's current values, reused while every input it
// reads (the effective Location, Rotation, PrePivot and Post/MainScale after
// their defaults) is unchanged. brushToWorld is a pure function of them.
const toWorldCache = new WeakMap();
const scaleInputs = (value, out) => {
  const scale = value?.scale ?? [1, 1, 1];
  out.push(scale[0], scale[1], scale[2], value?.shearAxis ?? 0, value?.shearRate ?? 0);
};
function brushToWorldCached(values) {
  const location = values.Location ?? [0, 0, 0], rotation = values.Rotation ?? [0, 0, 0];
  const prePivot = values.PrePivot ?? [0, 0, 0];
  const inputs = [location[0], location[1], location[2], rotation[0], rotation[1], rotation[2],
    prePivot[0], prePivot[1], prePivot[2]];
  scaleInputs(values.PostScale, inputs); scaleInputs(values.MainScale, inputs);
  const cached = toWorldCache.get(values);
  if (cached && cached.inputs.every((v, i) => v === inputs[i])) return cached.coords;
  const coords = brushToWorld(values);
  toWorldCache.set(values, { inputs, coords });
  return coords;
}
// The world stand-in the queries default to gets accessor members later (the
// actor field installers define them per runtime). An object literal's map
// belongs to the literal's allocation site, which lives as long as this
// module, and V8 keeps the descriptor arrays of its transition tree, accessor
// closures included, so the first runtimes' closures (and with them whole
// runtimes) stayed reachable after their map was left. A dictionary-mode
// object keeps its members, accessors included, in the object itself.
const standalone = members => Object.assign(Object.create(null), members);
const lineageKeys = new Map();
const lineageKey = kind => {
  let key = lineageKeys.get(kind);
  if (key === undefined) lineageKeys.set(kind, key = `engine.${kind.toLowerCase()}`);
  return key;
};

/** Compose the original registration, hash, primitive, joining and filter
 * routines. Actors must arrive in Level.Actors order with original ancestry.
 * Point/extent queries remain explicit dependencies until their full evidence
 * is connected. See docs/fitting.md and docs/collision-hash.md.
 *
 * Once the trace kernel is loaded, the hash's buckets are in Rust and
 * lineCheck/multiLineCheck run there (collision-kernel.mjs, docs/rust-core.md
 * R3-b); the JavaScript below stays the reference, the path before loading,
 * with `kernel: false`, and the answer to every query the kernel hands back.
 */
export function createLevelQueries(model, actors, { pointCheck, extentCheck,
  levelInfo = standalone({ id: '$world', name: '$world', lineage: ['engine.levelinfo', 'engine.zoneinfo', 'engine.actor'] }),
  kernel = true } = {}) {
  const store = kernel ? kernelHashStore() : null;
  const hash = !store ? createCollisionHash() : HASH_DIFFERENTIAL
    ? createDifferentialHash(createCollisionHash({ store }), createCollisionHash()) : createCollisionHash({ store });
  const valuesOf = actor => actor.collisionValues ?? actor.values;
  const isA = (actor, kind) => actor.lineage.includes(lineageKey(kind));
  const bounds = actor => actor.model ? brushCollisionBounds(actor.model, valuesOf(actor)) : primitiveCollisionBounds(null, valuesOf(actor));
  const hashOptions = actor => ({ location: valuesOf(actor).Location, actorFlags: actor.actorFlags ?? 0 });
  const addActor = actor => hash.addActor(actor, bounds(actor), hashOptions(actor));
  const removeActor = actor => hash.removeActor(actor, bounds(actor), hashOptions(actor));
  for (const actor of actors) addActor(actor);
  // Level->Model for the world checks: the moving brush tracker's model while
  // it lives (sim-host.mjs gives the level model `trackedCollision`,
  // bsp-occlusion.mjs collisionModel; docs/brush-tracker.md "Collision"),
  // else the static BSP. ULevel::MultiLineCheck and MultiPointCheck call
  // Level->Model's LineCheck and PointCheck, and once NF_IsNew clears the
  // tracker's fragments are ordinary nodes of it.
  const worldModel = () => model.trackedCollision?.() ?? model;
  const points = createLevelPoints(model, hash, levelInfo, worldModel);
  const modelLineCheck = (source, start, end, extent, extra, owner = null) => {
    const coords = owner && brushToWorldCached(owner);
    if (extent[0] === 0 && extent[1] === 0 && extent[2] === 0 && extent.length === 3 || extent.every(v => v === 0)) {
      const hit = traceRay(source, start, end, extra, coords);
      // Original ray traversal stores UModel in Primitive and the selected BSP
      // node in Item (Engine 0x103f3a89/0x103f3a8c), used by walking textures.
      return hit && { ...hit, primitive: source, item: hit.node };
    }
    if (!extentCheck) throw new Error('Original extent query dependency is unavailable');
    return extentCheck(source, start, end, extent, coords);
  };
  const join = {
    hashPresent: true, isMover: actor => isA(actor, 'Mover'),
    worldLineCheck: (end, start, extent, extra) => modelLineCheck(worldModel(), start, end, extent, extra),
    actorLineCheck: (end, start, extent, extra) => hash.actorLineCheck({ start, end, extent, extraNodeFlags: extra }, (actor, query) => {
      const values = valuesOf(actor);
      if (actor.model) {
        const hit = modelLineCheck(actor.model, query.start, query.end, query.extent, query.extraNodeFlags, values);
        return hit ? { ...hit, actor } : null;
      }
      // primitiveLineCheck's result, fresh per call; null where it is outside.
      const hit = primitiveLineHit(values.Location, values.CollisionRadius ?? 0, values.CollisionHeight ?? 0,
        query.start, query.end, query.extent);
      if (hit) hit.actor = actor;
      return hit;
    }),
  };
  const filter = { isA, levelInfo, multiLineCheck: (...args) => multiLineCheck(join, ...args) };
  // The kernel's line checks need its extent trace: traceExtent's kernel entry.
  const fast = store && extentCheck === traceExtent
    ? createKernelLineChecks({ store, model, worldModel, levelInfo, valuesOf, isA, brushToWorld: brushToWorldCached }) : null;
  const checked = HASH_DIFFERENTIAL || TRACE_DIFFERENTIAL;
  const javascriptMulti = ({ end, start, extent, checkActors, worldActor, extra = 0 }) =>
    multiLineCheck(join, end, start, extent, checkActors, worldActor, extra);
  const javascriptLine = (start, end, extent, flags, extra, source) => {
    const hit = { time: 1, actor: null, location: [0,0,0], normal: [0,0,0] };
    const outside = Boolean(singleLineCheck(filter, hit, source, end, start, flags, extent, extra));
    return { ...hit, outside };
  };
  // SingleLineCheck with another model standing for Level->Model: the one the
  // moving brush tracker filled (bsp-occlusion.mjs lineModel, docs/brush-tracker.md
  // "Collision"). Only the world check changes; the hash and the actors'
  // primitives are the level's. Zero extent only (the tracked model's ray is
  // the translated UModel::LineCheck's zero-extent branch).
  const modelLine = (worldModel, start, end, extent, flags, extra, source) => {
    const through = { ...join, worldLineCheck: (to, from, size, nodeFlags) => {
      if (!size.every(v => v === 0)) throw new Error('A tracked-model line check takes a zero extent');
      const found = traceRayFast(worldModel, from, to, nodeFlags, null);
      return found && { ...found, primitive: worldModel, item: found.node };
    } };
    const hit = { time: 1, actor: null, location: [0,0,0], normal: [0,0,0] };
    const outside = Boolean(singleLineCheck({ ...filter, multiLineCheck: (...args) => multiLineCheck(through, ...args) },
      hit, source, end, start, flags, extent, extra));
    return { ...hit, outside };
  };
  return {
    levelInfo, hash, addActor, removeActor, ...points,
    /** The model the world checks trace now (above): a world hit's Item is a
     * node of it, and its `surfaces` (with the tracker's) hold that node's
     * iSurf. */
    worldModel,
    actorEncroachmentCheck(actor, position, rotation, extra = 0) {
      return actorEncroachmentCheck(hash,actor,position,rotation,extra);
    },
    multiLineCheck(query) {
      if (fast) {
        const hits = fast.multiLineCheck(query);
        if (hits !== undefined) {
          if (checked) checkLineKernel('multiLineCheck', hits, () => javascriptMulti(query),
            { end: query.end, start: query.start, extent: query.extent, checkActors: query.checkActors, world: Boolean(query.worldActor), extra: query.extra });
          return hits;
        }
      }
      return javascriptMulti(query);
    },
    /** `worldModel`: another Level->Model for the world check (modelLine). */
    lineCheck(start, end, extent = [0,0,0], flags = 0x17, extra = 0, source = null, worldModel = null) {
      if (worldModel) return modelLine(worldModel, start, end, extent, flags, extra, source);
      if (fast) {
        const result = fast.lineCheck(start, end, extent, flags, extra, source);
        if (result !== undefined) {
          if (checked) checkLineKernel('lineCheck', result, () => javascriptLine(start, end, extent, flags, extra, source),
            { start, end, extent, flags, extra, source: source?.name ?? source?.id ?? null });
          return result;
        }
      }
      return javascriptLine(start, end, extent, flags, extra, source);
    },
    /** walking-surface.mjs's scan in one kernel call (collision-kernel.mjs
     * surfaceScan), or undefined for the JavaScript scan. */
    surfaceScan(start, ends, position, floorEnd, source, textureModel, textures, worldActor) {
      return fast ? fast.surfaceScan(start, ends, position, floorEnd, source, textureModel, textures, worldActor) : undefined;
    },
    pointCheck(position, extent, flags, checkActors) {
      return pointCheck ? pointCheck(position, extent, flags, checkActors)
        : Number(points.singlePointCheck(position, extent, flags, levelInfo, checkActors).outside);
    },
    // Original RemoveActor requires the still-registered transform. Callers
    // perform their evidenced state change between removal and re-insertion.
    changeActor(actor, change) {
      removeActor(actor);
      change(); addActor(actor);
    },
  };
}
