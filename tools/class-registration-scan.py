#!/usr/bin/env python3
"""Scan a DLL for UE1 native class registration sites.

Each registered class has a small body that pushes the UClass-constructor
arguments, sets ecx to the static class object, and calls the shared UClass
constructor (`??0UClass@@QAE@W4ENativeConstructor@@...`) through an import.
The pushes are interleaved with register moves and a `sub esp, 0x10` GUID
block, and some DLLs push the ctor/name via `mov reg, [IAT]` + `push reg`.

The scan anchors on the raw bytes `FF 15 <ctor-IAT>` (linear disassembly
desyncs on embedded data in some images), disassembles the preceding window,
and gathers `push imm32` plus register pushes fed by `mov reg, [IAT cell]`.
The class name is the last pushed string (UTF-16 or ASCII) that is not the
package name; the InternalConstructor is the pushed .text address or an
`?InternalConstructor@...` import.

Usage: class-registration-scan.py <install-root> <dll> [dll...]
Emits TSV: dll<TAB>name<TAB>static<TAB>internalCtor<TAB>site<TAB>ctorSymbol
"""
import re
import struct
import sys
from pathlib import Path
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

ROOT = Path(sys.argv[1])
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{1,63}$")


def load(dll):
    data = (ROOT / "System" / dll).read_bytes()
    pe = int.from_bytes(data[60:64], "little")
    opt = pe + 24
    base = int.from_bytes(data[opt + 28:opt + 32], "little")
    section = opt + int.from_bytes(data[pe + 20:pe + 22], "little")
    count = int.from_bytes(data[pe + 6:pe + 8], "little")
    sections = []
    for i in range(count):
        s = section + i * 40
        name = data[s:s + 8].rstrip(b"\0").decode()
        vsize, virtual, rsize, raw = (
            int.from_bytes(data[s + 8 + j * 4:s + 12 + j * 4], "little")
            for j in range(4)
        )
        sections.append(dict(name=name, virtual=virtual, vsize=vsize,
                             raw=raw, rsize=rsize))
    return data, base, sections


def to_file(sections, va, base):
    for s in sections:
        if s["virtual"] <= va - base < s["virtual"] + max(s["vsize"], s["rsize"]):
            return s["raw"] + va - base - s["virtual"]
    return None


def wide_string(data, off):
    out = []
    while off + 1 < len(data):
        lo, hi = data[off], data[off + 1]
        if lo == 0 and hi == 0:
            break
        if hi != 0 or not (0x20 <= lo < 0x7f):
            return None
        out.append(chr(lo))
        off += 2
    return "".join(out) if out else None


def ascii_string(data, off):
    end = off
    while end < len(data) and 0x20 <= data[end] < 0x7f:
        end += 1
    if end > off and end < len(data) and data[end] == 0:
        return data[off:end].decode()
    return None


def import_symbols(data, base, sections):
    """IAT cell VA -> imported symbol name, from the import directory."""
    opt = int.from_bytes(data[60:64], "little") + 24
    idir_rva = int.from_bytes(data[opt + 104:opt + 108], "little")

    def rva2file(rva):
        for s in sections:
            if s["virtual"] <= rva < s["virtual"] + max(s["vsize"], s["rsize"]):
                return s["raw"] + rva - s["virtual"]
        return None

    out = {}
    o = rva2file(idir_rva)
    while o is not None:
        vals = struct.unpack_from("<5I", data, o)
        if vals[0] == 0 and vals[4] == 0:
            break
        oft, ift = vals[0], vals[4]
        to = rva2file(oft)
        i = 0
        while to is not None:
            t = struct.unpack_from("<I", data, to + i * 4)[0]
            if t == 0:
                break
            if t & 0x80000000 == 0:
                ho = rva2file(t)
                if ho is not None:
                    end = data.find(b"\0", ho + 2)
                    out[base + ift + i * 4] = data[ho + 2:end].decode(errors="replace")
            i += 1
        o += 20
    return out


