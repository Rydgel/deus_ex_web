/** Original HUD tiles composited after the world, in original logical pixels.
 * Uses the existing renderer so DSTY_Translucent blends with the actual world.
 * A 'viewport', 'actor' (GC.DrawActor) or 'clearZ' (GC.ClearZ) command splits the stream
 * in window order: the tiles before it are submitted, then the caller's handler runs.
 * The commands are the simulation's plain GC commands (sim-session.mjs hud);
 * their textures decode here from the page's own asset store.
 */
import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
import {sharedProceduralTextures} from './procedural-textures.mjs';
/** A tile batch's material for a texture and Style (createHudRenderer), the shader warm-up's too (hudWarmup).
 * A modulated tile is masked too: D3DDrv.dll DrawTile (0x10005ba0) replaces the PolyFlags of a PF_Modulated tile with
 * PF_Modulated|PF_Masked (0x42, at 0x10005c27) before SetBlending (0x10008270), whose PF_Masked bit is ALPHATESTENABLE, so its
 * index-zero texels are not drawn; the shader is then the masked style's (one program). */
function tileMaterial(texture,style){
  return new THREE.ShaderMaterial({uniforms:{map:{value:texture}},
    vertexShader:'attribute vec3 tint; varying vec2 texCoord; varying vec3 tileColor; void main(){texCoord=uv;tileColor=tint;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`uniform sampler2D map; varying vec2 texCoord; varying vec3 tileColor; void main(){vec4 c=texture2D(map,texCoord);${style===2||style===4?'if(c.a<0.5)discard;':''}gl_FragColor=vec4(c.rgb*tileColor,1.);}`,
    // Keep every HUD tile in one render list so parent frames precede
    // opaque portraits and masked glyphs, exactly in Window draw order.
    depthTest:false,depthWrite:false,side:THREE.DoubleSide,transparent:true,
    blending:style===3||style===4?THREE.CustomBlending:THREE.NoBlending,
    blendSrc:style===4?THREE.DstColorFactor:THREE.OneFactor,blendDst:style===4?THREE.SrcColorFactor:THREE.OneMinusSrcColorFactor,
    toneMapped:false});
}
/** The shader warm-up's tile batches (shader-warmup.mjs): the masked style's shader and the others' (one program). */
export function hudWarmup({texture,geometry}){return [1,2].map(style=>new THREE.Mesh(geometry,tileMaterial(texture,style)));}
export async function createHudRenderer({assets,preload=[]}){
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,1,0,1,-1,1);
  const textures=new Map(),materials=new Map(),batches=[];
  const images=new Map(),pending=new Map(),store=new TextureStore(assets);
  let count=0,current=null,pendingError=null;
  async function imageFor(ref){
    if(images.has(ref.key))return images.get(ref.key);
    if(!pending.has(ref.key))pending.set(ref.key,(async()=>{
      const asset=await assets.get(ref.package),data=await store.get(asset,ref.index,'point');
      // A Fire.dll texture (the drunk and drugged HUD background DrunkFX is a WetTexture) is the page's live procedural
      // texture, as on BSP surfaces, mesh skins and sprites: its stored mip is Serialize's zeroed one, which a modulated tile
      // turns into a black screen.
      if(data.procedural==='FireTexture'||data.procedural==='WetTexture'){
        const live=sharedProceduralTextures().acquire(await store.get(asset,ref.index,false));
        const image={key:ref.key,width:data.values.USize|0,height:data.values.VSize|0,gpu:live.texture};
        images.set(ref.key,image);return image;
      }
      const image={key:ref.key,...data.mips[0]};
      images.set(ref.key,image);return image;
    })());
    return pending.get(ref.key);
  }
  // The textures the HUD's construction reached decode before its first
  // frame; a texture a later DrawWindow submits first draws once decoded.
  await Promise.all(preload.map(imageFor));
  function material(image,style){
    const key=`${image.key}:${style}`;
    if(!textures.has(image.key)&&image.gpu)textures.set(image.key,image.gpu);
    if(!textures.has(image.key)){
      const texture=new THREE.DataTexture(image.data,image.width,image.height,THREE.RGBAFormat);
      texture.magFilter=texture.minFilter=THREE.NearestFilter;texture.flipY=false;
      texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.generateMipmaps=false;texture.needsUpdate=true;textures.set(image.key,texture);
    }
    if(!materials.has(key))materials.set(key,tileMaterial(textures.get(image.key),style));
    return materials.get(key);
  }
  function batchFor(nextMaterial){
    if(current?.mesh.material===nextMaterial)return current;
    let batch=batches[count];
    if(!batch){
      const mesh=new THREE.Mesh(new THREE.BufferGeometry());mesh.frustumCulled=false;scene.add(mesh);
      batch={mesh,capacity:0,tiles:0};batches.push(batch);
    }
    batch.tiles=0;batch.mesh.visible=true;batch.mesh.renderOrder=count++;batch.mesh.material=nextMaterial;
    return current=batch;
  }
  function reserve(batch,tiles){
    if(batch.capacity>=tiles)return;
    const capacity=Math.max(8,batch.capacity*2),geometry=new THREE.BufferGeometry();
    for(const [name,size] of [['position',3],['uv',2],['tint',3]]){
      const array=new Float32Array(capacity*6*size),previous=batch.mesh.geometry.getAttribute(name);
      if(previous)array.set(previous.array);
      geometry.setAttribute(name,new THREE.BufferAttribute(array,size).setUsage(THREE.DynamicDrawUsage));
    }
    batch.mesh.geometry.dispose();batch.mesh.geometry=geometry;batch.capacity=capacity;
  }
  function draw({image,x,y,width,height,u=0,v=0,color=[255,255,255],style=2,clip=null,ul=width,vl=height}){
    if(!image||width<=0||height<=0||style===0)return;
    // GC.DrawTexture source extents track destination pixels. Window clips
    // shift U/V by the same amount; no scaling of the original texture art.
    if(clip){const left=Math.max(x,clip.x),top=Math.max(y,clip.y);
      width=Math.min(x+width,clip.x+clip.width)-left;height=Math.min(y+height,clip.y+clip.height)-top;
      u+=left-x;v+=top-y;x=left;y=top;if(width<=0||height<=0)return;}
    // Keep Window/GC command order, including translucent overlap. Only a
    // consecutive run with exactly the same material shares a submission.
    const batch=batchFor(material(image,style));reserve(batch,batch.tiles+1);
    const vertex=batch.tiles++*6,attrs=batch.mesh.geometry.attributes;
    const positions=attrs.position.array,p=vertex*3,right=x+width,bottom=y+height;
    positions[p]=x;positions[p+1]=y;positions[p+2]=0;
    positions[p+3]=right;positions[p+4]=y;positions[p+5]=0;
    positions[p+6]=x;positions[p+7]=bottom;positions[p+8]=0;
    positions[p+9]=right;positions[p+10]=y;positions[p+11]=0;
    positions[p+12]=right;positions[p+13]=bottom;positions[p+14]=0;
    positions[p+15]=x;positions[p+16]=bottom;positions[p+17]=0;
    const us=u/image.width,vs=v/image.height,ue=(u+ul)/image.width,ve=(v+vl)/image.height;
    const uv=attrs.uv.array,t=vertex*2;
    uv[t]=us;uv[t+1]=vs;uv[t+2]=ue;uv[t+3]=vs;uv[t+4]=us;uv[t+5]=ve;
    uv[t+6]=ue;uv[t+7]=vs;uv[t+8]=ue;uv[t+9]=ve;uv[t+10]=us;uv[t+11]=ve;
    // A modulated tile ignores the tile color: D3DDrv.dll DrawTile writes the vertex color 0xffffffff for PF_Modulated
    // (0x10005c5c to 0x10005c9d) and Color * MaxColor only for the other styles. DeusExScopeView draws HUDScopeView modulated
    // right after the black tile color of its borders.
    const white=style===4,tint=attrs.tint.array,r=white?1:color[0]/255,g=white?1:color[1]/255,b=white?1:color[2]/255;
    for(let i=p;i<p+18;i+=3){tint[i]=r;tint[i+1]=g;tint[i+2]=b;}
  }
  /** One HUD frame in window order. A ViewportWindow's 'viewport' command
   * (XViewportWindow::Draw's DrawWorld, docs/script-window-viewport.md)
   * splits it: the GC draws before it are submitted, `viewport(command)`
   * draws that world frame into its rectangle, and the later draws go over
   * it. */
  function render(renderer,width,height,commands,{viewport=null,actor=null,clearZ=null}={}){
    if(pendingError)throw pendingError;
    camera.right=width;camera.bottom=height;camera.updateProjectionMatrix();
    // GC.DrawActor's mesh draws are depth tested against the buffer as the overlay pass left it (ClearZ'd by
    // DrawWorld, the view model's depth): a frame with actor draws does not clear depth after its tile batches.
    const keepDepth=commands.some(command=>command.kind==='actor'||command.kind==='clearZ');
    let start=0;
    for(let end=0;end<=commands.length;end++){
      if(end<commands.length&&!['viewport','actor','clearZ'].includes(commands[end].kind))continue;
      submit(renderer,commands,start,end,keepDepth);
      if(end<commands.length){
        const command=commands[end];
        if(command.kind==='viewport')viewport?.(command);
        else if(command.kind==='actor')actor?.(command);
        else clearZ?.(command);
      }
      start=end+1;
    }
  }
  function submit(renderer,commands,start,end,keepDepth=false){
    count=0;current=null;
    for(let at=start;at<end;at++){
      const command=commands[at],image=images.get(command.texture.key);
      // A snapshot texture (RootWindow.GenerateSnapshot, docs/root-snapshot.md) is made by the page from its own frame; one the page has
      // not made (or has released) draws nothing.
      if(!image&&command.texture.dynamic)continue;
      if(!image){void imageFor(command.texture).catch(error=>{pendingError=error;});continue;}
      draw({...command,image});
    }
    if(!count&&start>0)return;
    for(let i=0;i<count;i++){
      const batch=batches[i],vertices=batch.tiles*6,geometry=batch.mesh.geometry;
      geometry.setDrawRange(0,vertices);
      for(const attribute of Object.values(geometry.attributes)){
        attribute.clearUpdateRanges();attribute.addUpdateRange(0,vertices*attribute.itemSize);attribute.needsUpdate=true;
      }
    }
    for(let i=count;i<batches.length;i++)batches[i].mesh.visible=false;
    if(!keepDepth)renderer.clearDepth();
    renderer.render(scene,camera);
  }
  /** A texture the page made at run time: `image` is {width, height, data} (RGBA bytes, top row first). The previous texture of that key,
   * and its materials, are dropped. */
  function setDynamicImage(key,image){
    images.set(key,{key,...image});
    textures.get(key)?.dispose();textures.delete(key);
    for(const [name,material] of [...materials])if(name.startsWith(`${key}:`)){material.dispose();materials.delete(name);}
  }
  function releaseDynamicImage(key){
    images.delete(key);textures.get(key)?.dispose();textures.delete(key);
    for(const [name,material] of [...materials])if(name.startsWith(`${key}:`)){material.dispose();materials.delete(name);}
  }
  return {render,draw,setDynamicImage,releaseDynamicImage,
    dispose(){for(const b of batches)b.mesh.geometry.dispose();for(const m of materials.values())m.dispose();for(const [key,t] of textures)if(!images.get(key)?.gpu)t.dispose();},
  };
}
