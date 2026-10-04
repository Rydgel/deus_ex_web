/** Original HUD tiles composited after the world, in original logical pixels.
 * Uses the existing renderer so DSTY_Translucent blends with the actual world.
 * The commands are the simulation's plain GC commands (sim-session.mjs hud);
 * their textures decode here from the page's own asset store.
 */
import * as THREE from 'three';
import {TextureStore} from '../unreal/textures.mjs';
export async function createHudRenderer({assets,preload=[]}){
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,1,0,1,-1,1);
  const textures=new Map(),materials=new Map(),batches=[];
  const images=new Map(),pending=new Map(),store=new TextureStore(assets);
  let count=0,current=null,pendingError=null;
  async function imageFor(ref){
    if(images.has(ref.key))return images.get(ref.key);
    if(!pending.has(ref.key))pending.set(ref.key,(async()=>{
      const data=await store.get(await assets.get(ref.package),ref.index,'point'),image={key:ref.key,...data.mips[0]};
      images.set(ref.key,image);return image;
    })());
    return pending.get(ref.key);
  }
  // The textures the HUD's construction reached decode before its first
  // frame; a texture a later DrawWindow submits first draws once decoded.
  await Promise.all(preload.map(imageFor));
  function material(image,style){
    const key=`${image.key}:${style}`;
    if(!textures.has(image.key)){
      const texture=new THREE.DataTexture(image.data,image.width,image.height,THREE.RGBAFormat);
      texture.magFilter=texture.minFilter=THREE.NearestFilter;texture.flipY=false;
      texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.generateMipmaps=false;texture.needsUpdate=true;textures.set(image.key,texture);
    }
    if(!materials.has(key)){
      const m=new THREE.ShaderMaterial({uniforms:{map:{value:textures.get(image.key)}},
        vertexShader:'attribute vec3 tint; varying vec2 texCoord; varying vec3 tileColor; void main(){texCoord=uv;tileColor=tint;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader:`uniform sampler2D map; varying vec2 texCoord; varying vec3 tileColor; void main(){vec4 c=texture2D(map,texCoord);${style===2?'if(c.a<0.5)discard;':''}gl_FragColor=vec4(c.rgb*tileColor,1.);}`,
        // Keep every HUD tile in one render list so parent frames precede
        // opaque portraits and masked glyphs, exactly in Window draw order.
        depthTest:false,depthWrite:false,side:THREE.DoubleSide,transparent:true,
        blending:style===3||style===4?THREE.CustomBlending:THREE.NoBlending,
        blendSrc:style===4?THREE.DstColorFactor:THREE.OneFactor,blendDst:style===4?THREE.SrcColorFactor:THREE.OneMinusSrcColorFactor,
        toneMapped:false});materials.set(key,m);
    }
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
    const tint=attrs.tint.array,r=color[0]/255,g=color[1]/255,b=color[2]/255;
    for(let i=p;i<p+18;i+=3){tint[i]=r;tint[i+1]=g;tint[i+2]=b;}
  }
  function render(renderer,width,height,commands){
    if(pendingError)throw pendingError;
    count=0;current=null;camera.right=width;camera.bottom=height;camera.updateProjectionMatrix();
    for(const command of commands){
      const image=images.get(command.texture.key);
      if(!image){void imageFor(command.texture).catch(error=>{pendingError=error;});continue;}
      draw({...command,image});
    }
    for(let i=0;i<count;i++){
      const batch=batches[i],vertices=batch.tiles*6,geometry=batch.mesh.geometry;
      geometry.setDrawRange(0,vertices);
      for(const attribute of Object.values(geometry.attributes)){
        attribute.clearUpdateRanges();attribute.addUpdateRange(0,vertices*attribute.itemSize);attribute.needsUpdate=true;
      }
    }
    for(let i=count;i<batches.length;i++)batches[i].mesh.visible=false;
    renderer.clearDepth();renderer.render(scene,camera);
  }
  return {render,draw,
    dispose(){for(const b of batches)b.mesh.geometry.dispose();for(const m of materials.values())m.dispose();for(const t of textures.values())t.dispose();},
  };
}
