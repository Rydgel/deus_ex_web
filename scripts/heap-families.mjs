/**
 * A V8 heap snapshot's live objects grouped by owner (docs/live-heap.md), for scripts/profile-live-heap.mjs's snapshots.
 *
 * Each object goes to the family named by the first DEPTH named edges (object properties and closure-context variables) on its
 * shortest path from the GC roots. Reaching an object of a named class with at most 8 instances (ScriptProcess, ScriptRuntime,
 * ScriptClassLoader, AssetStore, CollisionWorld...) starts that class's own family whatever the path, so one owner reached through
 * several aliases (host.scriptProcess, runtime.process) is one family. A family is a first-reach attribution: an object shared by
 * two owners counts once, under whichever the breadth-first walk met first. Per family: objects (what a major GC marks), their
 * outgoing edges, their JS heap bytes, the boxed heap numbers and strings among them, and the native backing stores they reach
 * (ArrayBuffer and external string data, not traced element by element). The snapshot's own string for a heap number's value
 * is not counted.
 *
 *   node scripts/heap-families.mjs <file.heapsnapshot> [depth=2] [top=40]
 *     [--heads] (each family's first object)
 *     [--inside KEY,KEY...] (the object kinds of those families and the edges between their objects)
 *     [--sample KEY] (the path from a family's first object to a few of its members)
 */
import {openSync,readSync,fstatSync} from 'node:fs';
const args=process.argv.slice(2).filter((a,i,all)=>!a.startsWith('--')&&!['--inside','--sample'].includes(all[i-1]));
const file=args[0],depth=Number(args[1]??2),top=Number(args[2]??40);
if(!file){console.error('usage: node scripts/heap-families.mjs <file.heapsnapshot> [depth] [top] [--heads] [--inside KEY,...] [--sample KEY]');process.exit(2);}
const fd=openSync(file,'r'),size=fstatSync(fd).size,buf=Buffer.allocUnsafe(size);
for(let at=0;at<size;){const n=readSync(fd,buf,at,Math.min(1<<28,size-at),at);if(!n)break;at+=n;}
const nodesAt=buf.indexOf('"nodes":[');
const header=JSON.parse(buf.toString('utf8',0,nodesAt).replace(/,\s*$/,'')+'}').snapshot;
const nf=header.meta.node_fields.length,ef=header.meta.edge_fields.length,N=header.node_count,M=header.edge_count;
const nodeTypes=header.meta.node_types[0],edgeTypes=header.meta.edge_types[0];
function ints(from,count,out){let o=0,cur=0,have=false,i=from;
  for(;o<count;i++){const b=buf[i];if(b>=48&&b<=57){cur=cur*10+(b-48);have=true;}else if(have){out[o++]=cur;cur=0;have=false;}}
  return i;}
const nodes=new Int32Array(N*nf),edges=new Int32Array(M*ef);
let p=ints(nodesAt+9,N*nf,nodes);
p=ints(buf.indexOf('"edges":[',p)+9,M*ef,edges);
const stringsAt=buf.indexOf('"strings":[',p)+11,sOff=[];
{let inStr=false,esc=false,start=0;for(let i=stringsAt;i<buf.length;i++){const b=buf[i];
  if(inStr){if(esc)esc=false;else if(b===92)esc=true;else if(b===34){inStr=false;sOff.push(start,i);}}
  else if(b===34){inStr=true;start=i;}else if(b===93)break;}}
