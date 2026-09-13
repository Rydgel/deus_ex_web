# Native window hierarchy queries

Original Extension.dll (SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`)
exports GetRootWindow at `1004c5a0`; its Window.GetRootWindow thunk is
`10051ea0`, native1425, Extension.u export1171. The thunk consumes no
arguments and writes the exact returned pointer.

The helper starts at the receiver and repeatedly reads the pointer at+138.
It stops at the first null parent. Only then it reads the final window's
byte at+28 and returns that object if the unsigned byte is at least3;
otherwise it returns null. The comparison at `1004c5b6` uses `jae`, so this
is not equality with3. These are native hierarchy/type fields; UObject.Outer
at+18 must not be used as a substitute for the parent link.

The original null-receiver path still dereferences byte+28 and faults. The
host rejects null/unresolved receivers and cyclic/malformed hierarchy
fixtures as unsupported instead of inventing a null result for them.
The translator preserves each traversal read and the final type-byte read.
Native queries do not construct, reparent, initialize or destroy windows.

## Child list mutation

XWindow::AddChild at `10050a80` takes `(child, front)`; Init passes front1.
Null child returns without reads/writes. A non-null child with a parent at+138
first calls that parent's RemoveChild (`10050a00`). The native links are:
parent+13c first/lower endpoint, parent+140 last/higher endpoint,
child+144 lower sibling, child+148 higher sibling, child+138 parent.

For front!=0, AddChild reads parent+140, writes child+148=null and
child+144=that endpoint, then rereads parent+140. If null it writes both
parent endpoints to child; otherwise it writes endpoint+148=child and
parent+140=child. For front0 it writes child+144=null, reads parent+13c into
child+148, rereads that endpoint and writes its+144 (or parent+140 if null)
to child, then parent+13c=child. Both paths finally write child+138=parent.

RemoveChild first reads child+144, reconnecting that sibling's+148 or the
parent's+13c from child+148. It then rereads child+148, reconnecting that
sibling's+144 or parent's+140 from child+144. Finally it clears the child's
+148, +144, +138, in that order. Null child is a no-op. These helpers send
no script events; the Init caller sends ChildAdded/DescendantAdded later.
Services preserve raw pointer identity and every read/write in instruction
order; they do not use an array that could hide sibling or endpoint state.
