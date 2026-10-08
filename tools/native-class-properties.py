#!/usr/bin/env python3
"""Recover the properties a UE1 native class registers in StaticConstructor.

Every shipped native class declares its properties with the same compiled
pattern (UnObjBas.h's `new(GetClass(),TEXT("Name"),RF_Public) UXProperty(
CPP_PROPERTY(Member), TEXT("Category"), Flags)`):

    push 1 ; push <wide name> ; call [FName::FName(const TCHAR*, EFindName)]
    call [UObject::GetClass]   ; push <sizeof> ; call [UXProperty::operator new]
    push <flags> ; push <wide category> ; push <offset> ; push 0 ; call <UXProperty ctor>
    [mov dword ptr [esi+0x5c], <bool mask | enum pointer>]

This prints one record per property: name, property class (from the operator-new
import), member offset, flags, category and the +0x5c word (a bool's bit mask
or a byte's enum object), in registration order.

    python3 tools/native-class-properties.py Engine 0x10375010-0x10375e00
    python3 tools/native-class-properties.py Galaxy 0x10604f00-0x10606000 --json
    python3 tools/native-class-properties.py Galaxy 0x10604c00-0x10604dc0 --names   (every FName created: enum entries)
"""
import json, re, struct, sys
from pathlib import Path
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_IMM, X86_OP_MEM

root = Path(__file__).resolve().parent.parent / 'Deus Ex GOTY Edition' / 'System'
dll = sys.argv[1] + ('.dll' if not sys.argv[1].endswith('.dll') else '')
start, end = (int(x, 16) for x in sys.argv[2].split('-'))
data = (root / dll).read_bytes()
pe = struct.unpack_from('<I', data, 60)[0]; opt = pe + 24
base = struct.unpack_from('<I', data, opt + 28)[0]
nsec = struct.unpack_from('<H', data, pe + 6)[0]; osz = struct.unpack_from('<H', data, pe + 20)[0]
secs = []
for i in range(nsec):
    o = opt + osz + i * 40
    vs, va, rs, raw = struct.unpack_from('<IIII', data, o + 8)
    secs.append((va, vs, raw, rs))
def v2f(v):
    for va, vs, raw, rs in secs:
        if va <= v - base < va + max(vs, rs): return raw + v - base - va
def wide(v):
    f = v2f(v); out = []
    while True:
        u = struct.unpack_from('<H', data, f)[0]
        if not u: return ''.join(out)
        out.append(chr(u)); f += 2
# IAT slot -> import name
imports = {}
imp = struct.unpack_from('<I', data, opt + 96 + 8)[0]
p = v2f(base + imp)
while True:
    oft, _, _, name_rva, ft = struct.unpack_from('<IIIII', data, p)
    if not name_rva: break
    t = v2f(base + (oft or ft)); a = base + ft
    while True:
        v = struct.unpack_from('<I', data, t)[0]
        if not v: break
        if not v & 0x80000000: imports[a] = data[v2f(base + v) + 2:].split(b'\0')[0].decode()
        t += 4; a += 4
    p += 20

md = Cs(CS_ARCH_X86, CS_MODE_32); md.detail = True
code = data[v2f(start):v2f(end)]
pushes, records, current, names = [], [], None, []
registers = {}          # register -> import name loaded with `mov reg, [IAT]`
for ins in md.disasm(code, start):
    op = ins.operands
    if ins.mnemonic == 'push' and op[0].type == X86_OP_IMM:
        pushes.append(op[0].imm & 0xffffffff)
        pushes = pushes[-6:]
        continue
    if ins.mnemonic == 'mov' and len(op) == 2 and op[0].type == 1 and op[1].type == X86_OP_MEM and op[1].mem.base == 0 and op[1].mem.index == 0:
        registers[ins.reg_name(op[0].reg)] = imports.get(op[1].mem.disp & 0xffffffff, '')
        continue
    if ins.mnemonic == 'call':
        target = None
        if op[0].type == X86_OP_MEM and op[0].mem.base == 0 and op[0].mem.index == 0:
            target = imports.get(op[0].mem.disp & 0xffffffff, '')
        elif op[0].type == 1:                       # call <register>
            target = registers.get(ins.reg_name(op[0].reg), '')
        if target and target.startswith('??0FName@@QAE@PBGW4EFindName@@@Z') and len(pushes) >= 2:
            names.append((ins.address, wide(pushes[-1])))
            current = {'name': wide(pushes[-1])}
            pushes = []
        elif target and target.startswith('??2U') and 'Property@@SAPAX' in target and current is not None:
            current['class'] = re.match(r'\?\?2(U\w+Property)@@', target).group(1)
            pushes = []
        elif target and target.startswith('??0UProperty@@QAE@W4ECppProperty@@HPBGK@Z') and current is not None and 'class' in current and len(pushes) >= 4:
            flags, category, offset, zero = pushes[-4:]
            if zero == 0:
                current.update(flags=flags, category=wide(category) if v2f(category) else None, offset=offset)
                records.append(current)
            pushes = []
        continue
    if ins.mnemonic == 'ret' and records:
        break
    if ins.mnemonic == 'mov' and records and op[0].type == X86_OP_MEM and op[0].mem.disp == 0x5c and op[1].type == X86_OP_IMM:
        records[-1]['word5c'] = op[1].imm & 0xffffffff
if '--names' in sys.argv:
    for address, text in names: print(f'0x{address:08x} {text}')
    sys.exit()
if '--json' in sys.argv:
    print(json.dumps(records, indent=1))
else:
    for r in records:
        print(f"{r['name']:<26} {r['class']:<16} +0x{r['offset']:03x} flags 0x{r['flags']:x} {r.get('category')!s:<10}" + (f" word5c 0x{r['word5c']:x}" if 'word5c' in r else ''))
