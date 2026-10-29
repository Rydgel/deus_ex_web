/**
 * Host bindings of script properties, without a pair of closures per object
 * (docs/live-heap.md, "Step 5's results").
 *
 * A binding is an object with `get(instance)` and `set(value, instance)`, called as methods of the binding by the
 * runtime, with the ScriptInstance that owns it: a closure pair `{get: () => ..., set: v => ...}` still works (it
 * ignores the arguments). The binding of an object's header fields carries no state of its own, so one object serves
 * every native object (the Island holds twelve thousand, five bindings each); a binding with state keeps it in
 * fields, with get and set on its prototype.
 */
import {writeCell} from './script-object-image.mjs';
import {storageReference} from './script-values.mjs';

/** The UObject header fields of an object bound to a native object (ScriptRuntime.bindNativeObject): the native
 * object is the instance's `nativeObject`, set before the bindings are made and replaced only by a later
 * bindNativeObject, which binds again. */
export const NATIVE_HEADER_BINDINGS = Object.freeze({
  ObjectFlags: Object.freeze({
    get(instance) { return instance.nativeObject.flags; },
    set(value, instance) { instance.nativeObject.flags = value >>> 0; },
  }),
  Outer: Object.freeze({
    get(instance) { return instance.nativeObject.outer?.identity ?? null; },
    set() { throw new Error('Changing native Outer requires object rename support'); },
  }),
  Name: Object.freeze({
    get(instance) { return instance.nativeObject.name; },
    set() { throw new Error('Changing native Name requires object rename support'); },
  }),
  Class: Object.freeze({
    get(instance) { return instance.cls.record; },
    set() { throw new Error('Changing native Class is unsupported'); },
  }),
  ObjectInternal: Object.freeze({
    get() { throw new Error('Raw native ObjectInternal pointers are not represented by the script host'); },
    set() { throw new Error('Writing native ObjectInternal is unsupported'); },
  }),
});

/** The same fields of a loaded package object (ScriptRuntime.prepareLoadedObject): read from the instance's
 * `loadedReference` and `loadedResource`, and immutable. */
const loadedLifecycle = name => Object.freeze({
  get() { throw new Error(`Loaded ${name} requires the live native object lifecycle`); },
  set() { throw new Error(`Loaded ${name} mutation requires its native lifecycle service`); },
});
const loadedImmutable = (name, get) => Object.freeze({
  get,
  set() { throw new Error(`Loaded ${name} mutation requires its native lifecycle service`); },
});
export const LOADED_HEADER_BINDINGS = Object.freeze({
  Name: loadedImmutable('Name', instance => instance.loadedReference.name),
  Class: loadedImmutable('Class', instance => instance.cls.record),
  Outer: loadedImmutable('Outer', instance => instance.loadedResource.outer?.object ?? instance.loadedResource.outer ?? null),
  ObjectFlags: loadedLifecycle('ObjectFlags'),
  ObjectInternal: loadedLifecycle('ObjectInternal'),
});

/** A binding mirrored in the object's image cell (ScriptRuntime.mirroredBinding): reads go to the binding; the cell
 * takes a copy at binding and after every set, so the Rust interpreter reads the cell. */
export class MirroredBinding {
  constructor(binding, instance, cell, codec) {
    this.binding = binding; this.instance = instance; this.cell = cell; this.codec = codec;
    this.mirrored = true;
  }
  get(instance) { return this.binding.get(instance); }
  set(value, instance) { this.binding.set(value, instance); this.write(); }
  write() {
    const instance = this.instance;
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(this.binding.get(instance)), instance.base);
  }
}

/** A binding as the storage of a PropertyReference: the reference calls get() and set(value) on it. */
export class BindingStorage {
  constructor(binding, instance) { this.descriptor = null; this.binding = binding; this.instance = instance; }
  get() { return this.binding.get(this.instance); }
  set(value) { this.binding.set(value, this.instance); }
}

/** fieldReference(receiver, field) of a bound field. */
export const bindingReference = (field, binding, instance) => storageReference(field, new BindingStorage(binding, instance));

/** Actor.Level of an attached map actor (script-doors makeBinding): the record's LevelInfo. Mirrored in the image. */
export class RecordLevelBinding {
  constructor(record) { this.record = record; }
  get() { return this.record.levelInfo; }
  set(value) { this.record.levelInfo = value; }
}
RecordLevelBinding.prototype.mirror = true;

/** LevelInfo.NetMode of the level's own LevelInfo actor: the record's level. Mirrored in the image. */
export class RecordNetModeBinding {
  constructor(record) { this.record = record; }
  get() { return this.record.level?.netMode ?? 0; }
  set(value) { if (this.record.level) this.record.level.netMode = Number(value) | 0; }
}
RecordNetModeBinding.prototype.mirror = true;
