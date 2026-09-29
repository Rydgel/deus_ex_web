/** DeusEx.dll ScriptedPawn natives 2105–2107. Original instruction contract
 * and normal-return boundaries: docs/script-pawn-alliance.md. */
import {refValue} from './script-vm.mjs';

const FRIENDLY=0,NEUTRAL=1,HOSTILE=2;
const nameKey=value=>String(value??'None').toLowerCase();
const ALLIANCE_NAME='deusex.scriptedpawn.allianceinfoex.alliancename';
const ALLIANCE_LEVEL='deusex.scriptedpawn.allianceinfoex.alliancelevel';
const AGITATION_LEVEL='deusex.scriptedpawn.allianceinfoex.agitationlevel';
// The AlliancesEx value as {length, at(i)}; `elements` reads entries in place.
const allianceEntries=(receiver,services)=>{
  if(services.elements)return services.elements(receiver,'AlliancesEx');
  const whole=services.read(receiver,'AlliancesEx');
  return Array.isArray(whole)?{length:whole.length,at:index=>whole[index]}:null;
};

export function pawnAllianceType(receiver,name,services) {
  const {read}=services,wanted=nameKey(name);
  let result=NEUTRAL;
  if(wanted!=='none') {
    const entries=allianceEntries(receiver,services);
    if(!entries||entries.length!==16)throw new Error('GetAllianceType requires all 16 linked alliance entries');
    for(let index=0;index<16;index++) {
      const entry=entries.at(index);
      if(nameKey(entry[ALLIANCE_NAME])!==wanted)continue;
      const level=entry[ALLIANCE_LEVEL],agitation=entry[AGITATION_LEVEL];
      // FCOM's C0 includes unordered on both comparisons. A NaN alliance
      // is hostile; a NaN agitation does not cross the >=1 hostility gate.
      result=!(level>=0)||agitation>=1?HOSTILE:level>0?FRIENDLY:NEUTRAL;
      break;
    }
  }
  if(read(receiver,'bLikesNeutral')&&result===NEUTRAL)result=FRIENDLY;
  if(read(receiver,'bReverseAlliances'))result=result===FRIENDLY?HOSTILE:result===HOSTILE?FRIENDLY:NEUTRAL;
  return result;
}

export function pawnToPawnAllianceType(receiver,other,services) {
  if(!other)return NEUTRAL;
  const reverse=services.isA(other,'deusex.scriptedpawn')
    ?pawnAllianceType(other,services.read(receiver,'Alliance'),services):NEUTRAL;
  // The receiver query runs even if reverse hostility already decides it.
  const direct=pawnAllianceType(receiver,services.read(other,'Alliance'),services);
  return reverse===HOSTILE?HOSTILE:direct;
}

export function execPawnAlliance(call,services) {
  if(call.argumentCount<1||call.argumentCount>(call.index===2105?2:1))
    throw new Error('Invalid ScriptedPawn alliance query argument count');
  const argument=refValue(call.evaluateArgument(0));
  if(call.index===2106)return pawnAllianceType(call.receiver,argument,services);
  if(call.index===2107)return pawnToPawnAllianceType(call.receiver,argument,services);
  if(call.index!==2105)throw new Error(`Unsupported alliance native ${call.index}`);
  const optional=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
  const checkAlliance=optional===undefined?true:Boolean(optional);
  const {read}=services;
  if(!argument||argument===call.receiver||read(argument,'bDeleteMe')||
    !read(argument,'bDetectable')||(read(argument,'Health')|0)<=0)return false;
  return !checkAlliance||pawnToPawnAllianceType(call.receiver,argument,services)===HOSTILE;
}
