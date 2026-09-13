"""Execute Core's original Object.Divide_IntInt wrapper/body.

The operand evaluator is the only replacement made by this probe.  The
hash-pinned Core.dll body performs the two FFrame Step calls, zero-divisor
guard, signed IDIV, result write and code cursor update.  The probe records
the evaluator order and catches the processor divide exception reached by
INT_MIN / -1 so the validator can keep that edge explicit.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UcError
from unicorn.x86_const import UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"
EVALUATOR_TABLE = 0x101F41B8
INT_CONST_OPCODE = 0x1D
END_FUNCTION_PARMS = 0x16
DIVIDE_INT_THUNK = 0x10101677
DIVIDE_INT_BODY = 0x10133710
IDIV_INSTRUCTION = 0x1013376C


class DivideIntProbe(_NATIVE.NativeCollision):
    """Run native 145 with controlled int expression evaluators."""

    def __init__(self, root: Path):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        # P_GET_INT invokes an evaluator with (FFrame*, destination) and
        # expects the evaluator to clean those two stack arguments.
        self.cpu.mem_write(self.evaluator, bytes.fromhex("c2 08 00"))
        self.write(EVALUATOR_TABLE + INT_CONST_OPCODE * 4, "I", self.evaluator)
        self.operands: list[int] = []
        self.evaluation = 0
        self.events: list[int] = []
        self.did_idiv = False

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == self.evaluator:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            output = self.read(stack + 8, "I")[0]
            value = self.operands[self.evaluation]
            self.write(output, "i", value)
            self.events.append(value)
            self.evaluation += 1
        elif address == IDIV_INSTRUCTION:
            self.did_idiv = True
        return super().on_instruction(cpu, address, size, data)

    def divide(self, name: str, dividend: int, divisor: int) -> dict[str, object]:
        self.operands = [dividend, divisor]
        self.evaluation = 0
        self.events = []
        self.did_idiv = False
        code = self.alloc(3)
        # The replacement evaluator consumes each one-byte opcode without a
        # serialized literal payload.  This leaves the native wrapper's own
        # two Step increments plus EndFunctionParms directly observable.
        self.cpu.mem_write(code, bytes((INT_CONST_OPCODE, INT_CONST_OPCODE, END_FUNCTION_PARMS)))
        frame = self.alloc(0x20)
        self.write(frame + 8, "2I", 0, code)
        result = self.alloc(4)
        self.write(result, "I", 0x7F7F7F7F)
        status = "ok"
        exception = None
        try:
            self.call(DIVIDE_INT_BODY, 0, struct.pack("<2I", frame, result))
        except UcError as error:
            # Native 145 executes IDIV for the sole signed overflow pair and
            # Unicorn reports the resulting hardware #DE as UC_ERR_EXCEPTION.
            if "UC_ERR_EXCEPTION" not in str(error):
                raise
            status = "cpu-exception"
            exception = "UC_ERR_EXCEPTION"
        return {
            "name": name,
            "dividend": dividend,
            "divisor": divisor,
            "status": status,
            "exception": exception,
            "result": self.read(result, "i")[0] if status == "ok" else None,
            "resultWord": self.read(result, "I")[0] if status == "ok" else None,
            "events": self.events,
            "didIdiv": self.did_idiv,
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
        }


CASES = [
    ("positive-truncates", 19, 4),
    ("negative-dividend", -19, 4),
    ("negative-divisor", 19, -4),
    ("both-negative", -19, -4),
    ("zero-dividend", 0, 7),
    ("int-max", 0x7FFFFFFF, 1),
    ("int-min", -0x80000000, 1),
    ("int-min-negative-two", -0x80000000, -2),
    ("zero-divisor", 123, 0),
    # Keep the hardware exception last: Unicorn stops at IDIV and does not
    # resume the emulated call after this reached processor fault.
    ("int-min-overflow", -0x80000000, -1),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-divide-int-oracle.py GAME_ROOT")
    probe = DivideIntProbe(Path(sys.argv[1]))
    cases = [probe.divide(name, dividend, divisor) for name, dividend, divisor in CASES]
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": {
            "nativeIndex": 145,
            "thunk": hex(DIVIDE_INT_THUNK),
            "body": hex(DIVIDE_INT_BODY),
            "idiv": hex(IDIV_INSTRUCTION),
            "evaluatorTable": hex(EVALUATOR_TABLE),
        },
        "tokens": {
            "IntConst": hex(INT_CONST_OPCODE),
            "EndFunctionParms": hex(END_FUNCTION_PARMS),
        },
        "cases": cases,
    }))


if __name__ == "__main__":
    main()
