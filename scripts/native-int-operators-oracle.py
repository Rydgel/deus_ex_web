"""Execute Core's original Object int/byte operator native bodies.

The operand evaluators are the only harness services.  The operator bodies,
the GPropAddr lvalue handoff, the x86 NOT/NEG/SHL/SAR/SHR/AND/XOR/OR/INC/DEC
instructions and the FFrame cursor updates execute from the hash-checked
GOTY Core.dll.  ``lbyte``/``lint`` operands mimic the execLocalVariable
contract: the value lands in the variable, GPropAddr receives its address,
and the destination still receives the value.  ``byte``/``int``/``bcast``
operands are non-lvalue expressions, so the bodies that support it fall back
to their stack temporary.  ``byte`` keeps execIntConstByte's DWORD store;
``bcast`` uses execIntToByte's single-BYTE store — the byte out-param
temporary sits one byte below the caller's saved return address, so a DWORD
store there (the IntConstByte shape) corrupts the frame before the body can
return, which is why non-lvalue byte out-arguments are only reachable
through byte-writing evaluators.
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
END_FUNCTION_PARMS = 0x16
# Token slots the probe replaces.  The slot choice documents the operand
# role; the bodies only dispatch through the table entry.
INT_OPERAND = 0x1D      # execIntConst
BYTE_OPERAND = 0x24     # execIntConstByte
CAST_BYTE_OPERAND = 0x3D  # execIntToByte
LVALUE_OPERAND = 0x00   # execLocalVariable
TOKENS = {"int": INT_OPERAND, "byte": BYTE_OPERAND, "bcast": CAST_BYTE_OPERAND,
          "lint": LVALUE_OPERAND, "lbyte": LVALUE_OPERAND}

NATIVES = {
    "addEqualByteByte":       {"index": 135, "thunk": 0x101011BD, "body": 0x10132F50, "result": "B", "variable": "B"},
    "subtractSubtractPreByte": {"index": 138, "thunk": 0x101016E0, "body": 0x101331D0, "result": "B", "variable": "B"},
    "addAddByte":             {"index": 139, "thunk": 0x1010189D, "body": 0x10133290, "result": "B", "variable": "B"},
    "subtractSubtractByte":   {"index": 140, "thunk": 0x10103215, "body": 0x10133350, "result": "B", "variable": "B"},
    "complementPreInt":       {"index": 141, "thunk": 0x10102A68, "body": 0x10133410, "result": "i"},
    "subtractPreInt":         {"index": 143, "thunk": 0x10103323, "body": 0x10133590, "result": "i"},
    "shiftLeftIntInt":        {"index": 148, "thunk": 0x101020F4, "body": 0x10133990, "result": "i"},
    "shiftRightIntInt":       {"index": 149, "thunk": 0x101030D5, "body": 0x10133A60, "result": "i"},
    "andIntInt":              {"index": 156, "thunk": 0x1010324C, "body": 0x10134010, "result": "i"},
    "xorIntInt":              {"index": 157, "thunk": 0x10102482, "body": 0x101340E0, "result": "i"},
    "orIntInt":               {"index": 158, "thunk": 0x101024C8, "body": 0x101341B0, "result": "i"},
    "addAddPreInt":           {"index": 163, "thunk": 0x101012E4, "body": 0x10134660, "result": "i", "variable": "i"},
    "subtractSubtractPreInt": {"index": 164, "thunk": 0x10101537, "body": 0x10134720, "result": "i", "variable": "i"},
    "shiftRightUIntInt":      {"index": 196, "thunk": 0x101021E9, "body": 0x101334C0, "result": "i"},
}


class IntOperatorsProbe(_NATIVE.NativeCollision):
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
        self.write(EVALUATOR_TABLE + BYTE_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + CAST_BYTE_OPERAND * 4, "I", self.value_evaluator)
        self.write(EVALUATOR_TABLE + LVALUE_OPERAND * 4, "I", self.lvalue_evaluator)
        # The variable an lvalue expression would point at.
        self.variable = self.alloc(8)
        self.operands: list[tuple[str, int]] = []
        self.evaluation = 0
        self.events: list[int] = []

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == self.value_evaluator or address == self.lvalue_evaluator:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            kind, value = self.operands[self.evaluation]
            if address == self.lvalue_evaluator:
                # execLocalVariable/execInstanceVariable contract: write the
                # value into the variable, publish its address in GPropAddr,
                # and still copy the value to the destination.
                if kind == "lint":
                    self.write(self.variable, "i", value)
                    self.write(output, "i", value)
                elif kind == "lbyte":
                    self.write(self.variable, "B", value)
                    self.write(output, "B", value)
                else:
                    raise ValueError(f"unknown lvalue operand kind {kind}")
                self.write(PROP_ADDR, "I", self.variable)
            elif kind == "int":
                self.write(output, "i", value)
            elif kind == "byte":
                # execIntConstByte zero-extends the serialized byte into a
                # DWORD store at the destination.
                self.write(output, "I", value)
            elif kind == "bcast":
                # execIntToByte/execBoolToByte/execFloatToByte store a single
                # BYTE at the destination.
                self.write(output, "B", value)
            else:
                raise ValueError(f"unknown operand kind {kind}")
            self.events.append(value)
            self.evaluation += 1
        return super().on_instruction(cpu, address, size, data)

    def run(self, native: str, case: str, operands: list[tuple[str, int]]) -> dict[str, object]:
        spec = NATIVES[native]
        self.operands = operands
        self.evaluation = 0
        self.events = []
        self.write(self.variable, "I", 0xA5A5A5A5)
        self.write(PROP_ADDR, "I", 0xDEADBEEF)
        # The replacement evaluators consume each one-byte token without a
        # serialized payload, so the wrapper's own Step increments plus
        # EndFunctionParms stay directly observable.
        code = self.alloc(len(operands) + 1)
        self.cpu.mem_write(code, bytes([TOKENS[kind] for kind, _ in operands] + [END_FUNCTION_PARMS]))
        frame = self.alloc(0x20)
        self.write(frame + 8, "2I", 0, code)
        result = self.alloc(4)
        self.write(result, "I", 0x7F7F7F7F)
        self.call(spec["body"], 0, struct.pack("<2I", frame, result))
        variable = None
        if spec.get("variable"):
            variable = self.read(self.variable, spec["variable"])[0]
        return {
            "name": case,
            "native": native,
            "index": spec["index"],
            "operands": [value for _, value in operands],
            "lvalue": [kind.startswith("l") for kind, _ in operands],
            "result": self.read(result, spec["result"])[0],
            "resultWord": self.read(result, "I")[0],
            "variable": variable,
            "variableWord": self.read(self.variable, "I")[0] if spec.get("variable") else None,
            "propAddr": self.read(PROP_ADDR, "I")[0],
            "events": self.events,
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
        }


INT_MIN = -0x80000000
INT_MAX = 0x7FFFFFFF
CASES = [
    ("complement-zero", "complementPreInt", [("int", 0)]),
    ("complement-neg-one", "complementPreInt", [("int", -1)]),
    ("complement-int-min", "complementPreInt", [("int", INT_MIN)]),
    ("complement-int-max", "complementPreInt", [("int", INT_MAX)]),
    ("complement-pattern", "complementPreInt", [("int", 0x12345678)]),
    ("complement-negative", "complementPreInt", [("int", -19)]),
    ("negate-positive", "subtractPreInt", [("int", 19)]),
    ("negate-negative", "subtractPreInt", [("int", -19)]),
    ("negate-zero", "subtractPreInt", [("int", 0)]),
    ("negate-one", "subtractPreInt", [("int", 1)]),
    ("negate-int-max", "subtractPreInt", [("int", INT_MAX)]),
    ("negate-int-min", "subtractPreInt", [("int", INT_MIN)]),
    ("shl-zero-count", "shiftLeftIntInt", [("int", 1), ("int", 0)]),
    ("shl-basic", "shiftLeftIntInt", [("int", 3), ("int", 4)]),
    ("shl-into-sign", "shiftLeftIntInt", [("int", 1), ("int", 31)]),
    ("shl-negative-value", "shiftLeftIntInt", [("int", -1), ("int", 1)]),
    ("shl-int-min", "shiftLeftIntInt", [("int", INT_MIN), ("int", 1)]),
    ("shl-count-32", "shiftLeftIntInt", [("int", 0x12345678), ("int", 32)]),
    ("shl-count-33", "shiftLeftIntInt", [("int", 7), ("int", 33)]),
    ("shl-count-negative", "shiftLeftIntInt", [("int", 5), ("int", -1)]),
    ("shl-overflow", "shiftLeftIntInt", [("int", 0x40000000), ("int", 2)]),
    ("shl-count-255", "shiftLeftIntInt", [("int", -16), ("int", 255)]),
    ("sar-positive", "shiftRightIntInt", [("int", 16), ("int", 2)]),
    ("sar-negative", "shiftRightIntInt", [("int", -16), ("int", 2)]),
    ("sar-int-min-4", "shiftRightIntInt", [("int", INT_MIN), ("int", 4)]),
    ("sar-int-min-31", "shiftRightIntInt", [("int", INT_MIN), ("int", 31)]),
    ("sar-zero-count", "shiftRightIntInt", [("int", -19), ("int", 0)]),
    ("sar-count-32", "shiftRightIntInt", [("int", INT_MAX), ("int", 32)]),
    ("sar-count-33", "shiftRightIntInt", [("int", -8), ("int", 33)]),
    ("sar-count-negative", "shiftRightIntInt", [("int", 255), ("int", -1)]),
    ("sar-neg-one", "shiftRightIntInt", [("int", -1), ("int", -1)]),
    ("shr-neg-one", "shiftRightUIntInt", [("int", -1), ("int", 1)]),
    ("shr-int-min-4", "shiftRightUIntInt", [("int", INT_MIN), ("int", 4)]),
    ("shr-int-min-31", "shiftRightUIntInt", [("int", INT_MIN), ("int", 31)]),
    ("shr-positive", "shiftRightUIntInt", [("int", INT_MAX), ("int", 4)]),
    ("shr-zero-count", "shiftRightUIntInt", [("int", -16), ("int", 0)]),
    ("shr-count-32", "shiftRightUIntInt", [("int", -16), ("int", 32)]),
    ("shr-count-33", "shiftRightUIntInt", [("int", -16), ("int", 33)]),
    ("shr-count-negative", "shiftRightUIntInt", [("int", -1), ("int", -1)]),
    ("and-pattern", "andIntInt", [("int", 0x0F0F0F0F), ("int", 0x00FF00FF)]),
    ("and-neg-one", "andIntInt", [("int", -1), ("int", 0x12345678)]),
    ("and-zero", "andIntInt", [("int", 0), ("int", -1)]),
    ("and-min-max", "andIntInt", [("int", INT_MIN), ("int", INT_MAX)]),
    ("and-min-min", "andIntInt", [("int", INT_MIN), ("int", INT_MIN)]),
    ("xor-pattern", "xorIntInt", [("int", 0x12345678), ("int", -1)]),
    ("xor-zero", "xorIntInt", [("int", 0), ("int", INT_MAX)]),
    ("xor-min-max", "xorIntInt", [("int", INT_MIN), ("int", INT_MAX)]),
    ("xor-self", "xorIntInt", [("int", -1), ("int", -1)]),
    ("xor-halves", "xorIntInt", [("int", 0x55555555), ("int", -0x55555556)]),
    ("or-pattern", "orIntInt", [("int", 0x12345678), ("int", 0)]),
    ("or-neg-one", "orIntInt", [("int", -1), ("int", 0)]),
    ("or-min-one", "orIntInt", [("int", INT_MIN), ("int", 1)]),
    ("or-halves", "orIntInt", [("int", 0x55555555), ("int", -0x55555556)]),
    ("or-zero-zero", "orIntInt", [("int", 0), ("int", 0)]),
    ("preinc-zero", "addAddPreInt", [("lint", 0)]),
    ("preinc-neg-one", "addAddPreInt", [("lint", -1)]),
    ("preinc-int-max", "addAddPreInt", [("lint", INT_MAX)]),
    ("preinc-int-min", "addAddPreInt", [("lint", INT_MIN)]),
    ("preinc-nonlvalue", "addAddPreInt", [("int", 5)]),
    ("predec-zero", "subtractSubtractPreInt", [("lint", 0)]),
    ("predec-one", "subtractSubtractPreInt", [("lint", 1)]),
    ("predec-int-min", "subtractSubtractPreInt", [("lint", INT_MIN)]),
    ("predec-int-max", "subtractSubtractPreInt", [("lint", INT_MAX)]),
    ("predec-nonlvalue", "subtractSubtractPreInt", [("int", 7)]),
    ("addeq-wrap", "addEqualByteByte", [("lbyte", 200), ("byte", 100)]),
    ("addeq-255-1", "addEqualByteByte", [("lbyte", 255), ("byte", 1)]),
    ("addeq-0-255", "addEqualByteByte", [("lbyte", 0), ("byte", 255)]),
    ("addeq-128-128", "addEqualByteByte", [("lbyte", 128), ("byte", 128)]),
    ("addeq-nonlvalue", "addEqualByteByte", [("bcast", 10), ("byte", 5)]),
    ("postinc-255", "addAddByte", [("lbyte", 255)]),
    ("postinc-zero", "addAddByte", [("lbyte", 0)]),
    ("postinc-200", "addAddByte", [("lbyte", 200)]),
    ("postinc-nonlvalue", "addAddByte", [("bcast", 9)]),
    ("postdec-zero", "subtractSubtractByte", [("lbyte", 0)]),
    ("postdec-255", "subtractSubtractByte", [("lbyte", 255)]),
    ("postdec-one", "subtractSubtractByte", [("lbyte", 1)]),
    ("predec-b-zero", "subtractSubtractPreByte", [("lbyte", 0)]),
    ("predec-b-255", "subtractSubtractPreByte", [("lbyte", 255)]),
    ("predec-b-one", "subtractSubtractPreByte", [("lbyte", 1)]),
    ("predec-b-nonlvalue", "subtractSubtractPreByte", [("bcast", 9)]),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-int-operators-oracle.py GAME_ROOT")
    probe = IntOperatorsProbe(Path(sys.argv[1]))
    cases = [probe.run(native, name, operands) for name, native, operands in CASES]
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256},
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
            "IntConst": hex(INT_OPERAND),
            "IntConstByte": hex(BYTE_OPERAND),
            "IntToByte": hex(CAST_BYTE_OPERAND),
            "LocalVariable": hex(LVALUE_OPERAND),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
