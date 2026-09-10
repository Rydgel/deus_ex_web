import { Reader, PackageError } from './package.mjs';
import { objectAt, nameAt } from './objects.mjs';

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
  function expression(depth=0) {
    if (depth>128 || pc>=size) throw new PackageError('Invalid script expression nesting or size',r.offset);
    const offset=pc,serializedOffset=r.offset,op=byte(),n={op,offset,serializedOffset};
    const child=()=>expression(depth+1);
    const args=()=>{const result=[];for(;;){const arg=child();if(arg.op===0x16)return result;result.push(arg);}};
    if(op>=0x60){n.op='native';n.index=op<0x70?((op-0x60)<<8)+byte():op;n.args=args();}
    else if(op>=0x39&&op<0x60)n.value=child();
    else switch(op){
      case 0x00: case 0x01: case 0x02: case 0x29: {
        const ref=objectRef();if(!ref.field)throw new Error('Null script field');
        n.fieldIndex=ref.index;n.name=ref.field.name;break;
      }
      case 0x04: case 0x0d: case 0x0e: case 0x2d:n.value=child();break;
      case 0x05:n.valueSize=byte();n.value=child();break;
      case 0x06:n.target=word();break;
      case 0x07: case 0x09: case 0x18:n.target=word();n.value=child();break;
      case 0x0a:n.target=word();if(n.target!==0xffff)n.value=child();break;
      case 0x0c:
        if(pc%4)throw new Error('Unaligned original label table');
        n.labels=[];
        for(;;){const label={...nameRef(),target:dword()};n.labels.push(label);if(label.name.toLowerCase()==='none')break;}
        break;
      case 0x0f: case 0x10: case 0x14: case 0x1a:n.left=child();n.right=child();break;
      case 0x11:n.args=[child(),child(),child(),child()];break;
      case 0x12: case 0x19:n.context=child();n.skip=word();n.valueSize=byte();n.value=child();break;
      case 0x13: case 0x2e: case 0x36:{const ref=objectRef();n.fieldIndex=ref.index;n.name=ref.field?.name;n.value=child();break;}
      case 0x1b: case 0x38:Object.assign(n,nameRef());n.args=args();break;
      case 0x1c:n.functionIndex=objectRef().index;n.args=args();break;
      case 0x1d:n.op='literal';n.value=int();break;
      case 0x1e:n.op='literal';n.value=float();break;
      case 0x1f:{const chars=[];for(;;){const c=byte();if(!c)break;chars.push(c);}n.op='literal';n.value=String.fromCharCode(...chars);break;}
      case 0x20:n.objectIndex=objectRef().index;break;
      case 0x21:Object.assign(n,nameRef());break;
      case 0x22:n.op='literal';n.value=[int(),int(),int()];break;
      case 0x23:n.op='literal';n.value=[float(),float(),float()];break;
      case 0x24: case 0x2c:n.op='literal';n.value=byte();break;
      case 0x25: case 0x26:n.op='literal';n.value=op-0x25;break;
      case 0x27: case 0x28:n.op='literal';n.value=op===0x27;break;
      case 0x2a:n.op='literal';n.value=null;break;
      case 0x2f:n.value=child();n.target=word();break;
      case 0x32: case 0x33:n.fieldIndex=objectRef().index;n.left=child();n.right=child();break;
      case 0x08: case 0x0b: case 0x16: case 0x17: case 0x30: case 0x31:break;
      default:throw new PackageError(`Unsupported executable script opcode 0x${op.toString(16)}`,serializedOffset);
    }
    if(pc>size)throw new Error('Expanded script length mismatch');
    n.token=op;n.end=pc;n.serializedEnd=r.offset;expressions.set(offset,n);return n;
  }
  while(pc<size){const offset=pc,node=expression();statements.set(offset,{node,next:pc});}
  if(pc!==size||r.offset!==bytes.length)throw new Error('Expanded script length mismatch');
  return {statements,expressions,size};
}
