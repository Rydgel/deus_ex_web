import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {createHudRenderer} from '../src/viewer/hud.mjs';

// Previous compositor's one-tile geometry, retained at this representation
// boundary. Native GC/Window behavior is covered by validate-play-hud.mjs.
function tile(command,image){
  let {x,y,width,height,u=0,v=0,color=[255,255,255],style=2,clip=null,ul=width,vl=height}=command;
  if(!image||width<=0||height<=0||style===0)return null;
  if(clip){const left=Math.max(x,clip.x),top=Math.max(y,clip.y);
    width=Math.min(x+width,clip.x+clip.width)-left;height=Math.min(y+height,clip.y+clip.height)-top;
    u+=left-x;v+=top-y;x=left;y=top;if(width<=0||height<=0)return null;}
  const us=u/image.width,vs=v/image.height,ue=(u+ul)/image.width,ve=(v+vl)/image.height;
  const tint=new Float32Array(18);for(let i=0;i<6;i++)tint.set(color.map(c=>c/255),i*3);
  return {image:image.key,style,
    position:new Float32Array([x,y,0,x+width,y,0,x,y+height,0,x+width,y,0,x+width,y+height,0,x,y+height,0]),
    uv:new Float32Array([us,vs,ue,vs,us,ve,ue,vs,ue,ve,us,ve]),tint};
}

test('HUD batches consecutive materials without changing the ordered tile stream',async()=>{
  const images=new Map(['font','portrait'].map(key=>[key,{key,width:128,height:64,data:new Uint8Array(128*64*4)}]));
  let commands=[],actual=[],drawCalls=0;
  const hud={images,commands:()=>commands,imageFor:()=>{throw new Error('Unexpected missing image');}};
  const compositor=await createHudRenderer(hud);
  const renderer={clearDepth(){},render(scene){
    actual=[];drawCalls=0;
    for(const mesh of scene.children.filter(mesh=>mesh.visible).sort((a,b)=>a.renderOrder-b.renderOrder)){
      drawCalls++;
      const {geometry,material}=mesh,count=geometry.drawRange.count;
      assert.equal(geometry.drawRange.start,0);assert.equal(count%6,0);
      assert.equal(material.depthWrite,false);assert.equal(material.depthTest,false);assert.equal(material.transparent,true);
      assert.equal(material.forceSinglePass,true);
      const image=[...images.values()].find(image=>image.data===material.uniforms.map.value.image.data);
      const style=material.blending===THREE.CustomBlending?(material.blendSrc===THREE.DstColorFactor?4:3):
        material.fragmentShader.includes('discard')?2:1;
      assert.equal(material.blendDst,style===4?THREE.SrcColorFactor:THREE.OneMinusSrcColorFactor);
      for(let i=0;i<count;i+=6){
        const entry={image:image.key,style};
        for(const name of ['position','uv','tint']){
          const attr=geometry.getAttribute(name);assert.ok(attr.version>0);
          assert.deepEqual(attr.updateRanges,[{start:0,count:count*attr.itemSize}]);
          entry[name]=attr.array.slice(i*attr.itemSize,(i+6)*attr.itemSize);
        }
        actual.push(entry);
      }
    }
  }};
  const command=(image='font',style=2,extra={})=>({texture:{key:image},x:1.25,y:2.5,width:7,height:11,u:3,v:5,style,...extra});
  try{
    const verify=()=>{
      compositor.render(renderer,1440,960);
      const expected=commands.map(command=>tile(command,images.get(command.texture.key))).filter(Boolean);
      assert.deepEqual(actual,expected,'Float32 tile attributes, material and triangle order match the former compositor');
      const runs=expected.reduce((count,t,i)=>count+Number(!i||t.image!==expected[i-1].image||t.style!==expected[i-1].style),0);
      assert.equal(drawCalls,runs);
    };
    // A long glyph run grows the retained buffers several times. Returning
    // to its texture after a portrait must start a separate ordered run.
    commands=[...Array.from({length:65},(_,i)=>command('font',2,{x:i*7.125,color:[i,255-i,128]})),
      command('font',2,{width:0}),command('portrait',0),command('portrait',3),command('font',2),
      command('font',4),command('font',1),command('font',2,{x:-0,y:-0,color:[0,0,0]}),
      command('font',2,{x:-2,y:-3,clip:{x:0,y:0,width:3,height:5},ul:19,vl:23}),
      command('font',2,{x:30,clip:{x:0,y:0,width:10,height:10}})];
    verify();assert.equal(drawCalls,6);assert.equal(actual.length,71);
    commands=[command('portrait',4),...Array.from({length:9},()=>command('font',3))];verify();
    commands=[command('font',2)];verify();
    commands=[];verify();
    commands=Array.from({length:130},()=>command('font',2));verify();assert.equal(drawCalls,1);
  }finally{compositor.dispose();}
});
