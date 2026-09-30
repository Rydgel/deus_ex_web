/**
 * Name ids for the Rust core (docs/rust-core.md R2b-6 and R3-c). A name is
 * the id of a folded spelling, interned once for every runtime; `none` is
 * id 1. These are host identities, not FName indices.
 *
 * Two folds are in use, and they differ only for a falsy value that is not
 * null or undefined (in practice the empty name ''):
 * - `nameId`: `String(v || 'None').toLowerCase()`, what Core's 254/255 and
 *   IsA compare (R2b-6);
 * - `nameKeyId`: `String(v ?? 'None').toLowerCase()`, what DeusEx's alliance
 *   natives compare (script-pawn-alliance.mjs `nameKey`).
 *
 * A name cell of an object image keeps its value in the reference array, as
 * before, and since R3-c also its `nameKeyId` in its four bytes
 * (script-object-image.mjs), with `none` stored as 0 so a zeroed image or
 * frame block reads as None.
 */
const nameKeys = new Map([['none', 1]]), nameSpellings = [null, 'none'];

/** The id of an already folded spelling. */
export function foldedNameId(folded) {
  let id = nameKeys.get(folded);
  if (id === undefined) {
    nameKeys.set(folded, id = nameSpellings.length);
    nameSpellings.push(folded);
  }
  return id;
}

// A string's ids by its exact spelling, so a name seen again is not folded again.
const spellingIds = new Map(), spellingKeyIds = new Map();

/** The R2b-6 id: `String(v || 'None').toLowerCase()`. */
export function nameId(value) {
  if (typeof value !== 'string') return foldedNameId(String(value || 'None').toLowerCase());
  let id = spellingIds.get(value);
  if (id === undefined) spellingIds.set(value, id = foldedNameId((value || 'None').toLowerCase()));
  return id;
}

/** The alliance natives' id: `String(v ?? 'None').toLowerCase()`. */
export function nameKeyId(value) {
  if (typeof value !== 'string') return foldedNameId(String(value ?? 'None').toLowerCase());
  let id = spellingKeyIds.get(value);
  if (id === undefined) spellingKeyIds.set(value, id = foldedNameId(value.toLowerCase()));
  return id;
}

/** A name cell's four bytes for a stored value: its nameKeyId, with `none`
 * as 0. */
export function nameCellWord(value) {
  const id = nameKeyId(value);
  return id === 1 ? 0 : id;
}

/** The folded spelling of a name id. */
export const nameSpelling = id => nameSpellings[id];
