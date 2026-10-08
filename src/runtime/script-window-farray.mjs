/** FArray over native-heap storage ({Data, Num, Max} at an object offset): the
 * Core FArray operations the window natives use (Realloc through GMalloc,
 * Empty, Add with the 3/8 + 32 growth, Remove). Shared by the window host and
 * the exec-body validators. */
export function createWindowFArray(W, heap) {
  const farray = {
    construct: (o, off) => { W.setU32(o, off, 0); W.setU32(o, off + 4, 0); W.setU32(o, off + 8, 0); },
    num: (o, off) => W.i32(o, off + 4),
    data: (o, off) => W.u32(o, off),
    // FArray::Realloc: GMalloc->Realloc moves the data and frees the old block
    // (a zero capacity frees it outright).
    realloc(o, off, elementSize) {
      const max = W.i32(o, off + 8), num = W.i32(o, off + 4), old = W.u32(o, off);
      if (max <= 0) { W.setU32(o, off, 0); if (old) heap.freeRaw(old); return; }
      const address = heap.allocRaw(max * elementSize);
      if (old) { heap.copyBytes(address,old,Math.min(num,max)*elementSize); heap.freeRaw(old); }
      W.setU32(o, off, address);
    },
    empty(o, off, elementSize, slack = 0) { W.setI32(o, off + 4, 0); W.setI32(o, off + 8, slack); farray.realloc(o, off, elementSize); },
    add(o, off, count, elementSize) {
      const index = W.i32(o, off + 4), num = index + count;
      W.setI32(o, off + 4, num);
      if (num > W.i32(o, off + 8)) { W.setI32(o, off + 8, num + Math.trunc((3 * num) / 8) + 32); farray.realloc(o, off, elementSize); }
      return index;
    },
    remove(o, off, index, count, elementSize) {
      const data = W.u32(o, off), num = W.i32(o, off + 4);
      heap.copyBytes(data+index*elementSize,data+(index+count)*elementSize,(num-index-count)*elementSize);
      W.setI32(o, off + 4, num - count);
    },
    ptr: (o, off, i) => heap.mem.read(W.u32(o, off) + 4 * i, 'ptr'),
    setPtr: (o, off, i, v) => heap.mem.write(W.u32(o, off) + 4 * i, 'ptr', v),
    qsort(o, off, compare) {
      const n = W.i32(o, off + 4), items = [];
      for (let i = 0; i < n; i++) items.push(farray.ptr(o, off, i));
      items.sort(compare);
      items.forEach((item, i) => farray.setPtr(o, off, i, item));
    },
  };
  return farray;
}
