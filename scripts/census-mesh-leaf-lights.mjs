/** What the corrected LeafLights change in Play's mesh lighting (docs/coronas.md
 * "Leaf lights", docs/mesh-lighting.md): on the Island and the Paris club, at
 * seeded views, every LOD-mesh actor within reach is lit by SetupForActor twice
 * on identical light managers, once from the leaf lists mesh-lighting-view
 * built before (movingLightLeaves, each light prepended to every leaf it
 * reaches, no ViewPlanes test) and once from the lists it builds now
 * (SetupDynamics' gate and the master frame's ViewPlanes, Filter's hop-parity
 * order). Counts the lights whose leaf lists differ (as sets and as orders), the
 * actors whose own leaf's list differs, and the actors whose chosen lights or
 * colours differ.
 *
 *   node scripts/census-mesh-leaf-lights.mjs [views per map] */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createMeshLightingView } from '../src/viewer/mesh-lighting-view.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { movingLightLeaves, worldLightRadius } from '../src/runtime/dynamic-lighting.mjs';
import { surfaceTextureFlags, renderPassTangent } from './occlusion-request.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const views = Number(process.argv[2] ?? 8);
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const f = Math.fround, io = new DataView(new ArrayBuffer(4));
const u32 = value => (io.setFloat32(0, value, true), io.getUint32(0, true));

async function census(mapName, seed) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
  const game = await createGame(map, asset, assets, { randomSeed: 1 });
  createPlayerInputFixture(game, { tickSeconds: 1 / 120 }).tick(30);
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch { return undefined; } };
  const exportIndexByName = new Map(asset.pkg.exports.map((entry, i) => [entry.name, i + 1]));
  const options = { exportName: ref => exportAt(asset.pkg, ref)?.name, exportIndex: name => exportIndexByName.get(name) };
  const occlusion = createBspOcclusion(kernel, map.model, { surfaceTextureFlags: await surfaceTextureFlags(assets, asset, map.model),
    zoneActors: map.model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const before = createMeshLightingView(runtime, () => runtime.levelFor(player), options);
  const after = createMeshLightingView(runtime, () => runtime.levelFor(player), options);
  const level = runtime.levelFor(player), model = level.model;
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
  const actors = level.actors.filter(a => a && a !== player && read(a, 'Mesh')?.kind === 'LodMesh' && !read(a, 'bHidden') && !read(a, 'bDeleteMe'));
  const total = { views: 0, candidates: 0, outsidePlanes: 0, lists: 0, listsDiffer: 0, orderOnly: 0, actors: 0, leafListDiffers: 0,
    chosenDiffers: 0, colorsDiffer: 0 };
  for (let v = 0; v < views; v++) {
    const eye = spots[Math.floor(random() * spots.length)].map((c, k) => c + (k === 2 ? 40 : 0));
    const rotation = [Math.floor((random() - 0.5) * 6000), Math.floor(random() * 65536), 0], fov = 75;
    const [vw, vh] = [1440, 960];
    renderPassTangent(fov, vw, 'census-mesh-leaf-lights');
    const master = occlusion.master({ location: eye.map(f), rotation, width: vw, height: vh, fov, render: { width: vw, height: vh } });
    const frame = { words: Array.from(master.frame), planes: Array.from(master.fields.slice(41, 57)) };
    const scanned = game.movingLights(), seconds = 30 + v / 60, input = { location: eye.map(f), rotation, seconds, lights: scanned };
    before.beginFrame(input);
    after.beginFrame({ ...input, master: frame });
    // The lists as they were: each light on every leaf it reaches, prepended.
    const legacy = new Map();
    for (const light of scanned) {
      const record = before.lightRecordOf(light.actor);
      for (const leaf of movingLightLeaves(model, record.location, worldLightRadius(record.values))) {
        const list = legacy.get(leaf) ?? [];
        list.unshift(record);
        legacy.set(leaf, list);
      }
    }
    before.frame.leafLights = legacy;
    const names = list => (list ?? []).map(record => record.actor.name);
    total.views++; total.candidates += scanned.length;
    const reached = lists => new Set([...lists.values()].flat().map(record => record.actor));
    const [oldLights, newLights] = [reached(legacy), reached(after.frame.leafLights)];
    total.outsidePlanes += [...oldLights].filter(actor => !newLights.has(actor)).length;
    for (const leaf of new Set([...legacy.keys(), ...after.frame.leafLights.keys()])) {
      total.lists++;
      const a = names(legacy.get(leaf)), b = names(after.frame.leafLights.get(leaf));
      if (a.join() !== b.join()) { total.listsDiffer++; if ([...a].sort().join() === [...b].sort().join()) total.orderOnly++; }
    }
    for (const actor of actors) {
      const location = read(actor, 'Location');
      if (Math.hypot(...location.map((c, k) => c - eye[k])) > 2500) continue;
      const iLeaf = read(actor, 'Region')?.['engine.actor.pointregion.ileaf'];
      const one = before.setupMesh(actor), two = after.setupMesh(actor);
      total.actors++;
      if (names(legacy.get(iLeaf)).join() !== names(after.frame.leafLights.get(iLeaf)).join()) total.leafListDiffers++;
      const chosen = result => result.setup.lights.map(info => info.light.actor?.name).join();
      const colors = result => result.setup.lights.map(info => [info.light.actor?.name, ...info.color.map(u32)].join()).join(';');
      if (chosen(one) !== chosen(two)) total.chosenDiffers++;
      else if (colors(one) !== colors(two)) total.colorsDiffer++;
    }
  }
  occlusion.dispose();
  console.log(`${mapName}: ${total.views} views, ${total.candidates} moving-light candidates (${total.outsidePlanes} that reached a leaf are outside a ViewPlane); ${total.lists} leaf lists, ${total.listsDiffer} differ ` +
    `(${total.orderOnly} only in order); ${total.actors} lit actors: ${total.leafListDiffers} with a different leaf list, ` +
    `${total.chosenDiffers} with different chosen lights, ${total.colorsDiffer} more with the same lights in a different order or colour`);
}
await census('01_NYC_UNATCOIsland', 41);
await census('10_Paris_Club', 43);
process.exit(0);
