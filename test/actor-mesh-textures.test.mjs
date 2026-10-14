import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ActorMeshTextures} from '../src/viewer/actor-mesh-textures.mjs';
import {POLY} from '../src/unreal/geometry.mjs';

const decoded=(masked=false)=>({key:'deusextextures.skin',values:{},masked,mips:[
  {width:2,height:2,data:new Uint8Array(16).fill(masked?0:255)},
  {width:1,height:1,data:new Uint8Array(4).fill(255)},
]});

test('static skins share GPU texture across private decodes with independent material-only flags',()=>{
  const pool=new ActorMeshTextures(),data=decoded();
  const a=pool.acquire(data,0),b=pool.acquire(decoded(),POLY.Translucent|POLY.TwoSided);
  assert.equal(a.texture,b.texture);
  assert.equal(a.texture.image.data,data.mips[0].data);
  assert.equal(a.texture.mipmaps,data.mips);
  assert.equal(a.texture.colorSpace,THREE.SRGBColorSpace);
  assert.equal(a.texture.flipY,false);
  assert.equal(a.texture.wrapS,THREE.RepeatWrapping);
  assert.equal(a.texture.wrapT,THREE.RepeatWrapping);
  assert.equal(a.texture.magFilter,THREE.LinearFilter);
  assert.equal(a.texture.minFilter,THREE.LinearMipmapNearestFilter,'D3DDrv MIPFILTER POINT (docs/texture-sampling.md)');
  assert.equal(a.texture.generateMipmaps,false);
  let disposed=0;a.texture.addEventListener('dispose',()=>disposed++);
  a.release();a.release();assert.equal(disposed,0,'the surviving actor still owns the texture');
  b.release();assert.equal(disposed,1);
  pool.dispose();assert.equal(disposed,1);
});

test('palette masking and NoSmooth require different shared texture variants',()=>{
  const pool=new ActorMeshTextures();
  const plain=pool.acquire(decoded(),0),masked=pool.acquire(decoded(true),POLY.Masked);
  const nearest=pool.acquire(decoded(),POLY.NoSmooth);
  assert.equal(new Set([plain.texture,masked.texture,nearest.texture]).size,3);
  assert.notDeepEqual(plain.texture.image.data,masked.texture.image.data);
  assert.equal(nearest.texture.magFilter,THREE.NearestFilter);
  assert.equal(nearest.texture.minFilter,THREE.NearestMipmapNearestFilter);
  const alias=pool.acquire(decoded(true),POLY.Environment|POLY.Masked);
  assert.equal(alias.texture,masked.texture,'canonical identity and final masking select the texture');
  pool.dispose();for(const lease of [plain,masked,nearest,alias])lease.release();
});

test('disposal during async decode cannot create a late texture or double-dispose existing leases',async()=>{
  const pool=new ActorMeshTextures(),existing=pool.acquire(decoded(),0);
  let disposals=0;existing.texture.addEventListener('dispose',()=>disposals++);
  let complete;
  const pendingDecode=new Promise(resolve=>{complete=resolve;});
  const pending=pendingDecode.then(data=>pool.acquire(data,POLY.NoSmooth));
  pool.dispose();pool.dispose();complete(decoded());
  await assert.rejects(pending,/pool is disposed/);
  existing.release();assert.equal(disposals,1);
  assert.equal(pool.entries.size,0);
  assert.throws(()=>pool.acquire(decoded(),0),/pool is disposed/);
});

test('animated and procedural skins remain unsupported without allocating a GPU texture',()=>{
  for(const special of [{values:{AnimNext:2}},{procedural:'Static source image'}]){
    const pool=new ActorMeshTextures();
    assert.throws(()=>pool.acquire({...decoded(),...special},0),/Animated\/procedural mesh skin is unsupported/);
    assert.equal(pool.entries.size,0);pool.dispose();
  }
});
