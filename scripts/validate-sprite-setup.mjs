/** FDynamicSprite::Setup in the Rust core (native/script-vm/src/setup.rs,
 * src/runtime/bsp-occlusion.mjs) against the unchanged original under
 * Unicorn (scripts/native-occlusion-oracle.py), at the render pass's
 * precision control 24: docs/bsp-occlusion.md "Setup".
 *
 * Per map (00_Training, 01_NYC_UNATCOIsland):
 * - synthetic cases: random meshes (boxes, frame boxes, sequences, scale,
 *   origin, RotOrigin) and actors of every DrawType around random cameras,
 *   including sprites near the view plane (Project's |Z| < 0.01 branch);
 * - real Play actors: the map booted through Play's createGame and ticked,
 *   then every Level.Actors entry with a prepared mesh or a sprite texture,
 *   seen from the player's view and from cameras looking at actors;
 * - the whole chain: the same actors through the original sprite
 *   constructor, Setup and OccludeBsp against occ_setup + occ_run, comparing
 *   Frame->Sprite and each sprite's span buffer;
 * - Play's packing: the actor mesh layer's candidates (mesh_reads words,
 *   dynamics-candidates.mjs) against the same fields read by name, word for
 *   word, in Level.Actors order.
 * Every Setup result (return value, X1, Y1, X2, Y2, Z, and the sprite path's
 * ScreenX, ScreenY and Persp) must match bit for bit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createActorMeshSim } from '../src/viewer/actor-mesh-sim.mjs';
import { packDynamics } from '../src/viewer/dynamics-candidates.mjs';
import { createBspOcclusion, packSetupCandidate, setupSequence, meshRecordFields, SETUP, SETUP_OUT_WORDS,
  SETUP_STATUS, SETUP_MESH_NONE, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { bits, occlusionModelRequest, occlusionTangents, renderPassTangent, renderRectangle, surfaceTextureFlags } from './occlusion-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-sprite-setup: no native probe environment');
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const TANGENTS = occlusionTangents();
const kernel = (await loadScriptVmKernel()).occlusion;
const f32 = Math.fround;

let state = 0;
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = list => list[Math.floor(random() * list.length)];
const sizes = [[640, 480], [1024, 768], [1440, 839], [1920, 1080], [801, 601], [1280, 720]];

/** FBox bytes: Min, Max floats and the IsValid byte, 28 bytes each. */
function boxBytes(boxes) {
  const bytes = new Uint8Array(28 * boxes.length), view = new DataView(bytes.buffer);
  boxes.forEach((box, i) => {
    for (let k = 0; k < 3; k++) { view.setFloat32(28 * i + 4 * k, box.min[k], true); view.setFloat32(28 * i + 12 + 4 * k, box.max[k], true); }
    bytes[28 * i + 24] = box.valid ? 1 : 0;
  });
  return bytes;
}
const boxBits = box => [...box.min.map(bits), ...box.max.map(bits), box.valid ? 1 : 0];
const randomBox = scale => {
  const a = [0, 1, 2].map(() => f32((random() - 0.5) * scale)), b = [0, 1, 2].map(() => f32((random() - 0.5) * scale));
  // Mostly ordered boxes, sometimes not; mostly valid.
  const ordered = random() < 0.9;
  return { min: a.map((v, k) => ordered ? Math.min(v, b[k]) : v), max: a.map((v, k) => ordered ? Math.max(v, b[k]) : b[k]),
    valid: random() < 0.9 };
};

/** A mesh payload's fields as Setup and the oracle use them, from a real
 * payload or a synthetic one. */
function meshEntry(key, payload, names) {
  const boxes = payload.arrays.get(0xa8).data, view = new DataView(boxes.buffer, boxes.byteOffset, boxes.byteLength);
  const boxList = [];
  for (let at = 0; at + 28 <= boxes.byteLength; at += 28)
    boxList.push([0, 1, 2, 3, 4, 5].map(k => view.getUint32(at + 4 * k, true)).concat(boxes[at + 24]));
  return { key, payload, fixture: { boxBits: boxBits(payload.boundingBox), boxes: boxList,
    sequences: payload.sequences.map(s => ({ name: names.id(s.name), startFrame: s.startFrame, numFrames: s.numFrames })),
    scaleBits: payload.scale.map(bits), originBits: payload.origin.map(bits), rotOrigin: payload.rotation.map(v => v | 0) } };
}
function syntheticMesh(key, names) {
  const count = Math.floor(random() * 12), boxes = Array.from({ length: count }, () => randomBox(200));
  const sequences = [];
  for (let i = 0, n = count ? 1 + Math.floor(random() * 4) : 0; i < n; i++) {
    const start = Math.floor(random() * count), frames = 1 + Math.floor(random() * (count - start));
    sequences.push({ name: `Seq${Math.floor(random() * 6)}`, startFrame: start, numFrames: frames });
  }
  const payload = { boundingBox: randomBox(400), arrays: new Map([[0xa8, { data: boxBytes(boxes) }]]), sequences,
    scale: [0, 1, 2].map(() => f32(random() < 0.1 ? -(0.01 + random() * 2) : 0.01 + random() * 2)),
    origin: [0, 1, 2].map(() => f32((random() - 0.5) * 100)),
    rotation: [0, 1, 2].map(() => random() < 0.5 ? 0 : Math.floor((random() - 0.5) * 2 ** 32)) };
  return meshEntry(key, payload, names);
}

