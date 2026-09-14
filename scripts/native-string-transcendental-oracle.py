#!/usr/bin/env python3
"""Execute Core's original string-compare/Asc/XorX/DivideEqual/MultiplyEqual and
transcendental natives in an x86 emulator.

Same harness as native-rotator-modulo-oracle.py: the operand evaluators are the
only stubbed services; every instruction of the native bodies runs from the
hash-checked GOTY Core.dll.  ``MSVCRT.dll`` is loaded alongside Engine/Core at
its preferred base so the native bodies reach the REAL shipped CRT code: the
``wcscmp`` import behind ``appStrcmp`` (115/120/121) and ``_ftol`` behind the
``/=`` truncation (160).  The kernel32 imports those CRT paths could touch are
satisfied by minimal x86 stubs — anything else raises.

The bodies under test:

    115 <  (string,string)->bool        thunk 0x1010153c -> body 0x1013ae20
    120 <= (string,string)->bool        thunk 0x10102bb2 -> body 0x1013b1c0
    121 >= (string,string)->bool        thunk 0x1010309e -> body 0x1013b390
    131 ^^ (bool,bool)->bool            thunk 0x1010288d -> body 0x10132b90
    160 /= (out int,float)->int         thunk 0x10102d6a -> body 0x10134370
    237 Asc(string)->int                thunk 0x10101c76 -> body 0x1013c630
    297 *= (out vector,vector)->vector  thunk 0x1010245a -> body 0x10138910
    187 Sin(float)->float  AUDIT ONLY   thunk 0x10102388 -> body 0x10135d20
    188 Cos(float)->float               thunk 0x10101faa -> body 0x10135dd0
    189 Tan(float)->float               thunk 0x101022ed -> body 0x10135e80
    190 Atan(float)->float              thunk 0x10102126 -> body 0x10135f30

The string bodies construct real FString temporaries, substitute the runtime
empty-string buffer at 0x101ef654 when the temporary's ArrayNum field is zero
(the pointer is not consulted), and call appStrcmp (0x101012c1 -> 0x10123540 ->
the shipped MSVCRT wcscmp) — a CASE-SENSITIVE unsigned UTF-16 code-unit compare.
They run only to the result store: the SEH-protected FString destructor tail is
compiler cleanup with no observable effect on the result, so each string body is
stopped at the instruction after its result store (same convention as
native-script-string-oracle.py).

The transcendental bodies widen the float32 argument to a double with fstpl and
call Core-internal thunks that execute the x87 FSIN/FCOS/FPTAN/FPATAN hardware
instructions directly (they are NOT MSVCRT imports — the thunks hold
``fld qword; fsin/fcos/fptan/fpatan; ret``).  This emulator executes those
instructions, including the x87 out-of-range passthrough: |x| > 2^63 returns
the operand unchanged for FSIN/FCOS, and FPTAN's out-of-range path leaves the
store producing +0 through this exact instruction sequence.

For the transcendental natives the oracle additionally runs a deterministic
sweep — a fixed targeted edge set plus 2^20 LCG float32 bit patterns — and
packs the (input, output) bit pairs as base64 so the validator can compare
every sampled input against the JavaScript implementation bit-for-bit.

Run:
    NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python \
        python3 scripts/native-string-transcendental-oracle.py GAME_ROOT
"""

from __future__ import annotations

import base64
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

from unicorn.x86_const import (
    UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
    UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG,
)


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"
MSVCRT_SHA256 = "e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210"
EVALUATOR_TABLE = 0x101F41B8
PROP_OBJECT = 0x101E32C0
PROP_ADDR = 0x101E32F8
END_FUNCTION_PARMS = 0x16
# Token slots the probe replaces.  The slot choice documents the operand
# role; the bodies only dispatch through the table entry.
FLOAT_OPERAND = 0x1E      # execFloatConst
INT_OPERAND = 0x1D        # execIntConst (also carries bool dword operands)
STRING_OPERAND = 0x1F     # execStringConst
VECTOR_OPERAND = 0x23     # execVectorConst
LVALUE_OPERAND = 0x00     # execLocalVariable
TOKENS = {"float": FLOAT_OPERAND, "int": INT_OPERAND, "bool": INT_OPERAND,
          "string": STRING_OPERAND, "vector": VECTOR_OPERAND,
          "lint": LVALUE_OPERAND, "lvector": LVALUE_OPERAND}

NATIVES = {
    # String bodies stop at the instruction after the result dword store; the
    # destructor tail runs compiler FString cleanup only.
    "slt":   {"index": 115, "thunk": 0x1010153C, "body": 0x1013AE20, "result": "I", "stop": 0x1013AEDC},
    "sle":   {"index": 120, "thunk": 0x10102BB2, "body": 0x1013B1C0, "result": "I", "stop": 0x1013B27C},
    "sge":   {"index": 121, "thunk": 0x1010309E, "body": 0x1013B390, "result": "I", "stop": 0x1013B44C},
    "xor":   {"index": 131, "thunk": 0x1010288D, "body": 0x10132B90, "result": "I"},
    "diveq": {"index": 160, "thunk": 0x10102D6A, "body": 0x10134370, "result": "I"},
    "asc":   {"index": 237, "thunk": 0x10101C76, "body": 0x1013C630, "result": "I", "stop": 0x1013C69E},
    "muleq": {"index": 297, "thunk": 0x1010245A, "body": 0x10138910, "result": "3f"},
    "sin":   {"index": 187, "thunk": 0x10102388, "body": 0x10135D20, "result": "f"},
    "cos":   {"index": 188, "thunk": 0x10101FAA, "body": 0x10135DD0, "result": "f"},
    "tan":   {"index": 189, "thunk": 0x101022ED, "body": 0x10135E80, "result": "f"},
    "atan":  {"index": 190, "thunk": 0x10102126, "body": 0x10135F30, "result": "f"},
}


def _f32(value):
    return struct.unpack("<f", struct.pack("<I", value & 0xFFFFFFFF))[0]


def _f32bits(value):
    return struct.unpack("<I", struct.pack("<f", value))[0]


