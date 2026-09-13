"""Execute Extension.dll's XWindow::Init body unchanged.

The x86 body is run from the hash-checked Extension.dll image.  FName, XGC
allocation/constructor, AddChild, parent virtual callbacks, and SetFonts are
intercepted as explicit leaves.  Their bodies are intentionally not emulated;
the probe only supplies the small postcondition needed by Init's later raw
reads (AddChild publishes child +0x138).
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

INIT = EXTENSION_BASE + 0x4bb30
FNAME_NONE_IAT = EXTENSION_BASE + 0x59124
XGC_OPERATOR_NEW = EXTENSION_BASE + 0x2c40
XGC_CONSTRUCTOR = EXTENSION_BASE + 0x26ad0
ADD_CHILD = EXTENSION_BASE + 0x50a80
SET_FONTS = EXTENSION_BASE + 0x27640
INIT_PARENT_SLOT = 0x138
CHILD_ADDED_SLOT = 0x68
DESCENDANT_ADDED_SLOT = 0x70

READ_OFFSETS = {
    0x30, 0x38, 0x74, 0x80, 0x84, 0xb8, 0xcc,
    0x138, 0x130, 0x54, 0x58, 0xd4, 0xd8,
}


class WindowInitProbe(_NATIVE.NativeCollision):
    """Run the original Init body with synchronous native leaves."""

    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.writes = []
        self.reads = []
        self.running = False
        self.suppress_writes = False
        self.window = None
        self.parent = None
        self.ancestor = None
        self.gc_values = []
        self.vtable = self.alloc(0x100)
        self.fname_stub = self.alloc(16)
        self.child_added_stub = self.alloc(16)
        self.descendant_added_stub = self.alloc(16)
        for address in (self.fname_stub, self.child_added_stub,
                        self.descendant_added_stub):
            self.cpu.mem_write(address, b'\xc3')
        self.write(self.vtable + CHILD_ADDED_SLOT, 'I', self.child_added_stub)
        self.write(self.vtable + DESCENDANT_ADDED_SLOT, 'I', self.descendant_added_stub)

        self.original_imports = {
            'fNameNone': self.read(FNAME_NONE_IAT, 'I')[0],
        }
        self.write(FNAME_NONE_IAT, 'I', self.fname_stub)
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)
        self.cpu.hook_add(UC_HOOK_MEM_READ, self.on_read)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _tracked(self, address, offset, size):
        if not self.running or size not in (1, 4):
            return None
        for label, target in [('window', self.window), ('parent', self.parent),
                              ('ancestor', self.ancestor)]:
            if target is not None and address == target + offset:
                return label
        return None

    def on_read(self, cpu, access, address, size, value, data):
        for offset in READ_OFFSETS:
            label = self._tracked(address, offset, size)
            if label is not None:
                self.reads.append({'object': label, 'offset': offset, 'size': size})
                return

    def on_write(self, cpu, access, address, size, value, data):
        if self.window is None or not (self.window <= address < self.window + 0x220):
            return
        if not self.running or self.suppress_writes:
            return
        self.writes.append({
            'offset': address - self.window,
            'size': size,
            'value': value,
        })

    def _label(self, value):
        labels = {
            self.window: 'window', self.parent: 'parent', self.ancestor: 'ancestor',
        }
        for index, pointer in enumerate(self.gc_values):
            labels[pointer] = f'gc{index}'
        return labels.get(value, value)

    def _set_word_quiet(self, address, value):
        self.suppress_writes = True
        self.write(address, 'I', value)
        self.suppress_writes = False

    def _new_object(self, size=0x220):
        address = self.alloc(size)
        self.cpu.mem_write(address, b'\xaa' * size)
        self.write(address, 'I', self.vtable)
        return address

    def _setup_parent(self, parent, next_parent=0):
        self._set_word_quiet(parent + INIT_PARENT_SLOT, next_parent)
        self._set_word_quiet(parent + 0x54, 0)
        self._set_word_quiet(parent + 0x58, 0)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == self.fname_stub:
            target = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            enum_value = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'FName', 'enum': enum_value})
            self.write(target, 'I', 0)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, 0)
            self._return(cpu, stack, 4)
            return
        if address == XGC_OPERATOR_NEW:
            size_arg, outer, name, flags = self.read(stack + 4, '4I')
            self.events.append({
                'op': 'XGCOperatorNew', 'size': size_arg, 'outer': self._label(outer),
                'name': name, 'flags': flags,
            })
            pointer = self.alloc(0xb8)
            self.cpu.mem_write(pointer, b'\xaa' * 0xb8)
            self.gc_values.append(pointer)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, pointer)
            self._return(cpu, stack)
            return
        if address == XGC_CONSTRUCTOR:
            pointer = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({'op': 'XGCConstructor', 'object': self._label(pointer)})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, pointer)
            self._return(cpu, stack)
            return
        if address == ADD_CHILD:
            parent = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            child, flag = self.read(stack + 4, '2I')
            self.events.append({
                'op': 'AddChild', 'parent': self._label(parent),
                'child': self._label(child), 'flag': flag,
            })
            # The full AddChild list mutation is a separate native boundary.
            # Its one required Init postcondition is the child's parent link.
            self._set_word_quiet(child + INIT_PARENT_SLOT, parent)
            self._return(cpu, stack, 8)
            return
        if address == self.child_added_stub:
            parent = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            child = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'ChildAdded', 'parent': self._label(parent),
                'child': self._label(child), 'slot': CHILD_ADDED_SLOT,
            })
            self._return(cpu, stack, 4)
            return
        if address == self.descendant_added_stub:
            parent = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            child = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'DescendantAdded', 'parent': self._label(parent),
                'child': self._label(child), 'slot': DESCENDANT_ADDED_SLOT,
            })
            self._return(cpu, stack, 4)
            return
        if address == SET_FONTS:
            graphics_context = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            normal, bold = self.read(stack + 4, '2I')
            self.events.append({
                'op': 'SetFonts', 'graphicsContext': self._label(graphics_context),
                'normalFont': normal, 'boldFont': bold,
            })
            self._return(cpu, stack, 8)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, name, with_parent):
        self.events = []
        self.writes = []
        self.reads = []
        self.gc_values = []
        self.window = self._new_object()
        self.parent = None
        self.ancestor = None
        self._set_word_quiet(self.window + 0x30, 0xa1b2c3d4)
        self._set_word_quiet(self.window + 0x38, 0x55667788)
        self._set_word_quiet(self.window + 0x74, 0x10203040)
        self._set_word_quiet(self.window + 0xb8, 0x55667704)
        self._set_word_quiet(self.window + 0xcc, 0xabcdef01)

        if with_parent:
            self.parent = self._new_object()
            self.ancestor = self._new_object()
            self._setup_parent(self.parent, self.ancestor)
            self._setup_parent(self.ancestor, 0)
            self._set_word_quiet(self.parent + 0x54, 0x21212121)
            self._set_word_quiet(self.parent + 0x58, 0x32323232)
            self._set_word_quiet(self.ancestor + 0x54, 0x41414141)
            self._set_word_quiet(self.ancestor + 0x58, 0x42424242)
            # Origin storage is float; the helper above intentionally writes
            # dwords, so replace those two fixture bytes without hook output.
            self.suppress_writes = True
            self.write(self.parent + 0xd4, 'f', 3.25)
            self.write(self.parent + 0xd8, 'f', -2.5)
            self.suppress_writes = False
            parent_arg = self.parent
        else:
            parent_arg = 0

        self.running = True
        self.call(INIT, self.window, struct.pack('<I', parent_arg))
        self.running = False
        writes = [dict(item, value=self._label(item['value'])) for item in self.writes]
        events = []
        for event in self.events:
            event = dict(event)
            for key in ('outer', 'parent', 'child', 'object', 'graphicsContext'):
                if key in event:
                    event[key] = self._label(event[key])
            events.append(event)
        state = {
            'parentLink': self._label(self.read(self.window + 0x138, 'I')[0]),
            'normalFont': self._label(self.read(self.window + 0x54, 'I')[0]),
            'boldFont': self._label(self.read(self.window + 0x58, 'I')[0]),
            'origin': self.read(self.window + 0xd4, '6f'),
            'packedColors': [
                self.read(self.window + 0x3d, 'I')[0],
                self.read(self.window + 0x60, 'I')[0],
                self.read(self.window + 0x100, 'I')[0],
            ],
        }
        return {
            'name': name,
            'parent': 'parent' if with_parent else None,
            'events': events,
            'reads': list(self.reads),
            'writes': writes,
            'state': state,
        }

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'body': INIT,
                'fNameNoneIat': FNAME_NONE_IAT,
                'xgcOperatorNew': XGC_OPERATOR_NEW,
                'xgcConstructor': XGC_CONSTRUCTOR,
                'addChild': ADD_CHILD,
                'childAddedSlot': CHILD_ADDED_SLOT,
                'descendantAddedSlot': DESCENDANT_ADDED_SLOT,
                'setFonts': SET_FONTS,
            },
            'originalImports': self.original_imports,
            'cases': {
                'parentNull': self.case('parentNull', False),
                'parentFonts': self.case('parentFonts', True),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-init-oracle.py GAME_ROOT')
    print(json.dumps(WindowInitProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
