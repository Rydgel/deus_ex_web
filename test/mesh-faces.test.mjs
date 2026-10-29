/** mesh-faces.mjs against the per-face-object readers it replaced (test/helpers/mesh-faces-reference.mjs): every field of every
 * face, the errors, the groups and corners the actor mesh layer derives, and the sharing. The real meshes of the game are
 * compared by scripts/validate-mesh-faces.mjs. Translation regression checks, not original-game evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {MeshFaces,buildLodMeshFaces,buildUMeshFaces,meshFaces,faceObjects,faceList} from '../src/runtime/mesh-faces.mjs';
import {readLodMeshSurfaces} from '../src/runtime/lodmesh-materials.mjs';
import {readUMeshSurfaces} from '../src/runtime/umesh-surfaces.mjs';
import {meshFaceGroups,groupCorners} from '../src/viewer/actor-mesh-skins.mjs';
import {POLY} from '../src/unreal/geometry.mjs';
import {referenceLodMeshSurfaces,referenceUMeshSurfaces,referenceFaceWords,referenceFaceGroups,referenceGroupCorners,
  referenceVertexFaceLists,referenceLodVertexLists} from './helpers/mesh-faces-reference.mjs';
import {vertexFaceLists,lodVertexLists} from '../src/viewer/gpu-mesh-layout.mjs';

/** A seeded generator (the same sequence on every run). */
function random(seed) {
  let state=seed>>>0;
  return limit=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*limit);};
}
/** A LodMesh payload of random faces, wedges and materials in the shape the readers see (arrays at +144, +15c, +168; SpecialVerts at +184). */
function lodMesh(seed,{faces=40,wedges=70,materials=5,vertices=50,special=3,fault=null}={}) {
  const next=random(seed);
  const faceBytes=new Uint8Array(faces*8),faceView=new DataView(faceBytes.buffer);
  for(let i=0;i<faces;i++){
    for(let j=0;j<3;j++)faceView.setUint16(i*8+j*2,next(wedges),true);
    faceView.setUint16(i*8+6,next(materials),true);
  }
  const wedgeBytes=new Uint8Array(wedges*4),wedgeView=new DataView(wedgeBytes.buffer);
  for(let i=0;i<wedges;i++){
    wedgeView.setUint16(i*4,next(vertices),true);wedgeBytes[i*4+2]=next(256);wedgeBytes[i*4+3]=next(256);
  }
  const materialBytes=new Uint8Array(materials*8),materialView=new DataView(materialBytes.buffer);
  for(let i=0;i<materials;i++){
    // flags with the top bit set now and then, so the unsigned reading matters
    materialView.setUint32(i*8,(next(0x10000)|(next(2)?0x80000000:0))>>>0,true);materialView.setInt32(i*8+4,next(9)-1,true);
  }
  const array=(bytes,elementSize,num)=>({num,elementSize,data:bytes});
  const mesh={frameVertexCount:vertices+special,scalarBits:new Map([[0x184,special]]),payloadStatus:'decoded-lodmesh',
    arrays:new Map([[0x144,array(faceBytes,8,faces)],[0x15c,array(wedgeBytes,4,wedges)],[0x168,array(materialBytes,8,materials)]])};
  if(fault==='material')faceView.setUint16(6,materials,true);
  if(fault==='wedge')faceView.setUint16(0,wedges,true);
  if(fault==='vertex')for(let i=0;i<wedges;i++)wedgeView.setUint16(i*4,vertices,true);
  if(fault==='array')mesh.arrays.get(0x15c).elementSize=8;
  if(fault==='size')mesh.arrays.get(0x168).num+=1;
  if(fault==='missing')mesh.arrays.delete(0x144);
  return mesh;
}
function umesh(seed,{triangles=30,vertices=40,fault=false}={}) {
  const next=random(seed),bytes=new Uint8Array(triangles*20),view=new DataView(bytes.buffer);
  for(let i=0;i<triangles;i++){
    for(let j=0;j<3;j++)view.setUint16(i*20+j*2,next(vertices),true);
    for(let j=0;j<6;j++)bytes[i*20+6+j]=next(256);
    view.setUint32(i*20+12,(next(0x10000)|(next(2)?0x80000000:0))>>>0,true);view.setInt32(i*20+16,next(5)-1,true);
  }
  if(fault)view.setUint16(20*2+2,vertices,true);
  const array=(data,num)=>({load(){return this;},data,num});
  return {payloadStatus:'decoded-mesh',frameVertexCount:vertices,
    arrays:new Map([[0x78,array(bytes,triangles)],[0x9c,array(new Uint8Array(0),0)],[0xcc,array(new Uint8Array(0),0)]])};
}
const outcome=run=>{try{return {value:run()};}catch(error){return {error:`${error.constructor.name}: ${error.message}`};}};

