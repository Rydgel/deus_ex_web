/**
 * The collector form of UObject::Serialize.
 *
 * This is an adapter around the host's native object/name registry.  The
 * adapter owns the order and branch gates recovered from Core.dll; it does
 * not invent a second mark policy.  In particular, `archive` is expected to
 * expose the mutable-reference operations supplied by script-gc-bridge.mjs
 * (or the native archive names `serializeObject` and `serializeName`).
 */

import {serializeScriptReferences} from './script-reference-serialization.mjs';

/** FArchive words written by the collector constructor at Core 0x1015eac0. */
export const GC_ARCHIVE_STATE = Object.freeze({
  ar0c: 0,
  ar10: 0,
  ar14: 0,
  ar18: 0,
  ar1c: 1,
  ar20: 1,
  ar24: 1,
});

/** Raw object bits tested or written by UObject::Serialize. */
export const OBJECT_SERIALIZATION_FLAGS = Object.freeze({
  StateFrame: 0x02000000,
  SerializeRoute: 0x40000000,
});

/** The Core hard-coded class pointer for the UClass metaclass. */
export const CORE_CLASS_METACLASS_ADDRESS = 0x101f1c18;

export class UnsupportedScriptObjectSerializationError extends Error {
  constructor(message, {operation = null, slot = null} = {}) {
    super(message);
    this.name = 'UnsupportedScriptObjectSerializationError';
    this.code = 'UNSUPPORTED_SCRIPT_OBJECT_SERIALIZATION';
    this.operation = operation;
    this.slot = slot;
  }
}

function fail(message, details = {}) {
  throw new UnsupportedScriptObjectSerializationError(message, details);
}

function finiteInteger(value, label, {minimum = null} = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || (minimum !== null && number < minimum)) {
    throw new TypeError(`Expected integer ${label}, got ${String(value)}`);
  }
  return number;
}

function word(source, key, fallback = 0) {
  const value = source?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function archiveStateOf(archive, options) {
  const supplied = options.archiveState ?? archive?.archiveState ?? null;
  const state = {
    ar0c: word(supplied, 'ar0c'),
    ar10: word(supplied, 'ar10'),
    ar14: word(supplied, 'ar14'),
    ar18: word(supplied, 'ar18'),
    ar1c: word(supplied, 'ar1c', 1),
    ar20: word(supplied, 'ar20', 1),
    ar24: word(supplied, 'ar24', 1),
  };
  // This module is intentionally the GC path.  The other FArchive modes
  // have different identity/state-frame gates and must use another helper.
  for (const key of ['ar0c', 'ar10', 'ar14', 'ar18']) {
    if (state[key] !== GC_ARCHIVE_STATE[key]) {
      fail(`UObject GC Serialize requires FArchive ${key} == ${GC_ARCHIVE_STATE[key]}`, {
        operation: 'serializeGcObject', slot: key,
      });
    }
  }
  for (const key of ['ar1c', 'ar20', 'ar24']) {
    if (state[key] !== GC_ARCHIVE_STATE[key]) {
      fail(`UObject GC Serialize requires FArchive ${key} == ${GC_ARCHIVE_STATE[key]}`, {
        operation: 'serializeGcObject', slot: key,
      });
    }
  }
  return state;
}

function requireArchive(archive) {
  if (!archive || (typeof archive.objectReference !== 'function' &&
      typeof archive.serializeObject !== 'function')) {
    throw new TypeError(
      'GC UObject Serialize requires archive.objectReference(reference) or archive.serializeObject(reference)',
    );
  }
  if (typeof archive.nameReference !== 'function' &&
      typeof archive.serializeName !== 'function') {
    throw new TypeError(
      'GC UObject Serialize requires archive.nameReference(reference) or archive.serializeName(reference)',
    );
  }
}

function holder(value, descriptor, fallbackObject = null, fallbackKeys = []) {
  const resolved = typeof value === 'function' ? value(descriptor) : value;
  if (resolved && typeof resolved.get === 'function' && typeof resolved.set === 'function') {
    return resolved;
  }
  if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
    return {
      reference: true,
      key: descriptor.key,
      get: () => resolved.value,
      set: next => { resolved.value = next; return next; },
    };
  }
  if (fallbackObject) {
    const key = fallbackKeys.find(name => Object.hasOwn(fallbackObject, name));
    if (key) {
      return {
        reference: true,
        key: descriptor.key,
        get: () => fallbackObject[key],
        set: next => { fallbackObject[key] = next; return next; },
      };
    }
  }
  throw new TypeError(`Missing mutable UObject Serialize slot ${descriptor.key}`);
}

