/** A bench-sim scenario (--scenario) for the pawn swimming differential
 * (validate-pawn-physics-kernel.mjs): from tick 30, every map pawn but the
 * player that is swimming (Physics = PHYS_Swimming) is driven, each phase,
 * along a heading that turns level, climbing and diving (its Velocity, with
 * DesiredSpeed 1 and WaterSpeed raised in alternate phases), so swimmers reach walls, corners, the floor
 * and ledges (physSwimming's stepUp). Every third phase makes them buoyant
 * (Buoyancy above Mass), so they surface: Swim's findWaterLine, the exit
 * into PHYS_Falling and the falling tail; they fall back in through the
 * falling body's startSwimming. Every fourth phase gives their water zone a
 * current (ZoneVelocity above 300), physSwimming's ZoneVelocity branch.
 * Each tick's inputs are the same on both paths; the outcome is compared by
 * digest, not to the original. */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  const headings = [[1, 0, 0.3], [0, 1, 1.5], [-1, 0, -0.8], [0, -1, 0], [0.70710678, 0.70710678, 2.5], [-0.70710678, 0.70710678, -0.2]];
  const START = 30, PHASE = 80;
  let pawns = null;
  const currents = new Map();
  const read = (actor, name) => runtime.readNamed(actor, name);
  return index => {
    if (index < START) return;
    const phase = Math.floor((index - START) / PHASE), first = (index - START) % PHASE === 0;
    // Rescanned each phase: Island's fish are spawned (FishGenerator).
    if (first) {
      const level = runtime.levelFor(player);
      pawns = level.actors.filter(actor => {
        if (!actor || actor === player) return false;
        try { return Boolean(read(actor, 'bIsPawn')) && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
    }
    pawns.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe') || read(actor, 'Physics') !== 3) return;
        const [dx, dy, dz] = headings[(phase + k) % headings.length];
        const speed = phase % 2 ? 2400 : 600;
        // The swimmers' AI sets Acceleration each tick; Velocity carries the
        // heading through calcVelocity, clamped to WaterSpeed * DesiredSpeed.
        runtime.writeNamed(actor, 'WaterSpeed', speed);
        runtime.writeNamed(actor, 'DesiredSpeed', 1);
        runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, dz * speed]);
        if (first) runtime.writeNamed(actor, 'Buoyancy', phase % 3 === 2 ? read(actor, 'Mass') * 1.5 : read(actor, 'Mass') * 0.9);
        const zone = read(actor, 'Region')?.['engine.actor.pointregion.zone'];
        if (first && zone && !currents.has(zone)) currents.set(zone, read(zone, 'ZoneVelocity'));
        if (first && zone) runtime.writeNamed(zone, 'ZoneVelocity', phase % 4 === 3 ? [400, -150, 0] : currents.get(zone));
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