/** Interned FName ids: 0 is None; spellings fold to one id (setupSequence). */
function nameTable() {
  const ids = new Map([['NONE', 0]]);
  return { id: name => {
    if (typeof name !== 'string') return 0;
    const key = name.toUpperCase();
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  } };
}

/** One actor as both sides read it: `spec` for packSetupCandidate, `fixture`
 * for the oracle. */
function actorPair(spec, meshIndex, textureIndex, names) {
  return {
    spec,
    fixture: { sequence: names.id(spec.animSequence), animFrameBits: bits(spec.animFrame), locationBits: spec.location.map(bits),
      rotation: spec.rotation.map(v => v | 0), drawType: spec.drawType, texture: textureIndex, mesh: meshIndex,
      drawScaleBits: bits(spec.drawScale), prePivotBits: spec.prePivot.map(bits), particles: spec.particles },
  };
}

/** Pack `pairs` as Setup candidates (key = index) and run Setup alone. */
function packPairs(occlusion, pairs, meshes) {
  // Mesh records first: an allocation may grow the memory under the views.
  const records = pairs.map(({ spec }) => {
    const mesh = spec.mesh ? meshes.get(spec.mesh) : null;
    return mesh ? occlusion.meshRecord(mesh.key, meshRecordFields(mesh.payload)) : SETUP_MESH_NONE;
  });
  const views = occlusion.setupCandidates(pairs.length);
  pairs.forEach(({ spec }, i) => {
    const mesh = spec.mesh ? meshes.get(spec.mesh) : null;
    packSetupCandidate(views, views.at + SETUP.WORDS * i, { ...spec, key: i, mesh: records[i],
      sequence: mesh ? setupSequence(mesh.payload.sequences, spec.animSequence) : null });
  });
}
function rustSetups(occlusion, words, pairs, meshes) {
  packPairs(occlusion, pairs, meshes);
  return occlusion.setupOnly(words, pairs.length);
}

const asFloat = word => new Float32Array(Uint32Array.of(word).buffer)[0];
function compareSetups(results, oracle, pairs, where, stats, meshes) {
  for (let i = 0; i < pairs.length; i++) {
    const r = results.subarray(SETUP_OUT_WORDS * i, SETUP_OUT_WORDS * (i + 1)), o = oracle[i];
    const status = r[0];
    assert.ok(status === SETUP_STATUS.ACCEPTED || status === SETUP_STATUS.REJECTED, `${where} actor ${i}: Rust status ${status}`);
    assert.deepEqual({ result: status, rect: [...r.subarray(1, 5)].map(v => v | 0), zBits: r[5], screenBits: [...r.subarray(6, 9)] },
      { result: o.result, rect: o.rect, zBits: o.zBits >>> 0, screenBits: o.screenBits.map(v => v >>> 0) },
      `${where} actor ${i} (DrawType ${pairs[i].spec.drawType}): Setup`);
    const kind = pairs[i].spec.drawType === 2 ? 'mesh' : pairs[i].spec.drawType === 1 || pairs[i].spec.drawType === 7 ? 'sprite' : 'other';
    stats[kind] = (stats[kind] ?? 0) + 1;
    if (status === SETUP_STATUS.ACCEPTED) stats[`${kind} accepted`] = (stats[`${kind} accepted`] ?? 0) + 1;
    // Branch coverage: GetRenderBoundingBox's frame-box pair, and Project's
    // |T.z| < 0.01 step (Z' = T.z + 0.02 makes Persp at least ProjZ / 0.03).
    const spec = pairs[i].spec, mesh = spec.mesh ? meshes.get(spec.mesh) : null;
    if (kind === 'mesh' && mesh && o.zBits && setupSequence(mesh.payload.sequences, spec.animSequence) && spec.animFrame >= 0)
      stats['mesh frame-box'] = (stats['mesh frame-box'] ?? 0) + 1;
    if (kind === 'sprite' && asFloat(o.screenBits[2]) > 8000) stats['sprite near-plane (Persp > 8000)'] = (stats['sprite near-plane (Persp > 8000)'] ?? 0) + 1;
  }
}

