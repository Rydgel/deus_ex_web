"""Execute the original Core UObject::execVRand (native 252).

The unchanged GOTY Core body runs in the shared x86 emulator.  Only the
explicit CRT/TLS setup from ``native-rng-oracle.py`` is reused; Core's
appFrand calls, rejection loop, x87 arithmetic, appSqrt and result stores all
execute from the hash-verified original image.
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
VRAND_THUNK = 0x101031ED
VRAND_BODY = 0x10139080
CRT_RAND = 0x78008936


class VRandProbe(_RNG.NativeRng):
    """Run native 252 with a caller-owned FFrame/result fixture."""

    def __init__(self, game_root: Path):
        super().__init__(game_root)
        self.random_calls = 0

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == CRT_RAND:
            self.random_calls += 1
        return super().on_instruction(cpu, address, size, data)

    def capture(self, seed: int) -> dict[str, object]:
        self.call(0x780097EF, 0, struct.pack("<I", seed))
        initial_state = self.read(self.tls + 0x14, "I")[0]
        frame = self.alloc(0x20)
        code = self.alloc(4)
        result = self.alloc(12)
        self.write(frame + 8, "2I", 0, code)
        self.write(frame + 0x0C, "I", 0)
        self.random_calls = 0
        self.call(VRAND_BODY, 0, struct.pack("<2I", frame, result))
        return {
            "seed": seed,
            "initialState": initial_state,
            "vector": list(self.read(result, "3f")),
            "codeAdvance": self.read(frame + 0x0C, "I")[0],
            "randomCalls": self.random_calls,
            "state": self.read(self.tls + 0x14, "I")[0],
        }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: native-vrand-oracle.py GAME_ROOT CASES_JSON")
    root = Path(sys.argv[1])
    cases_path = Path(sys.argv[2])
    raw = cases_path.read_bytes()
    cases = json.loads(raw)
    probe = VRandProbe(root)
    print(json.dumps({
        "hashes": {
            "Core.dll": CORE_SHA256,
            "MSVCRT.dll": MSVCRT_SHA256,
        },
        "addresses": {
            "nativeIndex": 252,
            "thunk": hex(VRAND_THUNK),
            "body": hex(VRAND_BODY),
            "f32One": hex(0x10177F9C),
            "f64One": hex(0x101765A8),
        },
        "casesSha256": hashlib.sha256(raw).hexdigest(),
        "results": [probe.capture(int(case["seed"])) for case in cases],
    }))


if __name__ == "__main__":
    main()
