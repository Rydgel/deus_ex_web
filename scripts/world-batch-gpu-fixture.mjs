/** Synthetic GPU boundary cases: no original assets or independent behavior model. */
import * as THREE from 'three';
import {LightAtlas,applyLightAtlas} from '../src/viewer/light-atlas.mjs';
import {batchWorldMeshes} from '../src/viewer/world-batches.mjs';
export async function runWorldBatchGpuFixture(){
const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(384,256);renderer.autoClear=false;
const target=new THREE.WebGLRenderTarget(384,256),camera=new THREE.PerspectiveCamera(60,384/256,.1,2000);
const make=(batched,pageCount=0)=>{
 const root=new THREE.Group(),scene=new THREE.Scene(),atlas=new LightAtlas(16),maps=[],materials=[],textures=[];
 scene.add(root);
 for(let k=0;k<12;k++){
  const size=2**(3+k%5),data=new Uint8Array(size*size*4);
  for(let i=0;i<data.length;i+=4){data[i]=(i/4*17+k*41)%256;data[i+1]=(i/4*37+k*7)%256;data[i+2]=(i/4*3+k*83)%256;data[i+3]=(i/4)%3?255:0;}
  const t=new THREE.DataTexture(data,size,size);t.flipY=false;t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.magFilter=k%3?THREE.LinearFilter:THREE.NearestFilter;t.minFilter=k%3?THREE.LinearMipmapLinearFilter:THREE.NearestMipmapNearestFilter;
  t.generateMipmaps=true;t.needsUpdate=true;textures.push(t);
 }
 for(let k=0;k<32;k++){
  const lm={width:6,height:5,pixels:Float32Array.from({length:90},(_,i)=>(i*13+k*3)%127/255),uv:()=>[.5,.5]};maps.push(lm);
  const tile=atlas.add(lm),geometry=new THREE.PlaneGeometry(2.5,1.7).toNonIndexed();
  const px=(k%7-3)*.31,py=(k%5-2)*.23;
  geometry.translate(px,py,0); // Deliberately overlapping, equal-depth faces.
  for(let i=0;i<geometry.attributes.uv.array.length;i++)geometry.attributes.uv.array[i]*=k%4?1:37;
  const count=geometry.attributes.position.count,uv=[],bounds=[],layers=[];
  for(let i=0;i<count;i++){uv.push((tile.x+(i%3)*3)/atlas.size,(tile.y+(i%2)*4)/atlas.size,k%7?1:0);bounds.push(...tile.bounds);layers.push(tile.page.index);}
  geometry.setAttribute('lightUV',new THREE.Float32BufferAttribute(uv,3));geometry.setAttribute('lightBounds',new THREE.Float32BufferAttribute(bounds,4));geometry.setAttribute('lightLayer',new THREE.Float32BufferAttribute(layers,1));
  const material=new THREE.MeshBasicMaterial({map:textures[k%12],side:k>25?THREE.DoubleSide:THREE.FrontSide,alphaTest:k>20?.5:0});
  material.userData={flags:0,key:`base${k%12}`};materials.push(material);applyLightAtlas(material,tile.page,{value:1},{value:2/3});
  const mesh=new THREE.Mesh(geometry,material);mesh.userData={actor:null,faces:[k*2,k*2+1]};root.add(mesh);
 }
 if(pageCount){
  // Exercise a non-power-of-two stride and the maximum code (selector7,
  // layer255 =>2055). Integer division/remainder must decode both exactly.
  let tile;
  while(atlas.pages.length<pageCount)tile=atlas.add({width:14,height:14,pixels:new Float32Array(14*14*3).fill(.23),uv:()=>[.5,.5]});
  tile.lightmap.pixels.fill(.47);atlas.update(tile.lightmap);
  // Put all eight sampler choices in visible foreground panels, including
  // unlit selector1 (exactly stride) and lit selector7 on the last layer.
  for(let k=0;k<8;k++)root.children[k].geometry
   .translate(-(k%7-3)*.31,-(k%5-2)*.23,0).scale(.2,.3,1).translate((k-3.5)*.55,0,.5);
  for(let i=2;i<root.children[1].geometry.attributes.lightUV.array.length;i+=3)
   root.children[1].geometry.attributes.lightUV.array[i]=0;
  const mesh=root.children[7],geometry=mesh.geometry;
  geometry.attributes.lightLayer.array.fill(tile.page.index);
  for(let i=0;i<geometry.attributes.position.count;i++){
   geometry.attributes.lightUV.array.set([(tile.x+(i%3)*3)/atlas.size,(tile.y+(i%2)*4)/atlas.size,1],i*3);
   geometry.attributes.lightBounds.array.set(tile.bounds,i*4);
  }
  applyLightAtlas(mesh.material,tile.page,{value:1},{value:2/3});
 }
 const stats=batched?batchWorldMeshes(root,atlas,{value:1},{value:2/3}):null;
 return {scene,atlas,maps,stats,dispose(){root.traverse(m=>m.geometry?.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());atlas.dispose();}};
};
const before=make(false),after=make(true),results=[];
for(const [distance,clip,update,large] of [[4,false,false],[21,false,false],[4,true,false],[4,false,true],[21,false,true],[4,false,false,true]]){
 const offset=large?new THREE.Vector3(10000,2000,600):new THREE.Vector3();
 if(large){
  for(const w of [before,after])w.scene.traverse(object=>object.geometry?.translate(...offset.toArray()));
  camera.near=1;camera.far=65536;camera.updateProjectionMatrix();
 }
 camera.position.set(large?1.9:.27,large?.9:.13,distance).add(offset);camera.lookAt(offset);camera.updateMatrixWorld();
 renderer.clippingPlanes=clip?[new THREE.Plane(new THREE.Vector3(1,0,0),.1)]:[];
 if(update)for(const w of [before,after]){
  w.maps[5].pixels[0]=.92;w.maps[29].pixels.fill(.17);
  w.atlas.update(w.maps[5],{partial:true,region:{minU:0,maxU:1,minV:0,maxV:1}});
  w.atlas.update(w.maps[29]);w.atlas.flush(renderer);
 }
 const render=w=>{renderer.setRenderTarget(target);renderer.setClearColor(0x164b87,1);renderer.clear();renderer.info.reset();renderer.render(w.scene,camera);
  const pixels=new Uint8Array(384*256*4);renderer.readRenderTargetPixels(target,0,0,384,256,pixels);return {pixels,calls:renderer.info.render.calls};};
 const a=render(before),b=render(after);let differences=0,max=0;
 for(let i=0;i<a.pixels.length;i++)if(a.pixels[i]!==b.pixels[i]){differences++;max=Math.max(max,Math.abs(a.pixels[i]-b.pixels[i]));}
 results.push({distance,clip,update,large:Boolean(large),differences,max,before:a.calls,after:b.calls});
}
const lost=new Promise(resolve=>renderer.domElement.addEventListener('webglcontextlost',resolve,{once:true}));
renderer.forceContextLoss();await lost;
// Full update while lost must not turn the next fresh array allocation into
// a selective upload that leaves the untouched layers uninitialized.
for(const w of [before,after]){w.maps[29].pixels.fill(.42);w.atlas.update(w.maps[29]);}
const restored=new Promise(resolve=>renderer.domElement.addEventListener('webglcontextrestored',resolve,{once:true}));
await new Promise(resolve=>setTimeout(resolve,100));
renderer.forceContextRestore();await restored;
const restoredRender=w=>{renderer.setRenderTarget(target);renderer.setClearColor(0x164b87,1);renderer.clear();renderer.render(w.scene,camera);
 const pixels=new Uint8Array(384*256*4);renderer.readRenderTargetPixels(target,0,0,384,256,pixels);return pixels;};
const restoreA=restoredRender(before),restoreB=restoredRender(after);
let restoreDifferences=0;for(let i=0;i<restoreA.length;i++)if(restoreA[i]!==restoreB[i])restoreDifferences++;
const decodeResults=[];
camera.near=.1;camera.far=2000;camera.updateProjectionMatrix();camera.position.set(.27,.13,4);camera.lookAt(0,0,0);camera.updateMatrixWorld();
for(const pages of [40,256]){
 const a=make(false,pages),b=make(true,pages),pixelsA=restoredRender(a),pixelsB=restoredRender(b);
 let differences=0;for(let i=0;i<pixelsA.length;i++)if(pixelsA[i]!==pixelsB[i])differences++;
 decodeResults.push({stride:pages+1,differences});a.dispose();b.dispose();
}
return {stats:after.stats,results,restoreDifferences,decodeResults,errors:renderer.getContext().getError()};

}
