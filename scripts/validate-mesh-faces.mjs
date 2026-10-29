/** The typed per-mesh face blocks (src/runtime/mesh-faces.mjs, docs/live-heap.md "Step 4's results") against the readers they
 * replaced (test/helpers/mesh-faces-reference.mjs, the per-face objects), on every mesh of the installed game: every LodMesh and
 * classic Mesh export of every code package in System, and of the Island, Training and 747 maps. For each mesh: every field of
 * every face (wedges, vertices, UVs, material, flags, texture), the words the lighting kernel and GPU layout read, and the face
 * groups and group corners the actor mesh layer derives (with the skin of a face its TextureIndex, and with PF_Environment faces
 * as a separate texture). Also against the original: validate-lodmesh-materials.mjs compares the block's objects with Render.dll.
 *
 *   node scripts/validate-mesh-faces.mjs [--maps 01_NYC_UNATCOIsland,00_Training,03_NYC_747] */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';
import {meshFaces,faceObjects} from '../src/runtime/mesh-faces.mjs';
import {meshFaceGroups,groupCorners} from '../src/viewer/actor-mesh-skins.mjs';
import {POLY} from '../src/unreal/geometry.mjs';
import {referenceLodMeshSurfaces,referenceUMeshSurfaces,referenceFaceWords,referenceFaceGroups,referenceGroupCorners} from '../test/helpers/mesh-faces-reference.mjs';
import {gameDirectory} from './game-directory.mjs';

let root;
try{root=gameDirectory();}catch{console.log('SKIP validate-mesh-faces: no installed game data');process.exit(0);}
const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const maps=option('maps','01_NYC_UNATCOIsland,00_Training,03_NYC_747').split(',').filter(Boolean);
const packages=(await readdir(`${root}/System`)).filter(name=>/\.u$/i.test(name)&&!/ConAudio/i.test(name)).map(name=>`${root}/System/${name}`);
const files=[...packages];
for(const map of maps){
  const path=[`${root}/Maps/${map}.dx`,`${root}/Maps/${map}.unr`].find(existsSync);
  if(!path)throw new Error(`No map ${map}`);
  files.push(path);
}

const stats={packages:0,meshes:0,classic:0,faces:0,groups:0,environmentFaces:0,invisibleFaces:0,skipped:[]};
for(const path of files){
  const bytes=await readFile(path),pkg=parsePackage(bytes);
  stats.packages++;
  for(let i=0;i<pkg.exports.length;i++){
    const entry=pkg.exports[i];
    if(entry.className!=='LodMesh'&&entry.className!=='Mesh')continue;
    let mesh;
    try{mesh=decodeLodMeshPayload(pkg,bytes,i+1);}catch(error){stats.skipped.push(`${path.split('/').pop()}:${entry.name}: ${error.message}`);continue;}
    const label=`${path.split('/').pop()}:${entry.name}`,classic=mesh.payloadStatus==='decoded-mesh';
    const reference=classic?referenceUMeshSurfaces(mesh):referenceLodMeshSurfaces(mesh),block=meshFaces(mesh);
    assert.equal(block.count,reference.length,label);
    assert.deepEqual(faceObjects(block),reference,label);
    assert.deepEqual(block.words,referenceFaceWords(reference),label);
    assert.equal(meshFaces(mesh),block,`${label} is built once`);
    // The groups the layer derives: a skin per TextureIndex, the PF_Environment faces on a texture of their own.
    const skin=face=>face.flags&POLY.Environment?{key:'environment'}:{key:`T${face.texture}`};
    const expected=referenceFaceGroups(reference,skin,POLY.Invisible),actual=meshFaceGroups(block,(flags,texture)=>flags&POLY.Environment?{key:'environment'}:{key:`T${texture}`});
    assert.equal(actual.error,expected.error,label);
    assert.deepEqual([...actual.groups.keys()],[...expected.groups.keys()],label);
    for(const [key,group] of expected.groups){
      assert.deepEqual(actual.groups.get(key),group,`${label} ${key}`);
      assert.deepEqual(groupCorners(block,group),referenceGroupCorners(reference,group),`${label} ${key} corners`);
      stats.groups++;
    }
    stats.meshes++;if(classic)stats.classic++;stats.faces+=block.count;
    for(const face of reference){if(face.flags&POLY.Environment)stats.environmentFaces++;if(face.flags&POLY.Invisible)stats.invisibleFaces++;}
  }
}
assert.ok(stats.meshes>100,'the game has meshes to compare');
console.log(`PASS ${stats.meshes} meshes (${stats.classic} classic) of ${stats.packages} packages: ${stats.faces} faces field by field, ${stats.groups} face groups and their corners (${stats.environmentFaces} environment and ${stats.invisibleFaces} invisible faces)${stats.skipped.length?`; ${stats.skipped.length} meshes did not decode (${stats.skipped.slice(0,3).join('; ')})`:''}.`);
