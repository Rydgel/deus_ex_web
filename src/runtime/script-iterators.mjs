/**
 * Controller for the original Engine native 304 (AllActors).
 *
 * This module owns argument evaluation and actor-array enumeration only. The
 * bytecode VM owns the iterator body's execution and calls next() at each
 * IteratorNext boundary.
 */
import { fastLineCheck } from './fast-line-check.mjs';

const isReference = value => Boolean(value?.reference && typeof value.set === 'function');
export const refValue = value => value?.reference ? value.get() : value;
/** The original exec bodies resolve each out expression to a raw address;
 * non-assignable expressions fall back to a private temporary whose writes
 * never escape. A bare sink reproduces that. */
export const writeSlot = value => isReference(value) ? value : {set() {}};

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
export function createTraceActorsIterator(call) {
  return traceActorsIterator(call, 'TraceActors', 0);
}

/** Original execTraceVisibleActors 0x1036ec50 (Deus Ex native index 1003,
 * thunk 0x10302847). Instruction-for-instruction the execTraceActors body
 * except the MultiLineCheck's last argument: `push 4` (1036edfe) where 309
 * pushes its zero register — ExtraNodeFlags = NF_NotVisBlocking, so the world
 * and mover BSP traces pass through invisible collision hulls. There is no
 * per-hit test: bHidden actors are published like any other hit.
 * Evidence: docs/script-trace.md. */
export function createTraceVisibleActorsIterator(call) {
  return traceActorsIterator(call, 'TraceVisibleActors', 4);
}

function traceActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  levelFor,
  readActor = (actor,name) => name==='Location'?actor.position:actor.worldActor,
}, name, extra) {
  if (typeof evaluateArgument !== 'function') throw new TypeError(`${name} requires evaluateArgument`);
  if (typeof levelFor !== 'function') throw new TypeError(`${name} requires levelFor`);
  // The exec's OPTX macros make Start/Extent optional: valid calls carry
  // five to seven argument expressions.
  if (argumentCount < 5 || argumentCount > 7) throw new RangeError(`${name} takes five to seven arguments; got ${String(argumentCount)}`);

  evaluateArgument(0);
  const outActor = writeSlot(evaluateArgument(1));
  const outLocation = writeSlot(evaluateArgument(2));
  const outNormal = writeSlot(evaluateArgument(3));
  const end = refValue(evaluateArgument(4));
  const startDefault = readActor(receiver,'Location');
  const start = (argumentCount > 5 ? refValue(evaluateArgument(5)) : undefined) ?? startDefault;
  const extent = (argumentCount > 6 ? refValue(evaluateArgument(6)) : undefined) ?? [0, 0, 0];

  const level = levelFor(receiver);
  const queries = level?.hash;
  const worldActor = readActor(receiver,'Level');
  if (typeof queries?.multiLineCheck !== 'function')
    throw new TypeError(`${name} requires the live level MultiLineCheck service`);
  if (worldActor === undefined)
    throw new TypeError(`${name} requires the receiver level-info field`);
  const hits = queries.multiLineCheck({
    end: end.map(Math.fround), start: start.map(Math.fround), extent: extent.map(Math.fround),
    checkActors: 1, worldActor, extra,
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
  readActor = (actor,name) => name==='Location'?actor.position:actor.worldActor,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('TraceTexture requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('TraceTexture requires levelFor');
  // The exec's OPTX macros make Start/Extent optional: valid calls carry
  // eight to ten argument expressions.
  if (argumentCount < 8 || argumentCount > 10) throw new RangeError(`TraceTexture takes eight to ten arguments; got ${String(argumentCount)}`);

  evaluateArgument(0);
  const outActor = writeSlot(evaluateArgument(1));
  const outName = writeSlot(evaluateArgument(2));
  const outGroup = writeSlot(evaluateArgument(3));
  const outFlags = writeSlot(evaluateArgument(4));
  const outLocation = writeSlot(evaluateArgument(5));
  const outNormal = writeSlot(evaluateArgument(6));
  const end = refValue(evaluateArgument(7));
  const startDefault = readActor(receiver,'Location');
  const start = (argumentCount > 8 ? refValue(evaluateArgument(8)) : undefined) ?? startDefault;
  const extent = (argumentCount > 9 ? refValue(evaluateArgument(9)) : undefined) ?? [0, 0, 0];

  const level = levelFor(receiver);
  const queries = level?.hash;
  const worldActor = readActor(receiver,'Level');
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
  // Loc is optional: valid calls carry three or four argument expressions.
  if (argumentCount < 3 || argumentCount > 4) throw new RangeError(`RadiusActors takes three or four arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const radius = f32(refValue(evaluateArgument(2)) ?? 0);
  const locationDefault = receiver.position.map(f32);
  const loc = ((argumentCount > 3 ? refValue(evaluateArgument(3)) : undefined) ?? locationDefault).map(f32);
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
 * actor flag +0x28 bit 0x02 (bHidden, `test byte ptr [edi+0x28], 2` at
 * 0x103e5394; `actorWord(actor)` is that whole dword from the candidate's
 * object image, actor-flag-words.mjs actorWordOf, since a host `actorFlags`
 * carries only four other bits) or a failed Class ancestry walk; the distance
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
  actorWord,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('VisibleActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('VisibleActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('VisibleActors requires isA');
  if (typeof actorWord !== 'function') throw new TypeError('VisibleActors requires actorWord');
  // Radius/Loc are optional: valid calls carry two to four argument
  // expressions (the exec pre-stores a zero Radius before the Loc default).
  if (argumentCount < 2 || argumentCount > 4) throw new RangeError(`VisibleActors takes two to four arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const radius = f32(argumentCount > 2 ? refValue(evaluateArgument(2)) ?? 0 : 0);
  const locationDefault = receiver.position.map(f32);
  const loc = ((argumentCount > 3 ? refValue(evaluateArgument(3)) : undefined) ?? locationDefault).map(f32);
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
        if (actorWord(actor) & 2) continue;
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

/** Original execCycleActors 0x1036e9d0 (native index 1002). The exec
 * evaluates BaseClass, the out Actor and out int Index expressions once —
 * a null BaseClass defaults to class'Actor' (0x1057cdf0) — then reads
 * *Index once into a private cursor clamped to [0, Actors.Num()). Each
 * resume clears the Actor out, re-clamps the saved step bound to
 * min(bound, Actors.Num()) and scans the Level->Actors array forward from
 * the cursor, wrapping it to 0 whenever it reaches Num. A candidate yields
 * when its Class ancestry reaches BaseClass: *Actor publishes it and
 * *Index receives the position after it. The step counter survives between
 * resumes, so one foreach pass can wrap through the array at most once;
 * exhaustion still writes *Index (the wrapped cursor) with Actor=None.
 * Evidence: Engine.dll execCycleActors at 0x1036e9d0 (thunk 0x1030400c). */
export function createCycleActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  actorClass,
  levelFor,
  isA,
  scan = null,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('CycleActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('CycleActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('CycleActors requires isA');
  if (argumentCount !== 3) throw new RangeError(`CycleActors takes three arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const indexArgument = evaluateArgument(2);
  const outIndex = writeSlot(indexArgument);
  const baseClass = baseValue === null || baseValue === undefined ? actorClass : baseValue;

  const actors = () => {
    const array = levelFor(receiver)?.actors;
    if (!array || typeof array.length !== 'number')
      throw new TypeError('CycleActors levelFor(receiver) must provide an actors array');
    return array;
  };
  const startIndex = refValue(indexArgument) | 0;
  let bound = actors().length;
  let cursor = startIndex >= 0 && startIndex < bound ? startIndex : 0;
  let steps = 0;

  // `scan(array, cursor, steps, bound, baseClass)`, when given, runs the
  // loop below in the Rust core (script-vm-render.mjs cycleScan): the same
  // cursor, steps and first match, or an actor it leaves to `isA`.
  // CYCLE_SCAN=js keeps this loop; CYCLE_SCAN=verify runs both.
  const mode = cycleScanMode();
  if (mode === 'js') scan = null;
  const loop = (array, state) => {
    while (state.steps < bound) {
      if (state.cursor >= array.length) state.cursor = 0;
      const actor = array[state.cursor++]; state.steps++;
      if (actor === null || actor === undefined) continue;
      if (!isA(actor, baseClass)) continue;
      return actor;
    }
    return null;
  };
  return {
    next() {
      outActor.set(null);
      const array = actors();
      if (array.length < bound) bound = array.length;
      let found = null;
      if (scan) {
        const check = mode === 'verify' ? {cursor, steps} : null;
        for (;;) {
          const result = scan(array, cursor, steps, bound, baseClass);
          cursor = result.cursor; steps = result.steps;
          if (result.kind === 0) break;
          if (result.kind === 1 || isA(array[cursor - 1], baseClass)) { found = array[cursor - 1]; break; }
        }
        if (check) {
          const expected = loop(array, check);
          if (expected !== found || check.cursor !== cursor || check.steps !== steps)
            throw new Error(`CYCLE_SCAN=verify: Rust ${found?.name}@${cursor}/${steps}, JavaScript ${expected?.name}@${check.cursor}/${check.steps}`);
        }
      } else {
        const state = {cursor, steps};
        found = loop(array, state);
        cursor = state.cursor; steps = state.steps;
      }
      if (found) { outActor.set(found); outIndex.set(cursor); return true; }
      outIndex.set(cursor);
      return false;
    },
  };
}
const cycleScanMode = () => (typeof process !== 'undefined' && process.env?.CYCLE_SCAN) || globalThis.DEUS_EX_CYCLE_SCAN || 'rust';

/** Original execBasedActors 0x103e4800 (native index 306). The exec evaluates
 * BaseClass and the out Actor expression, defaults a null BaseClass to
 * class'Actor' (0x1057cdf0), clears the out slot and resumes the
 * Level->Actors (+0x2c/+0x30) scan from a saved index. A candidate yields
 * when its Class ancestry reaches BaseClass and candidate->+0xc4 (Base) is
 * the receiver — no other exclusion or distance test. Evidence:
 * docs/script-actor-queries.md. */
export function createBasedActorsIterator({
  receiver,
  argumentCount,
  evaluateArgument,
  actorClass,
  levelFor,
  isA,
  baseOf,
}) {
  if (typeof evaluateArgument !== 'function') throw new TypeError('BasedActors requires evaluateArgument');
  if (typeof levelFor !== 'function') throw new TypeError('BasedActors requires levelFor');
  if (typeof isA !== 'function') throw new TypeError('BasedActors requires isA');
  if (typeof baseOf !== 'function') throw new TypeError('BasedActors requires baseOf');
  if (argumentCount !== 2) throw new RangeError(`BasedActors takes two arguments; got ${String(argumentCount)}`);

  const baseValue = refValue(evaluateArgument(0));
  const outActor = writeSlot(evaluateArgument(1));
  const baseClass = baseValue === null || baseValue === undefined ? actorClass : baseValue;

  let index = 0;
  return {
    next() {
      outActor.set(null);
      const level = levelFor(receiver), actors = level?.actors;
      if (!actors || typeof actors.length !== 'number')
        throw new TypeError('BasedActors levelFor(receiver) must provide an actors array');
      while (index < actors.length) {
        const actor = actors[index++];
        if (actor === null || actor === undefined) continue;
        if (!isA(actor, baseClass)) continue;
        if (baseOf(actor) !== receiver) continue;
        outActor.set(actor);
        return true;
      }
      return false;
    },
  };
}
