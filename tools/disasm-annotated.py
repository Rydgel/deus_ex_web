#!/usr/bin/env python3
"""Disassemble address ranges of a hash-pinned GOTY DLL with names filled in.

Like tools/disasm-body.py, plus three annotations that make a long body readable:

* `call dword ptr [IAT slot]` and `jmp dword ptr [IAT slot]` name the import (demangled with llvm-undname);
* `call/jmp rel32` to an exported function, or to the body behind an exported `jmp rel32` thunk
  (Engine.dll exports its functions through such thunks), names the function;
* an immediate or displacement that points at a NUL-terminated UTF-16 or ASCII string in the image shows it.

    python3 tools/disasm-annotated.py DeusEx.dll 10010b90-10010d00 [...]
    python3 tools/disasm-annotated.py --list Engine.dll Browse     # exports whose name contains the words (and thunk targets)
    python3 tools/disasm-annotated.py --brief DeusEx.dll 10010b90-10011520   # drops the exception-state stores and string-copy loops
    python3 tools/disasm-annotated.py --notes DeusEx.dll 1000ef10-1000f9b0   # only calls, strings, tests and conditional jumps

Needs capstone (.cache/native-probe-env/bin/python has it) and llvm-undname (optional: names stay mangled without it).
"""
import re
import struct
import subprocess
import sys
from pathlib import Path

from capstone import Cs, CS_ARCH_X86, CS_MODE_32

ROOT = Path(__file__).resolve().parent.parent / "Deus Ex GOTY Edition" / "System"


class Image:
    def __init__(self, name):
        self.name = name
        self.data = (ROOT / name).read_bytes()
        d = self.data
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        nsec = struct.unpack_from("<H", d, pe + 6)[0]
        opt = struct.unpack_from("<H", d, pe + 20)[0]
        self.base = struct.unpack_from("<I", d, pe + 24 + 28)[0]
        self.size = struct.unpack_from("<I", d, pe + 24 + 56)[0]
        self.sections = []
        for i in range(nsec):
            o = pe + 24 + opt + i * 40
            sname = d[o:o + 8].rstrip(b"\0").decode()
            vs, va, rs, raw = struct.unpack_from("<IIII", d, o + 8)
            self.sections.append((sname, va, vs, raw, rs))
        self.dirs = [struct.unpack_from("<II", d, pe + 24 + 96 + 8 * i) for i in range(16)]
        self.exports = self._exports()
        self.imports = self._imports()

    def off(self, va):
        rva = va - self.base
        for _, sva, vs, raw, rs in self.sections:
            if sva <= rva < sva + max(vs, rs):
                return raw + rva - sva
        return None

    def off_rva(self, rva):
        return self.off(rva + self.base)

    def cstr(self, off):
        end = self.data.index(b"\0", off)
        return self.data[off:end].decode("latin1")

    def _exports(self):
        rva, size = self.dirs[0]
        if not rva:
            return {}
        e = self.off_rva(rva)
        nfn, nnames, afn, anames, aord = struct.unpack_from("<IIIII", self.data, e + 20)
        out = {}
        for i in range(nnames):
            nrva = struct.unpack_from("<I", self.data, self.off_rva(anames) + 4 * i)[0]
            ordi = struct.unpack_from("<H", self.data, self.off_rva(aord) + 2 * i)[0]
            frva = struct.unpack_from("<I", self.data, self.off_rva(afn) + 4 * ordi)[0]
            out[self.base + frva] = self.cstr(self.off_rva(nrva))
        return out

    def _imports(self):
        rva, size = self.dirs[1]
        out = {}
        if not rva:
            return out
        p = self.off_rva(rva)
        while True:
            oft, _, _, name, ft = struct.unpack_from("<IIIII", self.data, p)
            if not name:
                break
            dll = self.cstr(self.off_rva(name))
            lookup = self.off_rva(oft or ft)
            i = 0
            while True:
                v = struct.unpack_from("<I", self.data, lookup + 4 * i)[0]
                if not v:
                    break
                if v & 0x80000000:
                    nm = f"#{v & 0xffff}"
                else:
                    nm = self.cstr(self.off_rva(v) + 2)
                out[self.base + ft + 4 * i] = (dll, nm)
                i += 1
            p += 20
        return out

    def thunk_target(self, va):
        o = self.off(va)
        if o is not None and o + 5 <= len(self.data) and self.data[o] == 0xE9:
            rel = struct.unpack_from("<i", self.data, o + 1)[0]
            return va + 5 + rel
        return None


