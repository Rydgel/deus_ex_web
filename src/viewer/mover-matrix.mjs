/** A mover group's matrix from the simulation's mover state (sim-session.mjs
 * movers): world.mjs poses its brush meshes with it and the simulation side
 * (drawn-set.mjs) culls them with it. */
import { brushMatrix } from './transforms.mjs';
import { toView } from '../unreal/geometry.mjs';

/** A rotating key (physMovingBrush's NewRotation) poses the brush matrix of
 * the live Location and Rotation, as ABrush::ToWorld does; otherwise the
 * authored matrix moves by the collider offset. Writes `out`; returns
 * whether the mover is rotated. */
export function moverGroupMatrix(mover, baseMatrix, out) {
  const authored = mover.values.Rotation ?? [0, 0, 0], rotation = mover.rotation ?? authored;
  if (rotation.some((v, i) => (v | 0) !== ((authored[i] ?? 0) | 0))) {
    out.copy(brushMatrix({ ...mover.values, Location: mover.position, Rotation: rotation }));
    return true;
  }
  out.copy(baseMatrix);
  const offset = toView(mover.offset);
  for (let i = 0; i < 3; i++) out.elements[12 + i] += offset[i];
  return false;
}
