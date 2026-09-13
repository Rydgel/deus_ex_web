"""Execute Core's original Object float/vector operator native bodies.

The operand evaluators are the only harness services.  The operator bodies,
the GPropAddr lvalue handoff, every x87 FLD/FMUL/FADDP/FSUB/FDIVR/FCOMP/FCHS
instruction and the FFrame cursor updates execute from the hash-checked GOTY
Core.dll.  ``lvector`` operands mimic the execLocalVariable contract: the
twelve-byte vector lands in the variable, GPropAddr receives its address, and
the destination still receives the same copy.  ``float``/``vector``/``int``
operands are non-lvalue expressions, so the out-parameter bodies fall back to
their stack temporary exactly as the int/byte out operators did.

Floats cross the harness as IEEE-754 single-precision bit patterns so the
cases can pin denormals, signed zeros, infinities and NaN without JSON
ambiguity.
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
END_FUNCTION_PARMS = 0x16
# Token slots the probe replaces.  The slot choice documents the operand
# role; the bodies only dispatch through the table entry.
INT_OPERAND = 0x1D      # execIntConst
FLOAT_OPERAND = 0x1E    # execFloatConst
VECTOR_OPERAND = 0x23   # execVectorConst
LVALUE_OPERAND = 0x00   # execLocalVariable
TOKENS = {"int": INT_OPERAND, "float": FLOAT_OPERAND, "vector": VECTOR_OPERAND,
          "lvector": LVALUE_OPERAND, "lfloat": LVALUE_OPERAND}

NATIVES = {
    "subtractPreVector":          {"index": 211, "thunk": 0x101030E4, "body": 0x10137710, "result": "3f"},
    "equalEqualVectorVector":     {"index": 217, "thunk": 0x10101663, "body": 0x10138430, "result": "I"},
    "notEqualVectorVector":       {"index": 218, "thunk": 0x10102379, "body": 0x10138530, "result": "I"},
    "dotVectorVector":            {"index": 219, "thunk": 0x10102874, "body": 0x10138630, "result": "f"},
    "multiplyEqualVectorFloat":   {"index": 221, "thunk": 0x1010261C, "body": 0x10138810, "result": "3f", "variable": "3f"},
    "divideEqualVectorFloat":     {"index": 222, "thunk": 0x10102DA1, "body": 0x10138A10, "result": "3f", "variable": "3f"},
    "subtractEqualVectorVector":  {"index": 224, "thunk": 0x1010120D, "body": 0x10138C10, "result": "3f", "variable": "3f"},
    "minIntInt":                  {"index": 249, "thunk": 0x1010190B, "body": 0x10134A20, "result": "i"},
    "square":                     {"index": 194, "thunk": 0x1010136B, "body": 0x101361F0, "result": "f"},
    "multiplyVectorVector":       {"index": 296, "thunk": 0x10102FFE, "body": 0x101379C0, "result": "3f"},
}

# Float32 operand values are written as bit patterns; vectors are three
# consecutive float32s.  ``f32`` converts each bits entry to its stored form.
def _f32(value):
    return struct.unpack("<f", struct.pack("<I", value & 0xFFFFFFFF))[0]


class FloatVectorOperatorsProbe(_NATIVE.NativeCollision):
    """Run each operator body with controlled expression evaluators."""

    def __init__(self, root: Path):
        super().__init__(root)
        # P_GET_* invokes an evaluator with (FFrame*, destination) and expects
        # the callee to clean those two stack arguments.
        self.value_evaluator = self.alloc(16)
        self.lvalue_evaluator = self.alloc(16)
        self.cpu.mem_write(self.value_evaluator, b"\xC2\x08\x00")
        self.cpu.mem_write(self.lvalue_evaluator, b"\xC2\x08\x00")
        self.write(EVALUATOR_TABLE + INT_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + FLOAT_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + VECTOR_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + LVALUE_OPERAND * 4, "I", self.lvalue_evaluator)
        # The variable an lvalue expression would point at (three float32s).
        self.variable = self.alloc(16)
        self.operands: list[tuple[str, object]] = []
        self.evaluation = 0
        self.events: list[object] = []

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == self.value_evaluator or address == self.lvalue_evaluator:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            kind, value = self.operands[self.evaluation]
            if address == self.lvalue_evaluator:
                # execLocalVariable/execInstanceVariable contract: write the
                # value into the variable, publish its address in GPropAddr,
                # and still copy the value to the destination.
                if kind == "lvector":
                    packed = struct.pack("<3f", *(_f32(v) for v in value))
                    self.cpu.mem_write(self.variable, packed)
                    self.cpu.mem_write(output, packed)
                elif kind == "lfloat":
                    self.write(self.variable, "f", _f32(value))
                    self.write(output, "f", _f32(value))
                else:
                    raise ValueError(f"unknown lvalue operand kind {kind}")
                self.write(PROP_ADDR, "I", self.variable)
            elif kind == "int":
                self.write(output, "i", value)
            elif kind == "float":
                self.write(output, "f", _f32(value))
            elif kind == "vector":
                self.cpu.mem_write(output, struct.pack("<3f", *(_f32(v) for v in value)))
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
        self.cpu.mem_write(self.variable, b"\xa5" * 16)
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
        self.call(spec["body"], 0, struct.pack("<2I", frame, result))
        variable = None
        variable_bits = None
        if spec.get("variable"):
            raw = self.cpu.mem_read(self.variable, 12)
            variable_bits = list(struct.unpack("<3I", raw))
            variable = [
                v if abs(v) != float("inf") and v == v else {"bits": b}
                for v, b in zip(struct.unpack("<3f", raw), variable_bits)
            ]
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
            "variable": variable,
            "variableBits": variable_bits,
            "propAddr": self.read(PROP_ADDR, "I")[0],
            "events": self.events,
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
        }


INT_MIN = -0x80000000
INT_MAX = 0x7FFFFFFF
INF = 0x7F800000
NINF = 0xFF800000
NAN = 0x7FC00000          # canonical positive quiet NaN
INDEFINITE = 0xFFC00000   # x87 real indefinite (negative quiet NaN)
NEG_ZERO = 0x80000000
F32_MAX = 0x7F7FFFFF      # 3.4028234663852886e+38
F32_MIN_NORMAL = 0x00800000
DENORM_1 = 0x00000001     # smallest positive denormal ~1.4e-45
DENORM_MID = 0x00400000

CASES = [
    # ---- Min (249): signed dword compare, A>B ? B : A ----
    ("min-zero", "minIntInt", [("int", 0), ("int", 0)]),
    ("min-pos-neg", "minIntInt", [("int", 5), ("int", -3)]),
    ("min-neg-pos", "minIntInt", [("int", -7), ("int", 12)]),
    ("min-equal", "minIntInt", [("int", 77), ("int", 77)]),
    ("min-int-min", "minIntInt", [("int", INT_MIN), ("int", 0)]),
    ("min-int-max", "minIntInt", [("int", INT_MAX), ("int", INT_MIN)]),
    ("min-int-max-1", "minIntInt", [("int", INT_MAX), ("int", 1)]),
    ("min-both-neg", "minIntInt", [("int", -5), ("int", -9)]),
    ("min-unsigned-trap", "minIntInt", [("int", -1), ("int", 1)]),  # 0xffffffff < 1 unsigned
    # ---- Square (194): fld f32, fmul f32, single fstp ----
    ("square-zero", "square", [("float", 0)]),
    ("square-neg-zero", "square", [("float", NEG_ZERO)]),
    ("square-one", "square", [("float", 0x3F800000)]),
    ("square-neg-one", "square", [("float", 0xBF800000)]),
    ("square-half", "square", [("float", 0x3F000000)]),
    ("square-irr", "square", [("float", 0x3FC90FDB)]),       # ~1.5707964
    ("square-round", "square", [("float", 0x3F99999A)]),     # 1.20000005
    ("square-max", "square", [("float", F32_MAX)]),          # overflow -> +Inf
    ("square-tiny", "square", [("float", 0x1CF5C3B4)]),      # ~1.7e-21 -> underflows
    ("square-denormal", "square", [("float", DENORM_1)]),    # -> +0
    ("square-denormal-out", "square", [("float", 0x2A000000)]),  # squared -> denormal
    ("square-inf", "square", [("float", INF)]),
    ("square-neg-inf", "square", [("float", NINF)]),
    ("square-nan", "square", [("float", NAN)]),
    # ---- preoperator -vector (211): per-component fld/fchs/fstp ----
    ("negv-zero", "subtractPreVector", [("vector", [0, 0, 0])]),
    ("negv-neg-zero", "subtractPreVector", [("vector", [NEG_ZERO, NEG_ZERO, NEG_ZERO])]),
    ("negv-mixed", "subtractPreVector", [("vector", [0x3F800000, 0xBF800000, 0x40490FDB])]),
    ("negv-negatives", "subtractPreVector", [("vector", [0xBF000000, 0xC2480000, 0x801C5668])]),
    ("negv-denormal", "subtractPreVector", [("vector", [DENORM_1, 0x80000001, F32_MIN_NORMAL])]),
    ("negv-inf", "subtractPreVector", [("vector", [INF, NINF, 0x3F800000])]),
    ("negv-nan", "subtractPreVector", [("vector", [NAN, 0x3F800000, 0x7FC00001])]),
    # ---- vector*vector (296): per-component product, fstp each ----
    ("mulv-zero", "multiplyVectorVector", [("vector", [0, 0, 0]), ("vector", [0, 0, 0])]),
    ("mulv-basic", "multiplyVectorVector", [("vector", [0x40000000, 0x40400000, 0x40A00000]),
                                            ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("mulv-neg", "multiplyVectorVector", [("vector", [0xBF800000, 0x3F800000, 0x80000000]),
                                          ("vector", [0x3F800000, 0xBF800000, 0xBF800000])]),
    ("mulv-mixed-mag", "multiplyVectorVector", [("vector", [0x3F99999A, 0x4B189680, 0x2D2F5000]),
                                                ("vector", [0x40C90FDB, 0x3A83126F, 0x4E6E6B28])]),
    ("mulv-denormal", "multiplyVectorVector", [("vector", [DENORM_MID, 0x80000001, 0x3F800000]),
                                               ("vector", [0x3F800000, 0x3F800000, DENORM_1])]),
    ("mulv-inf-zero", "multiplyVectorVector", [("vector", [INF, 0, NINF]),
                                               ("vector", [0, INF, 0])]),  # inf*0 -> indefinite NaN
    ("mulv-inf", "multiplyVectorVector", [("vector", [INF, NINF, 0xBF800000]),
                                          ("vector", [0x3F800000, 0x3F800000, NINF])]),
    ("mulv-nan", "multiplyVectorVector", [("vector", [NAN, 0x3F800000, 0x3F800000]),
                                          ("vector", [0x3F800000, NAN, 0x3F800000])]),
    ("mulv-round", "multiplyVectorVector", [("vector", [0x3F99999A, 0x3E4CCCCD, 0x3F19999A]),
                                            ("vector", [0x3FC90FDB, 0x3F4CCCCD, 0x402F1AA0])]),
    # ---- vector == / != (217/218): fcomp + test ah,0x40 per component ----
    ("eqv-equal", "equalEqualVectorVector", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                             ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("eqv-diff-x", "equalEqualVectorVector", [("vector", [0x3F800001, 0x40000000, 0x40400000]),
                                              ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("eqv-diff-y", "equalEqualVectorVector", [("vector", [0x3F800000, 0x40000001, 0x40400000]),
                                              ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("eqv-diff-z", "equalEqualVectorVector", [("vector", [0x3F800000, 0x40000000, 0x40400001]),
                                              ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("eqv-signed-zero", "equalEqualVectorVector", [("vector", [0, NEG_ZERO, 0]),
                                                   ("vector", [NEG_ZERO, 0, NEG_ZERO])]),
    ("eqv-nan-x", "equalEqualVectorVector", [("vector", [NAN, 0x40000000, 0x40400000]),
                                             ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("eqv-nan-mid", "equalEqualVectorVector", [("vector", [0x3F800000, 0x40000000, NAN]),
                                               ("vector", [0x3F800000, NAN, 0x40400000])]),
    ("eqv-both-nan", "equalEqualVectorVector", [("vector", [NAN, 0, 0]),
                                                ("vector", [0, NAN, NAN])]),
    ("eqv-inf", "equalEqualVectorVector", [("vector", [INF, NINF, 0]),
                                           ("vector", [INF, NINF, 0])]),
    ("eqv-inf-diff", "equalEqualVectorVector", [("vector", [INF, 0, 0]),
                                                ("vector", [NINF, 0, 0])]),
    ("nev-equal", "notEqualVectorVector", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                           ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("nev-diff-z", "notEqualVectorVector", [("vector", [0x3F800000, 0x40000000, 0x40400001]),
                                            ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("nev-nan", "notEqualVectorVector", [("vector", [NAN, 0x40000000, 0x40400000]),
                                         ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("nev-signed-zero", "notEqualVectorVector", [("vector", [0, NEG_ZERO, 0]),
                                                 ("vector", [NEG_ZERO, 0, NEG_ZERO])]),
    ("nev-inf-diff", "notEqualVectorVector", [("vector", [INF, 0, 0]),
                                              ("vector", [NINF, 0, 0])]),
    # ---- Dot (219): products + partial sum kept on the 80-bit stack ----
    ("dot-zero", "dotVectorVector", [("vector", [0, 0, 0]), ("vector", [0, 0, 0])]),
    ("dot-unit", "dotVectorVector", [("vector", [0x3F800000, 0, 0]), ("vector", [0x3F800000, 0, 0])]),
    ("dot-basic", "dotVectorVector", [("vector", [0x40000000, 0x40400000, 0x40A00000]),
                                      ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("dot-negative", "dotVectorVector", [("vector", [0xBF800000, 0x40000000, 0xBF000000]),
                                         ("vector", [0x40000000, 0xBF800000, 0x40A00000])]),
    ("dot-neg-zero-product", "dotVectorVector", [("vector", [0xBF800000, 0xBF800000, 0xBF800000]),
                                                 ("vector", [0, 0, 0])]),  # -0 products -> +0
    ("dot-mixed-mag", "dotVectorVector", [("vector", [0x4B189680, 0x2D2F5000, 0x3F99999A]),
                                          ("vector", [0x3A83126F, 0x4E6E6B28, 0x40C90FDB])]),
    ("dot-cancel", "dotVectorVector", [("vector", [0x3F800000, 0x3F800000, 0x3F800000]),
                                       ("vector", [0x3F800000, 0xBF800000, 0])]),  # 1 - 1 + 0
    ("dot-denormal", "dotVectorVector", [("vector", [DENORM_1, DENORM_MID, 0x3F800000]),
                                        ("vector", [0x3F800000, 0x3F800000, DENORM_1])]),
    ("dot-inf", "dotVectorVector", [("vector", [INF, 0x3F800000, 0x3F800000]),
                                    ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    ("dot-inf-cancel", "dotVectorVector", [("vector", [INF, NINF, 0x3F800000]),
                                           ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),  # inf + -inf -> NaN
    ("dot-inf-times-zero", "dotVectorVector", [("vector", [INF, 0x3F800000, 0]),
                                               ("vector", [0, 0x3F800000, 0x3F800000])]),
    ("dot-nan", "dotVectorVector", [("vector", [NAN, 0x3F800000, 0x3F800000]),
                                    ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    # Rounding-placement proof: py+pz overflows only after per-product f32
    # rounding would have produced Inf/-Inf; the original keeps products on
    # the x87 stack so the sum is +Inf, not the NaN a per-product model gives.
    ("dot-extended-products", "dotVectorVector",
     [("vector", [0x3F63AF83, 0x65DC9F50, 0x6415479C]),
      ("vector", [0xEAB477D2, 0xDF1582B0, 0x7F1B103C])]),
    # Rounding-placement proof: 1 + 2^-55 is exact in 64-bit x87 but rounds
    # to 1.0 in a 53-bit double, so the true sum -1 + (1 + 2^-55) = 2^-55
    # distinguishes the extended accumulation from any float64 evaluation.
    ("dot-partial-extended", "dotVectorVector",
     [("vector", [0x3F800000, 0x3F800000, 0x31800000]),
      ("vector", [0xBF800000, 0x3F800000, 0x32000000])]),
    # Summation-order proof: products 2^100*2^100 = 2^200, -2^200, and 1.
    # The original evaluates A.x*B.x + (A.y*B.y + A.z*B.z): the inner add
    # -2^200 + 1 rounds the 1 away at 64 bits (ulp there is 2^137), so the
    # result is exactly 0.  A left-associative (px + py) + pz evaluation —
    # in any precision — yields 1.0 instead.
    ("dot-order-cancel", "dotVectorVector",
     [("vector", [0x71800000, 0xF1800000, 0x3F800000]),
      ("vector", [0x71800000, 0x71800000, 0x3F800000])]),
    ("dot-order-cancel-neg", "dotVectorVector",
     [("vector", [0xF1800000, 0x71800000, 0x3F800000]),
      ("vector", [0x71800000, 0x71800000, 0x3F800000])]),
    # Equal-significand NaN ties pin the FADDP source-operand rule: which of
    # py/pz wins the inner add, and whether px or the inner sum wins the outer.
    ("dot-nan-tie-inner", "dotVectorVector",
     [("vector", [0x3F800000, 0x7FC00001, 0xFFC00001]),
      ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    ("dot-nan-tie-outer", "dotVectorVector",
     [("vector", [0x7FC00001, 0xFFC00001, 0]),
      ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    ("dot-payload-nan", "dotVectorVector", [("vector", [0x7FC00001, 0, 0]),
                                            ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    # ---- *= vector by float (221): per-component fmul, fstp through GPropAddr ----
    ("muleq-basic", "multiplyEqualVectorFloat", [("lvector", [0x40000000, 0x40400000, 0x40A00000]),
                                                 ("float", 0x40000000)]),
    ("muleq-neg", "multiplyEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0x80000000]),
                                               ("float", 0xBF000000)]),
    ("muleq-zero-scale", "multiplyEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0x80000000]),
                                                      ("float", 0)]),
    ("muleq-neg-zero-scale", "multiplyEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0]),
                                                          ("float", NEG_ZERO)]),
    ("muleq-round", "multiplyEqualVectorFloat", [("lvector", [0x3F99999A, 0x3E4CCCCD, 0x3F19999A]),
                                                 ("float", 0x3FC90FDB)]),
    ("muleq-denormal", "multiplyEqualVectorFloat", [("lvector", [DENORM_MID, 0x80000001, 0x3F800000]),
                                                    ("float", 0x3F800000)]),
    ("muleq-inf", "multiplyEqualVectorFloat", [("lvector", [0x3F800000, 0, 0xBF800000]),
                                               ("float", INF)]),
    ("muleq-by-inf-zero", "multiplyEqualVectorFloat", [("lvector", [0, 0x3F800000, 0xBF800000]),
                                                       ("float", INF)]),
    ("muleq-nonlvalue", "multiplyEqualVectorFloat", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                                     ("float", 0x40400000)]),
    # NaN payload propagation: arithmetic quiets sNaN (sets 0x400000) and
    # propagates the operand with the larger significand payload.
    ("mulv-payload-nan", "multiplyVectorVector", [("vector", [0x7FC00001, 0x3F800000, 0x3F800000]),
                                                  ("vector", [0x3F800000, 0xFFA00000, 0x3F800000])]),
    ("mulv-nan-nan", "multiplyVectorVector", [("vector", [0x7FC00001, 0x7F800001, 0x3F800000]),
                                              ("vector", [0x7FC00002, 0x7FC00003, 0x3F800000])]),
    ("mulv-nan-bigA", "multiplyVectorVector", [("vector", [0x7FC00010, 0, 0]),
                                               ("vector", [0x7FC00002, 0x3F800000, 0x3F800000])]),
    ("mulv-snan-qnan", "multiplyVectorVector", [("vector", [0x7FC00001, 0x7FA00000, 0]),
                                                ("vector", [0x7F800002, 0x7FC00001, 0x3F800000])]),
    # Equal-significand opposite-sign NaN operands: the FMUL memory-source
    # operand's NaN is the one that propagates on a tie.
    ("mulv-nan-tie", "multiplyVectorVector", [("vector", [0x7FC00001, 0, 0]),
                                              ("vector", [0xFFC00001, 0x3F800000, 0x3F800000])]),
    ("square-payload-nan", "square", [("float", 0x7FC00001)]),
    # fchs negation flips the sign bit without quieting or touching payloads.
    ("negv-payload-nan", "subtractPreVector", [("vector", [0x7FC00001, 0xFFA00000, 0x7F800001])]),
    ("eqv-snan", "equalEqualVectorVector", [("vector", [0x7F800001, 0x3F800000, 0x3F800000]),
                                            ("vector", [0x3F800000, 0x3F800000, 0x3F800000])]),
    # ---- /= vector by float (222): fdivr 1.0 kept extended, per-component fmul ----
    ("diveq-basic", "divideEqualVectorFloat", [("lvector", [0x40000000, 0x40400000, 0x40A00000]),
                                               ("float", 0x40000000)]),
    ("diveq-third", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                                               ("float", 0x40400000)]),   # /3 exercises reciprocal
    ("diveq-neg", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0x80000000]),
                                             ("float", 0xBF000000)]),
    ("diveq-zero-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0]),
                                                      ("float", 0)]),
    ("diveq-neg-zero-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0]),
                                                          ("float", NEG_ZERO)]),
    ("diveq-inf-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0x80000000]),
                                                     ("float", INF)]),
    ("diveq-neg-inf-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0]),
                                                         ("float", NINF)]),
    ("diveq-nan-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0xBF800000, 0x40400000]),
                                                     ("float", NAN)]),
    ("diveq-inf-vector", "divideEqualVectorFloat", [("lvector", [INF, NINF, NAN]),
                                                    ("float", 0x40000000)]),
    ("diveq-denormal-divisor", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                                                          ("float", DENORM_MID)]),
    ("diveq-denormal-vector", "divideEqualVectorFloat", [("lvector", [DENORM_MID, 0x80000001, DENORM_1]),
                                                         ("float", 0x40000000)]),
    ("diveq-nonlvalue", "divideEqualVectorFloat", [("vector", [0x3F800000, 0x40000000, 0x40400000]),
                                                   ("float", 0x40000000)]),
    # Rounding-placement proof: the 80-bit reciprocal 1/0x0C5C7FD0 times
    # 0xA6A3A450 stores 0xD9BDFD0B, while a float32-rounded reciprocal model
    # stores 0xD9BDFD0A — the reciprocal is never stored to float32.
    ("diveq-recip-extended", "divideEqualVectorFloat", [("lvector", [0xA6A3A450, 0, 0]),
                                                        ("float", 0x0C5C7FD0)]),
    ("diveq-near-mid", "divideEqualVectorFloat", [("lvector", [0x4B800000, 0, 0]),
                                                  ("float", 0x4B7FFFFF)]),
    ("diveq-payload-nan", "divideEqualVectorFloat", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                                                     ("float", 0x7FC00001)]),
    # ---- -= vector (224): per-component fsub, fstp through GPropAddr ----
    ("subeq-basic", "subtractEqualVectorVector", [("lvector", [0x40A00000, 0x40400000, 0x40000000]),
                                                  ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("subeq-cancel", "subtractEqualVectorVector", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                                                   ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    ("subeq-neg-zero", "subtractEqualVectorVector", [("lvector", [NEG_ZERO, 0, NEG_ZERO]),
                                                     ("vector", [NEG_ZERO, NEG_ZERO, 0])]),
    ("subeq-mixed-mag", "subtractEqualVectorVector", [("lvector", [0x4B189680, 0x2D2F5000, 0x3F99999A]),
                                                      ("vector", [0x3A83126F, 0x4E6E6B28, 0x40C90FDB])]),
    ("subeq-denormal", "subtractEqualVectorVector", [("lvector", [DENORM_MID, 0x80000001, 0x3F800000]),
                                                     ("vector", [DENORM_1, 0x00000001, 0x3F800000])]),
    ("subeq-inf", "subtractEqualVectorVector", [("lvector", [INF, NINF, 0x3F800000]),
                                                ("vector", [INF, 0x3F800000, NINF])]),  # inf-inf -> NaN
    ("subeq-nan", "subtractEqualVectorVector", [("lvector", [NAN, 0x3F800000, 0x3F800000]),
                                                ("vector", [0x3F800000, NAN, 0x3F800000])]),
    ("subeq-nonlvalue", "subtractEqualVectorVector", [("vector", [0x40A00000, 0x40400000, 0x40000000]),
                                                      ("vector", [0x3F800000, 0x40000000, 0x40400000])]),
    # A NaN subtrahend propagates its payload un-negated through FSUB.
    ("subeq-nan-b", "subtractEqualVectorVector", [("lvector", [0x3F800000, 0x40000000, 0x40400000]),
                                                  ("vector", [0x7FC00001, 0, 0])]),
    # Equal-significand opposite-sign NaN tie across FSUB.
    ("subeq-nan-tie", "subtractEqualVectorVector", [("lvector", [0x7FC00001, 0x3F800000, 0x3F800000]),
                                                    ("vector", [0xFFC00001, 0, 0])]),
    ("muleq-nan-tie", "multiplyEqualVectorFloat", [("lvector", [0x7FC00001, 0x3F800000, 0x3F800000]),
                                                   ("float", 0xFFC00001)]),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-float-vector-operators-oracle.py GAME_ROOT")
    probe = FloatVectorOperatorsProbe(Path(sys.argv[1]))
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
        if kind in ("float", "lfloat"):
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
            case["jsVariableBits"] = js["variableBits"]
            case["jsPropAddr"] = js["propAddr"]
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": {
            "evaluatorTable": hex(EVALUATOR_TABLE),
            "propAddr": hex(PROP_ADDR),
            "propObject": hex(PROP_OBJECT),
            "f64One": hex(F64_ONE),
            "natives": {
                name: {"index": spec["index"], "thunk": hex(spec["thunk"]), "body": hex(spec["body"])}
                for name, spec in NATIVES.items()
            },
        },
        "tokens": {
            "IntConst": hex(INT_OPERAND),
            "FloatConst": hex(FLOAT_OPERAND),
            "VectorConst": hex(VECTOR_OPERAND),
            "LocalVariable": hex(LVALUE_OPERAND),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
