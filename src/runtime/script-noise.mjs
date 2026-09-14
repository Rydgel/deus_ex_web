import {refValue} from './script-vm.mjs';

const f=Math.fround;
// Engine.dll AActor::MakeNoise 0x103bfad0 constants — image f64 values
// (fsub/fmul qword: 0x1042b8e8=0.2, 0x10431480=0.18, 0x1042f570=0.9); the
// 2500 near gate is f32 (0x1043148c):
const FRESH=0.2,STALE=0.18,NEAR_SQUARED=2500,LOUDER=0.9;
// Engine.dll hearing gate 0x103bf7b0 constants:
const HEAR_NORMAL=4e6,HEAR_TEAM=1.6e7,HEAR_SCALE=1.2e6,HEAR_LOUD=2,HEAR_ALERT=0.5;

function service(services,name,...args){
  if(typeof services?.[name]!=='function')throw new Error(`Original noise service is not linked: ${name}`);
  return services[name](...args);
}
function read(services,object,name){
  if(object==null)throw new Error(`Original noise field ${name} requires an object`);
  const value=service(services,'read',object,name);
  if(value===undefined)throw new Error(`Original noise field is not linked: ${name}`);
  return value;
}
function write(services,object,name,value){service(services,'write',object,name,value);}
function vector(value){
  if(!Array.isArray(value)||value.length!==3)throw new Error('Original noise requires a three-component vector');
  return value.map(f);
}
function array(services,object,name){
  const value=read(services,object,name);
  if(!Array.isArray(value))throw new Error(`Original noise field ${name} is not an actor array`);
  return value;
}
function truthy(value){return Boolean(value);}
function dist2(a,b){let s=0;for(let i=0;i<3;i++){const d=a[i]-b[i];s+=d*d;}return s;}

/** Engine.dll 0x103bf7b0: the per-pawn hearing gate MakeNoise runs after the
 * IsProbing/class filters. dist² = |pawn.Location - noiseLoc|² stored f32.
 * The team branch opens only for a bIsPlayer listener: the LevelInfo sanity
 * warns (0xf1/0xf2) repeat, then GameInfo.bTeamGame, instigator.bIsPlayer,
 * both PlayerReplicationInfo non-null and equal Team bytes give the wider
 * Loudness²*16e6 >= dist² range that jumps straight to the line check —
 * the Stimulus write and threshold test never run on that path.
 * Otherwise Loudness²*4e6 >= dist² gates; dist²==0 returns true outright;
 * t = f32(1.2e6/dist²); value = min(t,2)*Loudness + min(t,0.5)*Alertness
 * stores f32 into pawn.Stimulus while the UNROUNDED f80 value compares
 * >= pawn.HearingThreshold; finally FastLineCheck(model, noiseLoc,
 * pawn.Location) decides by its raw return. A null Actors[0]/Game derefs in
 * the original; this port raises its explicit error at the same boundary. */
export function checkNoiseHearing(pawn,noiseLoc,loudness,instigator,services){
  const location=vector(read(services,pawn,'Location'));
  const squared=f(dist2(location,noiseLoc));
  const level=read(services,pawn,'XLevel');
  const lineCheck=()=>{
    const model=read(services,level,'Model');
    let line=service(services,'fastLineCheck',model,noiseLoc,location);
    if(line&&typeof line==='object')line=line.result;
    return Boolean(Number(line));
  };
  if(truthy(read(services,pawn,'bIsPlayer'))){
    const levelInfo=array(services,level,'Actors')[0]??null;
    // 0x103bf824-0x103bf883: a null Actors[0] warns 0xf1 and a class that does
    // not reach LevelInfo warns 0xf2 — the native CONTINUES into the Game
    // deref either way (a null actor faults there; this port's field read
    // raises its explicit error at the same boundary).
    if(levelInfo===null)service(services,'warn',0xf1);
    if(levelInfo===null||!service(services,'isA',levelInfo,'Engine.LevelInfo'))service(services,'warn',0xf2);
    if(truthy(read(services,read(services,levelInfo,'Game'),'bTeamGame'))
      &&truthy(read(services,instigator,'bIsPlayer'))){
      const listenerInfo=read(services,pawn,'PlayerReplicationInfo');
      const instigatorInfo=read(services,instigator,'PlayerReplicationInfo');
      if(listenerInfo!==null&&instigatorInfo!==null
        &&(Number(read(services,listenerInfo,'Team'))&0xff)===(Number(read(services,instigatorInfo,'Team'))&0xff)){
        if(!(loudness*loudness*HEAR_TEAM>=squared))return false;
        return lineCheck();
      }
    }
  }
  if(!(loudness*loudness*HEAR_NORMAL>=squared))return false;
  if(squared===0)return true;
  const t=f(HEAR_SCALE/squared);
  const value=Math.min(t,HEAR_LOUD)*loudness+Math.min(t,HEAR_ALERT)*f(read(services,pawn,'Alertness'));
  write(services,pawn,'Stimulus',f(value));
  if(!(value>=f(read(services,pawn,'HearingThreshold'))))return false;
  return lineCheck();
}

