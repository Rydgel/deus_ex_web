"""Execute the original Core UObject::ResolveName ordinary path.

The hash-verified Core body resolves the focused
``DeusExConText.ConList_Mission00`` path while the string helpers, FName text
lookup, and package/object identity are explicit fixture services.  The
ResolveName, CreatePackage, and StaticFindObject bodies themselves execute
from the original image.  Config/localization and first-load branches are not
silently synthesized.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"

RESOLVE_NAME_THUNK = 0x10102C34
RESOLVE_NAME_BODY = 0x10154AD0
CREATE_PACKAGE_THUNK = 0x10101CCB
CREATE_PACKAGE_BODY = 0x101549F0
STATIC_FIND_OBJECT_THUNK = 0x1010326A
STATIC_FIND_OBJECT_BODY = 0x10151DE0
APP_STRNICMP_THUNK = 0x101029A0
APP_STRLEN_THUNK = 0x10101B04
APP_STRCHR_THUNK = 0x10101B9F
APP_STRCPY_THUNK = 0x10102432
FNAME_TEXT_THUNK = 0x10102E96

CORE_PACKAGE_CLASS = 0x1029B8E0
CORE_OBJECT_CLASS = 0x1029E0D0
G_OBJ_HASH = 0x1029E644
NAME_PACKAGE = 0x500


class ResolveNameProbe(_NATIVE.NativeCollision):
    """Original Core ResolveName with narrow deterministic helper services."""

    def __init__(self, game_root: Path):
        super().__init__(Path(game_root))
        self.events: list[dict[str, object]] = []
        self.services: dict[int, str] = {}
        self.labels: dict[int, str] = {}
        self._patch_service(APP_STRNICMP_THUNK, "appStrnicmp", b"\xC3")
        self._patch_service(APP_STRLEN_THUNK, "appStrlen", b"\xC3")
        self._patch_service(APP_STRCHR_THUNK, "appStrchr", b"\xC3")
        self._patch_service(APP_STRCPY_THUNK, "appStrcpy", b"\xC3")
        # FName(const TCHAR*,EFindName) is thiscall and returns with ret 8.
        self._patch_service(FNAME_TEXT_THUNK, "FNameText", b"\xC2\x08\x00")
        self._make_fixture()

    def _patch_service(self, address: int, name: str, code: bytes) -> None:
        self.cpu.mem_write(address, code)
        self.services[address] = name

    def _label(self, pointer: int) -> str | None:
        if pointer == 0:
            return None
        return self.labels.get(pointer, hex(pointer))

    def _utf16(self, address: int) -> str:
        units: list[int] = []
        for _ in range(4096):
            value = self.read(address, "H")[0]
            if value == 0:
                return "".join(chr(unit) for unit in units)
            units.append(value)
            address += 2
        raise RuntimeError("unterminated TCHAR string in ResolveName fixture")

    def _write_utf16(self, text: str) -> int:
        raw = text.encode("utf-16-le") + b"\x00\x00"
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        return pointer

    def _make_fixture(self) -> None:
        # StaticFindObject reads only the hash bucket for the resolved null
        # outer in this case; the all-packages GObjObjects scan is not reached.
        self.cpu.mem_write(G_OBJ_HASH, b"\x00" * (4096 * 4))
        self.labels[CORE_PACKAGE_CLASS] = "Core.Package"
        self.labels[CORE_OBJECT_CLASS] = "Core.Object"

        self.package = self.alloc(0x100)
        self.labels[self.package] = "DeusExConText"
        self.write(self.package + 0x08, "I", 0)
        self.write(self.package + 0x18, "I", 0)
        self.write(self.package + 0x20, "I", NAME_PACKAGE)
        self.write(self.package + 0x24, "I", CORE_PACKAGE_CLASS)
        self.write(G_OBJ_HASH + NAME_PACKAGE * 4, "I", self.package)

        self.outer_holder = self.alloc(4)
        self.write(self.outer_holder, "I", 0)
        self.path_pointer = self._write_utf16("DeusExConText.ConList_Mission00")
        self.name_holder = self.alloc(4)
        self.write(self.name_holder, "I", self.path_pointer)

    def _service(self, cpu, address: int) -> None:
        name = self.services[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)

        if name == "appStrnicmp":
            left_pointer, right_pointer, count = self.read(stack + 4, "3I")
            left = self._utf16(left_pointer)
            right = self._utf16(right_pointer)
            left_part = left[:count]
            right_part = right[:count]
            folded_left = left_part.casefold()
            folded_right = right_part.casefold()
            result = 0 if folded_left == folded_right else (-1 if folded_left < folded_right else 1)
            cpu.reg_write(UC_X86_REG_EAX, result)
            self.events.append({
                "op": "appStrnicmp",
                "left": left_part,
                "right": right_part,
                "count": count,
                "result": result,
            })
            return

        if name == "appStrlen":
            pointer = self.read(stack + 4, "I")[0]
            text = self._utf16(pointer)
            cpu.reg_write(UC_X86_REG_EAX, len(text))
            self.events.append({"op": "appStrlen", "text": text, "length": len(text)})
            return

        if name == "appStrchr":
            pointer, character = self.read(stack + 4, "2I")
            text = self._utf16(pointer)
            index = text.find(chr(character & 0xFFFF))
            result = 0 if index < 0 else pointer + 2 * index
            cpu.reg_write(UC_X86_REG_EAX, result)
            self.events.append({
                "op": "appStrchr",
                "text": text,
                "char": chr(character & 0xFFFF),
                "index": index,
                "found": result != 0,
            })
            return

        if name == "appStrcpy":
            destination, source = self.read(stack + 4, "2I")
            text = self._utf16(source)
            self.cpu.mem_write(destination, text.encode("utf-16-le") + b"\x00\x00")
            cpu.reg_write(UC_X86_REG_EAX, destination)
            self.events.append({"op": "appStrcpy", "text": text, "maxLength": 0x400})
            return

        if name == "FNameText":
            this = cpu.reg_read(UC_X86_REG_ECX)
            text_pointer, find_mode = self.read(stack + 4, "2I")
            text = self._utf16(text_pointer)
            if (text, find_mode) != ("DeusExConText", 0):
                raise RuntimeError(f"unexpected FName lookup: {text!r}, mode={find_mode}")
            self.write(this, "2I", NAME_PACKAGE, 0)
            cpu.reg_write(UC_X86_REG_EAX, this)
            self.events.append({
                "op": "FName",
                "text": text,
                "findMode": find_mode,
                "nameIndex": NAME_PACKAGE,
            })
            return

        raise RuntimeError(f"Unhandled ResolveName service {name}")

    def on_instruction(self, cpu, address, size, data):  # noqa: D401
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == RESOLVE_NAME_BODY:
            outer_holder, name_holder, create, throw = self.read(stack + 4, "4I")
            name_pointer = self.read(name_holder, "I")[0]
            self.events.append({
                "op": "ResolveNameEnter",
                "outer": self._label(self.read(outer_holder, "I")[0]),
                "name": self._utf16(name_pointer),
                "create": create,
                "throwOnConfigMissing": throw,
            })
        elif address == CREATE_PACKAGE_BODY:
            outer, name_pointer = self.read(stack + 4, "2I")
            self.events.append({
                "op": "CreatePackageEnter",
                "outer": self._label(outer),
                "name": self._utf16(name_pointer),
            })
        elif address == STATIC_FIND_OBJECT_BODY:
            class_ref, outer, name_pointer, exact = self.read(stack + 4, "4I")
            self.events.append({
                "op": "StaticFindObjectEnter",
                "classRef": self._label(class_ref),
                "outer": self._label(outer),
                "name": self._utf16(name_pointer),
                "exactClass": exact,
            })
        elif address in self.services:
            self._service(cpu, address)
        return super().on_instruction(cpu, address, size, data)

    def run(self) -> dict[str, object]:
        result = self.call(
            RESOLVE_NAME_BODY,
            0,
            struct.pack(
                "<4I",
                self.outer_holder,
                self.name_holder,
                1,
                1,
            ),
        )
        outer = self.read(self.outer_holder, "I")[0]
        name_pointer = self.read(self.name_holder, "I")[0]
        name = self._utf16(name_pointer)
        if result != 1 or outer != self.package or name != "ConList_Mission00":
            raise RuntimeError(
                f"ResolveName result mismatch: result={result}, outer={outer:#x}, name={name!r}"
            )
        return {
            "result": result,
            "outer": self._label(outer),
            "name": name,
            "namePointerOffset": name_pointer - self.path_pointer,
            "events": self.events,
        }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-resolve-name-oracle.py GAME_ROOT")
    probe = ResolveNameProbe(Path(sys.argv[1]))
    print(
        __import__("json").dumps(
            {
                "hashes": {
                    "Core.dll": CORE_SHA256,
                    "Engine.dll": _NATIVE.HASHES["Engine.dll"],
                },
                "addresses": {
                    "ResolveNameThunk": hex(RESOLVE_NAME_THUNK),
                    "ResolveNameBody": hex(RESOLVE_NAME_BODY),
                    "CreatePackageThunk": hex(CREATE_PACKAGE_THUNK),
                    "CreatePackageBody": hex(CREATE_PACKAGE_BODY),
                    "StaticFindObjectThunk": hex(STATIC_FIND_OBJECT_THUNK),
                    "StaticFindObjectBody": hex(STATIC_FIND_OBJECT_BODY),
                    "appStrnicmp": hex(APP_STRNICMP_THUNK),
                    "appStrlen": hex(APP_STRLEN_THUNK),
                    "appStrchr": hex(APP_STRCHR_THUNK),
                    "appStrcpy": hex(APP_STRCPY_THUNK),
                    "FNameText": hex(FNAME_TEXT_THUNK),
                },
                "case": probe.run(),
                "unsupported": [
                    "ini:/usr: config GetString and localized throw paths",
                    "quoted/config class syntax",
                    "first-load package construction and allocation",
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