function emitObject(archive, reference, context) {
  if (typeof archive.objectReference === 'function') {
    archive.objectReference(reference, context);
  } else {
    archive.serializeObject(reference, context);
  }
}

function emitName(archive, reference, context) {
  if (typeof archive.nameReference === 'function') {
    archive.nameReference(reference, context);
  } else {
    archive.serializeName(reference, context);
  }
}

function emitPreload(archive, callback, value, context, calls, {includeNull = false} = {}) {
  const preload = callback ?? archive.preloadObject;
  // The collector vtable installed at Core 0x1015eb26 (0x1017a2f0) has its
  // +0x10 Preload slot at 0x101011cc, which jumps to 0x101068e0
  // (`retl $0x4`).  A missing host hook therefore preserves the native no-op.
  if (typeof preload !== 'function' || (!includeNull && (value === null || value === undefined))) return false;
  preload(value, context);
  calls.push({value, context});
  return true;
}

function emitRaw(archive, callback, reference, size, context, calls) {
  const serialize = callback ?? archive.serializeRaw;
  if (typeof serialize === 'function') {
    serialize(reference, size, context);
    calls.push({reference, size, context, skipped: false});
    return false;
  }
  // FArchive::Serialize at 0x10106760 is a no-op.  The collector inherits
  // that slot, so omitting an adapter preserves the native GC side effect.
  calls.push({reference, size, context, skipped: true});
  return true;
}

function emitCountBytes(archive, callback, size, context) {
  const count = callback ?? archive.countBytes;
  if (typeof count !== 'function') {
    // FArchive::CountBytes at 0x10106900 is a no-op in this binary.
    return {called: false, skipped: true};
  }
  // UObject::Serialize pushes the same size twice at 0x101504ac.
  const value = count(size, size, context);
  return {called: true, skipped: false, value};
}

function propertySize(object, archive, callback) {
  const size = callback ?? archive.getPropertiesSize;
  if (typeof size === 'function') return finiteInteger(size(object), 'serialized property size', {minimum: 0});
  if (Number.isInteger(object?.propertiesSize) && object.propertiesSize >= 0) return object.propertiesSize;
  fail('GC UObject Serialize needs the class +0x64 serialized property-size adapter', {
    operation: 'serializeGcObject', slot: 'class.propertiesSize',
  });
}

function classIsCoreClassObject(object, classValue, options) {
  if (typeof options.isCoreClassObject === 'function') {
    return options.isCoreClassObject(classValue, object) === true;
  }
  if (options.isCoreClassObject !== undefined) return options.isCoreClassObject === true;
  if (object?.isCoreClassObject === true) return true;
  // This is only a raw-address convenience.  A linker must prefer the
  // callback above when it represents class identities as JS records.
  return object?.classAddress === CORE_CLASS_METACLASS_ADDRESS ||
    classValue === CORE_CLASS_METACLASS_ADDRESS ||
    classValue?.address === CORE_CLASS_METACLASS_ADDRESS;
}

function resolveNodeRange(node, options, context) {
  const range = typeof options.nodeCodeRange === 'function'
    ? options.nodeCodeRange(node, context)
    : options.nodeCodeRange;
  if (!range || typeof range !== 'object') {
    fail('State-frame Node has code but no explicit Node +0x44/+0x48 range adapter', {
      operation: 'serializeGcObject', slot: 'stateFrame.codeRange',
    });
  }
  const start = finiteInteger(range.start, 'state Node code start');
  const size = finiteInteger(range.size, 'state Node code span', {minimum: 0});
  return {start, size};
}

function frameDescriptor(frame, object, slot) {
  return {
    kind: 'state-frame', key: `stateFrame.${slot}`, slot, frame, object,
  };
}

