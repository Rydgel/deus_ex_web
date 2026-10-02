/** A bench-sim scenario (--scenario) for the walking-loop differential
 * (validate-walk-loop-branches.mjs): the walk-branches pushes, plus script
 * events that change Physics inside physWalking, the case the original
 * continues through (docs/walking.md "Physics changed by a script event").
 *
 * Every Bump, HitWall or Touch dispatched to a walking map pawn sets, in
 * turn, Physics None, Falling, Flying or nothing, as a script event during
 * MoveActor or stepUp would (Rotating would reach the unlinked pawn
 * performPhysics boundary when the event comes from another actor's move); every Falling event alternately
 * sets Flying (the stepUp branch's physFlying tail) or nothing. Before each
 * tick's push, a pawn left None or Flying walks again. The writes
 * are raw Physics stores, the same on both paths; the outcome is compared
 * by digest, not to the original (that is validate-native-walking). */
import pushes from './walk-branches.mjs';

export default function ({game, runtime}) {
  const push = pushes({game, runtime});
  const player = game.player.collisionActor;
  const read = (actor, name) => runtime.readNamed(actor, name);
  const pawns = new Set();
  let started = false, inMove = 0, fallings = 0;
  const processEvent = runtime.processEvent;
  runtime.processEvent = function (target, name, ...rest) {
    if (started && pawns.has(target)) {
      try {
        if ((name === 'Bump' || name === 'HitWall' || name === 'Touch') && read(target, 'Physics') === 1) {
          const next = [0, 2, 4, -1][inMove++ % 4];
          if (next >= 0) runtime.writeNamed(target, 'Physics', next);
        } else if (name === 'Falling' && fallings++ % 2 === 0) {
          runtime.writeNamed(target, 'Physics', 4);
        }
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    }
    return processEvent.call(this, target, name, ...rest);
  };
  return index => {
    if (index >= 30 && !started) {
      started = true;
      for (const actor of runtime.levelFor(player).actors) {
        if (!actor || actor === player) continue;
        try { if (read(actor, 'bIsPawn') && !read(actor, 'bDeleteMe')) pawns.add(actor); } catch { /* not a pawn */ }
      }
    }
    if (started) for (const actor of pawns) {
      try {
        if (!read(actor, 'bDeleteMe') && [0, 4].includes(read(actor, 'Physics'))) runtime.writeNamed(actor, 'Physics', 1);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    }
    push(index);
  };
}
