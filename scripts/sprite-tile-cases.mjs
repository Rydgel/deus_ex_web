/** Oracle data for the sprite tile validators (validate-sprite-tiles.mjs,
 * docs/frame-projection.md "Sprites"): seeded cameras on a map, each with
 * sprite actors in front of it, run through scripts/native-sprite-draw-oracle.py
 * (the unchanged FDynamicSprite constructor and Setup, OccludeBsp, then
 * DrawActorSprite -> UCanvas::DrawIcon -> UCanvas::DrawTile ->
 * UD3DRenderDevice::DrawTile for every sprite of every frame).
 *
 * The sprites are the runtime particle items Play's scan finds on the map
 * (ParticleProxy: the map's own DT_Sprite actors are bHidden editor icons) and
 * synthetic ones placed around each camera: mostly in the view, some across
 * its edges, in front of the near plane (Persp in the thousands, tiles far
 * larger than the frame) and behind it, with the texture sizes of the real
 * ones and a few others, DrawScale 0.02..6, Style 1..4 and ScaleGlow. */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createSimSession } from '../src/viewer/sim-session.mjs';
import { bits } from './occlusion-request.mjs';
import { makeCases, python } from './frame-projection-cases.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
export const assets = new AssetStore(files);
const f = Math.fround;

/** A texture's fixture fields: UTexture::Lock's UScale at LOD 0 is Scale (the property is named DrawScale in the packages). */
async function textureSpec(reference) {
  const asset = await assets.get(reference.package), values = readTexture(asset, reference.index).values;
  return { key: reference.key ?? `${reference.package}:${reference.index}`, usize: values.USize, vsize: values.VSize,
    scaleBits: bits(f(values.DrawScale ?? values.Scale ?? 1)), polyFlags: texturePolyFlags(values) };
}

/** The runtime sprite items the map shows after `ticks` Play ticks (Play's sprite scan with its render iterators). */
export async function mapSprites(mapName, ticks = 90) {
  const asset = await assets.get(mapName);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
  const sim = createSimSession(game, { assets });
  for (let i = 0; i < ticks; i++) { game.tick(1 / 60); sim.sprites(); }
  const scanned = sim.sprites(), view = game.view();
  return { sprites: scanned.sprites, errors: scanned.errors, view: { location: view.location.map(f), rotation: [...view.rotation], fov: view.fov } };
}

/** Sprite actors for one camera. `axes` are the camera's forward, right, up in world space. */
function placeSprites(random, camera, textures, real, count) {
  const pick = list => list[Math.floor(random() * list.length)];
  const yaw = camera.rotation[1] * Math.PI / 32768, pitch = camera.rotation[0] * Math.PI / 32768;
  const forward = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const right = [-Math.sin(yaw), Math.cos(yaw), 0];
  const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  const sprites = real.map(record => ({ real: true, texture: record.textureIndex, location: record.location, drawScale: record.drawScale,
    scaleGlow: record.scaleGlow, style: record.style }));
  for (let i = 0; i < count; i++) {
    const kind = random();
    // Depth: mostly in front of the view, some at the near plane and a few behind the camera.
    const depth = kind < 0.08 ? pick([1.0001, 1.001, 1.01, 1.5, 2, 3, 8]) : kind < 0.12 ? pick([0.5, 0.009, -0.004, -3, 0]) : 10 + random() * (kind < 0.7 ? 900 : 4000);
    // Across the view and past its edges.
    const u = (random() - 0.5) * 2.5, v = (random() - 0.5) * 1.9;
    const edge = random() < 0.2;
    const a = (edge ? pick([-1, 1]) * (0.85 + random() * 0.25) : u) * Math.abs(depth) * 0.9;
    const b = (edge ? (random() - 0.5) * 2 : v) * Math.abs(depth) * 0.6;
    sprites.push({ real: false, texture: Math.floor(random() * textures.length),
      location: [0, 1, 2].map(k => f(camera.location[k] + a * right[k] + b * up[k] + depth * forward[k])),
      drawScale: f(pick([0.02, 0.1, 0.25, 0.5, 1, 1, 1.5, 2, 3.5, 6, 0.01 + random() * 3])),
      scaleGlow: f(pick([1, 1, 1, 0.5, 0.2, 2, 0])), style: pick([1, 2, 3, 3, 4]) });
  }
  return sprites;
}

/** Oracle results for `count` seeded cameras on `mapName` (`aimed`: at mirrors, for child frames). */
export async function spriteTileOracle(mapName, { seed, count, aimed = true, perCamera = 40, ticks = 90, extraTextures = [] }) {
  const { sprites: records, view } = await mapSprites(mapName, ticks);
  const { model, cases, tangents, request } = await makeCases(mapName, { seed, count, aimed, views: [view] });
  // Textures: the real sprites' first, then a spread of sizes and scales.
  const textures = [], index = new Map();
  for (const record of records) {
    const key = record.texture.key ?? `${record.texture.package}:${record.texture.index}`;
    if (!index.has(key)) { index.set(key, textures.length); textures.push(await textureSpec(record.texture)); }
    record.textureIndex = index.get(key);
  }
  for (const [usize, vsize, scale] of [[64, 64, 1], [128, 128, 1], [32, 64, 1], [256, 128, 0.5], [16, 16, 2], [1, 1, 1], [8, 128, 1], [512, 512, 1]])
    textures.push({ key: `synthetic ${usize}x${vsize} x${scale}`, usize, vsize, scaleBits: bits(f(scale)), polyFlags: 0 });
  for (const extra of extraTextures) textures.push(extra);
  let state = (seed * 2654435761) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const real = records.slice(0, 24).map(record => ({ ...record, drawScale: f(record.drawScale), scaleGlow: f(record.scaleGlow),
    location: record.location.map(f) }));
  const placed = cases.map(c => placeSprites(random, c, textures, c === cases[0] ? real : [], perCamera));
  const oracleCases = cases.map((c, i) => ({ ...c, d3d: false, children: true, draw: true,
    sprites: placed[i].map(s => ({ actor: { locationBits: s.location.map(bits), rotation: [0, 0, 0], drawType: 1, texture: s.texture,
      drawScaleBits: bits(s.drawScale), scaleGlowBits: bits(s.scaleGlow), style: s.style,
      flags194: random() < 0.15 ? 2 : 0, flags15c: 0 } })) }));
  const result = JSON.parse(execFileSync(python, ['scripts/native-sprite-draw-oracle.py'],
    { input: JSON.stringify({ gameRoot: root, tangents, model: request, textures, cases: oracleCases, d3d: { colorBits: 32 } }),
      encoding: 'utf8', maxBuffer: 1 << 30 }));
  return { model, cases: oracleCases, placed, textures, results: result.results, uvScale: result.uvScale, view, records };
}
