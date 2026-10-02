import * as THREE from 'three';
import {POLY} from '../unreal/geometry.mjs';
import {sharedProceduralTextures} from './procedural-textures.mjs';

/** Scene-owned static skin textures. Only GPU textures and sampler state
 * are shared; each actor retains its material, lighting and draw order.
 * Acquisition is synchronous after the existing private decoder's awaits,
 * so texture sharing does not change async material allocation order.
 * See docs/actor-mesh-texture-sharing.md. */
export class ActorMeshTextures {
  constructor() {
    this.entries=new Map();this.disposed=false;
    // FireTexture skins (docs/fire-texture.md): the page's shared live
    // textures, updated once per frame by the world (world.mjs).
    this.procedural=sharedProceduralTextures();
  }
  acquire(data,flags) {
    if(this.disposed)throw new Error('Actor mesh texture pool is disposed');
    if(data.procedural==='FireTexture'||data.procedural==='WetTexture')return this.procedural.acquire(data);
    if(data.procedural||data.values.AnimNext)throw new Error('Animated/procedural mesh skin is unsupported');
    // Blend/side/environment flags live on each actor's material or UVs and
    // do not change these immutable texels and sampler settings.
    const key=`${data.key}:${data.masked}:${Boolean(flags&POLY.NoSmooth)}`;
    let entry=this.entries.get(key);
    if(!entry) {
      const first=data.mips[0],texture=new THREE.DataTexture(first.data,first.width,first.height,THREE.RGBAFormat);
      texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;
      texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
      texture.magFilter=flags&POLY.NoSmooth?THREE.NearestFilter:THREE.LinearFilter;
      const last=data.mips.at(-1),complete=last.width===1&&last.height===1;
      if(complete&&data.mips.length>1)texture.mipmaps=data.mips;
      texture.generateMipmaps=!complete;
      texture.minFilter=flags&POLY.NoSmooth?THREE.NearestMipmapNearestFilter:THREE.LinearMipmapLinearFilter;
      texture.needsUpdate=true;
      this.entries.set(key,entry={texture,references:0,disposed:false});
    }
    entry.references++;
    let released=false;
    return {texture:entry.texture,release:()=>{
      if(released)return;released=true;
      if(--entry.references===0&&!entry.disposed){
        entry.disposed=true;this.entries.delete(key);entry.texture.dispose();
      }
    }};
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    for(const entry of this.entries.values()){
      entry.disposed=true;entry.texture.dispose();
    }
    this.entries.clear();
  }
}
