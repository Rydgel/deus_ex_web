import { brushCollisionBounds, primitiveCollisionBounds } from './brush-bounds.mjs';
import { createCollisionHash } from './collision-hash.mjs';
import { brushToWorld } from './coords.mjs';
import { singleLineCheck } from './line-filter.mjs';
import { multiLineCheck } from './multiline.mjs';
import { primitiveLineCheck } from './primitive-collision.mjs';
import { traceRay } from './ray.mjs';
import { createLevelPoints } from './level-points.mjs';
import { actorEncroachmentCheck } from './encroachment-query.mjs';

/** Compose the original registration, hash, primitive, joining and filter
 * routines. Actors must arrive in Level.Actors order with original ancestry.
 * Point/extent queries remain explicit dependencies until their full evidence
 * is connected. See docs/fitting.md and docs/collision-hash.md.
 */
export function createLevelQueries(model, actors, { pointCheck, extentCheck,
  levelInfo = { id: '$world', name: '$world', lineage: ['engine.levelinfo', 'engine.zoneinfo', 'engine.actor'] } } = {}) {
  const hash = createCollisionHash();
  const valuesOf = actor => actor.collisionValues ?? actor.values;
  const isA = (actor, kind) => actor.lineage.includes(`engine.${kind.toLowerCase()}`);
  const bounds = actor => actor.model ? brushCollisionBounds(actor.model, valuesOf(actor)) : primitiveCollisionBounds(null, valuesOf(actor));
  const hashOptions = actor => ({ location: valuesOf(actor).Location, actorFlags: actor.actorFlags ?? 0 });
  const addActor = actor => hash.addActor(actor, bounds(actor), hashOptions(actor));
  const removeActor = actor => hash.removeActor(actor, bounds(actor), hashOptions(actor));
  for (const actor of actors) addActor(actor);
  const points = createLevelPoints(model, hash, levelInfo);
  const modelLineCheck = (source, start, end, extent, extra, owner = null) => {
    const coords = owner && brushToWorld(owner);
    if (extent.every(v => v === 0)) {
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
    worldLineCheck: (end, start, extent, extra) => modelLineCheck(model, start, end, extent, extra),
    actorLineCheck: (end, start, extent, extra) => hash.actorLineCheck({ start, end, extent, extraNodeFlags: extra }, (actor, query) => {
      let hit;
      const values = valuesOf(actor);
      if (actor.model) hit = modelLineCheck(actor.model, query.start, query.end, query.extent, query.extraNodeFlags, values);
      else {
        const result = primitiveLineCheck({ location: values.Location, radius: values.CollisionRadius ?? 0,
          height: values.CollisionHeight ?? 0 }, query.start, query.end, query.extent);
        if (!result.outside) hit = result;
      }
      return hit ? { ...hit, actor } : null;
    }),
  };
  const filter = { isA, levelInfo, multiLineCheck: (...args) => multiLineCheck(join, ...args) };
  return {
    levelInfo, hash, addActor, removeActor, ...points,
    actorEncroachmentCheck(actor, position, rotation, extra = 0) {
      return actorEncroachmentCheck(hash,actor,position,rotation,extra);
    },
    multiLineCheck({ end, start, extent, checkActors, worldActor, extra = 0 }) {
      return multiLineCheck(join, end, start, extent, checkActors, worldActor, extra);
    },
    lineCheck(start, end, extent = [0,0,0], flags = 0x17, extra = 0, source = null) {
      const hit = { time: 1, actor: null, location: [0,0,0], normal: [0,0,0] };
      const outside = Boolean(singleLineCheck(filter, hit, source, end, start, flags, extent, extra));
      return { ...hit, outside };
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
