/** A bench-sim scenario (--scenario) for the pawn MoveActor's two returns
 * that leave its Hit unwritten (validate-pawn-move-kernel.mjs). Every PHASE
 * ticks each walking map pawn but the player gets the push a moving brush's
 * CheckEncroachment gives it (0x1039a577), straight down into its floor
 * through ScriptRuntime.moveSmoothPawn: the first MoveActor meets the floor,
 * the zero slide's second one returns at 0x10399228 and HitWall reads the
 * floor hit (docs/mover-push.md, the pawn-floor oracle scene). On every other
 * phase the pawn is also moved once with bMovable cleared, the return at
 * 0x10399145 (bStatic or !bMovable, outside the editor). The same inputs run
 * on both paths; the outcome is compared by digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const START = 30, PHASE = 30;
  let pawns = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  return index => {
    if (index < START || (index - START) % PHASE) return;
    if (!pawns) {
      const level = runtime.levelFor(player);
      pawns = level.actors.filter(actor => {
        if (!actor || actor === player) return false;
        try { return Boolean(read(actor, 'bIsPawn')) && !read(actor, 'bDeleteMe') && runtime.isMapPawn(actor); } catch { return false; }
      });
    }
    const phase = (index - START) / PHASE;
    pawns.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe') || read(actor, 'Physics') !== 1) return;
        runtime.moveSmoothPawn(actor, [0, 0, -4]);
        if ((phase + k) % 2 === 0) {
          runtime.writeNamed(actor, 'bMovable', false);
          try { runtime.movePawn(actor, [4, 0, 0], null); } finally { runtime.writeNamed(actor, 'bMovable', true); }
        }
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
