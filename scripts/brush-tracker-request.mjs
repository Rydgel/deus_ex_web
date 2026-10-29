/** Requests for scripts/native-brush-tracker-oracle.py and the Rust port
 * (validate-brush-tracker.mjs): a map's level model, every non-static
 * brush with its class lineage, merged defaults and brush polygons, and the
 * cases' position specs (scripts/brush-tracker-cases.json). */
import { execFileSync } from 'node:child_process';
import { decodeMap } from '../src/unreal/map.mjs';
import { collectTrackerMovers, scaleWords } from '../src/runtime/brush-tracker.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const bits = v => (f32[0] = v, u32[0]);
const fround = Math.fround;

/** The oracle's `model` and `actors` for a map, plus each mover's key
 * positions for the position specs. */
export async function buildMap(assets, mapName) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), m = map.model;
  const textureKeys = new Map();
  const textureKey = ref => {
    if (!ref) return null;
    if (!textureKeys.has(ref)) textureKeys.set(ref, textureKeys.size);
    return textureKeys.get(ref);
  };
  const model = {
    nodes: m.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
      surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
      renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
    verts: m.vertices.map(v => [v.point, v.side]), pointBits: m.points.map(p => p.map(bits)),
    vectorBits: m.vectors.map(p => p.map(bits)), leafHulls: Array.from(m.leafHulls),
    surfs: m.surfaces.map(s => ({ texture: textureKey(s.texture), flags: s.flags >>> 0, base: s.base, normal: s.normal,
      textureU: s.textureU, textureV: s.textureV, lightMap: s.lightMap, brushPoly: s.brushPolygon, pan: s.pan })),
  };
  const actors = [], movers = {};
  for (const { name, classes, values: v, polys } of await collectTrackerMovers(assets, asset, map)) {
    const location = v.Location ?? [0, 0, 0], rotation = v.Rotation ?? [0, 0, 0];
    actors.push({ name, classes, flags: ((v.bStatic ? 1 : 0) | (v.bHidden ? 2 : 0)) >>> 0,
      specialLit: Boolean(v.bSpecialLit), locationBits: location.map(bits), rotation,
      prePivotBits: (v.PrePivot ?? [0, 0, 0]).map(bits), mainScale: scaleWords(v.MainScale), postScale: scaleWords(v.PostScale),
      brush: { polys: polys.map(p => ({ baseBits: p.base.map(bits), normalBits: p.normal.map(bits),
        textureUBits: p.textureU.map(bits), textureVBits: p.textureV.map(bits), vertexBits: p.vertices.map(x => x.map(bits)),
        flags: p.flags >>> 0, texture: textureKey(p.texture), iBrushPoly: p.brushPolygon, pan: p.pan })) } });
    const key = i => v[`KeyPos[${i}]`] ?? (i === 0 ? v.KeyPos : undefined) ?? [0, 0, 0];
    const keyRot = i => v[`KeyRot[${i}]`] ?? (i === 0 ? v.KeyRot : undefined) ?? [0, 0, 0];
    movers[name] = { basePos: v.BasePos ?? location, baseRot: v.BaseRot ?? rotation, key, keyRot,
      location, rotation, polys: polys.length };
  }
  return { map, model, actors, movers, textures: [...textureKeys.keys()] };
}

/** A position spec: {key: k} (BasePos + KeyPos[k], BaseRot + KeyRot[k]),
 * {from, to, alpha} (key interpolation in float32, rotation rounded),
 * {offset: [dx, dy, dz], addRotation} added to the placed position,
 * {hidden}, or {locationBits, rotation} verbatim. */
export function position(mover, spec) {
  if (spec.locationBits) return { locationBits: spec.locationBits, rotation: spec.rotation ?? mover.rotation };
  let location = mover.location.map(fround), rotation = [...mover.rotation];
  if (spec.key !== undefined || spec.alpha !== undefined) {
    const k0 = spec.key ?? spec.from ?? 0, k1 = spec.to ?? k0, alpha = fround(spec.alpha ?? 0);
    const p0 = mover.key(k0), p1 = mover.key(k1), r0 = mover.keyRot(k0), r1 = mover.keyRot(k1);
    location = [0, 1, 2].map(i => fround(fround(mover.basePos[i]) + fround(fround(p0[i]) + fround(fround(fround(p1[i]) - fround(p0[i])) * alpha))));
    rotation = [0, 1, 2].map(i => (mover.baseRot[i] + r0[i] + Math.round((r1[i] - r0[i]) * alpha)) | 0);
  }
  if (spec.offset) location = location.map((x, i) => fround(x + fround(spec.offset[i])));
  if (spec.addRotation) rotation = rotation.map((x, i) => (x + spec.addRotation[i]) | 0);
  const out = { locationBits: location.map(bits), rotation };
  if (spec.hidden !== undefined) out.hidden = spec.hidden;
  return out;
}

/** A case's movers and expanded steps ('cycle' steps become brief frames). */
export function caseRequest(built, c) {
  const actors = c.movers ? built.actors.filter(a => c.movers.includes(a.name)) : built.actors;
  const expanded = c.steps.flatMap(s => s.op !== 'cycle' ? [s] : Array.from({ length: s.count }, (_, i) =>
    ({ op: s.update ?? 'frame', ...(s.actor !== undefined ? { actor: s.actor } : {}), brief: s.brief ?? true,
      set: { [s.mover]: s.positions[i % s.positions.length] } })));
  const steps = expanded.map(s => {
    const out = { ...s };
    if (s.set) out.set = Object.fromEntries(Object.entries(s.set).map(([k, v]) => [k, position(built.movers[k], v)]));
    return out;
  });
  return { actors, steps, fillers: c.fillers ?? [] };
}

export function runOracle(python, root, request) {
  const text = execFileSync(python, ['scripts/native-brush-tracker-oracle.py'],
    { input: JSON.stringify({ gameRoot: root, ...request }), encoding: 'utf8', maxBuffer: 1 << 30 });
  return JSON.parse(text);
}
