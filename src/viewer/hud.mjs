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
import {expandHudStream,STREAM_STRIDE} from '../runtime/script-window-command-stream.mjs';
import {switchReader} from '../runtime/switch-reader.mjs';
/** 'single' (default), 'js' or 'verify': HUD_DRAW / DEUS_EX_HUD_DRAW / `?hudDraw=`. 'single' draws a frame's tile runs from one
 * interleaved vertex buffer (a THREE.InterleavedBuffer with a group per run of one material) and reads the simulation's command
 * stream directly, without the command objects; 'js' keeps a mesh and three attribute buffers per run (the reference below);
 * 'verify' draws like 'single' after checking each tile segment against the reference, vertex for vertex and pixel for pixel
 * (docs/firefox-60fps-plan.md "HUD remainder"). */
export const hudDrawMode=switchReader('HUD_DRAW','DEUS_EX_HUD_DRAW','single');
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
        const image={key:ref.key,width:data.values.USize|0,height:data.values.VSize|0,gpu:live.texture,lease:live};
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
  // ---- hudDraw=single: one interleaved vertex buffer for a segment's runs --------------------------------------------------------
  // A vertex is [x, y, 0, u, v, r, g, b]: the reference's position, uv and tint attributes at the same float32 values, interleaved (the
  // z word is never written; the buffer starts zeroed). A tile is six vertices in the reference's order. A run of tiles of one material
  // is a group of the one geometry; the groups draw in the order they were added (the mesh's renderOrder is one value, the render list's
  // sort is stable and the groups share the object's id), as the reference's meshes drew by their renderOrder.
  const WORDS=8,TILE_WORDS=6*WORDS,WHITE=[255,255,255];
  let single=null;
  function singleState(){
    if(single)return single;
    const sceneOfRuns=new THREE.Scene(),mesh=new THREE.Mesh(new THREE.BufferGeometry(),[]);
    mesh.frustumCulled=false;mesh.visible=false;sceneOfRuns.add(mesh);
    return single={scene:sceneOfRuns,mesh,data:new Float32Array(0),buffer:null,capacity:0,tiles:0,groups:[],pool:[],groupCount:0,materials:[],
      material:null,images:[],stats:{segments:0,tiles:0,runs:0,verified:0,pixels:0}};
  }
  function growSingle(S,need){
    let capacity=Math.max(256,S.capacity*2);while(capacity<need)capacity*=2;
    const data=new Float32Array(capacity*TILE_WORDS);data.set(S.data.subarray(0,S.tiles*TILE_WORDS));
    const buffer=new THREE.InterleavedBuffer(data,WORDS).setUsage(THREE.DynamicDrawUsage),geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(buffer,3,0));
    geometry.setAttribute('uv',new THREE.InterleavedBufferAttribute(buffer,2,3));
    geometry.setAttribute('tint',new THREE.InterleavedBufferAttribute(buffer,3,5));
    geometry.groups=S.groups;
    S.mesh.geometry.dispose();S.mesh.geometry=geometry;S.data=data;S.buffer=buffer;S.capacity=capacity;
  }
  /** A tile's material: the image's own cache of its styles, else material() (whose Map the dynamic images' disposal walks). */
  function materialOf(image,style){
    if(style>=0&&style<8&&(style|0)===style)return (image.styleMaterials??=[])[style]??=material(image,style);
    return material(image,style);
  }
  function openRun(S,nextMaterial){
    const at=S.tiles*6,groups=S.groups;
    if(S.groupCount)groups[S.groupCount-1].count=at-groups[S.groupCount-1].start;
    let index=S.materials.indexOf(nextMaterial);if(index<0)index=S.materials.push(nextMaterial)-1;
    const group=S.pool[S.groupCount]??(S.pool[S.groupCount]={start:0,count:0,materialIndex:0});groups[S.groupCount]=group;
    group.start=at;group.materialIndex=index;S.groupCount++;S.material=nextMaterial;
  }
  /** The tile `draw` makes, from positional numbers (the stream's, or an object command's after its defaults and clip). */
  function emit(S,image,style,color,x,y,width,height,u,v,ul,vl){
    if(width<=0||height<=0||style===0)return;
    const nextMaterial=materialOf(image,style);
    if(nextMaterial!==S.material)openRun(S,nextMaterial);
    if(S.tiles>=S.capacity)growSingle(S,S.tiles+1);
    const data=S.data,p=S.tiles++*TILE_WORDS,right=x+width,bottom=y+height;
    const us=u/image.width,vs=v/image.height,ue=(u+ul)/image.width,ve=(v+vl)/image.height;
    // (a modulated tile ignores the tile color, as in draw)
    const white=style===4,r=white?1:color[0]/255,g=white?1:color[1]/255,b=white?1:color[2]/255;
    data[p]=x;data[p+1]=y;data[p+3]=us;data[p+4]=vs;data[p+5]=r;data[p+6]=g;data[p+7]=b;
    data[p+8]=right;data[p+9]=y;data[p+11]=ue;data[p+12]=vs;data[p+13]=r;data[p+14]=g;data[p+15]=b;
    data[p+16]=x;data[p+17]=bottom;data[p+19]=us;data[p+20]=ve;data[p+21]=r;data[p+22]=g;data[p+23]=b;
    data[p+24]=right;data[p+25]=y;data[p+27]=ue;data[p+28]=vs;data[p+29]=r;data[p+30]=g;data[p+31]=b;
    data[p+32]=right;data[p+33]=bottom;data[p+35]=ue;data[p+36]=ve;data[p+37]=r;data[p+38]=g;data[p+39]=b;
    data[p+40]=x;data[p+41]=bottom;data[p+43]=us;data[p+44]=ve;data[p+45]=r;data[p+46]=g;data[p+47]=b;
  }
  /** `draw`'s defaults and clip for a command object, then emit. */
  function emitCommand(S,image,command){
    let {x,y,width,height}=command,u=command.u===undefined?0:command.u,v=command.v===undefined?0:command.v;
    const color=command.color===undefined?WHITE:command.color,style=command.style===undefined?2:command.style,
      clip=command.clip===undefined?null:command.clip,ul=command.ul===undefined?width:command.ul,vl=command.vl===undefined?height:command.vl;
    if(width<=0||height<=0||style===0)return;
    if(clip){const left=Math.max(x,clip.x),top=Math.max(y,clip.y);
      width=Math.min(x+width,clip.x+clip.width)-left;height=Math.min(y+height,clip.y+clip.height)-top;
      u+=left-x;v+=top-y;x=left;y=top;if(width<=0||height<=0)return;}
    emit(S,image,style,color,x,y,width,height,u,v,ul,vl);
  }
  /** submit's image lookup for a texture: null for a tile not drawn (a snapshot the page has not made; an image still decoding). */
  function imageOf(texture){
    const image=images.get(texture.key);
    if(image)return image;
    if(!texture.dynamic)void imageFor(texture).catch(error=>{pendingError=error;});
    return null;
  }
  /** The tiles [start, end) of `source` (a command list, or a stream) into the buffer, in runs. */
  function fillSingle(S,source,start,end){
    S.tiles=0;S.groupCount=0;S.material=null;S.materials.length=0;
    if(Array.isArray(source)){
      for(let at=start;at<end;at++){
        const command=source[at],image=imageOf(command.texture);
        if(image)emitCommand(S,image,command);
      }
    }else{
      const {words,textures,colors,others}=source,cache=S.images;cache.length=textures.length;cache.fill(undefined);
      for(let i=start;i<end;i++){
        const at=i*STREAM_STRIDE;
        if(words[at]===0){
          const t=words[at+1];let image=cache[t];
          if(image===undefined)image=cache[t]=imageOf(textures[t]);
          if(image)emit(S,image,words[at+3],colors[words[at+2]],words[at+4],words[at+5],words[at+6],words[at+7],words[at+8],words[at+9],words[at+10],words[at+11]);
        }else{
          const command=others[words[at+1]],image=imageOf(command.texture);
          if(image)emitCommand(S,image,command);
        }
      }
    }
    if(S.groupCount)S.groups[S.groupCount-1].count=S.tiles*6-S.groups[S.groupCount-1].start;
    S.stats.segments++;S.stats.tiles+=S.tiles;S.stats.runs+=S.groupCount;
  }
  /** The single buffer's draw state for the filled runs (the reference's loop over its batches). */
  function readySingle(S){
    S.groups.length=S.groupCount;
    if(S.tiles){
      S.mesh.geometry.setDrawRange(0,S.tiles*6);
      S.buffer.clearUpdateRanges();S.buffer.addUpdateRange(0,S.tiles*TILE_WORDS);S.buffer.needsUpdate=true;
    }
    S.mesh.material=S.materials;S.mesh.visible=S.groupCount>0;
  }
  /** What submit does after the batches are filled, for the single buffer. */
  function drawSingle(renderer,S,start,keepDepth){
    if(!S.groupCount&&start>0)return;
    readySingle(S);
    if(!keepDepth)renderer.clearDepth();
    renderer.render(S.scene,camera);
  }
  /** One HUD frame in window order. `commands` is a list of the simulation's plain commands, or the simulation's command stream
   * (script-window-command-stream.mjs), which 'single' reads directly. A ViewportWindow's 'viewport' command
   * (XViewportWindow::Draw's DrawWorld, docs/script-window-viewport.md)
   * splits it: the GC draws before it are submitted, `viewport(command)`
   * draws that world frame into its rectangle, and the later draws go over
   * it. */
  function render(renderer,width,height,commands,{viewport=null,actor=null,clearZ=null}={}){
    if(pendingError)throw pendingError;
    camera.right=width;camera.bottom=height;camera.updateProjectionMatrix();
    const mode=hudDrawMode(),stream=Array.isArray(commands)?null:commands;
    // The reference (and the check) draws a stream's expansion: the command list, one command to each of the stream's entries.
    const list=stream&&mode!=='single'?expandHudStream(stream):stream?null:commands,source=mode==='js'?list:stream??commands;
    const total=stream?stream.count:commands.length,words=stream?.words,others=stream?.others;
    const kindAt=stream?i=>words[i*STREAM_STRIDE]===0?undefined:others[words[i*STREAM_STRIDE+1]].kind:i=>commands[i].kind;
    // GC.DrawActor's mesh draws are depth tested against the buffer as the overlay pass left it (ClearZ'd by
    // DrawWorld, the view model's depth): a frame with actor draws does not clear depth after its tile batches.
    let keepDepth=false;
    for(let i=0;i<total&&!keepDepth;i++){const kind=kindAt(i);keepDepth=kind==='actor'||kind==='clearZ';}
    let start=0;
    for(let end=0;end<=total;end++){
      const kind=end<total?kindAt(end):undefined;
      if(end<total&&kind!=='viewport'&&kind!=='actor'&&kind!=='clearZ')continue;
      if(mode==='js')submit(renderer,list,start,end,keepDepth);
      else if(mode==='verify')submitVerified(renderer,width,height,list,source,start,end,keepDepth);
      else{const S=singleState();fillSingle(S,source,start,end);drawSingle(renderer,S,start,keepDepth);}
      if(end<total){
        const command=stream?others[words[end*STREAM_STRIDE+1]]:commands[end];
        if(kind==='viewport')viewport?.(command);
        else if(kind==='actor')actor?.(command);
        else clearZ?.(command);
      }
      start=end+1;
    }
  }
  /** The reference's submit up to the render call: the batches of commands [start, end) filled. */
  function fillBatches(commands,start,end){
    count=0;current=null;
    for(let at=start;at<end;at++){
      const command=commands[at],image=images.get(command.texture.key);
      // A snapshot texture (RootWindow.GenerateSnapshot, docs/root-snapshot.md) is made by the page from its own frame; one the page has
      // not made (or has released) draws nothing.
      if(!image&&command.texture.dynamic)continue;
      if(!image){void imageFor(command.texture).catch(error=>{pendingError=error;});continue;}
      draw({...command,image});
    }
  }
  /** The reference's draw state for the filled batches (the verify mode sets it without the render call). */
  function readyBatches(){
    for(let i=0;i<count;i++){
      const batch=batches[i],vertices=batch.tiles*6,geometry=batch.mesh.geometry;
      geometry.setDrawRange(0,vertices);
      for(const attribute of Object.values(geometry.attributes)){
        attribute.clearUpdateRanges();attribute.addUpdateRange(0,vertices*attribute.itemSize);attribute.needsUpdate=true;
      }
    }
    for(let i=count;i<batches.length;i++)batches[i].mesh.visible=false;
  }
  function submit(renderer,commands,start,end,keepDepth=false){
    fillBatches(commands,start,end);
    if(!count&&start>0)return;
    readyBatches();
    if(!keepDepth)renderer.clearDepth();
    renderer.render(scene,camera);
  }
  // ---- hudDraw=verify -----------------------------------------------------------------------------------------------------------
  let checkTargets=null;
  const wordsOf=array=>new Uint32Array(array.buffer,array.byteOffset,array.length);
  /** A segment through both paths: the single buffer's vertices against the reference batches' attributes (bit for bit, run for run,
   * material for material), then both scenes drawn into two render targets over one ground and read back (every byte equal); then
   * the single path draws to the frame as 'single' does. */
  function submitVerified(renderer,width,height,list,source,start,end,keepDepth){
    const S=singleState(),where=`tiles [${start}, ${end})`;
    fillBatches(list,start,end);
    fillSingle(S,source,start,end);
    if(S.groupCount!==count)throw new Error(`hudDraw=verify: ${where}: ${S.groupCount} runs, the reference has ${count} batches`);
    const bits=wordsOf(S.data);let vertex=0;
    for(let i=0;i<count;i++){
      const batch=batches[i],group=S.groups[i],vertices=batch.tiles*6;
      if(group.start!==vertex||group.count!==vertices)throw new Error(`hudDraw=verify: ${where}: run ${i} covers [${group.start}, +${group.count}), the reference [${vertex}, +${vertices})`);
      if(S.materials[group.materialIndex]!==batch.mesh.material)throw new Error(`hudDraw=verify: ${where}: run ${i} has another material`);
      const attrs=batch.mesh.geometry.attributes;
      for(const [name,size,offset] of [['position',3,0],['uv',2,3],['tint',3,5]]){
        const reference=wordsOf(attrs[name].array);
        for(let k=0;k<vertices;k++)for(let c=0;c<size;c++){
          const a=reference[k*size+c],b=bits[(vertex+k)*WORDS+offset+c];
          if(a!==b)throw new Error(`hudDraw=verify: ${where}: run ${i} vertex ${k} ${name}[${c}] is ${b.toString(16)}, the reference ${a.toString(16)}`);
        }
      }
      vertex+=vertices;
    }
    if(S.tiles*6!==vertex)throw new Error(`hudDraw=verify: ${where}: ${S.tiles*6} vertices, the reference ${vertex}`);
    if(count||start===0){
      readyBatches();
      comparePixels(renderer,width,height,where,S);
      S.stats.verified++;
    }
    drawSingle(renderer,S,start,keepDepth);
  }
  function comparePixels(renderer,width,height,where,S){
    if(!checkTargets||checkTargets.width!==width||checkTargets.height!==height){
      checkTargets?.targets.forEach(target=>target.dispose());
      const make=()=>new THREE.WebGLRenderTarget(width,height,{depthBuffer:false,stencilBuffer:false,colorSpace:THREE.NoColorSpace});
      checkTargets={width,height,targets:[make(),make()],pixels:[new Uint8Array(width*height*4),new Uint8Array(width*height*4)]};
    }
    const previous=renderer.getRenderTarget(),clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
    readySingle(S);
    try{
      // (a ground that is neither black nor white, so modulated and translucent tiles show against it)
      renderer.setClearColor(0x6699cc,1);
      [scene,S.scene].forEach((drawn,i)=>{
        renderer.setRenderTarget(checkTargets.targets[i]);renderer.clear(true,false,false);
        renderer.render(drawn,camera);
        renderer.readRenderTargetPixels(checkTargets.targets[i],0,0,width,height,checkTargets.pixels[i]);
      });
    }finally{renderer.setRenderTarget(previous);renderer.setClearColor(clear,alpha);}
    const [a,b]=checkTargets.pixels;
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw new Error(`hudDraw=verify: ${where}: pixel ${(i>>2)%width},${Math.floor((i>>2)/width)} channel ${i&3} is ${b[i]}, the reference ${a[i]}`);
    S.stats.pixels+=width*height;
  }
  /** A texture the page made at run time: `image` is {width, height, data} (RGBA bytes, top row first). The previous texture of that key,
   * and its materials, are dropped. */
  function setDynamicImage(key,image){
    images.get(key)?.lease?.release();
    images.set(key,{key,...image});
    textures.get(key)?.dispose();textures.delete(key);
    for(const [name,material] of [...materials])if(name.startsWith(`${key}:`)){material.dispose();materials.delete(name);}
  }
  function releaseDynamicImage(key){
    images.get(key)?.lease?.release();images.delete(key);textures.get(key)?.dispose();textures.delete(key);
    for(const [name,material] of [...materials])if(name.startsWith(`${key}:`)){material.dispose();materials.delete(name);}
  }
  return {render,draw,setDynamicImage,releaseDynamicImage,
    /** The single buffer's counters (segments, tiles, runs drawn; the segments and pixels `hudDraw=verify` compared), or null. */
    stats(){return single?{...single.stats,capacity:single.capacity}:null;},
    dispose(){for(const b of batches)b.mesh.geometry.dispose();single?.mesh.geometry.dispose();checkTargets?.targets.forEach(target=>target.dispose());
      for(const m of materials.values())m.dispose();for(const [key,t] of textures)if(!images.get(key)?.gpu)t.dispose();
      for(const image of images.values())image.lease?.release();},
  };
}
