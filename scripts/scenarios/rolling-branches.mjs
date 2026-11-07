/** A bench-sim scenario (--scenario) for the non-Pawn rolling differential (validate-actor-physics-kernel.mjs): from tick 30, in phases of 40 ticks,
 * every movable map Decoration and Inventory is set rolling (PHYS_Rolling) along a heading that turns from phase to phase, at three speeds,
 * some with an Acceleration (the friction prelude's two directions), some with bBounce (the HitWall bounce branch and its refund of the
 * unspent time) and some with a RotationRate (the performPhysics tail). Twelve ticks into a phase the actor is thrown up into PHYS_Falling
 * and four ticks later set rolling in the air: its drop finds no floor and physRolling's falling transition runs (the Falling event,
 * SetPhysics, the hand-off to physFalling). Walls, corners, slopes and the support base come from the maps. Each tick's inputs are the
 * same on every path; the outcome is compared by digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const headings = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.70710678, 0.70710678], [-0.70710678, 0.70710678]];
  const START = 30, PHASE = 40;
  let actors = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  const kind = actor => {
    const lineage = actor.lineage ?? [];
    return lineage.includes('engine.decoration') ? 'decoration' : lineage.includes('engine.inventory') ? 'inventory' : null;
  };
  const each = (index, step) => {
    const phase = Math.floor((index - START) / PHASE);
    actors.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe')) return;
        step(actor, k, phase);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
  return index => {
    if (index < START) return;
    const at = (index - START) % PHASE;
    if (at !== 0 && at !== 12 && at !== 16) return;
    if (!actors) {
      const level = runtime.levelFor(player);
      actors = level.actors.filter(actor => {
        if (!actor || actor === player || !kind(actor)) return false;
        try { return !read(actor, 'bStatic') && read(actor, 'bMovable') && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
    }
    if (at === 0) each(index, (actor, k, phase) => {
      const [dx, dy] = headings[(phase + k) % headings.length];
      const speed = [60, 320, 1400][(phase + k) % 3];
      runtime.writeNamed(actor, 'Physics', 7);
      runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, 0]);
      runtime.writeNamed(actor, 'Acceleration', k % 4 === 2 ? [-dy * 120, dx * 120, 0] : [0, 0, 0]);
      runtime.writeNamed(actor, 'bBounce', k % 4 === 1);
      runtime.writeNamed(actor, 'RotationRate', k % 5 === 3 ? [0, 8000 + 100 * phase, 0] : [0, 0, 0]);
    });
    else if (at === 12) each(index, (actor, k) => {
      if (k % 3 === 0) return;
      runtime.writeNamed(actor, 'Physics', 2);
      runtime.writeNamed(actor, 'Velocity', [0, 0, 500 + 40 * (k % 5)]);
    });
    else each(index, (actor, k) => {
      if (k % 3 === 0 || read(actor, 'Physics') !== 2) return;
      runtime.writeNamed(actor, 'Physics', 7);
    });
  };
}
