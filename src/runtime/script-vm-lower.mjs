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
import {scalarCell, structMemberCell, fieldImageCell, fieldImageCellVersion, isFixedCell, vectorCell} from './script-object-image.mjs';
import {primitiveNativeIndices} from './script-vm.mjs';
import {frameLayout} from './script-frame-locals.mjs';
import {fixedArrayShape} from './script-values.mjs';
import {nameId} from './script-name-ids.mjs';

const K = {
  S_EXPR: 1, S_JUMP: 2, S_JUMP_IF_NOT: 3, S_RETURN: 4, S_NOTHING: 5, S_YIELD: 6, S_ITER_NEXT: 7, S_ITER_POP: 8,
  S_RETURN_ITER: 9,
  LIT_INT: 20, LIT_FLOAT: 21, LIT_BOOL: 23, LIT_NONE: 24,
  LOCAL: {int: 30, byte: 31, bool: 32, float: 33, object: 34, vector: 161, rotator: 176},
  FIELD: {int: 40, byte: 41, bool: 42, float: 43, object: 44, vector: 162, rotator: 177},
  FIELD_ELEM: {int: 25, byte: 26, bool: 27, float: 28, object: 29},
  LOCAL_ELEM: {int: 35, byte: 36, bool: 37, float: 38, object: 39},
  DEFAULT: {int: 45, byte: 46, bool: 47, float: 48},
  JS: {int: 50, byte: 50, bool: 52, float: 53, object: 54, vector: 163, rotator: 178, name: 195}, JS_VOID: 55,
  SET_LOCAL: {int: 60, byte: 61, bool: 62, float: 63, object: 68, vector: 196, rotator: 198},
  SET_FIELD: {int: 64, byte: 65, bool: 66, float: 67, object: 69, vector: 197, rotator: 199},
  COMPOUND_LOCAL: 56, COMPOUND_FIELD: 57, VCOMPOUND_LOCAL: 156, VCOMPOUND_FIELD: 157,
  LIT_VECTOR: 160, LIT_ROTATOR: 175, LIT_NAME: 194, VECTOR_MEMBER: 183, ROTATOR_MEMBER: 184, IS_A: 193,
  PAWN_ENEMY: 200, PAWN_ALLIANCE: 201, AI_CAN_SEE: 202,
  CONTEXT: 70, SELF: 71, CALL: 72, DYNAMIC_CAST: 73,
  NOT: 80, AND: 81, OR: 82, BOOL_NE: 83, BOOL_EQ: 84,
  INT_DIV: 95, INT_LE: 96, INT_GE: 113, INT_CLAMP: 109, INT_NEG: 102, INT_NOT: 103,
  INC_LOCAL_PRE: 110, DEC_LOCAL_PRE: 111, INC_LOCAL_POST: 112,
  FLOAT_NEG: 124, FLOAT_LE: 127,
  BYTE_TO_INT: 150, INT_TO_BYTE: 151, INT_TO_FLOAT: 152, BYTE_TO_FLOAT: 153, FLOAT_TO_INT: 154, FLOAT_TO_BYTE: 155,
};
const NEXT_NONE = 0xffffffff;
const RETURN_KIND = {int: 1, byte: 1, bool: 2, float: 3, object: 4, vector: 5, rotator: 6};
// A context's value width (EX_Context's valueSize) per kind.
const WIDTH = {int: 4, byte: 1, bool: 4, float: 4, object: 4, vector: 12, rotator: 12, name: 4};

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
// R2b-6: Core's vector, rotator and name operators (native() cases, and the
// mover primitives 214/225): [kind code, operand kinds, result kind]. The
// node carries the call node after its kind.
const COMPOSITE_OPERATORS = new Map([
  [215, [164, ['vector', 'vector'], 'vector']],
  [216, [165, ['vector', 'vector'], 'vector']],
  [212, [166, ['vector', 'float'], 'vector']],
  [213, [167, ['float', 'vector'], 'vector']],
  [214, [168, ['vector', 'float'], 'vector']],
  [211, [169, ['vector'], 'vector']],
  [296, [170, ['vector', 'vector'], 'vector']],
  [226, [171, ['vector'], 'vector']],
  [300, [172, ['vector', 'vector'], 'vector']],
  [276, [173, ['vector', 'rotator'], 'vector']],
  [316, [179, ['rotator', 'rotator'], 'rotator']],
  [317, [180, ['rotator', 'rotator'], 'rotator']],
  [287, [181, ['rotator', 'float'], 'rotator']],
  [288, [182, ['float', 'rotator'], 'rotator']],
  [225, [185, ['vector'], 'float']],
  [219, [186, ['vector', 'vector'], 'float']],
  [217, [187, ['vector', 'vector'], 'bool']],
  [218, [188, ['vector', 'vector'], 'bool']],
  [142, [189, ['rotator', 'rotator'], 'bool']],
  [203, [190, ['rotator', 'rotator'], 'bool']],
  [254, [191, ['name', 'name'], 'bool']],
  [255, [192, ['name', 'name'], 'bool']],
]);
// native() claims 287/288 only for a number operand (`typeof b === 'number'`).
const NUMBER_CLAIMS = new Set([287, 288]);
// The out vector and rotator natives as statements: [op, target kind, value kind].
const VCOMPOUNDS = new Map([[221, [1, 'vector', 'float']], [222, [2, 'vector', 'float']], [223, [3, 'vector', 'vector']],
  [224, [4, 'vector', 'vector']], [297, [5, 'vector', 'vector']], [318, [6, 'rotator', 'rotator']], [319, [7, 'rotator', 'rotator']]]);
