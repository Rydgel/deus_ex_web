"""Run the unchanged Extension.dll XWindow::SetPos/Move body.

The small exported SetPos helper and XWindow::Move execute in the x86 oracle.
Only AskParentForReconfigure is intercepted as the explicit synchronous leaf;
all alignment/position reads and writes remain native memory operations.
"""
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

SET_POS = EXTENSION_BASE + 0x32f0
MOVE = EXTENSION_BASE + 0x4ce80
ASK_RECONFIGURE = EXTENSION_BASE + 0x4e060
ALIGNMENT_X = 0x88
ALIGNMENT_Y = 0x89
POSITION_X = 0x8c
POSITION_Y = 0x94


def bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


class WindowPositionProbe(_NATIVE.NativeCollision):
    """Run SetPos with only the hierarchy reconfigure leaf intercepted."""

    def __init__(self, root):
        # Extension.dll is deliberately rebased away from the preferred Core
        # and Engine images.  Do not map another package at this base.
        super().__init__(Path(root), EXTENSION)
        self.window = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    @staticmethod
    def _float_bits(cpu, address):
        return int.from_bytes(cpu.mem_read(address, 4), 'little')

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or not (self.window <= address < self.window + 0x200):
            return
        offset = address - self.window
        if size == 1 and offset in (ALIGNMENT_X, ALIGNMENT_Y):
            captured = (int.from_bytes(cpu.mem_read(address, 1), 'little')
                        if access == UC_MEM_READ else value & 0xff)
            kind = 'u8'
        elif size == 4 and offset in (POSITION_X, POSITION_Y):
            captured = (self._float_bits(cpu, address)
                        if access == UC_MEM_READ else value & 0xffffffff)
            kind = 'f32'
        else:
            return
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'offset': offset,
            'kind': kind,
            'bits': captured,
        })

    def on_instruction(self, cpu, address, size, data):
        if address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure'})
            self._return(cpu, cpu.reg_read(_NATIVE.UC_X86_REG_ESP))
            return
        return super().on_instruction(cpu, address, size, data)

    def _return(self, cpu, stack):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def case(self, initial_alignment, initial_position, requested):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.cpu.mem_write(self.window + ALIGNMENT_X,
                           bytes((initial_alignment[0] & 0xff,)))
        self.cpu.mem_write(self.window + ALIGNMENT_Y,
                           bytes((initial_alignment[1] & 0xff,)))
        self.cpu.mem_write(self.window + POSITION_X,
                           struct.pack('<I', initial_position[0]))
        self.cpu.mem_write(self.window + POSITION_Y,
                           struct.pack('<I', initial_position[1]))
        self.accesses = []
        self.events = []
        self.running = True
        self.call(SET_POS, self.window, struct.pack('<2I', *requested))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'finalAlignment': [
                self.cpu.mem_read(self.window + ALIGNMENT_X, 1)[0],
                self.cpu.mem_read(self.window + ALIGNMENT_Y, 1)[0],
            ],
            'final': [
                self._float_bits(self.cpu, self.window + POSITION_X),
                self._float_bits(self.cpu, self.window + POSITION_Y),
            ],
        }

    def run(self):
        nan = 0x7fc12345
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'setPos': SET_POS,
                'move': MOVE,
                'askParentForReconfigure': ASK_RECONFIGURE,
            },
            'cases': {
                'alignmentX': self.case([1, 0], [bits(10), bits(20)],
                                        [bits(30), bits(40)]),
                'alignmentY': self.case([0, 1], [bits(10), bits(20)],
                                        [bits(30), bits(40)]),
                'changedX': self.case([0, 0], [bits(10), bits(20)],
                                      [bits(30), bits(20)]),
                'changedY': self.case([0, 0], [bits(30), bits(20)],
                                      [bits(30), bits(40)]),
                'unchanged': self.case([0, 0], [bits(30), bits(40)],
                                       [bits(30), bits(40)]),
                'negativeZero': self.case([0, 0], [0, 0],
                                          [0x80000000, 0x80000000]),
                'storedNaN': self.case([0, 0], [nan, bits(40)],
                                       [bits(5), bits(40)]),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-position-oracle.py GAME_ROOT')
    print(json.dumps(WindowPositionProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
