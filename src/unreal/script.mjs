import { readObject, objectAt, nameAt } from './objects.mjs';
import { skipBytecode } from './classes.mjs';

/** Serialized UFunction/UStruct header, preserving its original script stream. */
export function readFunction(asset, index) {
  const { pkg, bytes } = asset, object = readObject(pkg, bytes, index), r = object.reader;
  if (object.entry.className !== 'Function') throw new Error('Expected Function export');
  const ref = () => { const n = r.compact(); objectAt(pkg, n); return n; };
  const base = ref(), next = ref(), scriptText = ref(), children = ref();
  const name = nameAt(pkg, r.compact()), line = r.u32(), textPosition = r.u32(), size = r.u32(), start = r.offset;
  skipBytecode(pkg, r, size);
  return { entry: object.entry, pkg, base, next, scriptText, children, name, line, textPosition, size, bytes: r.bytes.slice(start, r.offset) };
}
