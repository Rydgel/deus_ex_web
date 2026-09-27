/** Original HUD tiles composited after the world, in original logical pixels.
 * Uses the existing renderer so DSTY_Translucent blends with the actual world.
 */
import * as THREE from 'three';
export async function createHudRenderer(hud){
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,1,0,1,-1,1);
  const textures=new Map(),materials=new Map(),quads=[];
  let count=0,pendingError=null;
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
  function draw({image,x,y,width,height,u=0,v=0,color=[255,255,255],style=2,clip=null,ul=width,vl=height}){
    if(!image||width<=0||height<=0||style===0)return;
    // GC.DrawTexture source extents track destination pixels. Window clips
    // shift U/V by the same amount; no scaling of the original texture art.
    if(clip){const left=Math.max(x,clip.x),top=Math.max(y,clip.y);
      width=Math.min(x+width,clip.x+clip.width)-left;height=Math.min(y+height,clip.y+clip.height)-top;
      u+=left-x;v+=top-y;x=left;y=top;if(width<=0||height<=0)return;}
    let quad=quads[count];
    if(!quad){const g=new THREE.BufferGeometry();
      for(const [name,size] of [['position',3],['uv',2],['tint',3]])g.setAttribute(name,new THREE.Float32BufferAttribute(new Float32Array(6*size),size));
      quad=new THREE.Mesh(g);quad.frustumCulled=false;quads.push(quad);scene.add(quad);}
    quad.visible=true;quad.renderOrder=count++;quad.material=material(image,style);
    const positions=[x,y,0,x+width,y,0,x,y+height,0,x+width,y,0,x+width,y+height,0,x,y+height,0];
    const us=u/image.width,vs=v/image.height,ue=(u+ul)/image.width,ve=(v+vl)/image.height;
    const attrs=quad.geometry.attributes;attrs.position.array.set(positions);
    attrs.uv.array.set([us,vs,ue,vs,us,ve,ue,vs,ue,ve,us,ve]);
    for(let i=0;i<6;i++)attrs.tint.array.set(color.map(c=>c/255),i*3);
    for(const a of Object.values(attrs))a.needsUpdate=true;
  }
  function render(renderer,width,height,dialog=null,view=null){
    if(pendingError)throw pendingError;
    count=0;camera.right=width;camera.bottom=height;camera.updateProjectionMatrix();
    for(const command of hud.commands(width,height,view)){
      const image=hud.images.get(command.texture.key);
      if(!image){void hud.imageFor(command.texture).catch(error=>{pendingError=error;});continue;}
      draw({...command,image});
    }
    for(let i=count;i<quads.length;i++)quads[i].visible=false;
    renderer.clearDepth();renderer.render(scene,camera);
  }
  return {render,draw,
    dispose(){for(const q of quads)q.geometry.dispose();for(const m of materials.values())m.dispose();for(const t of textures.values())t.dispose();},
  };
}
