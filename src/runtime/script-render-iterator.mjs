/** The native side of the render iterators URender::SetupDynamics builds for
 * an actor with a RenderIteratorClass (script-particles.mjs
 * ensureRenderInterface; docs/particles.md, docs/lasers.md): their class
 * constructor and their Destroy, which LoadMap's collection reaches on Player
 * start (docs/script-loadmap-gc.md).
 *
 * DeusEx.u and Engine.u declare three RenderIterator classes: Engine's
 * RenderIterator and DeusEx's LaserIterator and ParticleIterator. Only the two
 * DeusEx classes are named by a RenderIteratorClass, and only they are
 * recovered here. */

export const RENDER_ITERATOR_NATIVE = Object.freeze({
  // Core ??_7UObject@@6B@, stored by UObject's default constructor.
  objectVtable: 0x10179dfc,
  // Engine ??_7URenderIterator@@6B@, stored by URenderIterator's constructor
  // (thunk 0x1030206d, body 0x103d9cf0).
  renderIteratorVtable: 0x104296dc,
  // DeusEx InternalConstructor -> default constructor (URenderIterator's,
  // then the class vtable) and the class vtable. Destroy (+0x24) is
  // 0x1001aec0 in both, `jmp [0x100270dc]` = Core UObject::Destroy; the
  // scalar deleting destructors (+0x0c, LaserIterator 0x1001a9c0,
  // ParticleIterator 0x1000d540) run ~Class (ConditionalDestroy, the
  // URenderIterator vtable, ConditionalDestroy, ~UObject) and then
  // UObject's operator delete, the collection's ordinary release tail.
  classes: Object.freeze({
    'deusex.laseriterator': Object.freeze({ internalConstructor: 0x1001a780, vtable: 0x100283d0,
      destroy: 0x1001aec0, deletingDestructor: 0x1001a9c0 }),
    'deusex.particleiterator': Object.freeze({ internalConstructor: 0x1000d360, vtable: 0x10027a14,
      destroy: 0x1001aec0, deletingDestructor: 0x1000d540 }),
  }),
});

/** The recovered class row UClass::Bind gives `cls`: the ClassConstructor of
 * its nearest native (RF_Native) ancestor. Throws for any other iterator. */
export function renderIteratorNativeClass(cls) {
  let native = cls;
  while (native && !((native.metadata?.entry?.flags ?? 0) & 0x04000000)) native = native.base;
  const row = native ? RENDER_ITERATOR_NATIVE.classes[native.record.key] : undefined;
  if (!row) throw new Error(`RenderIterator native constructor is not recovered for ${cls?.record?.key ?? 'None'}`);
  return row;
}

/** The class constructor StaticConstructObject runs after InitProperties.
 * UObject::UObject(), then URenderIterator::URenderIterator()
 * (0x103d9d16..0x103d9d62): Index (+0x2c) = 0, Observer (+0x30) = NULL, its
 * vtable, and check(GetOuter()->IsA(AActor::StaticClass()))
 * (UnRenderIterator.cpp line 15; the line 18 check compares the C++ size
 * with the class's properties size, a build-time fact). Then the class
 * vtable. `write(identity, name, value)` writes a reflected property;
 * `isActor(outerRecord)` is the IsA test; `destroyObjectBase` is
 * UObject::Destroy. */
export function constructRenderIterator(object, row, { write, isActor, destroyObjectBase }) {
  object.nativeVtable = RENDER_ITERATOR_NATIVE.objectVtable;
  write(object.identity, 'Index', 0);
  write(object.identity, 'Observer', null);
  object.nativeVtable = RENDER_ITERATOR_NATIVE.renderIteratorVtable;
  if (!isActor(object.outer)) throw new Error('URenderIterator requires an Actor Outer (UnRenderIterator.cpp:15)');
  object.nativeVtable = row.vtable;
  object.destroy = receiver => destroyObjectBase(receiver);
}
