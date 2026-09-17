/**
 * Shared validator-side services for the interactive-control natives.
 *
 * `buildWorld` constructs the same fixture the Unicorn probe's run_case does:
 * one canonical object per case node, labeled resource objects, and the
 * 'result' out-slot, with pointer fields holding object references.  The
 * read/write services record the same canonical access entries the probe's
 * memory hook emits ({op, object, offset, kind, size, bits, label}); the leaf
 * services emit the same event dicts and consume the same queued returns.
 */

const f = Math.fround;
const f32bits = value => {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, f(value), true);
  return buffer.getUint32(0, true);
};

export const U8_RANGE = [0x630, 0x630 + 0x100];
export const U8_OFFSETS = new Set([0x28, 0x30, 0x20c]);
export const F32_OFFSETS = new Set([0x9c, 0xa0, 0x80, 0x84, 0xbc, 0xc0, 0xc4,
  0xc8, 0x178, 0x17c, 0x180, 0x1fc, 0x200, 0x204]);
export const PTR_OFFSETS = new Set([0x00, 0x5c, 0xec, 0x138, 0x184, 0x190,
  0x194, 0x1ec, 0x1f0, 0x1f4, 0x1f8, 0x5c8,
  0x1a4, 0x1b0, 0x1bc, 0x1c8, 0x1d4, 0x1e0]);

export function fieldKind(offset) {
  if (U8_OFFSETS.has(offset) || (offset >= U8_RANGE[0] && offset < U8_RANGE[1]))
    return 'u8';
  if (F32_OFFSETS.has(offset)) return 'f32';
  if (PTR_OFFSETS.has(offset)) return 'ptr';
  return 'u32';
}

function resolveSpec(world, value) {
  if (typeof value === 'string') return world.objects[value];
  if (value && typeof value === 'object') {
    if ('ptr' in value) return world.objects[value.ptr];
    if ('f32' in value) return f(value.f32);
  }
  return value;
}

