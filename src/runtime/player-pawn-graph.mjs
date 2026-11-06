/**
 * The properties GetPlayerPawn's walk reads, watched for writes.
 *
 * Native 720 (Engine.dll+0x6d2a0) follows Actor.XLevel -> Engine (+0x40) -> Client (+0x44) -> Viewports data/count (+0x2c/+0x30) ->
 * the first viewport's Actor (+0x30), and Play holds that graph as plain host objects: `level.engine.client.viewports[0].actor`
 * (script-triggers.mjs resolveNativeGetPlayerPawn reads them through the `read` service script-doors.mjs gives it). The Rust
 * interpreter answers the native from a cell (natives.rs PLAYER_PAWN_CELL) filled by that walk, which stays right while none of the
 * properties the walk reads is written. `watchPlayerPawnGraph` turns each of the five links into an accessor that tells `notify`
 * on every write (and keeps watching the object a write installs), with the value, enumerability and the object's identity
 * unchanged for every reader.
 *
 * What it does not see: the viewport list's length, changed in place (push, pop, `length = 0`), and a property that did not exist
 * when it was installed. It returns false when a link in the chain is missing or is an accessor already; the caller then keeps the
 * walk at every call (script-vm-rust.mjs `playerPawn`, PLAYER_PAWN=direct). PLAYER_PAWN=verify compares the cell with a fresh walk
 * at every call.
 */

const LINKS = ['engine', 'client', 'viewports', 0, 'actor'];

/** Watch `level`'s chain. `notify(complete)` runs after every write to a link: `complete` is false when the object the write
 * installed has a link that cannot be watched (the cell is then no longer trusted). Returns true when every link of the chain
 * was an own data property that could be watched. */
export function watchPlayerPawnGraph(level, notify) {
  return watchLink(level, 0, notify);
}

function watchLink(object, depth, notify) {
  if (object === null || typeof object !== 'object') return false;
  const key = LINKS[depth], descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.configurable) return false;
  const last = depth === LINKS.length - 1;
  let value = descriptor.value;
  // (the viewport's actor is the end of the walk: a pawn, or None)
  const complete = last || watchLink(value, depth + 1, notify);
  Object.defineProperty(object, key, {
    configurable: true, enumerable: descriptor.enumerable,
    get() { return value; },
    set(next) {
      value = next;
      notify(last || watchLink(next, depth + 1, notify));
    },
  });
  return complete;
}
