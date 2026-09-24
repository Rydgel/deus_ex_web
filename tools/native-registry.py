#!/usr/bin/env python3
"""Resolve the native-index -> thunk -> body table for a shipped Deus Ex DLL.

Every UE1 DLL registers its natives through the same compiled stub:

    push  <data cell>            ; the cell holds the function pointer
    push  <native index>         ; imm32, or imm8 via 6a for small indices
    call  dword ptr [GRegisterNative]
    add   esp, 8
    mov   byte ptr [<static>], al

The registered pointer is usually an `E9` thunk; the real body is the jump
target.  This is the only reliable mapping.  In particular the packed pointer
arrays that sit in .data next to these cells LOOK index-aligned over a run of
indices and then silently drift, so they must not be used.

    python3 tools/native-registry.py Engine --index 298
    python3 tools/native-registry.py Extension --json out.json

Covers Engine.dll and Extension.dll, and is verified against every native
address this project had already recovered independently (see --selftest).
Core.dll uses a different registration shape and is not handled.
"""
import argparse, json, re, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "Deus Ex GOTY Edition"

# index -> body (or thunk where the project recorded the thunk) already
# recovered by hand elsewhere in this repo; used by --selftest.
ANCHORS = {
    "Extension": {1409: 0x10051830, 1413: 0x10051960, 1415: 0x10051a10,
                  1421: 0x10051ce0, 1432: 0x10052160, 1460: 0x10052f30,
                  1475: 0x10053ad0, 1550: 0x10046a30, 1556: 0x10047000},
    "Engine": {267: 0x103E3120, 261: 0x103DFF60},
}

# Core.dll does NOT use this stub shape: its registrations are `mov $index,
# <slot>` forms that take the function pointer from a separate data slot, so
# this tool does not cover it.  Core is not the gap anyway — Core.Object is
# bound apart from three deliberately excluded side-effecting natives.


class Image:
    def __init__(self, path):
        self.data = path.read_bytes()
        pe = struct.unpack_from("<I", self.data, 0x3C)[0]
        nsec = struct.unpack_from("<H", self.data, pe + 6)[0]
        opt = struct.unpack_from("<H", self.data, pe + 20)[0]
        self.base = struct.unpack_from("<I", self.data, pe + 24 + 28)[0]
        self.sections = []
        for i in range(nsec):
            o = pe + 24 + opt + i * 40
            vsize, va, rsize, raw = struct.unpack_from("<IIII", self.data, o + 8)
            self.sections.append((va, vsize, raw, rsize))

    def offset(self, va):
        rva = va - self.base
        for va0, vsize, raw, rsize in self.sections:
            if va0 <= rva < va0 + max(vsize, rsize):
                return raw + (rva - va0)
        return None

    def dword(self, va):
        o = self.offset(va)
        return None if o is None else struct.unpack_from("<I", self.data, o)[0]

    def follow_thunk(self, va):
        """An E9 rel32 thunk resolves to its jump target; anything else is the body."""
        o = self.offset(va)
        if o is not None and self.data[o] == 0xE9:
            return va + 5 + struct.unpack_from("<i", self.data, o + 1)[0]
        return va


def registry(image):
    """Return {index: (thunk, body, cell, stub)} for every registration stub."""
    text_va, _, text_raw, text_size = image.sections[0]
    blob = image.data[text_raw:text_raw + text_size]
    # Locate GRegisterNative by picking the import slot these stubs call most.
    tally = {}
    generic = re.compile(rb"\x68(....)(?:\x68(....)|\x6a(.))\xff\x15(....)", re.S)
    for m in generic.finditer(blob):
        imp = struct.unpack("<I", m.group(4))[0]
        idx = struct.unpack("<I", m.group(2))[0] if m.group(2) else m.group(3)[0]
        if 0 <= idx <= 4096:
            tally[imp] = tally.get(imp, 0) + 1
    if not tally:
        return {}, None
    slot = max(tally, key=tally.get)
    out = {}
    pat = re.compile(rb"\x68(....)(?:\x68(....)|\x6a(.))\xff\x15" + re.escape(struct.pack("<I", slot)), re.S)
    for m in pat.finditer(blob):
        cell = struct.unpack("<I", m.group(1))[0]
        idx = struct.unpack("<I", m.group(2))[0] if m.group(2) else m.group(3)[0]
        pointer = image.dword(cell)
        if pointer is None or image.offset(pointer) is None:
            continue
        out[idx] = (pointer, image.follow_thunk(pointer), cell,
                    image.base + text_va + m.start())
    return out, slot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("package", nargs="?", default="Engine",
                    choices=["Engine", "Extension", "DeusExText", "ConSys", "DeusEx"])
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--index", type=int, help="print only this native index")
    ap.add_argument("--json", help="write the full table to this path")
    ap.add_argument("--selftest", action="store_true",
                    help="check every package against the recorded anchors")
    args = ap.parse_args()

    packages = ["Engine", "Extension"] if args.selftest else [args.package]
    failures = 0
    for pkg in packages:
        image = Image(Path(args.root) / "System" / f"{pkg}.dll")
        table, slot = registry(image)
        if args.selftest:
            for index, expected in ANCHORS[pkg].items():
                entry = table.get(index)
                got = entry[1] if entry else None
                ok = got == expected
                failures += not ok
                print(f"  {'ok  ' if ok else 'FAIL'} {pkg} {index}: "
                      f"{'0x%08x' % got if got else 'missing'} vs 0x{expected:08x}")
            continue
        print(f"# {pkg}.dll base 0x{image.base:08x} GRegisterNative slot 0x{slot:08x} "
              f"({len(table)} natives)")
        items = sorted(table.items()) if args.index is None else \
            [(args.index, table[args.index])] if args.index in table else []
        if args.index is not None and not items:
            sys.exit(f"native {args.index} is not registered by {pkg}.dll")
        for index, (thunk, body, cell, stub) in items:
            print(f"{index:5}  thunk=0x{thunk:08x}  body=0x{body:08x}  "
                  f"cell=0x{cell:08x}  stub=0x{stub:08x}")
        if args.json:
            Path(args.json).write_text(json.dumps(
                {str(k): {"thunk": v[0], "body": v[1], "cell": v[2], "stub": v[3]}
                 for k, v in table.items()}, indent=2) + "\n")
    if args.selftest:
        print("selftest:", "PASS" if not failures else f"{failures} FAILED")
        sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