export function buildWorld(caseSpec) {
  const world = {
    objects: {}, trace: [], events: [], seen: new Map(), globals: {},
  };
  const canon = value => {
    if (value === null || value === undefined || value === 0) return 0;
    if (typeof value === 'object' || typeof value === 'function') {
      if (value.name !== undefined) return value.name;
      if (world.seen.has(value)) return world.seen.get(value);
      const label = `a${world.seen.size}`;
      world.seen.set(value, label);
      return label;
    }
    return value;
  };
  world.canon = canon;
  for (const name of Object.keys(caseSpec.resources ?? {})) {
    const object = { name };
    for (const [offText, v] of Object.entries(caseSpec.resources[name] ?? {}))
      object[Number(offText)] = resolveSpec(world, v);
    world.objects[name] = object;
  }
  if (Array.isArray(caseSpec.resources))
    for (const name of caseSpec.resources) world.objects[name] = { name };
  // nodes listed receiver-first; parent refs resolve by label.  Slot 0 holds
  // a labeled vtable object so [this] reads canonize identically.  Objects are
  // created in a first pass so forward references resolve.
  for (const [label] of caseSpec.nodes ?? [])
    world.objects[label] = { name: label, 0: { name: `vtable:${label}` } };
  for (const [label, fields] of caseSpec.nodes ?? []) {
    const object = world.objects[label];
    for (const [offText, v] of Object.entries(fields ?? {}))
      object[Number(offText)] = resolveSpec(world, v);
  }
  world.objects.result = { name: 'result' };
  world.objects.prefSizeDepth = { name: 'prefSizeDepth' };
  const receiver = world.objects[caseSpec.this ?? caseSpec.nodes?.[0]?.[0]];
  const nameOf = canon;

  const record = (op, object, offset, kind, value) => {
    world.trace.push({
      op, object: nameOf(object), offset, kind,
      size: kind === 'u8' ? 1 : 4,
      bits: kind === 'ptr' ? null
        : kind === 'f32' ? f32bits(value ?? 0)
        : ((value ?? 0) & (kind === 'u8' ? 0xff : 0xffffffff)) >>> 0,
      label: kind === 'ptr' ? nameOf(value) : null,
    });
  };

  const read = (object, offset, kind, details) => {
    let value = object[offset];
    if (kind === 'ptr') {
      value = value ?? null;
      record('read', object, offset, kind, value);
      return value;
    }
    if (value === undefined) value = 0;
    record('read', object, offset, kind, value);
    if (kind === 'u8') return value & 0xff;
    if (kind === 'u32') return value >>> 0;
    return f(value);
  };
  const write = (object, offset, kind, value, details) => {
    if (kind === 'ptr') {
      record('write', object, offset, kind, value ?? null);
      object[offset] = value ?? null;
      return;
    }
    const stored = kind === 'u8' ? value & 0xff
      : kind === 'u32' ? value >>> 0 : f(value);
    record('write', object, offset, kind, stored);
    object[offset] = stored;
  };

  const queues = {};
  for (const [key, returns] of Object.entries(caseSpec.vresults ?? {})) {
    const [win, slotText] = key.split(':');
    queues[`${win}:${Number(slotText)}`] = [...returns];
  }
  const pull = (object, slot) => {
    const queue = queues[`${nameOf(object)}:${slot}`];
    return queue && queue.length ? queue.shift() : 0;
  };
  const prefsize = {};
  for (const [k, v] of Object.entries(caseSpec.prefsize ?? {}))
    prefsize[k] = typeof v === 'object' ? f(v.f32) : v;

  world.services = {
    read, write,
    readGlobal: (name, kind, details) =>
      read(world.objects.prefSizeDepth, 0, kind, details),
    writeGlobal: (name, kind, value, details) =>
      write(world.objects.prefSizeDepth, 0, kind, value, details),
    askParentForReconfigure: details => {
      world.events.push({ op: 'AskParentForReconfigure',
                          object: nameOf(details.object) });
    },
    preferredSize: details => {
      const width = f32bits(prefsize.width ?? 0);
      const height = f32bits(prefsize.height ?? 0);
      const object = details.object;
      const result = pull(object, 0x7c);
      world.events.push({ op: 'PreferredSize', object: nameOf(object),
                          via: nameOf(object), flagW: details.flagW,
                          flagH: details.flagH, width, height,
                          virtualSlot: 0x7c, result });
      return { width: prefsize.width ?? 0, height: prefsize.height ?? 0,
               widthBits: width, heightBits: height, result };
    },
    activateButton: details => {
      const object = details.object;
      const result = pull(object, details.virtualSlot);
      world.events.push({ op: 'ActivateButton', object: nameOf(object),
                          via: nameOf(object), source: nameOf(details.source),
                          virtualSlot: details.virtualSlot, result });
      return result;
    },
    toggleChanged: details => {
      const object = details.object;
      const result = pull(object, 0xf0);
      world.events.push({ op: 'ToggleChanged', object: nameOf(object),
                          via: nameOf(object), source: nameOf(details.source),
                          toggle: details.toggle, virtualSlot: 0xf0, result });
      return result;
    },
    buttonPressed: details => {
      const object = details.object;
      const result = pull(object, 0x124);
      world.events.push({ op: 'ButtonPressed', object: nameOf(object),
                          via: nameOf(object), key: details.key,
                          virtualSlot: 0x124, result });
      return result;
    },
  };

  // Uninitialized probe memory is 0xaa-filled; a single sentinel object
  // canonizes to the same 'a<N>' label the oracle gives that fill pattern.
  const uninit = {};
  world.dumpState = dumpSpec => {
    const state = {};
    for (const [label] of caseSpec.nodes ?? []) {
      const object = world.objects[label];
      const offsets = Array.isArray(dumpSpec) ? dumpSpec
        : dumpSpec?.[label] ?? [];
      const dump = {};
      for (const offText of offsets) {
        const offset = Number(offText);
        const kind = fieldKind(offset);
        const value = object[offset];
        if (kind === 'u8') dump[offText] = value === undefined ? 0xaa : value & 0xff;
        else if (kind === 'ptr')
          dump[offText] = value === undefined ? nameOf(uninit) : nameOf(value ?? null);
        else if (kind === 'f32')
          dump[offText] = value === undefined ? 0xaaaaaaaa : f32bits(value);
        else dump[offText] = value === undefined ? 0xaaaaaaaa : value >>> 0;
      }
      state[label] = dump;
    }
    return state;
  };

  return { world, receiver, nameOf };
}
