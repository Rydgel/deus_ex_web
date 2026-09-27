/** Training boot/idle Physics inventory; headless execution is always RSS-bounded.
 * This records reachability, not original-game conformance. */
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
import {runChildWithWatchdog} from './training-probe-lib.mjs';
const out='.cache/training-physics-modes.json';
if(!process.argv.includes('--child')) {
 const {data,seconds,peakMiB}=await runChildWithWatchdog({script:'scripts/measure-training-physics.mjs',args:[],out,capMiB:4096,label:'Training physics measurement'});
 console.log(JSON.stringify({output:out,seconds,peakMiB,error:data.error}));
} else {
 const gameRoot=gameDirectory(),files=[];
 for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${gameRoot}/${dir}`))files.push({path:`${dir}/${name}`,read:()=>readFile(`${gameRoot}/${dir}/${name}`)});
 const reached=[];const original=ScriptRuntime.prototype.processActorPhysics;
 ScriptRuntime.prototype.processActorPhysics=function(actor,dt){ const cls=this.instance(actor).cls.record.key;const physics=this.readNamed(actor,'Physics');const key=`${actor.name}:${physics}`;if(!reached.some(r=>r.key===key))reached.push({key,cls,physics});return original.call(this,actor,dt);};
 const assets=new AssetStore(files),asset=await assets.get('00_Training'),game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:false});
 const runtime=game.doors.scriptRuntime.runtime,level=runtime.levelFor(game.player.collisionActor);
 const actors=level.actors.map((actor,index)=>{if(!actor)return null;try{return {index,name:actor.name,cls:runtime.instance(actor).cls.record.key,physics:runtime.readNamed(actor,'Physics'),pawn:actor.lineage?.includes('engine.pawn')??false,collisionView:runtime.collisionViewActors.has(actor)};}catch(error){return {index,name:actor.name,error:String(error)};}}).filter(Boolean);
 let error=null;try{for(let i=0;i<600;i++)game.tick(1/60,{});}catch(e){error=String(e);}
 await writeFile(out,JSON.stringify({firstDynamicActor:level.iFirstNetActor,actors,reached,error},null,2));
 console.log(JSON.stringify({bootModes:Object.fromEntries([...new Set(actors.map(a=>a.physics))].map(p=>[p,actors.filter(a=>a.physics===p).length])),reachedModes:[...new Set(reached.map(r=>r.physics))],error}));
}
