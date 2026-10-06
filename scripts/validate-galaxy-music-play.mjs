/** Galaxy music in headless Play (docs/galaxy-music/update-transition.md,
 * "Play"): the subsystem's music section over the live PlayerPawn fields,
 * with the recording mirror library (galaxy-music-library.mjs) standing in
 * for the browser's AudioWorklet library. Each map boots in its own child
 * process (one at a time: a boot holds 1-2 GB), on bench-sim's simulated
 * clock, with the HUD painted every frame so Galaxy Update runs after it as
 * UGameEngine::Draw does (0x1038f638).
 *
 * 00_Intro, idle:
 *  1. The first Update after Login (PostLogin's ClientSetMusic(Level.Song,
 *     Level.SongSection, 255, MTRAN_Fade)) finds +0x888 = 0, +0x88c = 0xff:
 *     no fade; one lock batch loads Level.Song (glxLoadMusic of the Music
 *     export's bytes + 1024 slack bytes, 0 here) and starts SongSection
 *     (stop, clear voices [EffectsChannels, +32), start, control(2, section),
 *     break flag); Transition becomes 0 and the Song's Handle -1, its Data
 *     emptied.
 *  2. Later frames issue no library op; SongSection follows the library's
 *     order byte (the mirror's stays 0xff: it has no sequencer).
 *  3. Player start (game.reset(): LoadMap of the loaded map) issues no
 *     library op; the reloaded LevelInfo holds the same UMusic, so the new
 *     PostLogin's Fade fades the song (one SetVolumes per frame, music volume
 *     falling to 0) and restarts the section on the loaded module: no unload,
 *     no load.
 *  4. dispose() (the runtime dropped on a map change: LoadMap's collection
 *     destroying the UMusic) unregisters it: glxStopMusic, glxUnloadMusic.
 * 00_Training, through the browser host's transport (createGame's
 *  musicLibrary option, createMusicLibraryProxy): the first painted frame
 *  posts one batch, the load+start sequence with Training_Music's bytes and
 *  slack; SongSection follows the proxy's order(); dispose posts
 *  UnregisterMusic's two calls.
 * 01_NYC_UNATCOIsland, W held until MeetPaul: UpdateDynamicMusic's
 *  conversation switch ClientSetMusic(Level.Song, 4, 255, MTRAN_Fade) fades
 *  and restarts section 4 on the loaded module.
 *
 * Also measured (host timing, not a fidelity claim): the music section's
 * per-frame cost in the steady state and on transition frames, and Galaxy
 * Update with and without it, interleaved.
 *
 *   node scripts/validate-galaxy-music-play.mjs [--map 00_Intro|00_Training|01_NYC_UNATCOIsland]
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] !== 'child') {
  const maps = argv.includes('--map') ? [argv[argv.indexOf('--map') + 1]] : ['00_Intro', '00_Training', '01_NYC_UNATCOIsland'];
  for (const map of maps) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', map], {encoding: 'utf8', maxBuffer: 1 << 26});
    if (child.status !== 0) throw new Error(`${map} child failed:\n${child.stderr.slice(-6000)}`);
    const report = JSON.parse(child.stdout.trim().split('\n').pop());
    console.log(`${map}: ${JSON.stringify(report)}`);
  }
  console.log('validate-galaxy-music-play: PASS');
  process.exit(0);
}

const map = argv[1];
const realNow = performance.now.bind(performance);
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});
globalThis.__realNow = realNow;

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {readMusicExport} = await import('../src/unreal/music-module.mjs');
const {x87double} = await import('../src/runtime/script-vm.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {createPlayerInputFixture} = await import('./player-input-fixture.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
// 00_Training goes through the browser host's transport instead of the
// mirror: createGame's musicLibrary option, the proxy that encodes each lock
// batch for the AudioWorklet (galaxy-music-library.mjs, phase 5).
const {createMusicLibraryProxy, MUSIC_OP} = await import('../src/runtime/galaxy-music-library.mjs');
const posted = [];
const proxy = map === '00_Training' ? createMusicLibraryProxy(message => posted.push(message)) : null;
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true,
  ...(proxy ? {musicLibrary: proxy} : {})});
const runtime = game.doors.scriptRuntime.runtime, audio = runtime.audio, library = audio.library;
const read = (object, name) => runtime.readNamed(object, name);
const levelInfo = () => runtime.levelFor(game.player.collisionActor).actors[0];
assert.equal(library.kind, proxy ? undefined : 'mirror', 'the default library is the recording mirror');
if (proxy) {
  assert.equal(library, proxy, 'createLiveAudio got the host library');
  const names = Object.fromEntries(Object.entries(MUSIC_OP).map(([name, code]) => [code, name]));
  const decode = message => Array.from({length: message.ops.length / 3}, (_, i) => names[message.ops[i * 3]]);
  const song = read(levelInfo(), 'Song'), player = game.player.collisionActor;
  for (let i = 0; i < 3; i++) { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); }
  assert.equal(posted.length, 1, 'one batch in three frames');
  assert.deepEqual(decode(posted[0]), ['setSampleVolume', 'setMusicVolume', 'loadMusic', 'setSampleVolume', 'setMusicVolume',
    'stopMusic', 'clearVoiceActive', 'startMusic', 'controlMusic', 'setBreakFlag'], 'the load+start batch');
  const moduleSize = readMusicExport(song.asset, song.index).bytes.length;
  assert.deepEqual([posted[0].modules.length, posted[0].modules[0].byteLength], [1, moduleSize + 1024], 'the module with its slack');
  assert.equal(read(player, 'SongSection'), 0xff, 'SongSection from the proxy\'s order (glxControlMusic(2, 0) leaves 0xff)');
  audio.dispose();
  assert.deepEqual(posted.slice(1).map(decode), [['stopMusic'], ['unloadMusic']], 'dispose: UnregisterMusic');
  console.log(JSON.stringify({map, song: song.key, batches: posted.length, first: decode(posted[0]), moduleBytes: posted[0].modules[0].byteLength,
    status: proxy.status()}));
  process.exit(0);
}
library.takeBatches();

// Timing of the music section in place (real clock; the page clock is pinned).
const timing = {steady: [], transition: []};
const update = audio.music.update;
audio.music.update = (dt, actor) => {
  const transition = read(actor, 'Transition');
  const start = realNow();
  update(dt, actor);
  (transition ? timing.transition : timing.steady).push(realNow() - start);
};
let tick = 0, firstError = null;
const frame = () => {
  simulatedMs += 1000 / 60; tick++;
  try {
    game.tick(1 / 60);
    game.hud.commands(1440, 960, game.view());
  } catch (error) { firstError ??= {tick, message: String(error?.message ?? error).split('\n')[0]}; }
  return library.takeBatches();
};
const ops = batch => batch.map(op => op.op);
const START = ['setSampleVolume', 'setMusicVolume', 'setSampleVolume', 'setMusicVolume', 'stopMusic', 'clearVoiceActive', 'startMusic', 'controlMusic', 'setBreakFlag'];
const FIRST = ['setSampleVolume', 'setMusicVolume', 'loadMusic', ...START.slice(2)];
const fieldsOf = player => Object.fromEntries(['SongSection', 'CdTrack', 'Transition'].map(name => [name, read(player, name)]));

/** Frames until a batch restarts the music, with the batches on the way. */
function runTransition(limit, label) {
  const fading = [], instant = [];
  for (let i = 0; i < limit; i++) {
    const batches = frame();
    for (const batch of batches) {
      if (ops(batch).includes('startMusic') || ops(batch).includes('unloadMusic') || ops(batch).includes('loadMusic')) return {fading, instant, end: batch, frames: i + 1};
      // SetInstantSoundVolume/SpeechVolume (natives 268/269) outside Update.
      if (batch.length === 1 && batch[0].op === 'setSampleVolume') instant.push(batch[0].volume);
      else fading.push(batch);
    }
  }
  throw new Error(`${label}: no restart within ${limit} frames (${JSON.stringify(firstError)})`);
}
function checkFade(fading, label) {
  assert.ok(fading.length > 30, `${label}: a fade of several frames (${fading.length})`);
  const volumes = fading.map(batch => {
    assert.deepEqual(ops(batch), ['setSampleVolume', 'setMusicVolume'], `${label}: a fading frame is one SetVolumes`);
    return batch[1].volume;
  });
  assert.ok(volumes.every((v, i) => !i || v <= volumes[i - 1]), `${label}: the music volume falls`);
  assert.equal(volumes.at(-1), 0, `${label}: the fade reaches 0 before the restart`);
  return volumes;
}