test('a LodMesh block holds every field of every face the object reader gives',()=>{
  for(let seed=1;seed<=60;seed++) {
    const mesh=lodMesh(seed,{faces:1+seed*7,wedges:3+seed*5,materials:1+seed%9,vertices:4+seed*3,special:seed%6});
    for(const polyFlags of [0,0x4000,0x80000000,0x4001]) {
      const reference=referenceLodMeshSurfaces(mesh,{polyFlags}),block=buildLodMeshFaces(mesh,{polyFlags});
      assert.equal(block.count,reference.length);
      assert.deepEqual(faceObjects(block),reference);
      assert.deepEqual(readLodMeshSurfaces(mesh,{polyFlags}),reference);
      assert.deepEqual(block.words,referenceFaceWords(reference));
    }
  }
});

test('a LodMesh without faces is an empty block',()=>{
  const block=buildLodMeshFaces(lodMesh(7,{faces:0}));
  assert.equal(block.count,0);
  assert.deepEqual(faceObjects(block),[]);
});

test('malformed LodMesh surface data throws the errors the object reader threw',()=>{
  for(const fault of ['material','wedge','vertex','array','size','missing']) {
    const mesh=lodMesh(11,{fault}),reference=outcome(()=>referenceLodMeshSurfaces(mesh));
    assert.ok(reference.error,fault);
    assert.deepEqual(outcome(()=>buildLodMeshFaces(mesh)),reference,fault);
  }
});

test('a classic UMesh block holds the triangles the object reader gave, with no wedges',()=>{
  for(let seed=1;seed<=30;seed++) {
    const mesh=umesh(seed,{triangles:1+seed*3,vertices:5+seed*2}),reference=referenceUMeshSurfaces(mesh),block=buildUMeshFaces(mesh);
    assert.deepEqual(faceObjects(block),reference);
    assert.deepEqual(readUMeshSurfaces(mesh),reference);
    assert.deepEqual(block.words,referenceFaceWords(reference));
    assert.equal(block.wedges.length,0);
  }
  const bad=umesh(3,{fault:true}),reference=outcome(()=>referenceUMeshSurfaces(bad));
  assert.ok(reference.error);
  assert.deepEqual(outcome(()=>buildUMeshFaces(bad)),reference);
});

test('meshFaces is built once for a mesh, and dispatches on the payload kind',()=>{
  const lod=lodMesh(5),classic=umesh(5);
  assert.equal(meshFaces(lod),meshFaces(lod));
  assert.ok(meshFaces(lod) instanceof MeshFaces);
  assert.deepEqual(faceObjects(meshFaces(lod)),referenceLodMeshSurfaces(lod));
  assert.deepEqual(faceObjects(meshFaces(classic)),referenceUMeshSurfaces(classic));
  assert.notEqual(meshFaces(lodMesh(5)),meshFaces(lod),'blocks are per payload');
  const broken=lodMesh(5,{fault:'material'});
  assert.throws(()=>meshFaces(broken),/material is out of range/);
  assert.throws(()=>meshFaces(broken),/material is out of range/,'a failed build is not kept');
});