def demangle(names):
    names = sorted(set(n for n in names if n.startswith("?") or n.startswith("??")))
    if not names:
        return {}
    try:
        out = subprocess.run(["llvm-undname"], input="\n".join(names) + "\n", capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return {}
    res = {}
    # llvm-undname prints "<mangled>\n<demangled or error>\n\n" blocks
    for block in out.split("\n\n"):
        lines = [ln for ln in block.splitlines() if ln]
        if len(lines) == 2 and lines[0] in names and not lines[1].startswith("error"):
            res[lines[0]] = lines[1]
    return res


def string_at(img, va):
    o = img.off(va)
    if o is None:
        return None
    d = img.data
    # UTF-16LE
    n = 0
    while n < 160 and o + 2 * n + 1 < len(d):
        c = d[o + 2 * n] | (d[o + 2 * n + 1] << 8)
        if c == 0:
            break
        if not (32 <= c < 127 or c in (9, 10, 13)):
            n = -1
            break
        n += 1
    if n >= 2 and o + 2 * n + 1 < len(d) and d[o + 2 * n] == 0 and d[o + 2 * n + 1] == 0:
        return "L" + repr(d[o:o + 2 * n].decode("utf-16le"))
    n = 0
    while n < 160 and o + n < len(d):
        c = d[o + n]
        if c == 0:
            break
        if not (32 <= c < 127 or c in (9, 10, 13)):
            n = -1
            break
        n += 1
    if n >= 3 and o + n < len(d) and d[o + n] == 0:
        return repr(d[o:o + n].decode("ascii"))
    return None


def main():
    args = sys.argv[1:]
    brief = notes_only = False
    while args and args[0] in ("--brief", "--notes"):
        brief = True
        notes_only = notes_only or args[0] == "--notes"
        args = args[1:]
    if args and args[0] == "--list":
        img = Image(args[1])
        words = [w.lower() for w in args[2:]]
        dm = demangle(img.exports.values())
        for va, nm in sorted(img.exports.items()):
            full = dm.get(nm, nm)
            if all(w in nm.lower() or w in full.lower() for w in words):
                t = img.thunk_target(va)
                print(f"{va:#x}" + (f" -> {t:#x}" if t else "") + f"  {full}")
        return
    img = Image(args[0])
    names = {}
    dm = demangle(list(img.exports.values()) + [n for _, n in img.imports.values()])
    for va, nm in img.exports.items():
        names[va] = dm.get(nm, nm)
        t = img.thunk_target(va)
        if t:
            names[t] = names[va]
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    for spec in args[1:]:
        start, end = (int(x, 16) for x in spec.split("-"))
        print(f"=== {img.name} {start:#x} - {end:#x} ===")
        blob = img.data[img.off(start):img.off(start) + (end - start)]
        for insn in md.disasm(blob, start):
            note = ""
            op = insn.op_str
            if insn.mnemonic in ("call", "jmp") and op.startswith("dword ptr [0x"):
                a = int(op[len("dword ptr ["):-1], 16)
                if a in img.imports:
                    dll, nm = img.imports[a]
                    note = f"{dll}!{dm.get(nm, nm)}"
            elif insn.mnemonic in ("call", "jmp") and op.startswith("0x"):
                a = int(op, 16)
                if a in names:
                    note = names[a]
            else:
                # immediates and displacements that look like image addresses
                for tok in op.replace("[", " ").replace("]", " ").replace(",", " ").replace("+", " ").split():
                    if tok.startswith("0x"):
                        try:
                            a = int(tok, 16)
                        except ValueError:
                            continue
                        if img.base <= a < img.base + img.size:
                            s = string_at(img, a)
                            if s:
                                note = s
                                break
                            if a in img.imports:
                                dll, nm = img.imports[a]
                                note = f"[{dll}!{dm.get(nm, nm)}]"
                                break
                            if a in names:
                                note = names[a]
                                break
            if brief and (re.fullmatch(r"(byte|dword) ptr \[ebp - 4\], (0x[0-9a-f]+|\d+)", op) and insn.mnemonic == "mov"
                          or insn.mnemonic in ("rep movsd", "rep movsb", "int3", "nop") or (insn.mnemonic, op) in (("shr", "ecx, 2"), ("and", "ebx, 3"))):
                continue
            if notes_only and not note and insn.mnemonic not in ("ret", "cmp", "test") and not (insn.mnemonic.startswith("j") and insn.mnemonic != "jmp"):
                continue
            if notes_only and any(w in note for w in ("FString::~FString", "FArray::Realloc", "FString::operator", "UnTemplate", "appFailAssert", "Index<=", "Index+Count")):
                continue
            line = f"{insn.address:#x}: {insn.bytes.hex():<24} {insn.mnemonic} {op}"
            print(line + (f"    ; {note}" if note else ""))


if __name__ == "__main__":
    main()
