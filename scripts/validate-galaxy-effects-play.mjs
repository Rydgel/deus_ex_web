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
 *    with the map (and unregisters the music);
 *  - speech (docs/galaxy-audio.md "Speech through Galaxy's voices"), when
 *    ffmpeg is installed: on a map with PaulDenton0, one of his prepared
 *    speech lines (the shortest) reaches the player's original
 *    execClientHearSound (SLOT_Talk, ConPlay.PlaySpeech's Radius 65536: at
    the map's start Paul is farther than a bark's 1024, where PlaySound's
    priority would be negative and take no channel) and so Galaxy's PlaySound.
 *    Update registers the host-decoded record (loadHostSample, the registry's
 *    handle), starts the voice, which the worklet holds (Active, nothing
 *    mixed) until this harness, in the page's role, answers the decode
 *    request with ffmpeg's 16-bit decode (attachSample). Then the voice table
 *    holds the record with the channel's frequency, volume and pan, the
 *    voice plays on Galaxy's ring transport (the decoder thread's refills),
 *    the reported read head advances through the ring to the PCM's length
 *    past the 4,096-sample head start, the lip-sync window at it holds the
 *    line, the voice ends on its own, the channel frees, and the PCM is
 *    released (releaseSample).
 *
 *   node scripts/validate-galaxy-effects-play.mjs [--map 01_NYC_UNATCOIsland] [--frames 600]
 */
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
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
// The worklet's timer callback cost per 20 ms (host measurement, real time:
// performance.now is the simulated clock here).
const renderTimes = [], callback = processor.kernel.callback;
processor.kernel.callback = (play, write) => { const t = process.hrtime.bigint(); const r = callback(play, write); renderTimes.push(Number(process.hrtime.bigint() - t) / 1000); return r; };

// The page's part for speech: decode requests (script-audio-live.mjs).
const decodes = [];
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true, musicLibrary: library,
  onAudioVoice: event => { if (event.op === 'decode') decodes.push(event); }});
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
let checks = 0, starts = 0, maxActive = 0, heldChecks = 0;
const startsSeen = new Set();
/** One frame's checks; false when a batch is not acknowledged yet. */
function check(f) {
  const status = library.status();
  assert.equal(processor.stats.error, null, processor.stats.error);
  assert.equal(processor.stats.fault, 0, `worklet fault 0x${processor.stats.fault.toString(16)}`);
  if (status.acknowledged !== status.issued) return false;
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
    // A speech start the worklet holds until its decode arrives: Active, not in the table yet.
    if (processor.kernel.heldSlots().includes(index)) { assert.ok(sample.host, 'only a host-decoded record is held'); heldChecks++; return; }
    startsSeen.add(`${index}:${sample.handle}`);
    assert.equal(view.getUint32(at + 0x42, true), sample.handle, `channel ${index}: SmpHdr is the registered sample`);
    const host = audio.voices.get(c.voice);
    assert.equal(view.getUint32(at + 0x5e, true), host.frequency >>> 0, `channel ${index}: C4Speed`);
    assert.equal(view.getUint16(at + 0x66, true), host.volume & 0xffff, `channel ${index}: SmpVol`);
    assert.equal(view.getUint16(at + 0x14, true), host.pan & 0xffff, `channel ${index}: pan`);
    checks++;
  });
  return true;
}
for (let f = 0; f < FRAMES; f++) {
  await frame();
  await settle();
  check(f);
}

