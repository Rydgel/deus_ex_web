/** ConEventRandomLabel native support (ConSys.dll, SHA-256
 * f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa).
 *
 * ConEventRandomLabel is `native noexport` and carries a `native private
 * DynamicArray labels` payload after its tagged properties. The three
 * intrinsics that read it are:
 *   - GetLabelCount  (2060, body 0x1000a0c0): returns labels.Num (+0x44).
 *   - GetLabel       (2061, body 0x1000a110): returns labels[index], or the
 *     static empty string when index<0 or index>=Num.
 *   - GetRandomLabel (2062, body 0x1000a270): the cycling selector recovered
 *     below. Its random branch calls Core `appRand()` (import 0x100130ec).
 *
 * Serialized payload layout (verified against DeusExConText.ConEventRandomLabel3,
 * the MunitionsTrooperFrob head): after the tagged-property `None` terminator the
 * bytes are a TArray<FString> — a CompactIndex count followed by that many
 * FStrings. ConEventRandomLabel3 decodes to ["A1","A2","A3","A4","A5"].
 *
 * The reflected script fields bCycleEvents/bCycleOnce/bCycleRandom pack into the
 * native +0x4c byte (bit0/bit1/bit2); cycleIndex is +0x50 and bLabelsCycled is
 * +0x54. Those five are ordinary UnrealScript properties, so the runtime keeps
 * them in the object's typed slots; only `labels` needs this decoder. */

export const RANDOM_LABEL_NATIVE = Object.freeze({
  className: 'ConEventRandomLabel',
  classKey: 'consys.coneventrandomlabel',
  hash: 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  getLabelCount: 2060,
  getLabel: 2061,
  getRandomLabel: 2062,
  bodies: Object.freeze({ getLabelCount: 0x1000a0c0, getLabel: 0x1000a110, getRandomLabel: 0x1000a270 }),
  appRandImport: 0x100130ec,
});

/** Decode the native `labels` TArray<FString> that follows the tagged
 * properties. `reader` is the readObject reader positioned at the payload
 * start (readObject.reader.offset === entry-props end). */
export function decodeRandomLabelLabels(reader, version) {
  const count = reader.compact();
  if (count < 0 || count > 100000)
    throw new RangeError(`ConEventRandomLabel labels count is implausible: ${count}`);
  const labels = [];
  for (let index = 0; index < count; index++) labels.push(reader.string(version));
  return labels;
}

/** GetLabelCount (2060): labels.Num. */
export function getLabelCount(labels) {
  return labels.length;
}

/** GetLabel (2061): labels[index], or the empty string for an out-of-range
 * index (the native returns the static empty TCHAR at 0x1001e1cc). */
export function getLabel(labels, index) {
  if (!Number.isInteger(index) || index < 0 || index >= labels.length) return '';
  return labels[index];
}

/**
 * GetRandomLabel (2062), recovered from body 0x1000a270. `state` carries the
 * mutable cycleIndex/bLabelsCycled the native reads and writes; `flags` are the
 * three reflected cycle booleans; `appRand` is Core appRand() (the shared CRT
 * rand stream) used only by the random branch.
 *
 * Returns { label, index, cycleIndex, bLabelsCycled } — the caller writes the
 * two mutated fields back to the object's typed slots, exactly as the native
 * writes +0x50/+0x54.
 */
export function getRandomLabel(labels, { bCycleEvents, bCycleOnce, bCycleRandom }, state, appRand) {
  const count = labels.length;
  let cycleIndex = state.cycleIndex | 0;
  let bLabelsCycled = Boolean(state.bLabelsCycled);
  if (count <= 0) return { label: '', index: -1, cycleIndex, bLabelsCycled };

  // if (cycleIndex == count) bLabelsCycled = true   (0x1000a296-0x1000a29a)
  if (cycleIndex === count) bLabelsCycled = true;

  let index;
  let goRandom = false;
  if (!bCycleEvents) {
    goRandom = true;                                   // 0x1000a2a2 je random
  } else if (bCycleRandom && bLabelsCycled) {
    goRandom = true;                                   // 0x1000a2a8-0x1000a2ab
  } else if (bCycleOnce && cycleIndex === count - 1) {
    index = count - 1;                                 // 0x1000a2b7 je: stay at last, no increment
  } else {
    index = cycleIndex % count;                        // 0x1000a2bb sequential
    cycleIndex = cycleIndex + 1;                        // 0x1000a2c1 inc + store
  }
  if (goRandom) {
    if (typeof appRand !== 'function')
      throw new Error('ConEventRandomLabel.GetRandomLabel random branch requires the shared appRand stream');
    index = (appRand() >>> 0) % count;                  // 0x1000a2ca appRand; idiv count
  }
  return { label: labels[index], index, cycleIndex, bLabelsCycled };
}
