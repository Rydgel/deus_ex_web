/** A bench-sim scenario (--scenario) for the non-Pawn PHYS_Projectile differential
 * (validate-actor-physics-kernel.mjs): from tick 30, every movable map
 * Decoration and Inventory is launched into PHYS_Projectile at the start of
 * each phase, along a heading that turns from phase to phase, with an
 * Acceleration of its own (none, a gravity-like pull, a sideways push).
 * Fast ones reach walls and floors (the HitWall event; with bBounce the
 * time refund and the bounce count), slow ones fly free (the final
 * Velocity = displacement / DeltaTime), some spin (RotationRate, the
 * performPhysics tail). The Island's water zone reaches the fluid-friction
 * integration. Each phase also spawns a few Projectile-class actors (Tracer,
 * Rocket, LAM) beside the player and launches them past their MaxSpeed (the
 * clamp), and after every third HitWall of the launched actors the scenario
 * sets the Physics of every third actor to PHYS_Falling at its first (the bounce
 * that hands the remaining time to physFalling; a second one is turned back
 * into a plain flight, as a third bounce would hand physFalling no time, which
 * falling refuses as a boundary). Each tick's inputs are the same on both paths; the outcome
 * is compared by digest, not to the original. */
export default async function ({game, runtime, assets}) {
  const player = game.player.collisionActor;
  const level = runtime.levelFor(player);
  const headings = [[1, 0, 0.5], [0, 1, 1.2], [-1, 0, -0.3], [0, -1, 0.8], [0.70710678, 0.70710678, 2], [-0.70710678, 0.70710678, 0.1]];
  const pulls = [[0, 0, 0], [0, 0, -600], [200, 0, 0], [0, -150, -300]];
  const START = 30, PHASE = 40;
  let actors = null;
  const read = (actor, name) => runtime.readNamed(actor, name);
  const kind = actor => {
    const lineage = actor.lineage ?? [];
    return lineage.includes('engine.decoration') ? 'decoration' : lineage.includes('engine.inventory') ? 'inventory' : null;
  };
  const deusEx = await assets.get('DeusEx');
  const projectiles = [];
  for (const name of ['tracer', 'rocket', 'lam']) {
    const exportIndex = deusEx.exportsByPath.get(name);
    if (exportIndex === undefined) continue;
    try { projectiles.push((await runtime.loadClass(deusEx, exportIndex)).record); } catch { /* the class does not load: skipped */ }
  }
  const launched = new Map(), hitsOf = new Map();
  // After the first HitWall of every third launched actor in a phase: PHYS_Falling. After the second (the third bounce of
  // one call would hand physFalling no time, which falling refuses): back to PHYS_Projectile without bBounce.
  const dispatch = runtime.dispatchSpawnedEvent.bind(runtime);
  runtime.dispatchSpawnedEvent = (target, event, args) => {
    const result = dispatch(target, event, args);
    if (event === 'HitWall' && launched.has(target)) {
      const n = (hitsOf.get(target) ?? 0) + 1;
      hitsOf.set(target, n);
      try {
        if (n === 1 && launched.get(target) % 3 === 0) runtime.writeNamed(target, 'Physics', 2);
        else if (n === 2) { runtime.writeNamed(target, 'Physics', 6); runtime.writeNamed(target, 'bBounce', false); }
      } catch { /* destroyed by its HitWall */ }
    }
    return result;
  };
  return index => {
    if (index < START || (index - START) % PHASE) return;
    if (!actors) {
      actors = level.actors.filter(actor => {
        if (!actor || actor === player || !kind(actor)) return false;
        try { return !read(actor, 'bStatic') && read(actor, 'bMovable') && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
      actors.forEach(actor => launched.set(actor, launched.size));
    }
    const phase = (index - START) / PHASE;
    hitsOf.clear();
    const origin = read(player, 'Location');
    projectiles.forEach((cls, c) => {
      for (let i = 0; i < 4; i++) {
        let actor = null;
        try {
          actor = runtime.spawnActor({cls, level, name: 'None', owner: null, instigator: null,
            location: origin.map((v, axis) => v + (axis === 2 ? 40 : 0) + (axis === 0 ? 30 * (i + 4 * c) : 0)), rotation: [0, 0, 0]});
        } catch { /* a gate refused this spawn */ }
        if (!actor) continue;
        launched.set(actor, launched.size);
        actors.push(actor);
      }
    });
    actors.forEach((actor, k) => {
      try {
        if (read(actor, 'bDeleteMe')) return;
        const [dx, dy, dz] = headings[(phase + k) % headings.length];
        const projectile = !kind(actor);
        const speed = projectile ? 12000 : (phase + k) % 3 === 0 ? 3200 : 450;
        runtime.writeNamed(actor, 'Physics', 6);
        runtime.writeNamed(actor, 'Velocity', [dx * speed, dy * speed, dz * speed]);
        runtime.writeNamed(actor, 'Acceleration', pulls[(phase + 2 * k) % pulls.length]);
        runtime.writeNamed(actor, 'bBounce', k % 4 === 1 || (projectile && k % 2 === 0));
        runtime.writeNamed(actor, 'RotationRate', k % 5 === 3 ? [0, 8000 + 100 * phase, 0] : [0, 0, 0]);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    });
  };
}
