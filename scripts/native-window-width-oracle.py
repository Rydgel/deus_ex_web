"""Run Extension.dll XWindow::SetWidth unchanged with reconfigure as a leaf."""
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
SET_WIDTH = EXTENSION_BASE + 0x4d040
ASK_RECONFIGURE = EXTENSION_BASE + 0x4e060
WIDTH = 0x9c
HEIGHT = 0xa0


def bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


class WindowWidthProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.window = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    @staticmethod
    def _return(cpu, stack):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or size != 4 or address not in (self.window + WIDTH, self.window + HEIGHT):
            return
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'offset': address - self.window,
            'bits': (int.from_bytes(cpu.mem_read(address, 4), 'little')
                     if access == UC_MEM_READ else value & 0xffffffff),
        })

    def on_instruction(self, cpu, address, size, data):
        if address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure'})
            self._return(cpu, cpu.reg_read(_NATIVE.UC_X86_REG_ESP))
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, initial, requested):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.write(self.window + WIDTH, 'I', initial[0])
        self.write(self.window + HEIGHT, 'I', initial[1])
        self.accesses = []
        self.events = []
        self.running = True
        self.call(SET_WIDTH, self.window, struct.pack('<I', requested))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'final': [self.read(self.window + WIDTH, 'I')[0], self.read(self.window + HEIGHT, 'I')[0]],
        }

    def run(self):
        nan = 0x7fc12345
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'addresses': {'setWidth': SET_WIDTH, 'askParentForReconfigure': ASK_RECONFIGURE},
            'cases': {
                'changed': self.case([bits(3), bits(4)], bits(431)),
                'unchanged': self.case([bits(431), bits(114)], bits(431)),
                'clamped': self.case([bits(3), bits(4)], bits(-5)),
                'requestedNaN': self.case([bits(3), bits(4)], nan),
                'negativeZero': self.case([bits(3), bits(4)], 0x80000000),
                'storedNaN': self.case([nan, bits(4)], bits(5)),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-width-oracle.py GAME_ROOT')
    print(json.dumps(WindowWidthProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
