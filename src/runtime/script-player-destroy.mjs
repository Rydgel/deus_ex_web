/** Native Destroy overrides of the player chain and its FlagBase.
 *
 * ConditionalDestroy selects each object's vtable slot +0x24. Of every native
 * Actor class the construction registry admits, only ADeusExPlayer
 * (DeusEx vtable 0x10027568) and APlayerPawnExt (Extension 0x1005c32c)
 * override it; the rest inherit AActor::Destroy. Evidence and callers:
 * docs/script-player-login.md ("Reset: LoadMap retires the old player").
 */

export const PLAYER_DESTROY = Object.freeze({
  deusExPlayerVtable: 0x10027568,
  deusExPlayerDestroy: 0x100141f0,
  playerPawnExtVtable: 0x1005c32c,
  playerPawnExtDestroy: 0x10037d40,
  flagBaseVtable: 0x1005c20c,
  flagBaseDestroy: 0x100239f0,
});

function required(services, name) {
  if (typeof services?.[name] !== 'function') throw new Error(`Player Destroy requires ${name}`);
  return services[name];
}

/** APlayerPawnExt::Destroy 0x10037d40. Inside a collection
 * (GObjInGarbageCollection, Core 0x102a264c) or with no FlagBase it only
 * nulls +0x890; otherwise it ConditionalDestroys the FlagBase and leaves the
 * pointer. A non-null rootWindow (+0x894) goes to XWindow::SafeDestroy, which
 * may defer a locked window; +0x894 is then nulled unconditionally before
 * AActor::Destroy. */
export function destroyPlayerPawnExtNative(receiver, services) {
  const read = required(services, 'read'), write = required(services, 'write');
  const inGarbageCollection = required(services, 'inGarbageCollection');
  const flagBase = read(receiver, 'flagBase');
  if (!inGarbageCollection() && flagBase) required(services, 'conditionalDestroy')(flagBase);
  else write(receiver, 'flagBase', null);
  const rootWindow = read(receiver, 'rootWindow');
  if (rootWindow) required(services, 'safeDestroyWindow')(rootWindow);
  write(receiver, 'rootWindow', null);
  return required(services, 'destroyActorBase')(receiver);
}

/** ADeusExPlayer::Destroy 0x100141f0: three explicit stores
 * (0x10014216..0x10014222) — conHistory +0x9fc, FirstLog +0xa50 and LastLog
 * +0xa54 by the retail property offsets — then APlayerPawnExt::Destroy. The
 * referenced objects are not destroyed here. */
export function destroyDeusExPlayerNative(receiver, services) {
  const write = required(services, 'write');
  for (const name of ['conHistory', 'FirstLog', 'LastLog']) write(receiver, name, null);
  return destroyPlayerPawnExtNative(receiver, services);
}

/** XFlagBase::Destroy 0x100239f0: UObject::Destroy first, then each of the 64
 * buckets (+0x28) is drained by RemoveFlag 0x10023a80, which unlinks the head
 * and zeroes its next (+0x34) and flagBase (+0x30). No script runs. The host
 * FlagBase stores its flags as entries without flag-object identities, so the
 * drained base is the observable result; the detached flag objects' own
 * lifetime (XFlag::Destroy 0x10023870 at their collection) has no host record. */
export function destroyFlagBaseNative(receiver, services) {
  required(services, 'destroyObjectBase')(receiver);
  const entries = receiver?.entries;
  if (!(entries instanceof Map)) throw new Error('XFlagBase::Destroy requires the host flag store');
  entries.clear();
}
