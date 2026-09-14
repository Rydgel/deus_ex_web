/**
 * Controller for the original Engine native 304 (AllActors).
 *
 * This module owns argument evaluation and actor-array enumeration only. The
 * bytecode VM owns the iterator body's execution and calls next() at each
 * IteratorNext boundary.
 */
import { fastLineCheck } from './fast-line-check.mjs';

const isReference = value => Boolean(value?.reference && typeof value.set === 'function');
const refValue = value => value?.reference ? value.get() : value;
/** The original exec bodies resolve each out expression to a raw address;
 * non-assignable expressions fall back to a private temporary whose writes
 * never escape. A bare sink reproduces that. */
const writeSlot = value => isReference(value) ? value : {set() {}};

function nameText(value) {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') {
    if (value.name !== undefined) return String(value.name).toLowerCase();
    if (value.value !== undefined) return String(value.value).toLowerCase();
  }
  return String(value).toLowerCase();
}

function isNoneName(value) {
  return value === 0 || nameText(value) === 'none';
}

/**
 * Create the native 304 controller for one compiled AllActors expression.
 *
 * `evaluateArgument` is called exactly once for each supplied argument, in
 * declaration order. Scalar arguments are dereferenced immediately; the
 * second argument is retained as an out reference when it is assignable.
 * `levelFor(receiver)` is read while scanning so the actor-array bound and
 * storage remain live. `isA` performs the linked class ancestry check and
 * `tagOf` returns an actor's FName-compatible Tag value.
 */
export function createAllActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  actorClass,
  levelFor,
  isA,
  tagOf,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('AllActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('AllActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('AllActors requires isA');
  if (typeof tagOf !== 'function') throw new TypeError('AllActors requires tagOf');

  const count = Number(argumentCount);
  if (count !== 2 && count !== 3) {
    throw new RangeError(`AllActors requires two or three arguments; got ${String(argumentCount)}`);
  }

  // The native evaluates BaseClass, then the out expression, then the
  // optional tag. Keep these operations separate: evaluating an out argument
  // can publish a reference used by the native, while scalar refValue calls
  // must happen immediately at their source position.
  const baseArgument = evaluateArgument(0);
  const baseValue = refValue(baseArgument);
  const outArgument = evaluateArgument(1);
  const outReference = isReference(outArgument) ? outArgument : null;
  let temporaryOut = outReference ? null : refValue(outArgument);
  const tagArgument = count === 3 ? evaluateArgument(2) : undefined;
  const matchTag = count === 3 ? refValue(tagArgument) : 'None';
  const baseClass = baseValue === null || baseValue === undefined ? actorClass : baseValue;

  let index = 0;

  function clearOut() {
    if (outReference) outReference.set(null);
    else temporaryOut = null;
  }

  function publish(actor) {
    if (outReference) outReference.set(actor);
    else temporaryOut = actor;
  }

  return {
    next() {
      clearOut();
      while (true) {
        const level = levelFor(receiver);
        const actors = level?.actors;
        if (!actors || typeof actors.length !== 'number') {
          throw new TypeError('AllActors levelFor(receiver) must provide an actors array');
        }
        if (index >= actors.length) return false;

        const actor = actors[index++];
        if (actor === null || actor === undefined) continue;
        if (!isA(actor, baseClass)) continue;
        if (!isNoneName(matchTag) && nameText(tagOf(actor)) !== nameText(matchTag)) continue;

        publish(actor);
        return true;
      }
    },
  };
}

const isLevelInfo = actor =>
  Array.isArray(actor?.lineage) && actor.lineage.includes('engine.levelinfo');

/** Original execTraceActors 0x103e4bc0 (native index 309). The exec evaluates
 * the seven argument expressions once — BaseClass, the three outs, End and the
 * pre-stored Location/zero-vector optional defaults — then runs one
 * XLevel.MultiLineCheck(GMem, End, Start, Extent, checkActors=1,
 * worldActor=this->+0xa8, extra=0) and publishes every hit in native list
 * order. BaseClass is defaulted to the Actor class when null and never filters
 * the hits; no self/owner exclusion applies (that lives in SingleLineCheck).
 * At natural exhaustion only the Actor out is cleared — HitLocation/HitNormal
 * keep the last published hit. Evidence: docs/script-trace.md. */
