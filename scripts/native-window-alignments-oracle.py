"""Run the unchanged Extension.dll XWindow::SetWindowAlignments body."""
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

SET_ALIGNMENTS = EXTENSION_BASE + 0x4d300
ASK_RECONFIGURE = EXTENSION_BASE + 0x4e060
H_ALIGN = 0x88
V_ALIGN = 0x89
H_MARGIN0 = 0x8c
H_MARGIN1 = 0x90
V_MARGIN0 = 0x94
V_MARGIN1 = 0x98
BYTE_FIELDS = (H_ALIGN, V_ALIGN)
FLOAT_FIELDS = (H_MARGIN0, H_MARGIN1, V_MARGIN0, V_MARGIN1)


def bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


class WindowAlignmentsProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.window = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def _return(self, cpu, stack):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or not (self.window <= address < self.window + 0x200):
            return
        offset = address - self.window
        if size == 1 and offset in BYTE_FIELDS:
            captured = (int.from_bytes(cpu.mem_read(address, 1), 'little')
                        if access == UC_MEM_READ else value & 0xff)
            kind = 'u8'
        elif size == 4 and offset in FLOAT_FIELDS:
            captured = (int.from_bytes(cpu.mem_read(address, 4), 'little')
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

    def case(self, initial_align, initial_margin, requested):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.cpu.mem_write(self.window + H_ALIGN, bytes((initial_align[0] & 0xff,)))
        self.cpu.mem_write(self.window + V_ALIGN, bytes((initial_align[1] & 0xff,)))
        for offset, value in zip(FLOAT_FIELDS, initial_margin):
            self.cpu.mem_write(self.window + offset, struct.pack('<I', value))
        self.accesses = []
        self.events = []
        self.running = True
        self.call(SET_ALIGNMENTS, self.window, struct.pack('<6I', *requested))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'finalAlign': [
                self.cpu.mem_read(self.window + H_ALIGN, 1)[0],
                self.cpu.mem_read(self.window + V_ALIGN, 1)[0],
            ],
            'finalMargin': [
                int.from_bytes(self.cpu.mem_read(self.window + H_MARGIN0, 4), 'little'),
                int.from_bytes(self.cpu.mem_read(self.window + H_MARGIN1, 4), 'little'),
                int.from_bytes(self.cpu.mem_read(self.window + V_MARGIN0, 4), 'little'),
                int.from_bytes(self.cpu.mem_read(self.window + V_MARGIN1, 4), 'little'),
            ],
        }

    def run(self):
        nan = 0x7fc12345
        zero = [bits(0), bits(0), bits(0), bits(0)]
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'setWindowAlignments': SET_ALIGNMENTS,
                'askParentForReconfigure': ASK_RECONFIGURE,
            },
            'cases': {
                'hAlign': self.case([0, 0], zero, [1, 0, bits(0), bits(0), bits(0), bits(0)]),
                'vAlign': self.case([0, 0], zero, [0, 2, bits(0), bits(0), bits(0), bits(0)]),
                'hMargin0': self.case([3, 3], zero, [3, 3, bits(1), bits(0), bits(0), bits(0)]),
                'hMargin1': self.case([3, 3], [bits(0), bits(0), bits(0), bits(0)],
                                     [3, 3, bits(0), bits(0), bits(4), bits(0)]),
                'vMargin0': self.case([3, 3], zero, [3, 3, bits(0), bits(5), bits(0), bits(0)]),
                'vMargin1': self.case([3, 3], zero, [3, 3, bits(0), bits(0), bits(0), bits(6)]),
                'unchanged': self.case([3, 3], [bits(1), bits(4), bits(5), bits(6)],
                                       [3, 3, bits(1), bits(5), bits(4), bits(6)]),
                'negativeZero': self.case([0, 0], zero,
                                          [0, 0, 0x80000000, 0x80000000, 0x80000000, 0x80000000]),
                'storedNaN': self.case([0, 0], [nan, bits(0), bits(0), bits(0)],
                                       [0, 0, bits(1), bits(0), bits(0), bits(0)]),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-alignments-oracle.py GAME_ROOT')
    print(json.dumps(WindowAlignmentsProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
