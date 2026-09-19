"""Original Core.dll import/verification bodies with explicit external services.

Only package lookup, registered-object lookup, FName/string and CreateExport
are supplied. Hash building, recursive VerifyImport, Verify, CreateImport and
IndexToObject run from the hash-checked installed DLL. Error formatting and
SEH stay boundaries; fixtures stop at the original ImportPath diagnostic call.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location("native_collision", Path(__file__).with_name("native-collision-oracle.py"))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

BODIES = {"index": 0x1012E550, "create": 0x1012E6C0, "verifyImport": 0x10160FD0, "verify": 0x10160D80}
PACKAGE_CLASS = 0x1029B8E0
CLASS_CLASS = 0x101F1C18
COUNTER = 0x102A2658


class ImportProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.service_addresses = {
            0x10101CCB: "CreatePackage", 0x10101591: "GetPackageLinker",
            0x1010326A: "StaticFindObject", 0x1010239C: "Stricmp",
            0x10102E96: "FName", 0x101012FD: "CreateExport",
        }
        for address, name in self.service_addresses.items():
            cleanup = 8 if name == "FName" else 4 if name == "CreateExport" else 0
            self.cpu.mem_write(address, b"\xc2" + struct.pack("<H", cleanup) if cleanup else b"\xc3")
        self.hash_building = False

    def text(self, pointer):
        values = []
        for _ in range(4096):
            value = self.read(pointer, "H")[0]
            if value == 0:
                return "".join(map(chr, values))
            values.append(value)
            pointer += 2
        raise RuntimeError("unterminated original string")

    def label(self, pointer):
        if not pointer:
            return None
        if pointer not in self.labels:
            raise RuntimeError(f"unknown pointer {pointer:#x}")
        return self.labels[pointer]

    def setup(self, scene):
        self.cpu.mem_write(0x20000000, bytes(self.free - 0x20000000))
        self.free = 0x20000000
        self.events = []
        self.boundary = None
        self.scene = scene
        self.labels = {PACKAGE_CLASS: "@Package", CLASS_CLASS: "@Class"}
        self.objects = {"@Package": PACKAGE_CLASS, "@Class": CLASS_CLASS}
        self.linkers = {}
        self.root_linkers = {}
        self.create_results = list(scene.get("createResults", []))
        self.write(COUNTER, "I", scene.get("counter", 0))
        self.write(0x101E5598, "I", 0)  # GIsEditor; editor logging is a boundary.
        self.write(PACKAGE_CLASS + 0x28, "I", 0)
        self.write(CLASS_CLASS + 0x28, "I", 0)
        self.names = {int(k): v for k, v in scene["names"].items()}
        name_table = self.alloc(4 * (max(self.names) + 1))
        self.write(0x102961F0, "I", name_table)
        for index, name in self.names.items():
            raw = name.encode("utf-16le") + b"\0\0"
            entry = self.alloc(12 + len(raw))
            self.cpu.mem_write(entry + 12, raw)
            self.write(name_table + index * 4, "I", entry)

        for label, spec in scene["objects"].items():
            obj = self.alloc(0x500)
            self.objects[label] = obj
            self.labels[obj] = label
        for label, spec in scene["objects"].items():
            obj = self.objects[label]
            self.write(obj + 0x18, "I", self.objects.get(spec.get("outer"), 0))
            self.write(obj + 0x1C, "I", spec.get("flags", 0))
            self.write(obj + 0x20, "I", spec["name"])
            self.write(obj + 0x24, "I", self.objects.get(spec.get("class"), 0))
            self.write(obj + 0x30, "I", spec.get("packageFlags", 0))
            self.write(obj + 0x484, "I", spec.get("classFlags", 0))
        for label, spec in scene["linkers"].items():
            linker = self.alloc(0x500)
            self.linkers[label] = linker
            self.labels[linker] = label
            self.root_linkers[self.objects[spec["root"]]] = linker
        for label, spec in scene["linkers"].items():
            linker = self.linkers[label]
            imports = self.alloc(28 * len(spec["imports"]))
            exports = self.alloc(36 * len(spec["exports"]))
            self.write(linker + 0x28, "I", self.objects[spec["root"]])
            self.write(linker + 0x48, "I", spec.get("summaryImportCount", len(spec["imports"])))
            self.write(linker + 0x78, "3I", imports, len(spec["imports"]), len(spec["imports"]))
            self.write(linker + 0x84, "3I", exports, len(spec["exports"]), len(spec["exports"]))
            self.write(linker + 0xD0, "2I", spec.get("loadFlags", 0), spec.get("verified", 0))
            for i, record in enumerate(spec["imports"]):
                words = [record.get(key, default) for key, default in [("classPackage", 0), ("className", 0), ("packageIndex", 0), ("objectName", 0)]]
                words += [self.objects.get(record.get("object"), 0), self.linkers.get(record.get("sourceLinker"), 0), record.get("sourceIndex", -1)]
                self.write(imports + 28 * i, "7I", *[word & 0xffffffff for word in words])
            for i, record in enumerate(spec["exports"]):
                words = [record.get(key, 0) for key in ["classIndex", "superIndex", "packageIndex", "objectName", "objectFlags", "serialSize", "serialOffset"]]
                words += [self.objects.get(record.get("object"), 0), 0xffffffff]
                self.write(exports + 36 * i, "9I", *[word & 0xffffffff for word in words])
            # Execute the original constructor's whole export-hash fragment.
            self.cpu.reg_write(UC_X86_REG_ESP, self.stack)
            self.cpu.reg_write(UC_X86_REG_EBP, self.stack - 0x100)
            self.cpu.reg_write(UC_X86_REG_ESI, linker)
            self.hash_building = True
            self.cpu.emu_start(0x10160786, 0x1016086B, count=100000)
            self.hash_building = False
            if self.cpu.reg_read(UC_X86_REG_EIP) != 0x1016086B:
                raise RuntimeError("native hash fragment did not finish")

    def on_instruction(self, cpu, address, size, data):
        if address in self.service_addresses:
            name = self.service_addresses[address]
            stack = cpu.reg_read(UC_X86_REG_ESP)
            this = cpu.reg_read(UC_X86_REG_ECX)
            result = 0
            if name == "CreatePackage":
                outer, pointer = self.read(stack + 4, "2I")
                text = self.text(pointer)
                matches = [self.objects[label] for label, spec in self.scene["objects"].items()
                           if spec.get("class") == "@Package" and self.names[spec["name"]] == text and not spec.get("outer")]
                if len(matches) != 1 or outer:
                    raise RuntimeError(f"unprepared CreatePackage {text}")
                result = matches[0]
                self.events.append({"op": name, "outer": None, "name": text, "result": self.label(result)})
            elif name == "GetPackageLinker":
                root, filename, flags, sandbox, guid = self.read(stack + 4, "5I")
                if filename or sandbox or guid or flags != 8:
                    raise RuntimeError("unexpected GetPackageLinker arguments")
                result = self.root_linkers[root]
                self.events.append({"op": name, "root": self.label(root), "flags": flags, "result": self.label(result)})
            elif name == "StaticFindObject":
                cls, outer, pointer, exact = self.read(stack + 4, "4I")
                text = self.text(pointer)
                for label, spec in self.scene["objects"].items():
                    if (self.objects.get(spec.get("class"), 0) == cls and
                            self.objects.get(spec.get("outer"), 0) == outer and self.names[spec["name"]] == text):
                        result = self.objects[label]
                        break
                self.events.append({"op": name, "class": self.label(cls), "outer": self.label(outer), "name": text, "exact": exact, "result": self.label(result)})
            elif name == "Stricmp":
                a, b = self.read(stack + 4, "2I")
                result = 0 if self.text(a).lower() == self.text(b).lower() else 1
            elif name == "FName":
                pointer, mode = self.read(stack + 4, "2I")
                text = self.text(pointer)
                index = next(index for index, value in self.names.items() if value == text)
                self.write(this, "I", index)
                result = this
                self.events.append({"op": name, "text": text, "mode": mode, "index": index})
            elif name == "CreateExport":
                index = self.read(stack + 4, "i")[0]
                record = self.read(this + 0x84, "I")[0] + index * 36
                result = self.objects.get(self.create_results.pop(0), 0) if self.create_results else self.read(record + 0x1C, "I")[0]
                self.write(record + 0x1C, "I", result)
                self.events.append({"op": name, "linker": self.label(this), "index": index, "result": self.label(result)})
            cpu.reg_write(UC_X86_REG_EAX, result)
        elif address == 0x10102DBA:
            # Stop before unsupported diagnostic formatting/exception paths.
            return_address = self.read(cpu.reg_read(UC_X86_REG_ESP), "I")[0]
            self.boundary = {0x10161463: "PRIVATE", 0x10161890: "MISSING"}.get(return_address)
            if self.boundary is None:
                raise RuntimeError(f"unexpected diagnostic at {return_address:#x}")
            cpu.reg_write(UC_X86_REG_EIP, self.done)
            cpu.emu_stop()
            return
        elif address == 0x10102C70:
            raise RuntimeError(f"native assertion; trace {list(self.trace)}")
        return super().on_instruction(cpu, address, size, data)

    def run(self, scene):
        self.setup(scene)
        results = []
        for action in scene["actions"]:
            result = self.call(BODIES[action["op"]], self.linkers[action["linker"]], struct.pack("<i", action.get("index", 0)))
            if action["op"] in ["index", "create"]:
                results.append(self.label(result))
            if self.boundary:
                break
        linkers = {}
        for label, spec in scene["linkers"].items():
            pointer = self.linkers[label]
            imports = self.read(pointer + 0x78, "I")[0]
            exports = self.read(pointer + 0x84, "I")[0]
            linkers[label] = {
                "verified": self.read(pointer + 0xD4, "I")[0],
                "imports": [{"object": self.label(self.read(imports + i * 28 + 16, "I")[0]),
                             "sourceLinker": self.label(self.read(imports + i * 28 + 20, "I")[0]),
                             "sourceIndex": self.read(imports + i * 28 + 24, "i")[0],
                             "className": self.read(imports + i * 28 + 4, "I")[0]}
                            for i in range(len(spec["imports"]))],
                "hash": list(self.read(pointer + 0xD8, "256i")),
                "hashNext": [self.read(exports + i * 36 + 32, "i")[0] for i in range(len(spec["exports"]))],
            }
        return {"results": results, "events": self.events, "boundary": self.boundary, "linkers": linkers,
                "counter": self.read(COUNTER, "I")[0],
                "packageFlags": {label: self.read(self.objects[label] + 0x30, "I")[0]
                                 for label, spec in scene["objects"].items() if spec.get("class") == "@Package"}}


if __name__ == "__main__":
    probe = ImportProbe(Path(sys.argv[1]))
    scenes = json.load(sys.stdin)
    output = []
    for scene in scenes:
        try:
            output.append(probe.run(scene))
        except Exception as error:
            raise RuntimeError(f"{scene['name']}: {error}") from error
    print(json.dumps(output))
