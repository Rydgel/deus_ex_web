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
assert.ok(augmentationSystem.get(),'Player startup creates AugmentationSystem before damage interaction');
const unwrappedCallFunction=runtime.callFunction;
let liveAdjustedDamage;
let liveDamageReduced;
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
}
assert.equal(liveAdjustedDamage,10,'live DXReduceDamage writes adjustedDamage=10 for unowned AugEnviro');
assert.equal(liveDamageReduced,false,'live DXReduceDamage reports no reduction for unowned AugEnviro');
assert.equal(ref(player,'Health'),98,'live Radiation10 recomputes total Health from body parts');
assert.deepEqual(Object.fromEntries(bodyParts.map(field=>[field,ref(player,field)])),{
  HealthHead:100,HealthTorso:100,HealthArmLeft:100,HealthArmRight:100,
  HealthLegLeft:90,HealthLegRight:100,
});
assert.equal(ref(player,'AnimSequence'),'HitLegLeft','Radiation10 selects the left-leg hit animation');
assert.equal(ref(player,'AnimFrame'),-0.25,'PlayAnim native starts HitLegLeft at its original frame');
assert.equal(ref(player,'AnimRate'),2.5,'PlayAnim native applies the original HitLegLeft rate');
assert.equal(ref(player,'TweenRate'),2.5,'PlayAnim native applies the authored tween time');
assert.equal(ref(player,'AnimLast'),0.75,'PlayAnim native stores the authored last frame');
assert.ok(game.player.unimplementedPhysicsEffects.has('DamageTrigger1.Timer mission script'));
dispatch(damage,'UnTouch',[player]);
assert.equal(ref(damage,'damagee'),null);

console.log('Play Trigger dispatch passed: base relevance, OrdersTrigger -> original pawn order queue, ' +
  'FlagTrigger set/inverse through native FlagBase, and DamageTrigger scheduling/UnTouch cleanup. ' +
  'Damage Timer runs the Radiation10 chain through body health=98 and GM_Trench HitLegLeft PlayAnim state, then ' +
  'records the Human.PlayTakeHitSound -> Actor.PlaySound native 264 boundary; DataLink enters the live Training lifecycle.');
