/** An NPC bark in Play through the original BarkManager path
 * (docs/script-conversation-binding.md, "Loaded graph").
 *
 * 01_NYC_UNATCOIsland, with the player placed in front of ComputerSecurity1
 * as validate-terminals-play.mjs approaches it: Terrorist18 (BarkBindName
 * Terrorist) sees the player, and ScriptedPawn.Attacking calls
 * DeusExPlayer.StartAIBarkConversation -> BarkManager.StartBark. StartBark
 * finds Terrorist_BarkTargetAcquired in the pawn's ConListItems, and
 * ConPlayBark.GetBarkSpeech walks its eventList from a ConEventRandomLabel
 * head. Before the mission list's load attached its whole graph, that read
 * threw "Object is not attached to script runtime:
 * deusexcontext.coneventrandomlabel1085" at tick ~527.
 *
 * Checks:
 *  - The list's prepared graph is exactly the closure of the serialized
 *    ObjectProperty references from ConList_Mission01 (what IndexToObject and
 *    EndLoad load), computed here from the package bytes.
 *  - 620 ticks after the placement run without error.
 *  - The bark starts: a current bark slot holds Terrorist18,
 *    Terrorist_BarkTargetAcquired and BM_TargetAcquired; GetSpeechAudio found
 *    the speech's sound (PlaySound's channel id, assigned only in that branch,
 *    is nonzero, and the duration is GetSpeechLength's, not the text pause);
 *    and the HUD bark display shows one item whose text is a ConSpeech of that
 *    conversation.
 *  - The bark's speech plays through Galaxy (docs/galaxy-audio.md "Speech
 *    through Galaxy's voices"): PlaySound(speech, SLOT_Talk, , , 1024) holds a
 *    channel with the returned id, whose sample is a host-decoded MP3 record
 *    at the MPEG header's 44100 Hz (before, the MP3 failed glxLoadSample's
 *    WAVE path and the bark was silent). With the clock held, the listener's
 *    view is swept around Terrorist18 (distances 64..1100 straight on, and
 *    turned 60 degrees either way): each Update's voice volume and pan equal
 *    Galaxy's formulas (Update steps 5-9) recomputed in doubles from the
 *    emitter's location and the frame coords (within 2 units; the x87
 *    rounding is validate-native-galaxy-audio's), the volume falls with the
 *    distance to the 0x80 floor at the radius, the pan is centred straight on
 *    and moves to the side the emitter is on. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import { readObject, exportAt } from '../src/unreal/objects.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {hostNow, setHostClock} from '../src/runtime/host-clock.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, W = game.hud.host.W, player = game.player.collisionActor;
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const input = createPlayerInputFixture(game, {paint});
const rd = (object, name) => runtime.readNamed(object, name);

// The mission list's load: every export reached through serialized
// ObjectProperty references (the exports' Outers are the package root).
const conText = await assets.get('DeusExConText'), pkg = conText.pkg;
const listIndex = conText.exportsByPath.get('conlist_mission01');
const closure = new Set([listIndex]);
for (const queue = [listIndex]; queue.length;) {
  const index = queue.pop();
  assert.equal(exportAt(pkg, index).outer, 0);
  for (const property of readObject(pkg, conText.bytes, index).properties)
    if (property.type === 5 && property.value > 0 && !closure.has(property.value)) { closure.add(property.value); queue.push(property.value); }
}
const prepared = runtime.conversationListObjects.get('deusexcontext.conlist_mission01');
assert.deepEqual(new Set(prepared.map(object => object.index)), closure, 'the prepared list graph is its serialized closure');
const exportNamed = name => runtime.objects.resolve(conText, conText.exportsByPath.get(name));
const [barkConversation, randomLabel] = await Promise.all([exportNamed('conversation1810'), exportNamed('coneventrandomlabel1085')]);
assert.equal(rd(barkConversation, 'conName'), 'Terrorist_BarkTargetAcquired');
assert.equal(rd(barkConversation, 'eventList'), randomLabel);
assert.ok(runtime.instances.has(randomLabel), 'the bark ConEventRandomLabel is attached at load');

input.tick(30);
const level = runtime.levelFor(player);
const computer = level.actors.find(a => a?.name === 'ComputerSecurity1');
const at = rd(computer, 'Location'), yaw = rd(computer, 'Rotation')[1] * Math.PI / 32768;
runtime.farMoveActor(player, [at[0] + Math.cos(yaw) * 56, at[1] + Math.sin(yaw) * 56, at[2]], 0, 1);

const barkManager = rd(player, 'BarkManager');
const field = (info, name) => info[`deusex.barkmanager.barkinfo.${name}`];
const hud = rd(rd(player, 'rootWindow'), 'hud'), barkDisplay = rd(hud, 'barkDisplay');
// The bark's speech on Galaxy's channel, and its voice against the listener,
// checked on the tick the bark starts (the bark plays for its duration).
const audio = runtime.audio, galaxy = audio.galaxy;
let sweep = null;
function sweepBark(channel) {
  assert.ok(rd(channel.actor, 'BarkBindName') || rd(channel.actor, 'BindName'), 'the bark channel is a pawn\'s');
  assert.equal((channel.id >> 1) & 7, 5, 'SLOT_Talk');
  assert.equal(channel.radius, 1024, 'BarkManager.StartBark plays it with Radius 1024');
  const sample = audio.samples.get(channel.sound);
  assert.ok(sample?.host, 'the speech sample is a host-decoded MP3 record');
  assert.equal(sample.rate, 44100, 'at the MPEG header rate (the MPEG loader\'s record +0x3c)');
  assert.deepEqual([...audio.notes].filter(note => note.includes(channel.sound.key)), [], 'no note of a silent speech sample');
  let coords = null;
  const update = galaxy.update;
  galaxy.update = (dt, frameCoords) => { coords = frameCoords; return update(dt, frameCoords); };
  // Galaxy's Update steps 5-9 in doubles for a speech channel (no occlusion
  // test, the speech ratio, the installed UseSurround/ReverseStereo False).
  const config = audio.galaxyConfig;
  function expected() {
    const v = [0, 1, 2].map(i => channel.location[i] - coords.origin[i]);
    const local = [coords.x, coords.y, coords.z].map(axis => v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]);
    const dist = Math.hypot(...local), near = channel.radius * 0.1;
    let angle = Math.atan2(local[0], Math.abs(local[2]));
    if (dist < near) angle *= dist / near;
    const pan = Math.max(0, Math.min(0x7fff, Math.trunc(angle * 28671.125 / Math.PI + 16383)));
    const factor = Math.max(1 - 2 * channel.occlusion, 0.33), sound = config.soundVolume, speech = config.speechVolume;
    const ratio = sound > speech ? speech / sound : sound === speech ? sound / 255 : 1;
    const volume = Math.max(0x80, Math.min(0x7fff, Math.trunc(factor * Math.max(0, Math.min(1, 1 - dist / channel.radius)) * ratio * channel.volume * 32767)));
    return {volume, pan, lateral: local[0]};
  }
  // The listener's view at `distance` from the emitter on the line from the
  // player, turned by `turn` degrees; the clock held, so the voice keeps playing.
  const emitter = channel.location.slice(), from = rd(player, 'Location');
  const heading = Math.atan2(emitter[1] - from[1], emitter[0] - from[0]);
  setHostClock({now: hostNow(), date: Date.now()});
  sweep = [];
  try {
    for (const turn of [0, -60, 60]) for (const distance of [64, 200, 400, 600, 800, 950, 1100]) {
      const location = [emitter[0] - Math.cos(heading) * distance, emitter[1] - Math.sin(heading) * distance, emitter[2]];
      const yaw = Math.round((heading + turn * Math.PI / 180) * 32768 / Math.PI) & 0xffff;
      game.hud.commands(1432, 1268, {location, rotation: [0, yaw, 0], fov: 75});
      const voice = audio.voices.get(channel.voice);
      assert.ok(voice?.playing && galaxy.state.channels.includes(channel), `the bark voice plays at ${distance}/${turn}`);
      sweep.push({turn, distance, volume: voice.volume, pan: voice.pan, want: expected()});
    }
  } finally { setHostClock(null); galaxy.update = update; }
  for (const {turn, distance, volume, pan, want} of sweep) {
    assert.ok(Math.abs(volume - want.volume) <= 2 && Math.abs(pan - want.pan) <= 2,
      `voice at ${distance} turned ${turn}: volume ${volume} pan ${pan}, Galaxy's formulas give ${want.volume} ${want.pan}`);
  }
  const ahead = sweep.filter(entry => entry.turn === 0);
  for (let i = 1; i < ahead.length; i++) assert.ok(ahead[i].volume < ahead[i - 1].volume || ahead[i].volume === 0x80, 'the volume falls with the distance');
  assert.equal(ahead.at(-1).volume, 0x80, 'past the radius: the 0x80 floor');
  assert.ok(ahead.every(entry => Math.abs(entry.pan - 16383) <= 2), 'straight on: the pan is centred');
  for (const entry of sweep.filter(entry => entry.turn !== 0 && entry.distance >= 200))
    assert.ok(Math.sign(entry.pan - 16383) === Math.sign(entry.want.lateral) && Math.abs(entry.pan - 16383) > 4000,
      `turned ${entry.turn} at ${entry.distance}: the pan (${entry.pan}) is on the emitter's side`);
  const near = sweep.find(entry => entry.turn === 60 && entry.distance === 64), far = sweep.find(entry => entry.turn === 60 && entry.distance === 200);
  assert.ok(Math.abs(near.pan - 16383) < Math.abs(far.pan - 16383), 'inside 0.1 Radius the pan narrows toward the centre');
}
let bark = null;
let barkChannel = null;
for (let tick = 0; tick < 620; tick++) {
  input.tick(1);
  // The first bark the player hears (a SLOT_Talk channel of a BarkManager
  // slot's PlaySound id): Terrorist18's own reaches no listener from here
  // (CheckHearSound), another terrorist's does.
  if (!barkChannel) {
    const ids = new Set(rd(barkManager, 'currentBarks').map(info => field(info, 'playingsoundid')).filter(Boolean));
    barkChannel = galaxy.state.channels.find(c => ids.has(c.id) && (c.id & 0xe) === 10) ?? null;
    if (barkChannel) sweepBark(barkChannel);
  }
  if (bark) continue;
  // Terrorist18's bark: with the AI event manager (docs/ai-event-manager.md) the other terrorists hear the placed player too, and one of
  // them may bark first (Terrorist30's BM_PreAttackSearching), so the slot is chosen by its pawn.
  const slot = rd(barkManager, 'currentBarks').find(info => field(info, 'barkpawn')?.name === 'Terrorist18');
  if (!slot) continue;
  const winBarks = rd(barkDisplay, 'winBarks'), item = W.ptr(winBarks, 0x13c);
  bark = {tick, pawn: field(slot, 'barkpawn').name, conName: field(slot, 'conname'), mode: field(slot, 'barkmode'),
    duration: field(slot, 'barkduration'), soundId: field(slot, 'playingsoundid'), count: rd(barkDisplay, 'barkCount'),
    text: item ? W.heap.read(rd(item, 'winBark'), 0x168, 'string') : null};
}
assert.ok(bark, 'a bark starts within 620 ticks');
assert.deepEqual([bark.pawn, bark.conName, bark.mode], ['Terrorist18', 'Terrorist_BarkTargetAcquired', 3],
  'Terrorist18 barks Terrorist_BarkTargetAcquired (BM_TargetAcquired)');
const speeches = [];
for (let event = randomLabel; event; event = rd(event, 'nextEvent')) {
  const speech = runtime.lookupMember(runtime.instance(event).cls, 'fields', 'conSpeech') && rd(event, 'conSpeech');
  if (speech) speeches.push({text: rd(speech, 'speech'), soundId: rd(speech, 'soundID')});
}
const spoken = speeches.find(speech => speech.text === bark.text);
assert.ok(spoken, `the bark display shows a speech of the conversation: ${JSON.stringify(bark.text)}`);
assert.ok(bark.count >= 1, 'a bark item is shown');
assert.notEqual(spoken.soundId, -1);
assert.notEqual(bark.soundId, 0, "GetSpeechAudio found the speech's sound and PlaySound returned its channel");
const textPause = Math.max(bark.text.length * rd(barkManager, 'perCharDelay'), rd(barkManager, 'minimumTextPause'));
assert.ok(bark.duration > 0 && bark.duration !== Math.fround(textPause), 'the duration is GetSpeechLength of the sound');

const row = turn => sweep.filter(entry => entry.turn === turn).map(entry => `${entry.distance}:${entry.volume}/${entry.pan}`).join(' ');
console.log(`island-bark: list graph ${closure.size} objects; tick ${bark.tick} ${bark.pawn} ${bark.conName} ` +
  `"${bark.text}" (ConAudioAIBarks_${spoken.soundId}, ${bark.duration.toFixed(3)} s, channel ${bark.soundId}); 620 ticks`);
assert.ok(sweep, 'a bark the player hears held a Galaxy channel');
console.log(`island-bark: ${barkChannel.actor.name}'s bark ${barkChannel.sound.key} on Galaxy channel ${barkChannel.id};`
  + ` speech voice volume/pan by distance, straight on ${row(0)}; turned -60 ${row(-60)}; turned 60 ${row(60)}`);
process.exit(0);
