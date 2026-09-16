/**
 * Recovered Extension.dll UGC::PopGC translation (native 1272,
 * exec trampoline 0x1002bfa0; PopGC(-1) body 0x100279f0 and RestoreGC(n)
 * 0x10027a80, contiguous span 0x100279f0..0x10027b7d).
 *
 * The exec preinitialises the param slot to 0xffffffff (the optional
 * gcNum = -1 default), evaluates one dword, then dispatches: gcNum == -1
 * calls 0x100279f0 which restores to `top ? top+0xa8 : this+0xa8 - 1`;
 * any other value calls 0x10027a80(gcNum).
 *
 * 0x10027a80(n): return if n >= this+0xa8 or this+0xb4 != 0.  Walk
 * node = this+0xac while node && node+0xa8 >= n: unlink the node
 * (this+0xac = node+0xac, this+0xa8 = node+0xa8) and move it to the free
 * list (node+0xa8 = free ? free+0xa8 + 1 : 1, node+0xb4 = this,
 * node+0xa4 |= 1, node+0xac = this+0xb0, node+0xb0 = 0, this+0xb0 = node),
 * stopping after the node whose depth equalled n.  If any node was
 * unlinked, CopyGC(lastUnlinkedNode) restores its state into `this`.
 */
import {gcCopyGC} from './script-gc-copy-gc.mjs';
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_POP_GC_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.PopGC',
  packageExport: 2096,
  nativeIndex: 1272,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002bfa0,
  execEnd: 0x1002bff8,
  execSha256: '704bd6dbb75cfbafe35c81ae4da701da363279be086ccb3cece7d5ba847e0f93',
  methodBody: 0x100279f0,
  methodEnd: 0x10027b7d,
  methodSha256: 'ac6316d80d9266f1c521fb9c2df10dea9d8b9cd9b12f33f65a92673cff2f9aef',
});

export class GcPopGcBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcPopGcBoundaryError';
    this.code = `GC_POP_GC_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcPopGcBoundaryError(message, details);
};

/** RestoreGC body 0x10027a80. */
export function gcRestoreGC(object, n, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.PopGC requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  const self = L.base;
  n |= 0;
  if (n >= L.read(self + GC.depth, 'i32')) return;
  if (L.read(self + GC.owner, 'u32') !== 0) return;
  let found = false;
  let last = 0;
  let node = L.read(self + GC.stackTop, 'u32');
  while (node !== 0) {
    const nodeDepth = L.read(node + GC.depth, 'i32');
    if (nodeDepth < n) break;
    if (nodeDepth === n) found = true;
    last = node;
    const next = L.read(node + GC.stackTop, 'u32');
    L.write(self + GC.stackTop, 'u32', next);
    L.write(self + GC.depth, 'i32', nodeDepth);
    const free = L.read(self + GC.freeList, 'u32');
    L.write(node + GC.depth, 'i32',
      free ? L.read(free + GC.depth, 'i32') + 1 : 1);
    L.write(node + GC.owner, 'u32', self);
    L.write(node + GC.nodeFlags, 'u32', L.read(node + GC.nodeFlags, 'u32') | 1);
    L.write(node + GC.stackTop, 'u32', L.read(self + GC.freeList, 'u32'));
    L.write(node + GC.freeList, 'u32', 0);
    L.write(self + GC.freeList, 'u32', node);
    if (found) break;
    node = next;
  }
  if (last) gcCopyGC(object, last, services);
}

export function gcPopGC(object, gcNum, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.PopGC requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof gcNum !== 'number' || !Number.isInteger(gcNum))
    fail('GC.PopGC requires an integer gcNum', {kind: 'VALUE', value: gcNum});
  if ((gcNum | 0) === -1) {
    const L = gcMemory(object, services);
    const top = L.read(L.base + GC.stackTop, 'u32');
    const target = top ? L.read(top + GC.depth, 'i32')
      : L.read(L.base + GC.depth, 'i32') - 1;
    gcRestoreGC(object, target, services);
  } else {
    gcRestoreGC(object, gcNum | 0, services);
  }
}

export const execGcPopGC = gcPopGC;
