#!/usr/bin/env python3
"""Execute Core's original Object Sqrt/Normal/GetAxes/Smerp/Mirror natives.

Same harness as native-float-vector-operators-oracle.py: the operand
evaluators are the only stubbed services, every x87 FLD/FMUL/FADDP/FSUBP/
FSQRT/FDIVR/FCOMP/FST/FSTP instruction and the FFrame cursor updates execute
from the hash-checked GOTY Core.dll.  Two extensions document this batch:

* ``rotator`` operands use a value evaluator that writes three serialized
  int32s (the pitch/yaw/roll words execRotatorConst would produce).
* ``lvector`` operands publish a per-operand variable through GPropAddr —
  GetAxes (229) writes three separate out parameters.

The bodies under test:

    193 Sqrt(float)->float                       thunk 0x101027c0 -> body 0x10136140
    226 Normal(vector)->vector                   thunk 0x10101730 -> body 0x10138de0
    229 GetAxes(rotator,out vector X,Y,Z)        thunk 0x10102d06 -> body 0x10139e90
    248 Smerp(float,float,float)->float          thunk 0x10101587 -> body 0x10136710
    300 MirrorVectorByNormal(vector,vector)->vec thunk 0x10101d2f -> body 0x101392a0

Floats and rotator components cross the harness as bit patterns/integers so
the cases can pin denormals, signed zeros, infinities, NaN and the rotator
sine-table quantization without JSON ambiguity.

Run:
    NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python \
        python3 scripts/native-normal-axes-oracle.py GAME_ROOT
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
EVALUATOR_TABLE = 0x101F41B8
PROP_OBJECT = 0x101E32C0
PROP_ADDR = 0x101E32F8
F64_ONE = 0x101765A8
F64_1EM8 = 0x101765D8
F64_THREE = 0x10177F90
END_FUNCTION_PARMS = 0x16
# Token slots the probe replaces.  The slot choice documents the operand
# role; the bodies only dispatch through the table entry.
FLOAT_OPERAND = 0x1E      # execFloatConst
VECTOR_OPERAND = 0x23     # execVectorConst
ROTATOR_OPERAND = 0x22    # execRotatorConst
LVALUE_OPERAND = 0x00     # execLocalVariable
TOKENS = {"float": FLOAT_OPERAND, "vector": VECTOR_OPERAND,
          "rotator": ROTATOR_OPERAND, "lvector": LVALUE_OPERAND}

NATIVES = {
    "sqrt":   {"index": 193, "thunk": 0x101027C0, "body": 0x10136140, "result": "f"},
    "normal": {"index": 226, "thunk": 0x10101730, "body": 0x10138DE0, "result": "3f"},
    "getAxes": {"index": 229, "thunk": 0x10102D06, "body": 0x10139E90, "result": "3f"},
    "smerp":  {"index": 248, "thunk": 0x10101587, "body": 0x10136710, "result": "f"},
    "mirror": {"index": 300, "thunk": 0x10101D2F, "body": 0x101392A0, "result": "3f"},
}


def _f32(value):
    return struct.unpack("<f", struct.pack("<I", value & 0xFFFFFFFF))[0]


class NormalAxesProbe(_NATIVE.NativeCollision):
    """Run each native body with controlled expression evaluators."""

    def __init__(self, root: Path):
        super().__init__(root)
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
        # Each lvalue operand owns a distinct variable; GetAxes publishes all
        # three of its out vectors through GPropAddr.
        self.out_vars: dict[int, int] = {}
        self.operands: list[tuple[str, object]] = []
        self.evaluation = 0
        self.events: list[object] = []
        # Core's startup constructor for FGlobalMath: fills the quantized
        # rotator sine table GetAxes reads (BSS in the image).
        self.actor = self.alloc(0x400)
        self.call(0x10102978, 0x101B3218, b"")

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
                if kind == "lvector":
                    packed = struct.pack("<3f", *(_f32(v) for v in value))
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

# Squared-length threshold for SafeNormal's FCOMP against the embedded 1e-08:
# 0x38d1b717 squares to 9.99999949475751e-09 (below) and 0x38d1b718 to
# 1.0000000949949049e-08 (above) as adjacent float32s.
BELOW_T = 0x38D1B717
ABOVE_T = 0x38D1B718

CASES = [
    # ---- Sqrt (193): fld f32 -> fstp f64 -> CRT sqrt (x87 FSQRT) -> fstp f32 ----
    ("sqrt-zero", "sqrt", [("float", 0)]),
    ("sqrt-neg-zero", "sqrt", [("float", NEG_ZERO)]),
    ("sqrt-one", "sqrt", [("float", 0x3F800000)]),
    ("sqrt-four", "sqrt", [("float", 0x40800000)]),
    ("sqrt-two", "sqrt", [("float", 0x40000000)]),
    ("sqrt-half", "sqrt", [("float", 0x3F000000)]),
    ("sqrt-quarter", "sqrt", [("float", 0x3E800000)]),
    ("sqrt-tenth", "sqrt", [("float", 0x3DCCCCCD)]),
    ("sqrt-min-normal", "sqrt", [("float", F32_MIN_NORMAL)]),
    ("sqrt-denormal-1", "sqrt", [("float", DENORM_1)]),
    ("sqrt-denormal-mid", "sqrt", [("float", DENORM_MID)]),
    ("sqrt-denormal-2", "sqrt", [("float", 0x00000002)]),
    ("sqrt-max", "sqrt", [("float", F32_MAX)]),
    ("sqrt-almost-max", "sqrt", [("float", 0x7F7FFFFE)]),
    # correctly-rounded boundary probes
    ("sqrt-round-1", "sqrt", [("float", 0x4B7FFFFF)]),
    ("sqrt-round-2", "sqrt", [("float", 0x5A000000)]),
    ("sqrt-round-3", "sqrt", [("float", 0x3F7FFFFF)]),
    ("sqrt-neg-tiny", "sqrt", [("float", 0x80000001)]),   # negative denormal -> indefinite
    ("sqrt-neg-one", "sqrt", [("float", 0xBF800000)]),    # -> x87 real indefinite
    ("sqrt-neg-max", "sqrt", [("float", 0xFF7FFFFF)]),
    ("sqrt-inf", "sqrt", [("float", INF)]),
    ("sqrt-neg-inf", "sqrt", [("float", NINF)]),
    ("sqrt-nan", "sqrt", [("float", NAN)]),
    ("sqrt-nan-payload", "sqrt", [("float", NAN_P1)]),
    ("sqrt-neg-nan-payload", "sqrt", [("float", NNAN_P1)]),
    ("sqrt-snan", "sqrt", [("float", SNAN)]),
    ("sqrt-neg-snan", "sqrt", [("float", NSNAN)]),
    # ---- Normal (226): SafeNormal — 80-bit left-assoc sum, f32 fst double,
    #      1e-08 fcomp on the register, 80-bit FDIVR reciprocal multiply ----
    ("normal-basic", "normal", [("vector", [0x40400000, 0x40800000, 0x00000000])]),
    ("normal-axis", "normal", [("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    ("normal-neg", "normal", [("vector", [0xBF800000, 0xBF800000, 0xBF800000])]),
    ("normal-mixed", "normal", [("vector", [0x3F800000, 0xC0000000, 0x40400000])]),
    ("normal-neg-zero", "normal", [("vector", [NEG_ZERO, NEG_ZERO, NEG_ZERO])]),
    # -0 component keeps its sign through the reciprocal multiply.
    ("normal-neg-zero-comp", "normal", [("vector", [NEG_ZERO, 0x3F800000, 0x00000000])]),
    # Exact squared-length threshold direction: below -> (0,0,0), above ->
    # normalized; both through the single-precision 1e-08 boundary pair.
    ("normal-below-threshold", "normal", [("vector", [BELOW_T, 0x00000000, 0x00000000])]),
    ("normal-above-threshold", "normal", [("vector", [ABOVE_T, 0x00000000, 0x00000000])]),
    # The 80-bit register compare is what branches on 1e-08: here the 80-bit
    # sum is strictly below 1e-08 while the stored double equals 1e-08, so a
    # model comparing the double would normalize where the original zeroes.
    ("normal-window-80bit", "normal", [("vector", [0x38D1B711, 0x33CE62E7, 0x2E3865E6])]),
    # Association proof: (x^2+y^2)+z^2 >= 1e-08 while x^2+(y^2+z^2) < 1e-08 —
    # the original's left-associated sum normalizes where right-association
    # would return the zero vector.
    ("normal-assoc", "normal", [("vector", [0x38D1B716, 0x333E2AD5, 0x2E01D355])]),
    # The 80-bit reciprocal times 0x404b6eaf stores 0x3f7fffff where an
    # f32-rounded reciprocal would store 0x3f7ffffe — the reciprocal is never
    # stored to float32 before the component multiplies.
    ("normal-recip-mul", "normal", [("vector", [0x162A01DE, 0x404B6EAF, 0xBAA1C6F1])]),
    ("normal-denormal", "normal", [("vector", [DENORM_1, DENORM_MID, DENORM_1])]),
    ("normal-denormal-x", "normal", [("vector", [DENORM_MID, 0x3F800000, 0x00000000])]),
    # Squared components overflow to +inf; the +0 reciprocal then produces
    # signed zeros (and the indefinite NaN for an infinite component).
    ("normal-near-overflow", "normal", [("vector", [F32_MAX, F32_MAX, 0x00000000])]),
    ("normal-huge", "normal", [("vector", [0x7E800000, 0x3F800000, 0x00000000])]),
    ("normal-inf-x", "normal", [("vector", [INF, 0x3F800000, 0x00000000])]),
    ("normal-inf-y", "normal", [("vector", [0x3F800000, INF, 0x00000000])]),
    ("normal-inf-z", "normal", [("vector", [0x00000000, 0x00000000, NINF])]),
    ("normal-inf-all", "normal", [("vector", [INF, NINF, INF])]),
    # A NaN component makes the sum unordered: FCOMP sets C0 and the body
    # returns exactly (0,0,0), never propagating the NaN.
    ("normal-nan-x", "normal", [("vector", [NAN, 0x3F800000, 0x00000000])]),
    ("normal-nan-y", "normal", [("vector", [0x3F800000, NAN, 0x00000000])]),
    ("normal-nan-z", "normal", [("vector", [0x3F800000, 0x00000000, NAN])]),
    ("normal-nan-payload", "normal", [("vector", [NAN_P1, 0x3F800000, 0x00000000])]),
    ("normal-snan-x", "normal", [("vector", [SNAN, 0x3F800000, 0x00000000])]),
    ("normal-tiny", "normal", [("vector", [0x34000000, 0x34000000, 0x34000000])]),
    ("normal-under-e6", "normal", [("vector", [0x358637BD, 0x00000000, 0x00000000])]),
    # ---- Smerp (248): A + (B-A)*(3*Alpha^2 - 2*Alpha^3); every intermediate
    #      stays on the x87 stack until the single fstp f32 store ----
    ("smerp-zero", "smerp", [("float", 0), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-one", "smerp", [("float", 0x3F800000), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-half", "smerp", [("float", 0x3F000000), ("float", 0x00000000), ("float", 0x3F800000)]),
    ("smerp-quarter", "smerp", [("float", 0x3E800000), ("float", 0x3F800000), ("float", 0x40400000)]),
    ("smerp-neg-alpha", "smerp", [("float", 0xBF000000), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-over-one", "smerp", [("float", 0x3FC00000), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-eq", "smerp", [("float", 0x3F000000), ("float", 0x40490FDB), ("float", 0x40490FDB)]),
    ("smerp-neg", "smerp", [("float", 0x3F000000), ("float", 0xC0000000), ("float", 0x40000000)]),
    ("smerp-swap", "smerp", [("float", 0x3F000000), ("float", 0x40000000), ("float", 0x3F800000)]),
    # Rounding-placement proof: keeping 3a^2/2a^3/(B-A)*S intermediates on the
    # 80-bit stack stores 0xbc556902 where per-operation float32 rounding
    # stores 0xfc737ccc.
    ("smerp-x87-intermediate", "smerp",
     [("float", 0x3F8608FE), ("float", 0x4164D839), ("float", 0xBDE5C099)]),
    ("smerp-denormal-alpha", "smerp", [("float", DENORM_1), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-denormal-ab", "smerp", [("float", 0x3F000000), ("float", DENORM_1), ("float", DENORM_MID)]),
    ("smerp-neg-zero-a", "smerp", [("float", 0x3F000000), ("float", NEG_ZERO), ("float", 0x3F800000)]),
    ("smerp-neg-zero-b", "smerp", [("float", 0x3F000000), ("float", 0x3F800000), ("float", NEG_ZERO)]),
    ("smerp-inf-a", "smerp", [("float", 0x3F000000), ("float", INF), ("float", 0x3F800000)]),
    ("smerp-inf-b", "smerp", [("float", 0x3F000000), ("float", 0x3F800000), ("float", INF)]),
    ("smerp-inf-alpha", "smerp", [("float", INF), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-nan-alpha", "smerp", [("float", NAN), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-nan-a", "smerp", [("float", 0x3F000000), ("float", NAN), ("float", 0x40000000)]),
    ("smerp-nan-b", "smerp", [("float", 0x3F000000), ("float", 0x3F800000), ("float", NAN)]),
    ("smerp-nan-payload", "smerp", [("float", NAN_P1), ("float", 0x3F800000), ("float", 0x40000000)]),
    ("smerp-snan-alpha", "smerp", [("float", SNAN), ("float", 0x3F800000), ("float", 0x40000000)]),
    # Equal-significand NaN ties pin operand roles: S(NAN_P1) * diff(NNAN_P1)
    # on the FMULP and prod * A on the closing FADD memory operand.
    ("smerp-nan-mul-tie", "smerp", [("float", NAN_P1), ("float", 0x00000000), ("float", NNAN_P1)]),
    ("smerp-nan-add-tie", "smerp", [("float", 0x3F800000), ("float", NNAN_P2), ("float", NAN_P2)]),
    # ---- GetAxes (229): rotator -> three out vectors through GPropAddr ----
    ("axes-zero", "getAxes",
     [("rotator", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-yaw-90", "getAxes",
     [("rotator", [0, 16384, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-pitch-90", "getAxes",
     [("rotator", [16384, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-roll-90", "getAxes",
     [("rotator", [0, 0, 16384]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-mixed", "getAxes",
     [("rotator", [8192, 16384, 8192]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-negative", "getAxes",
     [("rotator", [-8192, -16384, -8192]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-arbitrary", "getAxes",
     [("rotator", [12345, -23456, 30000]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-arbitrary-2", "getAxes",
     [("rotator", [-30000, 20000, -10000]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-wrap", "getAxes",
     [("rotator", [73728, 147456, -73728]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-max", "getAxes",
     [("rotator", [0x7FFFFFFF, -0x80000000, 0x40000000]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    ("axes-quantized", "getAxes",
     [("rotator", [1, 2, 3]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    # The out arguments' starting values are copied to the temporaries but
    # never read into the math: NaN/inf sentinels are simply overwritten.
    ("axes-out-values-ignored", "getAxes",
     [("rotator", [8192, 16384, 8192]),
      ("lvector", [0x3F800000, 0x40000000, 0x40400000]),
      ("lvector", [NAN, INF, NEG_ZERO]),
      ("lvector", [F32_MAX, SNAN, DENORM_1])]),
    # Non-lvalue out arguments write to the body's stack temporaries; no
    # variable is touched and GPropAddr ends cleared for the trailing ones.
    ("axes-nonlvalue-xyz", "getAxes",
     [("rotator", [0, 16384, 0]), ("vector", [0, 0, 0]), ("vector", [0, 0, 0]), ("vector", [0, 0, 0])]),
    ("axes-nonlvalue-yz", "getAxes",
     [("rotator", [8192, 0, 8192]), ("lvector", [0, 0, 0]), ("vector", [0, 0, 0]), ("vector", [0, 0, 0])]),
    ("axes-nonlvalue-mixed", "getAxes",
     [("rotator", [8192, 16384, 0]), ("lvector", [0, 0, 0]), ("vector", [0, 0, 0]), ("lvector", [0, 0, 0])]),
    # ---- MirrorVectorByNormal (300): V - 2*N*(V.N) with SafeNormal(N);
    #      the f32 dot store feeds all three product terms; only the x
    #      product stays on the x87 stack through the final subtract ----
    ("mirror-basic", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x00000000, 0x3F800000, 0x00000000])]),
    ("mirror-diag", "mirror",
     [("vector", [0x3F800000, 0x00000000, 0x00000000]), ("vector", [0x3F3504F3, 0x3F3504F3, 0x00000000])]),
    ("mirror-unnormalized", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x00000000, 0x40400000, 0x00000000])]),
    ("mirror-zero-normal", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x00000000, 0x00000000, 0x00000000])]),
    ("mirror-below-normal", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [BELOW_T, 0x00000000, 0x00000000])]),
    ("mirror-neg-normal", "mirror",
     [("vector", [0x3F800000, 0x00000000, 0x00000000]), ("vector", [0xBF800000, 0x00000000, 0x00000000])]),
    # The dot product is stored to f32 and reloaded for every product term:
    # with the f32 D the x result stores 0xa1ae6b18 where an 80-bit D stores
    # 0xa1ae6b19.
    ("mirror-d32-store", "mirror",
     [("vector", [0x96DFAA3C, 0xADA5543B, 0xB1D179B2]), ("vector", [0xB3B8580E, 0x402E24C5, 0xB7EF2497])]),
    # The y/z product terms are re-stored to f32 before the subtract; keeping
    # them in 80-bit stores 0xa6bb9463 where the original stores 0xa6bb9464.
    ("mirror-yz-preround", "mirror",
     [("vector", [0xB687B050, 0xA6638457, 0x3C3CFA23]), ("vector", [0x8EA467F9, 0x299CF785, 0x4048E985])]),
    # The x product is never stored: it stays on the x87 stack through the
    # subtract, storing 0x1aa3dcc9 where a pre-rounded f32 product stores
    # 0x1aa3dcca.
    ("mirror-x-keep80", "mirror",
     [("vector", [0x1711EB57, 0x356F8BD1, 0x952E1B8B]), ("vector", [0xA2F7647A, 0x3E361858, 0x03F8670D])]),
    ("mirror-denormal", "mirror",
     [("vector", [DENORM_1, DENORM_MID, 0x3F800000]), ("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    ("mirror-near-overflow", "mirror",
     [("vector", [F32_MAX, F32_MAX, F32_MAX]), ("vector", [0x3F3504F3, 0x3F3504F3, 0x3F3504F3])]),
    ("mirror-inf-v", "mirror",
     [("vector", [INF, 0x3F800000, 0x00000000]), ("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    ("mirror-nan-v", "mirror",
     [("vector", [NAN, 0x3F800000, 0x00000000]), ("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    ("mirror-nan-n", "mirror",
     [("vector", [0x3F800000, 0x00000000, 0x00000000]), ("vector", [NAN, 0x3F800000, 0x00000000])]),
    ("mirror-inf-n", "mirror",
     [("vector", [0x3F800000, 0x00000000, 0x00000000]), ("vector", [INF, 0x3F800000, 0x00000000])]),
    ("mirror-neg-zero", "mirror",
     [("vector", [NEG_ZERO, NEG_ZERO, NEG_ZERO]), ("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    ("mirror-snan-v", "mirror",
     [("vector", [SNAN, 0x3F800000, 0x00000000]), ("vector", [0x3F800000, 0x00000000, 0x00000000])]),
    # NaN ties across the dot-product FADDPs and the closing FSUBs.
    ("mirror-nan-dot-tie", "mirror",
     [("vector", [NAN, 0x3F800000, NNAN_P1]), ("vector", [0x3F800000, 0x00000000, 0x3F800000])]),
    ("mirror-nan-sub-tie", "mirror",
     [("vector", [NAN_P1, NNAN_P1, 0x3F800000]), ("vector", [0x3F800000, 0xBF800000, 0x00000000])]),
    # An infinite normal component: the squared length is +inf, the
    # reciprocal +0, so SafeNormal stores the real indefinite 0xffc00000 for
    # inf*0 and signed zeros for the finite components.  The indefinite then
    # reaches every result component through the f32 dot store, so all three
    # store the negative indefinite (the operands that failed
    # X87_CASES=5000 validate-script-vm-x87).
    ("mirror-inf-n-indefinite", "mirror",
     [("vector", [0x4FDE00D3, F32_MAX, 0xBF800000]), ("vector", [INF, 0x0C000000, 0xB7400B29])]),
    ("mirror-ninf-n-x", "mirror",
     [("vector", [0x4FDE00D3, F32_MAX, 0xBF800000]), ("vector", [NINF, 0x0C000000, 0xB7400B29])]),
    ("mirror-inf-n-y", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x3F800000, INF, 0x80000000])]),
    ("mirror-ninf-n-z", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x00000000, 0xBF800000, NINF])]),
    ("mirror-inf-n-mixed-signs", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [INF, NINF, 0x3F800000])]),
    # A zero vector against an infinite normal: no finite product hides the
    # indefinite, and V - NaN keeps the NaN's sign.
    ("mirror-inf-n-zero-v", "mirror",
     [("vector", [0x00000000, NEG_ZERO, 0x00000000]), ("vector", [NINF, 0x00000000, 0x00000000])]),
    # A NaN normal component makes SafeNormal's FCOMP unordered: the normal
    # is exactly (0,0,0) whatever the NaN's sign or payload, and an infinite
    # component beside it does not change that.
    ("mirror-neg-nan-n", "mirror",
     [("vector", [0x4FDE00D3, F32_MAX, 0xBF800000]), ("vector", [NNAN_P1, 0x3F800000, 0x00000000])]),
    ("mirror-nan-inf-n", "mirror",
     [("vector", [0x4FDE00D3, F32_MAX, 0xBF800000]), ("vector", [INF, NAN_P2, 0x0C000000])]),
    ("mirror-indefinite-n", "mirror",
     [("vector", [0x3F800000, 0xC0000000, 0x40400000]), ("vector", [0x00000000, 0x00000000, INDEFINITE])]),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-normal-axes-oracle.py GAME_ROOT")
    probe = NormalAxesProbe(Path(sys.argv[1]))
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
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": {
            "evaluatorTable": hex(EVALUATOR_TABLE),
            "propAddr": hex(PROP_ADDR),
            "propObject": hex(PROP_OBJECT),
            "f64One": hex(F64_ONE),
            "f64Threshold": hex(F64_1EM8),
            "f64Three": hex(F64_THREE),
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