/** The map's live actors after `ticks` Play ticks, as Setup reads them. */
async function playActors(asset, ticks) {
  const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
  for (let i = 0; i < ticks; i++) game.tick(1 / 60);
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  const read = (actor, name) => { try { return runtime.readNamed(actor, name); } catch { return undefined; } };
  const meshes = new Map(), textures = new Map(), actors = [];
  for (const actor of level.actors) {
    if (!actor) continue;
    const drawType = read(actor, 'DrawType') & 255, meshRef = read(actor, 'Mesh'), texture = read(actor, 'Texture');
    let mesh = null, size = null;
    if (meshRef && ['LodMesh', 'Mesh'].includes(meshRef.kind)) {
      try { const payload = await runtime.prepareMesh(actor); if (payload) { mesh = meshRef.key; meshes.set(mesh, payload); } }
      catch { continue; }
    }
    if ((drawType === 1 || drawType === 7) && texture) {
      if (!textures.has(texture.key)) {
        const data = readTexture(texture.asset, texture.index);
        textures.set(texture.key, { uSize: data.values.USize ?? data.mips[0].width, vSize: data.values.VSize ?? data.mips[0].height });
      }
      size = textures.get(texture.key);
    }
    if (drawType === 2 && !mesh && meshRef) continue; // a mesh Play cannot prepare
    actors.push({ name: actor.name, drawType, mesh, texture: size, location: [...read(actor, 'Location')].map(f32),
      rotation: [...read(actor, 'Rotation')], drawScale: f32(read(actor, 'DrawScale')),
      prePivot: [...read(actor, 'PrePivot')].map(f32), particles: Boolean(read(actor, 'bParticles')),
      animSequence: read(actor, 'AnimSequence'), animFrame: f32(read(actor, 'AnimFrame')) });
  }
  const view = game.view();
  return { game, actors, meshes, view: { location: view.location.map(f32), rotation: [...view.rotation], fov: view.fov } };
}

/** Play's packing (actor-mesh-sim.mjs packSetup through packDynamics) for
 * the actor mesh layer's bindings against packSetupCandidate on the fields
 * read by name; returns the number of candidates compared and how many came
 * from mesh_reads blocks. */
async function comparePlayPacking(game, asset, occlusion, where) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const level = runtime.levelFor(player), read = (actor, name) => runtime.readNamed(actor, name);
  const actorSim = await createActorMeshSim(runtime, assets, asset, { player: () => game.player.collisionActor });
  await actorSim.ready();
  let compared = 0, fromBlocks = 0;
  try {
    actorSim.update({ occlude: args => {
      const entries = packDynamics(occlusion, args);
      const got = occlusion.setupCandidates(entries.length), words = got.u32.slice(got.at, got.at + SETUP.WORDS * entries.length);
      const scratch = new ArrayBuffer(4 * SETUP.WORDS * entries.length);
      const want = { u32: new Uint32Array(scratch), f32: new Float32Array(scratch), i32: new Int32Array(scratch) };
      let last = -1;
      entries.forEach((entry, i) => {
        const actor = entry.binding.actor, index = level.actors.indexOf(actor);
        assert.ok(index > last, `${where}: candidates in Level.Actors order`);
        last = index;
        if (entry.binding.block && args.reads) fromBlocks++;
        packSetupCandidate(want, SETUP.WORDS * i, { key: i, drawType: read(actor, 'DrawType'), mesh: words[SETUP.WORDS * i + SETUP.MESH],
          texture: null, location: read(actor, 'Location'), rotation: read(actor, 'Rotation'), drawScale: read(actor, 'DrawScale'),
          prePivot: read(actor, 'PrePivot'), particles: read(actor, 'bParticles'), animFrame: read(actor, 'AnimFrame'),
          sequence: setupSequence(entry.binding.payload.sequences, read(actor, 'AnimSequence')) });
        assert.deepEqual([...words.subarray(SETUP.WORDS * i, SETUP.WORDS * (i + 1))], [...want.u32.subarray(SETUP.WORDS * i, SETUP.WORDS * (i + 1))],
          `${where}: ${actor.name}'s Setup candidate words`);
        compared++;
      });
      return { main: new Set(), children: false };
    } });
  } finally { actorSim.dispose(); }
  return { compared, fromBlocks };
}