function readFrameSlots(frame, object, frameLayout) {
  const layout = typeof frameLayout === 'function' ? frameLayout(frame, object) : (frameLayout ?? {});
  if (!layout || typeof layout !== 'object') throw new TypeError('Invalid state-frame slot layout');
  const fallback = {
    node: ['node', 'Node'],
    state: ['state', 'State'],
    probeMask: ['probeMask'],
    latentAction: ['latentAction', 'latent'],
    codePointer: ['codePointer'],
  };
  const slots = {};
  for (const slot of Object.keys(fallback)) {
    const descriptor = frameDescriptor(frame, object, slot);
    const spec = layout[slot];
    if (spec !== undefined) {
      slots[slot] = holder(spec, descriptor);
    } else {
      slots[slot] = holder(undefined, descriptor, frame, fallback[slot]);
    }
  }
  return slots;
}

function readFlagsSlot(object, layout, options) {
  if (typeof options.readFlags === 'function' && typeof options.writeFlags === 'function') {
    return {
      get: () => Number(options.readFlags(object)) >>> 0,
      set: next => { options.writeFlags(object, Number(next) >>> 0); return next; },
    };
  }
  const explicit = layout.flags ?? layout.objectFlags;
  if (explicit !== undefined) return holder(explicit, {kind: 'uobject-header', key: 'header.objectFlags', slot: 'ObjectFlags'});
  return holder(undefined, {kind: 'uobject-header', key: 'header.objectFlags', slot: 'ObjectFlags'}, object, ['flags', 'objectFlags', 'ObjectFlags']);
}

function createStateFrame(object, classValue, options, frameSlot) {
  if (typeof options.createStateFrame !== 'function') {
    fail('UObject state-frame flag is set but no FStateFrame allocator was supplied', {
      operation: 'serializeGcObject', slot: 'stateFrame',
    });
  }
  const frame = options.createStateFrame(object, classValue, {
    kind: 'state-frame', object, classValue,
  });
  if (frame === null || frame === undefined) {
    fail('FStateFrame allocator returned null for a flagged UObject', {
      operation: 'serializeGcObject', slot: 'stateFrame',
    });
  }
  frameSlot.set(frame);
  return frame;
}

function serializeStateFrame({object, classValue, archive, frameSlot, frameLayout, options, preloadCalls, rawCalls}) {
  const frame = frameSlot.get();
  const result = {
    used: true,
    created: false,
    references: 0,
    raw: rawCalls,
    codeOffset: null,
    codeOffsetBefore: null,
    codeOffsetAfter: null,
    warnings: [],
  };
  if (frame === null || frame === undefined) {
    result.created = true;
    result.frame = createStateFrame(object, classValue, options, frameSlot);
  } else {
    result.frame = frame;
  }

  const slots = readFrameSlots(result.frame, object, frameLayout);
  if (!slots.node || !slots.state || !slots.probeMask || !slots.latentAction || !slots.codePointer) {
    fail('FStateFrame GC serialization needs Node, State, probe-mask, and latent-action slots', {
      operation: 'serializeGcObject', slot: 'stateFrame',
    });
  }
  emitObject(archive, slots.node, frameDescriptor(result.frame, object, 'node'));
  result.references++;
  emitObject(archive, slots.state, frameDescriptor(result.frame, object, 'state'));
  result.references++;

  const raw = options.serializeRaw ?? archive.serializeRaw;
  emitRaw(archive, raw, slots.probeMask, 8, {
    kind: 'state-frame-raw', key: 'stateFrame.probeMask', slot: 'ProbeMask', object, frame: result.frame,
  }, rawCalls);
  emitRaw(archive, raw, slots.latentAction, 4, {
    kind: 'state-frame-raw', key: 'stateFrame.latentAction', slot: 'LatentAction', object, frame: result.frame,
  }, rawCalls);

  const node = slots.node.get();
  emitPreload(archive, options.preloadObject, node, {
    kind: 'state-frame-preload', key: 'stateFrame.node', slot: 'Node', object, frame: result.frame,
  }, preloadCalls);
  const codeSlot = slots.codePointer;
  if (node === null || node === undefined) {
    // 0x1015044e–0x10150455 clears Frame+0x0c when the post-archive Node is
    // null, even when the host frame carried a stale code pointer.
    codeSlot.set(null);
    return result;
  }
  const pointer = codeSlot.get();
  const context = {kind: 'state-frame-code', key: 'stateFrame.codeOffset', slot: 'Code', object, frame: result.frame, node};
  let range = null;
  let offset = pointer === null || pointer === undefined ? -1 : finiteInteger(pointer, 'state-frame code pointer');
  if (offset !== -1) {
    range = resolveNodeRange(node, options, context);
    offset -= range.start;
  }
  result.codeOffsetBefore = offset;
  const offsetSlot = {
    reference: true,
    key: context.key,
    get: () => offset,
    set: value => { offset = finiteInteger(value, 'serialized state-frame code offset'); return value; },
  };
  // FCompactIndex at 0x10159b50 takes this raw +0x04 branch when the GC
  // archive's +0x0c and +0x10 words are zero.  It therefore remains a 4-byte
  // raw value in this mode.
  emitRaw(archive, raw, offsetSlot, 4, context, rawCalls);
  result.codeOffsetAfter = offset;
  result.codeOffset = offset;
  if (offset === -1) {
    codeSlot.set(null);
  } else {
    range ??= resolveNodeRange(node, options, context);
    if (offset < 0 || offset >= range.size) {
      const warning = {object, frame: result.frame, node, offset, range, context};
      result.warnings.push(warning);
      options.onCodeOffsetWarning?.(warning);
    }
    codeSlot.set(range.start + offset);
  }
  return result;
}