export function createTraceActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  levelFor,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('TraceActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('TraceActors requires levelFor');
  if (argumentCount !== 7) throw new RangeError(`TraceActors takes seven arguments; got ${String(argumentCount)}`);

  evaluateArgument(0);
  const outActor = writeSlot(evaluateArgument(1));
  const outLocation = writeSlot(evaluateArgument(2));
  const outNormal = writeSlot(evaluateArgument(3));
  const end = refValue(evaluateArgument(4));
  const startDefault = receiver.position;
  const start = refValue(evaluateArgument(5)) ?? startDefault;
  const extent = refValue(evaluateArgument(6)) ?? [0, 0, 0];

  const level = levelFor(receiver);
  const queries = level?.hash;
  const worldActor = receiver.worldActor;
  if (typeof queries?.multiLineCheck !== 'function')
    throw new TypeError('TraceActors requires the live level MultiLineCheck service');
  if (worldActor === undefined)
    throw new TypeError('TraceActors requires the receiver level-info field');
  const hits = queries.multiLineCheck({
    end: end.map(Math.fround), start: start.map(Math.fround), extent: extent.map(Math.fround),
    checkActors: 1, worldActor, extra: 0,
  });

  let index = 0;
  return {
    next() {
      if (index >= hits.length) { outActor.set(null); return false; }
      const hit = hits[index++];
      outActor.set(hit.actor ?? null);
      outLocation.set([...hit.location]);
      outNormal.set([...hit.normal]);
      return true;
    },
  };
}

/** Original execTraceTexture 0x1036e450 (native index 1000). Same ten-argument
 * eval and MultiLineCheck skeleton as TraceActors; per hit it additionally
 * clears texName/texGroup/flags to zero and, only when the hit actor's class
 * ancestry reaches LevelInfo, resolves hit.Item through
 * Model->Nodes[Item].iSurf -> Model->Surfs[iSurf] to publish the surface
 * material's texture name (+0x20), its Outer's name and the surface
 * PolyFlags. Non-world and null-material hits keep the zeroed outs.
 * Evidence: docs/script-trace.md. */
export function createTraceTextureIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  levelFor,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('TraceTexture requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('TraceTexture requires levelFor');
  if (argumentCount !== 10) throw new RangeError(`TraceTexture takes ten arguments; got ${String(argumentCount)}`);

  evaluateArgument(0);
  const outActor = writeSlot(evaluateArgument(1));
  const outName = writeSlot(evaluateArgument(2));
  const outGroup = writeSlot(evaluateArgument(3));
  const outFlags = writeSlot(evaluateArgument(4));
  const outLocation = writeSlot(evaluateArgument(5));
  const outNormal = writeSlot(evaluateArgument(6));
  const end = refValue(evaluateArgument(7));
  const startDefault = receiver.position;
  const start = refValue(evaluateArgument(8)) ?? startDefault;
  const extent = refValue(evaluateArgument(9)) ?? [0, 0, 0];

  const level = levelFor(receiver);
  const queries = level?.hash;
  const worldActor = receiver.worldActor;
  if (typeof queries?.multiLineCheck !== 'function')
    throw new TypeError('TraceTexture requires the live level MultiLineCheck service');
  if (worldActor === undefined)
    throw new TypeError('TraceTexture requires the receiver level-info field');
  const hits = queries.multiLineCheck({
    end: end.map(Math.fround), start: start.map(Math.fround), extent: extent.map(Math.fround),
    checkActors: 1, worldActor, extra: 0,
  });

  let index = 0;
  return {
    next() {
      if (index >= hits.length) { outActor.set(null); return false; }
      const hit = hits[index++];
      outActor.set(hit.actor ?? null);
      outLocation.set([...hit.location]);
      outNormal.set([...hit.normal]);
      let name = 'None', group = 'None', flags = 0;
      if (isLevelInfo(hit.actor)) {
        const model = level.model, surfaceTexture = level.surfaceTexture;
        if (!Array.isArray(model?.nodes))
          throw new TypeError('TraceTexture world hit requires the level BSP model');
        const node = model.nodes[hit.item];
        if (!node) throw new Error(`TraceTexture hit item is not a valid BSP node: ${String(hit.item)}`);
        const surface = model.surfaces[node.surface];
        if (!surface) throw new Error(`TraceTexture node references an invalid surface: ${String(node.surface)}`);
        flags = surface.flags | 0;
        if (!Array.isArray(surfaceTexture))
          throw new TypeError('TraceTexture requires the level surface texture table');
        const texture = surfaceTexture[node.surface];
        if (texture) {
          name = texture.name;
          if (texture.outerName != null) group = texture.outerName;
        }
      }
      outName.set(name);
      outGroup.set(group);
      outFlags.set(flags);
      return true;
    },
  };
}

