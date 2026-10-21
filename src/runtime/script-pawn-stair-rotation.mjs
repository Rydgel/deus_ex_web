/** Pawn.FindStairRotation (native 524): APawn::execFindStairRotation, Engine.dll 0x103bb880-0x103bbf42. docs/pawn-stair-rotation.md.
 *
 * The base PlayerPawn.PlayerWalking.PlayerMove asks it for the pitch to ease towards when bLookUpStairs is set (installed User.ini
 * has it False; the StairLook exec sets it). It reads the pawn's Location (+0x114), CollisionRadius (+0x1d4), CollisionHeight
 * (+0x1d8), ViewRotation (+0x3dc) and EyeHeight (+0x3f4), asks the level for up to five line checks (ULevel::SingleLineCheck,
 * vtable +0xc0: Hit, Source, End, Start, flags 6, extent, extra 0) and returns the pitch it eases towards: 0x1518 when stairs rise
 * ahead, -5000 (0xffffec78) when they fall, else the current pitch kept on its side of zero, blended by min(1, k * DeltaTime).
 *
 * Every float is the exec's float32 store; the sums and products that stay on the x87 stack between stores are carried as 80-bit
 * values (script-vm.mjs x87 helpers), each fstp rounding once, and the pitch blend ends in the shipped _ftol (truncation). The
 * look direction is the X axis of GMath.UnitCoords /= FRotator(0, Yaw, Roll) (Core FCoords::operator/=), which getAxes
 * (camera.mjs, Core execGetAxes) computes. `Hit` (FCheckResult, Time at +0x24) starts at Time 1.0; the level's SingleLineCheck
 * leaves Time 1.0 on a clear trace (line-filter.mjs, validated), so each call's `time` is the Hit.Time the exec reads.
 *
 * state: {location, viewRotation: [pitch, yaw, roll] (integers), eyeHeight, radius, height} (float32 values).
 * services: lineCheck(start, end, extent, flags, extra) -> {time}, setPitch(pitch) for the normalisation store.
 * Returns the int result. */
import {x87load as L, x87double as D, x87mul as M, x87add as A, x87neg as N, x87store as S, x87cmp, x87int32, x87ftol} from './script-vm.mjs';
import {getAxes} from './camera.mjs';

const f = Math.fround;
const ones = new Set(['lt', 'un']);     // C0 set: below or unordered
const orEqual = new Set(['lt', 'eq', 'un']);   // C3 or C0 set

export const STAIR_ROTATION = Object.freeze({up: 0x1518, down: -5000, noLongerThan: 0.33});

