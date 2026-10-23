/**
 * Resolve the first authored DL_Start speech payload for the diagnostic
 * InfoLink preview. The returned MPEG bytes remain an owned local copy; browser
 * decoding is a presentation transport and does not claim the original audio
 * mixer or ClientHearSound path.
 */
import {readObject} from '../unreal/objects.mjs';
import {decodeSoundResource} from './script-sound-resource.mjs';
import {conversationSoundLength} from './script-conversation-sound-length.mjs';

export const INFOLINK_AUDIO_REFERENCE=Object.freeze({
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

const integerReference=(value,label)=>{
  if(!Number.isInteger(value)||value<=0)throw new Error(`InfoLink audio requires ${label} export reference`);
  return value;
};

export async function loadInfoLinkPreviewAudio(assets){
  if(!assets?.get)throw new TypeError('InfoLink audio requires AssetStore');
  const reference=INFOLINK_AUDIO_REFERENCE;
  const sounds=await assets.get(reference.startSoundPackage);
  const startIndex=sounds.exportsByPath.get(reference.startSoundPath);
  if(startIndex!==reference.startSoundExport)throw new Error('InfoLink audio DataLinkStart identity changed');
  const startDecoded=decodeSoundResource({pkg:sounds.pkg,bytes:sounds.bytes,
    entry:sounds.pkg.exports[startIndex-1]});
  if(startDecoded.lazy.formatName?.toLowerCase()!==reference.startSoundFormat||
    startDecoded.bytes?.byteLength!==reference.startSoundByteCount)
    throw new Error('InfoLink audio DataLinkStart WAV payload changed');
  const startSeconds=conversationSoundLength({soundData:{array:{
    data:startDecoded.bytes,num:startDecoded.bytes.byteLength,
  }}},{read:(object,key)=>object[key],loadSpecial:()=>{},
    log:()=>{throw new Error('InfoLink audio DataLinkStart failed original RIFF timing recognition');}});
  if(startSeconds!==reference.startSoundSeconds)throw new Error('InfoLink audio DataLinkStart duration changed');
  const context=await assets.get(reference.conversationPackage);
  const conversationEntry=context.pkg.exports[reference.conversationExport-1];
  if(conversationEntry?.name!==reference.conversationObject)
    throw new Error('InfoLink audio Conversation57 identity changed');
  const conversation=readObject(context.pkg,context.bytes,reference.conversationExport).values;
  // (Name values carry the first spelling a package entered them with, unreal/name-spelling.mjs: compared without case)
  if(String(conversation.conName).toLowerCase()!==reference.conversationName.toLowerCase()||
    String(conversation.audioPackageName).toLowerCase()!==reference.audioPackageName.toLowerCase())
    throw new Error('InfoLink audio DL_Start authored metadata changed');
  const eventRef=integerReference(conversation.eventList,'DL_Start eventList');
  if(eventRef!==reference.eventExport)throw new Error('InfoLink audio DL_Start first event changed');
  const event=readObject(context.pkg,context.bytes,eventRef).values;
  const speechRef=integerReference(event.ConSpeech,'DL_Start ConSpeech');
  if(speechRef!==reference.speechExport)throw new Error('InfoLink audio DL_Start speech reference changed');
  const speech=readObject(context.pkg,context.bytes,speechRef).values;
  if(speech.soundID!==reference.soundId)throw new Error('InfoLink audio DL_Start soundID changed');

  const audio=await assets.get(reference.soundPackage);
  const soundIndex=audio.exportsByPath.get(reference.soundObject.toLowerCase());
  if(soundIndex!==reference.soundExport)throw new Error('InfoLink audio sound export identity changed');
  const entry=audio.pkg.exports[soundIndex-1];
  const decoded=decodeSoundResource({pkg:audio.pkg,bytes:audio.bytes,entry});
  if(decoded.lazy.formatName?.toLowerCase()!==reference.format||
    decoded.lazy.byteCount!==reference.byteCount)
    throw new Error('InfoLink audio MPEG payload metadata changed');
  const start=entry.serialOffset+decoded.lazy.inlineOffset;
  const bytes=audio.bytes.slice(start,start+decoded.lazy.byteCount);
  if(bytes.byteLength!==reference.byteCount)throw new Error('InfoLink audio payload is truncated');
  const seconds=conversationSoundLength({soundData:{array:{data:bytes,num:bytes.byteLength}}},{
    read:(object,key)=>object[key],loadSpecial:()=>{},
    log:()=>{throw new Error('InfoLink audio payload failed original MPEG timing recognition');},
  });
  return Object.freeze({
    ...reference,seconds,bytes,
    startCue:Object.freeze({soundObject:reference.startSoundObject,
      soundExport:reference.startSoundExport,format:reference.startSoundFormat,
      mimeType:reference.startSoundMimeType,byteCount:reference.startSoundByteCount,
      seconds:startSeconds,bytes:startDecoded.bytes}),
    playbackBoundary:'Browser audio decoder; original ClientHearSound mixer remains unsupported',
  });
}
