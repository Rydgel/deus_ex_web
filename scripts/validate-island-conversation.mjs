/** UNATCO Island's first third-person conversation in Play
 * (docs/conversation-camera.md).
 *
 * Original Play, no bypass, bench-sim's forward walk (W held) with the HUD
 * painted every frame at 1440x960 and the view taken from the original
 * PlayerCalcView, as the browser does. DL_StartGame's ConEventTrigger sends
 * PaulDenton0 RunningTo the player; MeetPaul (radius-invoked, third person)
 * then runs to its first ConEventChoice. Checked on the way:
 *  1. Conversation.CreateConCamera (2051, execCreateConCamera 0x100106f0) on
 *     MeetPaul returns a fresh ConCamera: class ConSys.ConCamera, Outer the
 *     DeusEx package, RF_Public, a generated ConCamera<N> name and cameraActor
 *     None; InitializeCameraValues spawns its two ConLights.
 *  2. PlayerCalcView hands the view to ConCamera.CalculateCameraPosition: the
 *     camera leaves the first-person eye.
 *  3. ConWindowActive's SetRenderViewport clips the 3D area (root +0x5d8 bits
 *     0 and 1), and DrawRawBackground fills exactly the clip list's rects with
 *     the root's Solid raw background (validate-root-raw-background checks the
 *     list against Extension.dll).
 *  4. PaulDenton0's speech channel is (35713 << 4) + (slot << 1) + bNoOverride,
 *     35713 being his index in the original Island GObjObjects capture.
 *  5. The choice: three ConChoiceWindow buttons and ConPlay in WaitForInput,
 *     with no runtime error on the way.
 *  6. ISLAND_NPC_IDENTITIES equals the capture's (class, name) indices. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CAPTURE = '.cache/original-gobjects-20261001-island-open.txt';

if (process.argv[2] !== 'child') {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`child failed:\n${child.stderr.slice(-4000)}`);
  const run = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(run.firstError, null, `no runtime error before the choice: ${JSON.stringify(run.firstError)}`);
  assert.equal(run.conversation.name, 'MeetPaul');
  assert.equal(run.conversation.bFirstPerson, false);
  assert.ok(run.conversation.tick > 1800 && run.conversation.tick < 2000, `MeetPaul starts with Paul at the player (tick ${run.conversation.tick})`);
  // 1.
  const camera = run.camera;
  assert.equal(camera.cls, 'consys.concamera');
  assert.equal(camera.outer, 'DeusEx');
  assert.match(camera.name, /^ConCamera\d+$/);
  assert.equal(camera.flags & 4, 4, 'RF_Public');
  assert.equal(camera.cameraActor, null, 'the constructor clears cameraActor');
  assert.equal(run.conLights, 2, 'CreateHighlights spawned two ConLights');
  assert.equal(run.lightsHeld, true, 'they are the camera conLightSpeaker/conLightSpeakingTo');
  // 2.
  assert.ok(run.cameraOffEye > 16, `the conversation view leaves the first-person eye (${run.cameraOffEye})`);
  // 3.
  assert.equal(run.letterbox.renderFlags & 3, 3, 'bRender and bClipRender');
  assert.ok(run.letterbox.rects.length > 0, 'the clipped area leaves raw background');
  // Every clipped frame (the bars slide in, hold, then widen for the choice):
  // the frame's first tiles are one Solid tile per clip rect, at its pixels.
  assert.ok(run.clippedFrames > 2000, `clipped frames ${run.clippedFrames}`);
  assert.deepEqual(run.letterboxMismatches, [], 'one Solid tile per clip rect, at its pixels, on every frame');
  // The held bars (the most frequent layout) are CalculateWindowSizes' full
  // size from the class's own height percentages.
  assert.deepEqual(run.settled, run.heldBars, 'the letterbox held during the conversation');
  // 4.
  assert.ok(run.paulSpeech.length > 0, 'PaulDenton0 spoke');
  for (const id of run.paulSpeech) assert.equal(id >>> 4, 35713, `Paul's channel ${id} carries his captured index`);
  // 5.
  assert.equal(run.choiceButtons, 3);
  assert.equal(run.state, 'WaitForInput');
  // 6.
  assert.equal(run.identities.checked, run.identities.total);
  assert.deepEqual(run.identities.mismatches, []);
  console.log(JSON.stringify({ ok: true, start: run.conversation.tick, choice: run.choiceTick, camera: camera.name,
    letterboxFrames: run.clippedFrames, paulSpeech: run.paulSpeech.length, identities: run.identities.total }));
  process.exit(0);
}

// The child. Deterministic simulated clock, as bench-sim.
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { gameDirectory } = await import('./game-directory.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');
const { loadOriginalGObjects } = await import('./original-gobjects.mjs');
const { rawBackgroundClipList } = await import('../src/runtime/script-root-raw-background.mjs');
const { ISLAND_NPC_IDENTITIES } = await import('../src/runtime/island-npc-identities.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const scripts = game.doors.scriptRuntime, runtime = scripts.runtime, W = game.hud.host.W;
const read = (object, name) => runtime.readNamed(object, name);
const level = runtime.levelFor(game.player.collisionActor);
const paul = level.actors.find(a => a?.name === 'PaulDenton0');
const isA = (object, key) => { for (let c = runtime.instance(object).cls; c; c = c.base) if (c.record.key === key) return true; return false; };

// 6. The identity table against the capture (class and name).
if (!existsSync(CAPTURE)) throw new Error(`The original Island capture is missing: ${CAPTURE} (docs/conversation-camera.md)`);
const captured = await loadOriginalGObjects(CAPTURE);
const identities = { total: Object.keys(ISLAND_NPC_IDENTITIES).length, checked: 0, mismatches: [] };
for (const [name, index] of Object.entries(ISLAND_NPC_IDENTITIES)) {
  const actor = level.actors.find(a => a?.name === name);
  const found = actor ? captured.indexFor(runtime.instance(actor).cls.record.name, name) : null;
  if (found === index) identities.checked++; else identities.mismatches.push({ name, index, found });
}

let tick = 0, conversation = null, camera = null, choiceButtons = 0, choiceTick = null;
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  const result = invokeNative(call);
  if (call.index === 2051) {
    const object = result, instance = runtime.instance(object);
    camera = { cls: instance.cls.record.key, outer: read(object, 'Outer')?.name ?? null, name: read(object, 'Name'),
      flags: read(object, 'ObjectFlags'), cameraActor: read(object, 'cameraActor') };
    conversation = { tick, name: read(call.receiver, 'conName'), bFirstPerson: read(call.receiver, 'bFirstPerson') };
  }
  if (call.index === 1410 && String(call.script?.entry?.path ?? '').toLowerCase() === 'conwindowactive.createconbutton') {
    choiceButtons++; choiceTick ??= tick;
  }
  return result;
};
createPlayerInputFixture(game).key('KeyW', true);
const player = game.player.collisionActor;
let firstError = null, cameraOffEye = 0, letterbox = null, state = null, clippedFrames = 0;
const layouts = new Map();
let heldBars = null;
const letterboxMismatches = [];
while (!firstError && tick < 5200) {
  simulatedMs += 1000 / 60; tick++;
  try {
    game.tick(1 / 60);
    const view = game.view();
    const commands = game.hud.commands(1440, 960, view);
    const conPlay = read(player, 'conPlay');
    if (conPlay && camera) {
      const eye = read(player, 'Location').map((v, i) => v + (i === 2 ? read(player, 'EyeHeight') : 0) + read(player, 'WalkBob')[i]);
      cameraOffEye = Math.max(cameraOffEye, Math.hypot(...view.location.map((v, i) => v - eye[i])));
      const rootWin = read(player, 'rootWindow');
      if (W.u32(rootWin, 0x5d8) & 2) {
        const rects = rawBackgroundClipList(W, rootWin);
        const f = bits => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, bits, true); return d.getFloat32(0, true); };
        const h = W.i32(rootWin, 0x730), v = W.i32(rootWin, 0x734);
        letterbox = { renderFlags: W.u32(rootWin, 0x5d8), rects: rects.map(r => r.map(f)),
          expected: rects.map(r => [(f(r[2]) + f(r[0])) * h, (f(r[3]) + f(r[1])) * v, f(r[4]) * h, f(r[5]) * v]),
          // PaintWindows draws the raw background before the window tree.
          tiles: commands.slice(0, rects.length).filter(c => String(c.texture?.name ?? '').toLowerCase() === 'solid')
            .map(c => [c.x, c.y, c.width, c.height]) };
        // ConWindowActive.CalculateWindowSizes at currentWindowPos 1:
        // int(height * upper/lowerFinalHeightPercent) in root units.
        const win = read(conPlay, 'conWinThird'), rootH = W.f32(rootWin, 0x84);
        const upper = Math.trunc(Math.fround(rootH * read(win, 'upperFinalHeightPercent')));
        const lower = Math.trunc(Math.fround(rootH * read(win, 'lowerFinalHeightPercent')));
        heldBars = [[0, 0, 1440, upper * h], [0, (rootH - lower) * v, 1440, lower * v]];
        const key = JSON.stringify(letterbox.tiles);
        layouts.set(key, (layouts.get(key) ?? 0) + 1);
        clippedFrames++;
        if (JSON.stringify(letterbox.tiles) !== JSON.stringify(letterbox.expected)) letterboxMismatches.push({ tick, ...letterbox });
      }
      state = runtime.instance(conPlay)?.state?.stateNode?.record?.name ?? null;
      if (state === 'WaitForInput' && choiceButtons) break;
    }
  } catch (error) { firstError = { tick, message: String(error?.message ?? error).split('\n')[0] }; }
}
const lights = level.actors.filter(a => a && !read(a, 'bDeleteMe') && isA(a, 'consys.conlight'));
const cameraObject = read(read(player, 'conPlay'), 'cameraInfo');
const held = [read(cameraObject, 'conLightSpeaker'), read(cameraObject, 'conLightSpeakingTo')];
const paulSpeech = scripts.liveConPlay.soundRequests.filter(r => r.kind === 'speech' && r.emitter === paul).map(r => r.id);
console.log(JSON.stringify({ firstError, conversation, camera, conLights: lights.length,
  lightsHeld: held.every(l => lights.includes(l)), cameraOffEye, letterbox, heldBars, settled: JSON.parse([...layouts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'null'), clippedFrames, letterboxMismatches: letterboxMismatches.slice(0, 3), paulSpeech, choiceButtons, choiceTick, state, identities }));
process.exit(0);
