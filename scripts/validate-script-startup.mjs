/** Execute the original CameraPoint startup event through the inherited
 * relevance chain.  The fixture is deliberately explicit: it supplies
 * LevelInfo, DeusExGameInfo, and the base Engine.Mutator identities while
 * leaving native collision and destruction branches as fail-fast boundaries.
 * This validates script startup dispatch; it is not SpawnActor construction.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {gameDirectory} from './game-directory.mjs';

function packageFiles(root) {
  return readdir(`${root}/System`).then(names => names.map(name => ({
    path:name,
    read:()=>readFile(`${root}/System/${name}`),
  })));
}

function exportIndex(asset,path) {
  const index=asset.exportsByPath.get(path);
  assert(Number.isInteger(index),`Original export is missing: ${asset.name}.${path}`);
  return index;
}

/**
 * Build linked identities and prepare the original functions needed by
 * CameraPoint's inherited Actor.PreBeginPlay.  No startup event is run here,
 * so callers can install their own native lifecycle services before dispatch.
 *
 * `trace:true` instruments only this validator's call boundary.  Script
 * functions and native 195/303 still execute through ScriptRuntime; unknown
 * native indices throw from the explicit fallback below.
 */
export async function createStartupFixture({seed=1,trace=false}={}) {
  const root=gameDirectory();
  const assets=new AssetStore(await packageFiles(root));
  const engine=await assets.get('Engine');
  const deusEx=await assets.get('DeusEx');
  const level={
    actors:[],pendingDeleted:null,engine:{audio:null},collisionHash:null,
    editor:false,
  };
  const rng=createNativeRng(seed);
  const callTrace={events:[],functions:[],natives:[],frand:[],nativeFallback:[]};
  if(trace){
    const originalFrand=rng.frand.bind(rng);
    rng.frand=()=>{
      const retained=originalFrand();
      callTrace.frand.push({retained,stored:Math.fround(retained),state:rng.state});
      return retained;
    };
  }
  const runtime=new ScriptRuntime(assets,{
    levelFor:()=>level,
    rng,
    // This callback is intentionally not a native implementation.  The
    // selected CameraPoint path must need only the runtime's source-backed
    // native 195/303 handlers; another native is an explicit unsupported
    // branch rather than a guessed return value.
    native:call=>{
      const entry={index:call.index,path:call.script?.entry?.path??null};
      callTrace.nativeFallback.push(entry);
      throw new Error(`Startup fixture reached an unlinked native ${call.index} (${entry.path??'unknown script'})`);
    },
  });

  const cameraClass=await runtime.loadClass(engine,exportIndex(engine,'camerapoint'));
  const levelClass=await runtime.loadClass(engine,exportIndex(engine,'levelinfo'));
  const gameClass=await runtime.loadClass(deusEx,exportIndex(deusEx,'deusexgameinfo'));
  const mutatorClass=await runtime.loadClass(engine,exportIndex(engine,'mutator'));
  assert.equal(gameClass.base?.record.key,'engine.gameinfo',
    'DeusExGameInfo must inherit the original Engine.GameInfo implementation');

  const levelInfo={name:'LevelInfo startup fixture'};
  const game={name:'DeusExGameInfo startup fixture'};
  const mutator={name:'base Mutator startup fixture'};
  const camera={name:'CameraPoint startup fixture'};
  runtime.attach(levelInfo,levelClass);
  runtime.attach(game,gameClass);
  runtime.attach(mutator,mutatorClass);
  runtime.attach(camera,cameraClass);

  const ref=(receiver,name)=>runtime.namedReference(receiver,name);
  const set=(receiver,name,value)=>ref(receiver,name).set(value);

  // These are the actual script inputs consumed by PreBeginPlay and
  // GameInfo.IsRelevant.  They are set explicitly so class-default changes
  // cannot silently turn this fixture into a different branch.
  set(levelInfo,'NetMode',0); // ENetMode.NM_Standalone.
  // LoadMap sets this before its shared PreBeginPlay pass; Actor.ProcessEvent
  // otherwise suppresses events (Engine.dll 0x10369100).
  set(levelInfo,'bBegunPlay',true);
  set(levelInfo,'Game',game);
  set(game,'Level',levelInfo);
  set(game,'BaseMutator',mutator);
  set(game,'Difficulty',0);
  set(game,'bNoMonsters',false);
  set(game,'SecretGoals',0);
  set(game,'ItemGoals',0);
  set(game,'KillGoals',0);
  set(mutator,'NextMutator',null);
  set(camera,'Level',levelInfo);
  set(camera,'bGameRelevant',false);
  set(camera,'CollisionRadius',10);
  set(camera,'CollisionHeight',32);
  set(camera,'bDifficulty0',true);
  set(camera,'bDifficulty1',true);
  set(camera,'bDifficulty2',true);
  set(camera,'bDifficulty3',true);
  set(camera,'bSinglePlayer',true);
  set(camera,'bNet',true);
  set(camera,'bNetSpecial',true);
  set(camera,'OddsOfAppearing',1);
  set(camera,'bIsSecretGoal',false);
  set(camera,'bIsItemGoal',false);
  set(camera,'bIsKillGoal',false);

  const prepared=[
    ['actor.prebeginplay',engine],
    ['gameinfo.isrelevant',engine],
    ['mutator.alwayskeep',engine],
    ['mutator.isrelevant',engine],
    ['mutator.checkreplacement',engine],
  ];
  for(const [path,asset] of prepared)await runtime.prepareFunction(asset,exportIndex(asset,path));

  if(trace){
    const originalCallFunction=runtime.callFunction.bind(runtime);
    runtime.callFunction=(record,...args)=>{
      callTrace.functions.push(record.key);
      return originalCallFunction(record,...args);
    };
    const originalInvokeNative=runtime.invokeNative.bind(runtime);
    runtime.invokeNative=call=>{
      callTrace.natives.push({index:call.index,path:call.script?.entry?.path??null});
      return originalInvokeNative(call);
    };
  }

  return {
    runtime,assets,engine,deusEx,level,levelInfo,game,mutator,camera,
    cameraClass,levelClass,gameClass,mutatorClass,rng,trace:callTrace,
  };
}

