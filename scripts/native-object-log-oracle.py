"""Run Core UObject::execLog (native 231) from the hash-pinned GOTY DLL.

The FFrame expression evaluators and the FOutputDevice::Logf call are explicit
probe boundaries.  All argument stepping, default-tag setup, format selection,
and temporary FString cleanup execute from the original Core.dll instructions.
The DLL and extracted package stay outside Git; this script only emits compact
JSON observations for the validator.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EIP, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"
EVALUATOR_TABLE = 0x101F41B8
EXEC_LOG = 0x1013CAE0
LOGF_BODY = 0x10145380
REALLOC_BODY = 0x10145440
GLOG_POINTER = 0x101A7C34
FORMAT_STRING = 0x101AAFD0
EMPTY_STRING = 0x101EF654
STRING_OPCODE = 0x1F
NAME_OPCODE = 0x21
END_FUNCTION_PARMS = 0x16
DEFAULT_TAG = 0x302

ADDRESSES = {
    "thunk": 0x101031CF,
    "body": EXEC_LOG,
    "logfBody": LOGF_BODY,
    "reallocBody": REALLOC_BODY,
}


class ObjectLogProbe(_NATIVE.NativeCollision):
    """Drive execLog with controlled FFrame expressions and GLog boundary."""

    def __init__(self, root: Path):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        self.end_parameters = self.alloc(16)
        self.cpu.mem_write(self.evaluator, b"\xC2\x08\x00")
        self.cpu.mem_write(self.end_parameters, b"\xC2\x08\x00")
        self.write(EVALUATOR_TABLE + STRING_OPCODE * 4, "I", self.evaluator)
        self.write(EVALUATOR_TABLE + NAME_OPCODE * 4, "I", self.evaluator)
        self.write(EVALUATOR_TABLE + END_FUNCTION_PARMS * 4, "I", self.end_parameters)

        # The destructor's Realloc call is still reached, but the allocator is
        # a host-owned heap in the real process.  The existing Core string
        # oracle uses this same bounded return to observe the cleanup fields.
        self.cpu.mem_write(REALLOC_BODY, b"\xC2\x04\x00")

        # FString cleanup releases its data through the process GMalloc
        # vtable.  Keep that one allocator operation explicit while allowing
        # the original destructor and FArray::Remove code to run to return.
        self.free_stub = self.alloc(16)
        self.cpu.mem_write(self.free_stub, b"\xC2\x04\x00")
        self.gmem_vtable = self.alloc(16)
        self.gmem = self.alloc(4)
        self.write(self.gmem_vtable + 8, "I", self.free_stub)
        self.write(self.gmem, "I", self.gmem_vtable)
        self.write(0x101A7C44, "I", self.gmem)

        self.glog = self.alloc(4)
        self.write(GLOG_POINTER, "I", self.glog)
        self.pending_values = []
        self.events = []
        self.realloc_events = []
        self.free_events = []
        self._string_allocations = []

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            if not self.pending_values:
                raise RuntimeError("Object.Log evaluated an unexpected expression")
            kind, value = self.pending_values.pop(0)
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            self.events.append({"kind": kind, "value": value})
            if kind == "string":
                pointer, count = self._make_string(value)
                self.write(output, "3I", pointer, count, count)
            elif kind == "name":
                self.write(output, "I", value)
            else:
                raise RuntimeError(f"Unknown Object.Log expression kind: {kind}")
            return super().on_instruction(cpu, address, size, data)

        if address == self.end_parameters:
            self.events.append({"kind": "end"})
            return super().on_instruction(cpu, address, size, data)

        if address == LOGF_BODY:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            return_address, glog, tag, format_address, text_pointer = self.read(
                stack, "5I"
            )
            text = self.text_at(text_pointer)
            self.events.append({
                "kind": "logf",
                "glog": glog,
                "tag": tag,
                "format": format_address,
                "textPointer": text_pointer,
                "text": text,
                "formatText": self.text_at(format_address),
            })
            if glog != self.glog:
                raise RuntimeError("Object.Log did not use the process GLog pointer")
            if format_address != FORMAT_STRING:
                raise RuntimeError("Object.Log did not pass the original %s format")
            # Logf is cdecl.  Emulate its ret and let execLog's caller clean the
            # four pushed arguments before entering the FString destructor.
            cpu.reg_write(UC_X86_REG_ESP, stack + 4)
            cpu.reg_write(UC_X86_REG_EIP, return_address)
            return

        if address == REALLOC_BODY:
            array = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            pointer, count, capacity = self.read(array, "3I")
            self.realloc_events.append({
                "pointer": pointer,
                "count": count,
                "capacity": capacity,
            })
            return super().on_instruction(cpu, address, size, data)

        if address == self.free_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            self.free_events.append({"pointer": self.read(stack + 4, "I")[0]})
            return super().on_instruction(cpu, address, size, data)

        return super().on_instruction(cpu, address, size, data)

    def _make_string(self, text: str):
        raw = text.encode("utf-16-le", errors="surrogatepass") + b"\0\0"
        if not text:
            return 0, 0
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        self._string_allocations.append(pointer)
        return pointer, len(raw) // 2

    def text_at(self, pointer: int) -> str:
        raw = bytearray()
        while self.read(pointer, "H")[0]:
            raw.extend(self.cpu.mem_read(pointer, 2))
            pointer += 2
        return bytes(raw).decode("utf-16-le", errors="surrogatepass")

    def run(self, text: str, *, tag=None, has_tag=False):
        self.pending_values = [("string", text)]
        tokens = [STRING_OPCODE]
        if has_tag:
            self.pending_values.append(("name", tag))
            tokens.append(NAME_OPCODE)
        tokens.append(END_FUNCTION_PARMS)
        self.events = []
        self.realloc_events = []
        self.free_events = []
        code = self.alloc(len(tokens))
        self.cpu.mem_write(code, bytes(tokens))
        frame = self.alloc(0x20)
        self.write(frame + 8, "2I", 0, code)
        self.call(EXEC_LOG, 0, struct.pack("<I", frame))
        if self.pending_values:
            raise RuntimeError("Object.Log left an expression unevaluated")
        code_after = self.read(frame + 12, "I")[0]
        return {
            "input": text,
            "tagArgument": tag if has_tag else None,
            "tagOmitted": not has_tag,
            "events": self.events,
            "realloc": self.realloc_events,
            "free": self.free_events,
            "codeAdvance": code_after - code,
            "emptyStringAddress": EMPTY_STRING,
            "allocations": self._string_allocations[-1:] if text else [],
        }


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: native-object-log-oracle.py GAME_ROOT")
    probe = ObjectLogProbe(Path(sys.argv[1]))
    cases = [
        probe.run(""),
        probe.run("hello"),
        probe.run("prefix\u0000suffix"),
        probe.run("custom", tag=0x2F8, has_tag=True),
        probe.run("", tag=DEFAULT_TAG, has_tag=True),
    ]
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": ADDRESSES,
        "tokens": {
            "String": hex(STRING_OPCODE),
            "Name": hex(NAME_OPCODE),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
            "DefaultTag": hex(DEFAULT_TAG),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
