// The difference between two `gecko-phase.mjs --json` files, by named frame (inclusive), self leaf, or import: what B spends that A does
// not, in ms a frame.
//
//   node scripts/gecko-phase-diff.mjs A.json B.json [--key incl|self|imports] [--top 30]
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2),option=(n,f)=>{const i=args.indexOf(`--${n}`);return i<0?f:args[i+1];};
const [fa,fb]=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
const a=JSON.parse(readFileSync(fa,'utf8')),b=JSON.parse(readFileSync(fb,'utf8')),key=option('key','incl'),top=Number(option('top',30));
const keys=new Set([...Object.keys(a[key]),...Object.keys(b[key])]);
const rows=[...keys].map(k=>[k,a[key][k]??0,b[key][k]??0]).map(([k,x,y])=>[k,x,y,y-x]).sort((p,q)=>q[3]-p[3]).slice(0,top);
console.log(`A ${a.ms.toFixed(2)} ms  B ${b.ms.toFixed(2)} ms  (${key})`);
for(const [k,x,y,d] of rows)console.log(`${x.toFixed(2).padStart(6)} ${y.toFixed(2).padStart(6)} ${d.toFixed(2).padStart(6)}  ${k.slice(0,140)}`);
