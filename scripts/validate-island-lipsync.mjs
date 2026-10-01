/** Lip sync in MeetPaul (docs/lip-sync.md), headless.
 *
 * Original Play to the conversation's first choice, as
 * validate-island-conversation runs it. The speech the player hears goes
 * through Galaxy's lip-sync channels (galaxy-lipsync-channels.mjs) with the
 * Rust analysis (validate-galaxy-lipsync compares it with Galaxy.dll); the
 * host inputs are ffmpeg's 16-bit decode of each speech MP3 at its own rate
 * and the channel's own time as the mixer position. Checked: only SLOT_Talk
 * channels on speaking pawns are analysed, every 0.1 s of channel time
 * (float sums, as Galaxy stores them), and Paul's Pawn.LipSynch turns the
 * letters into its mouth blend animations (TweenBlendAnim of Mouth*). */
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
  assert.ok(run.analyses > 20, `analyses ran (${run.analyses})`);
  assert.ok(run.paulSlots.length && run.paulSlots.every(slot => slot === 5), `Paul speaks on SLOT_Talk: ${run.paulSlots}`);
  assert.deepEqual(run.nonTalk, [{ emitter: 'JCDentonMale0', slot: 0 }], 'the one non-Talk speech: the opening DataLink, on JC in SLOT_None');
  assert.equal(run.nonTalkAnalysed, 0, 'a non-Talk channel is never analysed');
  assert.equal(run.cadenceErrors, 0, 'each analysis waits for 0.1 s of channel time (float sums)');
  assert.ok(Object.keys(run.paulLetters).length >= 4, `Paul's nextPhoneme varies: ${JSON.stringify(run.paulLetters)}`);
  assert.ok(run.paulMouths.length >= 4, `LipSynch tweens Paul's mouth: ${JSON.stringify(run.paulMouths)}`);
  assert.ok(run.paulMouths.every(name => /^Mouth/.test(name)), 'only mouth sequences in blend slot 0');
  console.log(`PASS validate-island-lipsync: ${run.analyses} analyses over ${run.paulSpeeches} speeches; Paul's letters ${JSON.stringify(run.paulLetters)}; mouths ${run.paulMouths.join(' ')}`);
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
const { createLipSyncChannels, mp3SampleRate } = await import('../src/runtime/galaxy-lipsync-channels.mjs');
const { x87add, x87double, x87load, x87store } = await import('../src/runtime/script-vm.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const scripts = game.doors.scriptRuntime, runtime = scripts.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const paul = runtime.levelFor(game.player.collisionActor).actors.find(a => a?.name === 'PaulDenton0');

const kernel = (await loadScriptVmKernel()).lipsync;
const services = game.lipSyncServices();
let analyses = 0, nonTalkAnalysed = 0, cadenceErrors = 0;
const paulSlots = [], nonTalk = [];
const paulLetters = {};
const counted = {
  ...services,
  setPhoneme(actor, letter) {
    analyses++;
    if (actor === paul) paulLetters[letter] = (paulLetters[letter] ?? 0) + 1;
    return services.setPhoneme(actor, letter);
  },
};
const channels = createLipSyncChannels({ kernel, ...counted });
const dir = mkdtempSync(path.join(tmpdir(), 'island-lipsync-'));
const decode = bytes => {
  writeFileSync(path.join(dir, 'in.mp3'), bytes);
  const rate = mp3SampleRate(bytes);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'in.mp3'), '-f', 's16le', '-ac', '1', '-ar', String(rate), path.join(dir, 'out.raw')]);
  return { pcm: new Uint8Array(readFileSync(path.join(dir, 'out.raw'))), rate };
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
let tick = 0, seen = 0, paulSpeeches = 0, firstError = null, choice = false;
try {
  while (tick < 5200 && !firstError) {
    simulatedMs += 1000 / 60; tick++;
    try {
      game.tick(1 / 60);
      game.hud.commands(1440, 960, game.view());
      const requests = scripts.liveConPlay.soundRequests;
      for (; seen < requests.length; seen++) {
        const request = requests[seen];
        if (request.kind === 'stop') { channels.stop(request.id); continue; }
        channels.start(request);
        if ((request.id & 0xe) !== 10) nonTalk.push({ emitter: request.emitter?.name ?? null, slot: (request.id >> 1) & 7 });
        if (request.emitter === paul) { paulSpeeches++; paulSlots.push((request.id >> 1) & 7); }
        const { pcm, rate } = decode(request.audio.bytes), pitch = request.parameters[2] / 100;
        const channel = channels.channels.get(request.id);
        channels.attach(request.id, { pcm, rate, position: () => channel.time * rate * pitch });
      }
      const before = new Map([...channels.channels].map(([id, c]) => [id, c.next]));
      channels.update(1 / 60);
      for (const [id, channel] of channels.channels) {
        const previous = before.get(id);
        if (previous !== undefined && channel.next !== previous
          && channel.next !== x87store(x87add(x87load(previous), x87double(0.1)))) cadenceErrors++;
        if (previous !== undefined && channel.next !== previous && channel.time < previous) cadenceErrors++;
        if ((id & 0xe) !== 10 && channel.next !== 0) nonTalkAnalysed++;
      }
      const conPlay = read(player, 'conPlay');
      if (conPlay && runtime.instance(conPlay)?.state?.stateNode?.record?.name === 'WaitForInput' && tick > 2000) { choice = true; break; }
    } catch (error) { firstError = { tick, message: String(error?.message ?? error).split('\n')[0] }; }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify({ firstError, choice, tick, analyses, paulSpeeches, paulSlots, nonTalk, nonTalkAnalysed, cadenceErrors, paulLetters, paulMouths }));
