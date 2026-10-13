/** A bench-sim scenario (--scenario) for the walking-loop differential
 * (validate-walk-loop-branches.mjs): every walking map pawn but the player is
 * pushed along a heading that rotates over time, so pawns walk into walls,
 * steps, each other and off ledges; on a third of the phases jumping is
 * forbidden so a ledge takes the retreat branch, and the sloped-wall flag is
 * raised periodically so its re-probe runs. Each tick's inputs are the same
 * on both paths; the outcome is compared by digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const headings = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.70710678, 0.70710678], [-0.70710678, 0.70710678]];
  const START = 30, PHASE = 45;
  let pawns = null;
  // The zone's current, per phase: above 300 it enters a script pawn's desired move, below it does not (physWalking 0x103ca697),
  // which a long frame (--dt) makes visible (25 x |ZoneVelocity| x dt).
  const currents = new Map(), zoned = new Map();
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
        if (read(actor, 'bDeleteMe') || read(actor, 'Physics') !== 1) return;
        const [dx, dy] = headings[(phase + k) % headings.length];
        const speed = Math.max(100, read(actor, 'GroundSpeed') || 0) * 3;
        runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, 0]);
        runtime.writeNamed(actor, 'Acceleration', [dx * speed, dy * speed, 0]);
        // calcVelocity caps a script pawn at GroundSpeed x DesiredSpeed (0x103cdf05), 0.2-0.3 for a walking NPC: the
        // pawns run at their ground speed, so they still reach the steps and walls the scenario is for.
        runtime.writeNamed(actor, 'DesiredSpeed', 1);
        // Once per phase and zone (a write every tick for every pawn made the run minutes slower).
        const zone = read(actor, 'Region')?.['engine.actor.pointregion.zone'];
        if (zone && zoned.get(zone) !== phase) {
          zoned.set(zone, phase);
          if (!currents.has(zone)) currents.set(zone, read(zone, 'ZoneVelocity'));
          runtime.writeNamed(zone, 'ZoneVelocity', phase % 4 === 1 ? [305, 0, 0] : phase % 4 === 2 ? [0, -290, 0] : currents.get(zone));
        }
        runtime.writeNamed(actor, 'bCanJump', phase % 3 !== 1);
        if (index % 20 === 0 && k % 2 === 0) runtime.writeNamed(actor, 'bHitSlopedWall', true);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
