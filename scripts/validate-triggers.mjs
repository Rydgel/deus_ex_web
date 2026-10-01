/** Original Trigger Touch/UnTouch and timer dispatch in the live Play host.
 * Orders and Flag execute their original UFunctions; Damage reaches the
 * source-backed Training radiation body-health and GM_Trench PlayAnim state
 * from the native timer, then its recorded unsupported audio boundary. Training
 * DataLink enters the live source-backed transmission lifecycle.
 * Model/evidence: docs/scene-events.md. Requires the local game install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);

const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const ref = (a, n) => runtime.namedReference(a, n).get();
const find = name => { const a = level.actors.find(x => x?.name === name); assert.ok(a, `00_Training must contain ${name}`); return a; };
// player-move/actor-touch dispatch scene events through this same callback.
const dispatch = game.collision.doorCallbacks.dispatch;
const touch = (actor) => {
  const before = new Set(game.player.unimplementedPhysicsEffects);
  dispatch(actor, 'Touch', [player]); // must NOT throw (no scene-adapter pause)
  return [...game.player.unimplementedPhysicsEffects].filter(e => !before.has(e));
};

// DataLinkTrigger23 runs its real Touch into the installed player selection and
// DataLinkPlay spawn path. The true result is retained by the original trigger.
const dl = find('DataLinkTrigger23');
assert.equal(runtime.instance(dl).cls.record.name, 'DataLinkTrigger');
assert.equal(ref(dl, 'datalinkTag'), 'dl_start');
assert.equal(ref(dl, 'bStartedViaTouch'), false);
assert.deepEqual(touch(dl), []);
assert.equal(ref(dl, 'bStartedViaTouch'), true);
const dataLinkPlay=ref(player,'dataLinkPlay');
assert.ok(dataLinkPlay,'DataLink Touch spawns a live DataLinkPlay');
assert.equal(ref(dataLinkPlay,'con')?.name,'Conversation57');
assert.equal(ref(dataLinkPlay,'datalinkTrigger'),dl);

// UnTouch also routes without pausing.
assert.doesNotThrow(() => dispatch(dl, 'UnTouch', [player]), 'DataLinkTrigger.UnTouch routes without a pause');

// Base Trigger.Touch runs its real IsRelevant gate (the TriggerType switch + native
// ClassIsChildOf). Trigger0 is TT_ClassProximity for engine.carcass (a corpse-
// detection trigger that opens its body doors), so the player is not relevant: its
// Touch is a real no-op, not a false "mission script" deferral.
const isRelevant = (trig, other) => {
  const record = runtime.lookup(trig, 'IsRelevant');
  return runtime.callFunction(record, trig, 1, i => (i === 0 ? other : null));
};
const trigger0 = find('Trigger0');
assert.equal(runtime.instance(trigger0).cls.record.name, 'Trigger');
assert.equal(ref(trigger0, 'TriggerType'), 2);            // TT_ClassProximity
assert.equal(isRelevant(trigger0, player), false, 'ClassIsChildOf(JCDentonMale, Carcass) is false');
assert.deepEqual(touch(trigger0), [], 'Trigger0.Touch(player) runs the real gate and no-ops (no false deferral)');
// The TriggerType switch reaches its other arms too: a TT_PlayerProximity trigger
// (a DataLinkTrigger) is relevant to the player. This exercises the VM switch/case.
assert.equal(ref(dl, 'TriggerType'), 0);                  // TT_PlayerProximity
assert.equal(isRelevant(dl, player), true, 'TT_PlayerProximity is relevant to the player (switch other arm)');

const orders=find('OrdersTrigger0'),pawn=find('JaimeReyes1');
assert.deepEqual(touch(orders),[]);
assert.equal(ref(pawn,'Orders'),'Patrolling');
assert.equal(ref(pawn,'OrderTag'),'gunroom');
// The live pawn ran its original StartUp.BeginState, so bInterruptState is set
// and ScriptedPawn.SetState routes to GotoState: the pawn lands in Patrolling
// immediately rather than queuing NextState for a later tick.
assert.equal(runtime.instance(pawn).state?.stateNode?.record?.name,'Patrolling');
const flag=find('FlagTrigger0'),flagBase=game.doors.scriptRuntime.triggerActions.flagBase;
assert.deepEqual(touch(flag),[]);
assert.equal(flagBase.getBool('MunitionsTrooperReady'),true);
dispatch(flag,'UnTouch',[player]);
assert.equal(flagBase.getBool('MunitionsTrooperReady'),false);
const damage=find('DamageTrigger1');
assert.deepEqual(touch(damage),[]);
assert.equal(ref(damage,'damagee'),player);
assert.equal(ref(damage,'TimerRate'),1);
const health=runtime.namedReference(player,'Health');
const augmentationSystem=runtime.namedReference(player,'AugmentationSystem');
const desiredFlashScale=runtime.namedReference(player,'DesiredFlashScale');
const desiredFlashFog=runtime.namedReference(player,'DesiredFlashFog');
const bodyParts=['HealthHead','HealthTorso','HealthArmLeft','HealthArmRight','HealthLegLeft','HealthLegRight'];
for(const field of bodyParts)runtime.namedReference(player,field).set(100);
health.set(100);
desiredFlashScale.set(0);
desiredFlashFog.set([0,0,0]);
// Human.PlayTakeHitSound gates its PlaySound on a cooldown that consumes an
// FRand() draw: `Level.TimeSeconds - LastPainSound < FRand() + 0.5` returns
// early without reaching the native. The single Timer inside this window fires
// at TimeSeconds ~= 1.0, so pin LastPainSound far in the past to keep the gate
// deterministic instead of leaving the boundary on an RNG draw.
runtime.namedReference(player,'LastPainSound').set(-100);
// XLevel->Engine->Audio is Galaxy's subsystem; record its PlaySound calls.
const galaxyPlays=[],audio=runtime.levelFor(player).engine.audio,playSound=audio.playSound;
audio.playSound=(...args)=>{galaxyPlays.push({actor:args[0],id:args[1],sound:args[2]?.name});return playSound(...args);};
assert.ok(augmentationSystem.get(),'Player startup creates AugmentationSystem before damage interaction');
const unwrappedCallFunction=runtime.callFunction;
const unwrappedInvokeNative=runtime.invokeNative;
const unwrappedProcessActorAnimation=runtime.processActorAnimation;
let liveAdjustedDamage;
let liveDamageReduced;
let liveHitAnimationStart;
const liveHitTweenSteps=[];
const animationFields=['AnimSequence','AnimFrame','AnimRate','TweenRate','AnimLast'];
let liveHitTime,liveWaitingTween;
const levelInfo=game.collision.queries.levelInfo;
runtime.invokeNative=function captureHitAnimationStart(call){
  const result=unwrappedInvokeNative.call(this,call);
  if(call.index===259&&call.receiver===player&&ref(player,'AnimSequence')==='HitLegLeft'){
    liveHitAnimationStart=Object.fromEntries(animationFields.map(field=>[field,ref(player,field)]));
    liveHitTime=ref(levelInfo,'TimeSeconds');
  }
  if(call.index===294&&call.receiver===player&&liveHitAnimationStart&&!liveWaitingTween)
    liveWaitingTween={sequence:ref(player,'AnimSequence'),time:ref(levelInfo,'TimeSeconds'),caller:call.script?.entry?.path??null};
  return result;
};
runtime.processActorAnimation=function captureHitAnimationTick(actor,seconds){
  const before=actor===player&&liveHitAnimationStart&&ref(player,'AnimSequence')==='HitLegLeft'
    ?{frame:ref(player,'AnimFrame'),rate:ref(player,'TweenRate')}:null;
  const result=unwrappedProcessActorAnimation.call(this,actor,seconds);
  if(before?.frame<0)liveHitTweenSteps.push({...before,seconds,after:ref(player,'AnimFrame')});
  return result;
};
runtime.callFunction=function captureDamageReduction(record,receiver,argumentCount,evaluateArgument,context){
  if(record?.key!=='deusex.deusexplayer.dxreducedamage')
    return unwrappedCallFunction.call(this,record,receiver,argumentCount,evaluateArgument,context);
  const result=unwrappedCallFunction.call(this,record,receiver,argumentCount,index=>{
    const value=evaluateArgument(index);
    if(index===3&&value?.reference)
      return {reference:true,get:value.get,set:item=>{liveAdjustedDamage=item;return value.set(item)}};
    return value;
  },context);
  liveDamageReduced=result;
  return result;
};
try {
  for(let i=0;i<130;i++)game.tick(1/120,{});
} finally {
  runtime.callFunction=unwrappedCallFunction;
  runtime.invokeNative=unwrappedInvokeNative;
  runtime.processActorAnimation=unwrappedProcessActorAnimation;
}
assert.equal(liveAdjustedDamage,10,'live DXReduceDamage writes adjustedDamage=10 for unowned AugEnviro');
assert.equal(liveDamageReduced,false,'live DXReduceDamage reports no reduction for unowned AugEnviro');
assert.equal(ref(player,'Health'),98,'live Radiation10 recomputes total Health from body parts');
assert.deepEqual(Object.fromEntries(bodyParts.map(field=>[field,ref(player,field)])),{
  HealthHead:100,HealthTorso:100,HealthArmLeft:100,HealthArmRight:100,
  HealthLegLeft:90,HealthLegRight:100,
});
assert.ok(liveHitAnimationStart,'Radiation10 selects the left-leg hit animation through native PlayAnim during the Timer event');
assert.equal(liveHitAnimationStart.AnimFrame,-0.25,'PlayAnim native starts HitLegLeft at its original frame');
assert.equal(liveHitAnimationStart.AnimRate,2.5,'PlayAnim native applies the original HitLegLeft rate');
assert.equal(liveHitAnimationStart.TweenRate,2.5,'PlayAnim native applies the authored tween time');
assert.equal(liveHitAnimationStart.AnimLast,0.75,'PlayAnim native stores the authored last frame');
// Original AActor::Tick animation runs before the controlled-player tail.
// Engine 0x103a1bf0..0x103a1fd2 advances a negative tween frame by the
// float32-stored frame + delta*TweenRate (docs/script-animation-tick.md).
// The PlayAnim start values belong to its event boundary, not the last frame
// of this 130-tick interval.
assert.ok(liveHitTweenSteps.length>0,'later public ticks advance the player hit tween');
for(const step of liveHitTweenSteps){
  const expected=Math.fround(step.frame+Math.fround(step.seconds)*step.rate);
  assert.ok(expected<0,'this focused interval remains inside the initial tween');
  assert.equal(step.after,expected,'the live scheduler follows the original tween advancement');
}
// DamageTrigger1 precedes the spawned player in Level.Actors, so the player's
// own tick in the same frame reaches original PlayerPawn.PlayerWalking
// ProcessMove (PlayerPawn.uc:3571-3592): standing, not turning, a TakeHit
// group and bAnimTransition false (AnimEnd cleared it) select
// TweenToWaiting(0.2). The original body therefore replaces HitLegLeft with
// the Waiting tween before the next frame.
assert.ok(liveWaitingTween,'the same frame reaches the original Waiting tween after the hit');
assert.equal(liveWaitingTween.time,liveHitTime,'PlayerTick tweens to Waiting in the Timer frame');
assert.equal(liveWaitingTween.sequence,'BreatheLight','Human.TweenToWaiting selects BreatheLight');
assert.equal(liveWaitingTween.caller,'Human.TweenToWaiting');
assert.equal(ref(player,'AnimSequence'),'BreatheLight','the player ends the interval in the Waiting tween');
assert.ok(!game.player.unimplementedPhysicsEffects.has('DamageTrigger1.Timer mission script'));
// Human.PlayTakeHitSound's original PlaySound(SLOT_Pain) reaches Galaxy
// through the player's ClientHearSound, with the measured index's channel id.
assert.ok(galaxyPlays.some(play=>play.actor===player&&play.id===(runtime.measuredObjectIndex(player)<<4)+(2<<1)&&/^MalePain/.test(play.sound)),
  `pain sound on Galaxy: ${JSON.stringify(galaxyPlays.map(play=>[play.id,play.sound]))}`);
dispatch(damage,'UnTouch',[player]);
assert.equal(ref(damage,'damagee'),null);

console.log('Play Trigger dispatch passed: base relevance, OrdersTrigger -> original pawn order queue, ' +
  'FlagTrigger set/inverse through native FlagBase, and DamageTrigger scheduling/UnTouch cleanup. ' +
  'Damage Timer runs the Radiation10 chain through body health=98 and GM_Trench HitLegLeft PlayAnim state, then ' +
  'plays Human.PlayTakeHitSound through Galaxy and returns; DataLink enters the live Training lifecycle.');
