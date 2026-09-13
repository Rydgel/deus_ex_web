/** Validate the complete source-backed 00_Training DataLink catalog. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadTrainingDataLinkCatalog } from '../src/runtime/script-training-datalinks.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(`${root}/${directory}`)) {
    files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  }
}

const catalog = await loadTrainingDataLinkCatalog(new AssetStore(files));
assert.deepEqual(catalog.counts, { missionConItems: 70, trainingTriggers: 18 });
assert.equal(catalog.source.mapPackage, '00_Training');
assert.equal(catalog.source.conversationPackage, 'DeusExConText');
assert.equal(catalog.source.audioPackage, 'DeusExConAudioMission00');
assert.equal(catalog.source.conversationList.objectName, 'ConList_Mission00');
assert.equal(catalog.speaker.bindName, 'JaimeReyes');
assert.equal(catalog.speaker.displayName, 'Jaime Reyes');
assert.equal(catalog.speaker.portrait.objectName.toLowerCase(), 'infoportraits.jaimereyes');
assert.equal(catalog.speaker.portrait.exportIndex, 28);
assert.equal(catalog.speaker.portrait.width, 64);
assert.equal(catalog.speaker.portrait.height, 64);
assert.equal(catalog.speaker.portrait.rgbaSha256,
  'b2811f056a7c9af1990351a6593708bd4d0244402c1f6de2492b716d5954d0ef');

const expected = new Map([
  ['dl_start', {
    trigger: 'DataLinkTrigger23', conversation: 'DL_Start', event: 32934, speech: 32839,
    end: 32549, soundId: 79, bytes: 43056,
    sha256: 'f6367c840ed5988bd8d845125e67011d272799f5ec986039117c2634a8e2760c',
    seconds: 7.176000118255615, location: [-811.6166381835938, 832.4313354492188, -75.06744384765625], radius: 300, height: 20,
    text: "I figured you'd be sick of drills by now.  Hopefully our training exercises will be more interesting than what they've had you doing at the Academy.",
  }],
  ['dl_door', {
    trigger: 'DataLinkTrigger24', conversation: 'DL_door', event: 43413, speech: 43382,
    end: 43351, soundId: 41, bytes: 26052,
    sha256: '53414c07a3ed032cb344ab7f353f5b98ab8f732ddb8ca04d3f4d244e3f02d529',
    seconds: 4.3420000076293945, location: [-309.72412109375, 840.97705078125, -78.4474868774414], radius: 150, height: 20,
    text: 'Open the door by clicking the right mouse button.  The right button uses items in the world.',
  }],
  ['dl_key', {
    trigger: 'DataLinkTrigger4', conversation: 'DL_key', event: 41700, speech: 41673,
    end: 41646, soundId: 52, bytes: 61620,
    sha256: 'e893cab5ee815b04272fd075710064b0bedf10318efdc7e88502be638296a452',
    seconds: 10.270000457763672, location: [385.21337890625, 849.000732421875, -148.44747924804688], radius: 200, height: 20,
    text: 'The key on the desk opens encryption-based nanotech locks.  When you pick it up, it will automatically be added to your key ring.  Use the key ring to unlock the door and proceed to the next area.',
  }],
  ['dl_crate', {
    trigger: 'DataLinkTrigger31', conversation: 'DL_crate', event: 44977, speech: 44950,
    end: 44923, soundId: 32, bytes: 42588,
    sha256: 'df082f97199a5727c88575b34bbfdc1380f7faf1602276e0b01a5b38a2c355f4',
    seconds: 7.0980000495910645, location: [1067, 127.830078125, -72.44747924804688], radius: 200, height: 20,
    text: "Now pick up a weapon and try to break open those crates.  One of them's indestructible, but the others contain things you might find useful.",
  }],
  ['dl_keypad', {
    trigger: 'DataLinkTrigger7', conversation: 'DL_keypad', event: 41565, speech: 41535,
    end: 41507, soundId: 53, bytes: 79872,
    sha256: 'e5141ef051db4c40af291cc9111db82363e34537c47b01ed4ecbbf545cdae9b1',
    seconds: 13.312000274658203, location: [1737.743896484375, 852.53564453125, -141.44747924804688], radius: 200, height: 20,
    text: 'The code to the door has been stored in that datacube.  Right-click on the datacube to read the contents, then type the code into the keypad.  You activate the keypad with the right mouse button, just like you activate a datacube or any object in the world.',
  }],
  ['dl_dark', {
    trigger: 'DataLinkTrigger8', conversation: 'DL_dark', event: 44701, speech: 44674,
    end: 44647, soundId: 34, bytes: 56004,
    sha256: 'bd5392b25a71cd07b1d0796d1d2d950a5b5359754e80e69f0c03e6af1b98dde8',
    seconds: 9.333999633789062, location: [4264.26611328125, 846.0478515625, -141.44747924804688], radius: 200, height: 20,
    text: "You can bet this won't be the last time we send you into a dark room.  Turn on your light augmentation and find the exit on the other side.  Just press F12, by default.",
  }],
  ['dl_part2', {
    trigger: 'DataLinkTrigger9', conversation: 'DL_part2', event: 39412, speech: 39385,
    end: 39355, soundId: 67, bytes: 110292,
    sha256: 'a93e6eb373cbaa4660987f5e853f64ba1c5493dc5dea1867accb832d65b76300',
    seconds: 18.381999969482422, location: [5465.376953125, 549.596435546875, -141.44747924804688], radius: 200, height: 20,
    text: "Congratulations, you completed Phase 1.  Move over the ramp into the next rooms to begin learning movement skills.  We'll be watching you through the cameras, like the one you can see up in the corner.  In the field, remember that terrorists sometimes use cameras like this in their security-grids to set off alarms and alert guards to your location.",
  }],
  ['dl_jump', {
    trigger: 'DataLinkTrigger10', conversation: 'DL_jump', event: 41851, speech: 41811,
    end: 41784, soundId: 51, bytes: 37908,
    sha256: '80cc18540327f5239fd74fba816a9971c7d2729bf06afac746aa168afda0c72f',
    seconds: 6.317999839782715, location: [6991.212890625, -54.746337890625, 5.552521228790283], radius: 200, height: 20,
    text: "Jump across the platforms.  You'll have to crouch to get under those pipes.  If you fall use the stairs to begin again.",
  }],
  ['dl_ladder', {
    trigger: 'DataLinkTrigger11', conversation: 'DL_ladder', event: 41417, speech: 41390,
    end: 41360, soundId: 54, bytes: 34476,
    sha256: 'a2072c3a2364a55a5ea499612c1eab5e7685507e063e936e880d3420ad6f68ad',
    seconds: 5.745999813079834, location: [6991.9658203125, -2362.698974609375, 5.552521228790283], radius: 200, height: 20,
    text: 'Now go up the ladder at the other end of the room.  By default, you look up and use the arrow keys to climb.',
  }],
  ['dl_swim', {
    trigger: 'DataLinkTrigger12', conversation: 'DL_swim', event: 27188, speech: 27151,
    end: 27050, soundId: 86, bytes: 133380,
    sha256: 'f7fa3017e02c3aa55718c6973b6380731cba3c1248afd1a6ffa3688b86823607',
    seconds: 22.229999542236328, location: [6538.2646484375, -4009.103515625, 5.552521228790283], radius: 200, height: 20,
    text: "We get some complaints about this swimming obstacle because the water's contaminated.  Recruits forget to grab the HazMat suit and end up in my office.  Not pretty.  Or they forget that they have to put the suit on by selecting it and pressing the left mouse button.  Remember that the HazMat is disposable; you can wear it only once, and it operates only for a fixed duration.  Use the ramp on the other side of the pool to climb out.",
  }],
  ['dl_multitool', {
    trigger: 'DataLinkTrigger18', conversation: 'DL_multitool', event: 40269, speech: 40241,
    end: 40207, soundId: 61, bytes: 107796,
    sha256: 'd6a40b88007b93e06fc555981566ded2b5a4e046810fb587483a8997c3b46dc6',
    seconds: 17.965999603271484, location: [2315.950439453125, 826.298583984375, -151.89956665039062], radius: 200, height: 40,
    text: "Use the disposable multitools on the table to hack the keypad up ahead.  A multitool's resources are finite.  When a tool is depleted, it becomes useless.  The manual describes other uses for the multitool.  At higher skill levels, you'll need less time and multitool resources to hack a given device.",
  }],
  ['dl_repairbot', {
    trigger: 'DataLinkTrigger19', conversation: 'DL_repairbot', event: 37963, speech: 37894,
    end: 37848, soundId: 73, bytes: 64116,
    sha256: 'f3c5f80ac58c524000711ff49af02466d3abe60c9c06e191b5f18c74f0b5799d',
    seconds: 10.685999870300293, location: [5109.03515625, 488.16015625, -151.90000915527344], radius: 150, height: 40,
    text: "You're not a mech, but you're enough of a machine to need repair bots now and then.  If you used up some bioelectric energy getting through the dark area, for example, this contraption can charge you back up.",
  }],
  ['dl_medbot', {
    trigger: 'DataLinkTrigger20', conversation: 'DL_medbot', event: 40415, speech: 40385,
    end: 40355, soundId: 60, bytes: 76440,
    sha256: '0363873a1433b585dd3681449d6d8dd74bfcc4427bdfd63ab3e464a31ac65e60',
    seconds: 12.739999771118164, location: [5068.892578125, -4054.1064453125, 8.099990844726562], radius: 150, height: 40,
    text: "These medical bots, normally used for quick-healing, are of particular interest to you, JC, because you need a bot's help to install new augmentations.  If you took any damage during the swim, now's a good time to get patched up.",
  }],
  ['dl_lockstr', {
    trigger: 'DataLinkTrigger25', conversation: 'DL_lockstr', event: 40763, speech: 40713,
    end: 40683, soundId: 58, bytes: 95940,
    sha256: '1e7d3bd68e599ebe3af2a115a613b7bcce27423a7bf5034eb72ed834e51d6cca',
    seconds: 15.989999771118164, location: [1289.0491943359375, 143.3662109375, -87.89990997314453], radius: 50, height: 40,
    text: 'Doors have two strength values.  The Door Strength tells you how much damage a door takes before being destroyed.  The Lock Strength tells you how many lockpicks will be required to pick the lock.  Some doors have an infinite strength and an infinite lock strength.  That means you have to find a key.',
  }],
  ['dl_cratestack', {
    trigger: 'DataLinkTrigger27', conversation: 'DL_cratestack', event: 44836, speech: 44809,
    end: 44782, soundId: 33, bytes: 105300,
    sha256: 'c4a782ae4e6fd6a1f64406c1154f37aacadc97b8bc5695f5771c450edf757a9d',
    seconds: 17.549999237060547, location: [7063.58203125, -1632.3765869140625, 8.099868774414062], radius: 150, height: 40,
    text: 'You need to go through the door up ahead, but it\'s blocked.  Those wooden crates are too big to jump and too heavy to lift, so use the metal crates near the wall to build steps.  To pick up a crate, walk up to it so that it highlights, then click the right mouse button.  To drop something you\'re holding, you can press the Tab key by default.',
  }],
  ['dl_body', {
    trigger: 'DataLinkTrigger6', conversation: 'DL_body', event: 45589, speech: 45553,
    end: 45514, soundId: 28, bytes: 92820,
    sha256: '2a1f67064b20860cbbaa7ac677e6f172994e56c8bf45184546f50888030d01fc',
    seconds: 15.470000267028809, location: [3684.500732421875, 855.227783203125, -72.44747924804688], radius: 250, height: 20,
    text: 'Lying in front of you is a brave cadet who volunteered to be rendered unconscious for this next training exercise.  Highlight and search him to find the key to the medical room.  Afterward, pick up his body and place it on the medical table so that one of my aides can revive him once the exercise is over.',
  }],
  ['dl_bodyexit', {
    trigger: 'DataLinkTrigger32', conversation: 'DL_bodyexit', event: 45433, speech: 45406,
    end: 45379, soundId: 29, bytes: 33072,
    sha256: '30e28b5bd125adbbc174e5841156da82605e3999be36b67becf5045476132307',
    seconds: 5.51200008392334, location: [3747.576904296875, 443.1540832519531, -39.90013885498047], radius: 96, height: 40,
    text: "Good work.  I'll get someone down there immediately to revive Private Winslow.  Move on to the next area.",
  }],
  ['dl_f1f2', {
    trigger: 'DataLinkTrigger1', conversation: 'DL_F1F2', event: 43058, speech: 43028,
    end: 43001, soundId: 43, bytes: 132756,
    sha256: '7aad1a2f03197a4e42e96205e6249dc71ca3a3385e6f1c3cf6d5c012cc39cc05',
    seconds: 22.125999450683594, location: [381.4490966796875, 448.7422790527344, -100.44747924804688], radius: 100, height: 20,
    text: 'You\'re going to get a lot of equipment during these exercises.  Press F1 at any time to access the Inventory Screen, which will let you add and remove items from the Toolbelt.  Press F2 to view your current goals and any notes you may decide to take.  On a typical mission, a UNATCO agent\'s objectives are logged electronically so that he can stay on-task at all times.',
  }],
]);

assert.equal(catalog.routes.length, expected.size);
for (const route of catalog.routes) {
  const tag = route.trigger.dataLinkTag.toLowerCase();
  const want = expected.get(tag);
  assert.ok(want, `unexpected authored Training DataLink ${tag}`);
  assert.equal(route.dataLinkTag, tag);
  assert.equal(route.trigger.name, want.trigger);
  assert.equal(route.conversation.name, want.conversation);
  assert.equal(route.conversation.ownerName, 'JCDenton');
  assert.equal(route.conversation.bDataLinkCon, true);
  assert.equal(route.conversation.bDisplayOnce, true);
  assert.equal(route.conversation.audioPackageName, 'Mission00');
  assert.equal(route.trigger.playedFlag, `${want.conversation}_Played`);
  assert.equal(route.trigger.flags.TriggerType, 0);
  assert.equal(route.trigger.flags.bInitiallyActive, true);
  assert.equal(route.trigger.flags.bTriggerOnceOnly, true);
  assert.equal(route.trigger.flags.bHidden, true);
  assert.equal(route.trigger.flags.bStatic, false);
  assert.equal(route.trigger.flags.bNoDelete, false);
  assert.equal(route.trigger.flags.bDeleteMe, false);
  assert.equal(route.trigger.flags.bGameRelevant, false);
  assert.equal(route.trigger.flags.bMovable, true);
  assert.equal(route.trigger.flags.bCheckFalse, false);
  assert.equal(route.trigger.flags.bCheckFlagTimer, false);
  assert.equal(route.trigger.flags.checkFlagTimer, 1);
  assert.equal(route.trigger.initialCollision.bCollideActors, tag !== 'dl_bodyexit');
  assert.deepEqual(route.trigger.initialCollision, {
    bCollideActors: tag !== 'dl_bodyexit', bCollideWorld: false, bCollideWhenPlacing: false,
    bBlockActors: false, bBlockPlayers: false, bProjTarget: false,
  });
  assert.deepEqual(route.trigger.location, want.location);
  assert.equal(route.trigger.collision.radius, want.radius);
  assert.equal(route.trigger.collision.height, want.height);
  assert.equal(route.chain.speechEvent.className, 'ConEventSpeech');
  assert.equal(route.chain.speechEvent.exportIndex, want.event);
  assert.equal(route.chain.speechEvent.speechExport, want.speech);
  assert.equal(route.chain.speechEvent.nextEventExport, want.end);
  assert.equal(route.chain.speechEvent.speakerName, 'JaimeReyes');
  assert.equal(route.chain.speechEvent.speakingToName, 'JCDenton');
  assert.equal(route.chain.speech.className, 'ConSpeech');
  assert.equal(route.chain.speech.text, want.text);
  assert.equal(route.chain.endEvent.className, 'ConEventEnd');
  assert.equal(route.chain.endEvent.exportIndex, want.end);
  assert.equal(route.chain.endEvent.eventType, 18);
  assert.equal(route.speaker.bindName, 'JaimeReyes');
  assert.equal(route.speaker.displayName, 'Jaime Reyes');
  assert.equal(route.speaker.portrait, catalog.speaker.portrait);
  assert.equal(route.audio.soundId, want.soundId);
  assert.equal(route.audio.objectName, `ConAudioMission00_${want.soundId}`);
  assert.equal(route.audio.format, 'mp3');
  assert.equal(route.audio.mimeType, 'audio/mpeg');
  assert.equal(route.audio.byteCount, want.bytes);
  assert.equal(route.audio.bytes.byteLength, want.bytes);
  assert.equal(route.audio.seconds, want.seconds);
  assert.equal(route.audio.sha256, want.sha256);
  assert.equal(createHash('sha256').update(route.audio.bytes).digest('hex'), want.sha256);
  assert.equal(catalog.routeForTag(tag), route);
  assert.equal(catalog.routeForTag(tag.toUpperCase()), route);
  assert.equal(catalog.routeForTrigger(route.trigger.name.toUpperCase()), route);
}
assert.equal(catalog.routeForTag('missing_training_route'), null);
assert.equal(catalog.routeForTrigger('missing_trigger'), null);

console.log(`Training DataLink catalog passed: ${catalog.routes.length} authored triggers, ${catalog.counts.missionConItems} Mission00 DataLink conversations, direct Speech->End chains, Jaime Reyes portrait, and exact original MP3 bytes/timing.`);
