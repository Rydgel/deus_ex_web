import { decodeScript } from '../unreal/bytecode.mjs';
import { moverPrimitiveIndices, executeMoverPrimitive } from './script-mover-primitives.mjs';
import { decorationPrimitiveIndices, decorationOutPrimitiveIndices, executeDecorationPrimitive, vectorToRotator } from './script-decoration-primitives.mjs';
import { scriptStringEqual, scriptStringComplementEqual, scriptConcat, scriptAt, scriptLen, scriptInStr, scriptMid, scriptLeft, scriptRight, scriptCaps, scriptChr, scriptNameToString } from './script-string-operations.mjs';

const f = Math.fround;
const primitiveNatives=new Set([112,114,119,122,123,124,125,126,127,128,129,144,145,146,147,150,151,154,155,165,168,169,171,172,174,175,176,177,179,180,181,182,184,185,187,210,212,213,215,216,223,234,235,236,242,243,244,245,250,251,254,255,316]);
for(const index of moverPrimitiveIndices)primitiveNatives.add(index);
for(const index of decorationPrimitiveIndices)primitiveNatives.add(index);
export const primitiveNativeIndices=Object.freeze([...primitiveNatives,130,132].sort((a,b)=>a-b));
const primitiveOutNatives=new Set([165,166,182,184,185,223,...decorationOutPrimitiveIndices]);
export const refValue = v => v?.reference ? v.get() : v;
export const reference = (object, key) => ({ reference: true, get: () => object[key], set: value => (object[key] = value) });
export const assign = (ref, value) => { if (!ref?.reference) throw new Error('Script assignment requires a variable'); return ref.set(value); };

/** Original bytecode execution with linked engine services.
 * Unsupported instructions/native indices fail, rather than being approximated. */
