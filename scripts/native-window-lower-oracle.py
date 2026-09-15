"""Run Extension.dll XWindow::Lower with AddChild and focus as leaves."""
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
LOWER = EXTENSION_BASE + 0x4c2f0
ADD_CHILD = EXTENSION_BASE + 0x50a80
ASK_RECONFIGURE = EXTENSION_BASE + 0x4e060
CHECK_FOCUS = EXTENSION_BASE + 0x50b80
PARENT = 0x138
PREV_SIBLING = 0x144
NEXT_SIBLING = 0x148


class WindowLowerProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.child = self.alloc(0x200)
        self.parent = self.alloc(0x200)
        self.prev = self.alloc(0x200)
        self.next = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def _return(self, cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _label(self, pointer):
        return {self.child: 'child', self.parent: 'parent', self.prev: 'prev',
                self.next: 'next'}.get(pointer)

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or size != 4 or not (self.child <= address < self.child + 0x200):
            return
        offset = address - self.child
        if offset not in (PARENT, PREV_SIBLING, NEXT_SIBLING):
            return
        captured = (int.from_bytes(cpu.mem_read(address, 4), 'little')
                    if access == UC_MEM_READ else value & 0xffffffff)
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'offset': offset,
            'bits': captured,
            'label': self._label(captured) if access == UC_MEM_READ else None,
        })

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == ADD_CHILD:
            parent = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            child, flag = self.read(stack + 4, '2I')
            self.events.append({
                'op': 'AddChild', 'parent': self._label(parent),
                'child': self._label(child), 'flag': flag,
            })
            self._return(cpu, stack, 8)
            return
        if address == ASK_RECONFIGURE:
            self.events.append({
                'op': 'AskParentForReconfigure',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack)
            return
        if address == CHECK_FOCUS:
            self.events.append({
                'op': 'CheckFocusWindow',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, parent_bits, prev_bits, next_bits):
        self.cpu.mem_write(self.child, b'\xaa' * 0x200)
        self.write(self.child + PARENT, 'I', parent_bits)
        self.write(self.child + PREV_SIBLING, 'I', prev_bits)
        self.write(self.child + NEXT_SIBLING, 'I', next_bits)
        self.accesses = []
        self.events = []
        self.running = True
        self.call(LOWER, self.child, b'')
        self.running = False
        return {'accesses': list(self.accesses), 'events': list(self.events)}

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'addresses': {
                'lower': LOWER, 'addChild': ADD_CHILD,
                'askParentForReconfigure': ASK_RECONFIGURE,
                'checkFocusWindow': CHECK_FOCUS,
            },
            'cases': {
                'noParent': self.case(0, self.prev, self.next),
                'noLower': self.case(self.parent, 0, self.next),
                'lowered': self.case(self.parent, self.prev, self.next),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-lower-oracle.py GAME_ROOT')
    print(json.dumps(WindowLowerProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
