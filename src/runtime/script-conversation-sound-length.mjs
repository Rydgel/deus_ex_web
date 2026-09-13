/** ConSys10010430/10010460. See docs/script-conversation-sound-length.md. */
export const CONVERSATION_BITRATES=Object.freeze([
  -1,-1,-1,-1,-1, 32,32,32,32,8, 64,48,40,48,16, 96,56,48,56,24,
  128,64,56,64,32, 160,80,64,80,40, 192,96,80,96,48, 224,112,96,112,56,
  256,128,112,128,64, 288,160,128,144,80, 320,192,160,160,96,
  352,224,192,176,112, 384,256,224,192,128, 416,320,256,224,144,
  448,384,320,256,160, -1,-1,-1,-1,-1,
]);
const call=(fn,label,...args)=>{
  if(typeof fn!=='function')throw new Error(`Conversation sound length requires ${label}`);
  const result=fn(...args);
  if(result&&typeof result.then==='function')throw new Error(`Conversation ${label} must be synchronous`);
  return result;
};
export function conversationSoundLength(sound,{read,loadSpecial,log}={}) {
  if(sound===null)return 0;
  const data=call(read,'SoundData field',sound,'soundData');
  call(loadSpecial,'FSoundData.LoadSpecial',data);
  const array=call(read,'SoundData array',data,'array');
  const bytes=call(read,'array.Data',array,'data');
  if(bytes!==null&&bytes!==0){
    if(!(bytes instanceof Uint8Array))throw new Error('Conversation sound length requires a loaded byte view');
    const u32=offset=>{
      if(offset+4>bytes.byteLength)throw new Error('Conversation sound length reached unsupported native memory');
      return new DataView(bytes.buffer,bytes.byteOffset+offset,4).getUint32(0,true);
    };
    const header=u32(0);
    if(header===0x46464952)return Math.fround(u32(0x28)/(u32(0x1c)|0));
    if((header&0xff)===0xff&&(header&0xe000)===0xe000){
      const version=header&0x1800,layer=header&0x600;
      let column=0;
      if(version===0x1800){if(layer===0x400)column=1;else if(layer===0x200)column=2;}
      else if(version===0x1000||version===0){
        if(layer===0x600)column=3;else if(layer===0x400||layer===0x200)column=4;
      }
      const count=call(read,'array.Num',array,'num');
      if(!Number.isInteger(count)||count<0||count>0x7fffffff)throw new Error('Conversation sound length requires native ArrayNum');
      const rate=CONVERSATION_BITRATES[((header>>>20)&15)*5+column];
      return Math.fround((count<<3)/Math.imul(rate,1000));
    }
  }
  call(log,'invalid-format warning','**** DConversation::GetSoundLength() - WARNING!  Invalid sound file format!');
  return 0;
}
export function conversationSpeechLength(conversation,soundID,{getSpeechAudio,getSoundLength}={}) {
  if(!Number.isInteger(soundID)||soundID< -0x80000000||soundID>0x7fffffff)
    throw new Error('GetSpeechLength requires a signed int soundID');
  if(soundID===-1)return 0;
  const sound=call(getSpeechAudio,'GetSpeechAudio',conversation,soundID);
  if(sound===null)return 0;
  return Math.fround(call(getSoundLength,'GetSoundLength',sound));
}
