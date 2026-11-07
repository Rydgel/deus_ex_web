/**
 * A linked class's `defaults` (field key -> the Map of that default's values by index), counting its changes.
 *
 * Every construction asked whether the class image still matched the class (`sameDefaults`: a walk over the whole Map, every
 * default of an Actor class, comparing each entry by identity with the image's snapshot): 0.05 ms of a Dockyard frame in Firefox
 * (3.2 spawns a frame), 5.5 times what V8 spends. A change of the Map is a `set`, `delete` or `clear` of this object, whichever code
 * makes it, so `version` says whether any happened since an image was made from it; nothing changes a value Map in place (a changed
 * default replaces the class's entry), which is what the identity comparison relied on too.
 */
export class DefaultsMap extends Map {
  constructor(entries) {
    super();
    this.version = 0;
    if (entries) for (const [key, value] of entries) super.set(key, value);
  }
  set(key, value) { this.version++; return super.set(key, value); }
  delete(key) { this.version++; return super.delete(key); }
  clear() { this.version++; super.clear(); }
}