class StringTranscendentalProbe(_NATIVE.NativeCollision):
    """Run each native body with controlled expression evaluators."""

    def __init__(self, root: Path):
        super().__init__(root, additional_hashes={"MSVCRT.dll": MSVCRT_SHA256})
        self._install_kernel32()
        # MSVCRT's per-thread-data index (__TlsIndex) ships as 0xFFFFFFFF in
        # the image — DLL init never ran — so point it at emulated TLS slot 0;
        # the _getptd path then lazily allocates the thread block itself.
        self.write(0x7803D004, "I", 0)
        # P_GET_* invokes an evaluator with (FFrame*, destination) and expects
        # the callee to clean those two stack arguments.
        self.value_evaluator = self.alloc(16)
        self.lvalue_evaluator = self.alloc(16)
        self.cpu.mem_write(self.value_evaluator, b"\xC2\x08\x00")
        self.cpu.mem_write(self.lvalue_evaluator, b"\xC2\x08\x00")
        self.write(EVALUATOR_TABLE + FLOAT_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + INT_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + STRING_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + VECTOR_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + LVALUE_OPERAND * 4, "I", self.lvalue_evaluator)
        # The FString destructor tail calls the bounded allocator wrapper
        # (thunk 0x10101753 -> body 0x10145440) — stub the body like
        # native-script-string-oracle.py; the GMalloc Free edge below is only
        # reached by bodies that run past their result store.
        self.cpu.mem_write(0x10145440, bytes.fromhex("c2 04 00"))
        # GMalloc (0x101a7c44) -> object -> vtable; vtable[8] is Free(this,ptr).
        gmalloc_vtable = self.alloc(16)
        gmalloc_free = self.alloc(8)
        self.cpu.mem_write(gmalloc_free, b"\xc2\x04\x00")
        self.write(gmalloc_vtable + 8, "I", gmalloc_free)
        gmalloc = self.alloc(16)
        self.write(gmalloc, "I", gmalloc_vtable)
        self.write(0x101A7C44, "I", gmalloc)
        self.stop = None
        # Fast sweep lane: a real x86 evaluator that copies the dword at
        # fast_input to the destination; used only by the transcendental
        # bodies, which never touch the other stubs above.
        self.fast_input = self.alloc(4)
        self.fast_evaluator = self.alloc(16)
        self.cpu.mem_write(
            self.fast_evaluator,
            bytes.fromhex("8b442408 8b0d") + struct.pack("<I", self.fast_input)
            + bytes.fromhex("8908 c20800"))
        # The lvalue operand owns a distinct variable; 160/297 publish the
        # out parameter through GPropAddr.
        self.out_vars: dict[int, int] = {}
        self.operands: list[tuple[str, object]] = []
        self.evaluation = 0
        self.events: list[object] = []

    def _install_kernel32(self):
        """Minimal kernel32 for the MSVCRT error paths: real TLS cells, a
        last-error DWORD and a bump heap; anything else still raises."""
        cell = lambda x: x.to_bytes(4, "little")
        tls = self.alloc(0x400)
        lasterr = self.alloc(4)
        tlsnext = self.alloc(4)
        self.write(tlsnext, "I", 16)
        heap = self.alloc(0x40000)
        heapnext = self.alloc(4)
        self.write(heapnext, "I", heap)
        empty = self.alloc(16)
        R = lambda n: b"\xc2" + bytes([n, 0]) if n else b"\xc3"
        mov_eax_ret = lambda v, n=0: b"\xb8" + cell(v) + R(n)
        zero_ret = lambda n: b"\x31\xc0" + R(n)
        minus1_ret = lambda n: b"\x83\xc8\xff" + R(n)
        bump = lambda n: (b"\xa1" + cell(heapnext)
                          + b"\x81\x05" + cell(heapnext) + b"\x00\x10\x00\x00" + R(n))
        stubs = {
            "GetLastError": b"\xa1" + cell(lasterr) + b"\xc3",
            "SetLastError": b"\x8b\x44\x24\x04" + b"\xa3" + cell(lasterr) + R(4),
            "TlsGetValue": b"\x8b\x44\x24\x04" + b"\x8b\x04\x85" + cell(tls) + R(4),
            "TlsSetValue": (b"\x8b\x44\x24\x04\x8b\x4c\x24\x08"
                            + b"\x89\x0c\x85" + cell(tls) + mov_eax_ret(1, 8)),
            "TlsAlloc": (b"\xa1" + cell(tlsnext) + b"\x8d\x48\x01"
                         + b"\x89\x0d" + cell(tlsnext) + b"\xc3"),
            "TlsFree": mov_eax_ret(1, 4),
            "GetCurrentThreadId": mov_eax_ret(1),
            "GetCurrentThread": mov_eax_ret(0xFFFFFFFE),
            "GetCurrentProcess": mov_eax_ret(0xFFFFFFFF),
            "GetCurrentProcessId": mov_eax_ret(1),
            "InitializeCriticalSection": R(4), "DeleteCriticalSection": R(4),
            "EnterCriticalSection": R(4), "LeaveCriticalSection": R(4),
            "InterlockedIncrement": b"\x8b\x4c\x24\x04\x8b\x01\x40\x89\x01" + R(4),
            "InterlockedDecrement": b"\x8b\x4c\x24\x04\x8b\x01\x48\x89\x01" + R(4),
            "GetProcAddress": zero_ret(8), "LoadLibraryA": zero_ret(4),
            "FreeLibrary": zero_ret(4),
            "GetModuleHandleA": mov_eax_ret(0x78000000, 4),
            "GetModuleFileNameA": zero_ret(12), "GetModuleFileNameW": zero_ret(12),
            "GetVersion": mov_eax_ret(0x0A280105),
            "GetVersionExA": mov_eax_ret(1, 4),
            "SetUnhandledExceptionFilter": zero_ret(4),
            "UnhandledExceptionFilter": zero_ret(8),
            "RaiseException": zero_ret(16), "RtlUnwind": R(16),
            "TerminateProcess": R(8), "ExitProcess": R(4), "ExitThread": R(4),
            "HeapAlloc": bump(12), "HeapReAlloc": bump(16), "VirtualAlloc": bump(16),
            "HeapFree": mov_eax_ret(1, 12), "VirtualFree": mov_eax_ret(1, 12),
            "HeapCreate": mov_eax_ret(heap, 12), "HeapDestroy": mov_eax_ret(1, 4),
            "HeapSize": minus1_ret(12), "HeapValidate": zero_ret(12),
            "HeapCompact": zero_ret(8), "HeapWalk": zero_ret(4),
            "GetStdHandle": minus1_ret(4), "SetStdHandle": mov_eax_ret(1, 8),
            "GetFileType": zero_ret(4), "WriteFile": zero_ret(20),
            "SetHandleCount": R(4), "GetStartupInfoA": R(4),
            "GetCPInfo": zero_ret(8), "GetACP": mov_eax_ret(1252),
            "GetOEMCP": mov_eax_ret(437),
            "GetCommandLineA": mov_eax_ret(empty), "GetCommandLineW": mov_eax_ret(empty),
            "GetEnvironmentStringsA": mov_eax_ret(empty),
            "GetEnvironmentStringsW": mov_eax_ret(empty),
            "FreeEnvironmentStringsA": mov_eax_ret(1, 4),
            "FreeEnvironmentStringsW": mov_eax_ret(1, 4),
            "MultiByteToWideChar": zero_ret(24), "WideCharToMultiByte": zero_ret(32),
            "LCMapStringA": zero_ret(24), "LCMapStringW": zero_ret(24),
            "GetStringTypeA": zero_ret(20), "GetStringTypeW": zero_ret(20),
            "CompareStringA": zero_ret(24), "CompareStringW": zero_ret(24),
            "GetLocaleInfoA": zero_ret(24), "GetLocaleInfoW": zero_ret(24),
            "IsValidLocale": mov_eax_ret(1, 8), "IsValidCodePage": mov_eax_ret(1, 4),
            "EnumSystemLocalesA": mov_eax_ret(1, 8),
            "GetUserDefaultLCID": mov_eax_ret(0x409),
            "GetTimeZoneInformation": zero_ret(8),
            "SetEnvironmentVariableA": mov_eax_ret(1, 8),
            "SetEnvironmentVariableW": mov_eax_ret(1, 8),
            "Beep": mov_eax_ret(1, 8), "Sleep": R(4),
            "CreateThread": mov_eax_ret(1, 24), "ResumeThread": minus1_ret(4),
            "CloseHandle": mov_eax_ret(1, 4), "FindClose": mov_eax_ret(1, 4),
            "FindFirstFileA": minus1_ret(8), "FindFirstFileW": minus1_ret(8),
            "FindNextFileA": zero_ret(8), "FindNextFileW": zero_ret(8),
            "SetFilePointer": minus1_ret(16), "ReadFile": zero_ret(20),
            "FlushFileBuffers": zero_ret(4), "SetEndOfFile": zero_ret(4),
            "GetFileInformationByHandle": zero_ret(8), "PeekNamedPipe": zero_ret(24),
            "ReadConsoleA": zero_ret(20), "ReadConsoleInputA": zero_ret(16),
            "PeekConsoleInputA": zero_ret(16),
            "GetNumberOfConsoleInputEvents": zero_ret(8),
            "LockFile": zero_ret(20), "UnlockFile": zero_ret(20),
            "CreateFileA": minus1_ret(28), "CreateFileW": minus1_ret(28),
            "CreatePipeA": zero_ret(16), "DuplicateHandle": zero_ret(28),
            "GetExitCodeProcess": zero_ret(8), "WaitForSingleObject": zero_ret(8),
            "CreateProcessA": zero_ret(40), "CreateProcessW": zero_ret(40),
            "GetDiskFreeSpaceA": zero_ret(20), "GetLogicalDrives": zero_ret(20),
            "GetFileAttributesA": minus1_ret(4), "GetFileAttributesW": minus1_ret(4),
            "GetCurrentDirectoryA": zero_ret(8), "GetCurrentDirectoryW": zero_ret(8),
            "SetFileAttributesA": zero_ret(8), "SetFileAttributesW": zero_ret(8),
            "GetFullPathNameA": zero_ret(16), "GetFullPathNameW": zero_ret(16),
            "GetDriveTypeA": mov_eax_ret(3, 4), "GetDriveTypeW": mov_eax_ret(3, 4),
            "CreateDirectoryA": zero_ret(8), "CreateDirectoryW": zero_ret(8),
            "RemoveDirectoryA": zero_ret(4), "DeleteFileW": zero_ret(4),
            "MoveFileA": zero_ret(8), "MoveFileW": zero_ret(8),
            "FileTimeToSystemTime": mov_eax_ret(1, 8),
            "FileTimeToLocalFileTime": mov_eax_ret(1, 8),
            "SystemTimeToFileTime": mov_eax_ret(1, 8),
            "LocalFileTimeToFileTime": mov_eax_ret(1, 8),
            "SetLocalTime": zero_ret(4), "SetFileTime": zero_ret(16),
            "GetLocalTime": R(4), "GetSystemTime": R(4),
            "IsBadReadPtr": zero_ret(8), "IsBadWritePtr": zero_ret(8),
            "IsBadCodePtr": zero_ret(4), "SetErrorMode": zero_ret(4),
            "SetConsoleCtrlHandler": mov_eax_ret(1, 8),
        }
        for address, (dll, symbol) in list(self.thunks.items()):
            if dll != "kernel32.dll" or symbol not in stubs:
                continue
            code = stubs[symbol]
            target = self.alloc(len(code))
            self.cpu.mem_write(target, code)
            self.write(address, "B", 0xE9)                      # jmp stub
            self.write(address + 1, "I", (target - address - 5) & 0xFFFFFFFF)
            self.thunks.pop(address)

    def _make_string(self, text):
        """Real FString storage: UTF-16 units + NUL, ArrayNum/Max = len+1."""
        raw = text.encode("utf-16-le", errors="surrogatepass") + b"\0\0"
        if not text:
            return 0, 0
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        return pointer, len(raw) // 2

    def _write_fstring(self, output, value):
        """An FString operand: a str is real serialized storage; a dict sets
        the {data, ArrayNum, ArrayMax} fields verbatim so the num-vs-pointer
        substitution branch can be exercised independently."""
        if isinstance(value, dict):
            units = value["units"]
            pointer = 0
            if units is not None:
                pointer = self.alloc(2 * len(units) + 2)
                self.cpu.mem_write(pointer, struct.pack("<%dH" % len(units), *units))
            self.write(output, "3I", pointer, value["num"] & 0xFFFFFFFF,
                       value["max"] & 0xFFFFFFFF)
        else:
            pointer, count = self._make_string(value)
            self.write(output, "3I", pointer, count, count)

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if self.stop is not None and address == self.stop:
            cpu.emu_stop()
            return
        if address == self.value_evaluator or address == self.lvalue_evaluator:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            index = self.evaluation
            kind, value = self.operands[index]
            if address == self.lvalue_evaluator:
                # execLocalVariable/execInstanceVariable contract: write the
                # value into the variable, publish its address in GPropAddr,
                # and still copy the value to the destination.
                variable = self.out_vars[index]
                if kind == "lint":
                    packed = struct.pack("<i", value)
                elif kind == "lvector":
                    packed = struct.pack("<3f", *(_f32(v) for v in value))
                else:
                    raise ValueError(f"unknown lvalue operand kind {kind}")
                self.cpu.mem_write(variable, packed)
                self.cpu.mem_write(output, packed)
                self.write(PROP_ADDR, "I", variable)
            elif kind == "float":
                self.write(output, "f", _f32(value))
            elif kind in ("int", "bool"):
                self.write(output, "I", value & 0xFFFFFFFF)
            elif kind == "vector":
                self.cpu.mem_write(output, struct.pack("<3f", *(_f32(v) for v in value)))
            elif kind == "string":
                self._write_fstring(output, value)
            else:
                raise ValueError(f"unknown operand kind {kind}")
            self.events.append(value)
            self.evaluation += 1
        return super().on_instruction(cpu, address, size, data)

    def run(self, native: str, case: str, operands: list[tuple[str, object]]) -> dict[str, object]:
        spec = NATIVES[native]
        self.operands = operands
        self.evaluation = 0
        self.events = []
        self.out_vars = {}
        for index, (kind, _value) in enumerate(operands):
            if kind.startswith("l"):
                variable = self.alloc(16)
                self.cpu.mem_write(variable, b"\xa5" * 16)
                self.out_vars[index] = variable
        self.write(PROP_ADDR, "I", 0xDEADBEEF)
        # The replacement evaluators consume each one-byte token without a
        # serialized payload, so the wrapper's own Step increments plus
        # EndFunctionParms stay directly observable.
        code = self.alloc(len(operands) + 1)
        self.cpu.mem_write(code, bytes([TOKENS[kind] for kind, _ in operands] + [END_FUNCTION_PARMS]))
        frame = self.alloc(0x20)
        self.write(frame + 8, "2I", 0, code)
        result = self.alloc(16)
        self.cpu.mem_write(result, b"\x7f" * 16)
        stop = spec.get("stop")
        fault = None
        try:
            if stop is not None:
                # FString bodies are stopped at the instruction after the
                # result store; the destructor tail is compiler cleanup.
                self.stop = stop
                stack = self.stack
                for register, value in [
                    (UC_X86_REG_ESP, stack),
                    (UC_X86_REG_ECX, 0),
                    (UC_X86_REG_FPCW, 0x037F),
                    (UC_X86_REG_FPSW, 0),
                    (UC_X86_REG_FPTAG, 0xFFFF),
                ]:
                    self.cpu.reg_write(register, value)
                self.write(stack, "I", self.done)
                self.cpu.mem_write(stack + 4, struct.pack("<2I", frame, result))
                try:
                    self.cpu.emu_start(spec["body"], stop + 1, count=4000000)
                    if self.cpu.reg_read(UC_X86_REG_EIP) != stop:
                        raise RuntimeError(f"native did not reach result boundary {stop:x}")
                finally:
                    self.stop = None
            else:
                self.call(spec["body"], 0, struct.pack("<2I", frame, result))
        except RuntimeError as error:
            if "Invalid memory" not in str(error):
                raise
            fault = str(error)
        out_bits = {
            index: list(struct.unpack("<3I", self.cpu.mem_read(variable, 12)))
            for index, variable in self.out_vars.items()
        }
        width = struct.calcsize("<" + spec["result"])
        raw_result = self.cpu.mem_read(result, width)
        result_bits = list(struct.unpack("<%dI" % (width // 4), raw_result))
        # JSON cannot carry inf/NaN; resultBits is the authoritative channel.
        result_value = [
            v if isinstance(v, int) or abs(v) != float("inf") and v == v else {"bits": b}
            for v, b in zip(struct.unpack("<" + spec["result"], raw_result), result_bits)
        ]
        record = {
            "name": case,
            "native": native,
            "index": spec["index"],
            "operands": [value for _, value in operands],
            "lvalue": [kind.startswith("l") for kind, _ in operands],
            "result": result_value[0] if len(result_value) == 1 else result_value,
            "resultBits": result_bits,
            "resultTail": list(self.cpu.mem_read(result + width, 16 - width)),
            "outBits": {str(index): bits for index, bits in out_bits.items()},
            "propAddr": self.read(PROP_ADDR, "I")[0],
            "events": self.events,
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
        }
        if fault is not None:
            record["fault"] = fault
        return record

    def fast_call(self, body: int, bits: int, frame: int, code: int, result: int) -> int:
        """Single-float-operand body at sweep speed: the x86 evaluator stub
        copies fast_input to the destination, and until=self.done replaces
        the per-instruction stop hook."""
        self.write(self.fast_input, "I", bits)
        stack = self.stack
        for register, value in [
            (UC_X86_REG_ESP, stack),
            (UC_X86_REG_FPCW, 0x037F),
            (UC_X86_REG_FPSW, 0),
            (UC_X86_REG_FPTAG, 0xFFFF),
        ]:
            self.cpu.reg_write(register, value)
        self.write(stack, "I", self.done)
        self.cpu.mem_write(stack + 4, struct.pack("<2I", frame, result))
        self.write(frame + 8, "2I", 0, code)
        self.cpu.emu_start(body, self.done, count=100000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError("sweep body did not return")
        return self.read(result, "I")[0]

    def sweep(self, native: str, inputs) -> bytes:
        """Run one native body over every float32 bit pattern in `inputs`;
        returns packed little-endian (in, out) u32 pairs."""
        spec = NATIVES[native]
        table_slot = EVALUATOR_TABLE + FLOAT_OPERAND * 4
        saved = self.read(table_slot, "I")[0]
        self.write(table_slot, "I", self.fast_evaluator)
        code = self.alloc(8)
        self.cpu.mem_write(code, bytes([FLOAT_OPERAND, END_FUNCTION_PARMS]))
        frame = self.alloc(0x20)
        result = self.alloc(16)
        packed = bytearray()
        try:
            for bits in inputs:
                packed += struct.pack("<2I", bits, self.fast_call(spec["body"], bits, frame, code, result))
        finally:
            self.write(table_slot, "I", saved)
        return bytes(packed)


INF = 0x7F800000
NINF = 0xFF800000
NAN = 0x7FC00000          # canonical positive quiet NaN
NAN_P1 = 0x7FC00001       # quiet NaN, payload 1
NNAN_P1 = 0xFFC00001      # negative quiet NaN, payload 1
SNAN = 0x7F800001         # positive signaling NaN
NEG_ZERO = 0x80000000
F32_MAX = 0x7F7FFFFF
DENORM_1 = 0x00000001
DENORM_MID = 0x00400000
INT_MIN = -0x80000000
INT_MAX = 0x7FFFFFFF
X87_RANGE = 0x5F000000    # exactly 2^63 — the largest FSIN/FCOS in-range value
X87_OVER = 0x5F000001     # first out-of-range pattern


def _str(value):
    return ("string", value)


def _fstring(units, num, max_):
    return ("string", {"units": units, "num": num, "max": max_})


CASES = [
    # ---- 115 < / 120 <= / 121 >=: two FString temporaries, ArrayNum==0
    #      substitutes the empty-string buffer at 0x101ef654, appStrcmp
    #      (shipped MSVCRT wcscmp) compares UTF-16 code units unsigned, then
    #      setl/setle/setge on the signed result ----
    ("slt-less", "slt", [_str("abc"), _str("abd")]),
    ("slt-greater", "slt", [_str("abd"), _str("abc")]),
    ("slt-equal", "slt", [_str("abc"), _str("abc")]),
    ("slt-mixed-case", "slt", [_str("Abc"), _str("abc")]),   # 'A'<'a': case-sensitive
    ("slt-mixed-case-rev", "slt", [_str("abc"), _str("Abc")]),
    ("slt-empty-empty", "slt", [_str(""), _str("")]),
    ("slt-empty-left", "slt", [_str(""), _str("a")]),
    ("slt-empty-right", "slt", [_str("a"), _str("")]),
    ("slt-prefix-short", "slt", [_str("ab"), _str("abc")]),
    ("slt-prefix-long", "slt", [_str("abc"), _str("ab")]),
    ("slt-high-bmp", "slt", [_str("Ā"), _str("z")]),          # U+0100 > 'z'
    ("slt-high-bmp-rev", "slt", [_str("z"), _str("Ā")]),
    # Unsigned code-unit order: U+8000 > 'a' where a signed compare would
    # treat it as negative and report less.
    ("slt-unsigned-hi", "slt", [_str("耀"), _str("a")]),       # U+8000
    ("slt-unsigned-top", "slt", [_str("耀"), _str("￿")]),   # U+8000 < U+FFFF
    ("slt-surrogate", "slt", [_str("\ud83d"), _str("")]),   # lone surrogate < U+E000
    ("slt-embedded-zero", "slt",
     [_fstring([0x61, 0x00, 0x62, 0x00], 4, 4), _str("a")]),   # "a\0b" == "a"
    # num==0 substitutes the empty buffer even with a valid data pointer —
    # result must equal empty-vs-"a" (less), proving ArrayNum drives it.
    ("slt-numzero-ptr", "slt", [_fstring([0x61, 0x00], 0, 2), _str("a")]),
    ("slt-numzero-both", "slt", [_fstring([0x61, 0x00], 0, 2), _fstring([0x62, 0x00], 0, 2)]),
    # num!=0 with a null data pointer reaches wcscmp(0, ...) — an invalid
    # read proves the substitution keys on num, not on the pointer.
    ("slt-nullptr-num", "slt", [_fstring(None, 5, 5), _str("a")]),
    ("sle-less", "sle", [_str("abc"), _str("abd")]),
    ("sle-greater", "sle", [_str("abd"), _str("abc")]),
    ("sle-equal", "sle", [_str("abc"), _str("abc")]),
    ("sle-mixed-case", "sle", [_str("Abc"), _str("abc")]),
    ("sle-mixed-case-rev", "sle", [_str("abc"), _str("Abc")]),
    ("sle-empty-empty", "sle", [_str(""), _str("")]),
    ("sle-empty-left", "sle", [_str(""), _str("a")]),
    ("sle-empty-right", "sle", [_str("a"), _str("")]),
    ("sle-prefix-short", "sle", [_str("ab"), _str("abc")]),
    ("sle-prefix-long", "sle", [_str("abc"), _str("ab")]),
    ("sle-high-bmp", "sle", [_str("Ā"), _str("z")]),
    ("sle-unsigned-hi", "sle", [_str("耀"), _str("a")]),
    ("sle-embedded-zero", "sle",
     [_fstring([0x61, 0x00, 0x62, 0x00], 4, 4), _str("a")]),
    ("sle-numzero-ptr", "sle", [_fstring([0x61, 0x00], 0, 2), _str("a")]),
    ("sle-nullptr-num", "sle", [_fstring(None, 5, 5), _str("a")]),
    ("sge-less", "sge", [_str("abc"), _str("abd")]),
    ("sge-greater", "sge", [_str("abd"), _str("abc")]),
    ("sge-equal", "sge", [_str("abc"), _str("abc")]),
    ("sge-mixed-case", "sge", [_str("Abc"), _str("abc")]),
    ("sge-mixed-case-rev", "sge", [_str("abc"), _str("Abc")]),
    ("sge-empty-empty", "sge", [_str(""), _str("")]),
    ("sge-empty-left", "sge", [_str(""), _str("a")]),
    ("sge-empty-right", "sge", [_str("a"), _str("")]),
    ("sge-prefix-short", "sge", [_str("ab"), _str("abc")]),
    ("sge-prefix-long", "sge", [_str("abc"), _str("ab")]),
    ("sge-high-bmp", "sge", [_str("Ā"), _str("z")]),
    ("sge-unsigned-hi", "sge", [_str("耀"), _str("a")]),
    ("sge-embedded-zero", "sge",
     [_fstring([0x61, 0x00, 0x62, 0x00], 4, 4), _str("a")]),
    ("sge-numzero-ptr", "sge", [_fstring([0x61, 0x00], 0, 2), _str("a")]),
    ("sge-nullptr-num", "sge", [_fstring(None, 5, 5), _str("a")]),

    # ---- 237 Asc: ArrayNum==0 substitutes the empty buffer, then the result
    #      is the zero-extended first UTF-16 unit (movzx word [data]) ----
    ("asc-A", "asc", [_str("A")]),
    ("asc-a", "asc", [_str("a")]),
    ("asc-Z", "asc", [_str("Z")]),
    ("asc-0", "asc", [_str("0")]),
    ("asc-empty", "asc", [_str("")]),
    ("asc-first-only", "asc", [_str("ab")]),
    ("asc-latin1", "asc", [_str("é")]),                       # U+00E9 -> 233
    ("asc-high-bmp", "asc", [_str("Ā")]),                   # U+0100 -> 256
    ("asc-unsigned-top", "asc", [_str("￿")]),              # U+FFFF -> 65535
    ("asc-surrogate", "asc", [_str("\ud83d")]),               # lone lead -> 55357
    ("asc-embedded-zero", "asc",
     [_fstring([0x61, 0x00, 0x62, 0x00], 4, 4)]),               # first unit 'a'
    ("asc-leading-zero", "asc",
     [_fstring([0x00, 0x61, 0x62, 0x00], 4, 4)]),               # first unit NUL -> 0
    ("asc-numzero-ptr", "asc", [_fstring([0x61, 0x00], 0, 2)]),  # num==0 -> 0
    ("asc-nullptr-num", "asc", [_fstring(None, 5, 5)]),          # reads [0] -> fault

    # ---- 131 ^^: each dword operand tested with test/sete (==0), the two
    #      flags XORed — nonzero means true for ANY nonzero bit pattern ----
    ("xor-ff", "xor", [("bool", 0), ("bool", 0)]),
    ("xor-ft", "xor", [("bool", 0), ("bool", 1)]),
    ("xor-tf", "xor", [("bool", 1), ("bool", 0)]),
    ("xor-tt", "xor", [("bool", 1), ("bool", 1)]),
    ("xor-nonzero-a", "xor", [("bool", 5), ("bool", 0)]),
    ("xor-nonzero-b", "xor", [("bool", 0), ("bool", 7)]),
    ("xor-nonzero-both", "xor", [("bool", 2), ("bool", 3)]),
    ("xor-neg", "xor", [("bool", 0xFFFFFFFF), ("bool", 1)]),
    ("xor-signbit", "xor", [("bool", 0x80000000), ("bool", 0)]),

    # ---- 160 /=: fcomp of the float32 divisor against the embedded 0.0 at
    #      0x101765c4 — C3 (equal OR unordered) jumps to the _ftol(0.0f) path
    #      that stores 0 to BOTH the out int and the result; otherwise
    #      fild/fdiv in 80-bit, then the shipped MSVCRT _ftol's truncate
    #      FISTP qword and only the low DWORD is stored ----
    ("diveq-basic", "diveq", [("lint", 7), ("float", 0x40000000)]),            # 7/2 -> 3
    ("diveq-neg", "diveq", [("lint", -7), ("float", 0x40000000)]),             # -> -3
    ("diveq-negdiv", "diveq", [("lint", 7), ("float", 0xC0000000)]),           # -> -3
    ("diveq-half", "diveq", [("lint", 7), ("float", 0x3F000000)]),             # 7/0.5 -> 14
    ("diveq-trunc", "diveq", [("lint", 7), ("float", 0x40400000)]),            # 7/3 -> 2
    ("diveq-trunc-neg", "diveq", [("lint", -7), ("float", 0x40400000)]),       # -> -2
    # Zero or NaN divisor: C3 path — the previous out value is NOT kept;
    # _ftol(0.0f) stores 0 to both the variable and the result.
    ("diveq-zero", "diveq", [("lint", 5), ("float", 0x00000000)]),
    ("diveq-negzero", "diveq", [("lint", 5), ("float", NEG_ZERO)]),
    ("diveq-nan", "diveq", [("lint", 5), ("float", NAN)]),
    ("diveq-nan-payload", "diveq", [("lint", 5), ("float", NAN_P1)]),
    ("diveq-zero-var", "diveq", [("lint", 0), ("float", 0x00000000)]),
    # No guard for non-zero non-NaN divisors: inf yields A/inf -> +-0 -> 0.
    ("diveq-inf", "diveq", [("lint", 5), ("float", INF)]),
    ("diveq-neginf", "diveq", [("lint", -5), ("float", NINF)]),
    # int64-range quotients truncate and wrap to the low DWORD.
    ("diveq-wrap", "diveq", [("lint", INT_MAX), ("float", 0x3F000000)]),       # *2 -> 0xfffffffe
    ("diveq-intmin-half", "diveq", [("lint", INT_MIN), ("float", 0x3F000000)]),  # -2^32 -> 0
    ("diveq-intmin-negone", "diveq", [("lint", INT_MIN), ("float", 0xBF800000)]),  # +2^31 -> 0x80000000
    # Quotient outside int64 -> _ftol stores the integer indefinite -> low
    # DWORD 0.
    ("diveq-overflow64", "diveq", [("lint", INT_MAX), ("float", DENORM_MID)]),
    ("diveq-denormal-div", "diveq", [("lint", 1), ("float", DENORM_1)]),
    # 80-bit quotient: INT_MAX / 4.665708e-10 exact = 4602696374922633487.56…
    # — the 64-bit significand keeps it below ...488 while the 53-bit double
    # rounds to ...728.  The low DWORDs differ (0x843de10f vs 0x843de200).
    ("diveq-extended", "diveq", [("lint", INT_MAX), ("float", 0x30004000)]),
    ("diveq-nonlvalue", "diveq", [("int", 7), ("float", 0x40000000)]),

    # ---- 297 *=: GPropAddr out vector; per component fld arg1 / fmul arg0
    #      in 80-bit with a float32 store back through edi, then the three
    #      mutated words copy to the result ----
    ("muleq-basic", "muleq", [("lvector", [0x40000000, 0x40400000, 0x40800000]),
                              ("vector", [0x40400000, 0x40000000, 0x3F800000])]),
    ("muleq-neg", "muleq", [("lvector", [0xBF800000, 0x40000000, 0xC0000000]),
                            ("vector", [0x40000000, 0xBF800000, 0x40000000])]),
    ("muleq-zero", "muleq", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                             ("vector", [0x00000000, 0x00000000, 0x00000000])]),
    ("muleq-negzero", "muleq", [("lvector", [0x3F800000, 0xBF800000, 0x40000000]),
                                ("vector", [NEG_ZERO, 0x00000000, NEG_ZERO])]),
    ("muleq-inf", "muleq", [("lvector", [INF, 0x3F800000, 0xBF800000]),
                            ("vector", [0x40000000, INF, 0x40000000])]),
    ("muleq-inf-zero", "muleq", [("lvector", [INF, 0x3F800000, 0x00000000]),
                                 ("vector", [0x00000000, 0x3F800000, INF])]),
    ("muleq-nan", "muleq", [("lvector", [NAN, 0x3F800000, 0x40000000]),
                            ("vector", [0x40000000, NAN_P1, 0x3F800000])]),
    ("muleq-nan-tie", "muleq", [("lvector", [NAN_P1, NNAN_P1, 0x3F800000]),
                                ("vector", [NNAN_P1, NAN_P1, 0x40000000])]),
    ("muleq-denormal", "muleq", [("lvector", [DENORM_1, DENORM_MID, 0x3F800000]),
                                 ("vector", [0x3F800000, 0x40000000, DENORM_1])]),
    ("muleq-max", "muleq", [("lvector", [F32_MAX, 0xBF800000, 0x3F000000]),
                            ("vector", [0x40000000, F32_MAX, 0x40000000])]),
    ("muleq-snan", "muleq", [("lvector", [SNAN, 0x3F800000, 0x40000000]),
                             ("vector", [0x40000000, 0x3F800000, 0x3F800000])]),
    ("muleq-nonlvalue", "muleq", [("vector", [0x40000000, 0x40400000, 0x40800000]),
                                  ("vector", [0x40400000, 0x40000000, 0x3F800000])]),

    # ---- 187/188/189/190: fld f32 -> fstp qword -> Core thunk running the
    #      x87 FSIN/FCOS/FPTAN/FPATAN on the widened double -> one fstp f32.
    #      Pinned edges: zeros, pi/2 multiples, the |x| > 2^63 passthrough
    #      boundary, infinities, quiet/signaling NaN payloads, denormals ----
    ("sin-zero", "sin", [("float", 0x00000000)]),
    ("sin-negzero", "sin", [("float", NEG_ZERO)]),
    ("sin-half", "sin", [("float", 0x3F000000)]),
    ("sin-pi2", "sin", [("float", 0x3FC90FDB)]),                  # ~pi/2
    ("sin-pi", "sin", [("float", 0x40490FDB)]),                   # ~pi
    ("sin-range-edge", "sin", [("float", X87_RANGE)]),            # 2^63: computed
    ("sin-range-over", "sin", [("float", X87_OVER)]),             # passthrough
    ("sin-huge", "sin", [("float", 0x7E967699)]),                 # 1e38 passthrough
    ("sin-max", "sin", [("float", F32_MAX)]),                     # passthrough
    ("sin-inf", "sin", [("float", INF)]),
    ("sin-neginf", "sin", [("float", NINF)]),
    ("sin-nan", "sin", [("float", NAN)]),
    ("sin-nan-payload", "sin", [("float", NAN_P1)]),
    ("sin-negnan-payload", "sin", [("float", NNAN_P1)]),
    ("sin-snan", "sin", [("float", SNAN)]),
    ("sin-denormal", "sin", [("float", DENORM_1)]),
    ("cos-zero", "cos", [("float", 0x00000000)]),
    ("cos-negzero", "cos", [("float", NEG_ZERO)]),
    ("cos-half", "cos", [("float", 0x3F000000)]),
    ("cos-pi2", "cos", [("float", 0x3FC90FDB)]),
    ("cos-pi", "cos", [("float", 0x40490FDB)]),
    ("cos-range-edge", "cos", [("float", X87_RANGE)]),
    ("cos-range-over", "cos", [("float", X87_OVER)]),
    ("cos-huge", "cos", [("float", 0x7E967699)]),
    ("cos-inf", "cos", [("float", INF)]),
    ("cos-neginf", "cos", [("float", NINF)]),
    ("cos-nan", "cos", [("float", NAN)]),
    ("cos-nan-payload", "cos", [("float", NAN_P1)]),
    ("cos-negnan-payload", "cos", [("float", NNAN_P1)]),
    ("cos-snan", "cos", [("float", SNAN)]),
    ("cos-denormal", "cos", [("float", DENORM_1)]),
    ("tan-zero", "tan", [("float", 0x00000000)]),
    ("tan-negzero", "tan", [("float", NEG_ZERO)]),
    ("tan-half", "tan", [("float", 0x3F000000)]),
    ("tan-pi4", "tan", [("float", 0x3F490FDB)]),                  # ~pi/4 -> ~1
    ("tan-pi2", "tan", [("float", 0x3FC90FDB)]),                  # huge negative
    ("tan-range-edge", "tan", [("float", X87_RANGE)]),
    ("tan-range-over", "tan", [("float", X87_OVER)]),             # -> +0
    ("tan-huge", "tan", [("float", 0x7E967699)]),                 # -> +0
    ("tan-inf", "tan", [("float", INF)]),                         # -> +0
    ("tan-neginf", "tan", [("float", NINF)]),                     # -> +0
    ("tan-nan", "tan", [("float", NAN)]),
    ("tan-nan-payload", "tan", [("float", NAN_P1)]),
    ("tan-snan", "tan", [("float", SNAN)]),
    ("tan-denormal", "tan", [("float", DENORM_1)]),
    ("atan-zero", "atan", [("float", 0x00000000)]),
    ("atan-negzero", "atan", [("float", NEG_ZERO)]),
    ("atan-half", "atan", [("float", 0x3F000000)]),
    ("atan-one", "atan", [("float", 0x3F800000)]),
    ("atan-negone", "atan", [("float", 0xBF800000)]),
    ("atan-pi2", "atan", [("float", 0x3FC90FDB)]),
    ("atan-huge", "atan", [("float", 0x7E967699)]),               # -> +pi/2 f32
    ("atan-neghuge", "atan", [("float", 0xFE967699)]),            # -> -pi/2 f32
    ("atan-inf", "atan", [("float", INF)]),                       # -> +pi/2 f32
    ("atan-neginf", "atan", [("float", NINF)]),                   # -> -pi/2 f32
    ("atan-nan", "atan", [("float", NAN)]),
    ("atan-nan-payload", "atan", [("float", NAN_P1)]),
    ("atan-negnan-payload", "atan", [("float", NNAN_P1)]),
    ("atan-snan", "atan", [("float", SNAN)]),
    ("atan-denormal", "atan", [("float", DENORM_1)]),
    ("atan-max", "atan", [("float", F32_MAX)]),
]

# Transcendental sweep inputs: targeted edges, near-boundary candidates, then
# 2^20 LCG float32 bit patterns.  Deterministic — the validator replays the
# identical sequence against the JavaScript implementation.
SWEEP_RANDOM = 1 << 20
LCG_SEED = 0x9E3779B9


def _lcg_stream(seed, count):
    x = seed
    for _ in range(count):
        x = (x * 1103515245 + 12345) & 0xFFFFFFFF
        yield x


def _targeted_inputs():
    out = [
        0x00000000, 0x80000000, 0x3F800000, 0xBF800000, 0x3F000000, 0xBF000000,
        0x3FC90FDB, 0xBFC90FDB, 0x40490FDB, 0xC0490FDB, 0x3F490FDB, 0xBF490FDB,
        0x3E22F983, 0x5EFFFFFF, X87_RANGE, X87_OVER, 0x5F000002, 0x5F7FFFFF,
        0x7E967699, 0xFE967699, F32_MAX, 0xFF7FFFFF,
        INF, NINF, NAN, NAN_P1, NNAN_P1, 0xFFC00000, SNAN, 0xFF800001,
        DENORM_1, 0x80000001, DENORM_MID, 0x80000002, 0x00000002, 0x7F7FFFFE,
        0x00800000, 0x80800000,
    ]
    # Float32s nearest to k * pi/2 and k * pi for small and large k — the
    # argument-reduction region where reduction error concentrates.
    for k in list(range(1, 65)) + [1 << e for e in (10, 16, 20, 24, 30, 40, 50, 60)]:
        for mult in (math.pi / 2, math.pi, 2 * math.pi):
            bits = _f32bits(k * mult)
            out += [bits, (bits + 1) & 0xFFFFFFFF, (bits - 1) & 0xFFFFFFFF,
                    bits | 0x80000000]
    return out


def _boundary_inputs(fn, count, seed):
    """Inputs whose double result sits within ~2^-13 of an f32 rounding
    midpoint — where a last-ulp double difference survives float32
    narrowing."""
    out = []
    for bits in _lcg_stream(seed, 4 << 20):
        value = _f32(bits)
        try:
            y = fn(value)
        except ValueError:
            continue
        if not math.isfinite(y) or y == 0:
            continue
        mantissa = struct.unpack("<Q", struct.pack("<d", y))[0] & ((1 << 52) - 1)
        distance = abs((mantissa & 0x1FFFFFFF) - 0x10000000)
        if distance < (1 << 13):
            out.append(bits)
            if len(out) >= count:
                break
    return out


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-string-transcendental-oracle.py GAME_ROOT")
    probe = StringTranscendentalProbe(Path(sys.argv[1]))
    cases = [probe.run(native, name, operands) for name, native, operands in CASES]
    # JavaScript cannot hold a signaling NaN: reading one through a typed
    # array quiets it before the VM sees the operand.  For every case whose
    # operands contain an sNaN, run the body a second time on the quieted
    # bits — that is the original's answer to exactly what the VM can be
    # fed — and attach it as "js*".  The raw sNaN results stay in the
    # primary fields as evidence of the original's true behavior.
    def quiet(word):
        return word | 0x400000 if (word >> 23) & 0xFF == 0xFF and 0 < (word & 0x7FFFFF) < 0x400000 else word

    def quieted(kind, value):
        if kind == "float":
            return quiet(value)
        if kind in ("vector", "lvector"):
            return [quiet(v) for v in value]
        return value

    for case, (name, native, operands) in zip(cases, CASES):
        quiet_operands = [(kind, quieted(kind, value)) for kind, value in operands]
        if quiet_operands != operands:
            js = probe.run(native, name + "-js", quiet_operands)
            case["jsOperands"] = js["operands"]
            case["jsResultBits"] = js["resultBits"]
            case["jsOutBits"] = js["outBits"]
            case["jsPropAddr"] = js["propAddr"]

    sweep = {}
    for name, fn in (("sin", math.sin), ("cos", math.cos),
                     ("tan", math.tan), ("atan", math.atan)):
        inputs = (_targeted_inputs()
                  + _boundary_inputs(fn, 256, LCG_SEED + NATIVES[name]["index"])
                  + list(_lcg_stream(LCG_SEED ^ NATIVES[name]["index"], SWEEP_RANDOM)))
        packed = probe.sweep(name, iter(inputs))
        sweep[name] = {"count": len(inputs), "data": base64.b64encode(packed).decode("ascii")}

    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256, "MSVCRT.dll": MSVCRT_SHA256},
        "addresses": {
            "evaluatorTable": hex(EVALUATOR_TABLE),
            "propAddr": hex(PROP_ADDR),
            "propObject": hex(PROP_OBJECT),
            "emptyString": "0x101ef654",
            "appStrcmp": {"thunk": "0x101012c1", "body": "0x10123540"},
            "natives": {
                name: {"index": spec["index"], "thunk": hex(spec["thunk"]), "body": hex(spec["body"])}
                for name, spec in NATIVES.items()
            },
        },
        "tokens": {
            "FloatConst": hex(FLOAT_OPERAND),
            "IntConst": hex(INT_OPERAND),
            "StringConst": hex(STRING_OPERAND),
            "VectorConst": hex(VECTOR_OPERAND),
            "LocalVariable": hex(LVALUE_OPERAND),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
        "sweep": sweep,
    }))


if __name__ == "__main__":
    main()
