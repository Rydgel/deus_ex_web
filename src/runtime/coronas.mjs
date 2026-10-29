// Light coronas (docs/coronas.md): URender::DrawFrame's corona pass
// (Render.dll 0x10b1b46a-0x10b1bb06) and its visibility helper 0x10b1bc00.
// The pass runs inside the render pass, under precision control 24
// (docs/render-pass-precision.md): every arithmetic result is rounded once
// to a 24-bit significand (x87-pc24.mjs, exact for the double operands).
import { x87load, x87double, x87int32, x87store, x87cmp, setX87Precision } from './script-vm.mjs';
import { buildWindowSceneFrame } from './script-window-scene-frame.mjs';
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

// The zero extent of both checks: shared, and never written by a line check.
const NO_EXTENT = [0, 0, 0];

/** Helper 0x10b1bc00's two line checks, from the frame's Coords.Origin to the
 * light's Location: ULevel::SingleLineCheck takes (Hit, Source, End, Start,
 * TraceFlags, Extent, NodeFlags), and the helper pushes Start = `frame + 0x34`
 * (`lea edi` at 0x10b1bc43, pushed at 0x10b1bc4f) after End = the light's
 * +0x114 (`ebx`, pushed at 0x10b1bc50), before the calls at 0x10b1bc5b and
 * 0x10b1bcac: TRACE_Level|TRACE_Movers (6) must be clear, then
 * TRACE_Pawns|TRACE_Others (0x11) must be clear or hit the viewport actor.
 * `lineCheck(start, end, extent, flags, extra, source)` is level-queries.mjs
 * `lineCheck`, which takes Start first. validate-coronas.mjs compares these
 * arguments with the ones the original helper passes. */
export function coronaLineVisible(lineCheck, location, origin, viewer) {
  if (!lineCheck(origin, location, NO_EXTENT, 6, 0, null).outside) return false;
  const hit = lineCheck(origin, location, NO_EXTENT, 0x11, 0, null);
  return Boolean(hit.outside) || hit.actor === viewer;
}

/** Helper 0x10b1bc00 for one light of the camera leaf: the line checks
 * (coronaLineVisible) already decided `visible` (SingleLineCheck
 * TRACE_Level|TRACE_Movers clear, then TRACE_Pawns|TRACE_Others clear or
 * hitting the viewport actor);
 * `qualifies` is bCorona && Skin && !bDeleteMe. An existing entry gains 2Δ,
 * a new one takes the next free slot from `slot.next` at min(1, 2Δ). */
export function coronaSeen(cache, slot, light, { visible, qualifies, actorIndex, delta }) {
  if (!visible || !qualifies) return;
  seenEntry(cache, slot, light, delta, null, actorIndex);
}

/** coronaSeen for a light that passed the line checks and qualifies, with no arguments object and no closure
 * (corona-scan.mjs): a new entry's index is the light's position in `actors` (Level.Actors). */
export function coronaSeenAt(cache, slot, light, delta, actors) {
  seenEntry(cache, slot, light, delta, actors, null);
}

function seenEntry(cache, slot, light, delta, actors, actorIndex) {
  const twice = x87add(ld(delta), ld(delta)), entries = cache.entries;
  let found = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i].actor === light) { found = i; break; }
  if (found >= 0) {
    const sum = x87add(twice, ld(entries[found].brightness));
    entries[found].brightness = x87cmp(ONE, sum) === 'gt' ? st(sum) : 1;
    return;
  }
  while (slot.next < CORONA_SLOTS && entries[slot.next].actor != null) slot.next++;
  if (slot.next >= CORONA_SLOTS) return;
  entries[slot.next] = { actor: light, index: actors !== null ? actors.indexOf(light) : actorIndex(), brightness: x87cmp(ONE, twice) === 'gt' ? st(twice) : 1 };
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

const FRAME_WORDS = new Uint32Array(21), FRAME_FLOATS = new Float32Array(FRAME_WORDS.buffer);

/** The FSceneNode fields the corona pass reads from DrawFrame's frame
 * argument (Render.dll 0x10b1b7b4-0x10b1ba21: Coords +0x34 for the inline
 * TransformPointBy, Proj.Z +0xdc, FX2 +0xc8, FY2 +0xcc and X +0xa8), out of
 * the occlusion frame words (bsp-occlusion.mjs occlusionFrameWords: 0..11
 * Coords, 12 X, 16 FX2, 17 FY2, 20 Proj.Z; the master frame OccludeBsp
 * read, which DrawWorld hands to DrawFrame): `coords` {origin, x, y, z} for
 * coordsTransform and `frame` for coronaIcon. */
export function coronaFrame(words) {
  for (let k = 0; k < FRAME_WORDS.length; k++) FRAME_WORDS[k] = words[k];
  const vec = at => [FRAME_FLOATS[at], FRAME_FLOATS[at + 1], FRAME_FLOATS[at + 2]];
  return { coords: { origin: vec(0), x: vec(3), y: vec(6), z: vec(9) },
    frame: { projZ: FRAME_FLOATS[20], fx2: FRAME_FLOATS[16], fy2: FRAME_FLOATS[17], width: words[12] | 0 } };
}

/** The same fields without an OccludeBsp frame: Engine's ComputeRenderCoords
 * (game thread, 64 bits) and the render pass's ComputeRenderSize (24 bits)
 * on the render rectangle `rect` {width, height}, for the camera `view`
 * {location, rotation, fov} (script-window-scene-frame.mjs, validated
 * against the unchanged Engine code for these fields). */
export function coronaFrameFromCamera(view, rect) {
  const previous = setX87Precision(24);
  try {
    const f = buildWindowSceneFrame({ location: view.location, rotation: view.rotation.map(v => v | 0), width: rect.width,
      height: rect.height, fov: view.fov });
    const at = k => f.coords.slice(k, k + 3);
    return { coords: { origin: at(0), x: at(3), y: at(6), z: at(9) },
      frame: { projZ: f.projectionZ, fx2: f.center[0], fy2: f.center[1], width: rect.width } };
  } finally { setX87Precision(previous); }
}

/** The static lights the corona pass visits for the viewer's leaf
 * (0x10b1b6b1-0x10b1b70e): `Model.Leaves[leaf].iPermeating` indexes
 * `Model.Lights`, whose run of references ends at a null entry. The viewer's
 * LeafLights follow (0x10b1b711-0x10b1b743, dynamic-lighting.mjs
 * movingLightLeafLists), each through the same helper. */
export function leafPermeatingLights(model, leaf) {
  const start = model.leaves[leaf]?.permeating ?? -1, out = [];
  if (start < 0) return out;
  for (let i = start; i < model.lights.length && model.lights[i]; i++) out.push(model.lights[i]);
  return out;
}