const f32 = Math.fround;

/** Original execRadiusActors 0x103e4fa0 (native index 310). The exec
 * evaluates BaseClass, the out Actor expression and Radius, copies
 * this->+0x114 into the Loc buffer, then evaluates the optional Loc; a null
 * BaseClass falls back to the Actor class after evaluation. Each resume
 * clears the out slot and continues scanning Level->Actors (+0x2c/+0x30)
 * from a saved index — no self or owner exclusion. A candidate yields when
 * its Class ancestry reaches BaseClass and
 * (Radius + CollisionRadius)^2 > sum((candidate.Location - Loc)^2) with the
 * strict fcompp predicate (equal or unordered distances excluded).
 * Evidence: docs/script-actor-queries.md. */
export function createRadiusActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  actorClass,
  levelFor,
  isA,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('RadiusActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('RadiusActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('RadiusActors requires isA');
  if (argumentCount !== 4) throw new RangeError(`RadiusActors takes four arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const radius = f32(refValue(evaluateArgument(2)) ?? 0);
  const locationDefault = receiver.position.map(f32);
  const loc = (refValue(evaluateArgument(3)) ?? locationDefault).map(f32);
  const baseClass = baseValue === null || baseValue === undefined ? actorClass : baseValue;

  let index = 0;
  return {
    next() {
      outActor.set(null);
      const level = levelFor(receiver), actors = level?.actors;
      if (!actors || typeof actors.length !== 'number')
        throw new TypeError('RadiusActors levelFor(receiver) must provide an actors array');
      while (index < actors.length) {
        const actor = actors[index++];
        if (actor === null || actor === undefined) continue;
        if (!isA(actor, baseClass)) continue;
        const p = actor.position;
        const dx = f32(p[0]) - loc[0], dy = f32(p[1]) - loc[1], dz = f32(p[2]) - loc[2];
        const sum = radius + f32(actor.radius ?? 0);
        if (!(sum * sum > dx * dx + dy * dy + dz * dz)) continue;
        outActor.set(actor);
        return true;
      }
      return false;
    },
  };
}

/** Original execVisibleActors 0x103e5260 (native index 311). Same argument
 * skeleton as RadiusActors plus a pre-stored zero Radius buffer evaluated
 * before the Loc default copy. Each candidate is skipped on a null slot,
 * actor flag +0x28 bit 0x02 or a failed Class ancestry walk; the distance
 * gate runs only when Radius is ordered-nonzero against the double constant
 * 0.0 (strict Radius^2 > sum(d^2), no CollisionRadius term). Survivors call
 * Level->Model->FastLineCheck(candidate.Location, Loc) and yield on a
 * nonzero AL byte. Evidence: docs/script-actor-queries.md. */
export function createVisibleActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  actorClass,
  levelFor,
  isA,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('VisibleActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('VisibleActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('VisibleActors requires isA');
  if (argumentCount !== 4) throw new RangeError(`VisibleActors takes four arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const radius = f32(refValue(evaluateArgument(2)) ?? 0);
  const locationDefault = receiver.position.map(f32);
  const loc = (refValue(evaluateArgument(3)) ?? locationDefault).map(f32);
  const baseClass = baseValue === null || baseValue === undefined ? actorClass : baseValue;

  let index = 0;
  return {
    next() {
      outActor.set(null);
      const level = levelFor(receiver), actors = level?.actors;
      if (!actors || typeof actors.length !== 'number')
        throw new TypeError('VisibleActors levelFor(receiver) must provide an actors array');
      const model = level?.model, check = level?.fastLineCheck ?? fastLineCheck;
      while (index < actors.length) {
        const actor = actors[index++];
        if (actor === null || actor === undefined) continue;
        if ((actor.actorFlags ?? 0) & 2) continue;
        if (!isA(actor, baseClass)) continue;
        const p = actor.position;
        if (radius < 0 || radius > 0) {
          const dx = f32(p[0]) - loc[0], dy = f32(p[1]) - loc[1], dz = f32(p[2]) - loc[2];
          if (!(radius * radius > dx * dx + dy * dy + dz * dz)) continue;
        }
        if (!model) throw new TypeError('VisibleActors requires the level BSP model');
        if (!(check(model, p.map(f32), loc) & 0xff)) continue;
        outActor.set(actor);
        return true;
      }
      return false;
    },
  };
}
