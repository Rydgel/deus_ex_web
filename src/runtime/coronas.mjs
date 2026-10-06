// Light coronas (docs/coronas.md): URender::DrawFrame's corona pass
// (Render.dll 0x10b1b46a-0x10b1bb06) and its visibility helper 0x10b1bc00.
// The pass runs inside the render pass, under precision control 24
// (docs/render-pass-precision.md): every arithmetic result is rounded once
// to a 24-bit significand (x87-pc24.mjs, exact for the double operands).
import { x87load, x87double, x87int32, x87store, x87cmp } from './script-vm.mjs';
import { p24mul as x87mul, p24add as x87add, p24div as x87div, p24sub as sub } from './x87-pc24.mjs';

const ld = x87load, st = x87store;
const io = new DataView(new ArrayBuffer(4));
const num = bits => (io.setUint32(0, bits >>> 0, true), io.getFloat32(0, true));
// Render.dll constants: 1/85 (0x10b2b2e4), 1/84 (0x10b2b2e0), saturation
// 1/255 (double 0x10b2a930), fade 3.0 (double 0x10b2a890), size 0.2
// (0x10b2b2dc), half 0.5 (0x10b2a5c8), 1.0 (0x10b2a5b0 / double 0x10b2a610).
const K85 = ld(num(0x3c40c0c1)), K84 = ld(num(0x3c430c31)), SATURATION = x87double(1 / 255);
const FADE = x87double(3), SIZE = ld(num(0x3e4ccccd)), HALF = ld(0.5), ONE = ld(1), ZERO = ld(0), ONE_D = x87double(1);
export const CORONA_SLOTS = 32;

/** A fresh corona cache item (GCache id 0x27, 32 × {Actor, index,
 * brightness}, zeroed on creation) with the pass's clock. */
export const createCoronaCache = () => ({
  entries: Array.from({ length: CORONA_SLOTS }, () => ({ actor: null, index: 0, brightness: 0 })), last: null,
});

/** The pass's first steps: Δ = (now − last)·3 from the host clock
 * (appSeconds; the first pass starts the clock), then every live entry
 * fades by Δ and frees its slot once below 0. Returns Δ (float32). */
export function coronaDecay(cache, now) {
  if (cache.last === null) cache.last = now;
  const delta = st(x87mul(sub(x87double(now), x87double(cache.last)), FADE));
  cache.last = now;
  coronaFade(cache, delta);
  return delta;
}

/** The fade loop 0x10b1b682-0x10b1b6b1: FST keeps the difference, which
 * FCOMPs against 0.0; a negative entry frees its slot. */
export function coronaFade(cache, delta) {
  for (const entry of cache.entries) {
    if (entry.actor == null) continue;
    const faded = sub(ld(entry.brightness), ld(delta));
    entry.brightness = st(faded);
    if (x87cmp(faded, ZERO) === 'lt' || x87cmp(faded, ZERO) === 'un') entry.actor = null;
  }
}

/** Helper 0x10b1bc00 for one light of the camera leaf: the line checks
 * already decided `visible` (SingleLineCheck TRACE_Level|TRACE_Movers
 * clear, then TRACE_Pawns|TRACE_Others clear or hitting the viewport actor);
 * `qualifies` is bCorona && Skin && !bDeleteMe. An existing entry gains 2Δ,
 * a new one takes the next free slot from `slot.next` at min(1, 2Δ). */
export function coronaSeen(cache, slot, light, { visible, qualifies, actorIndex, delta }) {
  if (!visible || !qualifies) return;
  const twice = x87add(ld(delta), ld(delta)), entries = cache.entries;
  const found = entries.findIndex(entry => entry.actor === light);
  if (found >= 0) {
    const sum = x87add(twice, ld(entries[found].brightness));
    entries[found].brightness = x87cmp(ONE, sum) === 'gt' ? st(sum) : 1;
    return;
  }
  while (slot.next < CORONA_SLOTS && entries[slot.next].actor != null) slot.next++;
  if (slot.next >= CORONA_SLOTS) return;
  entries[slot.next] = { actor: light, index: actorIndex(), brightness: x87cmp(ONE, twice) === 'gt' ? st(twice) : 1 };
}

/** The corona colour from LightHue and LightSaturation (0x10b1b84f-
 * 0x10b1b9c9): three 85-wide hue sectors (the last blue term over 84),
 * then each channel blended toward 1 by Saturation/255. */
export function coronaColor(hue, saturation) {
  hue &= 255;
  let c;
  if (hue < 0x56) c = [st(x87mul(x87int32(0x55 - hue), K85)), st(x87mul(x87int32(hue), K85)), 0];
  else if (hue < 0xab) c = [0, st(x87mul(x87int32(0xaa - hue), K85)), st(x87mul(x87int32(hue - 0x55), K85))];
  else c = [st(x87mul(x87int32(hue - 0xaa), K85)), 0, st(x87mul(x87int32(0xff - hue), K84))];
  // FLD1/FSUB per channel: Z's (1 − Z) stays on the stack for its FMUL by
  // s, X's and Y's are stored to float32 first (0x10b1b961-0x10b1b994).
  const s = x87mul(x87int32(saturation & 255), SATURATION);
  const t = [st(x87mul(ld(st(sub(ONE, ld(c[0])))), s)), st(x87mul(ld(st(sub(ONE, ld(c[1])))), s)),
    st(x87mul(sub(ONE, ld(c[2])), s))];
  return c.map((v, i) => st(x87add(ld(v), ld(t[i]))));
}

/** One live entry's DrawIcon (0x10b1b7b4-0x10b1baea): `camera` is the
 * light's Location in frame space (TransformPointBy of the frame coords),
 * `frame` {projZ (+0xdc), fx2 (+0xc8), fy2 (+0xcc), width (+0xa8)}. Null
 * when the light is not beyond z = 1. Returns the icon's top-left corner,
 * square size and colour (brightness · colour; the canvas tile is drawn
 * with PolyFlags 0x104, Z 1.0 and no fog). */
export function coronaIcon(entry, camera, frame, { hue, saturation, drawScale }) {
  const [px, py, pz] = camera;
  const depth = x87cmp(ld(pz), ONE_D);
  if (depth !== 'gt') return null;
  const color = coronaColor(hue, saturation).map(v => st(x87mul(ld(entry.brightness), ld(v))));
  const persp = x87div(ld(frame.projZ), ld(pz));
  const x = st(x87add(x87mul(persp, ld(px)), ld(frame.fx2)));
  const y = st(x87add(x87mul(persp, ld(py)), ld(frame.fy2)));
  const size = st(x87mul(x87mul(x87int32(frame.width | 0), ld(drawScale)), SIZE));
  const half = x87mul(ld(size), HALF);
  return { x: st(sub(ld(x), half)), y: st(sub(ld(y), half)), size, color, polyFlags: 0x104 };
}
