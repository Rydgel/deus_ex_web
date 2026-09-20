/** Local real-data CPU benchmark; excludes GPU draw/compositor time. */
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createTrainingNpcPreview} from '../src/viewer/npc-mesh-preview.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const javascript=process.argv.includes('--javascript');
const preview=await createTrainingNpcPreview(game.doors.scriptRuntime.runtime,assets,asset,javascript?{kernel:null}:{});
if(!javascript&&preview.summary.poseBackend!=='rust-wasm')throw new Error(preview.summary.kernelError);
try {
  for(let i=0;i<30;i++){game.tick(1/60,{});preview.update();}
  const tick=[],mesh=[];
  for(let i=0;i<120;i++) {
    let start=performance.now();game.tick(1/60,{});tick.push(performance.now()-start);
    start=performance.now();preview.update();mesh.push(performance.now()-start);
  }
  const stats=values=>{
    const sorted=values.toSorted((a,b)=>a-b);
    return {mean:values.reduce((sum,n)=>sum+n,0)/values.length,median:sorted[60],p95:sorted[114]};
  };
  console.log(JSON.stringify({map:asset.name,seed:1,frames:120,secondsPerFrame:1/60,
    meshes:preview.actors.length,poseBackend:preview.summary.poseBackend,milliseconds:{simulation:stats(tick),meshPosing:stats(mesh),
      total:stats(tick.map((value,i)=>value+mesh[i]))},
    unsupportedNpcs:[...game.doors.scriptRuntime.npcFailures].map(([actor,message])=>({actor:actor.name,message}))},null,2));
} finally {preview.dispose();}
