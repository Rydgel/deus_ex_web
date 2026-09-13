/** Source-derived DataLinkPlay timer and WaitForSpeech presentation schedule. */
const freeze=Object.freeze;

function positive(value,name){
  if(!Number.isFinite(value)||value<=0)throw new TypeError(`InfoLink ${name} must be positive`);
  return value;
}

/** Repeating Timer advances by rate and branches only when elapsed > delay. */
export function strictTimerDuration(delay,rate){
  if(!Number.isFinite(delay)||delay<0)throw new TypeError('InfoLink timer delay must be nonnegative');
  positive(rate,'timer rate');
  return (Math.floor(delay/rate)+1)*rate;
}

export function createInfoLinkTimeline(content,speechSeconds){
  if(!content?.timing||typeof content.speech!=='string')throw new TypeError('InfoLink timeline requires content');
  positive(speechSeconds,'speech duration');
  const {blinkRate,startDelay,endDelay,perCharDelay,postSpeechDelay}=content.timing;
  const speechStart=strictTimerDuration(startDelay,blinkRate);
  const speechEnd=speechStart+speechSeconds;
  const endStart=speechEnd+postSpeechDelay;
  const destroy=endStart+strictTimerDuration(endDelay,blinkRate);
  return freeze({blinkRate,perCharDelay,speechStart,speechEnd,endStart,destroy});
}

export function infoLinkTimelineState(elapsed,content,timeline){
  if(!Number.isFinite(elapsed))throw new TypeError('InfoLink elapsed time must be finite');
  const time=Math.max(0,elapsed);
  if(time>=timeline.destroy)return freeze({phase:'destroyed',shellVisible:false,titleVisible:false,
    portrait:'portrait',portraitVisible:false,title:content.endTransmission,text:content.speech});
  if(time<timeline.speechStart){
    const ticks=Math.floor(time/timeline.blinkRate);
    return freeze({phase:'starting',shellVisible:true,titleVisible:true,
      portrait:ticks?'icon':'none',portraitVisible:ticks%2===0,
      title:'INCOMING TRANSMISSION...',text:''});
  }
  if(time<timeline.endStart){
    const characters=Math.min(content.speech.length,
      Math.max(0,Math.floor((time-timeline.speechStart)/timeline.perCharDelay)));
    return freeze({phase:'speech',shellVisible:true,titleVisible:true,portrait:'portrait',
      portraitVisible:true,title:content.speakerDisplayName,text:content.speech.slice(0,characters)});
  }
  const ticks=Math.floor((time-timeline.endStart)/timeline.blinkRate);
  return freeze({phase:'ending',shellVisible:true,titleVisible:ticks%2===0,
    portrait:'portrait',portraitVisible:true,title:content.endTransmission,text:content.speech});
}
