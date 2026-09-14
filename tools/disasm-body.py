#!/usr/bin/env python3
"""Disassemble an address range of the hash-pinned GOTY Core.dll."""
import sys
from pathlib import Path
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "Deus Ex GOTY Edition"
DLL = ROOT / "System" / (sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].endswith(".dll") else "Core.dll")
data = DLL.read_bytes()
pe = int.from_bytes(data[60:64], "little")
opt = pe + 24
base = int.from_bytes(data[opt + 28:opt + 32], "little")
section = opt + int.from_bytes(data[pe + 20:pe + 22], "little")
count = int.from_bytes(data[pe + 6:pe + 8], "little")
sections = []
for i in range(count):
    s = section + i * 40
    name = data[s:s + 8].rstrip(b"\0").decode()
    vsize, virtual, rsize, raw = (int.from_bytes(data[s + 8 + j * 4:s + 12 + j * 4], "little") for j in range(4))
    sections.append((name, virtual, vsize, raw, rsize))

def to_file(va):
    for name, virtual, vsize, raw, rsize in sections:
        if virtual <= va - base < virtual + max(vsize, rsize):
            return raw + va - base - virtual
    return va - base

md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = True

ranges = []
for spec in sys.argv[2:]:
    if spec.endswith(".dll"):
        continue
    start, end = (int(x, 16) for x in spec.split("-"))
    ranges.append((start, end))

for start, end in ranges:
    print(f"=== {start:#x} - {end:#x} ===")
    blob = data[to_file(start):to_file(end)]
    for insn in md.disasm(blob, start):
        print(f"{insn.address:#x}: {insn.bytes.hex():<24} {insn.mnemonic} {insn.op_str}")
