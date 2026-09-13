/** Validate the exact visible data and source-derived lifetime of DL_Start. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {INFOLINK_CONTENT_REFERENCE,loadInfoLinkPreviewContent} from '../src/runtime/script-infolink-content.mjs';
import {createInfoLinkTimeline,infoLinkTimelineState,strictTimerDuration} from '../src/runtime/script-infolink-timeline.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['System','Textures'])
  for(const name of await readdir(path.join(root,directory)))files.push({
    path:`${directory}/${name}`,read:()=>readFile(path.join(root,directory,name)),
  });
const assets=new AssetStore(files),content=await loadInfoLinkPreviewContent(assets);
assert.equal(content.conversationName,'DL_Start');
assert.equal(content.speakerBindName,'JaimeReyes');
assert.equal(content.speakerDisplayName,'Jaime Reyes');
assert.equal(content.soundId,79);
assert.equal(content.speech,"I figured you'd be sick of drills by now.  Hopefully our training exercises will be more interesting than what they've had you doing at the Academy.");
assert.equal(content.endTransmission,'END TRANSMISSION...');
assert.deepEqual(content.timing,{blinkRate:0.5,startDelay:1.5,endDelay:1,
  perCharDelay:Math.fround(0.03),postSpeechDelay:0.5});
assert.equal(content.portrait.key,'InfoPortraits.JaimeReyes');
assert.equal(content.dataLinkIcon.key,'DeusExUI.UserInterface.DataLinkIcon');
assert.equal(createHash('sha256').update(content.portrait.data).digest('hex'),
  INFOLINK_CONTENT_REFERENCE.portraitRgbaSha256);
assert.equal(createHash('sha256').update(content.dataLinkIcon.data).digest('hex'),
  INFOLINK_CONTENT_REFERENCE.iconMaskedRgbaSha256);

assert.equal(strictTimerDuration(1.5,0.5),2);
assert.equal(strictTimerDuration(1,0.5),1.5);
const timeline=createInfoLinkTimeline(content,7.176000118255615);
assert.deepEqual(timeline,{blinkRate:0.5,perCharDelay:Math.fround(0.03),speechStart:2,
  speechEnd:9.176000118255615,endStart:9.676000118255615,destroy:11.176000118255615});
assert.deepEqual(infoLinkTimelineState(0,content,timeline),{phase:'starting',shellVisible:true,
  titleVisible:true,portrait:'none',portraitVisible:true,title:'INCOMING TRANSMISSION...',text:''});
assert.equal(infoLinkTimelineState(0.5,content,timeline).portraitVisible,false);
assert.equal(infoLinkTimelineState(1,content,timeline).portrait,'icon');
assert.equal(infoLinkTimelineState(1,content,timeline).portraitVisible,true);
assert.equal(infoLinkTimelineState(2,content,timeline).phase,'speech');
assert.equal(infoLinkTimelineState(2.03,content,timeline).text,'I');
assert.equal(infoLinkTimelineState(timeline.endStart,content,timeline).title,'END TRANSMISSION...');
assert.equal(infoLinkTimelineState(timeline.endStart+0.5,content,timeline).titleVisible,false);
assert.equal(infoLinkTimelineState(timeline.endStart+1,content,timeline).titleVisible,true);
assert.equal(infoLinkTimelineState(timeline.destroy,content,timeline).shellVisible,false);
console.log('InfoLink content passed: exact DL_Start text/name, original icon and Jaime portrait pixels, strict startup/end timers, typed speech, and automatic destruction at +11.176000118255615s.');
