import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {meshFaceNormal,meshEnvironmentUV} from '../src/runtime/mesh-environment.mjs';
const samples=[
  {kind:'faceNormal',points:[[0,0,0],[1,0,0],[0,1,0]]},
  {kind:'faceNormal',points:[[11.75,-21,34.5],[3.75,48,-2],[111,49.75,-42]]},
  {kind:'faceNormal',points:[[0,0,0],[0,0,0],[0,0,0]]},
  {points:[[1,0,0],[1,2,3],[0,0,4]],normals:[[1,0,0],[0,0,1],[0,1,0]]},
  {points:[[92,-73,1.2],[3,25,33],[-1.5,3.9,2.6]],normals:[[.2,.8,.4],[-.7,.1,.5],[.8,0,.6]],axes:[0,1,0,0,0,1,1,0,0]},
];
const results=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-mesh-environment-oracle.py'],{input:JSON.stringify({gameRoot:gameDirectory(),samples}),encoding:'utf8'}));
for(let i=0;i<samples.length;i++){
 const s=samples[i],expected=results[i];
 const actual=s.kind==='faceNormal'?s.points.map(()=>meshFaceNormal(s.points)):
   s.points.map((p,j)=>meshEnvironmentUV(p,s.normals[j],s.axes).map(v=>v*256));
 for(let j=0;j<3;j++)for(let k=0;k<actual[j].length;k++)assert.ok(Math.abs(actual[j][k]-expected[j][k])<.00005,
   `sample ${i} vertex ${j} component ${k}: ${actual[j][k]} vs native ${expected[j][k]}`);
}
console.log('5 original Render normal/environment cases passed (UV tolerance < 0.00005 texels at 256px).');
