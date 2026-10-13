/** A bench-sim scenario (--scenario) for the pawn rotation step's differential (validate-pawn-physics-kernel.mjs,
 * APawn::physicsRotation 0x103c9f30; script-pawn-physics.mjs pawnRotationStep, native/script-vm/src/pawn_phys.rs): every
 * 15 ticks each map pawn but the player gets a Rotation and a DesiredRotation chosen to reach the branches: equal and raw
 * (non-canonical: negative Yaw, Pitch -4, Yaw above 65535), equal with a nonzero Pitch, one axis equal and the other not,
 * the half-turn tie of the shorter-arc rule, a nonzero Roll, and RotationRate values around the step size and the Pitch
 * clamp. Each tick's inputs are the same on both paths; the outcome is compared by digest, not to the original (the
 * oracle does that: validate-native-pawn-rotation.mjs). */
export default function ({game, runtime}) {
  const player = game.player.collisionActor;
  let pawns = null, seed = 0x51ed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const read = (actor, name) => runtime.readNamed(actor, name);
  const raw = () => [int(-70000, 140000), int(0, 65535), int(-40000, 70000)][int(0, 2)];
  return index => {
    if (index < 30 || index % 15) return;
    if (!pawns) {
      const level = runtime.levelFor(player);
      pawns = level.actors.filter(actor => {
        if (!actor || actor === player) return false;
        try { return Boolean(read(actor, 'bIsPawn')) && !read(actor, 'bDeleteMe'); } catch { return false; }
      });
    }
    for (const actor of pawns) {
      try {
        if (read(actor, 'bDeleteMe')) continue;
        const physics = read(actor, 'Physics');
        if (physics !== 1 && physics !== 2 && physics !== 4) continue;
        const kind = int(0, 7);
        const rotation = [kind === 1 ? -4 : kind === 2 ? 1500 : int(-2000, 2000), kind === 0 ? -32404 : raw(), kind === 5 ? int(1, 4000) : 0];
        let desired = [random() < .5 ? rotation[0] : raw(), random() < .5 ? rotation[1] : raw(), 0];
        if (kind === 3) desired = [rotation[0], rotation[1], 0];
        if (kind === 4) desired = [rotation[0], (rotation[1] + 32768) | 0, 0];       // the half turn
        if (kind === 6) desired = [0, rotation[1], 0];
        runtime.writeNamed(actor, 'Rotation', rotation);
        runtime.writeNamed(actor, 'DesiredRotation', desired);
        runtime.writeNamed(actor, 'RotationRate', [[0, 1, 546, 4096, 20000][int(0, 4)], [0, 90, 833, 50000, 125000][int(0, 4)], [-5, 0, 3072][int(0, 2)]]);
      } catch (error) {
        if (!/released|deleted/i.test(String(error?.message))) throw error;
      }
    }
  };
}
