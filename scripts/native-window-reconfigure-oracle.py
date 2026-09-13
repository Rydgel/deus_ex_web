"""Execute Extension.dll's XWindow::AskParentForReconfigure body unchanged.

The x86 body is run from the hash-checked Extension.dll image rebased to
0x12000000.  Virtual callbacks and ResizeChild are intercepted as explicit
leaves; the probe does not emulate the native UI callback bodies or diagnostic
logging graph.
"""
import importlib.util
import json
from pathlib import Path
import sys

from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_READ


_SPEC = importlib.util.spec_from_file_location(
    'native_window_child', Path(__file__).with_name('native-window-child-oracle.py'))
_CHILD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_CHILD)
_NATIVE = _CHILD._NATIVE


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

ASK_PARENT_FOR_RECONFIGURE = EXTENSION_BASE + 0x4e060
RESIZE_CHILD = EXTENSION_BASE + 0x4eab0
RECONFIGURE_DEPTH = EXTENSION_BASE + 0xaeb00
PREFERRED_SIZE_DEPTH = EXTENSION_BASE + 0xaeb04
GRANULARITY_DEPTH = EXTENSION_BASE + 0xaeb08
CONTEXT = EXTENSION_BASE + 0xaeafc
VISIBILITY_OFFSET = 0x30
RECONFIGURE_FLAGS_OFFSET = 0xb8
PARENT_OFFSET = 0x138
PARENT_CALLBACK_SLOT = 0x88
ROOT_CALLBACK_SLOT = 0x90
VISIBILITY_BIT = 0x01
RECONFIGURE_BIT = 0x01
INITIALIZE_MASK = 0x03


