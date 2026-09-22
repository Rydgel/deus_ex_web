/** The instant-hit trace Pawn.TraceShot runs with the optional Extent omitted.
 * TraceShot (Pawn.uc:1173) calls Trace(HitLocation, HitNormal, EndTrace,
 * StartTrace, True) — native 277 with five arguments, dropping the optional
 * Extent. The handler previously required exactly six and raised "Trace takes
 * six arguments", so every TraceShot caller (weapon fire, AI) stopped there.
 * The Trace declaration (Actor.uc:845) has three required and three optional
 * parameters, and the native already carries their defaults; only the arg-count
 * gate was wrong. docs/script-trace.md, docs/script-weapon-equip.md.
 *
 * SAFETY: this traces straight down into the floor, so the trace resolves
 * against world geometry and never a Pawn — TraceShot's re-trace-on-Pawn
 * recursion is not entered, and no weapon state machine (its latent NormalFire
 * loop) is touched. Exercising the weapon fire path itself is a separate,
 * currently unsafe boundary recorded in docs/script-weapon-equip.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createGame} from '../src/viewer/game.mjs';

const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;

// A downward trace from the player: guaranteed world hit, never a Pawn.
const start=game.player.position.slice();
const end=[start[0],start[1],start[2]-200];
const outLocation=[0,0,0],outNormal=[0,0,0];

// Before the native-277 optional-argument fix this threw "Trace takes six
// arguments"; TraceShot passes only five (Extent omitted).
let other;
assert.doesNotThrow(()=>{
  other=runtime.dispatchSpawnedEvent(player,'TraceShot',[outLocation,outNormal,end,start]);
},'Pawn.TraceShot runs Trace with the optional Extent omitted');

// The floor trace hits world geometry: the native returns the world hit
// identity (the level info actor) rather than null. (dispatchSpawnedEvent does
// not propagate the out HitLocation/HitNormal back to these JS arrays, so the
// return value is what is asserted here — the point is that the five-argument
// Trace ran and produced a hit instead of the arg-count boundary.)
assert.ok(other,'the downward TraceShot returns the world floor hit (native 277 ran with five args)');
assert.equal(game.doors.scriptRuntime.npcFailures.size,0,'the trace introduces no actor failure');

console.log('trace shot: Pawn.TraceShot runs the instant-hit Trace with the optional Extent '+
  `omitted (native 277, five args), hitting ${other.name ?? 'the world'}.`);
