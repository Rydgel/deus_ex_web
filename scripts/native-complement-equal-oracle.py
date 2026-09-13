"""Execute Core's original ComplementEqual_StrStr (native 124).

The probe runs the unchanged GOTY Core.dll wrapper/body in the shared x86
emulator.  The FFrame expression evaluators and the unresolved CRT
``_wcsicmp`` import are explicit harness services; the body, call order and
zero-result normalization remain original instructions.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ESP


_STRING_PATH = Path(__file__).with_name("native-script-string-oracle.py")
_SPEC = importlib.util.spec_from_file_location("native_script_string", _STRING_PATH)
_STRING = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_STRING)


CORE_SHA256 = "8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4"
COMPLEMENT_EQUAL_BODY = 0x1013B900
COMPLEMENT_EQUAL_THUNK = 0x10101F50
RESULT_WRITE_BOUNDARY = 0x1013B9BA


class ComplementEqualProbe(_STRING.StringProbe):
    """Core native 124 with a narrow, observable CRT comparison bridge."""

    def __init__(self, game_root: Path):
        super().__init__(game_root)
        try:
            self.compare = next(
                address for address, (_, symbol) in self.thunks.items()
                if symbol == "_wcsicmp"
            )
        except StopIteration as exc:  # pragma: no cover - stale image guard
            raise RuntimeError("Core appStricmp did not expose the _wcsicmp import") from exc

        # NativeCollision leaves unresolved imports as synthetic thunks.  A
        # single RET lets the hook provide the CRT result while Core's own
        # appStricmp wrapper and native 124 continue executing unchanged.
        self.cpu.mem_write(self.compare, b"\xc3")
        del self.thunks[self.compare]
        self.comparisons: list[dict[str, object]] = []

    @staticmethod
    def _fold(text: str) -> str:
        # The relevant original C-locale cases are ASCII.  Preserve all other
        # UTF-16 units exactly; this avoids replacing the CRT boundary with
        # host-language Unicode case mapping.
        return "".join(
            chr(ord(char) + 0x20) if "A" <= char <= "Z" else char
            for char in text
        )

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == self.compare:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            left_pointer, right_pointer = self.read(stack + 4, "2I")
            left, right = self.text_at(left_pointer), self.text_at(right_pointer)
            folded_left, folded_right = self._fold(left), self._fold(right)
            result = 0 if folded_left == folded_right else (
                1 if folded_left > folded_right else 0xFFFFFFFF
            )
            self.comparisons.append({"left": left, "right": right, "result": result})
            cpu.reg_write(UC_X86_REG_EAX, result)
            # The synthetic RET executes after this hook and returns through
            # Core's appStricmp wrapper to the unchanged native body.
            return super().on_instruction(cpu, address, size, data)
        return super().on_instruction(cpu, address, size, data)

    def run_case(self, left: str, right: str) -> dict[str, object]:
        self.comparisons = []
        code, frame, result = self._run_expression(
            COMPLEMENT_EQUAL_BODY,
            [left, right],
            [0x1F, 0x1F],
            4,
            RESULT_WRITE_BOUNDARY,
        )
        return {
            "left": left,
            "right": right,
            "value": self.read(result, "I")[0],
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
            "events": self.expression_events,
            "comparisons": self.comparisons,
        }


def run(game_root: Path) -> dict[str, object]:
    probe = ComplementEqualProbe(game_root)
    cases = [
        probe.run_case("", ""),
        probe.run_case("Hello", "hello"),
        probe.run_case("Hello", "HELLO"),
        probe.run_case("Hello", "world"),
        probe.run_case("A\x00ignored", "a"),
        probe.run_case("é", "É"),
        probe.run_case("é", "é"),
        probe.run_case("A\U0001f603Z", "a\U0001f603z"),
    ]
    return {
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": {
            "nativeIndex": 124,
            "thunk": hex(COMPLEMENT_EQUAL_THUNK),
            "body": hex(COMPLEMENT_EQUAL_BODY),
            "resultWriteBoundary": hex(RESULT_WRITE_BOUNDARY),
            "appStricmp": hex(0x1010239C),
            "appStricmpBody": hex(0x10123560),
        },
        "cases": cases,
        "unresolved": [
            "The expression evaluators and _wcsicmp result are explicit harness services; "
            "native 124's FFrame evaluation, appStricmp call and bool normalization execute "
            "from the hash-verified Core.dll image."
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-complement-equal-oracle.py GAME_ROOT")
    print(json.dumps(run(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