/** Engine.dll AActor::MakeNoise 0x103bfad0. Instigator (+0xbc) null returns
 * silently. T = Level->TimeSeconds(+0xdc); the two noise slots live on the
 * INSTIGATOR (noise1* +0x464.., noise2* +0x47c..). A slot suppresses the call
 * when time > T-0.2 && |spot-Location|² < 2500 && loudness >= L*0.9.
 * Otherwise the first stale slot (time < T-0.18) records the noise; when
 * both are fresh a near-and-not-louder slot1 refreshes, with a s2.loudness<=L
 * fallback — every write stamps {f32(T), Location, L} (the fstp sequence
 * discards both compare constants before each store). The loop walks
 * LevelInfo.PawnList: when instigator.bIsPlayer or instigator.Enemy.bIsPlayer
 * the loop SKIPS pawns whose class reaches PlayerPawn (players hear through
 * their own channel), otherwise bidirectional IsA against this->Class is
 * required; pawns equal to instigator, not probing HearNoise (0x156), or
 * failing the hearing gate are skipped; survivors get
 * ProcessEvent(HearNoise,{L,this}). */
export function actorMakeNoise(actor,loudness,services){
  const instigator=read(services,actor,'Instigator');
  if(instigator===null)return {dispatched:[]};
  const level=read(services,actor,'XLevel');
  const now=Number(read(services,level,'TimeSeconds'));
  const fresh=now-FRESH,stale=now-STALE;
  const location=vector(read(services,actor,'Location'));
  const slot=n=>({
    spot:vector(read(services,instigator,`noise${n}spot`)),
    time:f(read(services,instigator,`noise${n}time`)),
    loud:f(read(services,instigator,`noise${n}loudness`)),
    write:()=>{
      write(services,instigator,`noise${n}time`,f(now));
      write(services,instigator,`noise${n}spot`,location.slice());
      write(services,instigator,`noise${n}loudness`,loudness);
    },
  });
  const s1=slot(1),s2=slot(2);
  const suppress=s=>s.time>fresh&&dist2(s.spot,location)<NEAR_SQUARED&&s.loud>=loudness*LOUDER;
  if(suppress(s1)||suppress(s2))return {dispatched:[],suppressed:true};
  if(s1.time<stale)s1.write();
  else if(s2.time<stale)s2.write();
  else if(dist2(s1.spot,location)<NEAR_SQUARED&&s1.loud<=loudness)s1.write();
  else if(s2.loud<=loudness)s1.write();
  // 0x103bfde8+: Enemy (+0x3cc) is read only when instigator.bIsPlayer is clear.
  let playerNoise=truthy(read(services,instigator,'bIsPlayer'));
  if(!playerNoise){
    const enemy=read(services,instigator,'Enemy');
    playerNoise=enemy!==null&&truthy(read(services,enemy,'bIsPlayer'));
  }
  const levelInfo=array(services,level,'Actors')[0]??null;
  // The body re-runs the exec's LevelInfo sanity warns (0xf1/0xf2) on its own
  // path and CONTINUES; a null Actors[0] then faults on the PawnList read,
  // which this port reports as the field-read error at the same boundary.
  if(levelInfo===null)service(services,'warn',0xf1);
  if(levelInfo===null||!service(services,'isA',levelInfo,'Engine.LevelInfo'))service(services,'warn',0xf2);
  const dispatched=[];
  for(let pawn=read(services,levelInfo,'PawnList');pawn!==null;pawn=read(services,pawn,'nextPawn')){
    // 0x103bffda-0x103c0072: player noises test PlayerPawn ancestry first and
    // SKIP matches; non-player noises instead require the bidirectional IsA
    // against this->Class after the instigator/probe checks.
    if(playerNoise&&service(services,'isA',pawn,'Engine.PlayerPawn'))continue;
    if(pawn===instigator)continue;
    if(!service(services,'isProbing',pawn,'HearNoise'))continue;
    if(!playerNoise&&!service(services,'relatedClass',pawn,actor))continue;
    if(!checkNoiseHearing(pawn,location,loudness,instigator,services))continue;
    service(services,'processNativeEvent',pawn,'HearNoise',[loudness,actor]);
    dispatched.push(pawn);
  }
  return {dispatched};
}

/** Engine.dll execMakeNoise 0x103bcd20 (native 512): evaluate Loudness, read
 * Level->Actors[0]; null warns appWarnf code 0xf1, an actor whose class does
 * not reach LevelInfo warns 0xf2 — the original CONTINUES either way (the
 * wrong/null actor later faults on its field derefs; this port raises its
 * explicit field-read error at the same boundary). NetMode == 3 (NM_Client)
 * skips the body; otherwise AActor::MakeNoise runs. void native: no result. */
export function execMakeNoise(call,services){
  if(!Number.isInteger(call.argumentCount)||call.argumentCount!==1)
    throw new Error('MakeNoise requires one float argument');
  const loudness=f(refValue(call.evaluateArgument(0)));
  const level=read(services,call.receiver,'XLevel');
  const levelInfo=array(services,level,'Actors')[0]??null;
  if(levelInfo===null)service(services,'warn',0xf1);
  if(levelInfo===null||!service(services,'isA',levelInfo,'Engine.LevelInfo'))service(services,'warn',0xf2);
  if(read(services,level,'NetMode')===3)return {called:false};
  return actorMakeNoise(call.receiver,loudness,services);
}
