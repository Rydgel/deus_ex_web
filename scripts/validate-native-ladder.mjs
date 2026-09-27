/** Compare the walking surface prelude's Ladder branch (walking-surface.mjs
 * climbLadder -> flying.mjs physFlying) with the original 0x103cc450 prelude
 * running 0x103cc519-0x103cc6ca and native physFlying in Unicorn
 * (scripts/native-ladder-oracle.py). Line queries, WalkTexture and MoveActor
 * are the same controlled callbacks on both sides; MoveActor is unobstructed.
 * Evidence: docs/ladder-flying.md. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { walkingSurfacePrelude } from '../src/runtime/walking-surface.mjs';
import { physFlying } from '../src/runtime/flying.mjs';
import { gameDirectory } from './game-directory.mjs';

const f = Math.fround, cases = [];
const base = { position: [0, 0, 45], rotation: [0, 0, 0], radius: 20, height: 43, group: 'Ladder', hitAt: 0,
  velocity: [0, 0, 0], acceleration: [0, 0, 0], groundSpeed: 320, airSpeed: 400, accelRate: 500,
  viewRotation: [0, 0, 0], fluidFriction: f(1.2), walking: false };
const add = changes => cases.push({ ...base, ...changes });
// Pitch around zero and the signed/unnormalized forms; acceleration on/off.
for (const pitch of [0, 1, -1, 4000, -4000, 16384, -16384, 60000, -60000, 65535, 0x7fffe000])
  for (const acceleration of [[0, 0, 0], [500, 0, 0], [0, -300, 0], [1e-40, 0, 0]])
    add({ viewRotation: [pitch, 16384, 0], acceleration, velocity: [30, -20, 15] });
// GroundSpeed, prior bIsWalking, the selecting ray and the scanned hit.
for (const groundSpeed of [0, 320, 150.5]) for (const walking of [false, true]) for (const hitAt of [0, 9, 35])
  add({ groundSpeed, walking, hitAt, viewRotation: [-3000, 5000, 100], acceleration: [300, 400, 0], velocity: [250, 10, -80] });
// A lowercase group is not a scan break but still selects the branch.
add({ group: 'ladder', everyHit: true, acceleration: [200, 0, 0], viewRotation: [2000, 0, 0] });
add({ group: 'LADDER', hitAt: 3, acceleration: [0, 0, 0], velocity: [100, 0, 0] });
let seed = 90210;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const vector = scale => Array.from({ length: 3 }, () => f((random() * 2 - 1) * scale));
for (let i = 0; i < 120; i++) add({ position: vector(3000), rotation: [0, (random() * 65536) | 0, 0],
  velocity: vector(400), acceleration: random() < .25 ? [0, 0, 0] : vector(2000), groundSpeed: f(random() * 400),
  airSpeed: f(50 + random() * 500), accelRate: f(50 + random() * 2000), fluidFriction: f(random() * 3),
  viewRotation: [((random() * 2 - 1) * 70000) | 0, (random() * 65536) | 0, 0], walking: random() < .5,
  hitAt: (random() * 36) | 0 });

function run(c) {
  let index = 0;
  const events = [], texture = { key: `fixture.${c.group}.Rungs`, outerName: c.group, friction: 1 };
  const pawn = { position: c.position.map(f), rotation: c.rotation, radius: c.radius, height: c.height, physics: 1,
    velocity: c.velocity.map(f), acceleration: c.acceleration.map(f), groundSpeed: c.groundSpeed, airSpeed: c.airSpeed,
    accelRate: c.accelRate, desiredSpeed: 1, viewRotation: c.viewRotation, isWalking: c.walking, isPlayerPawn: true,
    isPlayer: false, netMode: 0, fluidFriction: c.fluidFriction, zoneVelocity: [0, 0, 0], zoneGravityZ: -950,
    collideWorld: false, zoneNumber: 1, justTeleported: false, oldLocation: [0, 0, 0], maxStepHeight: 25, mass: 100,
    lineCheck(start, end, extent, flags) {
      events.push({ line: { start: [...start], end, extent, flags } });
      const hit = c.everyHit || c.hitAt === index++;
      return { time: hit ? .5 : 1, location: end, normal: [0, 0, hit ? 1 : 0], texture: hit ? texture : null };
    },
    textureForHit: hit => hit.texture,
    // The ordinary WalkTexture (caller 0x103cc820) follows the floor trace,
    // which starts at Location; the Ladder one (0x103cc57c) follows the scan.
    walkTexture(t, location, normal) {
      const last = events.findLast(e => e.line), floor = last && last.line.start.every((v, i) => v === pawn.position[i]);
      events.push({ [floor ? 'walkTexture' : 'ladderWalkTexture']: !!t, location: [...location], normal: [...normal] });
    },
    move(delta) {
      events.push({ move: [...delta], velocity: [...pawn.velocity] });
      pawn.position = pawn.position.map((v, i) => f(v + delta[i]));
      return { time: 1, normal: [0, 0, 0], actor: null };
    },
    hitWall() { throw new Error('unobstructed ladder fixture hit a wall'); },
    flying: (seconds, iterations) => physFlying(pawn, seconds, iterations),
  };
  const handled = walkingSurfacePrelude(pawn, f(.016), 0);
  return { handled, events, position: pawn.position, velocity: pawn.velocity, acceleration: pawn.acceleration, walking: pawn.isWalking };
}

fs.mkdirSync('.cache/walking', { recursive: true });
fs.writeFileSync('.cache/walking/ladder-cases.json', JSON.stringify(cases));
const native = spawnSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-ladder-oracle.py', gameDirectory(), '.cache/walking/ladder-cases.json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (native.status) throw Error(native.stderr);
const expected = JSON.parse(native.stdout).results, failures = [];
cases.forEach((c, i) => {
  const actual = run(c);
  if (JSON.stringify(actual) !== JSON.stringify(expected[i])) failures.push({ i, input: c, actual, expected: expected[i] });
});
fs.writeFileSync('.cache/walking/ladder-comparison.json', JSON.stringify({ cases: cases.length, failures }, null, 1));
console.log(JSON.stringify({ cases: cases.length, failures: failures.length,
  first: failures[0] && { i: failures[0].i, input: failures[0].input,
    actual: { ...failures[0].actual, events: failures[0].actual.events.filter(e => !e.line) },
    expected: { ...failures[0].expected, events: failures[0].expected.events.filter(e => !e.line) } } }, null, 1));
assert.equal(failures.length, 0, 'the Ladder branch agrees with the original prelude and physFlying');
