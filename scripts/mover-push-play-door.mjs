/** Training's UN_maindoor leaf (DeusExMover16) closing on Ammo10mm2 (a pickup,
 * radius 8.5, height 3.02, flags 7) placed at the leaf's -Y edge, squeezed
 * against the door frame: Play's pushes of the first MoveActor calls and a few
 * later ones, recorded from validate-mover-push-play.mjs. Each group is one
 * Mover.MoveActor: the leaf (and its partner leaf, DeusExMover17) at `mover` /
 * `other`, the ammo at `ammo`, the leaf's translation `delta` along Y, and
 * `final`, the ammo's position after the whole CheckEncroachment (forward
 * push, re-query, reverse push). validate-native-mover-push.mjs runs the same
 * groups through the original Engine.dll and fails unless the original ends at
 * `final`; the Play validator fails unless Play does. */
export const AMMO = Object.freeze({name: 'Ammo10mm2', radius: 8.5, height: 3.0199999809265137, bits: 7, start: [-216, 764, -64]});
export const GROUPS = Object.freeze([
  {mover: [-220, 800, -64], other: [-219.998046875, 863.99853515625, -64], ammo: [-216, 764, -64], delta: [0, -0.0029296875, 0], final: [-216, 764, -64]},
  {mover: [-220, 796.0443725585938, -64], other: [-219.998046875, 867.9541625976562, -64], ammo: [-216, 764, -64], delta: [0, -0.1925048828125, 0], final: [-216, 764.1925048828125, -64]},
  {mover: [-220, 795.8518676757812, -64], other: [-219.998046875, 868.1466674804688, -64], ammo: [-216, 764.1925048828125, -64], delta: [0, -0.1964111328125, 0], final: [-216, 764.388916015625, -64]},
  {mover: [-220, 778.9351806640625, -64], other: [-219.998046875, 885.0633544921875, -64], ammo: [-216, 778.9723510742188, -64], delta: [0, -0.34075927734375, 0], final: [-216, 778.973388671875, -64]},
  {mover: [-220, 748.148193359375, -64], other: [-219.998046875, 915.850341796875, -64], ammo: [-216, 778.9835815429688, -64], delta: [0, -0.1925048828125, 0], final: [-216, 778.9835815429688, -64]},
  {mover: [-220, 744.0029296875, -64], other: [-219.998046875, 919.99560546875, -64], ammo: [-216, 781.8657836914062, -64], delta: [0, -0.0029296875, 0], final: [-216, 781.8687133789062, -64]},
]);