function measure() {
  // Cost. In place: every Update's music section, by kind of frame.
  const stats = list => {
    const sorted = [...list].sort((a, b) => a - b);
    return {frames: list.length, medianUs: +(1000 * sorted[sorted.length >> 1]).toFixed(3),
      meanUs: +(1000 * list.reduce((s, v) => s + v, 0) / Math.max(1, list.length)).toFixed(3),
    maxUs: +(1000 * (sorted.at(-1) ?? 0)).toFixed(3)};
  };
  report.musicSectionCost = {steady: stats(timing.steady), transition: stats(timing.transition)};
  // Microbenchmark of the steady state: one Transition==0 call plus the lock
  // pair, as Update makes them each frame.
  audio.music.update = update;
  const player = game.player.collisionActor, dt = x87double(1 / 60);
  if (read(player, 'Transition') === 0) {
    for (let i = 0; i < 20000; i++) { library.lock(); update(dt, player); library.unlock(); }
    const runs = [];
    for (let r = 0; r < 7; r++) {
      const start = realNow();
      for (let i = 0; i < 100000; i++) { library.lock(); update(dt, player); library.unlock(); }
      runs.push((realNow() - start) / 100000 * 1e6);
    }
    runs.sort((a, b) => a - b);
    report.steadyMicrobenchNs = Math.round(runs[3]);
  }
  // Galaxy Update with and without the music section, interleaved frames
  // (steady state; the A frames skip the music call).
  const galaxyUpdate = audio.galaxy.update, withMusic = [], without = [];
  let skip = false;
  const section = audio.music.update;
  audio.music.update = (...args) => { if (!skip) section(...args); };
  audio.galaxy.update = (...args) => { const start = realNow(); galaxyUpdate(...args); (skip ? without : withMusic).push(realNow() - start); };
  for (let i = 0; i < 600; i++) { skip = i % 2 === 1; frame(); }
  report.galaxyUpdate = {withMusic: stats(withMusic), withoutMusic: stats(without)};
}

