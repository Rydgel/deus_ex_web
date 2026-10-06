import {x87load, x87double, x87add, x87neg, x87div, x87cmp, x87store, x87ftol, x87int32} from './script-vm.mjs';
import {p24add, p24mul} from './x87-pc24.mjs';

/** Engine.dll UTexture animation (docs/texture-animation.md): Update
 * 0x103ecb70, Tick 0x103ed0d0, ConstantTimeTick 0x103ed330 and Get
 * 0x103212e0. A record with its own `constantTimeTick` (a procedural texture
 * whose class overrides the virtual, e.g. UFireTexture) runs that instead of
 * the AnimNext step; Tick itself is UTexture's for them too.
 *
 * `texture` is a host record: `animNext` (the serialized AnimNext record or
 * null), `primeCount` (byte), `minFrameRate`/`maxFrameRate` (float32) and the
 * transient native state the original keeps in the object: `animCur`
 * (+0x90), `primeCurrent` (+0x95), `accumulator` (+0xa0, float32) and
 * `lastUpdateTime` (UBitmap +0x4c, double; zero after construction). */
const ZERO = x87double(0), ONE = x87load(1), LOW = x87load(0.009999999776482582), HIGH = x87load(100);

/** 0x103ed330: AnimCur starts at the texture itself and follows AnimNext,
 * wrapping to the texture at the end of the chain. */
export function constantTimeTick(texture) {
  if (!texture.animCur) texture.animCur = texture;
  texture.animCur = texture.animCur.animNext ?? null;
  if (!texture.animCur) texture.animCur = texture;
}

// 1 / Clamp(rate, 0.01f, 100.f), stored float (fcom C0: below or unordered).
function frameTime(rate) {
  let value = x87load(rate);
  if (x87cmp(value, LOW) === 'lt' || x87cmp(value, LOW) === 'un') value = LOW;
  else if (x87cmp(value, HIGH) !== 'lt') value = HIGH;
  return x87load(x87store(x87div(ONE, value)));
}

/** 0x103ed0d0, Tick(DeltaSeconds) for a plain UTexture. */
export function tick(texture, deltaSeconds) {
  const step = texture.constantTimeTick ?? constantTimeTick;
  while ((texture.primeCurrent & 255) < (texture.primeCount & 255)) {
    texture.primeCurrent = (texture.primeCurrent + 1) & 255;
    step(texture);
  }
  const max = x87load(texture.maxFrameRate);
  const zero = x87cmp(max, ZERO);
  if (zero === 'eq' || zero === 'un') { step(texture); return; }
  const minTime = frameTime(texture.maxFrameRate), maxTime = frameTime(texture.minFrameRate);
  // The sum is compared before its float store (fcom, then fst).
  const sum = x87add(x87load(deltaSeconds), x87load(texture.accumulator));
  texture.accumulator = x87store(sum);
  const againstMin = x87cmp(sum, minTime);
  if (againstMin === 'lt' || againstMin === 'un') return;
  const againstMax = x87cmp(sum, maxTime);
  step(texture);
  if (againstMax === 'lt' || againstMax === 'un') { texture.accumulator = 0; return; }
  const rest = x87add(x87load(texture.accumulator), x87neg(maxTime));
  texture.accumulator = x87store(rest);
  const capped = x87cmp(rest, maxTime);
  if (capped === 'gt') texture.accumulator = x87store(maxTime);
}

/** 0x103ecb70, Update(Time): once per distinct time, Tick with the float
 * difference from the last update (Time is the viewport's CurrentTime). */
export function update(texture, time) {
  const now = x87double(time), last = x87double(texture.lastUpdateTime ?? 0);
  // fcomp qword; C3 is set for equal and for unordered.
  const same = x87cmp(now, last);
  if (same === 'eq' || same === 'un') return;
  // (The bRealtime -> bRealtimeChanged flag write only concerns procedural
  // uploads.) The difference is stored as the float argument.
  tick(texture, x87store(x87add(now, x87neg(last))));
  texture.lastUpdateTime = time;
}

/** 0x103212e0, Get(Time): Update, then the current frame (AnimCur or the
 * texture itself). */
export function get(texture, time) {
  update(texture, time);
  return texture.animCur ?? texture;
}

const PAN_RATE = x87load(35), PAN_SCALE = x87double(256), PAN_UNIT = x87double(1 / 256);

/** Render.dll's auto-pan in the BSP surface pass (0x10b1a59a-0x10b1a72a):
 * under PF_AutoUPan (0x200) the float PanU becomes
 * `f32(Surf.PanU + (ftol(Zone.TexUPanSpeed · Level.TimeSeconds · 35f · 256.0)
 * & 0x3ffff) · (1/256))`, and the same for V with TexVPanSpeed under
 * PF_AutoVPan (0x400). `zone` is the draw list's zone actor (the node's zone
 * on the viewer's side, or the LevelInfo). Returns the float pans.
 *
 * DrawFrame runs inside the render pass, so each FMUL and the FADD round to
 * 24 bits (x87 precision control 24, docs/render-pass-precision.md) with the
 * register's wide exponent; _ftol truncates that register value. */
export function surfacePan({panU, panV, flags, speedU, speedV, timeSeconds}) {
  const pan = (base, speed) => {
    const product = p24mul(p24mul(p24mul(x87load(speed), x87load(timeSeconds)), PAN_RATE), PAN_SCALE);
    return x87store(p24add(p24mul(x87int32(x87ftol(product) & 0x3ffff), PAN_UNIT), x87load(base)));
  };
  return {
    u: flags & 0x200 ? pan(Math.fround(panU), speedU) : Math.fround(panU),
    v: flags & 0x400 ? pan(Math.fround(panV), speedV) : Math.fround(panV),
  };
}
