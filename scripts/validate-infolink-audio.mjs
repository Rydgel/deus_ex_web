/** Validate the exact first DL_Start speech payload exposed by the InfoLink preview. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {INFOLINK_AUDIO_REFERENCE,loadInfoLinkPreviewAudio} from '../src/runtime/script-infolink-audio.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({
  path:`System/${name}`,read:()=>readFile(path.join(system,name)),
})));
const audio=await loadInfoLinkPreviewAudio(assets);
assert.equal(audio.conversationName,'DL_Start');
assert.equal(audio.soundId,79);assert.equal(audio.format,'mp3');
assert.equal(audio.byteCount,43056);assert.equal(audio.bytes.byteLength,43056);
assert.equal(audio.seconds,7.176000118255615);
assert.equal(audio.soundExport,81);
const sha256=createHash('sha256').update(audio.bytes).digest('hex');
assert.equal(sha256,'f6367c840ed5988bd8d845125e67011d272799f5ec986039117c2634a8e2760c');
assert.equal(audio.startCue.soundObject,'DataLinkStart');
assert.equal(audio.startCue.byteCount,29804);assert.equal(audio.startCue.seconds,0.6730612516403198);
assert.equal(createHash('sha256').update(audio.startCue.bytes).digest('hex'),
  '32348bd70454c713d803c84255d25e80c05a36479b3692514a99511cd6f6ee92');
assert.deepEqual(Object.fromEntries(Object.entries(INFOLINK_AUDIO_REFERENCE)),{
  startSoundPackage:'DeusExSounds',startSoundPath:'userinterface.datalinkstart',
  startSoundObject:'DataLinkStart',startSoundExport:296,startSoundFormat:'wav',
  startSoundMimeType:'audio/wav',startSoundByteCount:29804,
  startSoundSeconds:0.6730612516403198,speechDelaySeconds:2,
  conversationPackage:'DeusExConText',conversationExport:1926,
  conversationObject:'Conversation57',conversationName:'DL_Start',audioPackageName:'Mission00',
  eventExport:32934,speechExport:32839,soundId:79,
  soundPackage:'DeusExConAudioMission00',soundObject:'ConAudioMission00_79',soundExport:81,
  format:'mp3',mimeType:'audio/mpeg',byteCount:43056,
});
console.log(`InfoLink audio passed: original DataLinkStart cue ${audio.startCue.seconds}s, then DL_Start speech 79 at +${audio.speechDelaySeconds}s, ${audio.byteCount} MP3 bytes / ${audio.seconds}s, sha256 ${sha256}.`);
