/** Window.PlaySound reaching Galaxy in Play (docs/script-window-sound.md "Play").
 *
 * The original native (Extension 0x10050050) ends in
 * `pawn->XLevel->Engine->Audio->PlaySound(None, 0, Sound, Location, Volume,
 * 100, Pitch)` (vtable +0x74); validate-window-sound compares every argument
 * with the original body. Here the same request must reach Galaxy's
 * translated PlaySound (validate-native-galaxy-audio) through the linked
 * `XLevel->Engine->Audio` of the live Training level: reading Training's
 * DataCube0 runs DeusExPlayer.AddNote -> HUD log message -> the original
 * LogNoteAdded window sound.
 *
 *  - the window request and Galaxy's PlaySound call carry the same arguments
 *    (no actor, id 0, the sound, location, volume, radius 100, pitch);
 *  - id 0 has slot bits 0, so Galaxy takes its counter id `--counter << 4`
 *    and a channel records the sound with no actor;
 *  - Location is the player's plus a unit vector (the pan rotation is zero
 *    for the HUD log's centred window), and Volume is the log's .75 scaled
 *    by 100/99;
 *  - the next Update starts a voice for it (Galaxy's own, 2D);
 *  - a level whose Audio is None skips the call, as the original's null test.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-window-sound-play: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const scripts = game.doors.scriptRuntime, runtime = scripts.runtime, host = scripts.windowHost;
const player = game.player.collisionActor, level = runtime.levelFor(player);
const input = createPlayerInputFixture(game);
const get = (object, name) => runtime.namedReference(object, name).get();
const live = name => level.actors.find(actor => actor?.name === name);
const galaxy = runtime.audio.galaxy;
const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value); return view.getUint32(0); };
const soundName = sound => String(sound?.key ?? sound?.name ?? sound);

// Spy on the linked subsystem; the real PlaySound still runs.
const calls = [];
const audio = level.engine.audio, playSound = audio.playSound;
audio.playSound = (...args) => { const result = playSound(...args); calls.push({args, result}); return result; };

input.tick(30);
const requestsBefore = host.soundRequests.length;
const cube = live('DataCube0');
const side = 48 * Math.SQRT1_2;
const location = get(cube, 'Location');
const counterBefore = galaxy.state.counter;
const result = await input.frob(cube, {position: [location[0] - side, location[1] - side, location[2]]});
assert.deepEqual(result, {ok: true, message: ''});

const requests = host.soundRequests.slice(requestsBefore);
const note = requests.find(request => /lognoteadded/i.test(soundName(request.sound)));
assert.ok(note, `the log note window sound: ${requests.map(request => soundName(request.sound)).join(', ')}`);
// Actor sounds (the player's own, ClientHearSound) reach the same subsystem;
// a window request is the call with no actor and id 0, in order.
const windowCalls = calls.filter(call => call.args[0] === null && call.args[1] === 0);
assert.equal(windowCalls.length, requests.length, 'one Galaxy PlaySound per window request');
requests.forEach((request, i) => {
  const [actor, id, sound, at, volume, radius, pitch] = windowCalls[i].args;
  assert.equal(actor, null, 'no actor');
  assert.equal(id, 0, 'id 0');
  assert.ok(sound === request.sound, 'the requested sound');
  assert.deepEqual(at.map(bits), request.location.map(bits), 'location');
  assert.equal(bits(volume), bits(request.volume));
  assert.equal(radius, 100);
  assert.equal(bits(pitch), bits(request.pitch));
  assert.equal(request.played, windowCalls[i].result, 'the request records Galaxy\'s result');
});
const noteCall = windowCalls[requests.indexOf(note)];
assert.equal(noteCall.result, true, 'a free channel took the log note sound');
// HUDLogDisplay.AddLog passes .75; the body scales it by 100/99 (float32).
assert.equal(bits(note.requestedVolume), bits(.75));
assert.equal(bits(note.volume), bits(Math.fround(.75 * (100 / 99))));
const eye = get(player, 'Location');
const offset = note.location.map((v, i) => v - eye[i]);
assert.ok(Math.abs(Math.hypot(...offset) - 1) < 1e-3 && offset[2] === 0, `a unit offset from the pawn: ${offset}`);
// Galaxy's counter id, slot 0, in the channel record.
const channel = galaxy.state.channels.find(c => c.sound === note.sound);
assert.ok(channel, 'a channel holds the log note sound');
assert.equal(channel.actor, null);
assert.equal(channel.id & 0xe, 0, 'slot bits are zero');
assert.equal(channel.id, (galaxy.state.counter << 4) | 0, 'the counter id');
assert.ok(galaxy.state.counter < counterBefore, 'the counter was decremented');
assert.equal(channel.radius, 100);

// The next Update starts a Galaxy voice for the channel.
const voicesBefore = runtime.audio.voices.size;
game.hud.commands(800, 600, game.view());
const view = game.view();
runtime.audio.update(view);
assert.ok(channel.voice !== null && runtime.audio.voices.has(channel.voice), 'Update started a voice for the window sound');
assert.ok(runtime.audio.voices.size > voicesBefore, 'the voice table grew');
const started = runtime.audio.voices.get(channel.voice);
assert.ok(started.sample.bytes || started.sample.handle, 'the host decoded the UI sound\'s sample');
assert.ok(![...runtime.audio.notes].some(text => /lognoteadded/i.test(text)), `no sample note: ${[...runtime.audio.notes]}`);
assert.ok(started.volume > 0 && started.frequency > 0, `voice ${JSON.stringify({volume: started.volume, frequency: started.frequency, pan: started.pan})}`);

// A level without an Audio subsystem skips the call (the original's null test).
level.engine.audio = null;
const before = calls.length;
host.W.native.playSound(get(get(player, 'rootWindow'), 'hud'), note.sound, .75, 1);
assert.equal(calls.length, before, 'no Audio, no PlaySound call');
level.engine.audio = audio;
console.log(`window sound in Play: ${requests.length} request(s) reached Galaxy with the original arguments; ` +
  `channel id ${channel.id}, voice volume ${started.volume} pan ${started.pan} frequency ${started.frequency}`);