/** A camera at `distance` from `target` looking at it. */
function lookAt(target, distance) {
  const yaw = random() * 2 * Math.PI, pitch = (random() - 0.5) * 1.2;
  const offset = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)].map(v => v * distance);
  const location = target.map((v, k) => f32(v + offset[k]));
  const units = radians => Math.round(radians * 32768 / Math.PI) & 0xffff;
  const jitter = () => Math.floor((random() - 0.5) * 3000);
  return { location, rotation: [((units(-pitch) + jitter()) << 16) >> 16, (units(yaw + Math.PI) + jitter()) & 0xffff,
    random() < 0.2 ? jitter() : 0] };
}

async function validate(mapName, seed) {
  state = seed >>> 0;
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await surfaceTextureFlags(assets, asset, model);
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: textureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const names = nameTable(), stats = {};
  try {
    const play = await playActors(asset, 30);
    const packing = await comparePlayPacking(play.game, asset, occlusion, mapName);
    assert.ok(packing.compared > 0, `${mapName}: no Play candidates`);
    stats['Play candidates packed (mesh_reads)'] = `${packing.compared} (${packing.fromBlocks})`;
    // Meshes: the real ones, then synthetic ones.
    const meshes = new Map();
    for (const [key, payload] of play.meshes) meshes.set(key, meshEntry(key, payload, names));
    for (let i = 0; i < 16; i++) meshes.set(`synthetic:${i}`, syntheticMesh(`synthetic:${i}`, names));
    const meshKeys = [...meshes.keys()], meshIndex = key => (key ? meshKeys.indexOf(key) : null);
    const spriteTextures = [], textureIndex = size => {
      if (!size) return null;
      let i = spriteTextures.findIndex(t => t.uSize === size.uSize && t.vSize === size.vSize);
      if (i < 0) { i = spriteTextures.length; spriteTextures.push(size); }
      return i;
    };
    const pair = spec => actorPair(spec, meshIndex(spec.mesh), textureIndex(spec.texture), names);
    const realPairs = play.actors.map(pair);
    const synthetic = [...meshes.keys()].filter(k => k.startsWith('synthetic:'));
    const camera = c => occlusion.master({ location: c.location, rotation: c.rotation, width: c.width, height: c.height, fov: c.fov,
      render: c.render ? { width: c.render.width, height: c.render.height } : null });
    const cases = [], plans = [];
    // Real actors from the player's view and from cameras looking at them.
    const looked = play.actors.filter(a => a.drawType === 2 || a.drawType === 1 || a.drawType === 7);
    const realCameras = [{ ...play.view, width: 1440, height: 839 }, { ...play.view, width: 1920, height: 1080 }];
    for (let i = 0; i < 22; i++) {
      const [width, height] = pick(sizes);
      realCameras.push({ ...lookAt(pick(looked).location, 60 + random() * 1500), width, height, fov: random() < 0.5 ? 90 : 75 });
    }
    for (const c of realCameras) plans.push({ camera: c, pairs: realPairs, label: 'real' });
    // Synthetic actors around random cameras.
    const spots = map.actors.filter(a => a.values.Location).map(a => a.values.Location);
    for (let i = 0; i < 24; i++) {
      const [width, height] = pick(sizes);
      const c = { ...lookAt(pick(spots).map(f32), 20 + random() * 400), width, height, fov: random() < 0.5 ? 90 : 75 };
      const frame = camera(c).fields, o = [0, 1, 2].map(k => new Float32Array(Uint32Array.of(frame[k]).buffer)[0]);
      const axis = n => [0, 1, 2].map(k => new Float32Array(Uint32Array.of(frame[3 + 3 * n + k]).buffer)[0]);
      const [X, Y, Z] = [axis(0), axis(1), axis(2)];
      const pairs = [];
      for (let k = 0; k < 48; k++) {
        const drawType = pick([2, 2, 2, 2, 1, 1, 7, 0, 3, 5]);
        const near = random() < 0.15;
        const depth = near ? pick([0, 0.004, -0.004, 0.0099, 0.01, 0.5, 1, 1.01, -2]) : (random() - 0.15) * 3000;
        const spread = near ? 50 : Math.abs(depth) + 20;
        const a = (random() - 0.5) * spread * 1.6, b = (random() - 0.5) * spread;
        const location = [0, 1, 2].map(n => f32(o[n] + a * X[n] + b * Y[n] + depth * Z[n]));
        const mesh = random() < 0.9 ? pick(synthetic) : null, sequences = meshes.get(mesh)?.payload.sequences ?? [];
        pairs.push(pair({ drawType, mesh: drawType === 2 || random() < 0.2 ? mesh : null,
          texture: random() < 0.9 ? { uSize: pick([1, 8, 16, 32, 64, 128, 256, 512, 1024]), vSize: pick([1, 16, 64, 256, 2048]) } : null,
          location, rotation: [0, 1, 2].map(() => random() < 0.3 ? 0 : Math.floor((random() - 0.5) * 2 ** 32) | 0),
          drawScale: f32(pick([1, 1, 0.5, 2, 0, -1, 0.01 + random() * 4])),
          prePivot: [0, 1, 2].map(() => f32(random() < 0.6 ? 0 : (random() - 0.5) * 60)), particles: random() < 0.1,
          animSequence: random() < 0.7 && sequences.length ? pick(sequences).name.toLowerCase() : pick(['None', 'Unknown']),
          animFrame: f32(pick([0, 1, 0.5, -0.25, random() * 1.2, random() * 0.999, 2.5])) }));
      }
      plans.push({ camera: c, pairs, label: 'synthetic' });
    }
    // Setup runs inside DrawWorld on the frame the render pass's
    // ComputeRenderSize (XRootWindow::PreRender) left: two cameras in three
    // get a render rectangle, a third of those the viewport.
    const tangents = { ...TANGENTS };
    for (const [i, plan] of plans.entries()) {
      if (i % 3 === 0) continue;
      plan.camera.render = renderRectangle(plan.camera.width, plan.camera.height, random, i % 3 === 1 ? 1 : 0.5);
      Object.assign(tangents, renderPassTangent(plan.camera.fov, plan.camera.render.width, 'validate-sprite-setup'));
    }
    for (const [i, plan] of plans.entries())
      cases.push({ ...plan.camera, locationBits: plan.camera.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30),
        setupOnly: true, actors: plan.pairs.map(p => p.fixture) });
    // The whole chain on real actors: the frames carry NodeFlags over.
    const chain = realCameras.slice(0, 12);
    for (const [i, c] of chain.entries())
      cases.push({ ...c, locationBits: c.location.map(bits), frameCounter: 100 + i, timeBits: bits(5 + i / 30),
        sprites: realPairs.map(p => ({ actor: p.fixture })) });
    const request = { gameRoot: root, tangents, cases, meshes: meshKeys.map(k => meshes.get(k).fixture), spriteTextures,
      model: occlusionModelRequest(model, textureFlags) };
    const oracle = JSON.parse(execFileSync(python, ['scripts/native-occlusion-oracle.py'],
      { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 })).results;
    let drawn = 0, offered = 0;
    for (const [i, c] of cases.entries()) {
      const o = oracle[i], where = `${mapName} case ${i} ${JSON.stringify(c.location.map(v => +v.toFixed(1)))} ${c.rotation} ${c.width}x${c.height}`;
      const master = camera(c);
      assert.deepEqual([...master.fields].map(v => v >>> 0), [...o.frameBits, o.zoneNumber, ...o.uncoordsBits].map(v => v >>> 0), `${where}: master frame`);
      const words = [...master.frame];
      words[44] = c.frameCounter; words[45] = c.timeBits; words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES; words[47] = 0;
      if (c.setupOnly) {
        const pairs = i < plans.length ? plans[i].pairs : null;
        compareSetups(rustSetups(occlusion, words, pairs, meshes), o.setups, pairs, where, stats, meshes);
        stats.cases = (stats.cases ?? 0) + 1;
        continue;
      }
      // occ_setup + occ_run against the constructor, Setup and OccludeBsp.
      packPairs(occlusion, realPairs, meshes);
      const r = occlusion.run(words, [], { setupCount: realPairs.length });
      compareSetups(occlusion.setupResults(realPairs.length), o.setups, realPairs, where, stats, meshes);
      assert.deepEqual(r.sprites, o.sprites.map(entry => ({ key: entry.sprite, span: entry.span })), `${where}: Frame->Sprite`);
      drawn += r.sprites.length;
      offered += o.setups.filter(s => s.result).length;
      stats.chain = (stats.chain ?? 0) + 1;
    }
    const counts = Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`${mapName}: ${play.actors.length} Play actors, ${meshKeys.length} meshes; ${counts}; chain: ${drawn} of ${offered} set-up sprites in Frame->Sprite`);
  } finally {
    occlusion.dispose();
  }
}

await validate('00_Training', 17);
await validate('01_NYC_UNATCOIsland', 29);
console.log('validate-sprite-setup: ok');
