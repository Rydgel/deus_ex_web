/**
 * Recovered Extension.dll UGC::PushGC translation (native 1271,
 * method body 0x100278d0, exec trampoline 0x1002bf60).
 *
 * Returns the depth (+0xa8) before the push.  `this` is ecx:
 *   if +0xb4 (owner) is non-null the object is itself a saved node and the
 *   method returns the old depth untouched.  Otherwise the free-list head
 *   +0xb0 is reused if present (+0xb0 = head+0xac, then head.CopyGC(this));
 *   else a new UGC is allocated through UGC::operator new (0x10002c40 ->
 *   UObject::StaticAllocateObject(&UGC::PrivateStaticClass, this,
 *   FName(NAME_None), 0, 0, GError, 0)) and initialised by the copy-ctor
 *   0x10026c70 (UObject::UObject(), vtable 0x100598dc, zero +0x2c..+0x40,
 *   CopyGC(this), +0xa4 &= ~1, +0xac = +0xb0 = +0xb4 = 0, +0xa8 = 1).  A
 *   null allocation returns the old depth.  The node is then linked:
 *   node+0xb4 = this, node+0xa4 &= ~1, node+0xb0 = 0,
 *   node+0xa8 = this+0xa8, node+0xac = this+0xac, this+0xac = node,
 *   this+0xa8 += 1.
 * The exec body evaluates no params: it advances the frame code pointer,
 * calls the method, and stores the returned dword in the result slot.
 */
import {gcCopyGC} from './script-gc-copy-gc.mjs';
import {GC, GC_DLL, GC_VTABLE, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_PUSH_GC_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.PushGC',
  packageExport: 2094,
  nativeIndex: 1271,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002bf60,
  execEnd: 0x1002bf75,
  execSha256: '672c537c38a285486801d39655f6da83e8a928de04e70eb7c5bcc067a6996080',
  methodBody: 0x100278d0,
  methodEnd: 0x100279ec,
  methodSha256: '2f2ca473868ea767fe36c97e3b67abaa26f8168d2d38b2595dfe588f44e9e6e6',
});

export class GcPushGcBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcPushGcBoundaryError';
    this.code = `GC_PUSH_GC_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcPushGcBoundaryError(message, details);
};

/**
 * Copy-ctor 0x10026c70: UObject::UObject() on the fresh node (event), vtable
 * write, zero +0x2c..+0x40, CopyGC(source), then node-flag/pointer/depth
 * initialisation.
 */
export function gcConstructGC(node, source, L, services) {
  // Core UObject::UObject() base constructor (Extension IAT 0x1005907c) is a host leaf.
  services.constructUObject(node);
  L.write(node + GC.vtable, 'u32', GC_VTABLE);
  for (let offset = GC.originX; offset <= GC.clipHeight; offset += 4)
    L.write(node + offset, 'u32', 0);
  gcCopyGC({base: node}, source, services);
  L.write(node + GC.nodeFlags, 'u32', L.read(node + GC.nodeFlags, 'u32') & ~1);
  L.write(node + GC.stackTop, 'u32', 0);
  L.write(node + GC.freeList, 'u32', 0);
  L.write(node + GC.owner, 'u32', 0);
  L.write(node + GC.depth, 'i32', 1);
}

export function gcPushGC(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.PushGC requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const self = L.base;
  const depth = L.read(self + GC.depth, 'i32');
  if (L.read(self + GC.owner, 'u32') !== 0) return depth;
  let node = L.read(self + GC.freeList, 'u32');
  if (node !== 0) {
    L.write(self + GC.freeList, 'u32', L.read(node + GC.stackTop, 'u32'));
    gcCopyGC({base: node}, self, services);
  } else {
    if (typeof services.allocateObject !== 'function' || typeof services.constructUObject !== 'function')
      fail('GC.PushGC requires services.allocateObject/constructUObject', {kind: 'SERVICE'});
    node = services.allocateObject({outer: self, size: GC.size});
    if (globalThis.__gcAllocLog) globalThis.__gcAllocLog.push({tick: globalThis.__liveTick ?? null, window: globalThis.__gcWindow ?? null, stack: new Error('gc alloc').stack});   // (live-acceptance.mjs play --gc-trace)
    if (!node) return depth;
    gcConstructGC(node, self, L, services);
  }
  if (node === 0) return depth;
  L.write(node + GC.owner, 'u32', self);
  L.write(node + GC.nodeFlags, 'u32', L.read(node + GC.nodeFlags, 'u32') & ~1);
  L.write(node + GC.freeList, 'u32', 0);
  L.write(node + GC.depth, 'i32', L.read(self + GC.depth, 'i32'));
  L.write(node + GC.stackTop, 'u32', L.read(self + GC.stackTop, 'u32'));
  L.write(self + GC.stackTop, 'u32', node);
  L.write(self + GC.depth, 'i32', L.read(self + GC.depth, 'i32') + 1);
  return depth;
}

export const execGcPushGC = gcPushGC;
