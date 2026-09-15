"""Run Extension.dll XWindow::GetParent unchanged."""
import importlib.util
import json
from pathlib import Path
import struct
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
GET_PARENT = EXTENSION_BASE + 0x4c550
PARENT = 0x138
FIRST_CHILD = 0x13c


class WindowParentProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.window = self.alloc(0x200)
        self.parent = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or size != 4:
            return
        if not (self.window <= address < self.window + 0x200):
            return
        offset = address - self.window
        if offset not in (PARENT, FIRST_CHILD):
            return
        captured = (int.from_bytes(cpu.mem_read(address, 4), 'little')
                    if access == UC_MEM_READ else value & 0xffffffff)
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'offset': offset,
            'bits': captured,
        })

    def case(self, parent_bits):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.write(self.window + PARENT, 'I', parent_bits)
        self.write(self.window + FIRST_CHILD, 'I', 0x11111111)
        self.accesses = []
        self.running = True
        eax = self.call(GET_PARENT, self.window, b'')
        self.running = False
        return {
            'accesses': list(self.accesses),
            'eax': eax & 0xffffffff,
            'finalParent': self.read(self.window + PARENT, 'I')[0],
            'finalFirstChild': self.read(self.window + FIRST_CHILD, 'I')[0],
        }

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'addresses': {'getParent': GET_PARENT, 'parentWindow': self.parent},
            'cases': {
                'nullParent': self.case(0),
                'liveParent': self.case(self.parent),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-parent-oracle.py GAME_ROOT')
    print(json.dumps(WindowParentProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
