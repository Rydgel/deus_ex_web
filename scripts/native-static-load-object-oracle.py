"""Run the original Core StaticLoadObject already-loaded path.

This is a bounded native oracle for the installed GOTY Core.dll.  The direct
``UObject::StaticLoadObject`` body executes in Unicorn.  ResolveName, the
FName(const TCHAR*, EFindName) constructor, and appStrcpy are explicit
services because their complete startup/config graphs are separate contracts.
The package lookup, export hash walk, already-created export return, and the
empty outermost BeginLoad/EndLoad path run from the original Core instructions;
no JavaScript loaded-cache shortcut is used.  The reached Logf and FMalloc
virtual calls are the only additional explicit edges for the outermost case.

Only the hash-checked original DLLs accepted by native-collision-oracle.py are
used.  Original files and captures stay outside Git.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import (
    UC_X86_REG_EAX,
    UC_X86_REG_ECX,
    UC_X86_REG_EIP,
    UC_X86_REG_ESP,
)


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"

# Core thunks and direct bodies recovered from the same image.  StaticLoad's
# body calls the thunks; the thunks are retained in this table so the oracle
# can distinguish the exact boundary ordering from an internal helper call.
STATIC_LOAD_OBJECT = 0x10154D50
BEGIN_LOAD_THUNK = 0x10103328
BEGIN_LOAD_BODY = 0x10155410
END_LOAD_THUNK = 0x10102F27
END_LOAD_BODY = 0x10155510
RESOLVE_NAME_THUNK = 0x10102C34
FNAME_TEXT_THUNK = 0x10102E96
APP_STRCPY_THUNK = 0x10102432
GET_PACKAGE_LINKER_THUNK = 0x10101591
FIND_EXPORT_INDEX_THUNK = 0x1010191A
FIND_EXPORT_INDEX_BODY = 0x10161E00
CREATE_EXPORT_THUNK = 0x101012FD
CREATE_EXPORT_BODY = 0x1012E230
LOGF_THUNK = 0x10102A95
REALLOC_THUNK = 0x10101753
REALLOC_BODY = 0x10145440
GMALLOC_PTR = 0x101A7C44

# Core globals read by the ordinary existing-linker path.
G_LOAD_NEST = 0x102A2650
G_REGISTRATION_QUEUE = 0x102A265C
G_LOADER_DATA = 0x1029E608
G_LOADER_NUM = 0x1029E60C
G_LOADED_DATA = 0x1029E638
G_LOADED_NUM = 0x1029E63C
G_LOADED_MAX = 0x1029E640
G_LOAD_STATE = 0x102A2658
G_PACKAGE_EXTENSION_WORD = 0x102A26D8
G_PACKAGE_EXTENSION = 0x102A26DC

# A package's export hash is only 256 entries; the table itself is at
# ULinkerLoad+0xd8 and records are 0x24 bytes at ULinkerLoad+0x84.
LINKER_IMPORTS = 0x78
LINKER_EXPORTS = 0x84
LINKER_HASH = 0xD8
EXPORT_STRIDE = 0x24
IMPORT_STRIDE = 0x1C


class StaticLoadProbe(_NATIVE.NativeCollision):
    """Execute StaticLoadObject with an existing linker/export fixture."""

    def __init__(self, game_root: Path):
        super().__init__(Path(game_root))
        self.events: list[dict[str, object]] = []
        self.services: dict[int, str] = {}
        self.next_service = 0x700F0000
        self.labels: dict[int, str] = {}
        self.path_pointer = 0
        self.name_pointer = 0

        self._patch_service(RESOLVE_NAME_THUNK, "ResolveName", b"\xC3")
        # FName is a __thiscall constructor with two stack arguments.  Its
        # original thunk returns with ret 8, so preserve that exact cleanup.
        self._patch_service(FNAME_TEXT_THUNK, "FNameText", b"\xC2\x08\x00")
        self._patch_service(APP_STRCPY_THUNK, "appStrcpy", b"\xC3")
        # EndLoad's outermost empty-array path still calls FOutputDevice::Logf.
        # Keep the call as an explicit boundary: the native formatting/output
        # graph is outside this probe, while its receiver/name/format arguments
        # remain observable.
        self._patch_service(LOGF_THUNK, "Logf", b"\xC3")

        # FArray::Realloc is native through the Core FMalloc virtual.  Supply
        # only that external allocator slot, returning the old pointer exactly
        # as the allocator boundary permits; the original FArray body still
        # executes and publishes Data/Num/Max.
        allocator = self.alloc(0x20)
        allocator_vtable = self.alloc(0x20)
        self.realloc_stub = self.alloc(0x10)
        self.cpu.mem_write(self.realloc_stub, bytes.fromhex("8b 44 24 04 c2 0c 00"))
        self.write(allocator_vtable + 0x04, "I", self.realloc_stub)
        self.write(allocator, "I", allocator_vtable)
        self.write(GMALLOC_PTR, "I", allocator)

        self._make_fixture()

    def _patch_service(self, address: int, name: str, code: bytes) -> None:
        self.cpu.mem_write(address, code)
        self.services[address] = name

    def _utf16(self, address: int) -> str:
        units: list[int] = []
        for _ in range(4096):
            value = self.read(address, "H")[0]
            if value == 0:
                return "".join(chr(unit) for unit in units)
            units.append(value)
            address += 2
        raise RuntimeError("unterminated TCHAR string in StaticLoad fixture")

    def _write_utf16(self, text: str) -> int:
        raw = text.encode("utf-16-le") + b"\x00\x00"
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        return pointer

    def _label(self, pointer: int) -> str | None:
        if pointer == 0:
            return None
        return self.labels.get(pointer, hex(pointer))

    def _make_fixture(self) -> None:
        """Build a loaded package/linker/export graph read by original code.

        The target class lives in an imported package (ConSys) while the
        requested object lives in DeusExConText.  The one negative import
        record is laid out using the exact two name reads in FindExportIndex:
        record[0]+8 supplies outer import index -2, record[1]+12 supplies the
        outer package name, and record[0]+24 supplies the class name.
        """

        self.package = self.alloc(0x100)
        self.labels[self.package] = "DeusExConText"
        self.write(self.package + 0x18, "I", 0)
        self.write(self.package + 0x20, "I", 0x42)

        self.class_package = self.alloc(0x100)
        self.labels[self.class_package] = "ConSys"
        self.write(self.class_package + 0x18, "I", 0)
        self.write(self.class_package + 0x20, "I", 0x53)

        self.conversation_list_class = self.alloc(0x100)
        self.labels[self.conversation_list_class] = "ConSys.ConversationList"
        self.write(self.conversation_list_class + 0x18, "I", self.class_package)
        self.write(self.conversation_list_class + 0x20, "I", 0x29A)

        self.loaded_object = self.alloc(0x100)
        self.labels[self.loaded_object] = "DeusExConText.Mission00"
        self.write(self.loaded_object + 0x18, "I", self.package)
        self.write(self.loaded_object + 0x20, "I", 0x29B)

        self.linker = self.alloc(0x400)
        self.labels[self.linker] = "LinkerLoad(DeusExConText)"
        self.write(self.linker + 0x28, "I", self.package)
        self.write(self.linker + 0x64, "I", 0)
        # BeginLoad's outermost loader assertion reads ULinkerLoad + 0x90.
        # A nonzero marker is enough to keep the already-loaded fixture on the
        # original successful branch; no archive implementation is inferred.
        self.write(self.linker + 0x90, "I", self.package)

        # The linker import table is an array of 0x1c-byte records.  The
        # negative class index -1 in export record 0 resolves through this
        # table in FindExportIndex's two original negative-index walks.
        imports = self.alloc(IMPORT_STRIDE * 2)
        self.write(imports + 0x08, "i", -2)
        # For class index -1 the second negative-index walk reads
        # linker+0x78 + 0x0c (record[0]+0x0c).
        self.write(imports + 0x0C, "I", 0x29A)
        self.write(imports + IMPORT_STRIDE + 0x0C, "I", 0x53)
        self.write(self.linker + LINKER_IMPORTS, "I", imports)

        exports = self.alloc(EXPORT_STRIDE)
        self.write(exports + 0x00, "i", -1)  # class import index 1
        self.write(exports + 0x08, "i", 0)  # root export; requested -1 is the wildcard
        self.write(exports + 0x0C, "I", 0x29B)
        self.write(exports + 0x1C, "I", self.loaded_object)
        self.write(exports + 0x20, "i", -1)  # end of hash chain
        self.write(self.linker + LINKER_EXPORTS, "I", exports)

        bucket = (0x29A * 7 + 0x53 * 31 + 0x29B) & 0xFF
        self.write(self.linker + LINKER_HASH + bucket * 4, "i", 0)
        self.export_bucket = bucket

        # GetPackageLinker scans this loader array before any file lookup.  A
        # single entry whose +0x28 is the resolved Outer is the concrete
        # already-loaded condition under test.
        loader_data = self.alloc(4)
        self.write(loader_data, "I", self.linker)
        self.write(G_LOADER_DATA, "I", loader_data)
        self.write(G_LOADER_NUM, "I", 1)

        # BeginLoad/EndLoad are safely nested here: BeginLoad increments 1 to
        # 2 and returns before its global post-load walk; EndLoad decrements
        # 2 to 1 and returns before its cleanup walk.  This is the same nested
        # condition used by StaticLoadObject during an enclosing load.
        self.write(G_LOAD_NEST, "I", 1)
        self.write(G_REGISTRATION_QUEUE, "I", 0)
        self.write(G_LOADED_DATA, "I", 0)
        self.write(G_LOADED_NUM, "I", 0)
        self.write(G_LOAD_STATE, "I", 0)
        self.write(G_PACKAGE_EXTENSION_WORD, "H", 0)
        self.cpu.mem_write(G_PACKAGE_EXTENSION, b"\x00\x00")

        self.path_pointer = self._write_utf16("DeusExConText.Mission00")
        self.name_pointer = self._write_utf16("Mission00")

    def _service(self, cpu, address: int) -> None:
        name = self.services[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)

        if name == "ResolveName":
            outer_holder, name_holder, create, throw = self.read(stack + 4, "4I")
            path = self._utf16(self.read(name_holder, "I")[0])
            if (create, throw) != (1, 1):
                raise RuntimeError(f"unexpected ResolveName flags: {create}, {throw}")
            if path != "DeusExConText.Mission00":
                raise RuntimeError(f"unexpected StaticLoad path: {path!r}")
            self.write(outer_holder, "I", self.package)
            self.write(name_holder, "I", self.name_pointer)
            self.events.append({
                "op": "ResolveName",
                "path": path,
                "create": create,
                "throw": throw,
                "outer": self._label(self.package),
                "tail": "Mission00",
            })
            cpu.reg_write(UC_X86_REG_EAX, 1)
            return

        if name == "FNameText":
            this = cpu.reg_read(UC_X86_REG_ECX)
            text_pointer, find_mode = self.read(stack + 4, "2I")
            text = self._utf16(text_pointer)
            if (text, find_mode) != ("Mission00", 1):
                raise RuntimeError(f"unexpected FName constructor: {text!r}, {find_mode}")
            self.write(this, "2I", 0x29B, 0)
            self.events.append({
                "op": "FName",
                "text": text,
                "findMode": find_mode,
                "nameIndex": 0x29B,
            })
            cpu.reg_write(UC_X86_REG_EAX, this)
            return

        if name == "appStrcpy":
            destination, source = self.read(stack + 4, "2I")
            text = self._utf16(source)
            self.cpu.mem_write(destination, text.encode("utf-16-le") + b"\x00\x00")
            self.events.append({"op": "appStrcpy", "source": text})
            cpu.reg_write(UC_X86_REG_EAX, destination)
            return

        if name == "Logf":
            receiver, log_name, format_pointer = self.read(stack + 4, "3I")
            if (log_name, format_pointer) != (0x308, 0x101AF3D4):
                raise RuntimeError(
                    f"unexpected EndLoad Logf args: receiver={receiver:#x}, "
                    f"name={log_name:#x}, format={format_pointer:#x}"
                )
            self.events.append({
                "op": "Logf",
                "receiver": self._label(receiver),
                "name": log_name,
                "formatPointer": format_pointer,
            })
            cpu.reg_write(UC_X86_REG_EAX, 0)
            return

        raise RuntimeError(f"Unhandled StaticLoad service {name}")

    def on_instruction(self, cpu, address, size, data):  # noqa: D401
        if address == self.realloc_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            pointer, byte_count, tag = self.read(stack + 4, "3I")
            if (byte_count, tag) != (0, 0x101AB50C):
                raise RuntimeError(
                    f"unexpected GMem Realloc args: pointer={pointer:#x}, "
                    f"bytes={byte_count:#x}, tag={tag:#x}"
                )
            self.events.append({
                "op": "FArrayRealloc",
                "pointer": pointer,
                "bytes": byte_count,
                "tag": tag,
            })
        elif address in self.services:
            self._service(cpu, address)
        elif address == STATIC_LOAD_OBJECT:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            args = self.read(stack + 4, "6I")
            self.events.append({
                "op": "StaticLoadObject",
                "class": self._label(args[0]),
                "outer": self._label(args[1]),
                "path": self._utf16(args[2]),
                "filename": self._label(args[3]),
                "flags": args[4],
                "sandbox": self._label(args[5]),
            })
        elif address == BEGIN_LOAD_THUNK:
            self.events.append({"op": "BeginLoadThunk", "nest": self.read(G_LOAD_NEST, "I")[0]})
        elif address == BEGIN_LOAD_BODY:
            self.events.append({"op": "BeginLoadBody", "nest": self.read(G_LOAD_NEST, "I")[0]})
        elif address == END_LOAD_THUNK:
            self.events.append({"op": "EndLoadThunk", "nest": self.read(G_LOAD_NEST, "I")[0]})
        elif address == END_LOAD_BODY:
            self.events.append({"op": "EndLoadBody", "nest": self.read(G_LOAD_NEST, "I")[0]})
        elif address == GET_PACKAGE_LINKER_THUNK:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            outer, filename, flags, sandbox, guid = self.read(stack + 4, "5I")
            self.events.append({
                "op": "GetPackageLinker",
                "outer": self._label(outer),
                "filename": self._label(filename),
                "flags": flags,
                "sandbox": self._label(sandbox),
                "guid": self._label(guid),
            })
        elif address == FIND_EXPORT_INDEX_BODY:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            class_name, class_outer, object_name, requested_outer = self.read(stack + 4, "4i")
            self.events.append({
                "op": "FindExportIndex",
                "className": class_name,
                "classOuter": class_outer,
                "objectName": object_name,
                "requestedOuter": requested_outer,
                "bucket": self.export_bucket,
            })
        elif address == CREATE_EXPORT_BODY:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            index = self.read(stack + 4, "I")[0]
            self.events.append({
                "op": "CreateExport",
                "index": index,
                "existing": self._label(self.loaded_object),
            })
        return super().on_instruction(cpu, address, size, data)

    def run(self) -> dict[str, object]:
        result = self.call(
            STATIC_LOAD_OBJECT,
            0,
            struct.pack(
                "<6I",
                self.conversation_list_class,
                0,
                self.path_pointer,
                0,
                2,
                0,
            ),
        )
        if result != self.loaded_object:
            raise RuntimeError(f"StaticLoadObject returned {result:#x}, expected {self.loaded_object:#x}")
        return {
            "result": self._label(result),
            "flags": 2,
            "linker": self._label(self.linker),
            "exportBucket": self.export_bucket,
            "loadNestAfter": self.read(G_LOAD_NEST, "I")[0],
            "events": self.events,
        }

    def run_outermost(self) -> dict[str, object]:
        """Run StaticLoadObject with the native empty outermost lifecycle.

        The preloaded linker/export fixture remains the same, but the Core
        globals model an initially empty GObjLoaded and nest=0.  This drives
        BeginLoad 0->1 and EndLoad 1->0 through their actual bodies.  The
        allocator and Logf boundaries are explicit above; no postload object
        or loader-cleanup graph is synthesized.
        """
        self.events = []
        self.write(G_LOAD_NEST, "I", 0)
        self.write(G_REGISTRATION_QUEUE, "I", 0)
        self.write(G_LOADED_DATA, "I", 0)
        self.write(G_LOADED_NUM, "I", 0)
        self.write(G_LOADED_MAX, "I", 0)
        self.write(G_LOAD_STATE, "I", 0)
        self.write(G_LOADER_NUM, "I", 1)

        result = self.call(
            STATIC_LOAD_OBJECT,
            0,
            struct.pack(
                "<6I",
                self.conversation_list_class,
                0,
                self.path_pointer,
                0,
                2,
                0,
            ),
        )
        if result != self.loaded_object:
            raise RuntimeError(
                f"outermost StaticLoadObject returned {result:#x}, "
                f"expected {self.loaded_object:#x}"
            )
        return {
            "result": self._label(result),
            "flags": 2,
            "linker": self._label(self.linker),
            "exportBucket": self.export_bucket,
            "loadNestBefore": 0,
            "loadNestAfter": self.read(G_LOAD_NEST, "I")[0],
            "loadedNumAfter": self.read(G_LOADED_NUM, "I")[0],
            "loadedMaxAfter": self.read(G_LOADED_MAX, "I")[0],
            "loadStateAfter": self.read(G_LOAD_STATE, "I")[0],
            "events": self.events,
        }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-static-load-object-oracle.py GAME_ROOT")
    probe = StaticLoadProbe(Path(sys.argv[1]))
    nested_case = probe.run()
    outermost_case = probe.run_outermost()
    print(json.dumps({
        "hashes": {
            "Core.dll": CORE_SHA256,
            "Engine.dll": _NATIVE.HASHES["Engine.dll"],
        },
        "addresses": {
            "StaticLoadObject": hex(STATIC_LOAD_OBJECT),
            "BeginLoadThunk": hex(BEGIN_LOAD_THUNK),
            "BeginLoadBody": hex(BEGIN_LOAD_BODY),
            "EndLoadThunk": hex(END_LOAD_THUNK),
            "EndLoadBody": hex(END_LOAD_BODY),
            "ResolveName": hex(RESOLVE_NAME_THUNK),
            "FNameText": hex(FNAME_TEXT_THUNK),
            "GetPackageLinker": hex(GET_PACKAGE_LINKER_THUNK),
            "FindExportIndex": hex(FIND_EXPORT_INDEX_BODY),
            "CreateExport": hex(CREATE_EXPORT_BODY),
            "Logf": hex(LOGF_THUNK),
            "FArrayRealloc": hex(REALLOC_BODY),
        },
        "case": nested_case,
        "outermost": outermost_case,
        "unresolved": [
            "ResolveName and FName text lookup are explicit services; their complete config/name startup graphs are separate contracts.",
            "GetPackageLinker first-load/file resolution and the StaticFindObject fallback are not reached by this preloaded-linker hit.",
            "Nonempty GObjLoaded requires ConditionalPostLoad and nonzero load-state cleanup services; those branches remain unbound.",
        ],
    }))


if __name__ == "__main__":
    main()
