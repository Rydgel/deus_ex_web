"""Execute the original ConSys Conversation event-binding bodies.

This is a bounded research oracle for the installed GOTY ConSys.dll.  It runs
the direct C++ bodies with a small, explicit fixture for the services that the
native code reaches:

* ``UObject::GObjObjects`` and the three imported Engine class identities;
* the candidate/invoker FString storage at the original actor offsets;
* Core's ``appStricmp`` through an ASCII ``_wcsicmp`` bridge; and
* the event vtable's ``BindActor`` slot.

The event-specific ``DConEvent::BindActor`` implementations are separate
native bodies.  The fixture vtable records all three arguments and returns a
controlled bool, so this oracle establishes the surrounding DConversation
loops without pretending to implement a concrete event subclass.

Only the hash-verified binaries are accepted.  Original files remain outside
the repository; this script is an optional local validator input.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP


_NATIVE_PATH = Path(__file__).with_name("native-collision-oracle.py")
_SPEC = importlib.util.spec_from_file_location("native_collision", _NATIVE_PATH)
_NATIVE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_NATIVE)


CONSYS_SHA256 = "f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa"
CONSYS_BASE = 0x10000000

# These are the exact direct bodies recovered from this ConSys build.
BIND_EVENTS = 0x1000FEC0
BIND_EVENTS_TO_ACTOR = 0x100100F0
ADD_BOUND_ACTOR = 0x100101A0
BIND_ACTOR_EVENTS = 0x100101D0

# ConSys's static empty-name storage is a TCHAR buffer at this address.  The
# address is in the zero-filled tail of .data (the file has no bytes for this
# RVA), so the loader supplies an all-zero buffer.  It is an empty string, not
# the text "None".  The direct body probes use this original mapped state and
# do not invent a startup write.
EMPTY_LITERAL = 0x1001E1CC

# A synthetic executable target for the event vtable.  The code hook handles
# this address before Unicorn executes it, allowing us to emulate exactly the
# reached virtual call and its __thiscall stack cleanup.
EVENT_BIND_STUB = 0x700F0000


class ConversationEventsProbe(_NATIVE.NativeCollision):
    """Original ConSys body with explicit CRT/GObjObjects/event fixtures."""

    def __init__(self, game_root: Path, *, mode: str = "BindEvents", live: bool = False):
        super().__init__(game_root, {"ConSys.dll": CONSYS_SHA256})

        # Core::appStricmp forwards to this unresolved CRT import.  The thunk
        # contains C3, while this hook supplies the original comparison result.
        try:
            self.compare = next(
                address for address, (_, name) in self.thunks.items() if name == "_wcsicmp"
            )
        except StopIteration as exc:  # pragma: no cover - protects stale probes
            raise RuntimeError("NativeCollision did not expose Core _wcsicmp thunk") from exc
        self.cpu.mem_write(self.compare, b"\xc3")
        del self.thunks[self.compare]

        self.mode = mode
        self.live = live
        self.objects_by_pointer: dict[int, str] = {}
        self.events: list[dict[str, object]] = []
        self.comparisons: list[list[str]] = []
        self.helper_calls: list[str | None] = []
        self.add_calls: list[dict[str, object]] = []
        self.live_mutations = 0

        # The static literal is a native TCHAR buffer, not an FString header.
        # Its RVA is in the zero-filled .data tail of the mapped image.  Keep
        # the check explicit so a changed image layout cannot silently turn the
        # empty-name gate into a fabricated "None" string.
        if self.cpu.mem_read(EMPTY_LITERAL, 80) != b"\x00" * 80:
            raise RuntimeError("ConSys static empty-name buffer is not zero-filled")

    @staticmethod
    def _fold(text: str) -> str:
        # Fixtures intentionally stay in the ASCII range.  This mirrors the
        # C-locale folding relevant to appStricmp without inventing Unicode
        # locale behavior for an unneeded branch.
        return "".join(chr(ord(char) + 32) if "A" <= char <= "Z" else char for char in text)

    def read_text(self, pointer: int) -> str:
        units: list[int] = []
        for _ in range(4096):
            unit = self.read(pointer, "H")[0]
            if unit == 0:
                return "".join(chr(value) for value in units)
            units.append(unit)
            pointer += 2
        raise RuntimeError("unterminated native TCHAR fixture")

    def label(self, pointer: int) -> str | None:
        if pointer == 0:
            return None
        return self.objects_by_pointer.get(pointer, hex(pointer))

    def on_instruction(self, cpu, address, size, data):  # noqa: D401 - Unicorn hook signature
        if address == self.compare:
            # _wcsicmp(a,b) has the usual cdecl stack: return, a, b.  The C3
            # already written into the thunk performs the actual return after
            # this hook has supplied EAX.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            left_pointer, right_pointer = self.read(stack + 4, "2I")
            left = self.read_text(left_pointer)
            right = self.read_text(right_pointer)
            self.comparisons.append([left, right])
            folded_left, folded_right = self._fold(left), self._fold(right)
            cpu.reg_write(
                UC_X86_REG_EAX,
                0 if folded_left == folded_right else (1 if folded_left > folded_right else 0xFFFFFFFF),
            )
            return

        if address == BIND_EVENTS_TO_ACTOR:
            # At a direct __thiscall body entry: ret, out-array, invoke, candidate.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            candidate = self.read(stack + 12, "I")[0]
            self.helper_calls.append(self.label(candidate))
            return super().on_instruction(cpu, address, size, data)

        if address == ADD_BOUND_ACTOR:
            # At AddBoundActor entry: ret, Actor** array, Actor* actor.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            array_pointer, actor = self.read(stack + 4, "2I")
            self.add_calls.append({"array": hex(array_pointer), "actor": self.label(actor)})
            return super().on_instruction(cpu, address, size, data)

        if address == EVENT_BIND_STUB:
            # BindActor is called as event.__thiscall(invoke,candidate,conversation)
            # and cleans 0xc bytes.  The caller's return address is at +0.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            return_address, first_actor, second_actor, conversation = self.read(stack, "4I")
            result = self.mode == "BindEvents"
            self.events.append(
                {
                    "event": self.label(cpu.reg_read(UC_X86_REG_ECX)),
                    "first": self.label(first_actor),
                    "second": self.label(second_actor),
                    "conversation": self.label(conversation),
                    "result": result,
                }
            )

            # DConversation's iterator calls the helper again after returning
            # from the complete candidate.  Updating the live TArray count here
            # proves the native helper reloads GObjObjects/count at each advance.
            if self.live and self.live_mutations == 0:
                self.live_mutations += 1
                self.write(self.gobj_global + 4, "I", 8)

            cpu.reg_write(UC_X86_REG_EAX, 1 if result else 0)
            cpu.reg_write(UC_X86_REG_ESP, stack + 16)
            cpu.reg_write(UC_X86_REG_EIP, return_address)
            return

        return super().on_instruction(cpu, address, size, data)

    def write_string(self, address: int, text: str) -> None:
        raw = text.encode("utf-16-le") + b"\x00\x00"
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        # FString is Data, ArrayNum, ArrayMax.  Empty storage is represented by
        # Num==0; native then substitutes EMPTY_LITERAL without reading Data.
        count = len(raw) // 2 if text else 0
        self.write(address, "3I", pointer, count, count)

    def make_actor(self, label: str, bind_name: str, class_pointer: int) -> int:
        actor = self.alloc(0x2D0)
        self.objects_by_pointer[actor] = label
        self.write(actor + 0x24, "I", class_pointer)
        self.write_string(actor + 0x2AC, bind_name)
        return actor

    def setup(self) -> None:
        # The helper compares UObject+0x24 against a class token and follows
        # UClass+0x28 as SuperClass.  Imported PrivateStaticClass values are
        # direct object identities in the IAT, so the fixture writes the IAT
        # slots themselves (not a second indirection).
        self.cls_pawn = self.alloc(0x80)
        self.cls_decoration = self.alloc(0x80)
        self.cls_player = self.alloc(0x80)
        self.write(self.cls_pawn + 0x28, "I", 0)
        self.write(self.cls_decoration + 0x28, "I", 0)
        self.write(self.cls_player + 0x28, "I", self.cls_pawn)
        for slot, class_pointer in (
            (0x10013158, self.cls_pawn),
            (0x10013154, self.cls_decoration),
            (0x10013150, self.cls_player),
        ):
            self.write(slot, "I", class_pointer)

        self.conversation = self.alloc(0x100)
        self.objects_by_pointer[self.conversation] = "conversation"
        event_vtable = self.alloc(0x100)
        self.write(event_vtable + 0x58, "I", EVENT_BIND_STUB)
        speech_event = self.alloc(0x90)
        end_event = self.alloc(0x90)
        self.objects_by_pointer[speech_event] = "speech"
        self.objects_by_pointer[end_event] = "end"
        self.write(speech_event, "I", event_vtable)
        self.write(speech_event + 0x38, "I", end_event)
        self.write(end_event, "I", event_vtable)
        self.write(end_event + 0x38, "I", 0)
        self.write(self.conversation + 0x58, "I", speech_event)

        self.actors = {
            "first": self.make_actor("first", "Shared", self.cls_pawn),
            # Case variation confirms the actual CRT comparison, while the
            # same folded name exercises the native non-invoker skip gate.
            "second": self.make_actor("second", "shared", self.cls_pawn),
            "player": self.make_actor("player", "Shared", self.cls_player),
            "decoration": self.make_actor("decoration", "Other", self.cls_decoration),
            # Num==0 makes the native code pass EMPTY_LITERAL directly.
            "none": self.make_actor("none", "", self.cls_pawn),
            # This object is initially beyond Num and becomes visible only in
            # the live case after the first event callback.  Its literal text
            # "None" is a nonempty BindName and must not be confused with the
            # zero-filled static empty-name storage above.
            "literalNone": self.make_actor("literalNone", "None", self.cls_decoration),
            # This object is initially beyond Num and becomes visible only in
            # the live case after the first event callback.
            "late": self.make_actor("late", "Late", self.cls_pawn),
        }
        self.invoke = self.actors["first"]

        # Core's exported GObjObjects is a TArray header at the address in the
        # ConSys IAT: Data,+4 Num,+8 Max.  It is not a pointer to another
        # header.  Eight data slots leave room for the live append.
        self.gobj_global = self.read(0x10013138, "I")[0]
        self.gobj_data = self.alloc(8 * 4)
        entries = [
            0,
            self.actors["first"],
            self.actors["second"],
            self.actors["player"],
            self.actors["decoration"],
            self.actors["none"],
            self.actors["late"],
            self.actors["literalNone"],
        ]
        for index, pointer in enumerate(entries):
            self.write(self.gobj_data + index * 4, "I", pointer)
        # Both fixtures begin with the first six entries visible.  The live
        # callback raises Num to eight so the late actor and then the
        # literal-"None" actor become visible during the same traversal.
        self.write(self.gobj_global, "3I", self.gobj_data, 6, 8)

        self.out_array = self.alloc(10 * 4)
        self.write(self.out_array, "10I", *([0xDEADBEEF] * 10))

    def slots(self, array_pointer: int) -> list[str | None]:
        return [self.label(value) for value in self.read(array_pointer, "10I")]

    def run_bind_events(self) -> dict[str, object]:
        self.setup()
        self.call(BIND_EVENTS, self.conversation, struct.pack("<2I", self.out_array, self.invoke))
        return {
            "output": self.slots(self.out_array),
            "helpers": self.helper_calls,
            "addCalls": self.add_calls,
            "events": self.events,
            "comparisons": self.comparisons,
            "gobjNum": self.read(self.gobj_global + 4, "I")[0],
            "liveMutationCount": self.live_mutations,
        }

    def run_bind_actor_events(self) -> dict[str, object]:
        self.setup()
        # Return values are deliberately false for this mode.  The original
        # BindActorEvents body ignores AL, so both events must still be called.
        self.mode = "BindActorEvents"
        self.call(BIND_ACTOR_EVENTS, self.conversation, struct.pack("<I", self.actors["second"]))
        return {"events": self.events, "comparisons": self.comparisons}

    def run_add_bound_actor(self) -> dict[str, object]:
        self.setup()
        results: dict[str, object] = {}

        duplicate = self.alloc(40)
        self.write(duplicate, "10I", self.actors["first"], *([0] * 9))
        before = self.slots(duplicate)
        self.call(ADD_BOUND_ACTOR, self.conversation, struct.pack("<2I", duplicate, self.actors["first"]))
        results["duplicate"] = {"before": before, "after": self.slots(duplicate)}

        first_empty = self.alloc(40)
        self.write(first_empty, "10I", self.actors["first"], *([0] * 9))
        self.call(ADD_BOUND_ACTOR, self.conversation,
                  struct.pack("<2I", first_empty, self.actors["decoration"]))
        results["firstEmpty"] = {"after": self.slots(first_empty)}

        full = self.alloc(40)
        full_actors = []
        for index in range(10):
            actor = self.alloc(0x20)
            self.objects_by_pointer[actor] = f"full{index}"
            full_actors.append(actor)
        self.write(full, "10I", *full_actors)
        before = self.slots(full)
        self.call(ADD_BOUND_ACTOR, self.conversation, struct.pack("<2I", full, self.actors["late"]))
        results["full"] = {"before": before, "after": self.slots(full)}
        return results


def run(game_root: Path) -> dict[str, object]:
    static = ConversationEventsProbe(game_root, live=False).run_bind_events()
    live = ConversationEventsProbe(game_root, live=True).run_bind_events()
    actor_events = ConversationEventsProbe(game_root, mode="BindActorEvents").run_bind_actor_events()
    add_bound_actor = ConversationEventsProbe(game_root).run_add_bound_actor()
    return {
        "hashes": {
            "ConSys.dll": CONSYS_SHA256,
            "Core.dll": _NATIVE.HASHES["Core.dll"],
            "Engine.dll": _NATIVE.HASHES["Engine.dll"],
        },
        "addresses": {
            "BindEvents": hex(BIND_EVENTS),
            "BindEventsToActor": hex(BIND_EVENTS_TO_ACTOR),
            "AddBoundActor": hex(ADD_BOUND_ACTOR),
            "BindActorEvents": hex(BIND_ACTOR_EVENTS),
        },
        "cases": {
            "bindEvents": static,
            "bindEventsLiveGObjObjects": live,
            "bindActorEvents": actor_events,
            "addBoundActor": add_bound_actor,
        },
        "unresolved": [
            "Concrete DConEvent subclass BindActor bodies are outside this probe; the vtable fixture records arguments and supplies controlled bools.",
            "execBindEvents/execBindActorEvents wrappers are not executed; they require a live FFrame, GPropAddr and GNatives VM fixture.",
            "The static empty-name TCHAR buffer is the zero-filled mapped .data tail at 0x1001e1cc; no fixture write is supplied.",
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: native-conversation-events-oracle.py GAME_ROOT")
    print(json.dumps(run(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
