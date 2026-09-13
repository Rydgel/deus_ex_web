"""Run the unchanged Extension.dll XWindow visibility bodies on x86.

Only the two recovered normal bodies execute in this probe.  Focus/grab,
tree, event, reconfigure, accelerator, and parent callback bodies are
intercepted as explicit synchronous leaves.  The probe is deliberately small:
it records raw window/global accesses and leaf order for three visibility
transitions rather than attempting a broad UI corpus.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
REBASE = EXTENSION_BASE - 0x10000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

SET_VISIBILITY = EXTENSION_BASE + 0x4c7d0
SET_VISIBILITY_END = EXTENSION_BASE + 0x4c85e
SET_CHILD_VISIBILITY = EXTENSION_BASE + 0x4ee20
SET_CHILD_VISIBILITY_END = EXTENSION_BASE + 0x4eef6
CURRENT_WINDOW_GLOBAL = EXTENSION_BASE + 0xaeafc

CHECK_FOCUS_WINDOW = EXTENSION_BASE + 0x50b80
CHECK_GRABBED_WINDOW = EXTENSION_BASE + 0x50c90
RECOMPUTE_INIT_TREE = EXTENSION_BASE + 0x50d70
INVOKE_VISIBILITY_CHANGE = EXTENSION_BASE + 0x50e30
RECONFIGURE_TREE = EXTENSION_BASE + 0x4e520
MAKE_ACCELERATOR_TABLE_DIRTY = EXTENSION_BASE + 0x4c1d0
CHILD_REQUESTED_VISIBILITY_CHANGE = EXTENSION_BASE + 0x3540
CHILD_REQUESTED_VISIBILITY_CHANGE_SLOT = 0x84

WINDOW_FLAGS = 0x30
RECONFIGURE_FLAGS = 0xb8
PARENT = 0x138


class WindowVisibilityProbe(_NATIVE.NativeCollision):
    """Execute SetVisibility/SetChildVisibility with leaf interception."""

    def __init__(self, root):
        self.root = Path(root)
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.accesses = []
        self.case_name = None
        self.objects = {}
        self.vtables = {}
        self.global_value = 0
        self.vtable = self.alloc(0x100)
        self.native_leaves = {
            CHECK_FOCUS_WINDOW: ('CheckFocusWindow', 0),
            CHECK_GRABBED_WINDOW: ('CheckGrabbedWindow', 0),
            RECOMPUTE_INIT_TREE: ('RecomputeInitTree', 4),
            INVOKE_VISIBILITY_CHANGE: ('InvokeVisibilityChange', 4),
            RECONFIGURE_TREE: ('ReconfigureTree', 4),
            MAKE_ACCELERATOR_TABLE_DIRTY: ('MakeAcceleratorTableDirty', 0),
        }
        self.leaf_stubs = {}
        self.parent_stub = self.alloc(16)
        leaf_specs = list(self.native_leaves.values())
        for name, argument_bytes in leaf_specs:
            address = self.alloc(16)
            self.cpu.mem_write(address, b'\xc3')
            self.leaf_stubs[address] = (name, argument_bytes, address)
        self.cpu.mem_write(self.parent_stub, b'\xc3')
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_memory)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _pointer_name(self, value):
        if not value:
            return None
        for name, pointer in self.objects.items():
            if value == pointer:
                return name
        return None

    def _record_memory(self, op, address, size, value):
        if address == CURRENT_WINDOW_GLOBAL:
            self.accesses.append({
                'op': op, 'region': 'global', 'address': address,
                'size': size, 'value': value,
            })
            return
        for name, pointer in self.objects.items():
            if pointer <= address < pointer + 0x200:
                self.accesses.append({
                    'op': op, 'region': 'object', 'object': name,
                    'offset': address - pointer, 'size': size, 'value': value,
                })
                return
        if self.vtable <= address < self.vtable + 0x100:
            self.accesses.append({
                'op': op, 'region': 'vtable', 'offset': address - self.vtable,
                'size': size, 'value': value,
            })

    def on_memory(self, cpu, access, address, size, value, data):
        op = 'write' if access == UC_MEM_WRITE else 'read'
        actual = value if op == 'write' else int.from_bytes(cpu.mem_read(address, size), 'little')
        self._record_memory(op, address, size, actual)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        leaf = self.native_leaves.get(address)
        if leaf:
            name, argument_bytes = leaf
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            event = {
                'op': name,
                'object': self._pointer_name(receiver) or receiver,
                'native': address,
            }
            if argument_bytes:
                raw = self.read(stack + 4, 'I')[0]
                event['rawArgument'] = raw
                event['effectiveVisibility'] = bool(raw)
                if name == 'ReconfigureTree':
                    event['rawArgument'] = raw
            self.events.append(event)
            self._return(cpu, stack, argument_bytes)
            return
        if address == self.parent_stub:
            parent = cpu.reg_read(UC_X86_REG_ECX)
            child, visibility = self.read(stack + 4, '2I')
            self.events.append({
                'op': 'ChildRequestedVisibilityChange',
                'parent': self._pointer_name(parent) or parent,
                'child': self._pointer_name(child) or child,
                'rawVisibility': visibility,
                'newVisibility': bool(visibility & 1),
                'virtualSlot': CHILD_REQUESTED_VISIBILITY_CHANGE_SLOT,
                'native': CHILD_REQUESTED_VISIBILITY_CHANGE,
            })
            self._return(cpu, stack, 8)
            return
        return super().on_instruction(cpu, address, size, data)

    def _object(self, name, flags, parent=None, reconfigure=0):
        pointer = self.alloc(0x200)
        self.cpu.mem_write(pointer, b'\xaa' * 0x200)
        self.write(pointer, 'I', self.vtable)
        self.write(pointer + WINDOW_FLAGS, 'I', flags)
        self.write(pointer + RECONFIGURE_FLAGS, 'I', reconfigure)
        self.write(pointer + PARENT, 'I', parent or 0)
        self.objects[name] = pointer
        return pointer

    def _prepare(self, name, objects, global_value):
        self.case_name = name
        self.events = []
        self.accesses = []
        self.objects = {}
        self._object('saved', 0, None)
        for spec in objects:
            parent = spec.get('parent')
            if isinstance(parent, str):
                parent = self.objects[parent]
            self._object(spec['name'], spec['flags'], parent, spec.get('reconfigure', 0))
        if global_value is None:
            global_value = self.objects['saved']
        self.global_value = global_value
        self.write(CURRENT_WINDOW_GLOBAL, 'I', global_value or 0)
        self.write(self.vtable + CHILD_REQUESTED_VISIBILITY_CHANGE_SLOT, 'I', self.parent_stub)
        # Setup writes above are not part of the function trace.
        self.accesses = []

    def _state(self):
        state = {}
        for name, pointer in self.objects.items():
            state[name] = {
                'flags': self.read(pointer + WINDOW_FLAGS, 'I')[0],
                'reconfigureFlags': self.read(pointer + RECONFIGURE_FLAGS, 'I')[0],
                'parent': self._pointer_name(self.read(pointer + PARENT, 'I')[0]),
            }
        return state

    def _case_result(self, target, argument, entry=SET_VISIBILITY):
        self.call(entry, self.objects[target], struct.pack('<I', argument))
        accesses = list(self.accesses)
        state = self._state()
        global_value = self._pointer_name(self.read(CURRENT_WINDOW_GLOBAL, 'I')[0])
        self.accesses = accesses
        return {
            'events': list(self.events),
            'accesses': accesses,
            'state': state,
            'global': global_value,
        }

    def run(self):
        self._prepare('rootTransition', [
            {'name': 'target', 'flags': 0xa5a5a5a0, 'reconfigure': 0x55667700},
        ], None)
        root_transition = self._case_result('target', 1)

        self._prepare('blockedAncestor', [
            {'name': 'ancestor', 'flags': 0x2468ace0},
            {'name': 'target', 'flags': 0x13579be1, 'parent': 'ancestor',
             'reconfigure': 0x11223340},
        ], None)
        blocked_ancestor = self._case_result('target', 0, SET_CHILD_VISIBILITY)

        self._prepare('parentTransition', [
            {'name': 'parent', 'flags': 0x2468ace1},
            {'name': 'target', 'flags': 0x13579be0, 'parent': 'parent',
             'reconfigure': 0x77889900},
        ], None)
        parent_transition = self._case_result('target', 1)

        extension_path = self.root / 'System' / 'Extension.dll'
        body_hashes = {}
        if extension_path and extension_path.exists():
            data = extension_path.read_bytes()
            # The image sections are aligned in this build, so RVA == file
            # offset for both normal bodies.  Validate through Image.offset
            # when reporting hashes to keep that assumption explicit.
            image = _NATIVE.Image(extension_path, EXTENSION_HASH)
            for name, start, end in (
                ('setVisibility', SET_VISIBILITY - EXTENSION_BASE,
                 SET_VISIBILITY_END - EXTENSION_BASE),
                ('setChildVisibility', SET_CHILD_VISIBILITY - EXTENSION_BASE,
                 SET_CHILD_VISIBILITY_END - EXTENSION_BASE),
            ):
                body = image.data[image.offset(start):image.offset(end)]
                body_hashes[name] = hashlib.sha256(body).hexdigest()
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'setVisibility': SET_VISIBILITY,
                'setVisibilityEnd': SET_VISIBILITY_END,
                'setChildVisibility': SET_CHILD_VISIBILITY,
                'setChildVisibilityEnd': SET_CHILD_VISIBILITY_END,
                'currentWindowGlobal': CURRENT_WINDOW_GLOBAL,
                'childRequestedVisibilityChange': CHILD_REQUESTED_VISIBILITY_CHANGE,
                'childRequestedVisibilityChangeSlot': CHILD_REQUESTED_VISIBILITY_CHANGE_SLOT,
                'checkFocusWindow': CHECK_FOCUS_WINDOW,
                'checkGrabbedWindow': CHECK_GRABBED_WINDOW,
                'recomputeInitTree': RECOMPUTE_INIT_TREE,
                'invokeVisibilityChange': INVOKE_VISIBILITY_CHANGE,
                'reconfigureTree': RECONFIGURE_TREE,
                'makeAcceleratorTableDirty': MAKE_ACCELERATOR_TABLE_DIRTY,
            },
            'bodySha256': body_hashes,
            'cases': {
                'rootTransition': root_transition,
                'blockedAncestor': blocked_ancestor,
                'parentTransition': parent_transition,
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-visibility-oracle.py GAME_ROOT')
    probe = WindowVisibilityProbe(Path(sys.argv[1]))
    print(json.dumps(probe.run()))


if __name__ == '__main__':
    main()
