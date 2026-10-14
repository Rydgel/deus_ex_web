/** A bench-sim scenario (--scenario) for ULevel::MoveActor's block test on a pawn source (validate-pawn-move-kernel.mjs, validate-move-pawn-blockers.mjs).
 *
 * The test (Engine.dll 0x103996aa..0x1039978a) picks the candidate's bit by the source's category (bBlockPlayers for a controlled player or a
 * Projectile, bBlockActors for a pawn) and the source's bit by the candidate's, so an item that blocks actors and not players (a bottle, a HazMatSuit)
 * stops a walking pawn. The maps' collidable actors mostly carry both bits, which hides it. Every 30 ticks this flips the collision bits of each
 * map actor that collides with actors (decorations, items, movers) among three profiles (actors only, players only, both) and pushes every walking
 * pawn into them as walk-branches.mjs does. The same inputs run on both paths: the outcome is compared by digest, not to the original. */
import walkBranches from './walk-branches.mjs';

export default function ({game, runtime}) {
  const push = walkBranches({game, runtime});
  const player = game.player.collisionActor;
  const PHASE = 30;
  let actors = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  return index => {
    if (index % PHASE === 0) {
      if (!actors) {
        const level = runtime.levelFor(player);
        actors = level.actors.filter(actor => {
          if (!actor || actor === player) return false;
          try { return Boolean(read(actor, 'bCollideActors')) && !read(actor, 'bIsPawn') && !read(actor, 'bDeleteMe'); } catch { return false; }
        });
      }
      const phase = index / PHASE;
      actors.forEach((actor, k) => {
        try {
          if (read(actor, 'bDeleteMe')) return;
          const profile = (phase + k) % 3;
          runtime.writeNamed(actor, 'bBlockActors', profile !== 1);
          runtime.writeNamed(actor, 'bBlockPlayers', profile !== 0);
        } catch (error) {
          if (!/released|deleted/i.test(String(error?.message))) throw error;
        }
      });
    }
    push(index);
  };
}
