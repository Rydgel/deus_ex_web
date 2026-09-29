/**
 * Lowering of a compiled function to the Rust interpreter's word code
 * (docs/rust-core.md step R2b-2; native/script-vm/src/interp.rs). The format
 * is the contract in that file's header: a statement table, then each
 * statement's typed expression tree in evaluation order.
 *
 * Only what the Rust interpreter computes exactly as the compiled closures
 * (script-vm.mjs) do is lowered: scalar locals and fields at their linked
 * offsets, constants, and Core's scalar operators and conversions. Any other
 * node becomes a JavaScript node of the kind its position expects (the
 * closure evaluates it on the same frame), and any other statement a
 * JavaScript step (`compiled.step`), so every function body can run.
 *
 * Types come from the original tokens and linked properties: a literal's
 * token, a variable's property type, an operator's Core signature. A
 * position's consumer fixes how a JavaScript value converts, as the closures
 * convert it: int `v | 0`, bool `Boolean(v)`, float `+v` (undefined is kept
 * apart, since the float store codec turns it into 0), object its handle.
 */
import {scalarCell, structMemberCell, fieldImageCell, fieldImageCellVersion, isFixedCell} from './script-object-image.mjs';
import {primitiveNativeIndices} from './script-vm.mjs';
import {frameLayout} from './script-frame-locals.mjs';
import {fixedArrayShape} from './script-values.mjs';

const K = {
  S_EXPR: 1, S_JUMP: 2, S_JUMP_IF_NOT: 3, S_RETURN: 4, S_NOTHING: 5, S_YIELD: 6, S_ITER_NEXT: 7, S_ITER_POP: 8,
  LIT_INT: 20, LIT_FLOAT: 21, LIT_BOOL: 23, LIT_NONE: 24,
  LOCAL: {int: 30, byte: 31, bool: 32, float: 33, object: 34},
  FIELD: {int: 40, byte: 41, bool: 42, float: 43, object: 44},
  FIELD_ELEM: {int: 25, byte: 26, bool: 27, float: 28, object: 29},
  LOCAL_ELEM: {int: 35, byte: 36, bool: 37, float: 38, object: 39},
  DEFAULT: {int: 45, byte: 46, bool: 47, float: 48},
  JS: {int: 50, byte: 50, bool: 52, float: 53, object: 54}, JS_VOID: 55,
  SET_LOCAL: {int: 60, byte: 61, bool: 62, float: 63, object: 68},
  SET_FIELD: {int: 64, byte: 65, bool: 66, float: 67, object: 69},
  COMPOUND_LOCAL: 56, COMPOUND_FIELD: 57,
  CONTEXT: 70, SELF: 71, CALL: 72, DYNAMIC_CAST: 73,
  NOT: 80, AND: 81, OR: 82, BOOL_NE: 83, BOOL_EQ: 84,
  INT_DIV: 95, INT_LE: 96, INT_GE: 113, INT_CLAMP: 109, INT_NEG: 102, INT_NOT: 103,
  INC_LOCAL_PRE: 110, DEC_LOCAL_PRE: 111, INC_LOCAL_POST: 112,
  FLOAT_NEG: 124, FLOAT_LE: 127,
  BYTE_TO_INT: 150, INT_TO_BYTE: 151, INT_TO_FLOAT: 152, BYTE_TO_FLOAT: 153, FLOAT_TO_INT: 154, FLOAT_TO_BYTE: 155,
};
const NEXT_NONE = 0xffffffff;
const RETURN_KIND = {int: 1, byte: 1, bool: 2, float: 3, object: 4};
// A context's value width (EX_Context's valueSize) per kind.
const WIDTH = {int: 4, byte: 1, bool: 4, float: 4, object: 4};

