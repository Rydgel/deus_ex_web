# Core `Object.At_StrStr` native 168

The installed GOTY `Core.u` declaration is:

```unrealscript
native(168) static final operator(40) string @ (coerce string A, coerce string B);
```

The authority is the hash-pinned original image, not Unreal or JavaScript
string semantics. `Core.dll` has SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4` and
`Core.u` has SHA-256
`4fb22ee4e3a6868dfabb2b46b15fad8e5094f5fda5927a14ff11670a744ec36c`.

## Native body

The export thunk at `0x10101e2e` is `e9 fd 8d 03 00` and enters the unchanged
body at `0x1013ac30`. The body:

1. Evaluates `A`, advances `FFrame.Code`, and evaluates `B`.
2. Consumes `EndFunctionParms`, so the cursor advances three expression bytes
   for the two string operands and the terminator.
3. At `0x1013acaa`, passes `0x101aafcc` to the `FString(PWSTR)` path, appending
   that static TCHAR to `A`.
4. Calls `FString::operator+(FString const&)` at `0x1013acc9` to append `B`.
5. Copies the resulting three-word FString to the caller's return slot through
   `0x1013ad29`, then destroys its temporary arrays.

The original-instruction oracle is [native-at-string-oracle.py](../scripts/native-at-string-oracle.py).
Its evaluator, `wcscpy`, and `GMalloc.Free` bridges expose ABI results while
the Core body and data remain the hash-verified image. The result cases include
empty operands, non-ASCII UTF-16, and a supplementary-plane pair. Every case
advances the cursor by three bytes and copies the static separator first.

## Separator data and initializer audit

The target address is not a virtual-only tail. The PE has image base
`0x10100000`; therefore `0x101aafcc` is RVA `0xaafcc`. `.data` starts at RVA
`0xa7000`, has raw pointer `0xa7000`, and raw size `0xd000`, so this RVA is raw
file offset `0xaafcc` (`0x3fcc` bytes into `.data`). The four bytes there are:

```text
20 00 00 00
```

That is a little-endian UTF-16 `TCHAR` U+0020 followed by its terminator:
`L" "`. The next raw bytes begin the adjacent `%s` format literal. The
initialized value is established directly from original PE data.

These are the exact static searches used during the audit:

```sh
rg -n -i "101aafcc|1aafcc" .cache/research/Core.asm .cache/reference/Core-rng.asm
```

The only code reference is:

```text
1013acaa: 68 cc af 1a 10    pushl $0x101aafcc
```

The corresponding raw-byte and relocation checks are reproducible with this
short PE query (run outside Git against the installed binary):

```sh
python3 - <<'PY'
from pathlib import Path
import struct
p = Path('Deus Ex GOTY Edition/System/Core.dll')
d = p.read_bytes()
print('literal', d[0xaafcc:0xaafcc + 4].hex())
needle = bytes.fromhex('cc af 1a 10')
print('absolute-pointer-occurrences', d.count(needle), 'first', hex(d.find(needle)))
pe = struct.unpack_from('<I', d, 0x3c)[0]
opt = pe + 24
reloc_rva, reloc_size = struct.unpack_from('<II', d, opt + 96 + 5 * 8)
section = opt + struct.unpack_from('<H', d, pe + 20)[0]
sections = [struct.unpack_from('<8sIIII', d, section + i * 40)
            for i in range(struct.unpack_from('<H', d, pe + 6)[0])]
def raw(rva):
    for _, vsize, va, rsize, offset in sections:
        if va <= rva < va + max(vsize, rsize):
            return offset + rva - va
    return rva
hits = []
cursor = reloc_rva
while cursor < reloc_rva + reloc_size:
    page, block_size = struct.unpack_from('<II', d, raw(cursor))
    for pos in range(cursor + 8, cursor + block_size, 2):
        entry, = struct.unpack_from('<H', d, raw(pos))
        target = page + (entry & 0xfff)
        if entry >> 12 == 3 and target == 0xaafcc:
            hits.append(hex(target))
    cursor += block_size
print('relocation-targets', hits)
PY
```

It prints `literal 20000000`, one absolute-pointer occurrence at
`0x3acab`, and `relocation-targets []`.

The raw absolute pointer also occurs exactly once in the DLL, at file offset
`0x3acab`, which is that instruction's immediate. The relocation directory is
at RVA `0x1ac000` (raw `0xb5000`, size `0x8714`); parsing all 131 blocks and
16,696 entries finds no relocation for RVA `0xaafcc` or its vicinity. No loader
data fixup is involved.

The Core CRT route is `_DllMainCRTStartup 0x1016f14f` → `_CRT_INIT
0x1016f0a4` → `_initterm(0x101a7000, 0x101a78a4)` (553 entries). The existing
[`native-boot-replay.py`](../scripts/native-boot-replay.py) ran the Core,
Engine, and Window initializer arrays and `FName::StaticInit`; a write hook
over `0x101aafcc` recorded no writes and the mapped bytes stayed
`20 00 00 00`. Thus there is no missing startup assignment to recover: the
separator is already present in the raw `.data` image.

For a future retail-process check, build the existing read-only capture tools
under Windows/CrossOver, find the loaded Core base, and read the RVA rather
than assuming the preferred base:

```text
coreBase = module_base(pid, "Core.dll")
separatorAddress = coreBase + 0xaafcc
ReadProcessMemory(process, separatorAddress, 4 bytes)
```

The repository helper is [`tools/dump-gobjects.py`](../tools/dump-gobjects.py),
whose `module_base` and `Reader` implement those calls. To identify a startup
writer rather than only the steady-state value, launch the installed game
under a 32-bit debugger, break at `coreBase + 0x6f14f`
(`Core!_DllMainCRTStartup`, preferred VA `0x1016f14f`), resolve the same
`coreBase + 0xaafcc`, and set a four-byte write watchpoint there. Continue
through `_CRT_INIT` (`coreBase + 0x6f0a4`) and `_initterm`; record the triggering
EIP and call stack if it fires, then read the four bytes again after the title
screen. The emulator audit produced no trigger, consistent with the raw
literal.

## Runtime contract

The existing string VM registers native 168 as `scriptAt(left, right)`, which
requires typed strings and returns:

```text
A + L" " + B
```

The logical adapter rejects independently stored embedded-zero units because
the browser FString adapter cannot preserve their native allocation/count
metadata. The original probe observed that native storage boundary separately:
terminated output text truncates at the first zero while an owned temporary can
still contain later units. This remains an explicit unsupported adapter edge,
not a claim that the original native strips those units.

Run the focused validator with the local probe environment:

```sh
DEUS_EX_NATIVE_PYTHON=.cache/native-probe-env/bin/python \
  node scripts/validate-native-at-string.mjs
node --test test/script-string-operations.test.mjs
```

Both checks cover the original separator bytes, thunk/body addresses,
Core.u metadata, FFrame order and cursor advance, FString count/capacity,
translated result, and VM dispatch.