export function compileFunction(fn) {
  const decoded = decodeScript(fn), { statements } = decoded;
  for (const { node } of statements.values()) if ([0x06, 0x07].includes(node.op) && !statements.has(node.target)) throw new Error('Script jump is not an instruction boundary');
  for(const {node} of statements.values())if(node.op===0x2f&&statements.get(node.target)?.node.op!==0x30){
    throw new Error('Iterator target is not an IteratorPop instruction');
  }

  function native(index, args, receiver, services, frame) {
    if(moverPrimitiveIndices.has(index))return executeMoverPrimitive(index,args);
    if(decorationPrimitiveIndices.has(index))return executeDecorationPrimitive(index,args);
    const values = args.map(refValue), [a, b] = values;
    // Core.Object native declarations and original Engine.u CheckBob bytecode.
    switch (index) {
      case 112: return scriptConcat(a,b);
      case 168: return scriptAt(a,b);
      case 114: return a === b;
      case 119: return a !== b;
      case 122: return scriptStringEqual(a,b);
      case 123: return !scriptStringEqual(a,b);
      case 124: return scriptStringComplementEqual(a,b);
      case 125: return scriptLen(a);
      case 126: return scriptInStr(a,b);
      case 127: return scriptMid(a,b,values.length>2?values[2]:undefined);
      case 128: return scriptLeft(a,b);
      case 234: return scriptRight(a,b);
      case 129: return !a;
      case 146: return ((a | 0) + (b | 0)) | 0;
      case 147: return ((a | 0) - (b | 0)) | 0;
      // Core's Multiply_IntInt (144) evaluates both int32 operands into
      // temporaries, multiplies with the original signed 32-bit IMUL, and
      // stores the low DWORD in ReturnValue.
      case 144: return Math.imul(a | 0, b | 0);
      // Core's Divide_IntInt (145) evaluates signed dwords and uses the
      // original zero-divisor guard before x86 IDIV.  The one overflowing
      // signed pair (INT_MIN / -1) reaches the processor divide exception;
      // keep that reached exceptional path explicit instead of returning a
      // JavaScript Infinity or a guessed wrapped quotient.
      case 145: {
        const dividend=a|0, divisor=b|0;
        if(divisor===0)return 0;
        if(dividend===-0x80000000&&divisor===-1)
          throw new Error('Original Divide_IntInt signed overflow (x86 divide exception) is unsupported');
        return (Math.trunc(dividend/divisor))|0;
      }
      case 150: return (a | 0) < (b | 0);
      case 151: return (a | 0) > (b | 0);
      case 154: return (a | 0) === (b | 0);
      case 155: return (a | 0) !== (b | 0);
      case 165: if(args[0]?.reference)assign(args[0], ((a | 0) + 1) | 0); return a | 0;
      case 171: return f(a * b);
      case 172: return f(a / b);
      case 174: return f(a + b);
      case 175: return f(a - b);
      // Core's preoperator float - loads the operand as a float32 and uses
      // x87 FCHS before storing the float32 ReturnValue.
      case 169: return f(-f(a));
      case 176: return a < b;
      case 177: return a > b;
      case 179: return a >= b;
      // Core's fcomps handlers compare the float32 expression results. The
      // original tests C3 only: unordered (either operand NaN) is treated as
      // equal by native 180 and as not-not-equal by native 181.
      case 180: {
        const x=f(a), y=f(b);
        return Number.isNaN(x)||Number.isNaN(y)||x===y;
      }
      // Core's ComplementEqual_FloatFloat (210) evaluates both operands into
      // float32 temporaries, subtracts them in x87 precision, and tests the
      // absolute difference against the embedded double 0.0001.  The native
      // fcom path treats unordered (NaN) as below the threshold, so NaN is
      // deliberately accepted here just as it is by the original C0 test.
      case 210: {
        const x=f(a), y=f(b), difference=x-y;
        return Number.isNaN(difference)||Math.abs(difference)<0.0001;
      }
      case 181: {
        const x=f(a), y=f(b);
        return !(Number.isNaN(x)||Number.isNaN(y)||x===y);
      }
      case 182: return assign(args[0], f(a * b));
      case 184: return assign(args[0], f(a + b));
      // These three operators are used by DeusExPlayer.ClientFlash and the
      // preceding TakeDamage/DXReduceDamage path.  Core evaluates operands
      // left-to-right, loads each serialized float as float32, and stores
      // every result component as float32.  The first operand of 185/223 is
      // an out-lvalue and is therefore retained by primitiveOutNatives.
      case 185: return assign(args[0], f(f(a) - f(b)));
      case 187: return f(Math.sin(a));
      case 212: return a.map(v => f(f(v) * f(b)));
      case 213: return b.map(v => f(f(a) * f(v)));
      case 215: return a.map((v,i) => f(v + b[i]));
      case 216: return a.map((v,i) => f(v - b[i]));
      case 223: return assign(args[0], a.map((v,i) => f(f(v) + f(b[i]))));
      case 235: return scriptCaps(a);
      case 236: return scriptChr(a);
      // EqualEqual_BoolBool (242) / NotEqual_BoolBool (243): pure Core operators.
      case 242: return Boolean(a) === Boolean(b);
      case 243: return Boolean(a) !== Boolean(b);
      case 244: return a > b ? b : a;
      case 245: return a >= b ? a : b;
      case 250: return Math.max(a | 0, b | 0);
      case 251: return (a | 0) < (b | 0) ? b | 0 : (a | 0) < (values[2] | 0) ? a | 0 : values[2] | 0;
      // Loaded FNames are represented by canonical case-insensitive spelling,
      // independently of each package's serialized name-table index.
      case 254: return String(a||'None').toLowerCase()===String(b||'None').toLowerCase();
      case 255: return String(a||'None').toLowerCase()!==String(b||'None').toLowerCase();
      case 316: return a.map((v,i) => ((v | 0) + (b[i] | 0)) | 0);
      default:
        if (services.native) return services.native({index,args,receiver,script:fn,frame});
        throw new Error(`VM does not support native ${index}`);
    }
  }
  const compiled = {
    name: fn.entry.path, size: fn.size, decoded,
    createFrame(instance, locals = {}, services = {}, { offset = 0, state = false } = {}) {
      const frame = { instance, locals, script: fn, cursor: offset, latent: 0, state, returned: false, result: undefined, iterators:[] };
      const call = (node, receiver) => {
        const target={kind:node.op===0x1c?'final':node.op===0x38?'global':'virtual',
          receiver,name:node.name,index:node.functionIndex,script:fn,node,frame};
        // CallFunction copies each evaluated argument before evaluating the next.
        // The linked runtime must retain control of that evaluation order.
        if(services.invoke)return services.invoke({...target,argumentCount:node.args.length,
          evaluateArgument:index=>evaluate(node.args[index],instance)});
        if (!services.call) throw new Error(`Script call is not linked: ${node.name ?? node.functionIndex}`);
        // Context changes receiver; arguments retain the caller FFrame.Object.
        const args = node.args.map(arg => evaluate(arg, instance));
        return services.call({...target,args});
      };
      const evaluate = (n, receiver = instance) => {
        switch (n.op) {
          case 'literal': return Array.isArray(n.value) ? n.value.slice() : n.value;
          case 'native': {
            if (n.index===130 || n.index===132) {
              const first=Boolean(refValue(evaluate(n.args[0],instance))),second=n.args[1];
              if(second?.op!==0x18)throw new Error('Original short-circuit call requires Skip');
              return n.index===130 ? first&&Boolean(refValue(evaluate(second.value,instance)))
                : first||Boolean(refValue(evaluate(second.value,instance)));
            }
            if(!primitiveNatives.has(n.index)&&services.invokeNative)return services.invokeNative({index:n.index,receiver,script:fn,frame,
              argumentCount:n.args.length,evaluateArgument:index=>evaluate(n.args[index],instance)});
            const args=n.args.map((arg,index)=>{
              const result=evaluate(arg,instance);
              if(!primitiveNatives.has(n.index)||index===0&&primitiveOutNatives.has(n.index))return result;
              const value=refValue(result);return Array.isArray(value)?value.slice():value;
            });
            return native(n.index,args,receiver,services,frame);
          }
          case 0x00: return services.localReference?.(locals,fn,n) ?? reference(locals, n.name);
          case 0x01: return services.fieldReference?.(receiver,fn,n) ?? reference(receiver,n.name);
          case 0x02:
            if(!services.defaultReference)throw new Error('Default property is not linked');
            return services.defaultReference(receiver,fn,n);
          case 0x0f: return assign(evaluate(n.left), refValue(evaluate(n.right)));
          case 0x14: return assign(evaluate(n.left),Boolean(refValue(evaluate(n.right))));
          case 0x17: return instance;
          case 0x19: {
            const context=refValue(evaluate(n.context,receiver));
            if(context!==null && context!==undefined)return evaluate(n.value,context);
            services.warning?.({type:'Accessed None',script:fn.entry.path,offset:n.offset});
            if(!n.valueSize)return undefined;
            if(!services.zeroContextResult)throw new Error('Null context requires linked result type');
            return services.zeroContextResult(fn,n.value,n.valueSize);
          }
          case 0x1b: case 0x1c: case 0x38:return call(n,receiver);
          case 0x1a:
            if(!services.arrayReference)throw new Error('Array property is not linked');
            return services.arrayReference(refValue(evaluate(n.left,instance)),evaluate(n.right,receiver),fn,n);
          case 0x20:
            if(!n.objectIndex)return null;
            if(!services.objectReference)throw new Error('Object constant is not linked');
            return services.objectReference(fn,n.objectIndex,n);
          case 0x21:return n.name;
          case 0x13: case 0x2e: {
            // SerializeExpr stores the target object before the child.  The
            // native handlers then evaluate that child against the current
            // FFrame.Object and pass its resulting UObject to the cast test.
            if(typeof services.objectReference!=='function')throw new Error('Object cast target is not linked');
            if(typeof services.castObject!=='function')throw new Error('Object cast is not linked');
            const target=services.objectReference(fn,n.fieldIndex,n);
            const object=refValue(evaluate(n.value,instance));
            return services.castObject(object,target,n.op===0x13?'meta':'dynamic');
          }
          case 0x2d:{
            const field=evaluate(n.value,receiver);
            if(!field?.reference)throw new Error('BoolVariable requires a property');
            return {reference:true,get:()=>Boolean(refValue(field)),set:value=>assign(field,Boolean(value))};
          }
          case 0x3a: return refValue(evaluate(n.value)) & 255;
          case 0x3c: return f(refValue(evaluate(n.value)) & 255);
          case 0x3d: return refValue(evaluate(n.value)) & 255;
          case 0x3f: return f(refValue(evaluate(n.value)) | 0);
          case 0x43: {
            // execFloatToByte 10131aa0: float32 local -> _ftol -> store AL.
            const value = f(refValue(evaluate(n.value)));
            if (!Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63)
              throw new Error('Original FloatToByte _ftol nonfinite/overflow conversion is not implemented');
            return Math.trunc(value) & 255;
          }
          case 0x44: {
            // Core10131b40: float32 local -> _ftol -> store low DWORD.
            const value=f(refValue(evaluate(n.value)));
            if(!Number.isFinite(value)||value<-(2**63)||value>=2**63)
              throw new Error('Original FloatToInt _ftol nonfinite/overflow conversion is not implemented');
            return Math.trunc(value)|0;
          }
          case 0x50: return vectorToRotator(refValue(evaluate(n.value,instance)));
          case 0x57: return scriptNameToString(refValue(evaluate(n.value,instance)));
          case 0x36: {
            const field=evaluate(n.value,receiver);
            if(services.structReference)return services.structReference(field,fn,n);
            const value=refValue(field);return reference(value,Array.isArray(value)?{X:0,Y:1,Z:2,Pitch:0,Yaw:1,Roll:2}[n.name]:n.name);
          }
          case 0x0b: return undefined;
          default: throw new Error(`VM expression opcode 0x${n.op.toString(16)} is not supported`);
        }
      };
      frame.resume = () => {
        let budget = 2048;
        // A native iterator owns its body loop until Next/Pop, including when
        // a body statement changes the actor's latent action.
        while (frame.cursor !== null && (!frame.latent||frame.iterators.length) && !frame.returned) {
          if (!budget--) throw new Error('VM instruction budget exceeded');
          const entry = statements.get(frame.cursor); if (!entry) throw new Error('VM instruction pointer outside script');
          const n = entry.node;
          // Native state calls may replace Code. Advance before dispatch so a
          // GotoLabel or Stop during the statement is not overwritten afterward.
          frame.cursor = entry.next;
          if(n.op===0x2f){
            if(n.value.op!=='native'||!services.iterator)throw new Error('Original iterator native is not linked');
            const iterator=services.iterator({index:n.value.index,receiver:instance,script:fn,frame,
              argumentCount:n.value.args.length,evaluateArgument:index=>evaluate(n.value.args[index],instance)});
            const continuation={iterator,body:entry.next,after:statements.get(n.target).next};
            if(iterator.next())frame.iterators.push(continuation);
            else frame.cursor=continuation.after;
          }else if(n.op===0x31){
            const current=frame.iterators.at(-1);
            if(!current)throw new Error('IteratorNext without an active iterator');
            if(current.iterator.next())frame.cursor=current.body;
            else{frame.iterators.pop();frame.cursor=current.after;}
          }else if(n.op===0x30){
            if(!frame.iterators.pop())throw new Error('IteratorPop without an active iterator');
          }else if (n.op === 0x04) {
            if(frame.iterators.length)throw new Error('Return requires compiled iterator unwind');
            frame.result=refValue(evaluate(n.value));frame.returned=true;frame.cursor=null;
          }
          else if (n.op === 0x08) {
            if(!frame.state)throw new Error('Stop requires a state frame');
            frame.cursor=null;
          } else if (n.op === 0x05) {
            // EX_Switch: evaluate the switch value once; the following EX_Case
            // statements compare against it. Non-nested storage suffices because
            // all cases of a switch are evaluated before its matched body runs.
            frame.switchValue = refValue(evaluate(n.value));
          } else if (n.op === 0x0a) {
            // EX_Case: default (0xffff) always falls through; otherwise compare the
            // case value to the stored switch value — match falls into the body,
            // mismatch jumps to the next case (n.target).
            if (n.target !== 0xffff) {
              const value = refValue(evaluate(n.value)), key = frame.switchValue;
              const equal = key === value || (typeof key === 'string' && typeof value === 'string' && key.toLowerCase() === value.toLowerCase());
              if (!equal) frame.cursor = n.target;
            }
          } else if (n.op === 0x06 || n.op === 0x07 && !refValue(evaluate(n.value))) frame.cursor = n.target;
          else if (n.op !== 0x07) evaluate(n);
        }
        return frame.result;
      };
      return frame;
    },
    run(instance, locals = {}, services = {}) { return compiled.createFrame(instance,locals,services).resume(); },
  };
  return compiled;
}
