"""Execute Extension.dll's XToggleWindow::SetToggle body unchanged.

The x86 method at 0x100499b0 is run from the hash-checked Extension.dll image
rebased to 0x12000000.  Its internal callees 0x10008380 (style refresh),
0x1004ca20 (focus check) and 0x10049910 (ancestor notify) execute natively;
the only intercepted boundary is the per-ancestor virtual call through
vtable slot +0xf0, which is stubbed per object with queued return values.
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

SET_TOGGLE = EXTENSION_BASE + 0x499b0
SET_TOGGLE_END = EXTENSION_BASE + 0x49a1c
EXEC_BODY = EXTENSION_BASE + 0x49d10
EXEC_END = EXTENSION_BASE + 0x49d56
UPDATE_STYLE = EXTENSION_BASE + 0x8380
NOTIFY = EXTENSION_BASE + 0x49910
IS_FOCUS = EXTENSION_BASE + 0x4ca20
GET_ROOT = EXTENSION_BASE + 0x4c5a0
TOGGLE_CHANGED_SLOT = 0xf0

TYPE = 0x28
FLAGS = 0x30
PARENT = 0x138
TOGGLE_FLAGS = 0x174
ACTIVE_STYLE0 = 0x184
ACTIVE_STYLE1 = 0x188
ACTIVE_STYLE2 = 0x18c
STYLE_TABLE = 0x1a4
STYLE_TABLE_END = STYLE_TABLE + 6 * 12  # six entries of three dwords
ROOT_FOCUS = 0x5c8
VTABLE = 0x00
WINDOW_SIZE = 0x800

U8_OFFSETS = {TYPE, FLAGS}
PTR_OFFSETS = {VTABLE, PARENT, ROOT_FOCUS,
               ACTIVE_STYLE0, ACTIVE_STYLE1, ACTIVE_STYLE2,
               *range(STYLE_TABLE, STYLE_TABLE_END, 4)}
TRACKED = U8_OFFSETS | PTR_OFFSETS | {TOGGLE_FLAGS}


class WindowToggleSetProbe(_NATIVE.NativeCollision):
    """Run SetToggle with the +0xf0 virtual as the sole leaf."""

    def __init__(self, root):
        # Extension.dll is deliberately rebased away from the preferred Core
        # and Engine images.  NativeCollision applies the original relocations.
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.accesses = []
        self.windows = {}
        self.labels = {}
        self.stub_by_address = {}
        self.virtual_results = []
        self.running = False
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _label(self, pointer):
        for name, address in self.labels.items():
            if pointer == address:
                return name
        return None

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        for name, base in self.windows.items():
            if base <= address < base + WINDOW_SIZE:
                offset = address - base
                if offset not in TRACKED:
                    return
                if offset in U8_OFFSETS:
                    if size != 1:
                        return
                    kind = 'u8'
                elif size != 4:
                    return
                else:
                    kind = 'ptr' if offset in PTR_OFFSETS else 'u32'
                captured = (int.from_bytes(cpu.mem_read(address, size), 'little')
                            if access == UC_MEM_READ else value)
                self.accesses.append({
                    'op': 'read' if access == UC_MEM_READ else 'write',
                    'object': name, 'offset': offset, 'kind': kind, 'size': size,
                    'bits': captured,
                    'label': self._label(captured) if kind == 'ptr' else None,
                })
                return

    def _window(self, label, flags=0, parent=0, type_byte=0, toggle=0):
        address = self.alloc(WINDOW_SIZE)
        vtable = self.alloc(0x100)
        stub = self.alloc(16)
        self.cpu.mem_write(address, b'\xaa' * WINDOW_SIZE)
        self.cpu.mem_write(vtable, b'\x00' * 0x100)
        self.cpu.mem_write(stub, b'\xc3')
        self.write(address, 'I', vtable)
        self.write(vtable + TOGGLE_CHANGED_SLOT, 'I', stub)
        self.write(address + TYPE, 'B', type_byte)
        self.write(address + FLAGS, 'I', flags)
        self.write(address + PARENT, 'I', parent)
        self.write(address + TOGGLE_FLAGS, 'I', toggle)
        self.write(address + ROOT_FOCUS, 'I', 0)
        self.windows[label] = address
        self.labels[label] = address
        self.stub_by_address[stub] = label
        return address

    def _resource(self, label):
        self.labels[label] = self.alloc(4)
        return self.labels[label]

    def on_instruction(self, cpu, address, size, data):
        if address in self.stub_by_address:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            receiver = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            source, toggle = self.read(stack + 4, '2I')
            result = self.virtual_results.pop(0) if self.virtual_results else 0
            self.events.append({
                'op': 'ToggleChanged',
                'object': self._label(receiver),
                'via': self.stub_by_address[address],
                'source': self._label(source),
                'toggle': toggle,
                'virtualSlot': TOGGLE_CHANGED_SLOT,
                'result': result,
            })
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, result)
            self._return(cpu, stack, 8)  # thiscall callee pops two stack args
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, word, nodes, focus=None, table=None, virtual_results=()):
        """nodes: [(label, flags, type, parent_label, toggle)] receiver first."""
        self.events = []
        self.accesses = []
        self.windows = {}
        self.labels = {}
        self.stub_by_address = {}
        self.virtual_results = list(virtual_results)
        # nodes are receiver-first; build outermost-first so +0x138 links resolve.
        for label, flags, type_byte, parent_label, toggle in reversed(nodes):
            self._window(label, flags,
                         self.labels.get(parent_label, 0), type_byte, toggle)
        receiver = self.windows[nodes[0][0]]
        if focus is not None:
            root = self.windows[nodes[-1][0]]
            self.write(root + ROOT_FOCUS, 'I', self.labels[focus])
        if table:
            for index, triple in enumerate(table):
                for field, resource in enumerate(triple):
                    value = self._resource(resource) if resource else 0
                    self.write(receiver + STYLE_TABLE + index * 12 + field * 4,
                               'I', value)
        self.running = True
        self.call(SET_TOGGLE, receiver, struct.pack('<I', word))
        self.running = False
        return {
            'accesses': list(self.accesses),
            'events': list(self.events),
            'state': {
                label: {
                    'toggleFlags': self.read(address + TOGGLE_FLAGS, 'I')[0],
                    'style0': self._label(self.read(address + ACTIVE_STYLE0, 'I')[0]),
                    'style1': self._label(self.read(address + ACTIVE_STYLE1, 'I')[0]),
                    'style2': self._label(self.read(address + ACTIVE_STYLE2, 'I')[0]),
                }
                for label, address in self.windows.items()
            },
        }

    def run(self):
        SENSITIVE = 0x02
        full = [[f'e{i}f{j}' for j in range(3)] for i in range(6)]
        chain = lambda mid_flags=SENSITIVE, toggle=0: [
            ('toggle', SENSITIVE, 0, 'mid', toggle),
            ('mid', mid_flags, 0, 'root', 0),
            ('root', SENSITIVE, 3, None, 0),
        ]
        cases = {}
        # Bit already set: the body returns after the single +0x174 read.
        cases['noChange'] = self.case(1, chain(toggle=1), table=full)
        # All ancestors sensitive and the receiver is the root focus: idx 3.
        cases['setOnFocused'] = self.case(
            1, chain(), focus='toggle', table=full)
        # All sensitive but another window holds root focus: idx 1.
        cases['setOnUnfocused'] = self.case(
            1, chain(), focus='mid', table=full)
        # An insensitive ancestor short-circuits the walk: state 2, idx 5.
        cases['setOnInsensitiveAncestor'] = self.case(
            1, chain(mid_flags=0), focus='toggle', table=full)
        # The receiver itself is insensitive: state 2, toggle off, idx 4.
        cases['setOffInsensitiveSelf'] = self.case(0, [
            ('toggle', 0, 0, 'root', 1),
            ('root', SENSITIVE, 3, None, 0),
        ], table=full)
        # Unfocused + toggle on with entry1.f0 null: the fallback re-reads
        # +0x1b0 and lands on entry0.f0.
        fallback_on = [row[:] for row in full]
        fallback_on[1][0] = None
        cases['fallbackOnNullField'] = self.case(
            1, chain(), focus='mid', table=fallback_on)
        # Unfocused + toggle 1->0 with entry0.f0 null: the fallback re-reads
        # the same +0x1a4 slot and stores zero.
        fallback_off = [row[:] for row in full]
        fallback_off[0][0] = None
        cases['fallbackOffNullField'] = self.case(
            0, chain(toggle=1), focus='mid', table=fallback_off)
        # Notify walk where the root's virtual returns nonzero: three
        # dispatches (toggle, mid, root) then the walk stops.
        cases['notifyStopAtRoot'] = self.case(
            1, chain(), focus='toggle', table=full,
            virtual_results=[0, 0, 1])
        # Every virtual returns zero: the walk ends on the root's null parent.
        cases['notifyWalkOff'] = self.case(
            1, chain(), focus='mid', table=full,
            virtual_results=[0, 0, 0])
        # A receiver with no parent dispatches once on itself.
        cases['notifySelfOnly'] = self.case(
            1, [('toggle', 0, 3, None, 0)], table=full,
            virtual_results=[1])
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'body': SET_TOGGLE,
                'end': SET_TOGGLE_END,
                'execBody': EXEC_BODY,
                'execEnd': EXEC_END,
                'updateToggleStyle': UPDATE_STYLE,
                'notifyToggleChanged': NOTIFY,
                'isFocusWindow': IS_FOCUS,
                'getRootWindow': GET_ROOT,
                'toggleChangedSlot': TOGGLE_CHANGED_SLOT,
            },
            'cases': cases,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-toggle-set-oracle.py GAME_ROOT')
    print(json.dumps(WindowToggleSetProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
