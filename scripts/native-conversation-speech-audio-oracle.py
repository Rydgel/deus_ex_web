"""Execute ConSys ``DConversation::GetSpeechAudio`` from the original DLL.

This is a source/evidence probe, never a browser runtime dependency.  The
hash-verified ConSys body runs unchanged in the x86 Unicorn harness.  The
probe supplies only the string formatting and object-loading leaves needed by
one ordinary conversation fixture; Core's FArray realloc/remove/destructor
paths execute from the original images; FMalloc virtuals are explicit leaves.

The second case exercises the native ``soundID == -1`` early return with the
same entry point and no loading/string service calls.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import (
    UC_X86_REG_EAX,
    UC_X86_REG_ECX,
    UC_X86_REG_ESP,
)
from unicorn import UC_HOOK_MEM_WRITE


_SPEC = importlib.util.spec_from_file_location(
    "native_collision", Path(__file__).with_name("native-collision-oracle.py")
)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CONSYS_SHA256 = "f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa"

# ConSys DConversation::GetSpeechAudio.  The function is declared as native
# index 2055/exec wrapper 0x10010900; the body called by that wrapper is this
# C++ method at 0x10010210.
GET_SPEECH_AUDIO = 0x10010210

# ConSys import-address slots used by this body.  The image is loaded at its
# preferred 0x10000000 base, so these are both the exact IAT addresses and the
# addresses shown by the native disassembly.
IAT_REALLOC = 0x10013014
IAT_GMALLOC = 0x10013018
IAT_FARRAY_DESTRUCTOR = 0x10013090
IAT_FARRAY_REMOVE = 0x10013094
IAT_APP_STRLEN = 0x100130C4
IAT_APP_STRICMP = 0x100130D0
IAT_STATIC_LOAD_OBJECT = 0x100130D4
IAT_APP_STRCpy = 0x10013104
IAT_FSTRING_PRINTF = 0x1001311C
IAT_FNAME_NAMES = 0x10013124
IAT_USOUND_CLASS = 0x10013160
GMALLOC_PTR = 0x101A7C44

# Core import targets resolved by NativeCollision before selected leaves are
# replaced.  These direct bodies remain observable in the execution trace.
CORE_FARRAY_REALLOC = 0x10145440
CORE_FARRAY_REMOVE = 0x101454F0
CORE_FARRAY_DESTRUCTOR = 0x10107200

# Native static data referenced directly by the body.
EMPTY_TCHAR = 0x1001E1CC
FORMAT_AUDIO_NAME = 0x1001D7CC
FORMAT_AUDIO_FILE = 0x1001D5A4
TRIM_LITERAL = 0x1001D618


class SpeechAudioProbe(_NATIVE.NativeCollision):
    """Run one normal and one ``-1`` GetSpeechAudio call."""

    STUB_CODE = b"\xc3"  # cdecl leaves clean the pushed arguments themselves.
    REALLOC_STUB = bytes.fromhex("8b 44 24 04 c2 0c 00")
    FREE_STUB = bytes.fromhex("c2 04 00")

    def __init__(self, game_root: Path):
        super().__init__(Path(game_root), {"ConSys.dll": CONSYS_SHA256})
        self.events: list[dict[str, object]] = []
        self.service_addresses: dict[int, str] = {}
        self.labels: dict[int, str] = {}
        self.temp_headers: dict[int, str] = {}

        # Calls through these slots are intentionally explicit leaf services.
        # They retain the original ABI (cdecl, with the caller's stack cleanup)
        # while the body and all branch arithmetic remain native.
        self._install_stub(IAT_APP_STRCpy, "appStrcpy")
        self._install_stub(IAT_APP_STRLEN, "appStrlen")
        self._install_stub(IAT_APP_STRICMP, "appStricmp")
        self._install_stub(IAT_FSTRING_PRINTF, "FString::Printf")
        self._install_stub(IAT_STATIC_LOAD_OBJECT, "StaticLoadObject")

        # GetSpeechAudio's two temporary FString values are released by the
        # original Core FArray destructor and direct FMalloc virtual calls.
        # Realloc returns the old pointer, as the allocator boundary permits;
        # the native FArray body still computes bytes and publishes its header.
        allocator = self.alloc(0x20)
        allocator_vtable = self.alloc(0x20)
        self.realloc_stub = self.alloc(0x10)
        self.free_stub = self.alloc(0x10)
        self.cpu.mem_write(self.realloc_stub, self.REALLOC_STUB)
        self.cpu.mem_write(self.free_stub, self.FREE_STUB)
        self.write(allocator_vtable + 0x04, "I", self.realloc_stub)
        self.write(allocator_vtable + 0x08, "I", self.free_stub)
        self.write(allocator, "I", allocator_vtable)
        self.write(GMALLOC_PTR, "I", allocator)

        self._make_fixture()
        self.cpu.hook_add(UC_HOOK_MEM_WRITE,self.on_write)

    def _install_stub(self, iat: int, name: str) -> None:
        address = self.alloc(0x10)
        self.cpu.mem_write(address, self.STUB_CODE)
        self.write(iat, "I", address)
        self.service_addresses[address] = name

    def _utf16(self, address: int) -> str:
        units: list[int] = []
        for _ in range(4096):
            value = self.read(address, "H")[0]
            if value == 0:
                return "".join(chr(unit) for unit in units)
            units.append(value)
            address += 2
        raise RuntimeError(f"unterminated TCHAR string at {address:#x}")

    def _write_utf16(self, text: str) -> int:
        raw = text.encode("utf-16-le") + b"\x00\x00"
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        return pointer

    def _label(self, pointer: int) -> str | None:
        if pointer == 0:
            return None
        return self.labels.get(pointer, hex(pointer))

    def _write_fstring(self, record: int, text: str) -> int:
        data = self._write_utf16(text)
        count = len(text) + 1
        self.write(record, "3I", data, count, count)
        return data

    def _make_fixture(self) -> None:
        """Create only native fields reached by the ordinary method path."""

        # FName::Names is a TArray<FNameEntry*>.  GetSpeechAudio reads the
        # global slot, then header.Data[index], then FNameEntry + 0xc.
        names_header = self.alloc(0x0c)
        names_data = self.alloc(4 * 2)
        outer_name_entry = self.alloc(0x0c + 2 * (len("DeusExConText") + 1))
        outer_name_index = 1
        # FNameEntry stores TCHARs inline at +0xc; GetSpeechAudio adds that
        # offset before passing the address to appStrcpy.
        self.cpu.mem_write(
            outer_name_entry + 0x0c,
            "DeusExConText".encode("utf-16-le") + b"\x00\x00",
        )
        self.write(names_data + outer_name_index * 4, "I", outer_name_entry)
        self.write(names_header, "3I", names_data, 2, 2)
        self.write(IAT_FNAME_NAMES, "I", names_header)

        self.outer = self.alloc(0x80)
        self.labels[self.outer] = "DeusExConText"
        self.write(self.outer + 0x20, "I", outer_name_index)

        self.conversation = self.alloc(0x100)
        self.labels[self.conversation] = "Conversation(Outer=DeusExConText)"
        self.write(self.conversation + 0x18, "I", self.outer)
        self.audio_package_data = self._write_utf16("Mission00")
        self.write(self.conversation + 0x64, "3I", self.audio_package_data, len("Mission00") + 1, len("Mission00") + 1)

        # The imported USound::PrivateStaticClass data slot is normally filled
        # during engine startup.  This probe gives the body an explicit class
        # identity so the StaticLoadObject arguments are inspectable.
        self.sound_class = self.alloc(0x20)
        self.labels[self.sound_class] = "Engine.Sound.PrivateStaticClass"
        self.write(IAT_USOUND_CLASS, "I", self.sound_class)

        self.returned_sound = self.alloc(0x80)
        self.labels[self.returned_sound] = "ConAudio(Mission00,123)"

        # Body-local output arrays are recorded by their hidden FString result
        # address in the Printf service.  Their actual addresses are stack
        # locals and cannot be named ahead of the call.
        self.events.append({
            "op": "fixture",
            "conversation": self._label(self.conversation),
            "outer": self._label(self.outer),
            "outerName": "DeusExConText",
            "audioPackageName": "Mission00",
            "soundClass": self._label(self.sound_class),
            "returnedSound": self._label(self.returned_sound),
        })

    def _handle_service(self, cpu, address: int) -> None:
        name = self.service_addresses[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)

        if name == "appStrcpy":
            destination, source = self.read(stack + 4, "2I")
            source_text = self._utf16(source)
            self.cpu.mem_write(destination, source_text.encode("utf-16-le") + b"\x00\x00")
            self.events.append({"op": "appStrcpy", "source": source_text})
            cpu.reg_write(UC_X86_REG_EAX, destination)
            return

        if name == "appStrlen":
            (source,) = self.read(stack + 4, "I")
            source_text = self._utf16(source)
            self.events.append({"op": "appStrlen", "text": source_text, "length": len(source_text)})
            cpu.reg_write(UC_X86_REG_EAX, len(source_text))
            return

        if name == "appStricmp":
            left, right = self.read(stack + 4, "2I")
            left_text = self._utf16(left)
            right_text = self._utf16(right)
            result = 0 if left_text.casefold() == right_text.casefold() else (-1 if left_text.casefold() < right_text.casefold() else 1)
            self.events.append({
                "op": "appStricmp",
                "left": left_text,
                "right": right_text,
                "result": result,
            })
            cpu.reg_write(UC_X86_REG_EAX, result & 0xFFFFFFFF)
            return

        if name == "FString::Printf":
            # This static cdecl import receives the hidden aggregate result
            # as its first stack argument. ECX is not an input to this ABI.
            result_record, format_pointer, first, second = self.read(stack + 4, "4I")
            format_text = self._utf16(format_pointer)
            if format_text == self._utf16(FORMAT_AUDIO_NAME):
                first_text = self._utf16(first)
                output = f"ConAudio{first_text}_{second if second < 0x80000000 else second - 0x100000000}"
                kind = "objectName"
            elif format_text == self._utf16(FORMAT_AUDIO_FILE):
                first_text = self._utf16(first)
                second_text = self._utf16(second)
                output = f"..\\System\\{first_text}Audio{second_text}.u"
                kind = "filename"
            else:
                raise RuntimeError(f"unexpected GetSpeechAudio FString format: {format_text!r}")
            data = self._write_fstring(result_record, output)
            self.temp_headers[result_record] = kind
            self.events.append({
                "op": "FString::Printf",
                "kind": kind,
                "format": format_text,
                "arguments": [self._utf16(first), second if kind == "objectName" else self._utf16(second)],
                "resultRecord": hex(result_record),
                "result": output,
                "data": hex(data),
                "num": len(output) + 1,
                "max": len(output) + 1,
            })
            cpu.reg_write(UC_X86_REG_EAX, result_record)
            return

        if name == "StaticLoadObject":
            class_pointer, outer_pointer, object_name, filename, flags, sandbox = self.read(stack + 4, "6I")
            object_text = self._utf16(object_name)
            filename_text = self._utf16(filename)
            if class_pointer != self.sound_class or outer_pointer != 0 or flags != 2 or sandbox != 0:
                raise RuntimeError(
                    "GetSpeechAudio StaticLoadObject arguments do not match the recovered call"
                )
            if object_text != "ConAudioMission00_123":
                raise RuntimeError(f"unexpected generated sound name: {object_text!r}")
            if filename_text != "..\\System\\DeusExConAudioMission00.u":
                raise RuntimeError(f"unexpected generated sound filename: {filename_text!r}; raw stack args={self.read(stack + 4, '4I')!r}")
            self.events.append({
                "op": "StaticLoadObject",
                "class": self._label(class_pointer),
                "outer": self._label(outer_pointer),
                "name": object_text,
                "filename": filename_text,
                "flags": flags,
                "sandbox": self._label(sandbox),
                "result": self._label(self.returned_sound),
            })
            cpu.reg_write(UC_X86_REG_EAX, self.returned_sound)
            return

        raise RuntimeError(f"Unhandled GetSpeechAudio service {name}")

    def on_instruction(self, cpu, address, size, data):  # noqa: D401
        if address in self.service_addresses:
            self._handle_service(cpu, address)
        elif address == self.realloc_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            pointer, byte_count, tag = self.read(stack + 4, "3I")
            if tag != 0x101AB50C:
                raise RuntimeError(f"unexpected FString Realloc tag: {tag:#x}")
            self.events.append({
                "op": "FArray::Realloc",
                "pointer": hex(pointer),
                "bytes": byte_count,
                "elementSize": 2,
                "tag": hex(tag),
            })
        elif address == self.free_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            (pointer,) = self.read(stack + 4, "I")
            self.events.append({"op": "FMalloc::Free", "pointer": hex(pointer)})
        elif address in (CORE_FARRAY_REALLOC,CORE_FARRAY_REMOVE,CORE_FARRAY_DESTRUCTOR):
            receiver=cpu.reg_read(UC_X86_REG_ECX)
            kind=self.temp_headers.get(receiver)
            if kind:
                op={CORE_FARRAY_REALLOC:'ReallocBody',CORE_FARRAY_REMOVE:'RemoveBody',
                    CORE_FARRAY_DESTRUCTOR:'ArrayDestroyBody'}[address]
                event={'op':op,'kind':kind,'header':list(self.read(receiver,'3I'))}
                if address==CORE_FARRAY_REMOVE:
                    event['arguments']=list(self.read(cpu.reg_read(UC_X86_REG_ESP)+4,'3I'))
                self.events.append(event)
        return super().on_instruction(cpu, address, size, data)

    def on_write(self,cpu,access,address,size,value,data):
        for header,kind in self.temp_headers.items():
            offset=address-header
            if offset in (0,4,8) and size==4:
                self.events.append({'op':'FieldWrite','kind':kind,'field':('data','num','max')[offset//4],
                                    'value':value})

    def invoke(self, sound_id: int) -> dict[str, object]:
        self.events = []
        self.temp_headers = {}
        result = self.call(GET_SPEECH_AUDIO, self.conversation, struct.pack("<i", sound_id))
        return {
            "soundID": sound_id,
            "result": self._label(result),
            "resultPointer": hex(result),
            "conversationFieldsAfter": {
                "outer": self._label(self.read(self.conversation + 0x18, "I")[0]),
                "audioPackageName": self._utf16(self.read(self.conversation + 0x64, "I")[0]),
                "audioNum": self.read(self.conversation + 0x68, "I")[0],
                "audioMax": self.read(self.conversation + 0x6C, "I")[0],
            },
            "events": list(self.events),
        }


def run(game_root: Path) -> dict[str, object]:
    probe = SpeechAudioProbe(game_root)
    ordinary = probe.invoke(123)
    early = probe.invoke(-1)
    return {
        "hashes": {
            "ConSys.dll": CONSYS_SHA256,
            "Core.dll": _NATIVE.HASHES["Core.dll"],
            "Engine.dll": _NATIVE.HASHES["Engine.dll"],
        },
        "addresses": {
            "GetSpeechAudio": hex(GET_SPEECH_AUDIO),
            "CoreFArrayRealloc": hex(CORE_FARRAY_REALLOC),
            "CoreFArrayRemove": hex(CORE_FARRAY_REMOVE),
            "CoreFArrayDestructor": hex(CORE_FARRAY_DESTRUCTOR),
            "emptyTCHAR": hex(EMPTY_TCHAR),
            "formatAudioName": hex(FORMAT_AUDIO_NAME),
            "formatAudioFile": hex(FORMAT_AUDIO_FILE),
            "trimLiteral": hex(TRIM_LITERAL),
        },
        "ordinary": ordinary,
        "soundIDMinusOne": early,
        "unresolved": [
            "FString::Printf, appStrcpy/appStrlen/appStricmp and StaticLoadObject are explicit leaves for this ordinary fixture.",
            "StaticLoadObject receives the exact generated name/path/class/flags, but package/file lookup and Sound construction are outside this probe.",
            "Only the trailing-Text Outer name and nonempty Mission00 package branches are exercised; empty package and first-load/error paths remain unbound.",
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-conversation-speech-audio-oracle.py GAME_ROOT")
    print(json.dumps(run(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
