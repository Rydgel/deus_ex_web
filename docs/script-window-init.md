# XWindow initialization: recovered entry and open graph

Authority is installed Extension.dll SHA-256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
The normal `XWindow::Init(parent)` body spans `0x1004bb30`–`0x1004be89`
(the `ret 4` is at `0x1004be89`; the body byte range is file/RVA
`0x4bb30`–`0x4be8b`). It is the base virtual at slot `+0x54` reached by
CreateNewWindow; concrete class dispatch must still establish that the
selected subclass inherits it.

The unchanged body is executed by `scripts/native-window-init-oracle.py`.
`src/runtime/script-window-init.mjs` translates only its storage and call
order. `read(object, offset, type, details)` and
`write(object, offset, type, value, details)` are raw offset services. The
offset labels in the module are storage labels, not asserted script property
names.

The opening writes byte `+0x28=0` and the parent pointer at `+0x2c`. It reads
`+0x30`, changes only its low byte as `(old & 0xea)|2`, and retains the upper
24 bits. It writes `+0x34=0`. It reads `+0x38`, writes `(old & ~2)|1`, writes
`+0x3c=1`, rereads `+0x38`, then writes `old & ~4`. The first packed color and
the zero/one vector follow. It reads and writes `+0x74|1`, writes float `1`
at `+0x5c`, zeroes `+0x78/+0x7c`, writes float `10` at `+0x80/+0x84`, clears
bytes `+0x88/+0x89`, and zeroes `+0x8c/+0x90/+0x94/+0x98`. It reads `+0xb8`
before writing floats `-1` at `+0x9c/+0xa0`, then writes
`(old & ~4)|0x1b` to `+0xb8`. It writes floats `-1` at `+0xf8/+0xfc`, the
third packed color, reads `+0xcc`, writes zero to `+0xbc/+0xc0/+0xc4/+0xc8`,
writes `old & ~1` to `+0xcc`, then zeroes `+0xd0`, `+0xec`, `+0xf0`,
`+0x104/+0x108/+0x10c/+0x110/+0x118`, writes all-one dwords to
`+0x11c/+0x120`, and zeroes `+0x124/+0x128`.

The packed-color stores are deliberately raw. The body reuses the parent
argument slot `[ebp+8]` as a three-byte temporary and does not initialize its
fourth byte. If `p` is the 32-bit parent pointer word, the observed stores are:

| destination | initialized little-endian bytes | raw dword |
| --- | --- | --- |
| `+0x3d` | `00 ff 00`, then `p` byte 3 | `((p >>> 24) << 24) \| 0x0000ff00` |
| `+0x60` | `ff ff ff`, then `p` byte 3 | `((p >>> 24) << 24) \| 0x00ffffff` |
| `+0x100` | `ff ff ff`, then `p` byte 3 | `((p >>> 24) << 24) \| 0x00ffffff` |

For a null parent `p=0`, the fourth byte is zero. For a non-null parent it is
the parent pointer's high byte. This is observed stack residue; its semantic
padding/alpha status is unresolved, so the translation preserves the raw byte
and does not substitute an opaque alpha.

Before parent callbacks, Init performs two identical XGC sequences. Each
sequence calls the `FName(EName)` import through IAT `0x10059124` with enum
`0` (`NAME_None`), calls `XGC::operator new` at `0x10002c40` with size `0xb8`,
Outer `this`, that FName value, and flags `0`, then calls constructor
`0x10026ad0` when allocation is non-null. Results are written to `+0x130` and
`+0x134`, respectively. Pointers `+0x138` through `+0x148` are then zeroed.
These are explicit synchronous leaves in the translation; allocator, UObject
ownership, and XGC constructor bodies remain outside this boundary.

For a non-null parent, the exact order is `AddChild(parent,this,1)` at
`0x10050a80`, parent virtual `ChildAdded(this)` at slot `+0x68`, then
`DescendantAdded(this)` at slot `+0x70` on the parent and each ancestor. After
each DescendantAdded callback, the next ancestor is freshly read from the
current ancestor `+0x138`, so callback mutations affect the walk. AddChild's
full linked-list implementation is a separate leaf; Init only relies on its
publication of the child's `+0x138` parent link.

After that walk, Init freshly reads this `+0x138`, then reads height `+0x84`
and width `+0x80`. With a parent it reads parent `+0xd8` before parent `+0xd4`
and writes six floats at `+0xd4`: parent `+0xd4`, parent `+0xd8`, `0`, `0`,
current width, current height. Without a parent it writes `0`, `0`, `0`, `0`,
current width, current height.

The same parent pointer is then searched for the first non-null font pointer:
`+0x54` is tested first, `+0x58` second, and `+0x138` is freshly read only when
both are null. At the found owner, both `+0x54` and `+0x58` are reread and
copied to the child. If no owner is found, both child pointers are zeroed.
Init then rereads child `+0x130`; when non-null it rereads child `+0x58` and
`+0x54` in that order and calls `XGC::SetFonts` at `0x10027640` with the first
graphics context and those two pointers.

The focused validator compares the original unchanged body against the
translation for parent-null and parent-chain/font-inheritance fixtures:

    node scripts/validate-window-init.mjs

Class-specific constructors, full XGC lifecycles, AddChild's list mutations,
parent callback bodies, packed-color semantic layouts, and SetFonts internals
remain explicit boundaries before this Init body can enter Play.

The composed `scripts/validate-window-lifecycle-integration.mjs` now connects
this helper to the separately recovered Window/GC constructors, AddChild list
mutation, shared NewChild1410 and prepared original Window events. It preserves
canonical child/parent/GC identities, inherited origin/fonts, and the locked
InitWindow callback. The initial allocated/default-initialized storage,
Core allocation, SetFonts, visibility and reconfiguration are explicit fixtures;
the result establishes these integration boundaries, not full native UI startup.
