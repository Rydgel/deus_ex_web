// Function names of a non-stripped wasm module, for the Gecko profiles' `wasm-function[N]` frames (N is the function index, imports first).
//
//   node scripts/wasm-names.mjs MODULE.wasm 596 665 256 ...       (the names of those indices)
//   node scripts/wasm-names.mjs MODULE.wasm --profile RUN.json     (the indices a gecko-phase.mjs --json file names, resolved)
//
// A non-stripped build: CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path native/script-vm/Cargo.toml --locked --release
// --target wasm32-unknown-unknown --target-dir .cache/wasm-names (the indices equal the stripped module's: only the name section differs).
import {readFileSync} from 'node:fs';
const [file,...rest]=process.argv.slice(2);
const bytes=readFileSync(file);let p=8;
const leb=()=>{let r=0,s=0,b;do{b=bytes[p++];r|=(b&0x7f)<<s;s+=7;}while(b&0x80);return r>>>0;};
const names=new Map();
while(p<bytes.length){
  const id=bytes[p++],size=leb(),end=p+size;
  if(id===0){
    const n=leb(),name=bytes.toString('utf8',p,p+n);p+=n;
    if(name==='name'){
      while(p<end){
        const sub=bytes[p++],ssize=leb(),send=p+ssize;
        if(sub===1){const count=leb();for(let i=0;i<count;i++){const idx=leb(),len=leb();names.set(idx,bytes.toString('utf8',p,p+len));p+=len;}}
        p=send;
      }
    }
  }
  p=end;
}
const wanted=new Set();
const profile=rest.indexOf('--profile');
if(profile>=0){
  const json=JSON.parse(readFileSync(rest[profile+1],'utf8'));
  for(const group of [json.self,json.incl])for(const key of Object.keys(group??{})){const m=/^wasm-function\[(\d+)\]/.exec(key);if(m)wanted.add(Number(m[1]));}
}else for(const a of rest)wanted.add(Number(a));
for(const i of [...wanted].sort((a,b)=>a-b))console.log(`${i}\t${names.get(i)??'(no name)'}`);
console.error(`${names.size} names in ${file}`);
