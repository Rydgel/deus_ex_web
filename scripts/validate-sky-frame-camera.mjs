/** A sky child frame's camera from its own Coords (docs/bsp-occlusion.md
 * "Child frames", mirror-passes.mjs `skyFrameCamera`): the world turn the
 * sky request applied (Render.dll 0x10b184b1..0x10b187d1, the SkyZone's
 * roll, pitch and yaw over the parent's Coords) read back from the parent's
 * and the sky frame's axes must equal the rotator form the root sky frame
 * draws with (the SkyZone's Rotation applied after the parent's view), for
 * every sky frame the Rust OccludeBsp makes: in the root frame and inside
 * mirror frames, on real SkyZones and on random rotations.
 *
 * The parent camera is random (rotation or reflection, as a mirror frame's
 * is); the sky camera's origin must be the SkyZone's Location exactly, which
 * the frame's own origin carries.
 *
 *   node scripts/validate-sky-frame-camera.mjs [map ...] */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { pointZone } from '../src/unreal/lighting.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { skyFrameCamera } from '../src/viewer/mirror-passes.mjs';
import { rotatorEuler } from '../src/viewer/play-camera.mjs';
import { toView } from '../src/unreal/geometry.mjs';
import { surfaceTextureFlags } from './occlusion-request.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-sky-frame-camera: no installed game data'); process.exit(0); }
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const MIRRORED = 0x08000000, FAKE_BACKDROP = 0x80;
const units = r => Math.round(r * 32768 / Math.PI);
const floats = words => Array.from(new Float32Array(Uint32Array.from(words).buffer));

let state = 1;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = list => list[Math.floor(random() * list.length)];

/** The root sky frame's form, kept here as the reference: the SkyZone's
 * rotator turned onto the parent's world rotation, at the SkyZone's Location. */
function rotatorForm(parent, sky) {
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
  camera.matrixWorld.multiplyMatrices(new THREE.Matrix4().makeRotationFromEuler(rotatorEuler(sky.rotation)),
    new THREE.Matrix4().extractRotation(parent.matrixWorld)).setPosition(...toView(sky.location));
  return camera;
}
/** A camera whose world matrix is a random rotation, a reflection of one
 * (a mirror frame's), at a random position. */
function randomParent(reflect) {
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = camera.matrixWorldAutoUpdate = false;
  camera.matrixWorld.makeRotationFromEuler(new THREE.Euler((random() - 0.5) * 3, (random() - 0.5) * 6, (random() - 0.5) * 2, 'YXZ'));
  if (reflect) camera.matrixWorld.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  camera.matrixWorld.setPosition((random() - 0.5) * 4000, (random() - 0.5) * 4000, (random() - 0.5) * 4000);
  return camera;
}

async function validate(mapName, seed) {
  state = seed;
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await surfaceTextureFlags(assets, asset, model);
  const skies = map.actors.filter(a => a.className === 'SkyZoneInfo' && a.values.Location);
  const skyActor = skies.filter(a => a.values.bHighDetail).at(-1) ?? skies.at(-1) ?? null;
  assert.ok(skyActor, `${mapName} has a SkyZoneInfo`);
  const real = { location: skyActor.values.Location.map(Math.fround), rotation: (skyActor.values.Rotation ?? [0, 0, 0]).map(v => v | 0),
    zone: pointZone(model, skyActor.values.Location) };
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: textureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const targets = [];
  model.nodes.forEach((n, i) => {
    const flags = (model.surfaces.at(n.surface).flags | textureFlags[n.surface]) >>> 0;
    if (n.vertexCount < 3 || !(flags & (MIRRORED | FAKE_BACKDROP))) return;
    const c = [0, 0, 0];
    for (let k = 0; k < n.vertexCount; k++) {
      const p = model.points.at(model.vertices.at(n.vertexPool + k).point);
      for (let j = 0; j < 3; j++) c[j] += p[j] / n.vertexCount;
    }
    targets.push({ center: c, normal: n.plane.slice(0, 3), mirror: Boolean(flags & MIRRORED) });
  });
  const stats = { cases: 0, root: 0, nested: 0, rotated: 0, worst: 0, siblings: 0 };
  try {
    for (const variant of ['real', 'rotated']) {
      for (let i = 0; i < 40; i++) {
        // A random SkyZone rotation (every other case in the second round).
        const sky = variant === 'real' ? real : { ...real, rotation: [0, 1, 2].map(() => Math.floor((random() - 0.5) * 65536)) };
        occlusion.setZoneSkies(model.zones.map(() => sky));
        const t = pick(targets), distance = 60 + random() * 700, side = [random() - 0.5, random() - 0.5, (random() - 0.5) * 0.5];
        const eye = t.center.map((v, k) => v + t.normal[k] * distance + side[k] * distance), d = t.center.map((v, k) => v - eye[k]);
        const view = { location: eye.map(Math.fround), rotation: [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))),
          (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0] };
        const master = occlusion.master({ ...view, width: 1280, height: 720, fov: 90, render: null });
        const words = [...master.frame];
        words[44] = stats.cases + 1; words[45] = 0;
        words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES; words[47] = 0;
        const result = occlusion.run(words, [], { children: { fov: 90, orthoZoom: 0 } });
        stats.cases++;
        // Parents holding several sky frames (different sky surfaces).
        const perParent = new Map();
        for (const frame of result.frames) if (frame.kind === 'sky') perParent.set(frame.parent, (perParent.get(frame.parent) ?? 0) + 1);
        for (const count of perParent.values()) if (count > 1) stats.siblings++;
        for (const frame of result.frames) {
          if (frame.kind !== 'sky') continue;
          const parentCoords = frame.parent === 0 ? floats(master.frame.slice(0, 12))
            : floats(result.frames.find(f => f.index === frame.parent).fields.slice(0, 12));
          const parent = randomParent(frame.parent !== 0 || random() < 0.5), coords = floats(frame.fields.slice(0, 12));
          const got = skyFrameCamera(parent, parentCoords, coords).matrixWorld.elements;
          const want = rotatorForm(parent, sky).matrixWorld.elements;
          // The camera's origin is the SkyZone's Location, from the frame's own Coords.
          assert.deepEqual(coords.slice(0, 3), sky.location, `${mapName} case ${i}: sky frame origin`);
          let worst = 0;
          for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(got[k] - want[k]));
          assert.ok(worst < 2e-3, `${mapName} ${variant} case ${i} frame ${frame.index}: camera differs by ${worst}\n got ${got}\nwant ${want}`);
          stats.worst = Math.max(stats.worst, worst);
          stats[frame.parent === 0 ? 'root' : 'nested']++;
          if (variant === 'rotated') stats.rotated++;
        }
      }
    }
  } finally { occlusion.dispose(); }
  console.log(`${mapName}: ${stats.cases} cases, ${stats.root} root and ${stats.nested} nested sky frames (${stats.rotated} on random rotations, ${stats.siblings} parents with several), ` +
    `real rotation ${JSON.stringify(real.rotation)}, worst element difference ${stats.worst.toExponential(2)}`);
  return stats;
}

const only = new Set(process.argv.slice(2));
const maps = [['00_Training', 3], ['01_NYC_UNATCOIsland', 5], ['03_NYC_UNATCOIsland', 7], ['02_NYC_Smug', 9], ['11_Paris_Everett', 11]];
let nested = 0;
for (const [map, seed] of maps) if (!only.size || only.has(map)) nested += (await validate(map, seed)).nested;
assert.ok(only.size || nested > 0, 'some sky frame was made inside a mirror frame');
console.log('validate-sky-frame-camera: ok');
