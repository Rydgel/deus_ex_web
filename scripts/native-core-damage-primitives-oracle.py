"""Execute the original Core arithmetic natives used by Training radiation.

The operand evaluators are the only harness services.  The operator bodies,
float32 stores, signed integer multiply, and FFrame cursor updates execute
from the hash-checked GOTY Core.dll.  The probe is intentionally limited to
the five operators needed before DeusExPlayer's later PlayAnim boundary.
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
END_FUNCTION_PARMS = 0x16
FLOAT_CONST = 0x1E
INT_CONST = 0x1D
VECTOR_CONST = 0x23

NATIVES = {
    "multiplyIntInt": {"index": 144, "thunk": 0x10102FAE, "body": 0x10133640},
    "negateFloat": {"index": 169, "thunk": 0x101014D3, "body": 0x10134CF0},
    "subtractEqualFloat": {"index": 185, "thunk": 0x10101645, "body": 0x10135B80},
    "multiplyFloatVector": {"index": 213, "thunk": 0x10102897, "body": 0x101378D0},
    "addEqualVector": {"index": 223, "thunk": 0x10101447, "body": 0x10138B10},
}


class CoreDamagePrimitiveProbe(_NATIVE.NativeCollision):
    """Run each operator with controlled EX_* evaluators."""

    def __init__(self, root: Path):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        # P_GET_* invokes an evaluator with (FFrame*, destination) and expects
        # the callee to clean those two arguments.
        self.cpu.mem_write(self.evaluator, b"\xC2\x08\x00")
        for opcode in (FLOAT_CONST, INT_CONST, VECTOR_CONST):
            self.write(EVALUATOR_TABLE + opcode * 4, "I", self.evaluator)
        self.operands = []
        self.evaluation = 0
        self.destinations = []

    @staticmethod
    def float_bits(value: float) -> int:
        return struct.unpack("<I", struct.pack("<f", value))[0]

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            kind, value = self.operands[self.evaluation]
            self.destinations.append(output)
            if kind == "float":
                self.write(output, "f", value)
            elif kind == "int":
                self.write(output, "i", value)
            elif kind == "vector":
                self.write(output, "3f", *value)
            else:
                raise ValueError(f"unknown operand kind {kind}")
            self.evaluation += 1
        return super().on_instruction(cpu, address, size, data)

    def run(self, name: str, operands, result_format: str):
        native = NATIVES[name]
        self.operands = operands
        self.evaluation = 0
        self.destinations = []
        code = bytearray()
        for kind, value in operands:
            opcode = {"float": FLOAT_CONST, "int": INT_CONST, "vector": VECTOR_CONST}[kind]
            code.append(opcode)
            # The replacement evaluator supplies the value directly.  As in
            # the existing Core probes, omitting each literal's serialized
            # payload lets the native wrapper advance exactly one token per
            # P_GET_* expression while still executing its real body.
        code.append(END_FUNCTION_PARMS)
        code_address = self.alloc(len(code))
        self.cpu.mem_write(code_address, bytes(code))
        frame = self.alloc(0x20)
        self.write(frame + 8, "2I", 0, code_address)
        result = self.alloc(struct.calcsize("<" + result_format))
        self.cpu.mem_write(result, b"\x00" * struct.calcsize("<" + result_format))
        self.call(native["body"], 0, struct.pack("<2I", frame, result))
        out = self.read(result, result_format)
        lvalue = self.read(self.destinations[0], result_format) if name in {
            "subtractEqualFloat", "addEqualVector"
        } else None
        result_bits = [self.float_bits(value) for value in out] if result_format.endswith("f") else None
        lvalue_bits = [self.float_bits(value) for value in lvalue] if lvalue is not None and result_format.endswith("f") else None
        return {
            "name": name,
            "operands": [value for _, value in operands],
            "result": list(out),
            "resultBits": result_bits,
            "lvalue": list(lvalue) if lvalue is not None else None,
            "lvalueBits": lvalue_bits,
            "codeAdvance": self.read(frame + 12, "I")[0] - code_address,
        }


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: native-core-damage-primitives-oracle.py GAME_ROOT")
    probe = CoreDamagePrimitiveProbe(Path(sys.argv[1]))
    # The x87 control word of each call: 0x037f (the game thread) unless
    # ORACLE_CW sets the render pass's 0x007f (docs/render-pass-precision.md
    # "UnrealScript in the render pass").
    probe.control_word = int(__import__('os').environ.get('ORACLE_CW', '0x037f'), 0)
    cases = [
        probe.run("multiplyIntInt", [("int", 300), ("int", -7)], "i"),
        probe.run("multiplyIntInt", [("int", 0x40000000), ("int", 4)], "i"),
        probe.run("negateFloat", [("float", 3.5)], "f"),
        probe.run("negateFloat", [("float", -0.0)], "f"),
        probe.run("subtractEqualFloat", [("float", 1.0 + 2 ** -25), ("float", 0.25)], "f"),
        probe.run("subtractEqualFloat", [("float", -0.0), ("float", 0.0)], "f"),
        probe.run("multiplyFloatVector", [("float", 0.1), ("vector", [1.0, -2.0, 50.0])], "3f"),
        probe.run("addEqualVector", [("vector", [0.1, -2.0, 3.0]), ("vector", [0.2, 4.0, -5.0])], "3f"),
    ]
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": NATIVES,
        "tokens": {
            "FloatConst": hex(FLOAT_CONST),
            "IntConst": hex(INT_CONST),
            "VectorConst": hex(VECTOR_CONST),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
