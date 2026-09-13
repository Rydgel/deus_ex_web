/** Read a live GObjObjects capture produced by tools/dump-gobjects-win.c.
 *
 * The capture is the original game's global UObject registry, read from the
 * running process under CrossOver/Wine (Core.dll GObjObjects at base +0x19e628,
 * count +0x19e62c). Each object's global index (UObject +0x04) is the slot it
 * was assigned during the boot + package-load construction order. This index is
 * the value the original native audio path uses to form a sound channel id
 * (docs/script-sound.md), so we source it from measured evidence rather than a
 * package export index or an inferred constant.
 *
 * The capture lives under the ignored .cache/ tree; it is not committed with
 * the source. Regenerate it by running the dumper in the game's Wine bottle
 * while standing in the target map.
 *
 * File format (one header line, then one row per live object):
 *   pid=<n> Core.dll base=0x<h> objects=<n> names=<n>
 *   slot <slot> index <index> <Class>.<Name>
 */
import { readFile } from 'node:fs/promises';

const ROW = /^slot\s+(\d+)\s+index\s+(\d+)\s+(\S+)$/;
const HEADER = /objects=(\d+)\s+names=(\d+)/;

export async function loadOriginalGObjects(path) {
  const text = await readFile(path, 'utf8');
  const byKey = new Map();      // "Class.Name" -> {index, count}
  const rows = [];
  let header = null;
  let maxIndex = -1;
  const present = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!header) { const h = HEADER.exec(line); if (h) header = { objects: Number(h[1]), names: Number(h[2]) }; }
    const m = ROW.exec(line);
    if (!m) continue;
    const slot = Number(m[1]), index = Number(m[2]), key = m[3];
    rows.push({ slot, index, key });
    present.add(index);
    if (index > maxIndex) maxIndex = index;
    const existing = byKey.get(key);
    if (existing) existing.count++; else byKey.set(key, { index, count: 1 });
  }
  if (!rows.length) throw new Error(`No GObjObjects rows parsed from ${path}`);

  // The GObjObjects high-water count (Core.dll +0x19e62c) is the FArray length,
  // including any null holes; AddObject appends at this count when the free list
  // is empty. Prefer the header value, falling back to maxIndex+1.
  const count = header && Number.isInteger(header.objects) ? header.objects : maxIndex + 1;

  // Null holes below the high-water mark are freed slots still on GObjAvailable
  // (Core UObject destructor pushes the freed index; docs/script-object-release.md).
  // AddObject reuses them LIFO before appending. A memory snapshot reveals which
  // slots are free but not the order they were freed; the ascending list here is
  // exact only when there is at most one hole (the 00_Training capture: [42156]).
  const freeIndices = [];
  for (let i = 0; i < count; i++) if (!present.has(i)) freeIndices.push(i);

  /** Unique global index for one `Class.Name` object; null when the key is
   * absent or ambiguous. Never guesses, so an ambiguous reflection member
   * (e.g. Function.Tick) yields null rather than a wrong slot. */
  function indexFor(className, name) {
    const entry = byKey.get(`${className}.${name}`);
    return entry && entry.count === 1 ? entry.index : null;
  }

  return {
    header,
    rows,
    count,
    freeIndices,
    indexFor,
    /** Non-throwing capture-backed index provider for the runtime: it resolves a
     * pre-placed object's true global slot by (class, name), or null. */
    provider() { return { indexFor }; },
    /** Unique global index for one `Class.Name` object; throws if absent or
     * ambiguous, so a bad key never silently yields a wrong channel id. */
    index(className, name) {
      const key = `${className}.${name}`;
      const entry = byKey.get(key);
      if (!entry) throw new Error(`No live GObjObjects entry for ${key}`);
      if (entry.count !== 1) throw new Error(`Ambiguous GObjObjects key ${key} (${entry.count} matches)`);
      return entry.index;
    },
  };
}
