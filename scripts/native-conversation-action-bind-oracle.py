"""Execute ConEventAnimation/ConEventTrade BindActor from the original DLL.

The shared body at ConSys RVA 0x71b0 runs unchanged.  Only its imported CRT
wide-string comparator is serviced.  The fixture intentionally leaves the
mapped zero-filled empty TCHAR at 0x1001e1cc untouched, and it records the
event-owner write without emulating unrelated event actions.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_WRITE

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


CONSYS_HASH = 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa'
CONSYS = {'ConSys.dll': CONSYS_HASH}
ACTION_BIND = 0x100071b0
ANIMATION_VTABLE = 0x10013884
TRADE_VTABLE = 0x10013c8c
EMPTY_LITERAL = 0x1001e1cc
COMPARE_IAT = 0x100130d0


class ActionBindProbe(_NATIVE.NativeCollision):
    """Run each concrete vtable slot with explicit CRT comparison service."""

    def __init__(self, root):
        super().__init__(Path(root), CONSYS)
        self.app_stricmp = self.read(COMPARE_IAT, 'I')[0]
        self.compare = next((address for address, (_, symbol) in self.thunks.items()
                             if symbol == '_wcsicmp'), None)
        if self.compare is None:
            raise RuntimeError('Core appStricmp did not expose the recovered _wcsicmp thunk')
        # The code hook supplies EAX and the normal cdecl return below; remove
        # the unresolved-import marker so the base oracle does not reject it.
        self.cpu.mem_write(self.compare, b'\xc3')
        del self.thunks[self.compare]
        self.event = None
        self.actor = None
        self.writes = []
        self.comparisons = []
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    @staticmethod
    def _fold(text):
        return ''.join(chr(ord(char) + 32) if 'A' <= char <= 'Z' else char for char in text)

    def _text(self, pointer):
        units = []
        for _ in range(4096):
            unit = self.read(pointer, 'H')[0]
            if unit == 0:
                return ''.join(chr(value) for value in units)
            units.append(unit)
            pointer += 2
        raise RuntimeError('unterminated native TCHAR fixture')

    def _label(self, value):
        if value == self.actor:
            return 'candidate'
        if value == 0x44444444:
            return 'seed'
        return value

    def on_instruction(self, cpu, address, size, data):
        if address == self.compare:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            left_pointer, right_pointer = self.read(stack + 4, '2I')
            left, right = self._text(left_pointer), self._text(right_pointer)
            result = 0 if self._fold(left) == self._fold(right) else 1
            self.comparisons.append({'left': left, 'right': right, 'equal': result == 0})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, result)
        return super().on_instruction(cpu, address, size, data)

    def on_write(self, cpu, access, address, size, value, data):
        if self.event is not None and address == self.event + 0x40:
            self.writes.append({
                'offset': address - self.event,
                'value': self._label(value),
                'size': size,
            })

    def string(self, address, text, *, empty=False):
        if empty:
            # This is a deliberately invalid non-zero pointer.  A mistaken
            # native read instead of the zero-Num fallback fails the probe.
            self.write(address, '3I', 0xdeadbeef, 0, 0)
            return
        raw = text.encode('utf-16-le') + b'\0\0'
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        count = len(raw) // 2
        self.write(address, '3I', pointer, count, count)

    def case(self, vtable, name, *, event_name, bark_name, bind_name,
             conversation_flags, empty_event=False):
        self.event = self.alloc(0x70)
        self.actor = self.alloc(0x2d0)
        conversation = self.alloc(0x60)
        self.cpu.mem_write(self.event, b'\xaa' * 0x70)
        self.cpu.mem_write(self.actor, b'\xbb' * 0x2d0)
        self.cpu.mem_write(conversation, b'\xcc' * 0x60)
        self.write(self.event, 'I', vtable)
        self.write(self.event + 0x40, 'I', 0x44444444)
        self.string(self.event + 0x44, event_name, empty=empty_event)
        self.string(self.actor + 0x2ac, bind_name)
        self.string(self.actor + 0x2b8, bark_name)
        self.write(conversation + 0x50, 'I', conversation_flags)
        self.writes = []
        self.comparisons = []
        slot = self.read(vtable + 0x58, 'I')[0]
        result = self.call(slot, self.event,
                           struct.pack('<3I', 0x12345678, self.actor, conversation))
        owner = self.read(self.event + 0x40, 'I')[0]
        return {
            'vtable': vtable,
            'slot': slot,
            'result': bool(result & 0xff),
            'owner': self._label(owner),
            'writes': list(self.writes),
            'comparisons': list(self.comparisons),
            'conversationFlags': conversation_flags,
            'eventWasEmpty': empty_event,
        }

    def conversation_prefix_layout(self):
        # Exact original Children property prefix, supplied independently by
        # the package validator. These Core Link bodies execute unchanged.
        outer = self.alloc(0x70)
        self.write(outer, 'I', 0x101758f4)  # UClass: MergeBools/GetPropertiesSize
        self.write(outer + 0x3c, 'I', 0x28)  # registered ConObject base size
        archive = self.alloc(0x30)
        non_bool_class = self.alloc(0x30)
        previous = 0
        rows = []
        fields = [
            ('conName', 0x10167250, 0x10175f84, False),
            ('Description', 0x10167640, 0x10176044, False),
            ('CreatedBy', 0x10167640, 0x10176044, False),
            ('conOwnerName', 0x10167640, 0x10176044, False),
            ('bDataLinkCon', 0x10166060, 0x10175c84, True),
            ('bDisplayOnce', 0x10166060, 0x10175c84, True),
            ('bFirstPerson', 0x10166060, 0x10175c84, True),
        ]
        for name, body, vtable, is_bool in fields:
            prop = self.alloc(0x60)
            self.write(prop, 'I', vtable)
            self.write(prop + 0x18, 'I', outer)
            self.write(prop + 0x24, 'I', 0x102a6bf0 if is_bool else non_bool_class)
            self.write(prop + 0x34, 'I', 1)
            self.call(body, prop, struct.pack('<2I', archive, previous))
            offset = self.read(prop + 0x48, 'I')[0]
            size = self.read(prop + 0x38, 'I')[0]
            rows.append({'name': name, 'offset': offset, 'elementSize': size,
                         'bitMask': self.read(prop + 0x5c, 'I')[0] if is_bool else None})
            # UStruct.Link's caller-side running PropertiesSize update.
            self.write(outer + 0x3c, 'I', offset + size)
            previous = prop
        return rows

    def run(self):
        # Check that the static address is really zero-filled mapped data.  Do
        # not write it: the original body only reads it as an empty TCHAR.
        empty_bytes = list(self.cpu.mem_read(EMPTY_LITERAL, 8))
        if empty_bytes != [0] * 8:
            raise RuntimeError(f'Unexpected ConSys empty TCHAR bytes: {empty_bytes}')
        cases = {
            'ordinary': {
                # A bark-name match without Conversation bit 4 must fall
                # through to the reread/normal BindName path.
                'event_name': 'Normal', 'bark_name': 'normal', 'bind_name': 'normal',
                'conversation_flags': 0, 'empty_event': False,
            },
            'bark': {
                'event_name': 'BarkAlias', 'bark_name': 'barkalias', 'bind_name': 'Other',
                'conversation_flags': 4, 'empty_event': False,
            },
            'miss': {
                'event_name': '', 'bark_name': 'Bark', 'bind_name': 'Normal',
                'conversation_flags': 0, 'empty_event': True,
            },
        }
        classes = {
            'animation': ANIMATION_VTABLE,
            'trade': TRADE_VTABLE,
        }
        return {
            'hashes': {'ConSys.dll': CONSYS_HASH, **_NATIVE.HASHES},
            'addresses': {
                'body': ACTION_BIND,
                'animationVtable': ANIMATION_VTABLE,
                'tradeVtable': TRADE_VTABLE,
                'emptyLiteral': EMPTY_LITERAL,
                'compareIat': COMPARE_IAT,
                'compareTarget': self.app_stricmp,
                'compareThunk': self.compare,
            },
            'emptyLiteralBytes': empty_bytes,
            'conversationPrefixLayout': self.conversation_prefix_layout(),
            'classes': {
                class_name: {
                    'vtable': vtable,
                    'slot': self.read(vtable + 0x58, 'I')[0],
                    'cases': {
                        case_name: self.case(vtable, case_name, **case)
                        for case_name, case in cases.items()
                    },
                }
                for class_name, vtable in classes.items()
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-conversation-action-bind-oracle.py GAME_ROOT')
    print(json.dumps(ActionBindProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
