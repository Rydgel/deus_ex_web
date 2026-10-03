/** A bench-sim scenario (--scenario) for the non-Pawn falling differential
 * (validate-actor-physics-kernel.mjs): from tick 30, every movable map
 * Decoration and Inventory is launched into PHYS_Falling at the start of
 * each phase, along a heading that turns from phase to phase. Rising
 * launches reach physFalling's apex subdivision, fast ones the
 * terminal-velocity clamp and walls, corners and floors; some actors bounce
 * (bBounce, the HitWall event branch), some Decorations bob (bBobbing's
 * integration in dry zones) and some spin (RotationRate, the
 * performPhysics tail). Script reactions (Landed damage, fragments) follow
 * on both paths. Each tick's inputs are the same on both paths; the
 * outcome is compared by digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const headings = [[1, 0, 0.5], [0, 1, 1.2], [-1, 0, -0.3], [0, -1, 0.8], [0.70710678, 0.70710678, 2], [-0.70710678, 0.70710678, 0.1]];
  const START = 30, PHASE = 40;
  let actors = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  const kind = actor => {
    const lineage = actor.lineage ?? [];
    return lineage.includes('engine.decoration') ? 'decoration' : lineage.includes('engine.inventory') ? 'inventory' : null;
  };
  return index => {
    if (index < START || (index - START) % PHASE) return;
    if (!actors) {
      const level = runtime.levelFor(player);
      actors = level.actors.filter(actor => {
        if (!actor || actor === player || !kind(actor)) return false;
        try { return !read(actor, 'bStatic') && read(actor, 'bMovable') && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
    }
    const phase = (index - START) / PHASE;
    actors.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe')) return;
        const [dx, dy, dz] = headings[(phase + k) % headings.length];
        const speed = (phase + k) % 3 === 0 ? 3200 : 450;
        runtime.writeNamed(actor, 'Physics', 2);
        runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, dz * speed]);
        runtime.writeNamed(actor, 'bBounce', k % 4 === 1);
        if (kind(actor) === 'decoration') runtime.writeNamed(actor, 'bBobbing', k % 3 === 2);
        runtime.writeNamed(actor, 'RotationRate', k % 5 === 3 ? [0, 8000 + 100 * phase, 0] : [0, 0, 0]);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
