"""Execute Extension.dll's XWindow::ConfigureChild body unchanged.

The x86 method at 0x1004ec50 is run from the hash-checked Extension.dll image
rebased to 0x12000000.  Its internal callees 0x1004c140 (lock), 0x1004c150
(unlock), 0x1004c560 (type-1 ancestor) and 0x10050f90 (reconfigure children)
execute natively.  The intercepted leaves are the +0x90 configuration-changed
virtual, ResizeChild 0x1004eab0, the x87 bounds update 0x10051160, the qsort
0x10045140, SafeDestroy 0x1004c0b0, and the diagnostic fname/log IAT pair.
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

CONFIGURE_CHILD = EXTENSION_BASE + 0x4ec50
CONFIGURE_CHILD_END = EXTENSION_BASE + 0x4eded
EXEC_BODY = EXTENSION_BASE + 0x52f60
EXEC_END = EXTENSION_BASE + 0x53025
LOCK = EXTENSION_BASE + 0x4c140
UNLOCK = EXTENSION_BASE + 0x4c150
TYPE1_ANCESTOR = EXTENSION_BASE + 0x4c560
RECONFIGURE_CHILDREN = EXTENSION_BASE + 0x50f90
RESIZE_CHILD = EXTENSION_BASE + 0x4eab0
BOUNDS_UPDATE = EXTENSION_BASE + 0x51160
SORT_WINDOW_LISTS = EXTENSION_BASE + 0x45140
SAFE_DESTROY = EXTENSION_BASE + 0x4c0b0
CONFIGURATION_CHANGED_SLOT = 0x90
FNAME_IAT = EXTENSION_BASE + 0x59180
LOG_IAT = EXTENSION_BASE + 0x591a8
GERROR_IAT = EXTENSION_BASE + 0x590b4
DIAGNOSTIC_LINE = 0x2ff

VTABLE = 0x00
TYPE = 0x28
FLAGS = 0x30
LOCK_COUNT = 0x34
X = 0x78
Y = 0x7c
WIDTH = 0x80
HEIGHT = 0x84
ALIGN_X = 0x88
ALIGN_Y = 0x89
RECONFIGURE_FLAGS = 0xb8
PARENT = 0x138
FIRST_CHILD = 0x13c
NEXT_SIBLING = 0x148
WINDOW_SIZE = 0x800

CONTEXT = EXTENSION_BASE + 0xaeafc
RECONFIGURATION_DEPTH = EXTENSION_BASE + 0xaeb00
PREFERRED_SIZE_DEPTH = EXTENSION_BASE + 0xaeb04
GRANULARITY_DEPTH = EXTENSION_BASE + 0xaeb08
CONFIGURE_DEPTH = EXTENSION_BASE + 0xaeb0c
GLOBALS = {
    CONTEXT: ('global100aeafc', 'ptr'),
    RECONFIGURATION_DEPTH: ('global100aeb00', 'i32'),
    PREFERRED_SIZE_DEPTH: ('global100aeb04', 'i32'),
    GRANULARITY_DEPTH: ('global100aeb08', 'i32'),
    CONFIGURE_DEPTH: ('global100aeb0c', 'i32'),
}

U8_OFFSETS = {TYPE, FLAGS, ALIGN_X, ALIGN_Y}
F32_OFFSETS = {X, Y, WIDTH, HEIGHT}
U32_OFFSETS = {LOCK_COUNT}
PTR_OFFSETS = {VTABLE, PARENT, FIRST_CHILD, NEXT_SIBLING}
TRACKED = U8_OFFSETS | F32_OFFSETS | U32_OFFSETS | PTR_OFFSETS | {RECONFIGURE_FLAGS}


class WindowConfigureChildProbe(_NATIVE.NativeCollision):
    """Run ConfigureChild with the documented leaf boundaries."""

    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.accesses = []
        self.windows = {}
        self.labels = {}
        self.fname_stub = self.alloc(16)
        self.log_stub = self.alloc(16)
        self.config_stub = self.alloc(16)
        for stub in (self.fname_stub, self.log_stub, self.config_stub):
            self.cpu.mem_write(stub, b'\xc3')
        self.write(FNAME_IAT, 'I', self.fname_stub)
        self.write(LOG_IAT, 'I', self.log_stub)
        self.diagnostic_object = None
        self.diagnostic_name = 0
        self.running = False
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _label(self, pointer):
        if pointer == 0:
            return None
        for name, address in self.labels.items():
            if pointer == address:
                return name
        return pointer

    def _kind(self, offset, size):
        if offset in U8_OFFSETS or size == 1:
            return 'u8'
        if offset in F32_OFFSETS:
            return 'f32'
        if offset in PTR_OFFSETS:
            return 'ptr'
        return 'u32'

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running or size not in (1, 4):
            return
        op = 'read' if access == UC_MEM_READ else 'write'
        captured = (int.from_bytes(cpu.mem_read(address, size), 'little')
                    if access == UC_MEM_READ else value)
        if address in GLOBALS:
            name, kind = GLOBALS[address]
            self.accesses.append({
                'op': op, 'global': name, 'kind': kind, 'size': size,
                'bits': captured,
                'label': self._label(captured) if kind == 'ptr' else None,
            })
            return
        for name, base in self.windows.items():
            if not (base <= address < base + WINDOW_SIZE):
                continue
            offset = address - base
            if offset not in TRACKED:
                return
            kind = self._kind(offset, size)
            if kind == 'u8' and size != 1:
                return
            if kind != 'u8' and size != 4:
                return
            self.accesses.append({
                'op': op, 'object': name, 'offset': offset, 'kind': kind,
                'size': size, 'bits': captured,
                'label': self._label(captured) if kind == 'ptr' else None,
            })
            return

    def _window(self, label, fields):
        address = self.alloc(WINDOW_SIZE)
        vtable = self.alloc(0x100)
        self.cpu.mem_write(address, b'\xaa' * WINDOW_SIZE)
        self.cpu.mem_write(vtable, b'\x00' * 0x100)
        self.cpu.mem_write(self.config_stub, b'\xc3')
        self.write(address, 'I', vtable)
        self.write(vtable + CONFIGURATION_CHANGED_SLOT, 'I', self.config_stub)
        self.write(address + TYPE, 'B', fields.get('type', 0))
        self.write(address + FLAGS, 'I', fields.get('flags', 0))
        self.write(address + LOCK_COUNT, 'I', fields.get('lock', 0))
        for offset, key in ((X, 'x'), (Y, 'y'), (WIDTH, 'width'), (HEIGHT, 'height')):
            self.write(address + offset, 'I', fields.get(key, 0))
        self.write(address + ALIGN_X, 'B', fields.get('alignX', 0))
        self.write(address + ALIGN_Y, 'B', fields.get('alignY', 0))
        self.write(address + RECONFIGURE_FLAGS, 'I', fields.get('b8', 0))
        self.windows[label] = address
        self.labels[label] = address
        return address

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == self.fname_stub:
            self.diagnostic_object = self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX))
            self.diagnostic_name = self.read(stack + 4, 'I')[0]
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, 0x4e616d65)  # opaque name ptr
            self._return(cpu, stack, 4)  # thiscall callee pops the zero flag arg
            return
        if address == self.log_stub:
            gerror, line, fmt, name = self.read(stack + 4, '4I')
            self.events.append({
                'op': 'diagnostic',
                'object': self.diagnostic_object,
                'format': fmt,
                'line': line,
                'name': name,
                'gerror': gerror,
            })
            self._return(cpu, stack, 0)  # cdecl: the caller cleans four args
            return
        if address == self.config_stub:
            self.events.append({
                'op': 'ConfigurationChanged',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
                'virtualSlot': CONFIGURATION_CHANGED_SLOT,
            })
            self._return(cpu, stack, 0)
            return
        if address == RESIZE_CHILD:
            self.events.append({
                'op': 'ResizeChild',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack, 0)
            return
        if address == BOUNDS_UPDATE:
            self.events.append({
                'op': 'BoundsUpdate',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack, 0)
            return
        if address == SORT_WINDOW_LISTS:
            self.events.append({
                'op': 'SortWindowLists',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack, 0)
            return
        if address == SAFE_DESTROY:
            self.events.append({
                'op': 'SafeDestroy',
                'object': self._label(cpu.reg_read(_NATIVE.UC_X86_REG_ECX)),
            })
            self._return(cpu, stack, 0)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, args, windows, globals_):
        """windows: [(label, fields)] with 'parent'/'firstChild'/'nextSibling'
        naming other labels.  globals_: {address-name: int-or-label}."""
        self.events = []
        self.accesses = []
        self.windows = {}
        self.labels = {}
        for label, fields in windows:
            self._window(label, fields)
        for label, fields in windows:
            for key, offset in (('parent', PARENT), ('firstChild', FIRST_CHILD),
                                ('nextSibling', NEXT_SIBLING)):
                self.write(self.windows[label] + offset, 'I',
                           self.labels.get(fields.get(key), 0))
        self.write(CONTEXT, 'I',
                   self.labels.get(globals_.get('context'), 0)
                   if globals_.get('context') else globals_.get('contextRaw', 0))
        self.write(RECONFIGURATION_DEPTH, 'i', globals_.get('reconfigurationDepth', 0))
        self.write(PREFERRED_SIZE_DEPTH, 'i', globals_.get('preferredSizeDepth', 0))
        self.write(GRANULARITY_DEPTH, 'i', globals_.get('granularityDepth', 0))
        self.write(CONFIGURE_DEPTH, 'i', globals_.get('configureDepth', 0))
        self.running = True
        self.call(CONFIGURE_CHILD, self.windows[windows[0][0]],
                  struct.pack('<4I', *args))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'state': {
                label: {
                    'lock': self.read(address + LOCK_COUNT, 'I')[0],
                    'b8': self.read(address + RECONFIGURE_FLAGS, 'I')[0],
                    'x': self.read(address + X, 'I')[0],
                    'y': self.read(address + Y, 'I')[0],
                    'width': self.read(address + WIDTH, 'I')[0],
                    'height': self.read(address + HEIGHT, 'I')[0],
                }
                for label, address in self.windows.items()
            },
            'globals': {
                'context': self._label(self.read(CONTEXT, 'I')[0]),
                'reconfigurationDepth': self.read(RECONFIGURATION_DEPTH, 'i')[0],
                'preferredSizeDepth': self.read(PREFERRED_SIZE_DEPTH, 'i')[0],
                'granularityDepth': self.read(GRANULARITY_DEPTH, 'i')[0],
                'configureDepth': self.read(CONFIGURE_DEPTH, 'i')[0],
            },
        }


def f32(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-configure-child-oracle.py GAME_ROOT')
    probe = WindowConfigureChildProbe(Path(sys.argv[1]))
    VISIBLE = 0x01
    DESTROY = 0x10

    base = {'type': 0, 'flags': VISIBLE, 'lock': 0, 'b8': 0,
            'x': f32(1), 'y': f32(2), 'width': f32(3), 'height': f32(4)}
    args = [f32(5), f32(6), f32(7), f32(8)]

    cases = {}
    # Invisible: after the flag writes the method skips everything but the
    # depth decrement and unlock.
    cases['hidden'] = probe.case(args, [
        ('this', {**base, 'flags': 0}),
    ], {})
    # Width differs: full reconfigure-children pass over a mixed child list,
    # then the depth==1 bounds/sort gate.
    cases['changedWidth'] = probe.case(args, [
        ('this', {**base, 'firstChild': 'c1'}),
        ('c1', {'flags': VISIBLE, 'alignX': 1, 'nextSibling': 'c2'}),
        ('c2', {'flags': 0, 'alignX': 1, 'nextSibling': 'c3'}),
        ('c3', {'flags': VISIBLE, 'nextSibling': 'c4'}),
        ('c4', {'flags': VISIBLE, 'alignY': 1}),
    ], {})
    # Same dims but the pending +0xb8 bit0 forces the reconfigure path.
    cases['pendingBit'] = probe.case(
        [base['x'], base['y'], base['width'], base['height']],
        [('this', {**base, 'b8': 1})], {})
    # Same dims, no pending bit: children untouched, bounds gate still runs.
    cases['unchanged'] = probe.case(
        [base['x'], base['y'], base['width'], base['height']],
        [('this', {**base, 'firstChild': 'c1'}),
         ('c1', {'flags': VISIBLE, 'alignX': 1})], {})
    # Preset depth 1 (nested call): the gate falls through to the type byte.
    cases['nestedType0'] = probe.case(args, [
        ('this', {**base, 'type': 0}),
    ], {'configureDepth': 1})
    cases['nestedType1'] = probe.case(args, [
        ('this', {**base, 'type': 1}),
    ], {'configureDepth': 1})
    # Type-0 window whose ancestor has type>=1: the sort lands on the parent.
    cases['ancestorSort'] = probe.case(args, [
        ('this', {**base, 'type': 0, 'parent': 'p'}),
        ('p', {'flags': VISIBLE, 'type': 2, 'parent': 'gp'}),
        ('gp', {'flags': VISIBLE, 'type': 0}),
    ], {})
    # Type-0 chain to nowhere: no sort leaf.
    cases['noAncestor'] = probe.case(args, [
        ('this', {**base, 'type': 0, 'parent': 'p'}),
        ('p', {'flags': VISIBLE, 'type': 0}),
    ], {'configureDepth': 1})
    # Diagnostics: context mismatch, then both positive counters.
    cases['contextDiag'] = probe.case(args, [
        ('this', {**base, 'parent': 'p'}),
        ('p', {'flags': VISIBLE, 'type': 3}),
        ('other', {'flags': VISIBLE, 'type': 3}),
    ], {'context': 'other'})
    cases['contextIsParent'] = probe.case(args, [
        ('this', {**base, 'parent': 'p'}),
        ('p', {'flags': VISIBLE, 'type': 3}),
    ], {'context': 'p'})
    cases['counterDiags'] = probe.case(args, [
        ('this', {**base}),
    ], {'preferredSizeDepth': 2, 'granularityDepth': 3})
    # Unlock paths: the beingDestroyed bit dispatches SafeDestroy.
    cases['unlockDestroys'] = probe.case(args, [
        ('this', {**base, 'flags': VISIBLE | DESTROY, 'lock': 0}),
    ], {})
    cases['unlockNestedDestroy'] = probe.case(args, [
        ('this', {**base, 'flags': VISIBLE | DESTROY, 'lock': 2}),
    ], {})
    # x87 C3: a stored NaN width compares equal to any argument; -0 == +0.
    cases['nanWidth'] = probe.case(
        [f32(5), f32(6), f32(7), f32(4)],
        [('this', {**base, 'width': 0x7fc00000, 'height': f32(4)})], {})
    cases['negZero'] = probe.case(
        [f32(1), f32(2), 0x00000000, f32(4)],
        [('this', {**base, 'width': 0x80000000, 'height': f32(4)})], {})
    result = {
        'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
        'extensionBase': EXTENSION_BASE,
        'addresses': {
            'body': CONFIGURE_CHILD,
            'end': CONFIGURE_CHILD_END,
            'execBody': EXEC_BODY,
            'execEnd': EXEC_END,
            'lock': LOCK,
            'unlock': UNLOCK,
            'type1Ancestor': TYPE1_ANCESTOR,
            'reconfigureChildren': RECONFIGURE_CHILDREN,
            'resizeChild': RESIZE_CHILD,
            'boundsUpdate': BOUNDS_UPDATE,
            'sortWindowLists': SORT_WINDOW_LISTS,
            'safeDestroy': SAFE_DESTROY,
            'configurationChangedSlot': CONFIGURATION_CHANGED_SLOT,
            'fnameIat': FNAME_IAT,
            'logIat': LOG_IAT,
            'gerrorIat': GERROR_IAT,
            'diagnosticLine': DIAGNOSTIC_LINE,
        },
        'cases': cases,
    }
    print(json.dumps(result))


if __name__ == '__main__':
    main()
