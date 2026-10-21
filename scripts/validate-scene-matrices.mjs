// Scene world matrices without the per-render cascade (docs/play-cpu-plan.md
// step 1.3). The Play scene, the world root and the markers keep their
// identity matrices without matrixAutoUpdate, and movers flag only a changed
// brush matrix, so renderer.render no longer recomputes every descendant's
// matrixWorld twice per frame. This checks, on every scene update of every
// frame, that each object's matrixWorld after the renderer's own update
// equals a forced full cascade (updateMatrixWorld(true), what the auto-update
// root forced before), bit for bit. Host work only: no original behavior is
// involved.
//
// Browser cases, each standing then walking forward: UNATCO Island at Player
// start, 02_NYC_Smug, whose mirror sits on a mover (DeusExMover7), and
// 00_Training. None of their movers moves by itself, so a Node pass first
// drives world.syncMovers on 02_NYC_Smug's world with scripted offsets and a
// rotating key, calls a mover mesh's updateWorldMatrix(true, false) as the
// mirror pass does (it clears the group's flag without updating the group's
// other meshes), then makes the same comparison.
//
//   node scripts/validate-scene-matrices.mjs [--url http://...] [--frames 120] [--maps a,b]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createWorld} from '../src/viewer/world.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-scene-matrices: no installed game data'); process.exit(0); }
const compare = (scene, label) => {
  const snapshot = [];
  scene.traverse(object => snapshot.push([object, object.matrixWorld.elements.slice()]));
  scene.updateMatrixWorld(true);
  const wrong = snapshot.filter(([object, elements]) => elements.some((value, i) => !Object.is(value, object.matrixWorld.elements[i])));
  assert.deepEqual(wrong.map(([object]) => object.userData?.actor ?? object.name), [], `${label}: matrixWorld differs from the forced cascade`);
  return snapshot.length;
};
{
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(path.join(gameDirectory(), directory)))
      files.push({path: `${directory}/${name}`, read: () => readFile(path.join(gameDirectory(), directory, name))});
  const assets = new AssetStore(files), asset = await assets.get('02_NYC_Smug'), map = decodeMap(asset.bytes);
  const world = await createWorld(map, asset, assets);
  // As main.mjs: the scene does not auto-update.
  const scene = new THREE.Scene(); scene.matrixAutoUpdate = false; scene.add(world.root);
  const movers = map.actors.filter(actor => /Mover$/.test(actor.className) && actor.values.Brush > 0)
    .map(actor => ({name: actor.name, values: actor.values, position: [...actor.values.Location], offset: [0, 0, 0]}));
  const groups = [];
  world.root.traverse(object => { if (object.isGroup && object !== world.root && object.children.some(child => child.userData?.actor)) groups.push(object); });
  assert.ok(movers.length >= 2 && groups.length >= 2, 'Smug has mover groups');
  let checked = 0;
  for (let frame = 0; frame < 40; frame++) {
    movers.forEach((mover, i) => {
      // Movers start, stop and rotate at different frames.
      if ((frame + i) % 7 < 4) mover.offset = [frame * 3 + i, -frame * 2, (frame % 5) * 1.5];
      mover.rotation = i === 1 && frame >= 20 ? [0, frame * 512, 0] : undefined;
    });
    world.syncMovers(movers);
    for (const group of groups) group.children[0]?.updateWorldMatrix(true, false);
    scene.updateMatrixWorld();
    checked += compare(scene, `02_NYC_Smug Node frame ${frame}`);
  }
  world.dispose();
  console.log(JSON.stringify({node: {map: '02_NYC_Smug', movers: movers.length, frames: 40, objects: checked}}));
}
let server = null, url = option('url', null);
const frames = Number(option('frames', 120));
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const CASES = option('maps', '01_NYC_UNATCOIsland,02_NYC_Smug,00_Training').split(',');
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
const browser = await chromium.launch({args: [`--use-angle=${angle}`]});
const results = [];
try {
  for (const map of CASES) {
    const page = await browser.newPage({viewport: {width: 960, height: 640}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Reads the runtime through main.mjs: the page's own simulation (?sim=inline).
    await page.goto(debugUrl(`${url.replace(/\/$/, '')}/?sim=inline`));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 180000});
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 180000});
    await page.waitForFunction(() => window.deusExViewer?.status()?.gameplay?.hud?.health?.head?.displayedHealth === 100, {}, {timeout: 180000});
    await page.locator('#scene').click({position: {x: 480, y: 320}});
    // Every Scene.updateMatrixWorld the renderer makes: snapshot each
    // object's matrixWorld, run the forced cascade, compare.
    await page.evaluate(async () => {
      const source = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/three(?:\.js|\/)/.test(name));
      const {Scene, Object3D} = await import(source);
      const original = Object3D.prototype.updateMatrixWorld, check = window.__matrixCheck = {updates: 0, objects: 0, mismatches: []};
      Scene.prototype.updateMatrixWorld = function (force) {
        original.call(this, force);
        const snapshot = [];
        this.traverse(object => snapshot.push([object, object.matrixWorld.elements.slice()]));
        original.call(this, true);
        check.updates++; check.objects += snapshot.length;
        for (const [object, elements] of snapshot) {
          const now = object.matrixWorld.elements;
          if (elements.some((value, i) => !Object.is(value, now[i])) && check.mismatches.length < 20)
            check.mismatches.push({name: object.name || object.type, actor: object.userData?.actor ?? null, update: check.updates,
              renderer: elements, cascade: [...now], parent: object.parent?.type, auto: object.matrixAutoUpdate});
        }
      };
    });
    const step = async count => {
      for (let i = 0; i < count; i++) {
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const phases = await page.evaluate(() => window.deusExViewer.framePhases(false));
        if (phases.runtimeError) throw new Error(`${map}: ${phases.runtimeError}`);
      }
    };
    await step(frames / 2);
    await page.keyboard.down('KeyW');
    await step(frames / 2);
    await page.keyboard.up('KeyW');
    const check = await page.evaluate(() => window.__matrixCheck);
    assert.deepEqual(errors, [], `${map}: page errors`);
    assert.ok(check.updates >= frames, `${map}: scene updates were checked (${check.updates})`);
    assert.deepEqual(check.mismatches, [], `${map}: matrixWorld differs from the forced cascade`);
    results.push({map, updates: check.updates, objectsPerUpdate: Math.round(check.objects / check.updates)});
    await page.close();
  }
} finally {
  await browser.close();
  await server?.close();
}
console.log(JSON.stringify(results));
console.log('Every scene matrixWorld equals the forced cascade on every update.');
