// The means of the hitch log's phase columns over a run's drawn frames from --skip seconds after the map (default 5): for reading A/B runs
// next to each other. `p.` columns are the page thread's phases, `w.` the simulation step times (in inline mode the page adds them to its
// own phases of the same name: p.hud holds the simulation's HUD paint, w.hud, plus the page's drawing of the commands).
//
//   node scripts/hitch-phase-means.mjs RUN.json... [--skip 5] [--cols p.tick,p.hud,w.hud,...]
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2),option=(n,f)=>{const i=args.indexOf(`--${n}`);return i<0?f:args[i+1];};
const files=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
const skip=Number(option('skip',5))*1000,cols=option('cols','p.tick,p.hud,w.hud,p.actors,p.render,p.audio,p.fog,p.lighting').split(',');
for(const f of files){
  const d=JSON.parse(readFileSync(f)).dump,ci=Object.fromEntries(d.columns.map((c,i)=>[c,i]));
  const mapAt=d.events.filter(e=>e.kind==='map').at(-1)?.t??0;
  const rows=d.rows.filter(x=>x[ci.drawn]&&x[ci.t]>=mapAt+skip);
  const mean=k=>rows.reduce((s,x)=>s+x[ci[k]],0)/rows.length;
  console.log(`${f.split('/').pop()} ${rows.length} drawn: ${cols.map(k=>`${k} ${mean(k).toFixed(2)}`).join(' | ')}`);
}
