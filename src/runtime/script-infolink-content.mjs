/**
 * Source-backed visible content for the Training DL_Start InfoLink reference.
 *
 * The object chain and timing values are read from the installed packages on
 * every AssetStore instance. TextureStore decodes the original palette data;
 * no portrait, transcription, or display name is embedded as a replacement.
 */
import {Reader} from '../unreal/package.mjs';
import {readClass} from '../unreal/classes.mjs';
import {readObject} from '../unreal/objects.mjs';
import {TextureStore} from '../unreal/textures.mjs';

const freeze=Object.freeze;

export const INFOLINK_CONTENT_REFERENCE=freeze({
  conversationPackage:'DeusExConText',conversationExport:1926,
  conversationObject:'Conversation57',conversationName:'DL_Start',
  eventExport:32934,eventObject:'ConEventSpeech79',speechExport:32839,
  endEventExport:32549,endEventObject:'ConEventEnd77',
  speakerBindName:'JaimeReyes',speakerDisplayName:'Jaime Reyes',soundId:79,
  uiPackage:'DeusEx',dataLinkPlayClass:'datalinkplay',infoLinkNameIndex:9,
  portraitPackage:'InfoPortraits',portraitPath:'jaimereyes',portraitExport:28,
  portraitWidth:64,portraitHeight:64,portraitFormat:0,
  portraitRgbaSha256:'b2811f056a7c9af1990351a6593708bd4d0244402c1f6de2492b716d5954d0ef',
  iconPackage:'DeusExUI',iconPath:'userinterface.datalinkicon',iconExport:1190,
  iconWidth:64,iconHeight:64,iconFormat:0,
  iconMaskedRgbaSha256:'21b596984ce9a5298dfe2965244622d9abdcf63808d50fbc0712f41f3cb42788',
});

function requireValue(condition,message){if(!condition)throw new Error(message);}

function readInfoLinkName(property,version){
  requireValue(property?.type===10&&property.struct==='S_InfoLinkNames'&&property.data,
    'DataLinkPlay infoLinkNames[9] layout changed');
  const reader=new Reader(property.data);
  const result={bindName:reader.string(version),displayName:reader.string(version)};
  requireValue(reader.offset===reader.bytes.length,'DataLinkPlay infoLinkNames[9] has trailing data');
  return result;
}

async function decodedTexture(textures,assets,{packageName,path,index,width,height,format,masked}){
  const asset=await assets.get(packageName);
  requireValue(asset.exportsByPath.get(path)===index,`${packageName}.${path} export identity changed`);
  const decoded=await textures.get(asset,index,masked),mip=decoded.mips[0];
  requireValue(decoded.format===format,`${decoded.key} texture format changed`);
  requireValue(mip?.width===width&&mip?.height===height,`${decoded.key} dimensions changed`);
  return freeze({key:decoded.key,width:mip.width,height:mip.height,format:decoded.format,
    masked:Boolean(masked),data:mip.data.slice()});
}

export async function loadInfoLinkPreviewContent(assets){
  if(!assets?.get||!assets?.resolve)throw new TypeError('InfoLink content requires AssetStore');
  const reference=INFOLINK_CONTENT_REFERENCE;
  const [context,deusEx]=await Promise.all([
    assets.get(reference.conversationPackage),assets.get(reference.uiPackage),
  ]);
  requireValue(context.pkg.exports[reference.conversationExport-1]?.path===reference.conversationObject,
    'DL_Start conversation export identity changed');
  const conversation=readObject(context.pkg,context.bytes,reference.conversationExport).values;
  requireValue(conversation.conName===reference.conversationName&&conversation.eventList===reference.eventExport,
    'DL_Start conversation metadata changed');
  const eventEntry=context.pkg.exports[reference.eventExport-1];
  requireValue(eventEntry?.path===reference.eventObject&&eventEntry.className==='ConEventSpeech',
    'DL_Start first event identity changed');
  const event=readObject(context.pkg,context.bytes,reference.eventExport).values;
  requireValue(event.speakerName===reference.speakerBindName&&event.ConSpeech===reference.speechExport&&
    event.nextEvent===reference.endEventExport,'DL_Start speech event metadata changed');
  const speech=readObject(context.pkg,context.bytes,reference.speechExport).values;
  requireValue(speech.soundID===reference.soundId&&typeof speech.Speech==='string'&&speech.Speech.length,
    'DL_Start speech record changed');
  const endEntry=context.pkg.exports[reference.endEventExport-1];
  requireValue(endEntry?.path===reference.endEventObject&&endEntry.className==='ConEventEnd',
    'DL_Start end event identity changed');

  const dataLinkIndex=deusEx.exportsByPath.get(reference.dataLinkPlayClass);
  const dataLink=readClass(deusEx,dataLinkIndex);
  const defaults=Object.fromEntries(dataLink.properties.filter(property=>property.decoded).map(property=>[
    property.arrayIndex?`${property.name}[${property.arrayIndex}]`:property.name,property.value,
  ]));
  const nameProperty=dataLink.properties.find(property=>
    property.name==='infoLinkNames'&&property.arrayIndex===reference.infoLinkNameIndex);
  const name=readInfoLinkName(nameProperty,deusEx.pkg.version);
  requireValue(name.bindName===reference.speakerBindName&&name.displayName===reference.speakerDisplayName,
    'DataLinkPlay Jaime Reyes display-name mapping changed');
  for(const [key,value] of [['blinkRate',0.5],['startDelay',1.5],['endDelay',1],
    ['perCharDelay',Math.fround(0.03)]])
    requireValue(defaults[key]===value,`DataLinkPlay ${key} default changed`);
  requireValue(defaults.EndTransmission==='END TRANSMISSION...','DataLinkPlay EndTransmission changed');

  const textures=new TextureStore(assets);
  const [portrait,dataLinkIcon]=await Promise.all([
    decodedTexture(textures,assets,{packageName:reference.portraitPackage,path:reference.portraitPath,
      index:reference.portraitExport,width:reference.portraitWidth,height:reference.portraitHeight,
      format:reference.portraitFormat,masked:false}),
    decodedTexture(textures,assets,{packageName:reference.iconPackage,path:reference.iconPath,
      index:reference.iconExport,width:reference.iconWidth,height:reference.iconHeight,
      format:reference.iconFormat,masked:true}),
  ]);
  return freeze({conversationName:conversation.conName,speakerBindName:name.bindName,
    speakerDisplayName:name.displayName,speech:speech.Speech,soundId:speech.soundID,
    endTransmission:defaults.EndTransmission,
    timing:freeze({blinkRate:defaults.blinkRate,startDelay:defaults.startDelay,
      endDelay:defaults.endDelay,perCharDelay:defaults.perCharDelay,postSpeechDelay:0.5}),
    portrait,dataLinkIcon});
}
