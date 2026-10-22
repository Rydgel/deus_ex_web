/** The native payloads of a saved level that hold references into the package: `Model` (the world's compiled BSP and each mover's brush) and
 * `Polys` (a brush's polygons). A saved level is written with its own export and import tables, so these payloads are read and written again with
 * every object reference translated (`objectRef`: the source package's compact index -> the new package's) and every name too (`nameIndex`). The
 * grammar is unreal/model.mjs readModel and unreal/polys.mjs readPolys; every other field is copied unchanged. With identity translations the output
 * equals the input byte for byte (scripts/validate-level-save.mjs checks that on each Model and Polys of the saved levels).
 *
 * References: Model surfaces' texture and brushActor, zones' actor, the polygons' Polys object, the lights list's actors; Polys polygons' actor and
 * texture. Names: the property list's `None` terminator and each polygon's ItemName. */
import { Reader, PackageError } from '../unreal/package.mjs';
import { ByteWriter } from './byte-writer.mjs';

class Copy {
  constructor(pkg, bytes, translate) {
    this.pkg = pkg; this.r = new Reader(bytes); this.w = new ByteWriter(bytes.length + 64); this.translate = translate;
  }
  raw(n) { this.w.raw(this.r.take(n)); }
  compact() { const v = this.r.compact(); this.w.compact(v); return v; }
  count() { return this.compact(); }
  i32() { const v = this.r.i32(); this.w.i32(v); return v; }
  u8() { const v = this.r.u8(); this.w.u8(v); return v; }
  u32() { const v = this.r.u32(); this.w.u32(v); return v; }
  object() { const v = this.r.compact(); this.w.compact(this.translate.objectRef(v)); return v; }
  name() { const v = this.r.compact(); this.w.compact(this.translate.nameIndex(this.pkg.names[v].name)); return v; }
  /** An object saved with RF_HasStack (0x2000000) starts with its FStateFrame: Node, StateNode, ProbeMask, LatentAction and, with a Node, the
   * code offset. A Model and a Polys loaded from a .dx carry one; a saved level's do not (the original writes them without), so it is read past. */
  skipStack() {
    const node = this.r.compact(); this.r.compact(); this.r.u32(); this.r.u32(); this.r.i32();
    if (node) this.r.compact();
  }
  /** The empty tagged property list of a native object (just the terminating None). */
  noProperties() {
    const name = this.pkg.names[this.r.compact()].name;
    if (name !== 'None') throw new PackageError(`Expected an empty property list, found ${name}`, this.r.offset);
    this.w.compact(this.translate.nameIndex('None'));
  }
  done() {
    if (this.r.offset !== this.r.bytes.length) throw new PackageError('Trailing native data', this.r.offset);
    return this.w.finish();
  }
}

export function transcodeModel(pkg, bytes, translate, { hasStack = false } = {}) {
  const c = new Copy(pkg, bytes, translate);
  if (hasStack) c.skipStack();
  c.noProperties();
  c.raw(25); c.raw(16);                                   // bounds box (min, max, valid), bounding sphere
  c.raw(12 * c.count());                                  // vectors
  c.raw(12 * c.count());                                  // points
  for (let n = c.count(); n > 0; n--) {                   // nodes
    c.raw(16 + 8 + 1);                                    // plane, zone mask, flags
    for (let i = 0; i < 7; i++) c.compact();              // vertexPool, surface, back, front, coplanar, collisionBound, renderBound
    c.compact(); c.compact();                             // zones
    c.u8(); c.raw(8);                                     // vertexCount, leaves
  }
  for (let n = c.count(); n > 0; n--) {                   // surfaces
    c.object();                                           // texture
    c.u32();                                              // flags
    for (let i = 0; i < 5; i++) c.compact();              // base, normal, textureU, textureV, lightMap
    c.compact();                                          // brushPolygon
    c.raw(4);                                             // pan
    c.object();                                           // brushActor
  }
  for (let n = c.count(); n > 0; n--) { c.compact(); c.compact(); }   // vertices (point, side)
  c.i32();                                                // sharedSides
  for (let n = c.i32(); n > 0; n--) { c.object(); c.raw(16); }          // zones: actor, connectivity, visibility
  c.object();                                             // polygons (the brush's Polys)
  for (let n = c.count(); n > 0; n--) {                   // light maps
    c.raw(4 + 12); c.compact(); c.compact(); c.raw(8 + 4);
  }
  c.raw(c.count());                                       // light bits
  c.raw(25 * c.count());                                  // render bounds
  c.raw(4 * c.count());                                   // leaf hulls
  for (let n = c.count(); n > 0; n--) { c.compact(); c.compact(); c.compact(); c.raw(8); }   // leaves
  for (let n = c.count(); n > 0; n--) c.object();         // lights (actors)
  c.raw(8);                                               // rootOutside, linked
  return c.done();
}

export function transcodePolys(pkg, bytes, translate, { hasStack = false } = {}) {
  const c = new Copy(pkg, bytes, translate);
  if (hasStack) c.skipStack();
  c.noProperties();
  c.i32();                                                // count
  c.i32();                                                // capacity
  const count = c.r.view.getInt32(c.r.offset - 8, true);
  for (let n = 0; n < count; n++) {
    const vertices = c.compact();
    c.raw(48);                                            // base, normal, textureU, textureV
    c.raw(12 * vertices);
    c.u32();                                              // flags
    c.object(); c.object();                               // actor, texture
    c.name();                                             // ItemName
    c.compact(); c.compact();                             // iLink, iBrushPoly
    c.raw(4);                                             // pan
  }
  return c.done();
}

/** A native object that is only a tagged property list (LevelSummary): the tags copied with the name indices re-mapped. Properties whose
 * payload holds a reference (object, name, struct, array) stop by name: LevelSummary holds strings and numbers. */
export function transcodeProperties(pkg, bytes, translate, { hasStack = false } = {}) {
  const r = new Reader(bytes), w = new ByteWriter(bytes.length + 16);
  if (hasStack) { const node = r.compact(); r.compact(); r.u32(); r.u32(); r.i32(); if (node) r.compact(); }
  for (;;) {
    const name = pkg.names[r.compact()].name;
    w.compact(translate.nameIndex(name));
    if (name === 'None') break;
    const info = r.u8(), type = info & 15, code = (info >> 4) & 7;
    if (![1, 2, 3, 4, 13].includes(type)) throw new PackageError(`Property ${name} has the tag type ${type}, which a native property list copy does not translate`, r.offset);
    w.u8(info);
    const size = code < 5 ? [1, 2, 4, 12, 16][code] : code === 5 ? r.u8() : code === 6 ? r.u16() : r.u32();
    if (code === 5) w.u8(size); else if (code === 6) w.u16(size); else if (code === 7) w.u32(size);
    if ((info & 128) && type !== 3) {
      const first = r.u8();
      w.u8(first);
      const more = (first & 192) === 192 ? 3 : (first & 128) ? 1 : 0;
      for (let i = 0; i < more; i++) w.u8(r.u8());
    }
    w.raw(r.take(type === 3 ? 0 : size));
  }
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing native property list data', r.offset);
  return w.finish();
}
