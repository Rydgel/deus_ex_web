/** Original skin-selection workers/exec and full-resolution mesh surface data. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),textures=[],surfaces=[],meshes=[];
for(const mode of ['get','exec'])for(const [name,fields] of [
  ['slot-zero-skin',{index:0,skin:777}],['slot-zero-default',{index:0}],
  ['slot-one-mesh-before-skin',{index:1,skin:777}],['null-slot-skin',{index:2,skin:777}],
  ['null-slot',{index:2}],['multi-before-both',{index:1,skin:777,multi:[0,888,0,0,0,0,0,0]}],
  ['beyond-multiskins',{index:8,skin:777}],
])textures.push({name:`${mode}-${name}`,mode,...fields});
textures.push({name:'get-without-actor',mode:'get',index:1,noActor:true});
for(const index of [-1,9])for(const skin of [0,777])
  textures.push({name:`exec-outside-${index}-${skin}`,mode:'exec',index,skin});
textures.push({name:'exec-empty',mode:'exec',textures:[]},
  {name:'exec-nothing',mode:'exec',nothing:true},
  {name:'exec-no-mesh',mode:'exec',noMesh:true,multi:[888,0,0,0,0,0,0,0]});
for(const index of [-2147483648,-1,0,7,8,2147483647])
  textures.push({name:`skin-${index}`,mode:'skin',index,multi:[111,0,0,0,0,0,0,888]});
for(const [pack,index] of [['DeusExDeco',606],['DeusExCharacters',669]]) {
  const bytes=await readFile(`${root}/System/${pack}.u`),pkg=parsePackage(bytes);
  const mesh=decodeLodMeshPayload(pkg,bytes,index);meshes.push(mesh);
  surfaces.push({name:mesh.entry.name,frameVerts:mesh.frameVertexCount,special:mesh.scalarBits.get(0x184),flags:0x4000,
    arrays:Object.fromEntries([0x144,0x15c,0x168].map(offset=>{
      const a=mesh.arrays.get(offset);return [offset,{num:a.num,data:Buffer.from(a.data).toString('base64')}];
    }))});
}
const specs={textures,surfaces};
let reference;
if(process.argv.includes('--captured')) {
  const saved=JSON.parse(await readFile('.cache/research/lodmesh-materials-original.json','utf8'));
  assert.deepEqual(saved.specs,specs);reference=saved.reference;
}else reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-lodmesh-materials-oracle.py',root],{input:JSON.stringify(specs),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/lodmesh-materials-original.json',JSON.stringify({specs,reference}));
  console.log(`Captured ${textures.length} full skin/texture calls and ${reference.surfaces.map(s=>`${s.name}: ${s.faces.length} faces`).join(', ')}.`);
  process.exit(0);
}
const {getActorSkin,getMeshTexture,execGetMeshTexture,readLodMeshSurfaces}=await import('../src/runtime/lodmesh-materials.mjs');
for(const [i,sample] of textures.entries()) {
  const mesh={textures:(sample.textures??[11,22,0,44,0,66,0,88,99]).map(v=>v||null)};
  const actor={Mesh:sample.noMesh?null:mesh,Skin:sample.skin||null,MultiSkins:(sample.multi??Array(8).fill(0)).map(v=>v||null)};
  const events=[],services={read:(a,n)=>a[n],textureAt:(m,i)=>m.textures[i],textureCount:m=>m.textures.length,
    getSkin(a,index){events.push({op:'GetSkin',index});return getActorSkin(a,index,services.read);},
    warning:text=>events.push({op:'warning',text})};
  const index=sample.index??0;
  const result=sample.mode==='skin'?services.getSkin(actor,index):sample.mode==='get'
    ?getMeshTexture(mesh,sample.noActor?null:actor,index,services)
    :execGetMeshTexture({receiver:actor,argumentCount:1,evaluateArgument:()=>sample.nothing?undefined:index},services);
  assert.equal(result??0,reference.textures[i].result,sample.name);
  assert.deepEqual(events,reference.textures[i].events,sample.name);
}
for(const [i,mesh] of meshes.entries()) {
  const faces=readLodMeshSurfaces(mesh,{polyFlags:surfaces[i].flags});
  assert.deepEqual(faces.map(face=>({wedges:face.wedges,vertices:face.vertices,packed:face.uv.map((uv,j)=>
    ((face.vertices[j]-surfaces[i].special)|(uv[0]<<16)|(uv[1]<<24))>>>0),
    material:face.material,flags:face.flags,texture:face.texture})),reference.surfaces[i].faces,mesh.entry.name);
}
console.log(`PASS ${textures.length} complete original skin/texture calls and ${reference.surfaces.reduce((n,s)=>n+s.faces.length,0)} faces through original Render ranges: material/flags, wedges, UV bytes and special-vertex offsets.`);
