import { decodeScript } from '../unreal/bytecode.mjs';
import { moverPrimitiveIndices, executeMoverPrimitive } from './script-mover-primitives.mjs';
import { decorationPrimitiveIndices, decorationOutPrimitiveIndices, executeDecorationPrimitive, vectorToRotator } from './script-decoration-primitives.mjs';
import { scriptStringEqual, scriptStringComplementEqual, scriptConcat, scriptAt, scriptLen, scriptInStr, scriptMid, scriptLeft, scriptRight, scriptCaps, scriptChr, scriptNameToString, scriptObjectToString } from './script-string-operations.mjs';

const f = Math.fround;
const primitiveNatives=new Set([112,114,119,122,123,124,125,126,127,128,129,135,138,139,140,141,143,144,145,146,147,148,149,150,151,154,155,156,157,158,163,164,165,168,169,171,172,174,175,176,177,179,180,181,182,184,185,187,194,196,210,211,212,213,215,216,217,218,219,221,222,223,224,234,235,236,242,243,244,245,249,250,251,254,255,296,316]);
for(const index of moverPrimitiveIndices)primitiveNatives.add(index);
for(const index of decorationPrimitiveIndices)primitiveNatives.add(index);
export const primitiveNativeIndices=Object.freeze([...primitiveNatives,130,132].sort((a,b)=>a-b));
const primitiveOutNatives=new Set([135,138,139,140,163,164,165,166,182,184,185,221,222,223,224,...decorationOutPrimitiveIndices]);
export const refValue = v => v?.reference ? v.get() : v;
export const reference = (object, key) => ({ reference: true, get: () => object[key], set: value => (object[key] = value) });
export const assign = (ref, value) => { if (!ref?.reference) throw new Error('Script assignment requires a variable'); return ref.set(value); };

// The float/vector natives read and write float32 memory words, so their
// NaN payloads and signed zeros must cross through DataView bit patterns
// rather than JavaScript arithmetic on the NaN values themselves.
const f32io = new DataView(new ArrayBuffer(4));
const f32bits = v => (f32io.setFloat32(0, f(v), true), f32io.getUint32(0, true));
const f32num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));
const X87_INDEFINITE = 0xffc00000;

/** 80-bit x87 stack model for Core's float/vector operator natives.  The
 * bodies FLD float32 temporaries and keep intermediates on the x87 stack —
 * 64-bit significand, round-to-nearest-even — until an FST/FSTP store rounds
 * once to float32.  A finite value is {neg,sig,exp} with
 * value = (-1)^neg * sig * 2^exp; {inf:true} is an infinity; {nan:bits} keeps
 * the float32 NaN payload (the larger-significand operand propagates quieted;
 * invalid operations produce the real indefinite 0xffc00000). */