// Core operator natives by index: [kind code, operand kinds, result kind].
// Each transcribes its case in script-vm.mjs native().
const OPERATORS = new Map([
  [129, [K.NOT, ['bool'], 'bool']],
  [131, [K.BOOL_NE, ['bool', 'bool'], 'bool']],
  [242, [K.BOOL_EQ, ['bool', 'bool'], 'bool']],
  [243, [K.BOOL_NE, ['bool', 'bool'], 'bool']],
  [146, [90, ['int', 'int'], 'int']],
  [147, [91, ['int', 'int'], 'int']],
  [144, [92, ['int', 'int'], 'int']],
  [145, [K.INT_DIV, ['int', 'int'], 'int']],
  [156, [99, ['int', 'int'], 'int']],
  [157, [100, ['int', 'int'], 'int']],
  [158, [101, ['int', 'int'], 'int']],
  [148, [104, ['int', 'int'], 'int']],
  [149, [105, ['int', 'int'], 'int']],
  [196, [106, ['int', 'int'], 'int']],
  [249, [107, ['int', 'int'], 'int']],
  [250, [108, ['int', 'int'], 'int']],
  [251, [K.INT_CLAMP, ['int', 'int', 'int'], 'int']],
  [143, [K.INT_NEG, ['int'], 'int']],
  [141, [K.INT_NOT, ['int'], 'int']],
  [150, [93, ['int', 'int'], 'bool']],
  [151, [94, ['int', 'int'], 'bool']],
  [152, [K.INT_LE, ['int', 'int'], 'bool']],
  [153, [K.INT_GE, ['int', 'int'], 'bool']],
  [154, [97, ['int', 'int'], 'bool']],
  [155, [98, ['int', 'int'], 'bool']],
  [171, [120, ['float', 'float'], 'float']],
  [172, [121, ['float', 'float'], 'float']],
  [174, [122, ['float', 'float'], 'float']],
  [175, [123, ['float', 'float'], 'float']],
  [169, [K.FLOAT_NEG, ['float'], 'float']],
  [244, [132, ['float', 'float'], 'float']],
  [245, [133, ['float', 'float'], 'float']],
  [176, [125, ['float', 'float'], 'bool']],
  [177, [126, ['float', 'float'], 'bool']],
  [178, [K.FLOAT_LE, ['float', 'float'], 'bool']],
  [179, [128, ['float', 'float'], 'bool']],
  [180, [129, ['float', 'float'], 'bool']],
  [181, [130, ['float', 'float'], 'bool']],
  [210, [131, ['float', 'float'], 'bool']],
  [114, [140, ['object', 'object'], 'bool']],
  [119, [141, ['object', 'object'], 'bool']],
]);
// ++/--/++ on an int out-operand (163/164/165).
const INCREMENTS = new Map([[163, K.INC_LOCAL_PRE], [164, K.DEC_LOCAL_PRE], [165, K.INC_LOCAL_POST]]);
// Out-operand assignments (+=, -=, *=) as statements: [op, operand kind].
const COMPOUNDS = new Map([[184, [1, 'float']], [185, [2, 'float']], [182, [3, 'float']], [161, [4, 'int']], [162, [5, 'int']]]);
const primitives = new Set(primitiveNativeIndices);
for (const index of [...OPERATORS.keys(), ...INCREMENTS.keys(), ...COMPOUNDS.keys()])
  if (!primitives.has(index)) throw new Error(`Lowered operator ${index} is not a VM primitive`);

// Cast tokens: [kind code, operand kind, result kind].
const CASTS = new Map([
  [0x3a, [K.BYTE_TO_INT, 'byte', 'int']],
  [0x3d, [K.INT_TO_BYTE, 'int', 'byte']],
  [0x3c, [K.BYTE_TO_FLOAT, 'byte', 'float']],
  [0x3f, [K.INT_TO_FLOAT, 'int', 'float']],
  [0x43, [K.FLOAT_TO_BYTE, 'float', 'byte']],
  [0x44, [K.FLOAT_TO_INT, 'float', 'int']],
]);

// A call's argument and result kinds (interp.rs CALL).
const PARAM_KIND = {int: 1, bool: 2, float: 3, object: 4, byte: 5};
const RESULT_KIND = {int: 1, byte: 1, bool: 2, float: 3, object: 4};
const RESULT_TYPE = {int: 'int', byte: 'int', bool: 'bool', float: 'float', object: 'object', class: 'object'};
const CALL_KIND = {0: 'void', 1: 'int', 2: 'bool', 3: 'float', 4: 'object'};
const CALL_PARAM_KINDS = new Set(['int', 'byte', 'bool', 'float', 'object']);

// Signatures by shape, shared by every runtime: a call site is lowered for one
// shape and runs in Rust only when the resolved function has it.
const signatureIds = new Map();
const signatures = new WeakMap();
/** A prepared function's call signature for Rust calls — {id, rkind,
 * params: [{kind, offset, mask}]} — or null when a call to it keeps the
 * JavaScript path: out parameters, a value without a scalar cell, locals
 * that need destruction (CPF_NeedCtorLink), a frame without a block. */
