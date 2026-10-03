/** A bench-sim scenario (--scenario) for the pawn physics differential
 * (validate-pawn-physics-kernel.mjs): from tick 30, every map pawn but the
 * player flies (Physics = PHYS_Flying) along a heading that rotates over
 * time, level and climbing or diving, so pawns fly into walls, floors,
 * ceilings, ledges and each other. Level flight into a wall takes
 * physFlying's stepUp branch, steep flight its HitWall slide and the
 * TwoWallAdjust in corners. DesiredRotation is turned with the heading so
 * physicsRotation keeps stepping. Each tick's inputs are the same on both
 * paths; the outcome is compared by digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const headings = [[1, 0, 0], [0, 1, 0.2], [-1, 0, -0.6], [0, -1, 0], [0.70710678, 0.70710678, 0.9], [-0.70710678, 0.70710678, -0.1]];
  const START = 30, PHASE = 40;
  let pawns = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  return index => {
    if (index < START) return;
    if (!pawns) {
      const level = runtime.levelFor(player);
      pawns = level.actors.filter(actor => {
        if (!actor || actor === player) return false;
        try { return Boolean(read(actor, 'bIsPawn')) && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
    }
    const phase = Math.floor((index - START) / PHASE);
    pawns.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe')) return;
        const [dx, dy, dz] = headings[(phase + k) % headings.length];
        // calcVelocity clamps to AirSpeed * DesiredSpeed: fast phases raise
        // AirSpeed so pawns reach walls and corners within a phase.
        const speed = phase % 2 ? 2400 : 400;
        runtime.writeNamed(actor, 'AirSpeed', speed);
        if (read(actor, 'Physics') !== 4) runtime.writeNamed(actor, 'Physics', 4);
        runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, dz * speed]);
        runtime.writeNamed(actor, 'Acceleration', [dx * speed, dy * speed, dz * speed]);
        runtime.writeNamed(actor, 'DesiredRotation', [(phase * 4096) & 0xffff, (phase * 8192 + k * 1000) & 0xffff, 0]);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