const x87width = x => x.toString(2).length;
// Round a positive significand to `width` bits, nearest-even; returns
// [significand, rightShiftApplied].
const x87round = (sig, width) => {
  const n = x87width(sig);
  if (n <= width) return [sig, 0];
  const sh = BigInt(n - width);
  let q = sig >> sh;
  const rem = sig - (q << sh), half = 1n << (sh - 1n);
  if (rem > half || (rem === half && (q & 1n))) q += 1n;
  return x87width(q) > width ? [q >> 1n, n - width + 1] : [q, n - width];
};
const x87load = v => {
  const b = f32bits(v), neg = b >>> 31, e = (b >>> 23) & 0xff, m = b & 0x7fffff;
  if (e === 0xff) return m ? { nan: b } : { neg, inf: true };
  return { neg, sig: BigInt(e ? m | 0x800000 : m), exp: e ? e - 150 : -149 };
};
// NaN selection: the operand with the larger significand wins and stores
// quieted; a lone NaN operand quiets the same way.
const x87nan = (a, b) => ({ nan: (((b.nan & 0x7fffff) > (a.nan & 0x7fffff) ? b.nan : a.nan) | 0x400000) >>> 0 });
const x87quiet = v => ({ nan: (v.nan | 0x400000) >>> 0 });
const x87mul = (a, b) => {
  if (a.nan !== undefined) return b.nan === undefined ? x87quiet(a) : x87nan(a, b);
  if (b.nan !== undefined) return x87quiet(b);
  if (a.inf || b.inf) {
    const other = a.inf ? b : a;
    return !other.inf && other.sig === 0n ? { nan: X87_INDEFINITE } : { neg: a.neg ^ b.neg, inf: true };
  }
  if (a.sig === 0n || b.sig === 0n) return { neg: a.neg ^ b.neg, sig: 0n, exp: 0 };
  const [sig, sh] = x87round(a.sig * b.sig, 64);
  return { neg: a.neg ^ b.neg, sig, exp: a.exp + b.exp + sh };
};
// FSUB operand negation: sign flips on finite and infinite values while a
// NaN subtrahend propagates its own payload unchanged.
const x87neg = v => v.nan === undefined ? { ...v, neg: v.neg ^ 1 } : v;
const x87add = (a, b) => {
  if (a.nan !== undefined) return b.nan === undefined ? x87quiet(a) : x87nan(a, b);
  if (b.nan !== undefined) return x87quiet(b);
  if (a.inf || b.inf) {
    if (a.inf && b.inf) return a.neg === b.neg ? a : { nan: X87_INDEFINITE };
    return a.inf ? a : b;
  }
  if (a.sig === 0n) return b.sig === 0n ? { neg: a.neg & b.neg, sig: 0n, exp: 0 } : b;
  if (b.sig === 0n) return a;
  const exp = Math.min(a.exp, b.exp);
  const sum = (a.neg ? -(a.sig << BigInt(a.exp - exp)) : a.sig << BigInt(a.exp - exp))
    + (b.neg ? -(b.sig << BigInt(b.exp - exp)) : b.sig << BigInt(b.exp - exp));
  if (sum === 0n) return { neg: a.neg & b.neg, sig: 0n, exp: 0 };
  const neg = sum < 0n ? 1 : 0;
  const [sig, sh] = x87round(neg ? -sum : sum, 64);
  return { neg, sig, exp: exp + sh };
};
// 1.0 / b held on the x87 stack (native 222 divides the embedded double
// 1.0 at 0x101765a8 by the float32 divisor and never stores it to float32).
const x87recip = b => {
  const n = x87width(b.sig), num = 1n << BigInt(63 + n);
  let q = num / b.sig;
  const twice = (num - q * b.sig) * 2n;
  if (twice > b.sig || (twice === b.sig && (q & 1n))) q += 1n;
  let exp = -(63 + n) - b.exp;
  if (x87width(q) > 64) { q >>= 1n; exp += 1; }
  return { neg: b.neg, sig: q, exp };
};
// The FST/FSTP float32 store: round the 64-bit significand to 24 bits with
// nearest-even, honoring denormal and overflow boundaries.
const x87store = v => {
  if (v.nan !== undefined) return f32num(v.nan);
  if (v.inf || v.exp + x87width(v.sig) - 1 > 127) return f32num((v.neg << 31) | 0x7f800000);
  if (v.sig === 0n) return f32num(v.neg << 31);
  let e = v.exp + x87width(v.sig) - 1;
  if (e >= -126) {
    const shift = v.exp + 23 - e;
    let sig;
    if (shift >= 0) sig = v.sig << BigInt(shift);
    else {
      const sh = BigInt(-shift);
      let q = v.sig >> sh;
      const rem = v.sig - (q << sh), half = 1n << (sh - 1n);
      if (rem > half || (rem === half && (q & 1n))) q += 1n;
      if (x87width(q) > 24) { q >>= 1n; if (++e > 127) return f32num((v.neg << 31) | 0x7f800000); }
      sig = q;
    }
    return f32num((v.neg << 31) | ((e + 127) << 23) | Number(sig - (1n << 23n)));
  }
  const shift = v.exp + 149;
  let q;
  if (shift >= 0) q = v.sig << BigInt(shift);
  else {
    const sh = BigInt(-shift);
    q = v.sig >> sh;
    const rem = v.sig - (q << sh), half = 1n << (sh - 1n);
    if (rem > half || (rem === half && (q & 1n))) q += 1n;
  }
  return f32num(q >= (1n << 23n) ? (v.neg << 31) | 0x800000 : (v.neg << 31) | Number(q));
};

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
      // Core's int bitwise operators evaluate the int32 operands into DWORD
      // temporaries and execute NOT (141), NEG (143), AND (156), XOR (157) or
      // OR (158); the shifts execute SHL (148), SAR (149) or SHR (196) with
      // the count masked to 5 bits (CL & 31), which is also the JavaScript
      // shift semantics.  196 stores the unsigned SHR result back as an int.
      case 141: return ~(a | 0);
      case 143: return (-(a | 0)) | 0;
      case 148: return (a | 0) << (b | 0);
      case 149: return (a | 0) >> (b | 0);
      case 156: return (a | 0) & (b | 0);
      case 157: return (a | 0) ^ (b | 0);
      case 158: return (a | 0) | (b | 0);
      case 196: return ((a | 0) >>> (b | 0)) | 0;
      case 150: return (a | 0) < (b | 0);
      case 151: return (a | 0) > (b | 0);
      case 154: return (a | 0) === (b | 0);
      case 155: return (a | 0) !== (b | 0);
      // The int/byte out-parameter operators receive arg0 through the
      // original GPropAddr handoff: lvalue arguments mutate the variable,
      // anything else mutates a discarded stack temporary.  The byte
      // operators load and store single bytes (wrapping mod 256); the
      // preoperators return the NEW value while the postoperators write the
      // OLD value to the result before incrementing or decrementing.
      case 135: { const v=((a & 255) + (b & 255)) & 255; if(args[0]?.reference)assign(args[0], v); return v; }
      case 138: { const v=((a & 255) - 1) & 255; if(args[0]?.reference)assign(args[0], v); return v; }
      case 139: { const v=a & 255; if(args[0]?.reference)assign(args[0], (v + 1) & 255); return v; }
      case 140: { const v=a & 255; if(args[0]?.reference)assign(args[0], (v - 1) & 255); return v; }
      case 163: { const v=((a | 0) + 1) | 0; if(args[0]?.reference)assign(args[0], v); return v; }
      case 164: { const v=((a | 0) - 1) | 0; if(args[0]?.reference)assign(args[0], v); return v; }
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
      // Core's float/vector operators: every operand evaluator stores its
      // result as float32, and each FST/FSTP in the bodies is where the
      // original rounds to float32 — anything still on the x87 stack keeps
      // the 64-bit extended significand until that store.
      // SubtractPre_Vector (211) applies x87 FCHS per component — a pure
      // sign-bit flip that preserves even sNaN payloads unquieted.
      case 211: return a.map(v => f32num(f32bits(v) ^ 0x80000000));
      // EqualEqual/NotEqual_VectorVector (217/218) FCOMP each float32
      // component and test only C3 (test ah,0x40): unordered operands — any
      // NaN — compare equal, and signed zeros compare equal.
      case 217: {
        const x=a.map(f),y=b.map(f);
        return x.every((v,i)=>Number.isNaN(v)||Number.isNaN(y[i])||v===y[i]);
      }
      case 218: {
        const x=a.map(f),y=b.map(f);
        return x.some((v,i)=>!Number.isNaN(v)&&!Number.isNaN(y[i])&&v!==y[i]);
      }
      // Dot (219): the three float32 products and both FADDP partial sums
      // stay on the x87 stack until the single FSTP result store, so the
      // accumulation rounds once at 64-bit precision — never at float32 —
      // before the store.  The original sums y*z first, then adds x:
      // px + (py + pz), proven by dot-order-cancel (the +1 dies inside
      // -2^200 + 1 at 64 bits, yielding 0 where left-association gives 1)
      // and dot-partial-extended (2^-55 survives where a double rounds to
      // 0).  FADDP ties hand the inner add to py and the outer add to px,
      // matching x87nan's first-operand preference on equal significands
      // (dot-nan-tie-inner / dot-nan-tie-outer).
      case 219: {
        const px=x87mul(x87load(a[0]),x87load(b[0]));
        const py=x87mul(x87load(a[1]),x87load(b[1]));
        const pz=x87mul(x87load(a[2]),x87load(b[2]));
        return x87store(x87add(px,x87add(py,pz)));
      }
      // The out-vector operators mutate their first operand through the
      // GPropAddr lvalue handoff; a non-lvalue first operand mutates the
      // discarded stack temporary instead and still returns the result.
      case 221: {
        const s=x87load(b),out=a.map(v=>x87store(x87mul(x87load(v),s)));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // DivideEqual_VectorFloat (222) has no zero-divisor guard: it computes
      // the FDIVR reciprocal of the embedded double 1.0 in 80-bit, keeps it
      // on the stack, and multiplies each component — so /= 0 produces
      // signed infinities and the real indefinite NaN, and /= inf produces
      // signed zeros.  Verified by diveq-recip-extended and the divisor
      // sweep cases against the original body.
      case 222: {
        const d=x87load(b);
        const r=d.nan!==undefined?x87quiet(d):d.inf?{neg:d.neg,sig:0n,exp:0}
          :d.sig===0n?{neg:d.neg,inf:true}:x87recip(d);
        const out=a.map(v=>x87store(x87mul(x87load(v),r)));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      case 224: {
        const out=a.map((v,i)=>x87store(x87add(x87load(v),x87neg(x87load(b[i])))));
        if(args[0]?.reference)assign(args[0],out);
        return out;
      }
      // Min (249) is a signed dword compare: A>B ? B : A.
      case 249: return Math.min(a|0,b|0);
      // Square (194): A loaded as float32, multiplied once in x87, a single
      // FSTP float32 store — including -0 -> +0 and NaN payload propagation.
      case 194: { const d=x87load(a); return x87store(x87mul(d,d)); }
      // Multiply_VectorVector (296): each component product stores to
      // float32 with its own FSTP — no cross-component accumulation.
      case 296: return a.map((v,i)=>x87store(x87mul(x87load(v),x87load(b[i]))));
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
          case 0x56: return scriptObjectToString(refValue(evaluate(n.value,instance)));
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
