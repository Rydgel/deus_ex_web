/** Validate the original GM_Trench LodMesh prefix and native-259 boundary. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {decodeLodMesh, findSequence} from '../src/runtime/lodmesh.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const engineBytes=await readFile(`${root}/System/Engine.dll`);
const characterBytes=await readFile(`${root}/System/DeusExCharacters.u`);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(engineBytes),'0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
assert.equal(sha256(characterBytes),'bc9911e4e35440aef12d27c6239c596eef28673e3360d8e6b18fcdffdfbdc32d');

// The corrected oracle executes the complete original ULodMesh::Serialize
// body over this exact export. It must consume the entire million-byte payload.
const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const oracle=execFileSync(python,['scripts/native-lodmesh-oracle.py','DeusExCharacters:668'],{
  cwd:new URL('..',import.meta.url),encoding:'utf8',maxBuffer:32*1024*1024,
});
assert.match(oracle,/GM_Trench: returned, consumed local 1019128 of 1019128/);

const files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files);
const characters=await assets.get('DeusExCharacters');
const meshIndex=characters.exportsByPath.get('gm_trench');
assert.equal(meshIndex,669);
const mesh=decodeLodMesh(characters.pkg,characterBytes,meshIndex);
assert.equal(mesh.entry.className,'LodMesh');
assert.equal(mesh.entry.serialSize,1019128);
assert.equal(mesh.eagerEnd,993850);
assert.equal(mesh.sequences.length,71);
assert.deepEqual(findSequence(mesh,'HitTorso'),{
  name:'HitTorso',group:'TakeHit',startFrame:71,numFrames:4,
  notifyCount:0,notifies:[],rate:10,
});
assert.deepEqual(findSequence(mesh,'HitLegLeft'),{
  name:'HitLegLeft',group:'TakeHit',startFrame:79,numFrames:4,
  notifyCount:0,notifies:[],rate:10,
});

const mapAsset=await assets.get('00_Training');
const game=await createGame(decodeMap(mapAsset.bytes),mapAsset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime;
const player=game.player.collisionActor;
const meshReference=runtime.namedReference(player,'Mesh').get();
assert.equal(meshReference.key,'deusexcharacters.gm_trench');
const prepared=await runtime.prepareMesh(player);
assert.equal(prepared,runtime.meshPayload(player));
assert.equal(prepared.sequences.length,71);
assert.equal(runtime.resources.resources.get(meshReference.key).payloadStatus,'decoded-eager-prefix');

// TakeDamage uses PlayAnim('Hit*',,0.1): EX_Nothing occupies Rate while the
// later TweenTime is present. Native P_GET_FLOAT_OPTX retains Rate=1.
for(const [name,value] of [
  ['AnimSequence','None'],['AnimFrame',0],['AnimRate',0],['TweenRate',0],
  ['AnimLast',0],['OldAnimRate',0],
]) runtime.namedReference(player,name).set(value);
const args=['HitTorso',undefined,Math.fround(0.1)];
runtime.invokeNative({
  index:259,receiver:player,argumentCount:args.length,
  evaluateArgument:index=>args[index],script:{entry:{path:'Fixture.GMTrenchPlayAnim'}},
});
assert.equal(runtime.namedReference(player,'AnimSequence').get(),'HitTorso');
assert.equal(runtime.namedReference(player,'AnimFrame').get(),Math.fround(0.001));
assert.equal(runtime.namedReference(player,'AnimRate').get(),Math.fround(2.5));
assert.equal(runtime.namedReference(player,'TweenRate').get(),0);
assert.equal(runtime.namedReference(player,'AnimLast').get(),-3);
assert.equal(runtime.namedReference(player,'OldAnimRate').get(),Math.fround(2.5));

console.log('GM_Trench passed the complete original ULodMesh serializer, 71-sequence browser decode, canonical player preparation, and PlayAnim optional-hole state writes.');