export function functionSignature(fn, loader) {
  const cached = signatures.get(fn);
  if (cached && cached.source === fn.fields) return cached.signature;
  let signature = null;
  const layout = loader ? frameLayout(fn, loader) : null;
  const resultType = fn.result ? RESULT_TYPE[fn.result.metadata?.type] : 'void';
  if (layout && !layout.slotFields && resultType &&
    !fn.fields.some(field => field.metadata?.flags & 0x00400000) &&
    fn.parameters.every(field => !field.metadata?.out)) {
    const params = fn.parameters.map((field, index) => scalarCell(layout.parameterCells[index]));
    if (params.every(param => param && CALL_PARAM_KINDS.has(param.kind))) {
      const rkind = resultType === 'void' ? 0 : RESULT_KIND[resultType];
      const shape = `${rkind}|${params.map(param => `${param.kind}:${param.offset}:${param.mask}`).join(',')}`;
      let id = signatureIds.get(shape);
      if (id === undefined) signatureIds.set(shape, id = signatureIds.size + 1);
      signature = {id, rkind, params};
    }
  }
  signatures.set(fn, {source: fn.fields, signature});
  return signature;
}

// Field keys as small integers, shared by every runtime (the bound-key table
// is indexed by them).
const keyIds = new Map();
export function fieldKeyId(key) {
  let id = keyIds.get(key);
  if (id === undefined) keyIds.set(key, id = keyIds.size);
  return id;
}

// Class records as small integers from 1, shared by every runtime: a cast's
// target and the class rows of the handle class table (script-vm-rust.mjs)
// name records by these ids, so equal ids are the same record.
const recordIds = new WeakMap();
let nextRecordId = 1;
export function classRecordId(record) {
  let id = recordIds.get(record);
  if (id === undefined) recordIds.set(record, id = nextRecordId++);
  return id;
}

// The record id of the linked class whose own properties (propertyOrder)
// include `field`: a class's PropertyLink is its chain's propertyOrders, so
// the field is in it exactly when that class is in its chain (the handle
// class table checks the concatenation per class).
const owners = new WeakMap();
function ownerRecordId(field, runtime) {
  let id = owners.get(field);
  if (id !== undefined) return id;
  for (const cls of runtime.linkedClasses ?? []) {
    if (!cls.propertyOrder?.includes(field)) continue;
    if (id !== undefined) return 0;
    id = classRecordId(cls.record);
  }
  if (id === undefined) return 0;
  owners.set(field, id);
  return id;
}

const f32io = new DataView(new ArrayBuffer(4));
const floatBits = v => (f32io.setFloat32(0, v, true), f32io.getUint32(0, true));

// Kinds a position accepts: an int position takes a byte value unchanged
// (the consumer's `| 0` or `& 255` is the same), and a byte position an int
// (every byte consumer masks).
const accepts = (want, kind) => want === kind || (want === 'int' && kind === 'byte') || (want === 'byte' && kind === 'int');
const isNode = n => n !== null && typeof n === 'object';

/** Lower `compiled` for frames with `layout` (their FrameLocals layout), or
 * return null when nothing would run in Rust. */
