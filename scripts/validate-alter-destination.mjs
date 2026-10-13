/** Smoke check that ScriptedPawn.AlterDestination (the event the move polls fire for a walking bAdvancedTactics
 * pawn, docs/script-pawn-locomotion.md "Live divergence") runs to its end through this runtime for every
 * branch of its bytecode, in a loaded level: no unadmitted native or operator, no runtime error. The
 * effects asserted are the script's own (bytecode of ScriptedPawn.AlterDestination, scripts/dump-script-function.mjs):
 * MoveTimer -= 4 exactly when TurnDirection went from set to cleared; ObstacleTimer = 1.5 while the turn goes on (or the
 * turn is put back while the obstacle timer runs); the clear block resets NextDirection, ActorAvoiding, bAdvancedTactics
 * and ObstacleTimer. */
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const {runtime,npcPawns}=game.doors.scriptRuntime;
const pawn=npcPawns.find(actor=>actor.name==='mib1'),other=npcPawns.find(actor=>actor!==pawn);
assert.ok(pawn&&other);
const get=name=>runtime.readNamed(pawn,name),set=(name,value)=>runtime.writeNamed(pawn,name,value);
const loc=[...get('Location')];
const f32=Math.fround;
let cases=0,cleared=0,kept=0,undone=0;
for(const turn of [0,1,2]) for(const walkAround of [false,true]) for(const clearedObstacle of [false,true])
  for(const avoid of ['none','self','other']) for(const destMode of ['onAvoid','nearAvoid','far','atPawn']) for(const obstacle of [0,2]) {
    const actor=avoid==='none'?null:avoid==='self'?pawn:other;
    const aLoc=actor?[...runtime.readNamed(actor,'Location')]:[0,0,0];
    const dest={onAvoid:aLoc,nearAvoid:[aLoc[0]+30,aLoc[1]+10,aLoc[2]],far:[loc[0]+900,loc[1]-400,loc[2]],atPawn:loc}[destMode];
    set('TurnDirection',turn);set('bWalkAround',walkAround);set('bClearedObstacle',clearedObstacle);
    set('ActorAvoiding',actor);set('Destination',dest.map(f32));set('ObstacleTimer',obstacle);
    set('MoveTimer',3);set('NextDirection',2);set('bAdvancedTactics',true);
    const label=`TurnDirection ${turn} walkAround ${walkAround} cleared ${clearedObstacle} avoid ${avoid} dest ${destMode} obstacle ${obstacle}`;
    try { runtime.processEvent(pawn,'AlterDestination',[]); }
    catch(error) { assert.fail(`AlterDestination threw (${label}): ${error.message}`); }
    cases++;
    const after=get('TurnDirection'),timer=get('MoveTimer');
    if(after===0) {
      cleared++;
      assert.equal(timer,turn!==0?f32(3-4):3,`MoveTimer -= 4 only when a turn was set and has cleared (${label})`);
      assert.equal(get('bAdvancedTactics'),false,label);assert.equal(get('ActorAvoiding'),null,label);
      assert.equal(get('NextDirection'),0,label);assert.equal(get('ObstacleTimer'),0,label);
    } else {
      kept++;
      assert.equal(timer,3,`MoveTimer untouched while turning (${label})`);
      // either the turn still goes on (ObstacleTimer = 1.5) or it cleared while the obstacle timer ran and was put back
      const obstacleTimer=get('ObstacleTimer');
      assert.ok(obstacleTimer===f32(1.5)||(obstacleTimer===obstacle&&obstacle>0&&get('bClearedObstacle')&&after===turn),label);
    }
  }
console.log(`PASS AlterDestination: ${cases} branch combinations ran without error (${cleared} ended with the turn cleared, ${kept} still turning).`);