// Speech through Galaxy's voices (see the file comment).
let speech = null;
const scripts = game.doors.scriptRuntime, paul = runtime.levelFor(game.player.collisionActor).actors.find(a => a?.name === 'PaulDenton0');
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], {stdio: 'ignore'}); } catch { ffmpeg = false; }
if (paul && ffmpeg) {
  const lines = [...scripts.liveConPlay.sounds.values()].filter(entry => entry.format === 'mp3').sort((a, b) => a.bytes.length - b.bytes.length);
  assert.ok(lines.length, "Paul's conversations prepared speech");
  const line = lines[0], player = game.player.collisionActor, dir = mkdtempSync(path.join(tmpdir(), 'effects-play-speech-'));
  const id = (runtime.soundObjectIndex(paul).index << 4) | 0xa;
  // APawn::execClientHearSound: Volume X*0.01, Radius Y, Pitch Z*0.01; then Galaxy's PlaySound.
  runtime.processNativeEvent(player, 'ClientHearSound', [paul, id, line.sound, runtime.readNamed(paul, 'Location').slice(), [100, 65536, 100]]);
  const channelIndex = galaxy.state.channels.findIndex(c => c.id === id);
  assert.ok(channelIndex >= 0, 'the speech holds a Galaxy channel');
  speech = {sound: line.sound.key, bytes: line.bytes.length, channel: channelIndex, held: 0, played: 0, positions: [], frames: null, freedAt: null,
    audibleWindows: 0};
  try {
    for (let f = 0; f < 900 && speech.freedAt === null; f++) {
      await frame();
      // Before the page's answer: the worklet holds the start (Active, nothing mixed).
      if (decodes.length) {
        await settle();
        if (processor.kernel.heldSlots().includes(channelIndex)) {
          speech.held++;
          assert.equal(library.voiceActive(galaxy.state.channels[channelIndex].voice), 1, 'a held voice is Active to the poll');
        }
      }
      for (const request of decodes.splice(0)) {
        assert.equal(request.sound, speech.sound, 'the decode request is the line\'s');
        writeFileSync(path.join(dir, 'in.mp3'), request.bytes);
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'in.mp3'), '-f', 's16le', '-ac', String(request.channels ?? 1), '-ar', String(request.rate),
          path.join(dir, 'out.raw')]);
        const pcm = new Uint8Array(readFileSync(path.join(dir, 'out.raw')));
        speech.frames = pcm.length / 2 / (request.channels ?? 1);
        assert.ok(game.attachSpeech(request.sound, pcm), 'the PCM is attached while the voice waits');
      }
      await settle();
      if (!check(f)) continue;
      const c = galaxy.state.channels[channelIndex];
      if (c.id !== id) { speech.freedAt = f; break; }
      if (!c.voice) continue;
      if (processor.kernel.heldSlots().includes(channelIndex)) { speech.held++; continue; }
      // The read head is the ring's (ring.rs): the line's samples start 0x2000
      // bytes (4,096 samples) past the read head of the first refill post.
      const position = library.voicePosition(c.voice);
      if (position === null) continue;
      speech.played++;
      assert.ok(position >= (speech.positions.at(-1) ?? 0) && position < 0x7fff, `read head ${position} within the ring's first lap`);
      speech.positions.push(position);
      const window = library.voiceWindow(c.voice);
      if (window && new Int16Array(window.bytes.buffer, 0, window.available).some(v => v !== 0)) speech.audibleWindows++;
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
  const sample = audio.hostSamples.get(speech.sound), results = processor.kernel.results;
  assert.ok(speech.held > 0, 'the worklet held the start until the decode arrived');
  assert.ok(speech.played > 10, `the voice played through the mixer (${speech.played} frames)`);
  assert.ok(speech.positions.at(-1) > 4096 + speech.frames * 0.8, `the read head reached the end (${speech.positions.at(-1)} of 4096 + ${speech.frames})`);
  assert.ok(speech.audibleWindows > 0, 'the lip-sync window at the read head held the decoded line');
  assert.notEqual(speech.freedAt, null, 'the voice ended on its own and Update freed the channel');
  assert.equal(sample.rate, 44100, 'the record\'s rate is the MPEG header\'s');
  assert.ok(processor.stats.refills > 0, 'the decoder thread took refill posts');
  assert.deepEqual([results.hostSamples, results.attaches, results.heldStarts, results.releases], [1, 1, 1, 1],
    'one record, one attach, the held start run, one release');
  assert.equal(sample.host.pcm, null, 'the simulation dropped the PCM with the voice');
  speech.positions = speech.positions.length;
} else console.log(`${map}: speech phase skipped (${paul ? 'ffmpeg is not installed' : 'no PaulDenton0'})`);
const results = processor.kernel.results;
const status = library.status();
assert.equal(results.sampleMismatches, 0, 'sample handles agree');
assert.equal(results.sampleLoads, status.samples, 'every registered sample reached the worklet once');
assert.ok(status.samples > 0, 'some sounds registered');
assert.ok(results.voiceOps > 0, 'voice ops reached the worklet');
assert.ok(peak > 0, 'the output is not silent');
assert.equal(processor.stats.resyncs, 1, 'one resync: the first timer callback');
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
  // The first callback is the start-up resync: size − D bytes rendered at once (output.rs).
  renderUs: {median: Math.round(at(0.5)), p99: Math.round(at(0.99)), max: Math.round(sortedTimes.at(-1)), first: Math.round(renderTimes[0])},
  resyncs: processor.stats.resyncs,
  channelChecks: checks, heldChecks, speech, activeBeforeReset: before.toString(2), activeAfterReset: afterReset.toString(2), peak: Number(peak.toFixed(4)), underruns: processor.stats.underruns,
  notes: notes.slice(0, 8)};
console.log(JSON.stringify(report));
process.exit(0);