export function lowerFunction(compiled, layout, services, runtime, instance) {
  const fn = compiled.script, statements = compiled.decoded.statements;
  const offsets = [...statements.keys()], entries = [...statements.values()];
  const indexOf = new Map(offsets.map((offset, index) => [offset, index]));
  const nodes = [], nodeIds = new Map();
  const nodeId = n => {
    let id = nodeIds.get(n);
    if (id === undefined) { nodeIds.set(n, id = nodes.length); nodes.push(n); }
    return id;
  };
  const hasIterator = entries.some(entry => entry.node.op === 0x2f);
  const version = fieldImageCellVersion();
  let missingField = false, rustStatements = 0, inContext = false;
  const returnKinds = new Set(), fieldNodes = new Set();

  const operand = n => {
    try { return services.operand(fn, n); } catch { return null; }
  };
  // A local's scalar cell in this layout.
  const localCell = n => {
    const field = operand(n);
    return field?.metadata ? scalarCell(layout.cells.get(field.key)) : null;
  };
  // An instance field's scalar cell and key id.
  const fieldCell = n => {
    const field = operand(n);
    if (!field?.metadata) return null;
    const cell = scalarCell(fieldImageCell(field.key));
    if (!cell) { missingField = true; return null; }
    return {...cell, key: fieldKeyId(field.key), name: field.key};
  };

  /** The node's own lowering: {kind, words, canonical}, or null. A
   * canonical value is the closure's value itself (not a conversion of a
   * JavaScript value), so a Return may hand it back as the frame result. */
  function natural(n) {
    if (!isNode(n)) return null;
    const op = n.op;
    if (op === 'literal') {
      switch (n.token) {
        case 0x1d: case 0x25: case 0x26: case 0x2c: return typed('int', [K.LIT_INT, n.value >>> 0]);
        case 0x24: return typed('byte', [K.LIT_INT, n.value >>> 0]);
        case 0x1e: return typed('float', [K.LIT_FLOAT, floatBits(n.value)]);
        case 0x27: case 0x28: return typed('bool', [K.LIT_BOOL, n.value ? 1 : 0]);
        case 0x2a: return typed('object', [K.LIT_NONE]);
        default: return null;
      }
    }
    if (op === 0x20 && !n.objectIndex) return typed('object', [K.LIT_NONE]);
    if (op === 0x17) return typed('object', [K.SELF]);
    if (op === 0x00) {
      const cell = localCell(n);
      if (!cell) return null;
      return typed(cell.kind, cell.kind === 'bool' ? [K.LOCAL.bool, cell.offset, cell.mask] : [K.LOCAL[cell.kind], cell.offset]);
    }
    if (op === 0x01) {
      const cell = fieldCell(n);
      if (!cell) return null;
      const words = [K.FIELD[cell.kind], cell.offset, nodeId(n), cell.key];
      fieldNodes.add(nodeId(n));
      if (cell.kind === 'bool') words.push(cell.mask);
      return typed(cell.kind, words);
    }
    if (op === 0x1a) return element(n, n);
    if (op === 0x36 && isNode(n.value) && n.value.op === 0x1a) return element(n.value, n);
    if (op === 0x02) return defaultVariable(n);
    if (op === 0x2e) return dynamicCast(n);
    // A scalar member of a struct variable (Location.X): the member's bytes
    // in the variable's cell. A field keeps the struct's key, so a bound
    // struct (and the JavaScript path) takes the whole member node.
    if (op === 0x36 && isNode(n.value) && (n.value.op === 0x00 || n.value.op === 0x01)) {
      const member = operand(n), variable = operand(n.value);
      if (!member?.metadata || !variable?.metadata) return null;
      if (n.value.op === 0x00) {
        const cell = structMemberCell(layout.cells.get(variable.key), member);
        if (!cell) return null;
        return typed(cell.kind, cell.kind === 'bool' ? [K.LOCAL.bool, cell.offset, cell.mask] : [K.LOCAL[cell.kind], cell.offset]);
      }
      const struct = fieldImageCell(variable.key);
      if (!struct) { missingField = true; return null; }
      const cell = structMemberCell(struct, member);
      if (!cell) return null;
      const words = [K.FIELD[cell.kind], cell.offset, nodeId(n), fieldKeyId(variable.key)];
      if (cell.kind === 'bool') words.push(cell.mask);
      fieldNodes.add(nodeId(n));
      return typed(cell.kind, words);
    }
    // BoolVariable around a variable reads that variable as a bool.
    if (op === 0x2d && isNode(n.value) && (n.value.op === 0x00 || n.value.op === 0x01)) {
      const inner = natural(n.value);
      return inner?.kind === 'bool' ? inner : null;
    }
    if (op === 0x19) {
      inContext = true;
      let value;
      try { value = natural(n.value); } finally { inContext = false; }
      return value && WIDTH[value.kind] === n.valueSize ? context(n, value.kind, value.words, value.canonical) : null;
    }
    const cast = CASTS.get(op);
    if (cast) {
      const [code, operandKind, kind] = cast;
      return typed(kind, [code, ...expr(n.value, operandKind)]);
    }
    if (op === 'native') return native(n);
    if (op === 0x1b || op === 0x1c) return call(n, !inContext);
    return null;
  }
  const typed = (kind, words, canonical = true) => ({kind, words, canonical});

  // A script call whose function is known here: final calls by operand,
  // virtual calls on SELF by name from the running object (an override has
  // the same signature). JavaScript resolves the call again when it runs and
  // leaves it to JavaScript when that function's signature differs.
  function call(n, receiverIsSelf) {
    if (!Array.isArray(n.args)) return null;
    let record = null;
    try {
      if (n.op === 0x1c) record = operand(n);
      else if (n.op === 0x1b && receiverIsSelf && instance) record = runtime.lookup(instance, n.name, false);
    } catch { return null; }
    const target = record?.function, signature = target && functionSignature(target, runtime.classLoader);
    if (!signature || n.args.length > signature.params.length) return null;
    const args = [];
    n.args.forEach((arg, index) => {
      const param = signature.params[index];
      if (isNode(arg) && arg.op === 0x0b) args.push(0, 0, 0);
      else args.push(PARAM_KIND[param.kind], param.offset, param.mask, ...expr(arg, param.kind));
    });
    return typed(CALL_KIND[signature.rkind],
      [K.CALL, nodeId(n), signature.rkind, signature.id, n.args.length, args.length, ...args]);
  }

  // EX_ArrayElement (0x1a) of a local or instance fixed array read as a
  // value (`n` is `a`), or a scalar member of its element (`n` the 0x36 over
  // `a`): the element's bytes in the variable's cell. The index must
  // evaluate without an import (a literal or a local), since the JavaScript
  // path (a field on it, an index out of range) evaluates it again.
  function element(a, n) {
    const rs = runtime.services;
    if (services.arrayReference !== rs.arrayReference) return null;
    if (n !== a && (services.structValue !== rs.structValue || services.structReference !== rs.structReference)) return null;
    const variable = a.right;
    if (!isNode(variable) || (variable.op !== 0x00 && variable.op !== 0x01)) return null;
    const index = pureIndex(a.left);
    if (!index) return null;
    const field = operand(variable);
    if (!field?.metadata) return null;
    const cell = variable.op === 0x00 ? layout.cells.get(field.key) : fieldImageCell(field.key);
    if (!cell) {
      if (variable.op === 0x01) missingField = true;
      return null;
    }
    const shape = fixedArrayShape(field);
    if (!isFixedCell(cell) || !shape || shape.dimension !== cell.dim) return null;
    let target;
    if (n === a) target = scalarCell(cell.element);
    else {
      const member = operand(n);
      if (!member?.metadata) return null;
      target = structMemberCell(cell.element, member);
    }
    if (!target) return null;
    const offset = cell.offset + target.offset, id = nodeId(n);
    const words = variable.op === 0x00 ? [K.LOCAL_ELEM[target.kind], offset, cell.stride, cell.dim, id]
      : [K.FIELD_ELEM[target.kind], offset, cell.stride, cell.dim, id, fieldKeyId(field.key)];
    if (variable.op === 0x01) fieldNodes.add(id);
    if (target.kind === 'bool') words.push(target.mask);
    return typed(target.kind, [...words, ...index]);
  }
  // An int index with no effect and no import: a literal, a local, or a
  // byte-to-int conversion of either.
  function pureIndex(n) {
    const lowered = natural(n);
    if (!lowered || !accepts('int', lowered.kind)) return null;
    const words = lowered.words;
    const leaf = at => words[at] === K.LIT_INT || words[at] === K.LOCAL.int || words[at] === K.LOCAL.byte;
    return words.length === 2 && leaf(0) || words.length === 3 && words[0] === K.BYTE_TO_INT && leaf(1) ? words : null;
  }

  // DefaultVariable (0x02) of a scalar property: the receiver's class
  // default image (interp.rs DEFAULT_*). Object and array defaults and
  // Object's header properties (classDefaultReference's special cases) stay
  // in JavaScript.
  function defaultVariable(n) {
    if (services.defaultReference !== runtime.services.defaultReference) return null;
    const field = operand(n);
    if (!field?.metadata || typeof field.key !== 'string' || field.key.startsWith('core.object.')) return null;
    const registered = fieldImageCell(field.key);
    if (!registered) {
      missingField = true;
      return null;
    }
    const cell = scalarCell(registered);
    if (!cell || cell.kind === 'object') return null;
    const owner = ownerRecordId(field, runtime);
    if (!owner) return null;
    const words = [K.DEFAULT[cell.kind], cell.offset, nodeId(n), owner];
    if (cell.kind === 'bool') words.push(cell.mask);
    return typed(cell.kind, words);
  }

  // DynamicCast (0x2e) to a script class or None. A native-only class
  // target (castToNativeClass) or a bad target stays in JavaScript. The
  // target is the operand the closure resolves before the value.
  function dynamicCast(n) {
    const rs = runtime.services;
    if (services.objectReference !== rs.objectReference || services.castObject !== rs.castObject) return null;
    let target;
    try { target = services.objectReference(fn, n.fieldIndex, n); } catch { return null; }
    if (target !== null && target?.kind !== 'Class') return null;
    return typed('object', [K.DYNAMIC_CAST, target === null ? 0 : classRecordId(target), nodeId(n), ...expr(n.value, 'object')]);
  }

  function native(n) {
    const index = n.index, args = n.args;
    if (index === 130 || index === 132) {
      if (args.length !== 2 || !isNode(args[1]) || args[1].op !== 0x18) return null;
      const first = expr(args[0], 'bool'), second = expr(args[1].value, 'bool');
      return typed('bool', [index === 130 ? K.AND : K.OR, second.length, ...first, ...second]);
    }
    const increment = INCREMENTS.get(index);
    if (increment !== undefined) {
      if (args.length !== 1 || !isNode(args[0]) || args[0].op !== 0x00) return null;
      const cell = localCell(args[0]);
      return cell?.kind === 'int' ? typed('int', [increment, cell.offset]) : null;
    }
    const operator = OPERATORS.get(index);
    if (!operator || args.length !== operator[1].length) return null;
    const words = [operator[0]];
    operator[1].forEach((kind, i) => words.push(...expr(args[i], kind)));
    // FMin/FMax hand back an operand unconverted.
    return typed(operator[2], words, index !== 244 && index !== 245);
  }

  // EX_Context: the object against the current receiver, then the value
  // against that object; None logs Accessed None and yields the zero.
  function context(n, kind, valueWords, canonical) {
    return typed(kind, [K.CONTEXT, nodeId(n), valueWords.length, ...expr(n.context, 'object'), ...valueWords], canonical);
  }

  /** Code for `n` in a position of kind `want`. */
  function expr(n, want) {
    const lowered = natural(n);
    if (lowered && accepts(want, lowered.kind)) return lowered.words;
    // A context whose value is left to JavaScript still evaluates its
    // object here; the value's closure runs against the context object.
    if (isNode(n) && n.op === 0x19 && WIDTH[want] === n.valueSize)
      return context(n, want, expr(n.value, want), false).words;
    return [K.JS[want], nodeId(n)];
  }

  /** A variable a store can write in place: a local, a field of SELF, or a
   * scalar member of either (the member's bytes; JavaScript's member
   * reference rewrites the whole struct, which differs only for a
   * signaling NaN in another member, and the original writes the member
   * through GPropAddr). {kind, offset, mask} and, for a field, its key. */
  function storeTarget(target) {
    if (!isNode(target)) return null;
    if (target.op === 0x00) return localCell(target);
    if (target.op === 0x01) return fieldCell(target);
    if (target.op !== 0x36 || !isNode(target.value) || (target.value.op !== 0x00 && target.value.op !== 0x01)) return null;
    const member = operand(target), variable = operand(target.value);
    if (!member?.metadata || !variable?.metadata) return null;
    if (target.value.op === 0x00) return structMemberCell(layout.cells.get(variable.key), member);
    const struct = fieldImageCell(variable.key);
    if (!struct) { missingField = true; return null; }
    const cell = structMemberCell(struct, member);
    return cell && {...cell, key: fieldKeyId(variable.key), name: variable.key};
  }
  const isLocal = target => target.op === 0x00 || target.op === 0x36 && target.value.op === 0x00;

  function assignment(n, bool) {
    let target = n.left;
    if (bool && isNode(target) && target.op === 0x2d && isNode(target.value) &&
      (target.value.op === 0x00 || target.value.op === 0x01)) target = target.value;
    else if (bool) return null;
    const cell = storeTarget(target);
    if (!cell || (bool && cell.kind !== 'bool')) return null;
    const value = expr(n.right, cell.kind);
    if (isLocal(target)) return cell.kind === 'bool' ? [K.SET_LOCAL.bool, cell.offset, cell.mask, ...value]
      : [K.SET_LOCAL[cell.kind], cell.offset, ...value];
    // Actor.Base's store also bumps the base epoch in JavaScript.
    if (cell.kind === 'object' && cell.name === 'engine.actor.base') return null;
    const head = [K.SET_FIELD[cell.kind], cell.offset, nodeId(n), cell.key, value.length];
    fieldNodes.add(nodeId(n));
    if (cell.kind === 'bool') head.push(cell.mask);
    return [...head, ...value];
  }

  // `X += V` and the like as a statement: V is evaluated before X is read.
  function compound(n) {
    const [op, kind] = COMPOUNDS.get(n.index);
    if (n.args.length !== 2) return null;
    const cell = storeTarget(n.args[0]);
    if (cell?.kind !== kind) return null;
    const value = expr(n.args[1], kind);
    if (isLocal(n.args[0])) return [K.COMPOUND_LOCAL, op, cell.offset, ...value];
    fieldNodes.add(nodeId(n));
    return [K.COMPOUND_FIELD, op, cell.offset, nodeId(n), cell.key, value.length, ...value];
  }

  function statement(n) {
    switch (n.op) {
      case 0x06: return [K.S_JUMP, indexOf.get(n.target)];
      case 0x07: return [K.S_JUMP_IF_NOT, indexOf.get(n.target), ...expr(n.value, 'bool')];
      case 0x04: {
        if (hasIterator) return null;
        if (isNode(n.value) && n.value.op === 0x0b) return [K.S_RETURN, 0];
        const value = natural(n.value);
        if (!value || !value.canonical || !RETURN_KIND[value.kind]) return null;
        returnKinds.add(RETURN_KIND[value.kind]);
        return [K.S_RETURN, RETURN_KIND[value.kind], ...value.words];
      }
      case 0x0b: return [K.S_NOTHING];
      case 0x0f: case 0x14: {
        const words = assignment(n, n.op === 0x14);
        return words ? [K.S_EXPR, ...words] : [K.S_EXPR, K.JS_VOID, nodeId(n)];
      }
      // A foreach's steps: the iterator stays on the frame in JavaScript.
      case 0x31: return [K.S_ITER_NEXT];
      case 0x30: return [K.S_ITER_POP];
      // The compiled loop's own statements stay there.
      case 0x2f: case 0x08: case 0x05: case 0x0a: return null;
      default: {
        if (n.op === 'native' && INCREMENTS.has(n.index)) {
          const lowered = native(n);
          if (lowered) return [K.S_EXPR, ...lowered.words];
        }
        if (n.op === 'native' && COMPOUNDS.has(n.index)) {
          const words = compound(n);
          if (words) return [K.S_EXPR, ...words];
        }
        if (n.op === 0x1b || n.op === 0x1c) {
          const lowered = call(n, true);
          if (lowered) return [K.S_EXPR, ...lowered.words];
        }
        return [K.S_EXPR, K.JS_VOID, nodeId(n)];
      }
    }
  }

  const lowerAll = () => {
    const words = [entries.length];
    for (let i = 0; i < entries.length; i++) words.push(0, 0);
    rustStatements = 0;
    for (let i = 0; i < entries.length; i++) {
      const {node, next} = entries[i];
      words[1 + 2 * i] = words.length;
      words[2 + 2 * i] = indexOf.get(next) ?? NEXT_NONE;
      let code = isNode(node) ? statement(node) : null;
      // The host converts a typed result by one kind per function.
      if (code?.[0] === K.S_RETURN && code[1] && returnKinds.size > 1) code = null;
      if (code) {
        if (!(code[0] === K.S_EXPR && code[1] === K.JS_VOID)) rustStatements++;
        words.push(...code);
      } else words.push(K.S_YIELD);
    }
    return words;
  };
  let words = lowerAll();
  // Returns of different kinds (not expected: the compiler converts every
  // return value to the function's type) all stay in JavaScript.
  if (returnKinds.size > 1) words = lowerAll();
  if (!rustStatements) return null;
  for (const word of words) if (!Number.isInteger(word) || word < 0 || word > 0xffffffff)
    throw new Error(`Lowered word out of range in ${compiled.name}: ${word}`);
  return {
    words: Uint32Array.from(words), bytes: words.length * 4, code: 0, nodes, indexOf, entries, fieldNodes,
    returnKind: returnKinds.size === 1 ? [...returnKinds][0] : 0,
    // A field without a registered cell went to JavaScript; relower once
    // the registry has changed.
    stale: missingField ? () => fieldImageCellVersion() !== version : null,
    runtime,
  };
}
