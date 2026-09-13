import {copyCompletePropertyValue} from './script-property-copy.mjs';

/** Core UObject::InitProperties 0x101520d0. See docs/script-object-properties.md. */
export const OBJECT_PROPERTIES_NATIVE = Object.freeze({
  body: 0x101520d0, thunk: 0x1010102d, headerSize: 0x28,
  coreSha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});
const present = value => value !== null && value !== 0;
function integer(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > 0x7fffffff)
    throw new RangeError(`InitProperties requires valid ${name}`);
  return value;
}
function bytes(value, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`InitProperties requires ${name} byte storage`);
  return value;
}
function sync(value) {
  if (value && typeof value.then === 'function') throw new Error('InitProperties services must be synchronous');
  return value;
}

export function initializeNativeObjectProperties({data, count, cls = null,
  defaults = null, propertySize = count}, services = {}) {
  bytes(data, 'destination'); integer(count, 'Count', 0x28);
  integer(propertySize, 'PropertySize');
  if (data.length < count) throw new RangeError('InitProperties destination is smaller than Count');
  const read = (object, offset, kind) => {
    if (typeof services.read !== 'function') throw new Error('InitProperties requires raw metadata reads');
    const value = sync(services.read(object, offset, kind));
    if (value === undefined) throw new Error(`InitProperties unresolved metadata +0x${offset.toString(16)}`);
    return value;
  };
  if (!present(defaults) && present(cls)) {
    const num = integer(read(cls, 0x4d8, 'i32'), 'Defaults.Num');
    if (num !== 0) {
      defaults = read(cls, 0x4d4, 'ptr');
      propertySize = num;
    }
  }
  let copiedEnd = 0x28;
  if (present(defaults)) {
    bytes(defaults, 'defaults'); integer(propertySize, 'source size', 0x28);
    if (propertySize > defaults.length || propertySize > data.length)
      throw new RangeError('InitProperties copy exceeds supplied storage');
    // REP MOVSD/MOVSB is a forward copy, including when buffers overlap.
    const sourceView = new DataView(defaults.buffer, defaults.byteOffset, defaults.byteLength);
    const targetView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0x28;
    for (; offset + 4 <= propertySize; offset += 4)
      targetView.setUint32(offset, sourceView.getUint32(offset, true), true);
    for (; offset < propertySize; offset++) data[offset] = defaults[offset];
    copiedEnd = propertySize;
  }
  if (copiedEnd < count) data.fill(0, copiedEnd, count);
  const copy = services.copyCompleteValue ?? (({property, destination, source}) =>
    copyCompletePropertyValue(property, destination, source, services.propertyCopy ?? {}));
  const seen = new Set();
  const copiedProperties = [];
  for (let property = present(cls) ? read(cls, 0x68, 'ptr') : null; present(property);) {
    if (seen.has(property)) throw new Error('InitProperties cyclic constructor-linked properties');
    seen.add(property);
    const offset = integer(read(property, 0x48, 'i32'), 'property offset');
    if (offset < propertySize) {
      const stride = integer(read(property, 0x38, 'i32'), 'ElementSize');
      const dimension = integer(read(property, 0x34, 'i32'), 'ArrayDim');
      const size = integer(stride * dimension, 'property byte span');
      if (offset + size > data.length) throw new RangeError('InitProperties owning property exceeds destination');
      data.fill(0, offset, offset + size);
      const callOffset = integer(read(property, 0x48, 'i32'), 'copy property offset');
      if (!present(defaults)) throw new Error('InitProperties owning property reached null source');
      if (callOffset + size > defaults.length || callOffset + size > data.length)
        throw new RangeError('InitProperties owning property exceeds supplied storage');
      sync(copy({property, destination: {bytes: data, offset: callOffset},
        source: {bytes: defaults, offset: callOffset}, size, virtualSlot: 0x90}));
      copiedProperties.push(property);
    }
    property = read(property, 0x54, 'ptr');
  }
  return {data, source: defaults, propertySize, copiedEnd, copiedProperties};
}
