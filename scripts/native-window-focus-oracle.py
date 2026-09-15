"""Run Extension.dll XWindow::SetFocusWindow with clip/tween/virtuals as leaves."""
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
SET_FOCUS = EXTENSION_BASE + 0x4f0e0
CHECK_FOCUSABLE = EXTENSION_BASE + 0x4c460
FOCUS_GEOMETRY = EXTENSION_BASE + 0x4e230
FOCUS_TWEEN = EXTENSION_BASE + 0x4ffb0

TYPE = 0x28
FLAGS = 0x30
FLOAT80 = 0x80
FLOAT84 = 0x84
DWORD104 = 0x104
DWORD108 = 0x108
PARENT = 0x138
TYPE2_FOCUS = 0x178
ROOT_FOCUS = 0x5c8
TRACKED = {TYPE, FLAGS, FLOAT80, FLOAT84, DWORD104, DWORD108, PARENT, TYPE2_FOCUS, ROOT_FOCUS}


class WindowFocusProbe(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.vtable = self.alloc(0x100)
        self.stub_a8 = self.alloc(16)
        self.stub_ac = self.alloc(16)
        self.stub_b0 = self.alloc(16)
        self.stub_b4 = self.alloc(16)
        self.cpu.mem_write(self.stub_a8, b'\xc3')
        self.cpu.mem_write(self.stub_ac, b'\xc3')
        self.cpu.mem_write(self.stub_b0, bytes.fromhex('c20400'))
        self.cpu.mem_write(self.stub_b4, bytes.fromhex('c20400'))
        self.write(self.vtable + 0xa8, 'I', self.stub_a8)
        self.write(self.vtable + 0xac, 'I', self.stub_ac)
        self.write(self.vtable + 0xb0, 'I', self.stub_b0)
        self.write(self.vtable + 0xb4, 'I', self.stub_b4)
        self.windows = {
            'this': self.alloc(0x800),
            'root': self.alloc(0x800),
            'old': self.alloc(0x800),
            'new': self.alloc(0x800),
            'mid': self.alloc(0x800),
        }
        self.running = False
        self.accesses = []
        self.events = []
        self.focusable = 1
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    def _return(self, cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _label(self, pointer):
        for name, address in self.windows.items():
            if pointer == address:
                return name
        return None

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        for name, base in self.windows.items():
            if base <= address < base + 0x800:
                offset = address - base
                if offset not in TRACKED:
                    return
                if offset in (TYPE, FLAGS) and size != 1:
                    return
                if offset not in (TYPE, FLAGS) and size != 4:
                    return
                captured = (int.from_bytes(cpu.mem_read(address, size), 'little')
                            if access == UC_MEM_READ else value & ((1 << (size * 8)) - 1))
                kind = 'u8' if size == 1 else ('ptr' if offset in (PARENT, TYPE2_FOCUS, ROOT_FOCUS) else 'u32')
                label = self._label(captured) if kind == 'ptr' else None
                self.accesses.append({
                    'op': 'read' if access == UC_MEM_READ else 'write',
                    'object': name, 'offset': offset, 'kind': kind,
                    'bits': captured, 'label': label,
                })
                return

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == CHECK_FOCUSABLE:
            ecx = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            flag = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'checkFocusable', 'object': self._label(ecx), 'flag': flag,
            })
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, self.focusable)
            self._return(cpu, stack, 4)
            return
        if address == FOCUS_GEOMETRY:
            ecx = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            args = self.read(stack + 4, '4I')
            self.events.append({
                'op': 'focusGeometry', 'object': self._label(ecx), 'args': list(args),
            })
            self._return(cpu, stack, 16)
            return
        if address == FOCUS_TWEEN:
            ecx = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            args = self.read(stack + 4, '3I')
            self.events.append({
                'op': 'focusTween', 'object': self._label(ecx), 'args': list(args),
            })
            self._return(cpu, stack, 12)
            return
        if address == self.stub_ac:
            self.events.append({
                'op': 'virtual', 'slot': 0xac,
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'argument': None,
            })
            return
        if address == self.stub_a8:
            self.events.append({
                'op': 'virtual', 'slot': 0xa8,
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'argument': None,
            })
            return
        if address == self.stub_b4:
            arg = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'virtual', 'slot': 0xb4,
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'argument': self._label(arg),
            })
            return
        if address == self.stub_b0:
            arg = self.read(stack + 4, 'I')[0]
            self.events.append({
                'op': 'virtual', 'slot': 0xb0,
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'argument': self._label(arg),
            })
            return
        return super().on_instruction(cpu, address, size, data)

    def _init_window(self, name, *, parent=None, type_byte=1, flags=0, focus=None,
                     float80=0, float84=0, dword104=0, dword108=0, type2=0):
        base = self.windows[name]
        self.cpu.mem_write(base, b'\x00' * 0x800)
        self.write(base, 'I', self.vtable)
        self.cpu.mem_write(base + TYPE, bytes((type_byte & 0xff,)))
        self.cpu.mem_write(base + FLAGS, bytes((flags & 0xff,)))
        self.write(base + PARENT, 'I', 0 if parent is None else self.windows[parent])
        self.write(base + ROOT_FOCUS, 'I', 0 if focus is None else self.windows[focus])
        self.write(base + TYPE2_FOCUS, 'I', type2)
        self.write(base + FLOAT80, 'I', float80)
        self.write(base + FLOAT84, 'I', float84)
        self.write(base + DWORD104, 'I', dword104)
        self.write(base + DWORD108, 'I', dword108)

    def case(self, *, this, new, focusable=1, setup):
        for name, fields in setup.items():
            self._init_window(name, **fields)
        self.focusable = focusable
        self.accesses = []
        self.events = []
        self.running = True
        eax = self.call(SET_FOCUS, self.windows[this], struct.pack(
            '<I', 0 if new is None else self.windows[new]))
        self.running = False
        finals = {}
        for name, base in self.windows.items():
            if name not in setup:
                continue
            finals[name] = {
                'rootFocus': self._label(self.read(base + ROOT_FOCUS, 'I')[0]),
                'type2Focus': self._label(self.read(base + TYPE2_FOCUS, 'I')[0]),
            }
        return {
            'eax': eax & 0xffffffff,
            'accesses': list(self.accesses),
            'events': list(self.events),
            'finals': finals,
        }

    def run(self):
        selectable = 0x04
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'addresses': {
                'setFocusWindow': SET_FOCUS,
                'checkFocusable': CHECK_FOCUSABLE,
                'focusGeometry': FOCUS_GEOMETRY,
                'focusTween': FOCUS_TWEEN,
            },
            'cases': {
                'nonRoot': self.case(this='this', new=None, setup={
                    'this': {'type_byte': 1, 'flags': 0},
                }),
                'alreadyFocused': self.case(this='root', new='new', setup={
                    'root': {'type_byte': 3, 'flags': selectable, 'focus': 'new'},
                    'new': {'parent': 'root', 'type_byte': 2, 'flags': selectable},
                }),
                'rejected': self.case(this='root', new='new', focusable=0, setup={
                    'root': {'type_byte': 3, 'flags': selectable, 'focus': 'old'},
                    'old': {'parent': 'root', 'type_byte': 1, 'flags': selectable},
                    'new': {'parent': 'root', 'type_byte': 2, 'flags': selectable},
                }),
                'switch': self.case(this='root', new='new', setup={
                    'root': {'type_byte': 3, 'flags': selectable, 'focus': 'old'},
                    'old': {'parent': 'root', 'type_byte': 1, 'flags': selectable,
                            'dword108': 0x11111111, 'float80': 0x40000000, 'float84': 0x40800000},
                    'new': {'parent': 'root', 'type_byte': 2, 'flags': selectable,
                            'float80': 0x41000000, 'float84': 0x41800000, 'dword104': 0x22222222},
                }),
                'clearFocus': self.case(this='root', new=None, setup={
                    'root': {'type_byte': 3, 'flags': selectable, 'focus': 'old'},
                    'old': {'parent': 'root', 'type_byte': 1, 'flags': selectable,
                            'dword108': 0x33333333},
                }),
                'selectableAncestor': self.case(this='root', new='new', setup={
                    'root': {'type_byte': 3, 'flags': selectable, 'focus': 'old'},
                    'old': {'parent': 'root', 'type_byte': 1, 'flags': selectable,
                            'dword108': 0x10},
                    'mid': {'parent': 'root', 'type_byte': 2, 'flags': selectable,
                            'float80': 1, 'float84': 2, 'dword104': 3},
                    'new': {'parent': 'mid', 'type_byte': 1, 'flags': 0},
                }),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-focus-oracle.py GAME_ROOT')
    print(json.dumps(WindowFocusProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
