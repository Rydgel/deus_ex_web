import {scriptCaps,scriptStringText} from './script-string-operations.mjs';

/** DeusEx ConBindEvents2100/2101/2102 mission lookup and native list dispatch. */
export function bindActorConversations(actor,{levelFor,isLevelInfo,read,log,load,bind}={}) {
  if(typeof levelFor!=='function'||typeof isLevelInfo!=='function'||typeof read!=='function')
    throw new Error('ConBindEvents requires native level and typed field services');
  let info=null;
  for(let index=0;;index++){
    const actors=levelFor(actor)?.actors;
    if(!Array.isArray(actors))throw new Error('ConBindEvents requires the live level actor array');
    if(index>=actors.length)break;
    const candidate=actors[index];
    if(candidate===null)continue;
    if(candidate===undefined)throw new Error('ConBindEvents reached an unresolved actor slot');
    if(isLevelInfo(candidate)){info=candidate;break;}
  }
  if(info===null){
    if(typeof log!=='function')throw new Error('ConBindEvents missing-level log service is unbound');
    log('DeusExLevelInfo object missing!  Unable to bind Conversations!');
    return;
  }
  const mission=read(info,'missionNumber');
  if(!Number.isInteger(mission)||mission<( -0x80000000)||mission>0x7fffffff)
    throw new Error('ConBindEvents requires signed missionNumber');
  if(mission<0)return;
  const first=scriptStringText(read(info,'ConversationPackage'));
  const prefix=scriptCaps(first)==='DEUSEXCONVERSATIONS'
    ?'DeusExCon':scriptStringText(read(info,'ConversationPackage'));
  const path=`${prefix}Text.ConList_Mission${String(mission).padStart(2,'0')}`;
  if(prefix.length>=128||path.length>=128)
    throw new Error('ConBindEvents native stack-buffer overflow is unsupported');
  if(typeof load!=='function')throw new Error('ConBindEvents requires StaticLoadObject');
  const list=load({classKey:'consys.conversationlist',outer:null,path,filename:null,flags:2,sandbox:null});
  if(list===null)return;
  if(!list||typeof list.then==='function')throw new Error('ConBindEvents needs a synchronous loaded ConversationList');
  if(typeof bind!=='function')throw new Error('ConBindEvents requires native ConversationList.BindConversations');
  bind(list,actor);
}
