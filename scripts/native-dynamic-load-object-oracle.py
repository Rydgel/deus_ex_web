"""Execute the original Core ``UObject::execDynamicLoadObject`` wrapper.

This probe keeps the wrapper and its temporary FString cleanup in the
hash-checked GOTY Core.dll.  FFrame expression evaluators and the deeper
StaticLoadObject graph are explicit narrow services: the former provide a
controlled string/class/bool expression stream, while the latter records the
six cdecl arguments and returns a fixture pointer.  The original
FArray::Realloc body and GMalloc virtual edges still execute for the temporary
FString lifetime.

The original binary and captures remain outside Git.  This is a research
oracle, not a browser runtime dependency.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"

# Direct body/thunk addresses recovered from the same Core image.
EXEC_DYNAMIC_LOAD_OBJECT_THUNK = 0x10103201
EXEC_DYNAMIC_LOAD_OBJECT = 0x1013EB30
STATIC_LOAD_OBJECT_THUNK = 0x10102A1D
FARRAY_REALLOC_THUNK = 0x10101753
FARRAY_REALLOC = 0x10145440
EXEC_NOTHING = 0x1012F660

# Process globals and bytecode tokens touched by this wrapper.
GMALLOC = 0x101A7C44
GNATIVES = 0x101F41B8
EMPTY_STRING = 0x101EF654
END_FUNCTION_PARMS = 0x16
EX_NOTHING = 0x0B

# Private fixture tokens.  Their values are irrelevant to the native body;
# installing them in GNatives isolates each expression's output and order.
EX_NAME_FIXTURE = 0xE0
EX_CLASS_FIXTURE = 0xE1
EX_BOOL_FIXTURE = 0xE2


class DynamicLoadProbe(_NATIVE.NativeCollision):
    """Run the native wrapper with explicit expression/load/allocator edges."""

    def __init__(self, root: Path):
        super().__init__(Path(root))
        self.events: list[dict[str, object]] = []
        self.services: dict[int, str] = {}
        self.next_service = 0x700F0000

        # StaticLoadObject is the one deliberately bounded graph: the wrapper
        # itself still performs the call, argument pushes and result store.
        self.cpu.mem_write(STATIC_LOAD_OBJECT_THUNK, b"\xC3")
        self.services[STATIC_LOAD_OBJECT_THUNK] = "StaticLoadObject"

        self.expression_stubs = {
            "Name": self._patch_service("EvalName", b"\xC2\x08\x00"),
            "Class": self._patch_service("EvalClass", b"\xC2\x08\x00"),
            "MayFail": self._patch_service("EvalMayFail", b"\xC2\x08\x00"),
        }
        self.realloc_stub = self._patch_service("GMalloc.Realloc", b"\xC2\x0C\x00")
        self.free_stub = self._patch_service("GMalloc.Free", b"\xC2\x04\x00")

        # FArray::Realloc is left as original code.  It calls the two explicit
        # virtual allocator slots with (Data, NumBytes, Tag) and (Data).
        allocator_vtable = self.alloc(0x20)
        allocator = self.alloc(0x20)
        self.write(allocator_vtable + 0x04, "I", self.realloc_stub)
        self.write(allocator_vtable + 0x08, "I", self.free_stub)
        self.write(allocator, "I", allocator_vtable)
        self.write(GMALLOC, "I", allocator)

        self.write(GNATIVES + EX_NAME_FIXTURE * 4, "I", self.expression_stubs["Name"])
        self.write(GNATIVES + EX_CLASS_FIXTURE * 4, "I", self.expression_stubs["Class"])
        self.write(GNATIVES + EX_BOOL_FIXTURE * 4, "I", self.expression_stubs["MayFail"])
        # The native wrapper's third Step is unconditional.  The compiler's
        # omitted optional argument is the original Nothing expression.
        self.write(GNATIVES + EX_NOTHING * 4, "I", EXEC_NOTHING)

        self.object_class = self.alloc(0x20)
        self.loaded_object = self.alloc(0x20)

    def _patch_service(self, name: str, code: bytes) -> int:
        address = self.next_service
        self.next_service += 0x10
        self.cpu.mem_write(address, code)
        self.services[address] = name
        return address

    def _text_at(self, pointer: int) -> str:
        if not pointer or pointer == EMPTY_STRING:
            return ""
        units: list[int] = []
        for _ in range(4096):
            unit = self.read(pointer, "H")[0]
            if unit == 0:
                return "".join(chr(value) for value in units)
            units.append(unit)
            pointer += 2
        raise RuntimeError("unterminated TCHAR string in DynamicLoadObject fixture")

    def _write_fstring(self, text: str) -> tuple[int, int]:
        if not text:
            return 0, 0
        raw = text.encode("utf-16-le", errors="surrogatepass") + b"\x00\x00"
        data = self.alloc(len(raw))
        self.cpu.mem_write(data, raw)
        units = len(raw) // 2
        return data, units

    def on_instruction(self, cpu, address, size, data):  # noqa: D401
        if address == EXEC_NOTHING:
            self.events.append({"op": "EvalNothing"})
        elif address in self.services:
            service = self.services[address]
            stack = cpu.reg_read(UC_X86_REG_ESP)
            if service == "EvalName":
                output = self.read(stack + 8, "I")[0]
                self.write(output, "3I", self.name_data, self.name_units, self.name_units)
                self.events.append({"op": service, "text": self.name})
            elif service == "EvalClass":
                output = self.read(stack + 8, "I")[0]
                self.write(output, "I", self.object_class)
                self.events.append({"op": service, "pointer": self.object_class})
            elif service == "EvalMayFail":
                output = self.read(stack + 8, "I")[0]
                self.write(output, "I", self.may_fail)
                self.events.append({"op": service, "value": self.may_fail})
            elif service == "StaticLoadObject":
                values = self.read(stack + 4, "6I")
                self.events.append({
                    "op": service,
                    "class": values[0],
                    "outer": values[1],
                    "name": self._text_at(values[2]),
                    "namePointer": values[2],
                    "filename": values[3],
                    "flags": values[4],
                    "sandbox": values[5],
                })
                cpu.reg_write(UC_X86_REG_EAX, self.load_result)
            elif service == "GMalloc.Realloc":
                old, size_bytes, tag = self.read(stack + 4, "3I")
                self.events.append({
                    "op": service,
                    "old": old,
                    "size": size_bytes,
                    "tag": tag,
                })
                # Returning the old pointer lets the original FArray body
                # publish it before execDynamicLoadObject's subsequent Free.
                cpu.reg_write(UC_X86_REG_EAX, old)
            elif service == "GMalloc.Free":
                pointer = self.read(stack + 4, "I")[0]
                self.events.append({"op": service, "pointer": pointer})
            else:
                raise RuntimeError(f"Unhandled DynamicLoadObject service {service}")
        return super().on_instruction(cpu, address, size, data)

    def run_case(self, name: str, may_fail: int | None, load_result: int | None = None):
        """Run one expression stream and return observed native effects."""
        self.name = name
        self.may_fail = 0 if may_fail is None else may_fail
        self.name_data, self.name_units = self._write_fstring(name)
        self.load_result = self.loaded_object if load_result is None else load_result
        self.events = []

        # Even an omitted optional parameter has a third expression slot: the
        # original compiler emits EX_Nothing, which leaves the zeroed bool
        # local untouched.  The wrapper then consumes EndFunctionParms itself.
        third = EX_BOOL_FIXTURE if may_fail is not None else EX_NOTHING
        code_bytes = bytes([EX_NAME_FIXTURE, EX_CLASS_FIXTURE, third, END_FUNCTION_PARMS])
        code = self.alloc(len(code_bytes))
        self.cpu.mem_write(code, code_bytes)

        frame = self.alloc(0x40)
        self.write(frame + 0x08, "2I", 0, code)  # Object, Code
        result = self.alloc(4)
        self.write(result, "I", 0)

        self.call(EXEC_DYNAMIC_LOAD_OBJECT, 0, struct.pack("<2I", frame, result))
        observed_result = self.read(result, "I")[0]
        return {
            "input": name,
            "mayFailInput": may_fail,
            "result": observed_result,
            "codeAdvance": self.read(frame + 0x0C, "I")[0] - code,
            "temporaryData": self.name_data,
            "events": self.events,
        }


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: native-dynamic-load-object-oracle.py GAME_ROOT")
    root = Path(sys.argv[1])
    probe = DynamicLoadProbe(root)
    cases = [
        probe.run_case("InfoPortraits.JaimeReyes", None),
        probe.run_case("InfoPortraits.JaimeReyes", 0),
        probe.run_case("InfoPortraits.JaimeReyes", 1),
        probe.run_case("InfoPortraits.JaimeReyes", 2),
        probe.run_case("", None),
        probe.run_case("InfoPortraits.JaimeReyes", 1, load_result=0),
    ]
    print(json.dumps({
        "hashes": {
            "Core.dll": CORE_SHA256,
            "Engine.dll": _NATIVE.HASHES["Engine.dll"],
        },
        "addresses": {
            "execDynamicLoadObjectThunk": hex(EXEC_DYNAMIC_LOAD_OBJECT_THUNK),
            "execDynamicLoadObject": hex(EXEC_DYNAMIC_LOAD_OBJECT),
            "StaticLoadObject": hex(STATIC_LOAD_OBJECT_THUNK),
            "FArrayRealloc": hex(FARRAY_REALLOC),
            "GMalloc": hex(GMALLOC),
            "execNothing": hex(EXEC_NOTHING),
        },
        "tokens": {
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
            "Nothing": hex(EX_NOTHING),
            "fixtureName": hex(EX_NAME_FIXTURE),
            "fixtureClass": hex(EX_CLASS_FIXTURE),
            "fixtureMayFail": hex(EX_BOOL_FIXTURE),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
