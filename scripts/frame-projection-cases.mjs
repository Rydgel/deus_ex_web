/** Oracle data for the frame-projection validators (validate-frame-projection.mjs
 * and its GPU twin): seeded cameras on a map, run through
 * scripts/native-frame-projection-oracle.py (docs/frame-projection.md). */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { bits, occlusionModelRequest, occlusionTangents, renderPassTangent, renderRectangle,
  surfaceTextureFlags as textureFlagsOf } from './occlusion-request.mjs';
import { childFrameTangent } from '../src/runtime/bsp-occlusion.mjs';

export const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
export const available = existsSync(python);
const root = gameDirectory(), files = [];
if (available)
  for (const directory of ['Maps', 'System', 'Textures'])
    for (const name of await readdir(path.join(root, directory)))
      files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const MIRRORED = 0x08000000, FAKE_BACKDROP = 0x80;
const units = r => Math.round(r * 32768 / Math.PI);
const hex64 = value => {
  const io = new DataView(new ArrayBuffer(8));
  io.setFloat64(0, value, true);
  return io.getBigUint64(0, true).toString(16).padStart(16, '0');
};

function nodeCenter(model, i) {
  const n = model.nodes[i], c = [0, 0, 0];
  for (let k = 0; k < n.vertexCount; k++) {
    const p = model.points[model.vertices[n.vertexPool + k].point];
    for (let j = 0; j < 3; j++) c[j] += p[j] / n.vertexCount;
  }
  return c;
}
function aim(eye, at, roll = 0) {
  const d = at.map((v, k) => v - eye[k]);
  return { location: eye.map(Math.fround), rotation: [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))),
    (units(Math.atan2(d[1], d[0])) + 65536) % 65536, roll] };
}

/** A seeded camera sequence on a map, cameras aimed at mirror and sky
 * polygons when `aimed`. */
export async function makeCases(mapName, { seed, count, aimed, views = [] }) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await textureFlagsOf(assets, asset, model);
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = list => list[Math.floor(random() * list.length)];
  const targets = [];
  model.nodes.forEach((n, i) => {
    const flags = (model.surfaces[n.surface].flags | textureFlags[n.surface]) >>> 0;
    if (aimed && n.vertexCount >= 3 && flags & (MIRRORED | FAKE_BACKDROP))
      targets.push({ center: nodeCenter(model, i), normal: n.plane.slice(0, 3) });
  });
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
  const sizes = [[640, 480], [1024, 768], [1440, 839], [1920, 1080], [1280, 720]];
  const cases = views.map(v => ({ location: v.location.map(Math.fround), rotation: v.rotation, width: 1280, height: 720, fov: 90 }));
  count += cases.length;
  while (cases.length < count) {
    const [width, height] = pick(sizes), fov = random() < 0.5 ? 90 : 75;
    let camera;
    if (targets.length && random() < 0.85) {
      const t = pick(targets), distance = 60 + random() * 700;
      const side = [random() - 0.5, random() - 0.5, (random() - 0.5) * 0.5];
      camera = aim(t.center.map((v, k) => v + t.normal[k] * distance + side[k] * distance), t.center,
        random() < 0.15 ? Math.floor((random() - 0.5) * 6000) : 0);
    } else {
      const p = spots.length ? pick(spots).map((v, k) => v + (k < 2 ? (random() - 0.5) * 40 : 30)) :
        [0, 1, 2].map(k => model.bounds.min[k] + random() * (model.bounds.max[k] - model.bounds.min[k]));
      camera = { location: p.map(Math.fround), rotation: [Math.floor((random() - 0.5) * 20000), Math.floor(random() * 65536), 0] };
    }
    cases.push({ ...camera, width, height, fov });
  }
  cases.forEach((c, i) => Object.assign(c, { locationBits: c.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30),
    children: aimed, d3d: true, sprites: [] }));
  cases.forEach((c, i) => { if (i % 3) c.render = renderRectangle(c.width, c.height, random, i % 3 === 1 ? 1 : 0.5); });
  const tangents = occlusionTangents();
  for (const c of cases) {
    const { argument, tangent } = childFrameTangent(c.fov, c.render?.width ?? c.width);
    tangents[hex64(argument)] = hex64(tangent);
    if (c.render) Object.assign(tangents, renderPassTangent(c.fov, c.render.width, 'validate-frame-projection'));
  }
  return { model, cases, tangents, request: occlusionModelRequest(model, textureFlags) };
}

export const run = request => JSON.parse(execFileSync(python, ['scripts/native-frame-projection-oracle.py'],
  { input: JSON.stringify({ gameRoot: root, ...request }), encoding: 'utf8', maxBuffer: 1 << 30 }));

/** A frame's rectangle: the render pass' (X, Y, XB, YB) or the viewport. */
export const rectOf = c => c.render ? { width: c.render.width, height: c.render.height, x: c.render.x, y: c.render.y }
  : { width: c.width, height: c.height, x: 0, y: 0 };

/** The oracle's draw lists (main frame and child frames) for a seeded camera
 * sequence: `{ model, cases, results }`. */
export async function bspOracle(mapName, options) {
  const { model, cases, tangents, request } = await makeCases(mapName, options);
  return { model, cases, results: run({ tangents, cases, model: request }).results };
}

/** The oracle's mesh vertices: camera-space points projected in each case's
 * frame: `{ cases, results }`. */
export async function meshOracle(mapName, { seed, count, points = 160 }) {
  const { cases, tangents, request } = await makeCases(mapName, { seed, count, aimed: false });
  let state = seed * 7 >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const projection = cases.map(c => ({ ...c, d3d: false, pointBits: Array.from({ length: points }, () => {
    // Mostly in front of the camera, a few behind and off to the sides.
    const z = random() < 0.9 ? Math.fround(1 + random() * 3000) : Math.fround((random() - 0.4) * 400);
    const spread = Math.abs(z) * 1.6 + 40;
    return [bits(Math.fround((random() - 0.5) * 2 * spread)), bits(Math.fround((random() - 0.5) * 2 * spread * 0.7)), bits(z)];
  }) }));
  return { cases: projection, results: run({ tangents, cases: [], projection, model: request }).projection };
}
