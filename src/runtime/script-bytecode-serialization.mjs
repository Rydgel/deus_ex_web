/**
 * GC-mode reference traversal for one decoded UE1 script expression.
 *
 * Core.dll's UStruct::SerializeExpr only gives the collector meaningful work
 * for UObject and FName operands.  Raw script bytes go through the collector
 * archive's no-op Serialize slot; this adapter therefore follows the native
 * expanded-offset cursor and emits only the virtual object/name references.
 */

const OBJECT_OPERAND_SLOTS = Object.freeze({
  property: 'property',
  castClass: 'cast-class',
  structProperty: 'struct-property',
  structMember: 'struct-member',
  function: 'function',
  object: 'object',
});

const NAME_OPERAND_SLOTS = Object.freeze({
  label: 'label',
  function: 'function-name',
  constant: 'name',
});

/** Collector FArchive words observed in Core's constructor at 0x1015eac0. */
export const SCRIPT_BYTECODE_GC_ARCHIVE_STATE = Object.freeze({
  ar04: 0x44,
  ar08: 0x44c,
  ar0c: 0,
  ar10: 0,
  ar14: 0,
  ar18: 0,
  ar1c: 1,
  ar20: 1,
  ar24: 1,
});

export class UnsupportedScriptBytecodeSerializationError extends Error {
  constructor(message, { offset = null, opcode = null, operation = null } = {}) {
    super(message);
    this.name = 'UnsupportedScriptBytecodeSerializationError';
    this.code = 'UNSUPPORTED_SCRIPT_BYTECODE_SERIALIZATION';
    this.offset = offset;
    this.opcode = opcode;
    this.operation = operation;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptBytecodeSerializationError(message, details);
}

function integer(value, label, { minimum = null } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function opcodeOf(node) {
  if (node?.op === 'native' || node?.op === 'literal') return node.token;
  return node?.op;
}

function nodeLabel(node) {
  const opcode = opcodeOf(node);
  return Number.isInteger(opcode) ? `0x${opcode.toString(16)}` : String(opcode);
}

function validateNode(node, size) {
  if (!node || typeof node !== 'object') throw new TypeError('Expected a decoded script expression node');
  const offset = integer(node.offset, 'decoded expression offset', { minimum: 0 });
  const end = integer(node.end, 'decoded expression end', { minimum: 0 });
  if (end <= offset || end > size) {
    fail(`Decoded expression ${nodeLabel(node)} has invalid expanded bounds ${offset}..${end}`, {
      offset, opcode: opcodeOf(node), operation: 'serializeGcScriptExpression',
    });
  }
  return { offset, end };
}

function mutableOperand(value, label) {
  if (!value || typeof value.get !== 'function' || typeof value.set !== 'function') {
    throw new TypeError(`${label} callback did not return a mutable lvalue`);
  }
  return value;
}

function checkCollectorArchive(archive) {
  const supplied = archive.archiveState ?? archive;
  for (const [key, expected] of Object.entries(SCRIPT_BYTECODE_GC_ARCHIVE_STATE)) {
    if (supplied?.[key] === undefined) continue;
    const actual = Number(supplied[key]);
    if (!Number.isFinite(actual) || actual !== expected) {
      fail(`SerializeExpr GC traversal requires FArchive ${key} == ${expected}`, {
        operation: 'serializeGcScriptExpression',
      });
    }
  }
}

function emitObject(archive, reference, descriptor) {
  if (typeof archive.objectReference === 'function') {
    archive.objectReference(reference, descriptor);
    return;
  }
  archive.serializeObject(reference, descriptor);
}

function emitName(archive, reference, descriptor) {
  if (typeof archive.nameReference === 'function') {
    archive.nameReference(reference, descriptor);
    return;
  }
  archive.serializeName(reference, descriptor);
}

function emitObjectOperand(node, slot, state, kind = 'object') {
  const context = {
    kind: `script-${kind}-operand`,
    key: `script.${kind}.${slot}.${node.offset}`,
    slot,
    offset: node.offset,
    end: node.end,
    opcode: opcodeOf(node),
    node,
  };
  if (typeof state.objectCallback !== 'function') {
    throw new TypeError(`Missing objectOperand callback for ${context.key}`);
  }
  const reference = mutableOperand(state.objectCallback(node, slot), context.key);
  emitObject(state.archive, reference, context);
}

function emitNameOperand(node, slot, state, kind = 'name', parent = null) {
  const context = {
    kind: `script-${kind}-operand`,
    key: `script.${kind}.${slot}.${node.offset ?? parent?.offset ?? 0}`,
    slot,
    offset: node.offset ?? parent?.offset ?? 0,
    end: node.end ?? parent?.end ?? null,
    opcode: opcodeOf(parent ?? node),
    node,
    parent,
  };
  if (typeof state.nameCallback !== 'function') {
    throw new TypeError(`Missing nameOperand callback for ${context.key}`);
  }
  const reference = mutableOperand(state.nameCallback(node, slot), context.key);
  emitName(state.archive, reference, context);
}

function expressionAt(state, offset, size) {
  const node = state.decoded.expressions.get(offset);
  if (!node) {
    fail(`No decoded expression starts at expanded offset ${offset}`, {
      offset, operation: 'serializeGcScriptExpression',
    });
  }
  validateNode(node, size);
  return node;
}

function fixedNext(node, size, width) {
  const next = node.offset + width;
  if (next > size) {
    fail(`SerializeExpr operand at ${node.offset} exceeds script size`, {
      offset: node.offset, opcode: opcodeOf(node), operation: 'serializeGcScriptExpression',
    });
  }
  return next;
}

function visitArguments(state, cursor, size, active) {
  for (let count = 0; count <= size; count++) {
    const node = expressionAt(state, cursor, size);
    if (opcodeOf(node) === 0x16) return visitAt(state, cursor, size, active);
    const next = visitAt(state, cursor, size, active);
    if (next <= cursor) {
      fail(`SerializeExpr argument made no expanded progress at ${cursor}`, {
        offset: cursor, opcode: opcodeOf(node), operation: 'serializeGcScriptExpression',
      });
    }
    cursor = next;
  }
  fail(`SerializeExpr argument list did not reach EndParm before script bound`, {
    offset: cursor, operation: 'serializeGcScriptExpression',
  });
}

function visitAt(state, cursor, size, active) {
  const node = expressionAt(state, cursor, size);
  const opcode = opcodeOf(node);
  if (active.has(cursor)) {
    fail(`Cyclic decoded script expression at expanded offset ${cursor}`, {
      offset: cursor, opcode, operation: 'serializeGcScriptExpression',
    });
  }
  active.add(cursor);
  try {
    if (node.op === 'native') {
      if (!Number.isInteger(node.token) || node.token < 0x60) {
        fail(`Unsupported decoded native token ${nodeLabel(node)}`, {
          offset: cursor, opcode, operation: 'serializeGcScriptExpression',
        });
      }
      // 0x60..0x6f carry one expanded native-index byte; >=0x70 do not.
      const firstArgument = cursor + (node.token < 0x70 ? 2 : 1);
      return visitArguments(state, firstArgument, size, active);
    }
    if (node.op === 'literal') return node.end;
    if (!Number.isInteger(opcode)) {
      fail(`Unsupported decoded expression ${nodeLabel(node)}`, {
        offset: cursor, opcode, operation: 'serializeGcScriptExpression',
      });
    }

    // Conversions 0x39..0x5f call SerializeExpr recursively on their value.
    if (opcode >= 0x39 && opcode < 0x60) return visitAt(state, cursor + 1, size, active);

    switch (opcode) {
      case 0x00: case 0x01: case 0x02: case 0x29:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.property, state);
        return fixedNext(node, size, 5);
      case 0x13:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.castClass, state);
        return visitAt(state, cursor + 5, size, active);
      case 0x20:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.object, state);
        return fixedNext(node, size, 5);
      case 0x1c:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.function, state);
        return visitArguments(state, cursor + 5, size, active);
      case 0x2e:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.castClass, state);
        return visitAt(state, cursor + 5, size, active);
      case 0x32: case 0x33:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.structProperty, state);
        {
          const afterLeft = visitAt(state, cursor + 5, size, active);
          return visitAt(state, afterLeft, size, active);
        }
      case 0x36:
        emitObjectOperand(node, OBJECT_OPERAND_SLOTS.structMember, state);
        return visitAt(state, cursor + 5, size, active);
      case 0x0c:
        if ((cursor + 1) % 4 !== 0) {
          fail(`LabelTable at expanded offset ${cursor} is not four-byte aligned`, {
            offset: cursor, opcode, operation: 'serializeGcScriptExpression',
          });
        }
        if (!Array.isArray(node.labels)) {
          fail('Decoded LabelTable has no label entries', {
            offset: cursor, opcode, operation: 'serializeGcScriptExpression',
          });
        }
        for (const label of node.labels) {
          emitNameOperand(label, NAME_OPERAND_SLOTS.label, state, 'label-table', node);
        }
        return node.end;
      case 0x1b: case 0x38:
        emitNameOperand(node, NAME_OPERAND_SLOTS.function, state);
        return visitArguments(state, cursor + 5, size, active);
      case 0x21:
        emitNameOperand(node, NAME_OPERAND_SLOTS.constant, state);
        return fixedNext(node, size, 5);

      // These handlers recurse but carry no object/name operands themselves.
      case 0x04: case 0x0d: case 0x0e:
        return visitAt(state, cursor + 1, size, active);
      case 0x05:
        return visitAt(state, cursor + 2, size, active);
      case 0x07: case 0x09: case 0x18:
        return visitAt(state, cursor + 3, size, active);
      case 0x0a:
        return node.target === 0xffff ? fixedNext(node, size, 3) : visitAt(state, cursor + 3, size, active);
      case 0x0f: case 0x10: case 0x14: case 0x1a: {
        const afterLeft = visitAt(state, cursor + 1, size, active);
        return visitAt(state, afterLeft, size, active);
      }
      case 0x11: {
        let next = cursor + 1;
        for (let index = 0; index < 4; index++) next = visitAt(state, next, size, active);
        return next;
      }
      case 0x12: case 0x19: {
        const afterContext = visitAt(state, cursor + 1, size, active);
        return visitAt(state, afterContext + 3, size, active);
      }
      case 0x2f: {
        const afterValue = visitAt(state, cursor + 1, size, active);
        return fixedNext({ ...node, offset: afterValue }, size, 2);
      }

      // The native jump-table entry for BoolVariable is the common epilogue:
      // it advances past only the token.  The decoder retains its following
      // variable expression for execution; the cursor loop visits that child
      // at its own expanded offset on the next native call.
      case 0x2d:
        return fixedNext(node, size, 1);

      // EndParm, Stop, Nothing, Self, integer/boolean zero/one, NoObject and
      // literal nodes have no reference operands.  Decoder-produced literal
      // nodes are handled above; these numeric cases cover control tokens.
      case 0x06: case 0x08: case 0x0b: case 0x16: case 0x17:
      case 0x25: case 0x26: case 0x27: case 0x28: case 0x2a:
      case 0x30: case 0x31:
        return fixedNext(node, size, 1);
      default:
        fail(`SerializeExpr reference traversal does not support decoded opcode ${nodeLabel(node)}`, {
          offset: cursor, opcode, operation: 'serializeGcScriptExpression',
        });
    }
  } finally {
    active.delete(cursor);
  }
}

