/** Original standalone authority AActor::Tick, including Pawn/PlayerPawn tail.
 * Evidence and external-service boundaries: docs/script-actor-tick.md.
 * World iteration, startup and client/network simulation are separate work.
 */
import {updateActorTimer} from './script-timers.mjs';

const f=Math.fround;
const less=(a,b)=>a<b||Number.isNaN(a)||Number.isNaN(b);

export function actorInStasis(actor,{read,level}) {
  if(typeof level.timeSeconds!=='number')throw new Error('Original Actor.Tick requires the native level clock value');
  if(!(level.timeSeconds-read(actor,'LastRenderTime')>5)||!read(actor,'bStasis'))return false;
  const physics=read(actor,'Physics');
  if(!read(actor,'bForceStasis')&&physics!==0&&physics!==5)return false;
  const rendered=level.zoneLastRenderTime(actor);
  if(typeof rendered!=='number')throw new Error('Original zone render timestamp is not provided');
  if(!(level.timeSeconds-rendered>5)&&!(read(actor,'DistanceFromPlayer')>1200))return false;
  return level.netMode===0;
}

export function tickStandaloneActor(actor,seconds,tickType,services) {
  const {read,write,isA,level,processEvent,processState,advanceAnimation}=services;
  const get=name=>read(actor,name),set=(name,value)=>write(actor,name,value);
  if(get('Role')!==4||level.netMode!==0||level.demoRecDriver!==null)
    throw new Error('Original Actor.Tick client/demo route is not implemented');
  if(level.tickTag!==0&&level.tickTag!==1)throw new Error('Original level TickTag is not provided');
  const delta=f(seconds),event=(name,args=[])=>processEvent(actor,name,args);
  if(actorInStasis(actor,services)) {
    if(get('bTransient')&&get('Role')>=2)services.destroyActor(actor,0);
    return 1;
  }
  const owner=get('Owner');
  if(owner&&Number(Boolean(read(owner,'bTicked')))!==level.tickTag) {
    const node=services.allocateDeferredActor();
    if(node!==null&&typeof node!=='object')throw new Error('Original deferred-actor allocation result is not provided');
    if(node){node.actor=actor;node.next=level.deferredHead;}
    level.deferredHead=node;
    return 0;
  }
  set('bTicked',Boolean(level.tickTag&1));
  const pawn=get('bIsPawn')&&isA(actor,'engine.pawn');
  advanceAnimation(actor,delta);
  const scriptAndTimer=()=>{
    processState(actor,delta);
    // updateActorTimer's first access reads TimerRate and returns for a
    // disabled (zero, negative or NaN) rate; most actors stop there, so the
    // accessor view is only built for a running timer.
    if(!(f(get('TimerRate')??0)>0))return;
    const timers={};
    for(const name of ['TimerRate','TimerCounter','bTimerLoop'])
      Object.defineProperty(timers,name,{get:()=>get(name),set:value=>set(name,value)});
    updateActorTimer(timers,delta,()=>event('Timer'));
  };
  if(get('RemoteRole')===3) {
    if(get('Role')===4) {
      if(pawn&&isA(actor,'engine.playerpawn')) {
        const target=get('ViewTarget');
        if(target&&isA(target,'engine.pawn')) {
          set('TargetViewRotation',read(target,'ViewRotation'));
          set('TargetEyeHeight',read(target,'EyeHeight'));
          const weapon=read(target,'Weapon');
          if(weapon)set('TargetWeaponViewOffset',read(weapon,'PlayerViewOffset'));
        }
      }
      scriptAndTimer();
    }
  } else if(get('Role')>=2) {
    if(pawn&&isA(actor,'engine.playerpawn')&&get('Player')) {
      if(isA(actor,'engine.camera')&&!(get('ShowFlags')&0x800))return 1;
      services.readInput(get('Player'),delta);
      event('PlayerInput',[delta]);
      event('PlayerTick',[delta]);
      services.readInput(get('Player'),-1);
      if(level.demoRecDriver!==null)throw new Error('Actor.Tick input installed an unsupported DemoRecDriver');
    } else {
      if(tickType===1)return 1;
      if(services.isProbing(actor,'Tick'))event('Tick',[delta]);
    }
    scriptAndTimer();
    const lifespan=get('LifeSpan');
    if(lifespan!==0&&!Number.isNaN(lifespan)) {
      const remaining=lifespan-delta;
      set('LifeSpan',f(remaining));
      if(!(remaining>0.0001)) {
        event('Expired');
        services.destroyActor(actor,0);
        return 1;
      }
    }
    if(get('Physics')!==0&&get('Role')!==3)services.performPhysics(actor,delta);
  } else if(get('Physics')===2)services.performPhysics(actor,delta);

  // No DemoRecDriver is admitted at entry; the native demo tail is absent.
  if(level.demoRecDriver!==null)throw new Error('Actor.Tick callback installed an unsupported DemoRecDriver');
  if(!pawn)return 1;
  if(get('bIsPlayer')&&get('Role')>=3) {
    if(get('bViewTarget'))event('UpdateEyeHeight',[delta]);
    else set('ViewRotation',get('Rotation'));
  }
  const weapon=get('Weapon');
  if(weapon)services.farMoveActor(weapon,get('Location'),0,0);
  if(get('Role')!==4||tickType!==2)return 1;
  if(less(get('SightCounter'),0))set('SightCounter',f(get('SightCounter')+0.2));
  set('SightCounter',f(get('SightCounter')-delta));
  if(get('bIsPlayer')&&!get('bHidden'))services.showSelf(actor);
  if(less(get('SightCounter'),0)&&services.isProbing(actor,'EnemyNotVisible')) {
    services.checkEnemyVisible(actor);
    set('SightCounter',f(0.1));
  }
  for(const [name,callback] of [['PainTime','PainTimer'],['SpeechTime','SpeechTimer']]) {
    if(get(name)>0) {
      const remaining=get(name)-delta;
      set(name,f(remaining));
      if(less(remaining,0.001)) {
        set(name,0);
        event(callback);
      }
    }
  }
  if(get('bAdvancedTactics'))event('UpdateTactics',[delta]);
  return 1;
}