const strOf=k=>{const s=sOff[2*k],e=sOff[2*k+1];try{return JSON.parse(buf.toString('utf8',s,e+1));}catch{return buf.toString('utf8',s+1,e);}};
const T=Object.fromEntries(nodeTypes.map((t,i)=>[t,i])),E=Object.fromEntries(edgeTypes.map((t,i)=>[t,i]));
const first=new Int32Array(N+1);{let acc=0;for(let n=0;n<N;n++){first[n]=acc;acc+=nodes[n*nf+4];}first[N]=acc;}
// Anchors: objects of a named class with at most 8 instances (ScriptProcess, ScriptRuntime, AssetStore...). Reaching one starts
// its own family (its class name), whatever the path, so aliases of one owner (host.scriptProcess, runtime.process) are one family.
const BUILTIN=/^(Object|Array|Map|Set|WeakMap|WeakSet|WeakRef|Promise|Function|Error|RegExp|Date|ArrayBuffer|SharedArrayBuffer|DataView|(Big)?(Ui|I)nt\d+(Clamped)?Array|Float\d+Array|BigInt64Array|BigUint64Array|Window|Worker\w*|DedicatedWorkerGlobalScope|Module|Symbol|Proxy|Iterator|Generator|.*Event.*|.*Port.*)$/;
const ctorCount=new Map();
for(let n=0;n<N;n++)if(nodes[n*nf]===T.object){const k=nodes[n*nf+1];ctorCount.set(k,(ctorCount.get(k)??0)+1);}
const anchorName=new Map();
for(const [k,c] of ctorCount)if(c<=8){const name=strOf(k);if(/^[A-Z][A-Za-z0-9_]+$/.test(name)&&!BUILTIN.test(name))anchorName.set(k,name);}
// BFS over strong edges; a node's family extends its parent's while the parent's key is shorter than DEPTH and the edge is named
const fam=new Int32Array(N).fill(-1),named=new Uint8Array(N),order=new Int32Array(N),parentEdge=new Int32Array(N).fill(-1),parent=new Int32Array(N).fill(-1);let qh=0,qt=0;
const keys=['(roots)'],keyIndex=new Map([['(roots)',0]]),extend=new Map(),head=[0];
let reaching=-1;const keyOf=key=>{let g=keyIndex.get(key);if(g===undefined){g=keys.length;keys.push(key);keyIndex.set(key,g);head[g]=reaching;}return g;};
fam[0]=0;order[qt++]=0;
while(qh<qt){const n=order[qh++];
  for(let e=first[n];e<first[n+1];e++){const t=edges[e*ef];if(t===E.weak||t===E.shortcut)continue;
    const to=edges[e*ef+2]/nf;if(fam[to]!==-1)continue;
    let f=fam[n],d=named[n];
    const anchor=nodes[to*nf]===T.object?anchorName.get(nodes[to*nf+1]):undefined;
    reaching=to;parent[to]=n;parentEdge[to]=e;
    if(anchor!==undefined){fam[to]=keyOf(anchor);named[to]=0;order[qt++]=to;continue;}
    if(d<depth&&(t===E.property||t===E.context)){const name=strOf(edges[e*ef+1]);const ek=f*4194304+edges[e*ef+1];
      let g=extend.get(ek);if(g===undefined){g=keyOf(f===0?name:`${keys[f]}.${name}`);extend.set(ek,g);}
      f=g;d++;}
    fam[to]=f;named[to]=d;order[qt++]=to;}}
const F=keys.length,objs=new Float64Array(F),bytes=new Float64Array(F),native=new Float64Array(F),outE=new Float64Array(F),nums=new Float64Array(F),strs=new Float64Array(F);
let totalObjs=0,totalBytes=0,totalEdges=0;
let synthetic=0;
for(let n=0;n<N;n++){const f=fam[n];if(f<0)continue;const t=nodes[n*nf],s=nodes[n*nf+3];
  // the snapshot's own string for a heap number's value is not a heap object
  if(t===T.string&&parent[n]>=0&&nodes[parent[n]*nf]===T.number){synthetic++;continue;}
  if(t===T.native&&/ArrayBufferData|ExternalStringData/.test(strOf(nodes[n*nf+1]))){native[f]+=s;continue;}
  objs[f]++;bytes[f]+=s;outE[f]+=nodes[n*nf+4];totalObjs++;totalBytes+=s;totalEdges+=nodes[n*nf+4];
  if(t===T.number)nums[f]++;else if(t===T.string||t===T['concatenated string']||t===T['sliced string'])strs[f]++;}
