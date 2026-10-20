/** Training's ladder (CoreTexMetal.Ladder group, X 6960..7012, Y -3376..-3370, Z -191..-17) through public input: the scenario of
 * scripts/validate-training-ladder.mjs, callable on a session someone else opened (scripts/validate-stage5-o3.mjs records it, the census delegates to the
 * validator that runs it). `game` is a Play game on 00_Training before its first tick and `input` the player-input fixture of that game (tickSeconds 1/60).
 * Returns the summary the validator prints. */
import assert from 'node:assert/strict';
import {getAxes} from '../src/runtime/camera.mjs';

export function ladderScene(game, input) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = name => runtime.readNamed(player, name);
  const z = () => game.player.position[2];
  const noError = label => assert.equal(game.runtimeError ?? null, null, `${label}: ${game.runtimeError?.message}`);
  // The branch's raw Velocity.Z (GroundSpeed * XAxis.Z * 0.5) is only the input
  // to physFlying, whose calcVelocity and final displacement/dt overwrite it in
  // the same tick; its exact value is covered by validate-native-ladder. Here the
  // sign of the climb follows XAxis.Z of the pitch after the 6144 shift.
  const climbSign = () => {
    const [pitch, yaw, roll] = read('ViewRotation');
    return Math.sign(getAxes([(pitch >= 0 ? pitch + 0x1800 : pitch - 0x1800) | 0, yaw, roll])[0][2]);
  };
  input.tick(30);

  // 1. From the pit floor, walking into the rungs while looking up climbs out.
  input.place([6986, -3330, 60], {yaw: -Math.PI / 2});
  input.tick(120); noError('settle');
  assert.equal(read('Physics'), 1, 'settled walking on the pit floor');
  const floor = z();
  assert.ok(floor < -140, `pit floor, got Z=${floor}`);
  input.steer(-Math.PI / 2, .6);
  input.driveLegacy({forward: 1});
  input.tick(20); noError('climb');
  assert.equal(read('bIsWalking'), true, 'the Ladder branch sets bIsWalking');
  assert.equal(climbSign(), 1);
  assert.ok(read('Velocity')[2] > 100 && z() > floor + 20, 'climbing rises');
  input.tick(100); noError('exit');
  input.driveLegacy({forward: 0}); input.tick(30); noError('top');
  assert.ok(z() > 10, `climbed onto the upper floor, got Z=${z()}`);
  const top = game.player.position.map(Math.round);

  // 2. On the rungs with no input: zero Acceleration leaves zero Velocity (hang).
  input.place([6986, -3349, -60], {yaw: -Math.PI / 2, pitch: -.7});
  input.tick(60); noError('hang');
  assert.deepEqual(read('Velocity'), [0, 0, 0], 'hanging on the ladder');
  assert.equal(z(), -60, 'no gravity while on the ladder');

  // 3. Looking down descends at the original rate; ViewRotation.Pitch is stored
  // unsigned (65536-7301), so it takes the +6144 branch.
  input.driveLegacy({forward: 1});
  input.tick(30); noError('descend');
  assert.ok(read('ViewRotation')[0] > 32768, 'down-look pitch is stored unsigned');
  assert.equal(climbSign(), -1);
  assert.ok(read('Velocity')[2] < 0 && read('Velocity')[2] > -40 && z() < -60, 'a 40-degree down-look descends slowly');
  const descentZ = read('Velocity')[2];
  input.driveLegacy({forward: 0}); input.tick(10);
  return {floor: Math.round(floor), top, hang: -60, descentZ,
    scope: 'Training ladder climb, exit, hang and descent through public input; no runtime boundary'};
}
