/**
 * Controller for the original Engine native 304 (AllActors).
 *
 * This module owns argument evaluation and actor-array enumeration only. The
 * bytecode VM owns the iterator body's execution and calls next() at each
 * IteratorNext boundary.
 */

const isReference = value => Boolean(value?.reference && typeof value.set === 'function');
const refValue = value => value?.reference ? value.get() : value;

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