/**
 * Emit the GC archive references in one decoded expression and return its
 * native expanded offset.  `objectOperand(node, slot)` and
 * `nameOperand(node, slot)` must return live `{get,set}` lvalues; resolved
 * snapshots are rejected because the collector may rewrite a reference.
 *
 * The callback is intentionally one expression at a time.  A UStruct caller
 * can retain the returned offset and invoke this function until ScriptSize,
 * exactly as the native `UStruct::Serialize` loop invokes virtual slot +0x7c.
 */
export function serializeGcScriptExpression(script, decoded, offset, archive, {
  objectOperand,
  nameOperand,
} = {}) {
  if (!script || typeof script !== 'object') throw new TypeError('Expected a decoded script record');
  if (!decoded || typeof decoded !== 'object' || !(decoded.expressions instanceof Map)) {
    throw new TypeError('Expected decodeScript output with an expressions Map');
  }
  if (!archive || (typeof archive.objectReference !== 'function' &&
      typeof archive.serializeObject !== 'function')) {
    throw new TypeError('SerializeExpr GC traversal requires archive.objectReference or archive.serializeObject');
  }
  if (!archive || (typeof archive.nameReference !== 'function' &&
      typeof archive.serializeName !== 'function')) {
    throw new TypeError('SerializeExpr GC traversal requires archive.nameReference or archive.serializeName');
  }
  checkCollectorArchive(archive);
  const version = script.pkg?.version;
  if (version !== undefined && ![68, 69].includes(version)) {
    fail(`Unsupported executable script version ${version}`, {
      operation: 'serializeGcScriptExpression',
    });
  }
  const size = integer(decoded.size ?? script.size ?? script.scriptSize, 'expanded script size', { minimum: 0 });
  const before = integer(offset, 'expanded script offset', { minimum: 0 });
  if (before >= size) throw new RangeError(`SerializeExpr offset ${before} is outside script size ${size}`);
  const state = { decoded, archive, objectCallback: objectOperand, nameCallback: nameOperand };
  const next = visitAt(state, before, size, new Set());
  if (!Number.isInteger(next) || next <= before || next > size) {
    fail(`SerializeExpr produced invalid expanded progress ${before} -> ${String(next)}`, {
      offset: before, opcode: opcodeOf(decoded.expressions.get(before)), operation: 'serializeGcScriptExpression',
    });
  }
  return next;
}

export { OBJECT_OPERAND_SLOTS, NAME_OPERAND_SLOTS };
