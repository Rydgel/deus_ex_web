"""Run Extension.dll XWindow::ChangeStyle with StyleChanged as a leaf."""
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
CHANGE_STYLE = EXTENSION_BASE + 0x50310

TYPE = 0x28
PARENT = 0x138
FIRST_CHILD = 0x13c
TOP_CHILD = 0x140
LOWER_SIBLING = 0x144
HIGHER_SIBLING = 0x148
TRACKED = {TYPE, PARENT, TOP_CHILD, LOWER_SIBLING}


class WindowChangeStyleProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.vtable = self.alloc(0x100)
        self.stub_e4 = self.alloc(16)
        self.cpu.mem_write(self.stub_e4, b'\xc3')
        self.write(self.vtable + 0xe4, 'I', self.stub_e4)
        self.windows = {
            'this': self.alloc(0x200),
            'root': self.alloc(0x200),
            'mid': self.alloc(0x200),
            'midA': self.alloc(0x200),
            'midB': self.alloc(0x200),
            'child': self.alloc(0x200),
            'childA': self.alloc(0x200),
            'childB': self.alloc(0x200),
            'leaf': self.alloc(0x200),
            'leafA': self.alloc(0x200),
            'leafB': self.alloc(0x200),
        }
        self.running = False
        self.accesses = []
        self.events = []
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def _label(self, pointer):
        if not pointer:
            return None
        for name, address in self.windows.items():
            if pointer == address:
                return name
        return None

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        for name, base in self.windows.items():
            if base <= address < base + 0x200:
                offset = address - base
                if offset not in TRACKED:
                    return
                if offset == TYPE and size != 1:
                    return
                if offset != TYPE and size != 4:
                    return
                captured = (int.from_bytes(cpu.mem_read(address, size), 'little')
                            if access == UC_MEM_READ else value & ((1 << (size * 8)) - 1))
                kind = 'u8' if size == 1 else 'ptr'
                label = self._label(captured) if kind == 'ptr' else None
                self.accesses.append({
                    'op': 'read' if access == UC_MEM_READ else 'write',
                    'object': name, 'offset': offset, 'kind': kind,
                    'bits': captured, 'label': label,
                })
                return

    def on_instruction(self, cpu, address, size, data):
        if address == self.stub_e4:
            self.events.append({
                'op': 'StyleChanged',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'slot': 0xe4,
            })
            return
        return super().on_instruction(cpu, address, size, data)

    def _init_window(self, name, *, parent=None, type_byte=1, top=None, lower=None,
                     first=None, higher=None):
        base = self.windows[name]
        self.cpu.mem_write(base, b'\x00' * 0x200)
        self.write(base, 'I', self.vtable)
        self.cpu.mem_write(base + TYPE, bytes((type_byte & 0xff,)))
        self.write(base + PARENT, 'I', 0 if parent is None else self.windows[parent])
        self.write(base + TOP_CHILD, 'I', 0 if top is None else self.windows[top])
        self.write(base + LOWER_SIBLING, 'I', 0 if lower is None else self.windows[lower])
        self.write(base + FIRST_CHILD, 'I', 0 if first is None else self.windows[first])
        self.write(base + HIGHER_SIBLING, 'I', 0 if higher is None else self.windows[higher])

    def case(self, this, setup):
        for name, fields in setup.items():
            self._init_window(name, **fields)
        self.accesses = []
        self.events = []
        self.running = True
        self.call(CHANGE_STYLE, self.windows[this], b'')
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
        }

    def run(self):
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'addresses': {
                'changeStyle': CHANGE_STYLE,
                'walk': EXTENSION_BASE + 0x510c0,
                'getRootWindow': EXTENSION_BASE + 0x4c5a0,
                'getTopChild': EXTENSION_BASE + 0x4c6b0,
                'getLowerSibling': EXTENSION_BASE + 0x4c650,
            },
            'cases': {
                'nonRoot': self.case('this', {
                    'this': {'type_byte': 1},
                }),
                'emptyRoot': self.case('root', {
                    'root': {'type_byte': 3},
                }),
                'singleChild': self.case('root', {
                    'root': {'type_byte': 3, 'top': 'child', 'first': 'child'},
                    'child': {'parent': 'root', 'type_byte': 1},
                }),
                'siblings': self.case('root', {
                    'root': {'type_byte': 3, 'top': 'childB', 'first': 'childA'},
                    'childB': {'parent': 'root', 'type_byte': 1, 'lower': 'childA'},
                    'childA': {'parent': 'root', 'type_byte': 1, 'higher': 'childB'},
                }),
                'nested': self.case('root', {
                    'root': {'type_byte': 3, 'top': 'mid'},
                    'mid': {'parent': 'root', 'type_byte': 1, 'top': 'leaf'},
                    'leaf': {'parent': 'mid', 'type_byte': 1},
                }),
                'fromChild': self.case('leaf', {
                    'root': {'type_byte': 3, 'top': 'mid'},
                    'mid': {'parent': 'root', 'type_byte': 1, 'top': 'leaf'},
                    'leaf': {'parent': 'mid', 'type_byte': 1},
                }),
                'twoLevel': self.case('root', {
                    'root': {'type_byte': 3, 'top': 'midB', 'first': 'midA'},
                    'midB': {'parent': 'root', 'type_byte': 1, 'top': 'leafB', 'lower': 'midA'},
                    'midA': {'parent': 'root', 'type_byte': 1, 'top': 'leafA', 'higher': 'midB'},
                    'leafB': {'parent': 'midB', 'type_byte': 1},
                    'leafA': {'parent': 'midA', 'type_byte': 1},
                }),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-change-style-oracle.py GAME_ROOT')
    print(json.dumps(WindowChangeStyleProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