class WindowReconfigureProbe(_NATIVE.NativeCollision):
    """Run AskParentForReconfigure with synchronous callback leaves."""

    def __init__(self, root):
        # Extension.dll is deliberately rebased away from the preferred Core
        # and Engine images.  NativeCollision applies the original relocations.
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.accesses = []
        self.objects = {}
        self.running = False
        self.parent_result = 0
        self.vtable = self.alloc(0x100)
        self.parent_callback_stub = self.alloc(16)
        self.root_callback_stub = self.alloc(16)
        for address in (self.parent_callback_stub, self.root_callback_stub):
            self.cpu.mem_write(address, b'\xc3')
        self.write(self.vtable + PARENT_CALLBACK_SLOT, 'I', self.parent_callback_stub)
        self.write(self.vtable + ROOT_CALLBACK_SLOT, 'I', self.root_callback_stub)
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _tracked(self, address, size):
        for label, object_address in self.objects.items():
            for offset, kind in ((VISIBILITY_OFFSET, 'u8'),
                                 (RECONFIGURE_FLAGS_OFFSET, 'u32'),
                                 (PARENT_OFFSET, 'ptr')):
                if address == object_address + offset:
                    if offset == RECONFIGURE_FLAGS_OFFSET and size == 1:
                        kind = 'u8'
                    return {'object': label, 'offset': offset, 'kind': kind}
        globals_by_address = {
            RECONFIGURE_DEPTH: ('global100aeb00', 'i32'),
            PREFERRED_SIZE_DEPTH: ('global100aeb04', 'i32'),
            GRANULARITY_DEPTH: ('global100aeb08', 'i32'),
            CONTEXT: ('global100aeafc', 'ptr'),
        }
        if address in globals_by_address:
            name, kind = globals_by_address[address]
            return {'global': name, 'kind': kind}
        return None

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or size not in (1, 4):
            return
        tracked = self._tracked(address, size)
        if tracked is None:
            return
        item = {
            'op': 'read' if access == UC_MEM_READ else 'write',
            **tracked,
            'size': size,
            'value': (int.from_bytes(cpu.mem_read(address, size), 'little')
                      if access == UC_MEM_READ else value),
        }
        self.accesses.append(item)

    def _label(self, value):
        if value == 0:
            return None
        for label, object_address in self.objects.items():
            if value == object_address:
                return label
        if value == 0x45454545:
            return 'contextSeed'
        return value

    def _object(self, label, flags, parent=0):
        address = self.alloc(0x200)
        self.cpu.mem_write(address, b'\xaa' * 0x200)
        self.write(address, 'I', self.vtable)
        self.write(address + VISIBILITY_OFFSET, 'I', flags)
        self.write(address + RECONFIGURE_FLAGS_OFFSET, 'I', 0x55667704)
        self.write(address + PARENT_OFFSET, 'I', parent)
        self.objects[label] = address
        return address

    def _reset_globals(self):
        self.write(RECONFIGURE_DEPTH, 'i', 0)
        self.write(PREFERRED_SIZE_DEPTH, 'i', 0)
        self.write(GRANULARITY_DEPTH, 'i', 0)
        self.write(CONTEXT, 'I', 0x45454545)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == self.parent_callback_stub:
            parent = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            child = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'ChildRequestedReconfiguration',
                'parent': self._label(parent),
                'child': self._label(child),
                'virtualSlot': PARENT_CALLBACK_SLOT,
                'result': self.parent_result,
            })
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, self.parent_result)
            self._return(cpu, stack, 4)
            return
        if address == self.root_callback_stub:
            self.events.append({
                'op': 'ConfigurationChanged',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'virtualSlot': ROOT_CALLBACK_SLOT,
            })
            self._return(cpu, stack)
            return
        if address == RESIZE_CHILD:
            self.events.append({
                'op': 'ResizeChild',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, name):
        self.events = []
        self.accesses = []
        self.objects = {}
        self.parent_result = 0
        self._reset_globals()

        if name == 'normalhidden':
            window = self._object('window', 0)
        elif name == 'rootvisible':
            window = self._object('window', VISIBILITY_BIT)
        elif name == 'parentcallback':
            parent = self._object('parent', VISIBILITY_BIT)
            window = self._object('window', VISIBILITY_BIT, parent)
        else:
            raise ValueError(f'Unknown reference case: {name}')

        self.running = True
        result = self.call(ASK_PARENT_FOR_RECONFIGURE, window, b'')
        self.running = False

        accesses = []
        for item in self.accesses:
            item = dict(item)
            if item['kind'] == 'ptr':
                item['value'] = self._label(item['value'])
            accesses.append(item)
        reads = [item for item in accesses if item['op'] == 'read']
        writes = [item for item in accesses if item['op'] == 'write']
        state = {
            label: self.read(address + RECONFIGURE_FLAGS_OFFSET, 'I')[0]
            for label, address in self.objects.items()
        }
        return {
            'result': result,
            'events': list(self.events),
            'accesses': accesses,
            'reads': reads,
            'writes': writes,
            'state': {'flags': state},
            'globals': {
                'reconfigurationDepth': self.read(RECONFIGURE_DEPTH, 'i')[0],
                'preferredSizeDepth': self.read(PREFERRED_SIZE_DEPTH, 'i')[0],
                'granularityDepth': self.read(GRANULARITY_DEPTH, 'i')[0],
                'context': self._label(self.read(CONTEXT, 'I')[0]),
            },
        }

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'body': ASK_PARENT_FOR_RECONFIGURE,
                'resizeChild': RESIZE_CHILD,
                'parentRequestedReconfigurationSlot': PARENT_CALLBACK_SLOT,
                'configurationChangedSlot': ROOT_CALLBACK_SLOT,
                'reconfigurationDepth': RECONFIGURE_DEPTH,
                'preferredSizeDepth': PREFERRED_SIZE_DEPTH,
                'granularityDepth': GRANULARITY_DEPTH,
                'context': CONTEXT,
            },
            'cases': {name: self.case(name)
                      for name in ('normalhidden', 'rootvisible', 'parentcallback')},
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-reconfigure-oracle.py GAME_ROOT')
    print(json.dumps(WindowReconfigureProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
