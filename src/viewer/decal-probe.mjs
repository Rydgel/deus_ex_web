/** Validation only (scripts/validate-decals-play.mjs): stand the player a few
 * metres from a ScriptedPawn looking at its feet (`place`), or read that
 * pawn's Shadow and the level's FDecal state, on whichever side runs the
 * simulation (sim-worker.mjs `call`, or the page with ?sim=inline). */
export function decalProbe(game, { place = false, pawn = null } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = (a, n) => runtime.readNamed(a, n), level = runtime.levelFor(player);
  if (place) {
    const isA = (a, key) => { for (let c = runtime.instance(a)?.cls; c; c = c.base) if (c.record?.key === key) return true; return false; };
    const pawns = level.actors.filter(a => a && isA(a, 'deusex.scriptedpawn') && read(a, 'Shadow') && !read(a, 'bHidden'));
    const target = pawns.find(a => /JaimeReyes/.test(a.name)) ?? pawns[0];
    const loc = read(target, 'Location'), h = read(target, 'CollisionHeight');
    const from = [loc[0] - 300, loc[1] + 120, loc[2] + 30];
    runtime.farMoveActor(player, from, 0, 1);
    // Aim at the pawn's feet (Location - CollisionHeight) from the eye.
    const eye = read(player, 'Location')[2] + read(player, 'BaseEyeHeight'), feet = loc[2] - h;
    const yaw = Math.round(Math.atan2(loc[1] - from[1], loc[0] - from[0]) * 32768 / Math.PI);
    const pitch = Math.round(-Math.atan2(eye - feet, Math.hypot(loc[0] - from[0], loc[1] - from[1])) * 32768 / Math.PI);
    runtime.writeNamed(player, 'ViewRotation', [(pitch + 65536) & 0xffff, (yaw + 65536) & 0xffff, 0]);
    return { name: target.name, shadow: read(target, 'Shadow').name };
  }
  const target = level.actors.find(a => a?.name === pawn), shadow = read(target, 'Shadow');
  return { surfList: [...read(shadow, 'SurfList')], hasDecal: read(shadow, 'bHasDecal'), lastRendered: read(shadow, 'LastRenderedTime'),
    time: read(level.actors[0], 'TimeSeconds'), records: level.decals?.store.count ?? 0 };
}
