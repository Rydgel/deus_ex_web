/** Light-map atlas uploads in Play (docs/play-frame-cost.md, October 2).
 *
 * Host rendering only, no original behavior: light maps reach the GPU once,
 * in the sealed array, and unbatched surfaces sample their page's layer.
 * 1. On this browser/GPU, linear sampling of one 2D-array layer returns the
 *    same bytes as the same texels in a 2D texture, through the light-map
 *    shader's clamp, at arbitrary sub-texel positions.
 * 2. In Play, after the per-rectangle texSubImage3D path has run for many
 *    frames of animated light maps, every array layer read back from the GPU
 *    equals the CPU page bytes, no page texture was uploaded, light-map
 *    changes did not re-upload the whole array and GL reports no error.
 *
 *   node scripts/validate-light-atlas-upload.mjs [--url http://127.0.0.1:5173] [--map 00_Training]
 *     [--browser chromium|firefox]
 *   (default: its own dev server of this checkout, Chromium). Firefox copies
 *   each upload's whole source view, so its uploads take another shape
 *   (light-atlas.mjs flush); --browser firefox checks them there.
 */
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium,firefox} from '@playwright/test';
import {createServer} from 'vite';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const map=option('map','00_Training'),engine=option('browser','chromium');
if(engine!=='chromium'&&engine!=='firefox')throw new Error('--browser must be chromium or firefox');
try{gameDirectory();}catch{console.log('SKIP validate-light-atlas-upload: no installed game data');process.exit(0);}
// Without --url, a bounded dev server of this checkout (as validate-gpu-mesh).
let server=null,url=option('url',null);
if(!url){
  const root=fileURLToPath(new URL('..',import.meta.url));
  const {default:base}=await import('../vite.config.mjs');
  const deny=base.server.fs.deny.filter(pattern=>!(pattern.includes('.work')&&root.includes('/.work/'))
    &&!(pattern.includes('.claude/worktrees')&&root.includes('/.claude/worktrees/')));
  server=await createServer({...base,configFile:false,root,logLevel:'error',
    server:{...base.server,port:0,strictPort:false,fs:{...base.server.fs,deny},watch:null}});
  await server.listen();
  url=server.resolvedUrls.local[0].replace(/\/$/,'');
}
const browser=engine==='firefox'?await firefox.launch():
  await chromium.launch({args:[`--use-angle=${process.platform==='darwin'?'metal':'gl'}`]});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Test-only hooks: the atlas and renderer as the frame flushes them.
  await page.route(/\/src\/viewer\/world\.mjs(?:\?|$)/,async route=>{
    const response=await route.fetch(),body=await response.text(),from='flushLighting(renderer) { lightAtlas.flush(renderer); },';
    if(!body.includes(from))throw new Error('world.mjs flushLighting changed');
    await route.fulfill({response,body:body.replace(from,
      'flushLighting(renderer) { lightAtlas.flush(renderer); globalThis.__atlasProbe?.(lightAtlas, renderer); },')});
  });
  await page.goto(debugUrl(url));
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,{}, {timeout:180000});

  // 1. Sampling equivalence on this GPU.
  const sampling=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
    const gl=canvas.getContext('webgl2');const size=256,layers=3,target=1;
    let seed=0x2545f491;const rand=()=>((seed=Math.imul(seed^(seed>>>15),0x2c1b3c6d)+0x6d2b79f5|0)>>>0);
    const texels=new Uint8Array(size*size*4*layers);for(let i=0;i<texels.length;i++)texels[i]=rand()&255;
    const make=(type,data,depth)=>{const t=gl.createTexture();gl.bindTexture(type,t);
      if(depth)gl.texImage3D(type,0,gl.RGBA8,size,size,depth,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
      else gl.texImage2D(type,0,gl.RGBA8,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
      gl.texParameteri(type,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(type,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(type,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(type,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;};
    const flat=make(gl.TEXTURE_2D,texels.subarray(size*size*4*target,size*size*4*(target+1)));
    const array=make(gl.TEXTURE_2D_ARRAY,texels,layers);
    const vs=`#version 300 es
in vec2 p;out vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0,1);}`;
    const fs=sampler=>`#version 300 es
precision highp float;in vec2 uv;out vec4 o;uniform highp ${sampler} t;uniform float layer;
void main(){vec2 jitter=fract(sin(gl_FragCoord.xy*vec2(12.9898,78.233))*43758.5453);
vec2 lm=clamp(uv*1.3-.15+jitter/512.,vec2(.002),vec2(.998));
o=vec4(${sampler==='sampler2D'?'texture(t,lm)':'texture(t,vec3(lm,layer))'}.rgb*2.0*.5,1);}`;
    const program=sampler=>{const p=gl.createProgram();for(const [type,src] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs(sampler)]]){
      const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));gl.attachShader(p,s);}
      gl.bindAttribLocation(p,0,'p');gl.linkProgram(p);return p;};
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    const draw=(sampler,type,texture)=>{const p=program(sampler);gl.useProgram(p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(type,texture);
      gl.uniform1i(gl.getUniformLocation(p,'t'),0);gl.uniform1f(gl.getUniformLocation(p,'layer'),target);
      gl.viewport(0,0,512,512);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);const out=new Uint8Array(512*512*4);
      gl.readPixels(0,0,512,512,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
    const a=draw('sampler2D',gl.TEXTURE_2D,flat),b=draw('sampler2DArray',gl.TEXTURE_2D_ARRAY,array);
    let differing=0,distinct=new Set();for(let i=0;i<a.length;i++){if(a[i]!==b[i])differing++;if(i%4===0)distinct.add(a[i]);}
    return {pixels:512*512,differing,distinct:distinct.size,error:gl.getError()};
  });
  assert.equal(sampling.error,0,'sampling test GL error');
  assert.ok(sampling.distinct>200,'sampling test exercises varied texels');
  assert.equal(sampling.differing,0,'2D-array layer sampling differs from 2D sampling');

  // 2. Play: GPU array layers equal the CPU pages after the per-rectangle path.
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map=>{const s=window.deusExViewer?.status();return s?.ready&&s.map===map;},map,{timeout:180000});
  await page.waitForFunction(()=>window.deusExViewer?.status()?.gameplay?.hud?.health?.head?.displayedHealth===100,{}, {timeout:180000});
  await page.locator('#scene').click({position:{x:600,y:350}});
  const play=await page.evaluate(async()=>{
    let flushes=0;
    const result=await new Promise(resolve=>{
      globalThis.__fullUploads=0;
      globalThis.__atlasProbe=(atlas,renderer)=>{
        flushes++;
        const t=atlas.arrayUniform.value;if(t&&renderer.properties.get(t).__version!==t.version)globalThis.__fullUploads++;
        if(flushes<240)return;
        globalThis.__atlasProbe=null;
        const gl=renderer.getContext(),texture=atlas.arrayUniform.value;
        const before=gl.getError();
        // A full upload still owed (dirtyPage) happens when the array is next
        // bound for a draw, before any sampling; perform it now to compare.
        const pending=renderer.properties.get(texture).__version!==texture.version;
        if(pending)renderer.initTexture(texture);
        const webgl=renderer.properties.get(texture).__webglTexture,fb=gl.createFramebuffer();
        const previous=gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
        const out=new Uint8Array(atlas.size*atlas.size*4);let differing=0;
        for(const p of atlas.pages){
          gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,webgl,0,p.index);
          gl.readPixels(0,0,atlas.size,atlas.size,gl.RGBA,gl.UNSIGNED_BYTE,out);
          let layer=0;for(let i=0;i<out.length;i++)if(out[i]!==p.pixels[i]){differing++;layer++;
            if((globalThis.__diffs??=[]).length<12)globalThis.__diffs.push([p.index,(i>>2)%atlas.size,Math.floor((i>>2)/atlas.size),i&3,out[i],p.pixels[i]]);}
          (globalThis.__layers??=[]).push(layer);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER,previous);gl.deleteFramebuffer(fb);
        resolve({pages:atlas.pages.length,sealed:Boolean(texture),arrayUploaded:atlas.arrayUploaded,
          pageUploads:atlas.pages.filter(p=>p.uploaded).length,differing,before,pending,fullUploads:globalThis.__fullUploads,layers:globalThis.__layers,diffs:globalThis.__diffs,error:gl.getError()});
      };
      setTimeout(()=>resolve({timeout:true}),60000);
    });
    return result;
  });
  if(process.argv.includes('--debug'))console.log(JSON.stringify(play));
  assert.ok(!play.timeout,'Play did not reach 240 flushes');
  assert.ok(play.sealed&&play.arrayUploaded,'light-map array sealed and uploaded');
  assert.equal(play.error,0,'GL error after the per-rectangle uploads');
  assert.equal(play.pageUploads,0,'a page texture was uploaded although every surface samples the array');
  assert.equal(play.differing,0,'GPU light-map layers differ from the CPU pages');
  // Light-map changes resend their tiles; a whole-array upload is a regression
  // (it was 183 of 240 frames on Training before October 2).
  assert.ok(play.fullUploads<=2,`${play.fullUploads} whole-array light-map uploads in 240 frames`);
  const status=await page.evaluate(()=>window.deusExViewer.status());
  assert.equal(status.runtimeError??null,null,'Play paused');
  assert.deepEqual(errors,[]);
  console.log(`Light-map atlas (${engine}): 2D-array layer sampling equals 2D sampling on ${sampling.pixels} pixels (${sampling.distinct} distinct values); `+
    `on ${map} after 240 flushes, ${play.pages} GPU array layers equal the CPU pages, no page texture was uploaded and ${play.fullUploads} whole-array uploads were owed.`);
}finally{await browser.close();await server?.close();}
