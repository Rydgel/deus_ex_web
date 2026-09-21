/** Original HUD tiles composited after the world, in original logical pixels.
 * Uses the existing renderer so DSTY_Translucent blends with the actual world.
 */
import * as THREE from 'three';
import {hudColor} from '../runtime/script-play-hud.mjs';
import {createHudText} from './hud-text.mjs';
import {TextureStore} from '../unreal/textures.mjs';
import {conversationHudFrame} from './conversation-hud.mjs';

export async function createHudRenderer(hud,assets,shell){
  const dx=await assets.get('DeusEx');
  const cls=await hud.runtime.loadClass(dx,dx.exportsByPath.get('hudconwindowfirst'));
  const defaultOf=name=>hud.runtime.defaultValue(cls,hud.runtime.lookupMember(cls,'fields',name));
  const text=await createHudText(assets,[...new Set(['DeusExUI.FontTiny','DeusExUI.FontMenuHeaders_DS',
    'DeusExUI.FontFixedWidthSmall_DS','DeusExUI.FontMenuSmall_DS',defaultOf('fontName').key])]);
  const store=new TextureStore(assets);
  for(const field of ['texBackgrounds','texBorders'])for(const ref of hud.read(shell.object,field)){
    const data=await store.get(ref.asset,ref.index,true);hud.images.set(ref.key,{key:ref.key,...data.mips[0]});
  }
  for(const field of ['texBackgrounds','texBorders'])for(const ref of defaultOf(field)){
    if(!ref||hud.images.has(ref.key))continue;
    const data=await store.get(ref.asset,ref.index,true);hud.images.set(ref.key,{key:ref.key,...data.mips[0]});
  }
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,1,0,1,-1,1);
  const textures=new Map(),materials=new Map(),quads=[];
  const white={key:'$hud-solid',width:1,height:1,data:new Uint8Array([255,255,255,255])};
  let count=0;
  function material(image,style){
    const key=`${image.key}:${style}`;
    if(!textures.has(image.key)){
      const texture=new THREE.DataTexture(image.data,image.width,image.height,THREE.RGBAFormat);
      texture.magFilter=texture.minFilter=THREE.NearestFilter;texture.flipY=false;
      texture.generateMipmaps=false;texture.needsUpdate=true;textures.set(image.key,texture);
    }
    if(!materials.has(key)){
      const m=new THREE.ShaderMaterial({uniforms:{map:{value:textures.get(image.key)}},
        vertexShader:'attribute vec3 tint; varying vec2 texCoord; varying vec3 tileColor; void main(){texCoord=uv;tileColor=tint;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader:`uniform sampler2D map; varying vec2 texCoord; varying vec3 tileColor; void main(){vec4 c=texture2D(map,texCoord);${style===2?'if(c.a<0.5)discard;':''}gl_FragColor=vec4(c.rgb*tileColor,1.);}`,
        // Keep every HUD tile in one render list so parent frames precede
        // opaque portraits and masked glyphs, exactly in Window draw order.
        depthTest:false,depthWrite:false,side:THREE.DoubleSide,transparent:true,
        blending:style===3?THREE.CustomBlending:THREE.NoBlending,
        blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcColorFactor,
        toneMapped:false});materials.set(key,m);
    }
    return materials.get(key);
  }
  function draw({image,x,y,width,height,u=0,v=0,color=[255,255,255],style=2,clip=null}){
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
    const us=u/image.width,vs=v/image.height,ue=(u+width)/image.width,ve=(v+height)/image.height;
    const attrs=quad.geometry.attributes;attrs.position.array.set(positions);
    attrs.uv.array.set([us,vs,ue,vs,us,ve,ue,vs,ue,ve,us,ve]);
    for(let i=0;i<6;i++)attrs.tint.array.set(color.map(c=>c/255),i*3);
    for(const a of Object.values(attrs))a.needsUpdate=true;
  }
  const decorate=(object,x,y,post=false)=>{
    for(const command of hud.decorationCommands(object,post)){
      const positioned={...command,x:x+command.x,y:y+command.y};
      if(command.borders)text.borders(draw,{...positioned,images:command.borders.map(ref=>ref&&hud.images.get(ref.key))});
      else draw({...positioned,image:hud.images.get(command.texture)});
    }
  };
  function children(object,x,y,clip=null){
    for(const child of hud.children.get(object)??[]){
      if(!hud.visible(child))continue;
      const r=hud.rect(child),at={x:x+r.x,y:y+r.y,width:r.width,height:r.height};
      const ref=hud.background(child);
      if(ref)draw({...at,...hud.tile(child),image:hud.images.get(ref.key),clip});
      if(child===hud.read(hud.hit,'winEnergy')||child===hud.read(hud.hit,'winBreath')){
        const size=hud.read(child,'barSize');
        draw({image:white,x:at.x,y:at.y+at.height-size,width:at.width,height:size,
          color:hudColor(hud.read(child,'colForeground')),style:1,clip});
      }
      children(child,at.x,at.y,clip?{
        x:Math.max(clip.x,at.x),y:Math.max(clip.y,at.y),
        width:Math.max(0,Math.min(clip.x+clip.width,at.x+at.width)-Math.max(clip.x,at.x)),
        height:Math.max(0,Math.min(clip.y+clip.height,at.y+at.height)-Math.max(clip.y,at.y)),
      }:at);
    }
  }
  function render(renderer,width,height,dialog=null){
    count=0;camera.right=width;camera.bottom=height;camera.updateProjectionMatrix();
    for(const object of [hud.hit,hud.compass])if(hud.visible(object)){
      const r=hud.rect(object);decorate(object,r.x,r.y);children(object,r.x,r.y);
      if(object===hud.compass)decorate(object,r.x,r.y,true);
    }
    if(hud.visible(hud.hit)){
      const bar=hud.read(hud.hit,'winEnergy');
      text.draw(draw,{font:'DeusExUI.FontTiny',text:hud.read(hud.hit,'EnergyText'),x:13,y:74,width:8,height:8,
        color:hudColor(hud.read(bar,'colForeground'))});
      if(hud.read(hud.hit,'bUnderwater'))text.draw(draw,{font:'DeusExUI.FontTiny',text:hud.read(hud.hit,'O2Text'),
        x:61,y:74,width:8,height:8,color:hudColor(hud.read(hud.read(hud.hit,'winBreath'),'colForeground'))});
    }
    const image=hud.images.get(hud.background(hud.cross)?.key);
    if(image)draw({image,x:Math.trunc((width-image.width)/2+.5),y:Math.trunc((height-image.height)/2+.5),
      width:image.width,height:image.height,color:[255,255,255],style:2});
    if(dialog?.state?.shellVisible){
      const {state,shell:info}=dialog;
      // DeusExHUD.ConfigurationChanged: no visible log => (hitWidth+20,0).
      const x=hud.rect(hud.hit).width+20,y=0;
      decorate(info.object,x,y);
      const controls=Object.fromEntries(info.initializedControls.map(c=>[c.name,c]));
      const portrait=controls.winPortrait;
      if(state.portraitVisible&&state.portrait!=='none')draw({
        image:state.portrait==='icon'?state.content.dataLinkIcon:state.content.portrait,
        x:x+portrait.x,y:y+portrait.y,width:portrait.width,height:portrait.height,
        style:state.portrait==='icon'?2:1});
      const line=controls.winLine;
      draw({image:white,x:x+line.x,y:y+line.y,width:line.width,height:line.height,
        color:[line.tileColor.r,line.tileColor.g,line.tileColor.b],style:1});
      for(const [name,value,show] of [['winName',state.title,state.titleVisible],['winQueued',state.queuedText??'',true]]){
        const c=controls[name];if(!show||!value)continue;
        text.draw(draw,{font:c.font,text:value,x:x+c.x,y:y+c.y,width:c.width,height:c.height,
          color:[c.textColor.r,c.textColor.g,c.textColor.b],hAlign:c.horizontalAlignment,vAlign:c.verticalAlignment});
      }
      const body=controls.winText;
      text.draw(draw,{font:body.font,text:state.text,x:x+body.x,y:y+body.y,width:body.width,height:body.height,
        color:[info.colors.text.r,info.colors.text.g,info.colors.text.b]});
    }
    const face=conversationHudFrame(hud.runtime,hud.player,shell,width,height,text.measure);
    if(face){
      decorate(face.window,face.x,face.y);
      for(const c of face.children){
        if(c.text!==undefined)text.draw(draw,{...c,x:face.x+c.x+c.mx,y:face.y+c.y+c.my,
          width:c.width-2*c.mx,height:c.height-2*c.my});
        else draw({image:white,x:face.x+c.x,y:face.y+c.y,width:c.width,height:c.height,...hud.tile(c.object)});
      }
    }
    for(let i=count;i<quads.length;i++)quads[i].visible=false;
    renderer.clearDepth();renderer.render(scene,camera);
  }
  return {render,draw,
    dispose(){for(const q of quads)q.geometry.dispose();for(const m of materials.values())m.dispose();for(const t of textures.values())t.dispose();},
  };
}
