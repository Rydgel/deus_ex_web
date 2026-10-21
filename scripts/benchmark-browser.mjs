/** Rendered Play timing. Run against npm run dev; hardware backend is reported. */
import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import { debugUrl } from './page-url.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const url=new URL(arg('--url')??'http://127.0.0.1:5173');
if(process.argv.includes('--javascript'))url.searchParams.set('meshBackend','javascript');
const browser=await chromium.launch({args:process.argv.includes('--metal')?['--use-angle=metal']:[]});
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(debugUrl(url.href));
  await page.waitForFunction(()=>window.deusExViewer?.status().ready,null,{timeout:120000});
  await page.locator('#scene').click({position:{x:500,y:350}});
  await page.evaluate(async()=>{for(let i=0;i<60;i++)await new Promise(requestAnimationFrame);});
  const profilePath=arg('--profile'),cdp=profilePath?await page.context().newCDPSession(page):null;
  if(cdp){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  const result=await page.evaluate(async()=>{
    const samples=[];let last=await new Promise(requestAnimationFrame);
    for(let i=0;i<300;i++){
      const now=await new Promise(requestAnimationFrame);samples.push(now-last);last=now;
    }
    const sorted=samples.toSorted((a,b)=>a-b),state=window.deusExViewer.status();
    const gl=document.getElementById('scene').getContext('webgl2'),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {frames:samples.length,viewport:[innerWidth,innerHeight],devicePixelRatio,
      gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      milliseconds:{mean:samples.reduce((a,b)=>a+b,0)/samples.length,median:sorted[150],p95:sorted[285]},
      state:{map:state.map,ready:state.ready,mode:state.mode,paused:state.paused,runtimeError:state.runtimeError,
        poseBackend:state.npcPreview?.poseBackend,kernelError:state.npcPreview?.kernelError,
        meshes:state.npcPreview?.actors.length,frame:state.frame,calls:state.calls}};
  });
  if(cdp){const {profile}=await cdp.send('Profiler.stop');await writeFile(profilePath,JSON.stringify(profile));}
  console.log(JSON.stringify({...result,profiled:Boolean(cdp),pageErrors:errors},null,2));
  const expected=url.searchParams.get('meshBackend')==='javascript'?'javascript':'rust-wasm';
  if(errors.length||result.state.runtimeError||result.state.paused||result.state.mode!=='play'||result.state.poseBackend!==expected)
    throw new Error('Benchmark did not remain in Play with the requested backend');
} finally {await browser.close();}
