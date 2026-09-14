#!/usr/bin/env python3
"""Execute Core's original rotator/float-modulo natives in an x86 emulator.

Same harness as native-normal-axes-oracle.py: the operand evaluators are the
only stubbed services; every instruction of the native bodies runs from the
hash-checked GOTY Core.dll.  Two extensions document this batch:

* ``MSVCRT.dll`` is loaded alongside Engine/Core at its preferred base so the
  native bodies reach the REAL shipped CRT code: ``_CIfmod`` behind the fmod
  cdecl thunk used by ``%`` (173) and ``_ftol`` used by ``*`` (287/288).
  The kernel32 imports those CRT paths touch are satisfied by minimal x86
  stubs (TLS cells, last-error, a bump heap) — anything else raises.
* ``lrotator`` operands publish a per-operand variable through GPropAddr —
  AddEqual/SubtractEqual_RotatorRotator (318/319) write through it.

The bodies under test:

    142 ==(rotator,rotator)->bool        thunk 0x10102b30 -> body 0x10139400
    173 %(float,float)->float            thunk 0x101031d9 -> body 0x10135020
    203 !=(rotator,rotator)->bool        thunk 0x10102086 -> body 0x101394f0
    276 >>(vector,rotator)->vector       thunk 0x10101cc6 -> body 0x101380e0
    287 *(rotator,float)->rotator        thunk 0x10101f64 -> body 0x101395e0
    288 *(float,rotator)->rotator        thunk 0x10101c12 -> body 0x101396d0
    317 -(rotator,rotator)->rotator      thunk 0x1010164a -> body 0x10139bb0
    318 +=(out rotator,rotator)->rotator thunk 0x10102059 -> body 0x10139c90
    319 -=(out rotator,rotator)->rotator thunk 0x10102a2c -> body 0x10139d90

Floats and rotator components cross the harness as bit patterns/integers so
the cases can pin denormals, signed zeros, infinities, NaN payloads and the
rotator sine-table quantization without JSON ambiguity.

Run:
    NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python \
        python3 scripts/native-rotator-modulo-oracle.py GAME_ROOT
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_ESP


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
VECTOR_OPERAND = 0x23     # execVectorConst
ROTATOR_OPERAND = 0x22    # execRotatorConst
LVALUE_OPERAND = 0x00     # execLocalVariable
TOKENS = {"float": FLOAT_OPERAND, "vector": VECTOR_OPERAND,
          "rotator": ROTATOR_OPERAND, "lrotator": LVALUE_OPERAND}

NATIVES = {
    "req":     {"index": 142, "thunk": 0x10102B30, "body": 0x10139400, "result": "I"},
    "mod":     {"index": 173, "thunk": 0x101031D9, "body": 0x10135020, "result": "f"},
    "rne":     {"index": 203, "thunk": 0x10102086, "body": 0x101394F0, "result": "I"},
    "rrotate": {"index": 276, "thunk": 0x10101CC6, "body": 0x101380E0, "result": "3f"},
    "rmulf":   {"index": 287, "thunk": 0x10101F64, "body": 0x101395E0, "result": "3i"},
    "fmulr":   {"index": 288, "thunk": 0x10101C12, "body": 0x101396D0, "result": "3i"},
    "rsub":    {"index": 317, "thunk": 0x1010164A, "body": 0x10139BB0, "result": "3i"},
    "raddeq":  {"index": 318, "thunk": 0x10102059, "body": 0x10139C90, "result": "3i"},
    "rsubeq":  {"index": 319, "thunk": 0x10102A2C, "body": 0x10139D90, "result": "3i"},
}


def _f32(value):
    return struct.unpack("<f", struct.pack("<I", value & 0xFFFFFFFF))[0]


class RotatorModuloProbe(_NATIVE.NativeCollision):
    """Run each native body with controlled expression evaluators."""

    def __init__(self, root: Path):
        super().__init__(root, additional_hashes={"MSVCRT.dll": MSVCRT_SHA256})
        self._install_kernel32()
        # MSVCRT's per-thread-data index (__TlsIndex) ships as 0xFFFFFFFF in
        # the image — DLL init never ran — so point it at emulated TLS slot 0;
        # the _getptd path then lazily allocates the thread block itself.
        self.write(0x7803D004, "I", 0)
        # P_GET_* invokes an evaluator with (FFrame*, destination) and expects
        # the callee to clean those two stack arguments.  Initialize before
        # the GMath constructor call so the code hook can compare addresses.
        self.value_evaluator = self.alloc(16)
        self.lvalue_evaluator = self.alloc(16)
        self.cpu.mem_write(self.value_evaluator, b"\xC2\x08\x00")
        self.cpu.mem_write(self.lvalue_evaluator, b"\xC2\x08\x00")
        self.write(EVALUATOR_TABLE + FLOAT_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + VECTOR_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + ROTATOR_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + LVALUE_OPERAND * 4, "I", self.lvalue_evaluator)
        # The lvalue operand owns a distinct variable; 318/319 publish the
        # out rotator through GPropAddr.
        self.out_vars: dict[int, int] = {}
        self.operands: list[tuple[str, object]] = []
        self.evaluation = 0
        self.events: list[object] = []
        # Core's startup constructor for FGlobalMath: fills the quantized
        # rotator sine table the >> body reads (BSS in the image).
        self.actor = self.alloc(0x400)
        self.call(0x10102978, 0x101B3218, b"")

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
            "GetEnvironmentStrings": mov_eax_ret(empty),
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
            "GetTimeZoneInformation": zero_ret(4),
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
            "CreatePipe": zero_ret(16), "DuplicateHandle": zero_ret(28),
            "GetExitCodeProcess": zero_ret(8), "WaitForSingleObject": zero_ret(8),
            "CreateProcessA": zero_ret(40), "CreateProcessW": zero_ret(40),
            "GetDiskFreeSpaceA": zero_ret(20), "GetLogicalDrives": zero_ret(0),
            "GetFileAttributesA": minus1_ret(4), "GetFileAttributesW": minus1_ret(4),
            "GetCurrentDirectoryA": zero_ret(8), "GetCurrentDirectoryW": zero_ret(8),
            "SetCurrentDirectoryA": zero_ret(4), "SetCurrentDirectoryW": zero_ret(4),
            "SetFileAttributesA": zero_ret(8), "SetFileAttributesW": zero_ret(8),
            "GetFullPathNameA": zero_ret(16), "GetFullPathNameW": zero_ret(16),
            "GetDriveTypeA": mov_eax_ret(3, 4), "GetDriveTypeW": mov_eax_ret(3, 4),
            "CreateDirectoryA": zero_ret(8), "CreateDirectoryW": zero_ret(8),
            "RemoveDirectoryA": zero_ret(4), "RemoveDirectoryW": zero_ret(4),
            "DeleteFileA": zero_ret(4), "DeleteFileW": zero_ret(4),
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

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
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
                if kind == "lrotator":
                    packed = struct.pack("<3i", *value)
                    self.cpu.mem_write(variable, packed)
                    self.cpu.mem_write(output, packed)
                else:
                    raise ValueError(f"unknown lvalue operand kind {kind}")
                self.write(PROP_ADDR, "I", variable)
            elif kind == "float":
                self.write(output, "f", _f32(value))
            elif kind == "vector":
                self.cpu.mem_write(output, struct.pack("<3f", *(_f32(v) for v in value)))
            elif kind == "rotator":
                self.cpu.mem_write(output, struct.pack("<3i", *value))
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
        self.write(frame + 8, "2I", self.actor, code)
        result = self.alloc(16)
        self.cpu.mem_write(result, b"\x7f" * 16)
        self.call(spec["body"], 0, struct.pack("<2I", frame, result))
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
        return {
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


INF = 0x7F800000
NINF = 0xFF800000
NAN = 0x7FC00000          # canonical positive quiet NaN
INDEFINITE = 0xFFC00000   # x87 real indefinite (negative quiet NaN)
NEG_ZERO = 0x80000000
F32_MAX = 0x7F7FFFFF      # 3.4028234663852886e+38
F32_MIN_NORMAL = 0x00800000
DENORM_1 = 0x00000001     # smallest positive denormal ~1.4e-45
DENORM_MID = 0x00400000
NAN_P1 = 0x7FC00001       # quiet NaN, payload 1
NAN_P2 = 0x7FC00002       # quiet NaN, payload 2
NNAN_P1 = 0xFFC00001      # negative quiet NaN, payload 1
NNAN_P2 = 0xFFC00002      # negative quiet NaN, payload 2
SNAN = 0x7F800001         # positive signaling NaN
NSNAN = 0xFF800001        # negative signaling NaN
INT_MIN = -0x80000000
INT_MAX = 0x7FFFFFFF

CASES = [
    # ---- 173 % : float32 operands widened to double for the cdecl fmod
    #      thunk; the shipped MSVCRT _CIfmod runs the fxch/FPREM loop or a
    #      domain-error/NaN action; one FSTP float32 store of the result ----
    ("mod-basic", "mod", [("float", 0x40A00000), ("float", 0x40400000)]),      # 5 % 3 = 2
    ("mod-reversed", "mod", [("float", 0x40400000), ("float", 0x40A00000)]),   # 3 % 5 = 3
    ("mod-neg-dividend", "mod", [("float", 0xC0B00000), ("float", 0x40000000)]),
    ("mod-neg-divisor", "mod", [("float", 0x40B00000), ("float", 0xC0000000)]),
    ("mod-both-neg", "mod", [("float", 0xC0B00000), ("float", 0xC0000000)]),
    ("mod-exact", "mod", [("float", 0x40F00000), ("float", 0x40200000)]),      # 7.5 % 2.5 -> +0
    ("mod-exact-neg", "mod", [("float", 0xC0F00000), ("float", 0x40200000)]),  # -7.5 % 2.5 -> +0
    ("mod-exact-negdiv", "mod", [("float", 0x40F00000), ("float", 0xC0200000)]),
    ("mod-less-than", "mod", [("float", 0x3F000000), ("float", 0x7F000000)]),  # |a|<|b| -> a
    ("mod-one", "mod", [("float", 0x3F800000), ("float", 0x3F800000)]),        # 1 % 1 -> +0
    ("mod-zero-dividend", "mod", [("float", 0x00000000), ("float", 0x40000000)]),
    ("mod-negzero-dividend", "mod", [("float", NEG_ZERO), ("float", 0x40000000)]),  # -> +0
    ("mod-zero-negdivisor", "mod", [("float", 0x00000000), ("float", 0xC0000000)]),
    ("mod-negzero-negdivisor", "mod", [("float", NEG_ZERO), ("float", 0xC0000000)]),
    # Zero divisor: CRT domain error -> x87 real indefinite 0xffc00000.
    ("mod-div-zero", "mod", [("float", 0x3F800000), ("float", 0x00000000)]),
    ("mod-div-negzero", "mod", [("float", 0x3F800000), ("float", NEG_ZERO)]),
    ("mod-neg-div-zero", "mod", [("float", 0xBF800000), ("float", 0x00000000)]),
    ("mod-zero-div-zero", "mod", [("float", 0x00000000), ("float", 0x00000000)]),
    ("mod-negzero-div-zero", "mod", [("float", NEG_ZERO), ("float", 0x00000000)]),
    # Infinite operands are domain errors in the CRT path — including the
    # finite % inf case where plain JS/IEEE fmod would return the dividend.
    ("mod-inf-dividend", "mod", [("float", INF), ("float", 0x40000000)]),
    ("mod-neginf-dividend", "mod", [("float", NINF), ("float", 0x40000000)]),
    ("mod-inf-divisor", "mod", [("float", 0x40A00000), ("float", INF)]),
    ("mod-neginf-divisor", "mod", [("float", 0x40A00000), ("float", NINF)]),
    ("mod-inf-both", "mod", [("float", INF), ("float", INF)]),
    ("mod-inf-div-zero", "mod", [("float", INF), ("float", 0x00000000)]),
    ("mod-zero-div-inf", "mod", [("float", 0x00000000), ("float", INF)]),
    # NaN operands propagate their payload quieted.
    ("mod-nan-a", "mod", [("float", NAN), ("float", 0x40000000)]),
    ("mod-nan-b", "mod", [("float", 0x40000000), ("float", NAN)]),
    ("mod-nan-payload-a", "mod", [("float", NAN_P1), ("float", 0x40000000)]),
    ("mod-nan-payload-b", "mod", [("float", 0x40000000), ("float", NNAN_P1)]),
    ("mod-nan-both", "mod", [("float", NAN_P1), ("float", NNAN_P2)]),
    ("mod-nan-both-swap", "mod", [("float", NNAN_P2), ("float", NAN_P1)]),
    ("mod-nan-div-zero", "mod", [("float", NAN_P1), ("float", 0x00000000)]),
    ("mod-nan-div-inf", "mod", [("float", NAN_P1), ("float", INF)]),
    ("mod-inf-div-nan", "mod", [("float", INF), ("float", NAN_P1)]),
    ("mod-snan-a", "mod", [("float", SNAN), ("float", 0x40000000)]),
    ("mod-snan-b", "mod", [("float", 0x40000000), ("float", NSNAN)]),
    # Denormals and extremes.
    ("mod-denormal-a", "mod", [("float", DENORM_1), ("float", 0x3F800000)]),
    ("mod-denormal-b", "mod", [("float", 0x3F800000), ("float", DENORM_1)]),
    ("mod-denormal-both", "mod", [("float", DENORM_MID), ("float", DENORM_1)]),
    ("mod-denormal-div", "mod", [("float", 0x3F800000), ("float", DENORM_MID)]),
    ("mod-max-b", "mod", [("float", F32_MAX), ("float", 0x40000000)]),
    ("mod-max-minnormal", "mod", [("float", F32_MAX), ("float", F32_MIN_NORMAL)]),
    ("mod-tiny-result", "mod", [("float", 0x00800001), ("float", 0x3F800000)]),

    # ---- 276 >> : per-angle FCoords rows (yaw, pitch, roll) accumulated
    #      through the FCoords transform; result = V dotted with the three
    #      composed axes, all dots in 80-bit with one f32 store each ----
    ("rot-identity", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                 ("rotator", [0, 0, 0])]),
    ("rot-yaw-90", "rrotate", [("vector", [0x3F800000, 0x00000000, 0x00000000]),
                               ("rotator", [0, 16384, 0])]),
    ("rot-pitch-90", "rrotate", [("vector", [0x3F800000, 0x00000000, 0x00000000]),
                                 ("rotator", [16384, 0, 0])]),
    ("rot-roll-90", "rrotate", [("vector", [0x3F800000, 0x00000000, 0x00000000]),
                                ("rotator", [0, 0, 16384])]),
    ("rot-y-90", "rrotate", [("vector", [0x00000000, 0x3F800000, 0x00000000]),
                             ("rotator", [0, 16384, 0])]),
    ("rot-z-90", "rrotate", [("vector", [0x00000000, 0x00000000, 0x3F800000]),
                             ("rotator", [0, 0, 16384])]),
    ("rot-mixed", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                              ("rotator", [8192, 16384, 8192])]),
    ("rot-mixed-2", "rrotate", [("vector", [0x40400000, 0xBF800000, 0x40000000]),
                                ("rotator", [-8192, -16384, -8192])]),
    ("rot-arbitrary", "rrotate", [("vector", [0x3FC00000, 0x40200000, 0xC1200000]),
                                  ("rotator", [12345, -23456, 30000])]),
    ("rot-arbitrary-2", "rrotate", [("vector", [0x42C80000, 0x3E800000, 0xBF000000]),
                                    ("rotator", [-30000, 20000, -10000])]),
    # Components larger than 16 bits keep every bit of the (angle>>2)&0x3fff
    # table index — including 32-bit wrap on angle+0x4000.
    ("rot-wrap", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                             ("rotator", [73728, 147456, -73728])]),
    ("rot-max", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                            ("rotator", [INT_MAX, INT_MIN, 0x40000000])]),
    ("rot-quantized", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                  ("rotator", [1, 2, 3])]),
    ("rot-quantized-neg", "rrotate", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                      ("rotator", [-1, -2, -3])]),
    # Vector operand bit patterns: NaN/inf/denormal/neg-zero components ride
    # through the closing dots.
    ("rot-vec-nan", "rrotate", [("vector", [NAN, 0x3F800000, 0x00000000]),
                                ("rotator", [0, 16384, 0])]),
    ("rot-vec-nan-payload", "rrotate", [("vector", [0x00000000, NAN_P1, 0x00000000]),
                                        ("rotator", [8192, 16384, 8192])]),
    ("rot-vec-nan-tie", "rrotate", [("vector", [NAN_P1, NNAN_P1, 0x00000000]),
                                    ("rotator", [8192, 0, 0])]),
    ("rot-vec-inf", "rrotate", [("vector", [INF, 0x3F800000, 0x00000000]),
                                ("rotator", [0, 0, 16384])]),
    ("rot-vec-neginf", "rrotate", [("vector", [0x00000000, NINF, 0x3F800000]),
                                   ("rotator", [0, 16384, 0])]),
    ("rot-vec-negzero", "rrotate", [("vector", [NEG_ZERO, NEG_ZERO, NEG_ZERO]),
                                    ("rotator", [0, 16384, 0])]),
    ("rot-vec-denormal", "rrotate", [("vector", [DENORM_1, DENORM_MID, 0x00000000]),
                                     ("rotator", [0, 16384, 0])]),
    ("rot-vec-snan", "rrotate", [("vector", [SNAN, 0x3F800000, 0x00000000]),
                                 ("rotator", [8192, 16384, 0])]),

    # ---- 287 rotator*float / 288 float*rotator: FILD int32, FMUL f32 in
    #      80-bit, then the shipped MSVCRT _ftol (truncate FISTP m64) and the
    #      low DWORD is stored per component ----
    ("rmul-basic", "rmulf", [("rotator", [1, 2, 3]), ("float", 0x40000000)]),       # *2
    ("rmul-half", "rmulf", [("rotator", [1, 2, 3]), ("float", 0x3F000000)]),        # *0.5 -> trunc
    ("rmul-half-neg", "rmulf", [("rotator", [-1, -3, -5]), ("float", 0x3F000000)]), # -> 0,-1,-2
    ("rmul-neg-scalar", "rmulf", [("rotator", [1, 3, 5]), ("float", 0xBF000000)]),
    ("rmul-tie-pos", "rmulf", [("rotator", [3, 5, 7]), ("float", 0x3F000000)]),     # 1.5,2.5,3.5 -> 1,2,3
    ("rmul-tie-neg", "rmulf", [("rotator", [-3, -5, -7]), ("float", 0x3F000000)]),
    ("rmul-frac", "rmulf", [("rotator", [100, -100, 7]), ("float", 0x3DCCCCCD)]),   # *0.1
    ("rmul-identity", "rmulf", [("rotator", [16384, -32768, 65536]), ("float", 0x3F800000)]),
    # The 80-bit product: 0x7fffffff x 1.0000001f = 2147483902.9999.. exact
    # (trunc 2147483902) while the double product rounds to 2147483903.
    ("rmul-extended", "rmulf", [("rotator", [INT_MAX, 2, 0]), ("float", 0x3F800001)]),
    ("rmul-extended-neg", "rmulf", [("rotator", [INT_MIN, 1, -1]), ("float", 0x3F800001)]),
    # int32 wrap of the truncated int64 low DWORD; int64 overflow and
    # nonfinite scalars produce the integer indefinite (low DWORD 0).
    ("rmul-wrap", "rmulf", [("rotator", [INT_MAX, INT_MIN, 0x40000000]), ("float", 0x40000000)]),
    ("rmul-overflow64", "rmulf", [("rotator", [INT_MAX, 1, 1]), ("float", 0x501502F9)]),  # *1e10
    ("rmul-edge64", "rmulf", [("rotator", [INT_MAX, 0, 0]), ("float", 0x5F800000)]),      # *2^63ish
    ("rmul-nan-scalar", "rmulf", [("rotator", [1, 2, 3]), ("float", NAN)]),
    ("rmul-nan-payload", "rmulf", [("rotator", [1, 2, 3]), ("float", NAN_P1)]),
    ("rmul-inf-scalar", "rmulf", [("rotator", [1, 2, 3]), ("float", INF)]),
    ("rmul-neginf-scalar", "rmulf", [("rotator", [1, -2, 3]), ("float", NINF)]),
    ("rmul-zero-scalar", "rmulf", [("rotator", [1, 2, 3]), ("float", 0x00000000)]),
    ("rmul-negzero-scalar", "rmulf", [("rotator", [1, -2, 3]), ("float", NEG_ZERO)]),
    ("rmul-denormal", "rmulf", [("rotator", [INT_MAX, 1000, -1000]), ("float", DENORM_MID)]),
    ("rmul-max-component", "rmulf", [("rotator", [INT_MAX, INT_MIN, -1]), ("float", 0x3F8FFFFF)]),
    ("fmul-basic", "fmulr", [("float", 0x40000000), ("rotator", [1, 2, 3])]),
    ("fmul-half", "fmulr", [("float", 0x3F000000), ("rotator", [1, 2, 3])]),
    ("fmul-neg", "fmulr", [("float", 0xBF000000), ("rotator", [1, 3, 5])]),
    ("fmul-extended", "fmulr", [("float", 0x3F800001), ("rotator", [INT_MAX, -1, 0])]),
    ("fmul-wrap", "fmulr", [("float", 0x40000000), ("rotator", [INT_MAX, INT_MIN, 0x40000000])]),
    ("fmul-overflow64", "fmulr", [("float", 0x501502F9), ("rotator", [INT_MAX, 1, 1])]),
    ("fmul-nan", "fmulr", [("float", NAN), ("rotator", [1, 2, 3])]),
    ("fmul-inf", "fmulr", [("float", INF), ("rotator", [1, 2, 3])]),
    ("fmul-negzero", "fmulr", [("float", NEG_ZERO), ("rotator", [1, -2, 3])]),

    # ---- 317 rotator-rotator: three independent dword SUBs ----
    ("rsub-basic", "rsub", [("rotator", [10, 20, 30]), ("rotator", [1, 2, 3])]),
    ("rsub-neg", "rsub", [("rotator", [-10, -20, -30]), ("rotator", [1, -2, 3])]),
    ("rsub-zero", "rsub", [("rotator", [5, -5, 0]), ("rotator", [0, 0, 0])]),
    ("rsub-wrap", "rsub", [("rotator", [INT_MIN, 0, INT_MAX]), ("rotator", [1, -1, INT_MIN])]),
    ("rsub-self", "rsub", [("rotator", [12345, -23456, 30000]), ("rotator", [12345, -23456, 30000])]),

    # ---- 318 += / 319 -=: GPropAddr out rotator, then three dword ADD/SUBs
    #      through the published variable; result copies the three words ----
    ("addeq-basic", "raddeq", [("lrotator", [10, 20, 30]), ("rotator", [1, 2, 3])]),
    ("addeq-neg", "raddeq", [("lrotator", [-10, -20, -30]), ("rotator", [1, -2, 3])]),
    ("addeq-wrap", "raddeq", [("lrotator", [INT_MAX, INT_MIN, 0]), ("rotator", [1, -1, INT_MAX])]),
    ("addeq-nonlvalue", "raddeq", [("rotator", [10, 20, 30]), ("rotator", [1, 2, 3])]),
    ("subeq-basic", "rsubeq", [("lrotator", [10, 20, 30]), ("rotator", [1, 2, 3])]),
    ("subeq-neg", "rsubeq", [("lrotator", [-10, -20, -30]), ("rotator", [1, -2, 3])]),
    ("subeq-wrap", "rsubeq", [("lrotator", [INT_MIN, INT_MAX, 0]), ("rotator", [1, -1, INT_MIN])]),
    ("subeq-nonlvalue", "rsubeq", [("rotator", [10, 20, 30]), ("rotator", [1, 2, 3])]),

    # ---- 142 == / 203 !=: three dword CMPs on the rotator words ----
    ("req-equal", "req", [("rotator", [1, 2, 3]), ("rotator", [1, 2, 3])]),
    ("req-pitch", "req", [("rotator", [1, 2, 3]), ("rotator", [4, 2, 3])]),
    ("req-yaw", "req", [("rotator", [1, 2, 3]), ("rotator", [1, 4, 3])]),
    ("req-roll", "req", [("rotator", [1, 2, 3]), ("rotator", [1, 2, 4])]),
    ("req-extreme", "req", [("rotator", [INT_MIN, INT_MAX, -1]), ("rotator", [INT_MIN, INT_MAX, -1])]),
    ("req-zero", "req", [("rotator", [0, 0, 0]), ("rotator", [0, 0, 0])]),
    ("rne-equal", "rne", [("rotator", [1, 2, 3]), ("rotator", [1, 2, 3])]),
    ("rne-pitch", "rne", [("rotator", [1, 2, 3]), ("rotator", [4, 2, 3])]),
    ("rne-yaw", "rne", [("rotator", [1, 2, 3]), ("rotator", [1, 4, 3])]),
    ("rne-roll", "rne", [("rotator", [1, 2, 3]), ("rotator", [1, 2, 4])]),
    ("rne-extreme", "rne", [("rotator", [INT_MIN, INT_MAX, -1]), ("rotator", [INT_MAX, INT_MAX, -1])]),
    ("rne-zero", "rne", [("rotator", [0, 0, 0]), ("rotator", [0, 0, 0])]),
    # Components differing only above bit 15: a raw dword CMP reports them
    # unequal, while any 16-bit angle normalization would call them equal.
    # These separate the recovered "no normalization" claim from a masked one.
    ("req-highword-pitch", "req", [("rotator", [0x10000, 2, 3]), ("rotator", [0, 2, 3])]),
    ("req-highword-yaw", "req", [("rotator", [1, 0x20002, 3]), ("rotator", [1, 2, 3])]),
    ("rne-highword-pitch", "rne", [("rotator", [0x10000, 2, 3]), ("rotator", [0, 2, 3])]),
    ("rne-highword-roll", "rne", [("rotator", [1, 2, 0x30003]), ("rotator", [1, 2, 3])]),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-rotator-modulo-oracle.py GAME_ROOT")
    probe = RotatorModuloProbe(Path(sys.argv[1]))
    cases = [probe.run(native, name, operands) for name, native, operands in CASES]
    # JavaScript cannot hold a signaling NaN: reading one through a typed
    # array quiets it before the VM sees the operand.  For every case whose
    # operands contain an sNaN, run the body a second time on the quieted
    # operand bits — that is the original's answer to exactly what the VM
    # can be fed — and attach it as "js*".  The raw sNaN results stay in the
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
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256, "MSVCRT.dll": MSVCRT_SHA256},
        "addresses": {
            "evaluatorTable": hex(EVALUATOR_TABLE),
            "propAddr": hex(PROP_ADDR),
            "propObject": hex(PROP_OBJECT),
            "natives": {
                name: {"index": spec["index"], "thunk": hex(spec["thunk"]), "body": hex(spec["body"])}
                for name, spec in NATIVES.items()
            },
        },
        "tokens": {
            "FloatConst": hex(FLOAT_OPERAND),
            "VectorConst": hex(VECTOR_OPERAND),
            "RotatorConst": hex(ROTATOR_OPERAND),
            "LocalVariable": hex(LVALUE_OPERAND),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