export async function validateStartup(options={}) {
  const fixture=await createStartupFixture({...options,trace:true});
  const {runtime,camera,rng,trace}=fixture;
  const beforeState=rng.state;
  trace.events.push('engine.actor.prebeginplay');
  assert.equal(runtime.lookup(camera,'PreBeginPlay')?.key,'engine.actor.prebeginplay');
  assert.equal(runtime.lookup(fixture.game,'IsRelevant')?.key,'engine.gameinfo.isrelevant');
  assert.equal(runtime.lookup(fixture.mutator,'AlwaysKeep')?.key,'engine.mutator.alwayskeep');
  assert.equal(runtime.lookup(fixture.mutator,'IsRelevant')?.key,'engine.mutator.isrelevant');
  assert.equal(runtime.lookup(fixture.mutator,'CheckReplacement')?.key,'engine.mutator.checkreplacement');
  assert.equal(runtime.processEvent(camera,'PreBeginPlay'),true);

  // Actor.PreBeginPlay's CameraPoint path asks IsA for Decoration, Inventory,
  // and Pawn, then GameInfo.IsRelevant calls exactly the base mutator chain
  // before its one FRand gate.  SetCollisionSize and Destroy are not guessed.
  assert.deepEqual(trace.natives.map(call=>call.index),[303,303,303,195]);
  assert.deepEqual(trace.natives.map(call=>call.path),[
    'Actor.PreBeginPlay','Actor.PreBeginPlay','Actor.PreBeginPlay','GameInfo.IsRelevant',
  ]);
  assert.deepEqual(trace.functions,[
    'engine.gameinfo.isrelevant',
    'engine.mutator.alwayskeep',
    'engine.mutator.isrelevant',
    'engine.mutator.checkreplacement',
  ]);
  assert.deepEqual(trace.nativeFallback,[]);
  assert.equal(trace.frand.length,1);
  assert.equal(trace.frand[0].state,rng.state);
  assert.notEqual(rng.state,beforeState);
  const expected=createNativeRng(options.seed??1);
  const expectedRetained=expected.frand();
  assert.equal(trace.frand[0].retained,expectedRetained);
  assert.equal(trace.frand[0].stored,Math.fround(expectedRetained));
  assert.equal(rng.state,expected.state);

  assert.equal(runtime.namedReference(camera,'bDeleteMe').get(),false);
  assert.equal(runtime.namedReference(fixture.game,'SecretGoals').get(),0);
  assert.equal(runtime.namedReference(fixture.game,'ItemGoals').get(),0);
  assert.equal(runtime.namedReference(fixture.game,'KillGoals').get(),0);
  assert.equal(runtime.namedReference(fixture.mutator,'NextMutator').get(),null);
  console.log(`Original CameraPoint → Actor.PreBeginPlay → DeusExGameInfo/GameInfo.IsRelevant → Mutator AlwaysKeep/IsRelevant/CheckReplacement passed; FRand retained ${trace.frand[0].retained} and advanced state ${beforeState} → ${rng.state}.`);
  return fixture;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await validateStartup();
