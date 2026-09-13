"""Execute Core's original ``At_StrStr`` operator (native 168).

The probe keeps the Core.dll body and its static separator read in the x86
emulator.  FFrame expression evaluation, ``wcscpy`` and the allocator's free
method are explicit ABI bridges so the returned FString can be observed
before the native's temporary cleanup runs.
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
NATIVE_INDEX = 168
NATIVE_THUNK = 0x10101E2E
NATIVE_BODY = 0x1013AC30
RESULT_WRITE_BOUNDARY = 0x1013AD29
SEPARATOR_ADDRESS = 0x101AAFCC


class AtStringProbe(_STRING.StringProbe):
    """Core native 168 with observable copy and temporary-free bridges."""

    def __init__(self, game_root: Path):
        super().__init__(game_root)

        try:
            self.copy_string = next(
                address for address, (_, symbol) in self.thunks.items()
                if symbol == "wcscpy"
            )
        except StopIteration as exc:  # pragma: no cover - stale image guard
            raise RuntimeError("Core At_StrStr did not expose the wcscpy import") from exc

        # NativeCollision leaves CRT imports as synthetic thunks.  Keep the
        # original call instruction and provide only the documented wcscpy
        # result through this hook.
        self.cpu.mem_write(self.copy_string, b"\xc3")
        del self.thunks[self.copy_string]
        self.copies: list[dict[str, object]] = []

        # The native destroys temporary FStrings after the result-copy
        # boundary.  Supply the smallest ABI-compatible GMalloc/vtable so the
        # original destructor can be reached when this probe is extended.
        # The current boundary stops before cleanup, but installing it keeps
        # the fixture faithful to the complete native call contract.
        self.gmalloc = self.alloc(4)
        self.gmalloc_vtable = self.alloc(16)
        self.free_stub = self.alloc(16)
        self.cpu.mem_write(self.free_stub, bytes.fromhex("c2 04 00"))
        self.write(self.gmalloc, "I", self.gmalloc_vtable)
        self.write(self.gmalloc_vtable + 8, "I", self.free_stub)
        self.write(0x101A7C44, "I", self.gmalloc)

        separator = bytes(self.cpu.mem_read(SEPARATOR_ADDRESS, 4))
        if separator != bytes.fromhex("20 00 00 00"):
            raise RuntimeError(
                "Unexpected Core separator bytes at 0x101aafcc: "
                f"{separator.hex()}"
            )

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook
        if address == self.copy_string:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            destination, source = self.read(stack + 4, "2I")
            text = self.text_at(source)
            raw = text.encode("utf-16-le", errors="surrogatepass") + b"\0\0"
            self.cpu.mem_write(destination, raw)
            cpu.reg_write(UC_X86_REG_EAX, destination)
            self.copies.append({
                "destination": hex(destination),
                "source": hex(source),
                "text": text,
            })
        return super().on_instruction(cpu, address, size, data)

    def run_case(self, left: str, right: str) -> dict[str, object]:
        self.copies = []
        code, frame, result = self._run_expression(
            NATIVE_BODY,
            [left, right],
            [0x1F, 0x1F],
            12,
            RESULT_WRITE_BOUNDARY,
        )
        return {
            "left": left,
            "right": right,
            **self._result_string(result),
            "codeAdvance": self.read(frame + 12, "I")[0] - code,
            "events": self.expression_events,
            "copies": self.copies,
        }


def run(game_root: Path) -> dict[str, object]:
    probe = AtStringProbe(game_root)
    cases = [
        probe.run_case("", ""),
        probe.run_case("", "B"),
        probe.run_case("A", ""),
        probe.run_case("A", "B"),
        probe.run_case("é", "ß"),
        probe.run_case("A\U0001f603Z", "B"),
    ]
    separator_bytes = bytes(probe.cpu.mem_read(SEPARATOR_ADDRESS, 4))
    return {
        "hashes": {"Core.dll": CORE_SHA256},
        "addresses": {
            "nativeIndex": NATIVE_INDEX,
            "thunk": hex(NATIVE_THUNK),
            "body": hex(NATIVE_BODY),
            "resultWriteBoundary": hex(RESULT_WRITE_BOUNDARY),
            "separator": hex(SEPARATOR_ADDRESS),
        },
        "separator": {
            "address": hex(SEPARATOR_ADDRESS),
            "bytes": separator_bytes.hex(),
            "unit": int.from_bytes(separator_bytes[:2], "little"),
            "text": probe.text_at(SEPARATOR_ADDRESS),
        },
        "cases": cases,
        "unresolved": [
            "FFrame expression evaluators, wcscpy and GMalloc.Free are explicit "
            "harness bridges; the native 168 body and separator bytes execute "
            "from the hash-verified Core.dll image."
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-at-string-oracle.py GAME_ROOT")
    print(json.dumps(run(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