console.log(`${file.split('/').pop()}: ${(totalObjs/1e6).toFixed(2)} M objects (${(synthetic/1e6).toFixed(2)} M number-value strings left out), ${(totalEdges/1e6).toFixed(1)} M edges, ${(totalBytes/1048576).toFixed(0)} MB JS heap; families at depth ${depth}: ${F}`);
const rows=[...Array(F).keys()].sort((a,b)=>objs[b]-objs[a]).slice(0,top);
console.log('   objects    edges    MB   numbers  strings  native MB  family');
const heads=process.argv.includes('--heads');
for(const f of rows){const h=head[f];if(heads&&h>=0){const t=nodes[h*nf];console.log(`           head: ${nodeTypes[t]} ${String(strOf(nodes[h*nf+1])).slice(0,50)} self ${nodes[h*nf+3]} edges ${nodes[h*nf+4]}`);}console.log(`${(objs[f]/1e3).toFixed(0).padStart(9)}k ${(outE[f]/1e6).toFixed(2).padStart(7)}M ${(bytes[f]/1048576).toFixed(1).padStart(6)} ${(nums[f]/1e3).toFixed(0).padStart(8)}k ${(strs[f]/1e3).toFixed(0).padStart(7)}k ${(native[f]/1048576).toFixed(1).padStart(9)}  ${keys[f].slice(0,140)}`);}
// --inside KEY[,KEY...]: the (type, name) of the objects in each family KEY, and the edges between the family's objects. Heap
// numbers' value strings (the snapshot's own) are left out.
const ii=process.argv.indexOf('--inside');
if(ii>0)for(const key of process.argv[ii+1].split(',')){const f=keyIndex.get(key);if(f===undefined){console.log('no family',key);continue;}const by=new Map(),via=new Map();
  for(let n=0;n<N;n++)if(fam[n]===f){const t=nodeTypes[nodes[n*nf]];if(t==='string'&&parent[n]>=0&&nodeTypes[nodes[parent[n]*nf]]==='number')continue;
    const k=`${t} ${String(strOf(nodes[n*nf+1])).slice(0,50)}`;by.set(k,(by.get(k)??0)+1);
    for(let e=first[n];e<first[n+1];e++){const to=edges[e*ef+2]/nf;if(fam[to]!==f)continue;const et=edgeTypes[edges[e*ef]];if(t==='number')continue;
      const name=et==='element'||et==='hidden'?`${et}`:`${et}:${strOf(edges[e*ef+1])}`;const k2=`${t} -${name}-> ${nodeTypes[nodes[to*nf]]}`;via.set(k2,(via.get(k2)??0)+1);}}
  console.log(`== ${key}: ${[...by.values()].reduce((a,b)=>a+b,0)} objects`);for(const [k,c] of [...by].sort((a,b)=>b[1]-a[1]).slice(0,6))console.log(`  ${String(c).padStart(9)} ${k}`);
  console.log('  edges:');for(const [k,c] of [...via].sort((a,b)=>b[1]-a[1]).slice(0,9))console.log(`  ${String(c).padStart(9)} ${k}`);}
// --sample KEY: the path from the family's head to a few of its objects, step by step.
const si=process.argv.indexOf('--sample');
if(si>0){const f=keyIndex.get(process.argv[si+1]),members=[];for(let n=0;n<N;n++)if(fam[n]===f)members.push(n);
  const edgeLabel=e=>{const t=edgeTypes[edges[e*ef]];return t==='element'||t==='hidden'?`[${edges[e*ef+1]}]`:`${t}:${strOf(edges[e*ef+1])}`;};
  for(const n of [members[1000],members[Math.floor(members.length/2)],members.at(-5)]){if(n===undefined)continue;const steps=[];
    for(let c=n;c!==head[f]&&c>0&&steps.length<40;c=parent[c])steps.push(`${edgeLabel(parentEdge[c])} -> ${nodeTypes[nodes[c*nf]]} ${String(strOf(nodes[c*nf+1])).slice(0,40)}`);
    console.log('sample (head first):');for(const s of steps.reverse())console.log('   ',s);}}
