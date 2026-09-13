"""Execute the original Extension window constructor bodies.

The probe maps the hash-checked Extension.dll at a rebased address and runs
the original x86 instructions.  It intercepts only the Core UObject
constructor call and records writes made to patterned object storage.  Core
allocation/registration and all later XWindow::Init behavior remain outside
this oracle.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

CORE_UOBJECT_CONSTRUCTOR_IAT = EXTENSION_BASE + 0x5907c
CORE_UOBJECT_CONSTRUCTOR_THUNK = 0x101021c6
CORE_UOBJECT_CONSTRUCTOR_BODY = 0x1014f340
ENABLE_TRANSLUCENT_TEXT = EXTENSION_BASE + 0x27610

EXTENSION_OBJECT_INTERNAL = EXTENSION_BASE + 0x2770
EXTENSION_OBJECT_CONSTRUCTOR = EXTENSION_BASE + 0x2780
EXTENSION_OBJECT_VTABLE = EXTENSION_BASE + 0x59888

WINDOW_INTERNAL = EXTENSION_BASE + 0x3120
WINDOW_CONSTRUCTOR = EXTENSION_BASE + 0x3130
WINDOW_VTABLE = EXTENSION_BASE + 0x59930
WINDOW_INIT = EXTENSION_BASE + 0x4bb30

GC_INTERNAL = EXTENSION_BASE + 0x2ce0
GC_CONSTRUCTOR = EXTENSION_BASE + 0x26ad0
GC_VTABLE = EXTENSION_BASE + 0x598dc


class WindowConstructionProbe(_NATIVE.NativeCollision):
    """Run each constructor with a patterned, already allocated object."""

    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.object = None
        self.object_size = 0
        self.phase = None
        self.writes = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    def on_write(self, cpu, access, address, size, value, data):
        if self.object is None or not (self.object <= address < self.object + self.object_size):
            return
        self.writes.append({
            'offset': address - self.object,
            'size': size,
            'value': value,
            'phase': self.phase,
        })

    def on_instruction(self, cpu, address, size, data):
        if address == CORE_UOBJECT_CONSTRUCTOR_THUNK:
            self.events.append({
                'op': 'CoreUObjectConstructorThunk',
                'object': cpu.reg_read(UC_X86_REG_ECX),
            })
        elif address == CORE_UOBJECT_CONSTRUCTOR_BODY:
            self.events.append({
                'op': 'CoreUObjectConstructorBody',
                'object': cpu.reg_read(UC_X86_REG_ECX),
            })
        elif address == ENABLE_TRANSLUCENT_TEXT:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            self.events.append({
                'op': 'EnableTranslucentText',
                'object': cpu.reg_read(UC_X86_REG_ECX),
                'value': self.read(stack + 4, 'I')[0],
            })
        return super().on_instruction(cpu, address, size, data)

    def run(self):
        # Capture each invocation separately because run_case reseeds between
        # the direct body and InternalConstructor calls.
        cases = {}
        for key, body, internal, size, seed in [
            ('extensionObject', EXTENSION_OBJECT_CONSTRUCTOR,
             EXTENSION_OBJECT_INTERNAL, 0x28, 0xa5),
            ('window', WINDOW_CONSTRUCTOR, WINDOW_INTERNAL, 0xf0, 0xa5),
            ('gc', GC_CONSTRUCTOR, GC_INTERNAL, 0xb8, 0xa5),
        ]:
            self.object = self.alloc(size)
            self.object_size = size
            self.cpu.mem_write(self.object, bytes([seed]) * size)
            self.phase = key
            self.writes = []
            self.events = []
            self.call(body, self.object, b'')
            body_result = self.cpu.reg_read(_NATIVE.UC_X86_REG_EAX)
            body_writes = list(self.writes)
            body_events = list(self.events)
            body_bytes = list(self.cpu.mem_read(self.object, size))

            self.cpu.mem_write(self.object, bytes([seed]) * size)
            self.phase = key + ':internal'
            self.writes = []
            self.events = []
            internal_result = self.call(internal, 0, struct.pack('<I', self.object))
            internal_writes = list(self.writes)
            internal_events = list(self.events)
            internal_bytes = list(self.cpu.mem_read(self.object, size))
            cases[key] = {
                'size': size,
                'seed': seed,
                'object': self.object,
                'body': {
                    'result': body_result,
                    'writes': body_writes,
                    'events': body_events,
                    'bytes': body_bytes,
                },
                'internal': {
                    'result': internal_result,
                    'writes': internal_writes,
                    'events': internal_events,
                    'bytes': internal_bytes,
                },
            }

        self.object = self.alloc(0xb8)
        self.object_size = 0xb8
        self.cpu.mem_write(self.object, bytes([0xa5]) * 0xb8)
        self.phase = 'SetFonts'
        self.writes = []
        self.events = []
        self.call(EXTENSION_BASE + 0x27640, self.object, struct.pack('<II', 0x21456780, 0))
        set_fonts = {'normalFont': 0x21456780, 'boldFont': 0,
                     'writes': list(self.writes),
                     'bytes': list(self.cpu.mem_read(self.object, 0xb8))}

        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'extensionObjectInternal': EXTENSION_OBJECT_INTERNAL,
                'extensionObjectConstructor': EXTENSION_OBJECT_CONSTRUCTOR,
                'extensionObjectVtable': EXTENSION_OBJECT_VTABLE,
                'windowInternal': WINDOW_INTERNAL,
                'windowConstructor': WINDOW_CONSTRUCTOR,
                'windowVtable': WINDOW_VTABLE,
                'windowInit': WINDOW_INIT,
                'gcInternal': GC_INTERNAL,
                'gcConstructor': GC_CONSTRUCTOR,
                'gcVtable': GC_VTABLE,
                'coreUObjectConstructorIat': CORE_UOBJECT_CONSTRUCTOR_IAT,
                'coreUObjectConstructorThunk': CORE_UOBJECT_CONSTRUCTOR_THUNK,
                'coreUObjectConstructorBody': CORE_UOBJECT_CONSTRUCTOR_BODY,
                'enableTranslucentText': ENABLE_TRANSLUCENT_TEXT,
                'windowInitVtableSlot': 0x54,
            },
            'imports': {
                'coreUObjectConstructor': self.read(CORE_UOBJECT_CONSTRUCTOR_IAT, 'I')[0],
            },
            'vtableSlots': {
                'windowInit': self.read(WINDOW_VTABLE + 0x54, 'I')[0],
            },
            'cases': cases,
            'setFonts': set_fonts,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-construction-oracle.py GAME_ROOT')
    print(json.dumps(WindowConstructionProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
