"""Execute the unchanged Extension.dll Window.SetBackgroundStyle path.

The wrapper and Window/XGC bodies remain native x86 instructions.  Only
GeneratePolyFlags is intercepted as the explicit synchronous leaf described
by the Stage 3 translation.  The probe records the relevant byte/dword
accesses for a null-GC branch and styles 1 through 4.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_READ


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

EXEC = EXTENSION_BASE + 0x51d50
EXEC_END = EXTENSION_BASE + 0x51d93
SET_BACKGROUND_STYLE = EXTENSION_BASE + 0x4d670
SET_BACKGROUND_STYLE_END = EXTENSION_BASE + 0x4d6c1
SET_STYLE = EXTENSION_BASE + 0x27170
SET_STYLE_END = EXTENSION_BASE + 0x2724b
GENERATE_POLY_FLAGS = EXTENSION_BASE + 0x2af00

WINDOW_BACKGROUND_STYLE = 0x3c
WINDOW_GC = 0x130
GC_STYLE = 0x44
GC_FLAGS = 0x48


class WindowBackgroundStyleProbe(_NATIVE.NativeCollision):
    """Execute SetBackgroundStyle with GeneratePolyFlags as a leaf."""

    def __init__(self, root):
        self.root = Path(root)
        super().__init__(self.root, EXTENSION)
        self.window = self.alloc(0x200)
        self.gc = self.alloc(0x200)
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_memory)

    @staticmethod
    def _return(cpu, stack):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _region(self, address, size):
        if self.window <= address and address + size <= self.window + 0x200:
            return 'window', address - self.window
        if self.gc <= address and address + size <= self.gc + 0x200:
            return 'gc', address - self.gc
        return None

    def on_memory(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        region = self._region(address, size)
        if region is None:
            return
        name, offset = region
        actual = value & ((1 << (size * 8)) - 1) if access != UC_MEM_READ else int.from_bytes(
            cpu.mem_read(address, size), 'little')
        if ((name == 'window' and offset not in (WINDOW_BACKGROUND_STYLE, WINDOW_GC)) or
                (name == 'gc' and offset not in (GC_STYLE, GC_FLAGS))):
            return
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'region': name,
            'offset': offset,
            'size': size,
            'value': actual,
        })

    def on_instruction(self, cpu, address, size, data):
        if address == GENERATE_POLY_FLAGS:
            receiver = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({
                'op': 'GeneratePolyFlags',
                'receiver': 'gc' if receiver == self.gc else receiver,
                'native': GENERATE_POLY_FLAGS,
            })
            self._return(cpu, cpu.reg_read(_NATIVE.UC_X86_REG_ESP))
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, name, initial_style, initial_flags, style, gc):
        self.cpu.mem_write(self.window, b'\xaa' * 0x200)
        self.cpu.mem_write(self.gc, b'\xaa' * 0x200)
        self.write(self.window + WINDOW_BACKGROUND_STYLE, 'B', initial_style)
        self.write(self.window + WINDOW_GC, 'I', self.gc if gc else 0)
        self.write(self.gc + GC_STYLE, 'B', 0x77)
        self.write(self.gc + GC_FLAGS, 'I', initial_flags)
        self.accesses = []
        self.events = []
        self.running = True
        self.call(SET_BACKGROUND_STYLE, self.window, struct.pack('<I', style))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'final': {
                'windowStyle': self.read(self.window + WINDOW_BACKGROUND_STYLE, 'B')[0],
                'gcStyle': self.read(self.gc + GC_STYLE, 'B')[0],
                'gcFlags': self.read(self.gc + GC_FLAGS, 'I')[0],
            },
        }

    def run(self):
        cases = {
            'nullGc': self.case('nullGc', 0x55, 0xa5a5a5a5, 3, False),
            'style0': self.case('style0', 0x55, 0xffffffff, 0, True),
            'style1': self.case('style1', 0x55, 0xa5a5a5a5, 1, True),
            'style2': self.case('style2', 0x55, 0x12345678, 2, True),
            'style3': self.case('style3', 0x55, 0x89abcdef, 3, True),
            'style4': self.case('style4', 0x55, 0x13579bdf, 4, True),
        }
        extension_path = self.root / 'System' / 'Extension.dll'
        image = _NATIVE.Image(extension_path, EXTENSION_HASH)
        body_hashes = {}
        for name, start, end in (
                ('exec', EXEC, EXEC_END),
                ('setBackgroundStyle', SET_BACKGROUND_STYLE, SET_BACKGROUND_STYLE_END),
                ('setStyle', SET_STYLE, SET_STYLE_END)):
            body = image.data[image.offset(start - EXTENSION_BASE):
                              image.offset(end - EXTENSION_BASE)]
            body_hashes[name] = hashlib.sha256(body).hexdigest()
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'exec': EXEC,
                'execEnd': EXEC_END,
                'setBackgroundStyle': SET_BACKGROUND_STYLE,
                'setBackgroundStyleEnd': SET_BACKGROUND_STYLE_END,
                'setStyle': SET_STYLE,
                'setStyleEnd': SET_STYLE_END,
                'generatePolyFlags': GENERATE_POLY_FLAGS,
            },
            'bodySha256': body_hashes,
            'cases': cases,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-background-style-oracle.py GAME_ROOT')
    print(json.dumps(WindowBackgroundStyleProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