const primitives = new Set(primitiveNativeIndices);
for (const index of [...OPERATORS.keys(), ...INCREMENTS.keys(), ...COMPOUNDS.keys(), ...COMPOSITE_OPERATORS.keys(), ...VCOMPOUNDS.keys()])
  if (!primitives.has(index)) throw new Error(`Lowered operator ${index} is not a VM primitive`);
const STRUCT_KEYS = {vector: 'core.object.vector', rotator: 'core.object.rotator'};
const COMPONENTS = {vector: ['X', 'Y', 'Z'], rotator: ['Pitch', 'Yaw', 'Roll']};
// Float words that can be JavaScript's undefined in Rust (UNDEF_F64): a
// JavaScript leaf, or FMin/FMax/a context handing one back.
const MAYBE_UNDEFINED = new Set([K.JS.float, 132, 133, K.CONTEXT]);

// R3-c perception natives: [kind code, result kind, argument kinds].
const PERCEPTION = new Map([
  [2105, [200, 'bool', ['object', 'bool']]],
  [2107, [201, 'byte', ['object']]],
  [705, [202, 'float', ['object', 'float', 'bool', 'bool', 'bool', 'bool']]],
]);
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

// Names as small integers from 1, shared by every runtime (R2b-6): the id of
// a name value's folded spelling `String(v || 'None').toLowerCase()`, which is
// what 254/255 and IsA compare; `none` is id 1. Class rows list their chain's
// `String(name).toLowerCase()` ids (script-vm-rust.mjs). The table lives in
// script-name-ids.mjs, which the object image uses too (R3-c).
export {foldedNameId, nameId, nameSpelling} from './script-name-ids.mjs';

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
  // Imports the lowered code is expected to make (JavaScript leaves, fields
  // whose key a binding uses): R2b-6 kinds are lowered only when their
  // operands need at most one, the cost of leaving the node to JavaScript.
  let imports = 0;
  const boundKey = key => Boolean(runtime.boundKeys?.has(key));
  // The runtime's own read services copy every value through its codec.
  const rs = runtime.services;
  const runtimeReads = services.fieldValueOf === rs.fieldValueOf && services.localValueOf === rs.localValueOf &&
    services.structValue === rs.structValue && services.arrayReference === rs.arrayReference &&
    services.defaultReference === rs.defaultReference;
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
    if (boundKey(field.key)) imports++;
    return {...cell, key: fieldKeyId(field.key), name: field.key};
  };
  // A local's or instance field's vector or rotator cell (R2b-6).
  const localVectorCell = n => {
    const field = operand(n);
    return field?.metadata ? vectorCell(layout.cells.get(field.key)) : null;
  };
  const fieldVectorCell = n => {
    const field = operand(n);
    if (!field?.metadata) return null;
    const registered = fieldImageCell(field.key);
    if (!registered) { missingField = true; return null; }
    const cell = vectorCell(registered);
    if (!cell) return null;
    if (boundKey(field.key)) imports++;
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
        // VectorConst / RotationConst: the closure hands out a copy of the
        // decoded float32 / int32 numbers.
        case 0x23: {
          const v = n.value;
          if (!Array.isArray(v) || v.length !== 3 || !v.every(c => typeof c === 'number' && (Number.isNaN(c) || Object.is(Math.fround(c), c))))
            return null;
          return typed('vector', [K.LIT_VECTOR, ...v.map(floatBits)]);
        }
        case 0x22: {
          const v = n.value;
          if (!Array.isArray(v) || v.length !== 3 || !v.every(c => Object.is(c | 0, c))) return null;
          return typed('rotator', [K.LIT_ROTATOR, ...v.map(c => c >>> 0)]);
        }
        default: return null;
      }
    }
    // NameConst: the closure's value is the name's spelling.
    if (op === 0x21) return typed('name', [K.LIT_NAME, nameId(n.name)]);
    if (op === 0x20 && !n.objectIndex) return typed('object', [K.LIT_NONE]);
    if (op === 0x17) return typed('object', [K.SELF]);
    if (op === 0x00) {
      const cell = localCell(n);
      if (!cell) {
        const vector = localVectorCell(n);
        return vector && typed(vector.kind, [K.LOCAL[vector.kind], vector.offset, nodeId(n)]);
      }
      return typed(cell.kind, cell.kind === 'bool' ? [K.LOCAL.bool, cell.offset, cell.mask] : [K.LOCAL[cell.kind], cell.offset]);
    }
    if (op === 0x01) {
      const field = operand(n), registered = field?.metadata ? fieldImageCell(field.key) : null;
      if (vectorCell(registered)) {
        const vector = fieldVectorCell(n);
        fieldNodes.add(nodeId(n));
        return typed(vector.kind, [K.FIELD[vector.kind], vector.offset, nodeId(n), vector.key]);
      }
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
    // EX_StructMember over a vector or rotator value that is not a variable
    // (R2b-6): structValue's member of the value, with the member's receiver.
    if (op === 0x36 && isNode(n.value)) return structMember(n);
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

  // structValue(value.ev(fr, r), member) over a lowered vector or rotator
  // value: the component, as copyFloat / copyInt read it.
  function structMember(n) {
    const rs = runtime.services;
    if (services.structValue !== rs.structValue || services.structReference !== rs.structReference) return null;
    const member = operand(n);
    if (!member?.metadata || typeof member.key !== 'string') return null;
    const struct = member.key.slice(0, member.key.lastIndexOf('.'));
    const kind = struct === STRUCT_KEYS.vector ? 'vector' : struct === STRUCT_KEYS.rotator ? 'rotator' : null;
    const index = kind ? COMPONENTS[kind].indexOf(member.name) : -1;
    if (index < 0) return null;
    const value = natural(n.value);
    if (value?.kind !== kind) return null;
    return typed(kind === 'vector' ? 'float' : 'int', [kind === 'vector' ? K.VECTOR_MEMBER : K.ROTATOR_MEMBER, nodeId(n), index, ...value.words]);
  }

  // Whether a JavaScript node in a vector or rotator position yields a codec
  // copy of that type (an Array of three float32 numbers or int32 words):
  // a variable, a default, a fixed-array element or struct member of that
  // type, or a context of one. Any other node's value is left unconverted
  // by the closures, so its consumer stays in JavaScript.
  function codecCopy(n, kind) {
    if (!isNode(n) || !runtimeReads) return false;
    if (n.op === 0x19 || n.op === 0x12) return n.valueSize === 12 && codecCopy(n.value, kind);
    if (n.op !== 0x00 && n.op !== 0x01 && n.op !== 0x02 && n.op !== 0x36 && n.op !== 0x1a) return false;
    const field = operand(n.op === 0x1a ? n.right : n);
    const m = field?.metadata;
    if (!m || m.type !== 'struct' || String(m.structKey ?? '').toLowerCase() !== STRUCT_KEYS[kind]) return false;
    return n.op === 0x1a ? (m.arrayDim ?? 1) > 1 : (m.arrayDim ?? 1) === 1;
  }

  /** Code for `n` in a vector, rotator or name position, or null when its
   * consumer must stay in JavaScript. */
  function valueExpr(n, want) {
    const lowered = natural(n);
    if (lowered && lowered.kind === want) return lowered.words;
    if (isNode(n) && n.op === 0x19 && WIDTH[want] === n.valueSize) {
      const mark = imports, value = valueExpr(n.value, want);
      if (value) return context(n, want, value, false).words;
      imports = mark;
    }
    // A name's closure value is any JavaScript value: the name id folds it.
    if (want !== 'name' && !codecCopy(n, want)) return null;
    imports++;
    return [K.JS[want], nodeId(n)];
  }
  /** Code for an operand of an R2b-6 operator. */
  const operandExpr = (n, want) => want === 'vector' || want === 'rotator' || want === 'name' ? valueExpr(n, want) : expr(n, want);

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
    const composite = COMPOSITE_OPERATORS.get(index);
    if (composite) return compositeOperator(n, composite);
    if (index === 303) return isA(n);
    if (PERCEPTION.has(index)) return perception(n);
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

  // A vector, rotator or name operator (R2b-6), when its operands need at
  // most one import.
  function compositeOperator(n, [code, kinds, result]) {
    const args = n.args;
    if (args.length !== kinds.length) return null;
    const mark = imports, words = [code, nodeId(n)];
    for (let i = 0; i < kinds.length; i++) {
      const operandWords = operandExpr(args[i], kinds[i]);
      if (!operandWords || kinds[i] === 'float' && NUMBER_CLAIMS.has(n.index) && MAYBE_UNDEFINED.has(operandWords[0])) {
        imports = mark;
        return null;
      }
      words.push(...operandWords);
    }
    if (imports - mark > 1) {
      imports = mark;
      return null;
    }
    return typed(result, words);
  }

  // IsA (invokeNative 303) with a name literal: nothing to evaluate, so the
  // JavaScript path may evaluate the whole node.
  function isA(n) {
    const args = n.args;
    if (args.length !== 1 || !isNode(args[0]) || args[0].op !== 0x21) return null;
    if (services.invokeNative !== runtime.services.invokeNative || runtime.boundaryNatives?.has(303)) return null;
    return typed('bool', [K.IS_A, nodeId(n), nameId(args[0].name)]);
  }

  // R3-c: IsValidEnemy (2105), GetPawnAllianceType (2107) and AICanSee (705)
  // in Rust (percep.rs), when the runtime's own invokeNative would run their
  // bodies (not a boundary native, and no host has replaced the runtime's
  // invokeNative, as validators that observe native calls do) and the field
  // table has every field they read. Each argument is a presence word (0 for
  // EX_Nothing, whose value is undefined) and its code, evaluated in order
  // before the body, as evaluateArgument is.
  function perception(n) {
    const [code, result, kinds] = PERCEPTION.get(n.index), args = n.args;
    if (services.invokeNative !== runtime.services.invokeNative || Object.hasOwn(runtime, 'invokeNative') ||
      runtime.boundaryNatives?.has(n.index)) return null;
    if (!Array.isArray(args) || args.length < 1 || args.length > kinds.length || !runtime.scriptVm?.perceptionReady(n.index))
      return null;
    const words = [code, nodeId(n), args.length];
    for (let i = 0; i < args.length; i++) {
      if (isNode(args[i]) && args[i].op === 0x0b) { words.push(0); continue; }
      const value = expr(args[i], kinds[i]);
      // IsValidEnemy reads an undefined optional as true, which a JavaScript
      // leaf's bool conversion would lose.
      if (n.index === 2105 && i === 1 && value[0] === K.JS.bool) return null;
      words.push(1, ...value);
    }
    return typed(result, words);
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
    imports++;
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

  // A vector or rotator store (R2b-6) to a local or a field of SELF, when
  // it needs at most one import (the value's, or the field's JS path).
  function vectorAssignment(n) {
    const target = n.left;
    if (!isNode(target) || (target.op !== 0x00 && target.op !== 0x01)) return null;
    const mark = imports;
    const cell = target.op === 0x00 ? localVectorCell(target) : fieldVectorCell(target);
    if (!cell) return null;
    const value = valueExpr(n.right, cell.kind);
    if (!value || imports - mark > 1) {
      imports = mark;
      return null;
    }
    if (target.op === 0x00) return [K.SET_LOCAL[cell.kind], cell.offset, ...value];
    fieldNodes.add(nodeId(n));
    return [K.SET_FIELD[cell.kind], cell.offset, nodeId(n), cell.key, value.length, ...value];
  }

  function assignment(n, bool) {
    let target = n.left;
    if (bool && isNode(target) && target.op === 0x2d && isNode(target.value) &&
      (target.value.op === 0x00 || target.value.op === 0x01)) target = target.value;
    else if (bool) return null;
    if (!bool && isNode(target) && (target.op === 0x00 ? localVectorCell(target)
      : target.op === 0x01 && vectorCell(fieldImageCell(operand(target)?.key)))) return vectorAssignment(n);
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

  // An out vector or rotator native as a statement (R2b-6): V is evaluated
  // before X is read, as for compound().
  function vectorCompound(n) {
    const [op, targetKind, valueKind] = VCOMPOUNDS.get(n.index);
    const target = n.args[0];
    if (n.args.length !== 2 || !isNode(target) || (target.op !== 0x00 && target.op !== 0x01)) return null;
    const mark = imports;
    const cell = target.op === 0x00 ? localVectorCell(target) : fieldVectorCell(target);
    const value = cell?.kind === targetKind ? operandExpr(n.args[1], valueKind) : null;
    if (!value || imports - mark > 1) {
      imports = mark;
      return null;
    }
    if (target.op === 0x00) return [K.VCOMPOUND_LOCAL, op, cell.offset, nodeId(n), ...value];
    fieldNodes.add(nodeId(n));
    return [K.VCOMPOUND_FIELD, op, cell.offset, nodeId(n), cell.key, value.length, ...value];
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
        // In a body with a foreach, the host's iterator count is checked
        // first (stepCompiled's iterator unwind error).
        const kind = hasIterator ? K.S_RETURN_ITER : K.S_RETURN;
        if (isNode(n.value) && n.value.op === 0x0b) return [kind, 0];
        const value = natural(n.value);
        if (!value || !value.canonical || !RETURN_KIND[value.kind]) return null;
        returnKinds.add(RETURN_KIND[value.kind]);
        return [kind, RETURN_KIND[value.kind], ...value.words];
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
        if (n.op === 'native' && VCOMPOUNDS.has(n.index)) {
          const words = vectorCompound(n);
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
      if ((code?.[0] === K.S_RETURN || code?.[0] === K.S_RETURN_ITER) && code[1] && returnKinds.size > 1) code = null;
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