def scan(dll, internal_thunks=()):
    data, base, sections = load(dll)
    text = next(s for s in sections if s["name"] == ".text")
    package = dll[:-4].lower()
    imports = import_symbols(data, base, sections)
    ctor_cells = [va for va, sym in imports.items()
                  if sym.startswith("??0UClass@@QAE@W4ENativeConstructor")]
    blob = data[text["raw"]:text["raw"] + text["rsize"]]
    va0 = base + text["virtual"]
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    rows = []
    sites = set()
    thunk_targets = list(internal_thunks)
    for cell in ctor_cells:
        needle = b"\xff\x15" + struct.pack("<I", cell)
        idx = 0
        while True:
            idx = blob.find(needle, idx)
            if idx < 0:
                break
            sites.add(idx)
            idx += 1
        # `jmp [iat]` thunks reach the same ctor via `call rel32`.
        needle = b"\xff\x25" + struct.pack("<I", cell)
        idx = 0
        while True:
            idx = blob.find(needle, idx)
            if idx < 0:
                break
            thunk_targets.append(va0 + idx)
            idx += 1
    # Internal `call rel32` anchors (Core.dll calls its own ctor via a thunk;
    # other DLLs call their `jmp [iat]` thunk).
    for thunk in thunk_targets:
        idx = 0
        while True:
            idx = blob.find(b"\xe8", idx)
            if idx < 0:
                break
            rel = struct.unpack_from("<i", blob, idx + 1)[0]
            if va0 + idx + 5 + rel == thunk:
                sites.add(idx)
            idx += 1
    for site_off in sorted(sites):
        site_va = va0 + site_off
        # Registration bodies sit between int3/nop padding runs: find the
        # nearest padding run before the site and disassemble from its end so
        # instruction boundaries align.
        win_start = max(0, site_off - 160)
        probe = site_off - 1
        while probe > max(0, site_off - 200):
            if blob[probe] in (0xcc, 0x90):
                run_end = probe + 1
                while probe > 0 and blob[probe - 1] in (0xcc, 0x90):
                    probe -= 1
                if run_end - probe >= 4:
                    win_start = run_end
                    break
            probe -= 1
        window = list(md.disasm(blob[win_start:site_off + 6], va0 + win_start))
        ecx_va = None
        pushes = []
        reg_from = {}
        for p in window:
            if p.mnemonic == "mov":
                dst, _, src = p.op_str.partition(", ")
                src = src.strip()
                if src.startswith("dword ptr [0x"):
                    try:
                        reg_from[dst.strip()] = int(src[12:-1], 16)
                    except ValueError:
                        pass
                elif src.startswith("0x"):
                    reg_from.pop(dst.strip(), None)
                    if dst.strip() == "ecx":
                        try:
                            ecx_va = int(src, 16)
                        except ValueError:
                            pass
                else:
                    reg_from.pop(dst.strip(), None)
            elif p.mnemonic == "xor" and p.op_str.split(",")[0].strip() in reg_from:
                del reg_from[p.op_str.split(",")[0].strip()]
            elif p.mnemonic == "push":
                op = p.op_str.strip()
                if op.startswith("0x"):
                    pushes.append(("imm", int(op, 16)))
                elif op in reg_from:
                    pushes.append(("import", reg_from[op]))
        if ecx_va is None or to_file(sections, ecx_va, base) is None:
            continue
        name = None
        for kind, value in pushes:
            if kind != "imm":
                continue
            off = to_file(sections, value, base)
            if off is None:
                continue
            s = wide_string(data, off) or ascii_string(data, off)
            if s and NAME_RE.match(s) and s.lower() != package and s != "System":
                name = s
        if name is None:
            continue
        ctor = ctor_symbol = None
        for kind, value in pushes:
            if kind == "imm":
                off = to_file(sections, value, base)
                if off is not None and text["raw"] <= off < text["raw"] + text["rsize"]:
                    ctor = value
            elif (sym := imports.get(value)) and "InternalConstructor" in sym:
                ctor_symbol = sym
        rows.append((name, ecx_va, ctor, site_va, ctor_symbol))
    return rows


# Core.dll calls its own UClass ctor through the internal thunk 0x10102d9c
# (shared body 0x10128630) rather than an IAT import.
INTERNAL_THUNKS = {"Core.dll": [0x10102d9c]}

for dll in sys.argv[2:]:
    try:
        rows = scan(dll, INTERNAL_THUNKS.get(dll, ()))
    except Exception as e:
        print(f"{dll}: {e}", file=sys.stderr)
        continue
    for name, static, ctor, site, sym in rows:
        print(f"{dll}\t{name}\t{static:#x}\t{ctor if ctor else 0:#x}\t{site:#x}\t{sym or ''}")
