/** Speech through Galaxy's voices and lip sync in MeetPaul (docs/galaxy-audio.md
 * "Speech through Galaxy's voices", docs/lip-sync.md), headless.
 *
 * Original Play to the conversation's first choice, as
 * validate-island-conversation runs it. The speech takes the original chain
 * (execPlaySound, CheckHearSound, the player's execClientHearSound) into
 * Galaxy's PlaySound and Update (galaxy-audio.mjs). This harness plays the
 * page's part: each decode request gets ffmpeg's 16-bit decode of the MP3 at
 * its own rate (game.attachSpeech). Headless runs use the host voices (no
 * worklet), whose mixer position is the voice's clock.
 *
 * Checked:
 *  - Paul's speech lands on Galaxy channels with his SLOT_Talk ids, as a
 *    host-decoded sample at the MPEG header's 44100 Hz, and the PCM of every
 *    line is released once no voice plays it;
 *  - the speech voice takes Update's volume and pan for Paul's location in
 *    the listener's (conversation camera's) space: each Update's voice volume
 *    and pan against Galaxy's formulas (docs/galaxy-audio.md Update steps
 *    5-9) recomputed here in doubles from Paul's location, the frame coords
 *    and the channel's radius and volume (the x87 rounding is
 *    validate-native-galaxy-audio's; here within 2 units). MeetPaul's lines
 *    take ConPlay.PlaySpeech's Radius 65536 (bForcePlay, or an uninterruptible
 *    third-person conversation), so the distance barely attenuates them;
 *    validate-island-bark sweeps a bark's Radius 1024 voice over distance and
 *    direction;
 *  - lip sync is Update's step 12 on the same channels: only SLOT_Talk
 *    channels on speaking pawns are analysed, every 0.1 s of channel time
 *    (float sums, as Galaxy stores them), and Paul's Pawn.LipSynch turns the
 *    letters into its mouth blend animations (TweenBlendAnim of Mouth*). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== 'child') {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { console.log('SKIP validate-island-lipsync: ffmpeg is not installed (host MP3 decode for the test)'); process.exit(0); }
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`child failed:\n${child.stderr.slice(-4000)}`);
  const run = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(run.firstError, null, `no runtime error before the choice: ${JSON.stringify(run.firstError)}`);
  assert.ok(run.choice, 'MeetPaul reached its first choice');
  assert.ok(run.paulSpeeches > 0, 'Paul spoke');
  assert.ok(run.paulSlots.length && run.paulSlots.every(slot => slot === 5), `Paul speaks on SLOT_Talk: ${run.paulSlots}`);
  assert.deepEqual(run.nonTalk, [{ emitter: 'JCDentonMale0', slot: 0 }], 'the one non-Talk conversation sound: the DataLink start cue, on JC in SLOT_None');
  // Speech on Galaxy's channels.
  assert.equal(run.paulChannelMisses, 0, 'every speech Paul starts holds a Galaxy channel with its id');
  assert.deepEqual(run.speechRates, [44100], 'speech samples are host-decoded records at the MPEG header rate');
  assert.ok(run.decodes >= run.paulSpeeches, `a decode per started line (${run.decodes})`);
  assert.equal(run.pcmHeldAtEnd, 0, 'no speech PCM is kept once no voice plays it');
  assert.deepEqual(run.notes, [], 'no speech note (silent sample, failed decode)');
  // Volume and pan follow the emitter.
  assert.ok(run.voiceChecks > 200, `Paul's voice checked over many Updates (${run.voiceChecks})`);
  assert.equal(run.voiceMismatches.length, 0, `voice volume/pan follow Galaxy's formulas: ${JSON.stringify(run.voiceMismatches.slice(0, 5))}`);
  assert.deepEqual(run.radii, [65536], "ConPlay.PlaySpeech's Radius 65536 branch");
  assert.ok(run.distance.max - run.distance.min > 20, `the distance varies: ${JSON.stringify(run.distance)}`);
  assert.ok(run.pan.max - run.pan.min > 50, `the pan follows Paul across the camera: ${JSON.stringify(run.pan)}`);
  // Lip sync.
  assert.ok(run.analyses > 20, `analyses ran (${run.analyses})`);
  assert.equal(run.nonTalkAnalysed, 0, 'a non-Talk channel is never analysed');
  assert.equal(run.cadenceErrors, 0, 'each analysis waits for 0.1 s of channel time (float sums)');
  assert.ok(Object.keys(run.paulLetters).length >= 4, `Paul's nextPhoneme varies: ${JSON.stringify(run.paulLetters)}`);
  assert.ok(run.paulMouths.length >= 4, `LipSynch tweens Paul's mouth: ${JSON.stringify(run.paulMouths)}`);
  assert.ok(run.paulMouths.every(name => /^Mouth/.test(name)), 'only mouth sequences in blend slot 0');
  console.log(`PASS validate-island-lipsync: ${run.paulSpeeches} speeches on Galaxy channels, ${run.decodes} decodes; voice volume/pan`
    + ` checked over ${run.voiceChecks} Updates (distance ${run.distance.min.toFixed(0)}-${run.distance.max.toFixed(0)},`
    + ` volume ${run.volume.min}-${run.volume.max}, pan ${run.pan.min}-${run.pan.max}, left ${run.sides.left} / right ${run.sides.right});`
    + ` ${run.analyses} analyses; Paul's letters ${JSON.stringify(run.paulLetters)}; mouths ${run.paulMouths.join(' ')}`);
  process.exit(0);
}

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
const { loadScriptVmKernel } = await import('../src/runtime/script-vm-kernel.mjs');
const { createLipSyncAnalysis, mp3SampleRate } = await import('../src/runtime/galaxy-lipsync-channels.mjs');
const { x87add, x87double, x87load, x87store } = await import('../src/runtime/script-vm.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const decodes = [];
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true,
  onAudioVoice: event => { if (event.op === 'decode') decodes.push(event); } });
const scripts = game.doors.scriptRuntime, runtime = scripts.runtime, audio = runtime.audio, galaxy = audio.galaxy;
const read = (object, name) => runtime.readNamed(object, name);
const paul = runtime.levelFor(game.player.collisionActor).actors.find(a => a?.name === 'PaulDenton0');
assert.equal(audio.galaxyVoices, false, 'headless: the host voices');

let analyses = 0;
const paulLetters = {};
const services = game.lipSyncServices();
audio.setLipSync(createLipSyncAnalysis({ kernel: (await loadScriptVmKernel()).lipsync, ...services,
  setPhoneme(actor, letter) {
    analyses++;
    if (actor === paul) paulLetters[letter] = (paulLetters[letter] ?? 0) + 1;
    return services.setPhoneme(actor, letter);
  } }));

// The page's part: ffmpeg's 16-bit decode at the MP3's own rate.
const dir = mkdtempSync(path.join(tmpdir(), 'island-lipsync-'));
const decode = bytes => {
  writeFileSync(path.join(dir, 'in.mp3'), bytes);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'in.mp3'), '-f', 's16le', '-ac', '1', '-ar', String(mp3SampleRate(bytes)),
    path.join(dir, 'out.raw')]);
  return new Uint8Array(readFileSync(path.join(dir, 'out.raw')));
};

// Galaxy's formulas (Update steps 5-9) in doubles for a speech channel: no
// occlusion test (slot 5), the speech category ratio, the installed
// UseSurround/ReverseStereo False.
const config = audio.galaxyConfig;
function expected(channel, coords) {
  const v = [0, 1, 2].map(i => channel.location[i] - coords.origin[i]);
  const local = [coords.x, coords.y, coords.z].map(axis => v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]);
  const dist = Math.hypot(...local), near = channel.radius * 0.1;
  let angle = Math.atan2(local[0], Math.abs(local[2]));
  if (dist < near) angle *= dist / near;
  const pan = Math.max(0, Math.min(0x7fff, Math.trunc(angle * 28671.125 / Math.PI + 16383)));
  const factor = Math.max(1 - 2 * channel.occlusion, 0.33), sound = config.soundVolume, speech = config.speechVolume;
  const ratio = sound > speech ? speech / sound : sound === speech ? sound / 255 : 1;
  const distanceFactor = Math.max(0, Math.min(1, 1 - dist / channel.radius));
  const volume = Math.max(0x80, Math.max(0, Math.min(0x7fff, Math.trunc(factor * distanceFactor * ratio * channel.volume * 32767))));
  return { volume, pan, dist, lateral: local[0] };
}

// Each Update: the channels' next analysis times before it (cadence) and the
// frame coords it ran on (the volume/pan check).
let cadenceErrors = 0, nonTalkAnalysed = 0, voiceChecks = 0, paulChannelMisses = 0;
const voiceMismatches = [], distance = { min: Infinity, max: -Infinity }, volume = { min: Infinity, max: -Infinity },
  pan = { min: Infinity, max: -Infinity }, sides = { left: 0, right: 0 }, radii = new Set();
const update = galaxy.update;
galaxy.update = (dt, coords) => {
  const before = galaxy.state.channels.map(c => ({ id: c.id, next: c.lipSync, time: c.time }));
  update(dt, coords);
  galaxy.state.channels.forEach((channel, index) => {
    const previous = before[index];
    if (!channel.id || previous.id !== channel.id) return;
    const talk = (channel.id & 0xe) === 10;
    if (!talk && channel.lipSync !== 0) nonTalkAnalysed++;
    if (channel.lipSync !== previous.next) {
      if (channel.lipSync !== x87store(x87add(x87load(previous.next), x87double(0.1)))) cadenceErrors++;
      if (channel.time < previous.next) cadenceErrors++;
    }
    const voice = audio.voices.get(channel.voice);
    if (channel.actor !== paul || !talk || !voice?.playing) return;
    const want = expected(channel, coords);
    voiceChecks++;
    if (Math.abs(voice.volume - want.volume) > 2 || Math.abs(voice.pan - want.pan) > 2)
      voiceMismatches.push({ id: channel.id, got: [voice.volume, voice.pan], want: [want.volume, want.pan] });
    distance.min = Math.min(distance.min, want.dist); distance.max = Math.max(distance.max, want.dist);
    volume.min = Math.min(volume.min, voice.volume); volume.max = Math.max(volume.max, voice.volume);
    pan.min = Math.min(pan.min, voice.pan); pan.max = Math.max(pan.max, voice.pan);
    if (want.lateral > 8 && voice.pan > 16383) sides.right++;
    if (want.lateral < -8 && voice.pan < 16383) sides.left++;
    radii.add(channel.radius);
  });
};

const paulMouths = [], invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  const result = invokeNative(call);
  if (call.receiver === paul && call.index === 1012 && String(call.script?.entry?.path ?? '').toLowerCase() === 'pawn.lipsynch') {
    const sequence = String(read(paul, 'BlendAnimSequence')[0]);
    if (paulMouths.at(-1) !== sequence) paulMouths.push(sequence);
  }
  return result;
};

createPlayerInputFixture(game).key('KeyW', true);
const player = game.player.collisionActor;
let tick = 0, seen = 0, paulSpeeches = 0, decoded = 0, firstError = null, choice = false;
const paulSlots = [], nonTalk = [], speechRates = new Set();
try {
  while (tick < 5200 && !firstError) {
    simulatedMs += 1000 / 60; tick++;
    try {
      game.tick(1 / 60);
      game.hud.commands(1440, 960, game.view());
      for (const request of decodes.splice(0)) { game.attachSpeech(request.sound, decode(request.bytes)); decoded++; }
      const requests = scripts.liveConPlay.soundRequests;
      for (; seen < requests.length; seen++) {
        const request = requests[seen];
        if ((request.id & 0xe) !== 10) nonTalk.push({ emitter: request.emitter?.name ?? null, slot: (request.id >> 1) & 7 });
        if (request.emitter !== paul) continue;
        paulSpeeches++; paulSlots.push((request.id >> 1) & 7);
        const channel = galaxy.state.channels.find(c => c.id === request.id && c.actor === paul);
        if (!channel) { paulChannelMisses++; continue; }
        speechRates.add(audio.samples.get(channel.sound)?.host ? audio.samples.get(channel.sound).rate : null);
      }
      const conPlay = read(player, 'conPlay');
      if (conPlay && runtime.instance(conPlay)?.state?.stateNode?.record?.name === 'WaitForInput' && tick > 2000) { choice = true; break; }
    } catch (error) { firstError = { tick, message: String(error?.message ?? error).split('\n')[0] }; }
  }
  // The conversation goes on past the choice; stop every channel (a Player
  // start's StopSound loop): every line's PCM must be released.
  audio.reset();
} finally { rmSync(dir, { recursive: true, force: true }); }
const pcmHeldAtEnd = [...audio.hostSamples.values()].filter(sample => sample.host.pcm).length;
const notes = [...audio.notes].filter(note => /speech|MP3|ConAudio/i.test(note));
console.log(JSON.stringify({ firstError, choice, tick, analyses, paulSpeeches, paulSlots, nonTalk, nonTalkAnalysed, cadenceErrors, paulLetters, paulMouths,
  paulChannelMisses, speechRates: [...speechRates], decodes: decoded, pcmHeldAtEnd, notes, voiceChecks, voiceMismatches, distance, volume, pan, sides, radii: [...radii],
  speech: audio.speech }));
