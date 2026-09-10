/** Native index declared by Actor.uc for Actor.SetOwner. */
export const SET_OWNER_NATIVE_INDEX = 272;

const isObject = value => value !== null && value !== undefined;

/**
 * Execute the original AActor::SetOwner transition.
 *
 * `read(actor, property)` and `write(actor, property, value)` are the host's
 * property boundary. `processEvent(actor, name, args)` is synchronous and is
 * required because LostChild/GainedChild are dynamic script events. The
 * helper intentionally has no implicit Owner container, actor-array update,
 * Modify, or tick hook: the traced native performs none of those operations.
 */
export function setScriptOwner(receiver, newOwner, { read, write, processEvent } = {}) {
  if (!isObject(receiver)) throw new TypeError('SetOwner requires a receiver actor');
  if (typeof read !== 'function') throw new TypeError('SetOwner requires a read callback');
  if (typeof write !== 'function') throw new TypeError('SetOwner requires a write callback');
  if (typeof processEvent !== 'function') throw new TypeError('SetOwner requires a processEvent callback');

  // AActor::SetOwner reads Owner once, before any callback. An old callback
  // can re-enter SetOwner or mutate the field; the outer native still writes
  // its saved NewOwner after LostChild returns.
  const oldOwner = read(receiver, 'Owner');
  if (isObject(oldOwner)) processEvent(oldOwner, 'LostChild', [receiver]);

  // The assignment is between the two notifications. No equality, self, or
  // ownership-cycle guard exists in the original body.
  write(receiver, 'Owner', newOwner);
  if (isObject(newOwner)) processEvent(newOwner, 'GainedChild', [receiver]);
}
