/** Galaxy's effect voices in headless Play (docs/galaxy-audio.md "Effects
 * through Galaxy's mixer"): the map's own Galaxy Update (galaxy-audio.mjs,
 * script-audio-live.mjs) drives the library through the browser host's
 * transport, the effect-capable proxy (galaxy-music-library.mjs: sample
 * registry, startSample/controlSample/stopSample ops, Active reports) to the
 * worklet processor itself (galaxy-music-worklet.mjs) running under Node and
 * pulled in real time: 44100 frames per simulated second. Host checks: the
 * entries the worklet calls are verified against Galaxy.dll by
 * validate-galaxy-effects.mjs.
 *
 * Per map (one child process each, bench-sim's simulated clock, the HUD
 * painted every frame so Galaxy Update runs after it as UGameEngine::Draw does):
 *  - every sound Galaxy registered went to the worklet once, with the
 *    registry's handle (no mismatch), and no fault or error in the worklet;
 *  - the subsystem's voices are the library's: each channel holding a voice
 *    has it in the voice table with the channel's last frequency, volume and
 *    pan (glxControlSample) and the sample's record;
 *  - once every batch is acknowledged, the proxy's voiceActive() is the
 *    library's Active byte for every effect voice;
 *  - the output carries the effects (bus B) and the music;
 *  - a Player start stops every channel's voice, and dispose() stops them
 *    with the map (and unregisters the music).
 *
 *   node scripts/validate-galaxy-effects-play.mjs [--map 01_NYC_UNATCOIsland] [--frames 600]
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
if (argv[0] !== 'child') {
  const maps = argv.includes('--map') ? [option('map')] : ['01_NYC_UNATCOIsland', '03_NYC_BrooklynBridgeStation', '00_Training'];
  for (const map of maps) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', map, option('frames', '600')],
      {encoding: 'utf8', maxBuffer: 1 << 26});
    if (child.status !== 0) throw new Error(`${map} child failed:\n${child.stderr.slice(-6000)}`);
    const report = JSON.parse(child.stdout.trim().split('\n').pop());
    console.log(`${map}: ${JSON.stringify(report)}`);
  }
  console.log('validate-galaxy-effects-play: PASS');
  process.exit(0);
}

const map = argv[1], FRAMES = Number(argv[2]);
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {createMusicLibraryProxy, createSampleRegistry, voiceSlot, VOICE_BASE, VOICE_SIZE} = await import('../src/runtime/galaxy-music-library.mjs');

// The worklet module under Node: AudioWorkletProcessor gives each processor its page port.
globalThis.sampleRate = 44100;
globalThis.AudioWorkletProcessor = class { constructor() { const channel = new MessageChannel(); this.port = channel.port1; this.pagePort = channel.port2; } };
const worklet = await import('../src/viewer/galaxy-music-worklet.mjs');
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);

const processor = new worklet.GalaxyMusicProcessor();
const wasm = await readFile(new URL('../src/runtime/galaxy-kernel.wasm', import.meta.url));
processor.page({type: 'init', wasm: wasm.slice().buffer});
const channel = new MessageChannel();
const library = createMusicLibraryProxy((message, transfer) => channel.port2.postMessage(message, transfer), {samples: createSampleRegistry()});
channel.port2.onmessage = ({data}) => library.report(data);
processor.page({type: 'connect', port: channel.port1, effectsChannels: 16, pc: 64, ahead: 176400 - 882 * 4});
while (!processor.open) await turn();
// The worklet's render cost per 20 ms callback (host measurement, real time:
// performance.now is the simulated clock here).
const renderTimes = [], render = processor.kernel.render;
processor.kernel.render = frames => { const t = process.hrtime.bigint(); const r = render(frames); renderTimes.push(Number(process.hrtime.bigint() - t) / 1000); return r; };

const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true, musicLibrary: library});
const runtime = game.doors.scriptRuntime.runtime, audio = runtime.audio;
assert.equal(audio.library, library, 'createLiveAudio got the host library');
assert.equal(audio.galaxyVoices, true, "effects through Galaxy's voices");
// Real-time pull: 44100 frames per simulated second, 128-frame quanta.
const left = new Float32Array(128), right = new Float32Array(128);
let owed = 0, peak = 0, quanta = 0;
async function frame(dt = 1 / 60) {
  simulatedMs += dt * 1000;
  game.tick(dt);
  game.hud.commands(1440, 960, game.view());
  await turn();
  owed += dt * 44100;
  while (owed >= 128) {
    processor.process([], [[left, right]]);
    for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    owed -= 128; quanta++;
  }
  await turn();
}
const voiceTable = () => new Uint8Array(processor.kernel.memory(), processor.kernel.voicesPtr(), 256 * VOICE_SIZE);
const settle = async () => { for (let i = 0; i < 20 && library.status().acknowledged !== library.status().issued; i++) await turn(); };

const galaxy = audio.galaxy;
let checks = 0, starts = 0, maxActive = 0;
const startsSeen = new Set();
for (let f = 0; f < FRAMES; f++) {
  await frame();
  await settle();
  const status = library.status();
  assert.equal(processor.stats.error, null, processor.stats.error);
  assert.equal(processor.stats.fault, 0, `worklet fault 0x${processor.stats.fault.toString(16)}`);
  if (status.acknowledged !== status.issued) continue;
  // The library's Active bits, against the proxy's answers and the channels.
  const active = processor.kernel.active();
  maxActive = Math.max(maxActive, active.toString(2).replaceAll('0', '').length);
  for (let slot = 0; slot < 16; slot++) {
    assert.equal(library.voiceActive(VOICE_BASE + slot * VOICE_SIZE), (active >>> slot) & 1, `frame ${f}: voice ${slot} Active`);
  }
  const table = voiceTable(), view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  galaxy.state.channels.forEach((c, index) => {
    if (!c.voice || c.voice < 0) return;
    assert.equal(voiceSlot(c.voice), index, `channel ${index}'s voice is slot ${index}`);
    const at = index * VOICE_SIZE;
    const sample = audio.voices.get(c.voice)?.sample;
    if (!sample) return;
    startsSeen.add(`${index}:${sample.handle}`);
    assert.equal(view.getUint32(at + 0x42, true), sample.handle, `channel ${index}: SmpHdr is the registered sample`);
    const host = audio.voices.get(c.voice);
    assert.equal(view.getUint32(at + 0x5e, true), host.frequency >>> 0, `channel ${index}: C4Speed`);
    assert.equal(view.getUint16(at + 0x66, true), host.volume & 0xffff, `channel ${index}: SmpVol`);
    assert.equal(view.getUint16(at + 0x14, true), host.pan & 0xffff, `channel ${index}: pan`);
    checks++;
  });
}
const results = processor.kernel.results;
const status = library.status();
assert.equal(results.sampleMismatches, 0, 'sample handles agree');
assert.equal(results.sampleLoads, status.samples, 'every registered sample reached the worklet once');
assert.ok(status.samples > 0, 'some sounds registered');
assert.ok(results.voiceOps > 0, 'voice ops reached the worklet');
assert.ok(peak > 0, 'the output is not silent');
starts = startsSeen.size;
// The listener's zone reverb (UseReverb True in the installed DeusEx.ini):
// Update hands each changed glxReverb over; on a reverb map the SSE engine is
// installed with the setup's parameters for that zone.
const reverbState = processor.kernel.reverbState(), listenerZone = (() => {
  const viewActor = game.player.collisionActor, target = runtime.readNamed(viewActor, 'ViewTarget') ?? viewActor;
  return runtime.readNamed(target, 'Region')?.['engine.actor.pointregion.zone'] ?? null;
})();
const zoneReverb = listenerZone ? Boolean(runtime.readNamed(listenerZone, 'bReverbZone')) : false;
assert.equal(Boolean(reverbState & 1), zoneReverb, `the reverb hook follows the listener zone's bReverbZone (${listenerZone?.name})`);
if (map === '03_NYC_BrooklynBridgeStation') assert.ok(zoneReverb, 'the station is a reverb zone');
// A Player start: SetViewport's StopSound loop stops every voice.
const before = processor.kernel.active();
// Island's start has six ambient voices; Training's first room has none.
if (map !== '00_Training') assert.ok(before, 'voices active before the Player start');
audio.reset();
await settle(); await turn();
assert.equal(processor.kernel.active(), 0, 'the Player start stopped every voice');
for (let i = 0; i < 30; i++) await frame();
await settle();
const afterReset = processor.kernel.active();
// The map dropped: dispose() stops the voices with it.
audio.dispose();
await settle(); await turn();
assert.equal(processor.kernel.active(), 0, 'dispose() stopped every voice');
const notes = [...audio.notes];
const sortedTimes = renderTimes.toSorted((a, b) => a - b), at = q => sortedTimes[Math.min(sortedTimes.length - 1, Math.floor(q * sortedTimes.length))];
const report = {frames: FRAMES, quanta, callbacks: processor.stats.callbacks, batches: status.batches, reports: status.reports,
  samples: status.samples, sampleBytes: status.sampleBytes, voiceOps: results.voiceOps, voiceStarts: starts, maxActive,
  reverb: {zone: listenerZone?.name ?? null, bReverbZone: zoneReverb, calls: results.reverbCalls, installed: Boolean(reverbState & 1)},
  renderUs: {median: Math.round(at(0.5)), p99: Math.round(at(0.99)), max: Math.round(sortedTimes.at(-1))},
  channelChecks: checks, activeBeforeReset: before.toString(2), activeAfterReset: afterReset.toString(2), peak: Number(peak.toFixed(4)), underruns: processor.stats.underruns,
  notes: notes.slice(0, 8)};
console.log(JSON.stringify(report));
process.exit(0);
