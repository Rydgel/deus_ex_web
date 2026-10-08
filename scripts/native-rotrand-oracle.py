"""Execute the original Core UObject::execRotRand (native 320).

The unchanged GOTY Core body runs in the shared x86 emulator with the explicit
CRT/TLS setup from ``native-rng-oracle.py``.  Its optional bool argument is
evaluated by the body's own ``Stack.Step`` through GNatives; the four argument
tokens used here (EX_Nothing 0x0b, EX_EndFunctionParms 0x16, EX_True 0x27,
EX_False 0x28) are installed from Core's own registration cells, whose indexes
were recovered from the registration stubs (see docs/actor-physics.md), because
the emulator does not run Core's static initializers.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys


_RNG_PATH = Path(__file__).with_name("native-rng-oracle.py")
_SPEC = importlib.util.spec_from_file_location("native_rng", _RNG_PATH)
_RNG = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_RNG)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"
MSVCRT_SHA256 = "e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210"
GNATIVES = 0x101F41B8
ROTRAND_CELL = 0x101AA940
ROTRAND_THUNK = 0x10102EBE
ROTRAND_BODY = 0x101391B0
CRT_RAND = 0x78008936
# token -> Core registration cell (intUObjectexec*), stored by the stubs at
# 0x1012f6a2 (0x0b), 0x1012f7b2 (0x16), 0x10130d42 (0x27), 0x10130db2 (0x28).
TOKEN_CELLS = {0x0B: 0x101AA6A4, 0x16: 0x101AA6AC, 0x27: 0x101AA714, 0x28: 0x101AA718}


class RotRandProbe(_RNG.NativeRng):
    """Run native 320 with a caller-owned FFrame, argument tokens and result."""

    def __init__(self, game_root: Path):
        super().__init__(game_root)
        self.random_calls = 0
        for token, cell in TOKEN_CELLS.items():
            self.write(GNATIVES + 4 * token, "I", self.read(cell, "I")[0])

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == CRT_RAND:
            self.random_calls += 1
        return super().on_instruction(cpu, address, size, data)

    def capture(self, case: dict) -> dict[str, object]:
        self.call(0x780097EF, 0, struct.pack("<I", int(case["seed"])))
        initial_state = self.read(self.tls + 0x14, "I")[0]
        tokens = bytes(case["tokens"]) + b"\x16"
        frame, code, result = self.alloc(0x20), self.alloc(len(tokens) + 4), self.alloc(12)
        self.cpu.mem_write(code, tokens)
        self.write(frame + 8, "2I", 0, code)  # FFrame.Object, FFrame.Code
        self.write(result, "3i", -1, -1, -1)
        self.random_calls = 0
        self.call(ROTRAND_BODY, 0, struct.pack("<2I", frame, result))
        return {
            "seed": case["seed"],
            "tokens": case["tokens"],
            "initialState": initial_state,
            "rotator": list(self.read(result, "3i")),
            "codeAdvance": self.read(frame + 0x0C, "I")[0] - code,
            "randomCalls": self.random_calls,
            "state": self.read(self.tls + 0x14, "I")[0],
        }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: native-rotrand-oracle.py GAME_ROOT CASES_JSON")
    root = Path(sys.argv[1])
    raw = Path(sys.argv[2]).read_bytes()
    probe = RotRandProbe(root)
    # The x87 control word of each call: 0x037f (the game thread) unless
    # ORACLE_CW sets the render pass's 0x007f (docs/render-pass-precision.md
    # "UnrealScript in the render pass").
    probe.control_word = int(__import__('os').environ.get('ORACLE_CW', '0x037f'), 0)
    print(json.dumps({
        "hashes": {"Core.dll": CORE_SHA256, "MSVCRT.dll": MSVCRT_SHA256},
        "addresses": {"nativeIndex": 320, "cell": hex(ROTRAND_CELL), "thunk": hex(ROTRAND_THUNK),
                      "body": hex(ROTRAND_BODY), "gnativesSlot": hex(GNATIVES + 4 * 320)},
        "casesSha256": hashlib.sha256(raw).hexdigest(),
        "results": [probe.capture(case) for case in json.loads(raw)],
    }))


if __name__ == "__main__":
    main()
