import {scriptCaps,scriptStringText} from './script-string-operations.mjs';

const equal=(a,b)=>scriptCaps(scriptStringText(a))===scriptCaps(scriptStringText(b));

/** ConSys DConEventSpeech::BindActor1000b070, with explicit canonical fields. */
export function bindSpeechActor({event,firstActor,secondActor,read,write,equalText=equal}) {
  if(!event||!secondActor)throw new Error('Speech BindActor requires its event and candidate actor');
  if(typeof read!=='function'||typeof write!=='function')throw new Error('Speech BindActor requires typed field services');
  function matches(field){
    const name=read(event,field),bindName=read(secondActor,'BindName');
    if(equalText(bindName,name))return true;
    if(firstActor!==secondActor)return false;
    const repeatedName=read(event,field),barkName=read(secondActor,'BarkBindName');
    return equalText(barkName,repeatedName);
  }
  let bound=false;
  if(matches('speakerName')){write(event,'speaker',secondActor);bound=true;}
  if(matches('speakingToName')){write(event,'speakingTo',secondActor);return true;}
  return bound;
}

/** ConSys DConEventSpeech::ClearBindActors1000b180. */
export function clearSpeechActors(event,{write}={}) {
  if(typeof write!=='function')throw new Error('Speech ClearBindActors requires typed field writes');
  write(event,'speaker',null);
  write(event,'speakingTo',null);
}
