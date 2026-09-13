/**
 * Original Engine AActor::execSetLocation (native 267).
 *
 * The script wrapper evaluates one FVector, loads Actor+0xac (ULevel), and
 * calls that level's FarMoveActor virtual with Test=0 and bNoCheck=0.  The
 * wrapper has no actor-side fallback.  `actorFor` and `farMoveActor` are
 * therefore required injected services: a host must identify the native
 * actor and choose the verified scene adapter explicitly.
 */

export const SET_LOCATION_NATIVE = Object.freeze({
  index: 267,
  engineSha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  thunk: 0x10302bb2,
  exec: 0x103e3120,
  farMoveActorVtableOffset: 0x8c,
  farMoveActorBody: 0x10398ba0,
});

function requireService(service, name) {
  if (typeof service !== 'function') {
    throw new Error(`Actor.SetLocation requires an explicit ${name} service`);
  }
  return service;
}

/**
 * Execute the recovered native wrapper against an explicitly supplied actor
 * identity and FarMoveActor implementation.  FarMoveActor owns the native
 * float conversion, scene callbacks and Boolean result; this wrapper only
 * supplies the original level, destination and two zero flags.
 */
export function execSetLocation(receiver, destination, {
  levelFor,
  actorFor,
  farMoveActor,
} = {}) {
  if (!Array.isArray(destination) || destination.length !== 3) {
    throw new TypeError('Actor.SetLocation requires one FVector expression');
  }
  const getLevel = requireService(levelFor, 'Actor level');
  const level = getLevel(receiver);
  if (level === null || level === undefined) {
    throw new Error('Actor.SetLocation reached a null Actor+0xac Level');
  }
  const getActor = requireService(actorFor, 'native actor identity');
  const actor = getActor(receiver, level);
  if (actor === null || actor === undefined) {
    throw new Error('Actor.SetLocation could not resolve the native actor identity');
  }
  const move = requireService(farMoveActor, 'FarMoveActor');
  // Engine execSetLocation passes the exact zero Test and bNoCheck words.
  return Boolean(move(level, actor, destination, 0, 0));
}
