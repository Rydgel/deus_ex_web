import { loadLazyByteArray } from './script-lazy-byte-array.mjs';

/** FSoundData.LoadSpecial1036f700; normal path with the original archive services. */
export function loadSoundDataSpecial(data,services) {
  return loadLazyByteArray(data,services);
}

/** FSoundData.Load1036f040; see docs/script-lazy-byte-array.md. */
export function loadSoundDataNative(data,{read,write,loadArray,getPeriod,readAudio}={}) {
  const call=(service,label,...args)=>{
    if(typeof service!=='function')throw new Error(`FSoundData.Load requires ${label}`);
    const value=service(...args);
    if(value&&typeof value.then==='function')throw new Error(`FSoundData.Load ${label} must be synchronous`);
    return value;
  };
  const field=(object,key)=>call(read,'typed reads',object,key);
  const position=field(data,'lazyField08');
  if(!Number.isInteger(position)||position< -0x80000000||position>0x7fffffff)
    throw new Error('FSoundData.Load requires a signed int saved position');
  const wasUnloaded=position>0;
  call(loadArray,'generic lazy-array Load',data);
  if(!wasUnloaded)return;
  const period=call(getPeriod,'GetPeriod',data);
  if(typeof period!=='number')throw new Error('FSoundData.GetPeriod must return a float');
  call(write,'typed writes',field(data,'owner'),'durationCache',Math.fround(period));
  const requireNoAudio=()=>{
    if(call(readAudio,'USound.Audio global read')!==null)
      throw new Error('FSoundData.Load audio subsystem query/conversion is unsupported');
  };
  requireNoAudio();
  const count=field(field(data,'array'),'num');
  if(!Number.isInteger(count)||count<0||count>0x7fffffff)
    throw new Error('FSoundData.Load requires a native byte-array count');
  call(write,'typed writes',field(data,'owner'),'serializedByteCount',count);
  requireNoAudio();
}
