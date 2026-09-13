"""Execute the original Core.Object.Chr native (236) in an x86 emulator.

The Core.dll body is hash-gated by the shared native harness.  The one int
expression evaluator and the bounded FString allocator are explicit probe
services; all character truncation, result-header writes, and FFrame cursor
updates execute in the original Core.dll instructions.
"""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location(
    "native_string", Path(__file__).with_name("native-script-string-oracle.py"))
native_string = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_string)


class ChrProbe(native_string.StringProbe):
    def chr(self, value):
        code, frame, result = self._run_expression(
            0x1013c520, [value], [0x1d], 12, 0x1013c5ba)
        return {
            "input": value,
            **self._result_string(result),
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
            "events": self.expression_events,
        }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-chr-oracle.py GAME_ROOT")
    probe = ChrProbe(Path(sys.argv[1]))
    values = [
        0, 1, 65, 0x7f, 0x80, 0xD83D, 0xDE03, 0xFFFF,
        0x10000, 0x10001, 0x12345, -1, -0x10000, -0x10001,
        0x7fffffff, -0x80000000,
    ]
    print(json.dumps({
        "hashes": native_string.native.HASHES,
        "addresses": {
            "nativeIndex": 236,
            "thunk": "0x1010279d",
            "body": "0x1013c520",
            "fStringChrThunk": "0x10102117",
            "fStringChrBody": "0x10145570",
            "appStrlen": "0x10101b04",
            "realloc": "0x10101753",
        },
        "cases": [probe.chr(value) for value in values],
    }))