const report = {map};
if (map === '00_Intro') {
  const player = game.player.collisionActor, song = read(levelInfo(), 'Song');
  const section = read(levelInfo(), 'SongSection');
  const moduleSize = readMusicExport(song.asset, song.index).bytes.length;
  assert.deepEqual({song: read(player, 'Song'), ...fieldsOf(player)}, {song, SongSection: section, CdTrack: 255, Transition: 3},
    'PostLogin\'s ClientSetMusic(Level.Song, Level.SongSection, Level.CdTrack, MTRAN_Fade)');
  // 1. The first Update.
  const first = frame();
  assert.equal(first.length, 1, 'one batch');
  assert.deepEqual(ops(first[0]), FIRST, 'the first-start sequence (no fade)');
  const load = first[0][2], control = first[0][8], clear = first[0][6];
  assert.equal(load.length, moduleSize + 1024, 'glxLoadMusic gets Data after Add(1024): OriginalSize + 1024 bytes');
  assert.deepEqual([control.cmd, control.value], [2, section], 'glxControlMusic(GLX_SETPOSITION2, SongSection)');
  assert.deepEqual([clear.first, clear.count], [16, 32], 'voices [EffectsChannels, +32) cleared');
  assert.deepEqual([first[0][0].volume, first[0][1].volume], [126, 76], 'SetVolumes: sample 126, music ftol(f32(153/255)*127) = 76 at PC64');
  assert.equal(audio.music.state.current, song, '+0x888 is Level.Song');
  assert.deepEqual(fieldsOf(player), {SongSection: section, CdTrack: 255, Transition: 0}, 'Transition cleared');
  assert.deepEqual(frame(), [], 'the next frame issues no library op');
  assert.deepEqual(fieldsOf(player), {SongSection: 0xff, CdTrack: 255, Transition: 0},
    'with no transition pending SongSection = the order byte (0xff: the mirror has no sequencer)');
  assert.deepEqual(audio.musicLog.map(line => line.text), ['Load music: Music Intro_Music.Intro_Music']);
  report.first = {ops: ops(first[0]), loadLength: load.length, section};
  // 2. Idle frames.
  const idle = [];
  for (let i = 0; i < 240; i++) idle.push(...frame());
  for (const batch of idle) assert.deepEqual(ops(batch), ['setSampleVolume'], 'idle: only SetInstantSoundVolume/SpeechVolume (natives 268/269)');
  report.idle = {frames: 240, batches: idle.map(batch => `${batch[0].op}(${batch[0].volume})`), fields: fieldsOf(player)};
  // 3. Player start.
  const resetBatches = (() => { game.reset(); return library.takeBatches(); })();
  assert.deepEqual(resetBatches, [], 'LoadMap issues no library op (SetViewport no-op; the UMusic survives)');
  const player2 = game.player.collisionActor;
  assert.notEqual(player2, player, 'a new player logged in');
  assert.equal(read(levelInfo(), 'Song'), song, 'the reloaded LevelInfo holds the same UMusic');
  assert.deepEqual(fieldsOf(player2), {SongSection: section, CdTrack: 255, Transition: 3}, 'the new PostLogin');
  const restart = runTransition(200, 'Player start');
  const volumes = checkFade(restart.fading, 'Player start');
  assert.deepEqual(ops(restart.end), START, 'the section restarts on the loaded module: no unload, no load');
  assert.equal(audio.musicLog.length, 1, 'no Unregister or Load line');
  report.playerStart = {fadeFrames: restart.fading.length, firstVolumes: volumes.slice(0, 4), restart: ops(restart.end), instantSampleVolumes: restart.instant};
  measure();
  // 4. dispose: the runtime's UMusic destroyed.
  audio.dispose();
  const disposed = library.takeBatches();
  assert.deepEqual(disposed.map(ops), [['stopMusic'], ['unloadMusic']], 'UnregisterMusic outside Update: stop, unload');
  assert.equal(audio.music.state.current, null);
  assert.equal(audio.musicLog.at(-1).text, 'Unregister music: Music Intro_Music.Intro_Music');
  report.dispose = disposed.map(ops);
} else {
  const player = game.player.collisionActor;
  const first = frame();
  assert.deepEqual(first.map(ops), [FIRST], 'the first-start sequence');
  report.first = {song: read(levelInfo(), 'Song').key, section: first[0][8].value, loadLength: first[0][2].length};
  createPlayerInputFixture(game).key('KeyW', true);
  // Walk until UpdateDynamicMusic's conversation switch (Transition set
  // again with section 4).
  // PlayerTick's UpdateDynamicMusic runs in game.tick, Galaxy Update after
  // the HUD: the switch frame already fades.
  let switched = null;
  while (tick < 5200 && !switched) {
    const batches = frame();
    if (batches.length) switched = {tick, ...fieldsOf(player), batches};
  }
  assert.ok(switched, `the conversation switch happened (${JSON.stringify(firstError)})`);
  assert.deepEqual([switched.SongSection, switched.Transition], [4, 3], 'ClientSetMusic(Level.Song, 4, 255, MTRAN_Fade)');
  const change = runTransition(200, 'conversation');
  change.fading.unshift(...switched.batches);
  const volumes = checkFade(change.fading, 'conversation');
  assert.deepEqual(ops(change.end), START, 'the same song restarts at section 4: no unload, no load');
  assert.equal(change.end[7].value, 4);
  report.conversation = {tick: switched.tick, fadeFrames: change.fading.length, firstVolumes: volumes.slice(0, 4), restart: ops(change.end), instantSampleVolumes: change.instant};
  for (let i = 0; i < 120; i++) frame();
  measure();
}
assert.equal(firstError, null, `no runtime error (${JSON.stringify(firstError)})`);

console.log(JSON.stringify(report));
process.exit(0);