/**
 * Execute the collector archive path of Core UObject::Serialize.
 *
 * `layout`/`objectLayout` has explicit mutable slots named `name`, `outer`,
 * `class`, `linker`, `flags`, and `stateFrame`.  `frameLayout`/`frameSlots`
 * has `node`, `state`, `probeMask`, `latentAction`, and `codePointer`.  A slot
 * is `{get,set}` or a function returning one.  This
 * avoids making native FName/UObject identities depend on short property
 * names in the script metadata.
 *
 * The typed property body can be supplied as `serializeProperties`; otherwise
 * `fields` plus `propertyReference(field)` are passed to the established
 * `serializeScriptReferences` walker.  `nodeCodeRange(node)` returns the
 * original `+0x44` start and `+0x48` span in the host representation.
 */
export function serializeGcObject(object, archive, options = {}) {
  requireArchive(archive);
  if (!object || typeof object !== 'object') throw new TypeError('Expected a UObject record');
  const state = archiveStateOf(archive, options);
  const layout = options.layout ?? options.objectLayout ?? options.slots ?? {};
  const frameLayout = options.frameLayout ?? options.frameSlots ?? layout.frame ?? {};
  const flagsSlot = readFlagsSlot(object, layout, options);
  const header = {
    name: holder(layout.name, {kind: 'uobject-header', key: 'header.name', slot: 'Name', object}, object, ['name', 'Name']),
    outer: holder(layout.outer, {kind: 'uobject-header', key: 'header.outer', slot: 'Outer', object}, object, ['outer', 'Outer']),
    class: holder(layout.class ?? layout.classRecord ?? layout.objectClass,
      {kind: 'uobject-header', key: 'header.class', slot: 'Class', object}, object,
      ['classRecord', 'classRef', 'objectClass', 'class', 'Class']),
    linker: holder(layout.linker, {kind: 'uobject-header', key: 'header.linker', slot: 'Linker', object}, object, ['linker', 'Linker']),
  };
  const classValue = header.class.get();
  const initialClassIsCoreClass = classIsCoreClassObject(object, classValue, options);
  const preloadCalls = [];
  const rawCalls = [];

  // 0x10150235–0x1015024f: set the route marker before any callback.  The
  // collector clears it before dispatch and checks it after this function.
  flagsSlot.set((Number(flagsSlot.get()) >>> 0) | OBJECT_SERIALIZATION_FLAGS.SerializeRoute);
  if (!initialClassIsCoreClass) {
    emitPreload(archive, options.preloadObject, classValue, {
      kind: 'uobject-class-preload', key: 'header.class', slot: 'Class', object,
    }, preloadCalls, {includeNull: true});
  }

  // GC has ar0c/ar10/ar14/ar18 == 0, so the native identity sequence is
  // always Name, Outer, Class, then Linker.
  emitName(archive, header.name, {kind: 'uobject-header', key: 'header.name', slot: 'Name', object});
  emitObject(archive, header.outer, {kind: 'uobject-header', key: 'header.outer', slot: 'Outer', object});
  emitObject(archive, header.class, {kind: 'uobject-header', key: 'header.class', slot: 'Class', object});
  emitObject(archive, header.linker, {kind: 'uobject-header', key: 'header.linker', slot: 'Linker', object});

  const frameFlag = (Number(flagsSlot.get()) >>> 0) & OBJECT_SERIALIZATION_FLAGS.StateFrame;
  const hasFrameSlot = layout.stateFrame !== undefined ||
    Object.hasOwn(object, 'stateFrame') || Object.hasOwn(object, 'StateFrame');
  const frameSlot = (frameFlag || hasFrameSlot) ? holder(layout.stateFrame, {
    kind: 'uobject-header', key: 'header.stateFrame', slot: 'StateFrame', object,
  }, object, ['stateFrame', 'StateFrame']) : null;
  let stateFrame;
  if (frameFlag) {
    // The allocator reads UObject+0x24 after identity serialization, not the
    // class pointer retained for the initial Class Preload.
    stateFrame = serializeStateFrame({
      object, classValue: header.class.get(), archive, frameSlot, frameLayout, options, preloadCalls, rawCalls,
    });
  } else {
    let freed = false;
    const existing = frameSlot?.get() ?? null;
    if (existing !== null && existing !== undefined) {
      if (typeof options.freeStateFrame !== 'function') {
        fail('UObject has an unflagged FStateFrame but no freeStateFrame adapter was supplied', {
          operation: 'serializeGcObject', slot: 'stateFrame',
        });
      }
      options.freeStateFrame(existing, object, {kind: 'state-frame-free', object, frame: existing});
      frameSlot.set(null);
      freed = true;
    }
    stateFrame = {used: false, created: false, freed, references: 0, raw: rawCalls, codeOffset: null, warnings: []};
  }

  // The native routine reloads UObject+0x24 after the complete frame path for
  // its class-vtable gates; a frame/object callback may have changed it.
  const finalClassValue = header.class.get();
  const specialClass = classIsCoreClassObject(object, finalClassValue, options);

  // In GC mode ar0c/ar10/ar14 are all zero.  The +0x74 tagged-property gate
  // is therefore skipped; the class +0x70 SerializeBin gate always runs for
  // every class except an object whose class is the hard-coded Core.Class
  // metaclass at 0x101f1c18.
  let properties = {called: false, skipped: specialClass, result: null};
  if (!specialClass) {
    const serializeProperties = options.serializeProperties ?? archive.serializeProperties;
    if (typeof serializeProperties === 'function') {
      properties = {
        called: true,
        skipped: false,
        result: serializeProperties(object, archive, {
          kind: 'serialize-bin', address: 0x10126610, classValue: finalClassValue,
        }),
      };
    } else {
      const fields = options.fields ?? object.fields ?? finalClassValue?.propertyLink;
      const propertyReference = options.propertyReference ?? options.reference;
      if (fields === undefined || typeof propertyReference !== 'function') {
        fail('GC UObject Serialize needs SerializeBin fields and propertyReference adapters', {
          operation: 'serializeGcObject', slot: 'class.SerializeBin',
        });
      }
      properties = {
        called: true,
        skipped: false,
        result: serializeScriptReferences(fields, propertyReference, archive, {persistent: false}),
      };
    }
  }

  // The native path invokes class vtable +0x64 and then FArchive +0x14 with
  // the same value twice, even for the Core.Class metaclass.
  const size = propertySize(object, archive, options.getPropertiesSize);
  const countBytes = emitCountBytes(
    archive, options.countBytes, size,
    {kind: 'count-bytes', key: 'class.SerializeBin', object, classValue: finalClassValue, size},
  );
  return {
    archiveState: state,
    specialClass,
    routeMarker: Boolean((Number(flagsSlot.get()) >>> 0) & OBJECT_SERIALIZATION_FLAGS.SerializeRoute),
    flags: Number(flagsSlot.get()) >>> 0,
    header: {name: true, outer: true, class: true, linker: true},
    stateFrame,
    preloadCalls,
    rawCalls,
    properties,
    size,
    countBytes,
    references: 1 + 3 + stateFrame.references,
    nameReferences: 1,
  };
}

export const serializeUObjectGc = serializeGcObject;
