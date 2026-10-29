import { Reader, PackageError } from './package.mjs';
import { objectAt, nameAt } from './objects.mjs';

/** Exact native nodes whose result goes only to statement scratch storage.
 * Context forwards that storage through its value child, never its receiver.
 * See docs/script-sound.md; do not descend into operands or arguments. */
export function discardedNativeCalls(decoded) {
  const calls = new Set();
  for (const {node} of decoded.statements.values()) {
    let value = node;
    while (value.op === 0x19 || value.op === 0x12) value = value.value;
    if (value.op === 'native') calls.add(value);
  }
  return calls;
}

/** Original SerializeExpr layout; offsets refer to expanded native script. */
export function decodeScript(script) {
  const { pkg, bytes, size } = script;
  if (pkg.version !== undefined && ![68,69].includes(pkg.version)) throw new Error(`Unsupported executable script version ${pkg.version}`);
  if (!Number.isInteger(size) || size < 0 || size > 16_000_000) throw new Error('Invalid expanded script size');
  const r = new Reader(bytes), statements = new Map(), expressions = new Map();
  let pc = 0;
  const byte = () => { pc++; return r.u8(); };
  const word = () => { pc+=2; return r.u16(); };
  const dword = () => { pc+=4; return r.u32(); };
  const int = () => { pc+=4; return r.i32(); };
  const float = () => { pc+=4; return r.f32(); };
  const objectRef = () => { const index=r.compact(); pc+=4; return {index,field:objectAt(pkg,index)}; };
  const nameRef = () => { const nameIndex=r.compact(); pc+=4; return {nameIndex,name:nameAt(pkg,nameIndex)}; };
  // Every node is one literal with all its keys, in the order they were always added (`op`, `offset`, the opcode's own, `token`, `end`):
  // keys added after the literal were an out-of-line property array on each of the Island's 100,000 held nodes, and `end` is set once the
  // node is complete (docs/live-heap.md "Load records and functions").
  function expression(depth=0) {
    if (depth>128 || pc>=size) throw new PackageError('Invalid script expression nesting or size',r.offset);
    // (the byte offset in the package is kept for the error message only: as fields of every node, it and the end were two boxed
    // numbers each, 750,000 objects in the worker's heap on the Island, and nothing read them; docs/live-heap.md)
    const offset=pc,serializedOffset=r.offset,op=byte();
    let n;
    const child=()=>expression(depth+1);
    const args=()=>{const result=[];for(;;){const arg=child();if(arg.op===0x16)return result;result.push(arg);}};
    if(op>=0x60){const index=op<0x70?((op-0x60)<<8)+byte():op;n={op:'native',offset,index,args:args(),token:op,end:0};}
    else if(op>=0x39&&op<0x60)n={op,offset,value:child(),token:op,end:0};
    else switch(op){
      case 0x00: case 0x01: case 0x02: case 0x29: {
        const ref=objectRef();if(!ref.field)throw new Error('Null script field');
        n={op,offset,fieldIndex:ref.index,name:ref.field.name,token:op,end:0};break;
      }
      case 0x04: case 0x0d: case 0x0e: case 0x2d:n={op,offset,value:child(),token:op,end:0};break;
      case 0x05:{const valueSize=byte();n={op,offset,valueSize,value:child(),token:op,end:0};break;}
      case 0x06:n={op,offset,target:word(),token:op,end:0};break;
      case 0x07: case 0x09: case 0x18:{const target=word();n={op,offset,target,value:child(),token:op,end:0};break;}
      case 0x0a:{
        const target=word();
        n=target!==0xffff?{op,offset,target,value:child(),token:op,end:0}:{op,offset,target,token:op,end:0};break;
      }
      case 0x0c:{
        if(pc%4)throw new Error('Unaligned original label table');
        const labels=[];
        for(;;){const label={...nameRef(),target:dword()};labels.push(label);if(label.name.toLowerCase()==='none')break;}
        n={op,offset,labels,token:op,end:0};break;
      }
      case 0x0f: case 0x10: case 0x14: case 0x1a:{const left=child();n={op,offset,left,right:child(),token:op,end:0};break;}
      case 0x11:{const a=child(),b=child(),c=child(),d=child();n={op,offset,args:[a,b,c,d],token:op,end:0};break;}
      case 0x12: case 0x19:{
        const context=child(),skip=word(),valueSize=byte();
        n={op,offset,context,skip,valueSize,value:child(),token:op,end:0};break;
      }
      case 0x13: case 0x2e: case 0x36:{const ref=objectRef();n={op,offset,fieldIndex:ref.index,name:ref.field?.name,value:child(),token:op,end:0};break;}
      case 0x1b: case 0x38:{const ref=nameRef();n={op,offset,nameIndex:ref.nameIndex,name:ref.name,args:args(),token:op,end:0};break;}
      case 0x1c:{const functionIndex=objectRef().index;n={op,offset,functionIndex,args:args(),token:op,end:0};break;}
      case 0x1d:n={op:'literal',offset,value:int(),token:op,end:0};break;
      case 0x1e:n={op:'literal',offset,value:float(),token:op,end:0};break;
      case 0x1f:{const chars=[];for(;;){const c=byte();if(!c)break;chars.push(c);}n={op:'literal',offset,value:String.fromCharCode(...chars),token:op,end:0};break;}
      case 0x20:n={op,offset,objectIndex:objectRef().index,token:op,end:0};break;
      case 0x21:{const ref=nameRef();n={op,offset,nameIndex:ref.nameIndex,name:ref.name,token:op,end:0};break;}
      case 0x22:n={op:'literal',offset,value:[int(),int(),int()],token:op,end:0};break;
      case 0x23:n={op:'literal',offset,value:[float(),float(),float()],token:op,end:0};break;
      case 0x24: case 0x2c:n={op:'literal',offset,value:byte(),token:op,end:0};break;
      case 0x25: case 0x26:n={op:'literal',offset,value:op-0x25,token:op,end:0};break;
      case 0x27: case 0x28:n={op:'literal',offset,value:op===0x27,token:op,end:0};break;
      case 0x2a:n={op:'literal',offset,value:null,token:op,end:0};break;
      case 0x2f:{const value=child();n={op,offset,value,target:word(),token:op,end:0};break;}
      case 0x32: case 0x33:{const fieldIndex=objectRef().index;const left=child();n={op,offset,fieldIndex,left,right:child(),token:op,end:0};break;}
      case 0x08: case 0x0b: case 0x16: case 0x17: case 0x30: case 0x31:n={op,offset,token:op,end:0};break;
      default:throw new PackageError(`Unsupported executable script opcode 0x${op.toString(16)}`,serializedOffset);
    }
    if(pc>size)throw new Error('Expanded script length mismatch');
    n.end=pc;expressions.set(offset,n);return n;
  }
  while(pc<size){const offset=pc,node=expression();statements.set(offset,{node,next:pc});}
  if(pc!==size||r.offset!==bytes.length)throw new Error('Expanded script length mismatch');
  return {statements,expressions,size};
}