export function findStairRotation(state, deltaTime, services) {
  const dt = f(deltaTime);
  let pitch = state.viewRotation[0] | 0;
  // fcomp against the double 0.33 (0x10431428): above it the exec returns the stored pitch untouched.
  if (x87cmp(L(dt), D(0.33)) === 'gt') return pitch;
  if (pitch > 0x8000) { pitch = ((pitch & 0xffff) - 0x10000) | 0; services.setPitch(pitch); }
  const dir = getAxes([0, state.viewRotation[1] | 0, state.viewRotation[2] | 0])[0].map(f);
  const [lx, ly, lz] = state.location.map(f), eye = f(state.eyeHeight), radius = f(state.radius);
  const eyeSpot = [lx, ly, S(A(L(eye), L(lz)))];
  const h = S(A(L(f(state.height)), L(eye)));                     // CollisionHeight + EyeHeight
  const extent = [radius, radius, 1];
  const twoH = A(L(h), L(h));
  const check = (start, end, size = extent) => services.lineCheck(start, end, size, 6, 0).time;
  const sub = (a, b) => A(a, N(b));

  // Trace 1: eye level, 2h ahead.
  const first = [S(A(L(S(M(L(dir[0]), twoH))), L(eyeSpot[0]))), S(A(L(S(M(L(dir[1]), twoH))), L(eyeSpot[1]))),
    S(A(M(twoH, L(dir[2])), L(eyeSpot[2])))];
  const t1 = check(eyeSpot, first);
  const T = S(A(M(L(f(t1)), L(h)), M(L(f(t1)), L(h))));         // 2 * h * Time
  let target = 0;
  // Continue only when 0.8 * h < T (the wall is more than 0.4 of the way).
  if (ones.has(x87cmp(M(L(h), D(0.8)), L(T)))) {
    // Trace 2: from half way to the wall (h * Time along the look direction), 3h straight down.
    const half = M(L(T), D(0.5));
    const point = [S(A(L(S(M(L(dir[0]), half))), L(eyeSpot[0]))), S(A(L(S(M(L(dir[1]), half))), L(eyeSpot[1]))),
      S(A(M(half, L(dir[2])), L(eyeSpot[2])))];
    const h3 = S(M(L(h), L(3)));
    const t2 = check(point, [point[0], point[1], S(sub(L(point[2]), L(h3)))]);
    if (ones.has(x87cmp(L(f(t2)), D(1)))) {
      const floor = S(M(L(h3), L(f(t2))));                         // distance to the floor below that point
      const p07 = M(L(h), D(0.7));
      if (!orEqual.has(x87cmp(sub(p07, D(6)), L(floor)))) {
        // The floor is nearer than 0.7h - 6: the ground rises. Trace 3: from the first wall hit, 3h down.
        const along = dir.map(c => S(M(L(c), L(T))));
        const wall = [S(A(L(along[0]), L(eyeSpot[0]))), S(A(L(along[1]), L(eyeSpot[1]))), S(A(L(along[2]), L(eyeSpot[2])))];
        const t3 = check(wall, [wall[0], wall[1], S(sub(L(wall[2]), L(h3)))]);
        target = pitch > 0 ? pitch : 0;
        if (!orEqual.has(x87cmp(sub(L(floor), L(10)), M(L(h3), L(f(t3)))))) target = STAIR_ROTATION.up;
      } else if (ones.has(x87cmp(A(p07, D(6)), L(floor)))) {
        // The floor is farther than 0.7h + 6: the ground falls. Trace 4: a thin line from Location along 0.9 T.
        const k = M(L(T), D(0.9));
        const along = dir.map(c => S(M(L(c), k)));
        const reach = [S(A(L(along[0]), L(lx))), S(A(L(along[1]), L(ly))), S(A(L(along[2]), L(lz)))];
        const t4 = check([lx, ly, lz], reach, [0, 0, 0]);
        if (new Set(['eq', 'un']).has(x87cmp(L(f(t4)), D(1)))) {
          // Trace 5: from the wall hit (the products stay extended into the sums), 3h down.
          const wall = [S(A(M(L(dir[0]), L(T)), L(eyeSpot[0]))), S(A(M(L(dir[1]), L(T)), L(eyeSpot[1]))), S(A(M(L(dir[2]), L(T)), L(eyeSpot[2])))];
          const t5 = check(wall, [wall[0], wall[1], S(sub(L(wall[2]), L(h3)))]);
          target = pitch < 0 ? pitch : 0;
          if (ones.has(x87cmp(A(L(floor), L(10)), M(L(h3), L(f(t5)))))) target = STAIR_ROTATION.down;
        }
      }
    }
  }
  // Ease from the stored pitch to the target: weight min(1, (8000 / |difference|, or 8 from 1000 up) * DeltaTime).
  let difference = (pitch - target) | 0;
  if (difference < 0) difference = -difference | 0;
  if (difference <= 0) return target;
  let weight = difference < 1000 ? x87int32(Math.trunc(8000 / difference)) : L(8);
  weight = M(weight, L(dt));
  if (orEqual.has(x87cmp(L(1), weight))) weight = L(1);
  const blend = A(M(A(L(1), N(weight)), x87int32(pitch)), M(x87int32(target), weight));
  return x87ftol(blend);
}
