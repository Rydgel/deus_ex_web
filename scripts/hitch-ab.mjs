// Interleaved A/B sessions (AGENTS.md: judge a change by interleaved medians): `--pairs` rounds of one scripts/hitch-run.mjs session per
// arm, in turn (the order reversed in every second round), each arm adding its own URL switches. Each session writes <dir>/<prefix>-<arm>-<n>.json and, every 5 s, the CPU seconds
// of its process tree (<...>.cpu: "elapsed_s cpu_s"), which scripts/hitch-summary.mjs reads beside it.
//
//   node scripts/hitch-ab.mjs --arms "inline:sim=inline,worker:" --pairs 2 --prefix ff-island [--dir .cache/perf/hitch]
//     -- --browser firefox --map 01_NYC_UNATCOIsland --seconds 100 --mode roam   (the arguments after -- go to every session)
//
// Every session starts its own dev server unless the arguments name --url (a fresh server per session is what a code A/B needs: the
// in-process server keeps the modules it has transformed). Moved from .work/hitch/ab-ff.sh (2026-10-28).
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,readdirSync} from 'node:fs';

const split=process.argv.indexOf('--'),own=split<0?process.argv.slice(2):process.argv.slice(2,split),pass=split<0?[]:process.argv.slice(split+1);
const option=(n,f)=>{const i=own.indexOf(`--${n}`);return i<0?f:own[i+1];};
const arms=option('arms','a:,b:').split(',').map(arm=>{const at=arm.indexOf(':');return {name:arm.slice(0,at),query:arm.slice(at+1)};});
const pairs=Number(option('pairs',2)),prefix=option('prefix','ab'),dir=option('dir','.cache/perf/hitch');
mkdirSync(dir,{recursive:true});

/** CPU seconds (user + system) of `root` and its descendants. */
function cpuOfTree(root){
  if(process.platform==='linux'){
    const parent=new Map(),cpu=new Map(),tick=100;
    for(const d of readdirSync('/proc')){if(!/^\d+$/.test(d))continue;
      try{const fields=readFileSync(`/proc/${d}/stat`,'utf8').split(') ')[1].split(' ');parent.set(Number(d),Number(fields[1]));cpu.set(Number(d),(Number(fields[11])+Number(fields[12]))/tick);}catch{}}
    let total=0;for(const [pid,s] of cpu){let p=pid;while(p&&p!==root&&p!==1)p=parent.get(p);if(p===root)total+=s;}
    return total;
  }
  // ps's TIME is [[dd-]hh:]mm:ss[.ss] on Linux and macOS alike
  const parent=new Map(),cpu=new Map();
  for(const line of execFileSync('ps',['-A','-o','pid=,ppid=,time='],{encoding:'utf8'}).trim().split('\n')){
    const [pid,ppid,time]=line.trim().split(/\s+/);const [days,clock]=time.includes('-')?time.split('-'):[0,time];
    parent.set(Number(pid),Number(ppid));cpu.set(Number(pid),Number(days)*86400+clock.split(':').reduce((s,part)=>s*60+Number(part),0));}
  let total=0;for(const [pid,s] of cpu){let p=pid;while(p&&p!==root&&p!==1)p=parent.get(p);if(p===root)total+=s;}
  return total;
}

// The arms' order alternates from pair to pair: sessions late in a pair ran slower (about 0.4 ms of Firefox's tick on the
// Area 51 bunker, 2026-11-05, docs/firefox-60fps-plan.md "Progress"), which a fixed order folds into the difference.
for(let i=1;i<=pairs;i++)for(const arm of i%2?arms:[...arms].reverse()){
  const out=`${dir}/${prefix}-${arm.name}-${i}`,args=['scripts/hitch-run.mjs',...pass,'--out',out];
  if(arm.query){const at=args.indexOf('--query');if(at<0)args.push('--query',arm.query);else args[at+1]=`${args[at+1]}&${arm.query}`;}
  const started=Date.now(),log=[];writeFileSync(`${out}.cpu`,'');
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log.push(b));child.stderr.on('data',b=>log.push(b));
  const timer=setInterval(()=>{try{appendFileSync(`${out}.cpu`,`${((Date.now()-started)/1000).toFixed(0)} ${cpuOfTree(child.pid).toFixed(2)}\n`);}catch{}},5000);
  const code=await new Promise(resolve=>child.on('exit',resolve));clearInterval(timer);
  writeFileSync(`${out}.log`,Buffer.concat(log));
  console.log(`${arm.name} ${i} exit ${code} ${((Date.now()-started)/1000).toFixed(0)} s -> ${out}.json`);
}