test('face groups and corners over the block are the object reader\'s',()=>{
  const skin=texture=>({key:`T${texture}`});
  for(let seed=1;seed<=40;seed++) {
    const mesh=lodMesh(seed,{faces:30+seed*5,wedges:20+seed*4,materials:1+seed%7,vertices:10+seed*2});
    const objects=referenceLodMeshSurfaces(mesh),block=buildLodMeshFaces(mesh);
    for(const hide of [false,true]) {
      if(hide)objects.forEach((face,i)=>{if(i%5===0){face.flags=(face.flags|POLY.Invisible)>>>0;block.words[i*4+3]=face.flags;}});
      const reference=referenceFaceGroups(objects,face=>skin(face.texture),POLY.Invisible),
        actual=meshFaceGroups(block,(flags,texture)=>skin(texture));
      assert.equal(reference.error,undefined);
      assert.equal(actual.error,undefined);
      assert.deepEqual([...actual.groups.keys()],[...reference.groups.keys()]);
      for(const [key,group] of reference.groups) {
        assert.deepEqual(actual.groups.get(key),group);
        assert.deepEqual(groupCorners(block,group),referenceGroupCorners(objects,group));
      }
    }
  }
});

test('a face whose skin slot is empty ends the grouping with the same error',()=>{
  let errors=0;
  for(let seed=1;seed<=20;seed++) {
    const mesh=lodMesh(seed,{faces:25}),objects=referenceLodMeshSurfaces(mesh),block=buildLodMeshFaces(mesh);
    const skin=texture=>texture===3?null:{key:`T${texture}`};
    const reference=referenceFaceGroups(objects,face=>skin(face.texture),POLY.Invisible),actual=meshFaceGroups(block,(flags,texture)=>skin(texture));
    assert.equal(actual.error,reference.error);
    if(reference.error)errors++;else assert.deepEqual([...actual.groups.keys()],[...reference.groups.keys()]);
  }
  assert.ok(errors>0);
});

test('anyFlags and faceList read the words',()=>{
  const block=buildLodMeshFaces(lodMesh(9)),objects=referenceLodMeshSurfaces(lodMesh(9));
  assert.equal(block.anyFlags(POLY.Environment),objects.some(face=>face.flags&POLY.Environment));
  assert.equal(block.anyFlags(0),false);
  assert.deepEqual(faceList(block.words),objects.map(face=>({vertices:face.vertices,flags:face.flags})));
});

const asLists=({starts,items},V)=>Array.from({length:V},(_,v)=>[...items.subarray(starts[v],starts[v+1])]);

test('the GPU layout\'s vertex adjacency lists are the arrays of arrays they replaced, as offsets and items',()=>{
  for(let seed=1;seed<=40;seed++) {
    const V=8+seed*3,mesh=lodMesh(seed,{faces:10+seed*6,wedges:12+seed*4,materials:3,vertices:V,special:0}),block=buildLodMeshFaces(mesh);
    assert.deepEqual(asLists(vertexFaceLists(block.words,block.count,V),V),referenceVertexFaceLists(block.words,block.count,V));
  }
  assert.throws(()=>vertexFaceLists(Uint32Array.of(0,1,9,0),1,5),/face vertex out of range/);
});

test('the LOD vertex lists keep the walk\'s order and its repeat rule',()=>{
  for(let seed=1;seed<=40;seed++) {
    const next=random(seed*7),wedges=20+seed*3,V=10+seed*2,special=seed%4,faceCount=15+seed*3;
    const faces=new Uint16Array(faceCount*4),collapseWedges=new Uint16Array(wedges),wedgeWords=new Uint32Array(wedges);
    for(let i=0;i<faceCount*4;i++)faces[i]=next(wedges);
    // chains that end at a wedge pointing to itself, some pointing back to an earlier wedge of the same vertex
    for(let w=0;w<wedges;w++){collapseWedges[w]=next(4)===0?w:Math.max(0,w-next(5));wedgeWords[w]=next(V-special)|(next(256)<<16);}
    for(let w=0;w<wedges;w++)if(collapseWedges[w]>=w)collapseWedges[w]=w;
    const topology={faces,faceCount,wedges:wedgeWords,collapseWedges,special};
    assert.deepEqual(asLists(lodVertexLists(topology,V),V),referenceLodVertexLists(topology,V),`seed ${seed}`);
  }
});
