import { Reader } from '../unreal/package.mjs';
import { objectAt } from '../unreal/objects.mjs';

const f = Math.fround;
const refValue = v => v?.reference ? v.get() : v;
const reference = (object, key) => ({ reference: true, get: () => object[key], set: value => (object[key] = value) });
const assign = (ref, value) => { if (!ref?.reference) throw new Error('Script assignment requires a variable'); return ref.set(value); };

/** Deliberately bounded VM prototype for the original CheckBob call path.
 * Unsupported instructions/native indices fail, rather than being approximated. */
export function compileFunction(fn) {
  const r = new Reader(fn.bytes), statements = new Map(); let pc = 0;
  const byte = () => { pc++; return r.u8(); };
  const word = () => { pc += 2; return r.u16(); };
  const ref = () => { const n = r.compact(); pc += 4; const e = objectAt(fn.pkg, n); if (!e) throw new Error('Null script field'); return e.name; };
  function expression(depth = 0) {
    if (depth > 128) throw new Error('Script expression nesting limit');
    const op = byte();
    if (op >= 0x60) {
      const index = op < 0x70 ? ((op - 0x60) << 8) + byte() : op, args = [];
      while (true) { const arg = expression(depth + 1); if (arg.op === 0x16) break; args.push(arg); }
      return { op: 'native', index, args };
    }
    switch (op) {
      case 0x00: case 0x01: return { op, name: ref() };
      case 0x06: return { op, target: word() };
      case 0x07: { const target = word(); return { op, target, value: expression(depth + 1) }; }
      case 0x04: case 0x3f: return { op, value: expression(depth + 1) };
      case 0x0f: return { op, left: expression(depth + 1), right: expression(depth + 1) };
      case 0x1e: pc += 4; return { op: 'literal', value: r.f32() };
      case 0x25: case 0x26: return { op: 'literal', value: op - 0x25 };
      case 0x2c: return { op: 'literal', value: byte() };
      case 0x36: { const name = ref(); return { op, name, value: expression(depth + 1) }; }
      case 0x0b: case 0x16: return { op };
      default: throw new Error(`VM prototype does not support opcode 0x${op.toString(16)}`);
    }
  }
  while (r.offset < r.bytes.length) { const offset = pc, node = expression(); statements.set(offset, { node, next: pc }); }
  if (pc !== fn.size) throw new Error('Expanded script length mismatch');
  for (const { node } of statements.values()) if ([0x06, 0x07].includes(node.op) && !statements.has(node.target)) throw new Error('Script jump is not an instruction boundary');

  function native(index, args) {
    const values = args.map(refValue), [a, b] = values;
    // Core.Object native declarations and original Engine.u CheckBob bytecode.
    switch (index) {
      case 171: return f(a * b);
      case 172: return f(a / b);
      case 174: return f(a + b);
      case 175: return f(a - b);
      case 176: return a < b;
      case 177: return a > b;
      case 182: return assign(args[0], f(a * b));
      case 184: return assign(args[0], f(a + b));
      case 187: return f(Math.sin(a));
      case 212: return a.map(v => f(v * b));
      case 244: return Math.min(a, b);
      default: throw new Error(`VM prototype does not support native ${index}`);
    }
  }
  return {
    name: fn.entry.path, size: fn.size,
    run(instance, locals) {
      const evaluate = n => {
        switch (n.op) {
          case 'literal': return n.value;
          case 'native': return native(n.index, n.args.map(evaluate));
          case 0x00: return reference(locals, n.name);
          case 0x01: return reference(instance, n.name);
          case 0x0f: return assign(evaluate(n.left), refValue(evaluate(n.right)));
          case 0x3f: return f(refValue(evaluate(n.value)));
          case 0x36: { const value = refValue(evaluate(n.value)); return reference(value, Array.isArray(value) ? { X: 0, Y: 1, Z: 2 }[n.name] : n.name); }
          case 0x0b: return undefined;
          default: throw new Error('VM prototype expression not supported');
        }
      };
      let cursor = 0, budget = 2048;
      while (budget--) {
        const entry = statements.get(cursor); if (!entry) throw new Error('VM instruction pointer outside script');
        const n = entry.node;
        if (n.op === 0x04) return refValue(evaluate(n.value));
        if (n.op === 0x06 || n.op === 0x07 && !refValue(evaluate(n.value))) cursor = n.target;
        else { if (n.op !== 0x07) evaluate(n); cursor = entry.next; }
      }
      throw new Error('VM instruction budget exceeded');
    },
  };
}
