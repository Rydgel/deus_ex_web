"""Run the recovered Extension.Window.Destroy path in the x86 oracle.

Only the hash-checked Extension.dll is executed.  Core allocation, GC object
destruction, subclass cleanup, and the final UObject release are intercepted
as explicit leaves; the XWindow Destroy/SafeDestroy/PreDestroy/KillAllChildren
and CleanUp bodies execute unchanged.  The probe is a focused research tool,
not a browser runtime dependency.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

EXEC_DESTROY = EXTENSION_BASE + 0x51830
SAFE_DESTROY = EXTENSION_BASE + 0x4c0b0
PRE_DESTROY = EXTENSION_BASE + 0x50500
KILL_ALL_CHILDREN = EXTENSION_BASE + 0x505d0
CLEAN_UP = EXTENSION_BASE + 0x4bec0
XWINDOW_DESTRUCTOR = EXTENSION_BASE + 0x30b0
DELETING_DESTRUCTOR = EXTENSION_BASE + 0x4860
SET_VISIBILITY = EXTENSION_BASE + 0x4c7d0
SET_SELECTABILITY = EXTENSION_BASE + 0x4c390
PROCESS_SCRIPT = EXTENSION_BASE + 0x4ded0
REMOVE_CHILD = EXTENSION_BASE + 0x50a00
DESTROY_NAME = EXTENSION_BASE + 0x9b348
GMALLOC_IAT = EXTENSION_BASE + 0x59060
DELETE_UOBJECT_IAT = EXTENSION_BASE + 0x5908c

XWINDOW_VTABLE_SLOT = 0x58
CHILD_REMOVED_SLOT = 0x6c
DESCENDANT_REMOVED_SLOT = 0x74
DELETE_SLOT = 0x0c

OFF_TYPE = 0x28
OFF_FLAGS = 0x30
OFF_LOCK = 0x34
OFF_GC_A = 0x128
OFF_GC_B = 0x12c
OFF_CONTEXT_A = 0x130
OFF_CONTEXT_B = 0x134
OFF_PARENT = 0x138
OFF_FIRST = 0x13c
OFF_LAST = 0x140
OFF_PREVIOUS = 0x144
OFF_NEXT = 0x148
OFF_FOCUS = 0x5a0
OFF_GRAB = 0x5c4
OFF_NODE_NEXT = 0x1c
OFF_FRAME_GUARD = 0x0c

VISIBLE_CHAIN = 0x01
BEING_DESTROYED = 0x10


class WindowDestroyProbe(_NATIVE.NativeCollision):
    """Execute normal bounded trees with synchronous native leaves."""

    def __init__(self, root):
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.writes = []
        self.case_name = None
        self.objects = set()
        self.vtable = self.alloc(0x100)
        self.child_removed_stub = self.alloc(16)
        self.descendant_removed_stub = self.alloc(16)
        self.context_dtor_stub = self.alloc(16)
        self.context_vtable = self.alloc(16)
        self.gc_allocator_vtable = self.alloc(32)
        self.gc_allocator = self.alloc(16)
        self.gc_free_stub = self.alloc(16)
        self.cpu.mem_write(self.child_removed_stub, b'\xc3')
        self.cpu.mem_write(self.descendant_removed_stub, b'\xc3')
        self.cpu.mem_write(self.context_dtor_stub, b'\xc3')
        self.cpu.mem_write(self.gc_free_stub, b'\xc3')
        self.write(self.context_vtable + DELETE_SLOT, 'I', self.context_dtor_stub)
        self.cpu.mem_write(self.gc_allocator_vtable, b'\0' * 32)
        self.write(self.gc_allocator_vtable + 8, 'I', self.gc_free_stub)
        self.write(self.gc_allocator, 'I', self.gc_allocator_vtable)

        # The Extension data import points at Core's GMalloc pointer.  Keep
        # that one level of indirection: CleanUp loads [Extension IAT], then
        # [Core GMalloc], then dispatches the allocator virtual slot.
        self.gmalloc_global = self.read(GMALLOC_IAT, 'I')[0]
        self.write(self.gmalloc_global, 'I', self.gc_allocator)
        self.delete_stub = self.alloc(16)
        # The scalar deleting destructor is executed from the real body.  Its
        # complete XWindow destructor is a subclass/base leaf in this probe.
        self.write(self.vtable + DELETE_SLOT, 'I', DELETING_DESTRUCTOR)
        self.write(self.vtable + XWINDOW_VTABLE_SLOT, 'I', CLEAN_UP)
        self.write(self.vtable + CHILD_REMOVED_SLOT, 'I', self.child_removed_stub)
        self.write(self.vtable + DESCENDANT_REMOVED_SLOT, 'I', self.descendant_removed_stub)

        # Static initialisation is not run in a DLL-only emulator.  Give the
        # ProcessScript call a stable FName value so the argument is visible.
        self.write(DESTROY_NAME, 'I', 0x44535452)
        self.write(DELETE_UOBJECT_IAT, 'I', self.delete_stub)
        self.frame = None
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(UC_X86_REG_EIP, return_address)

    def on_write(self, cpu, access, address, size, value, data):
        for object_address in self.objects:
            if object_address <= address < object_address + 0x700:
                self.writes.append({
                    'object': object_address,
                    'offset': address - object_address,
                    'size': size,
                    'value': value,
                    'phase': self.case_name,
                })
                break

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if address == SAFE_DESTROY:
            self.events.append({'op': 'SafeDestroy', 'object': cpu.reg_read(UC_X86_REG_ECX)})
        elif address == PRE_DESTROY:
            self.events.append({'op': 'PreDestroy', 'object': cpu.reg_read(UC_X86_REG_ECX)})
        elif address == KILL_ALL_CHILDREN:
            self.events.append({'op': 'KillAllChildren', 'object': cpu.reg_read(UC_X86_REG_ECX)})
        elif address == CLEAN_UP:
            self.events.append({'op': 'CleanUp', 'object': cpu.reg_read(UC_X86_REG_ECX)})
        elif address == REMOVE_CHILD:
            self.events.append({'op': 'RemoveChild', 'object': cpu.reg_read(UC_X86_REG_ECX),
                                'child': self.read(stack + 4, 'I')[0]})
        elif address == SET_VISIBILITY:
            object_address = cpu.reg_read(UC_X86_REG_ECX)
            visible = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'SetVisibility', 'object': object_address, 'visible': visible})
            self._return(cpu, stack, 4)
            return
        elif address == SET_SELECTABILITY:
            object_address = cpu.reg_read(UC_X86_REG_ECX)
            selectable = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'SetSelectability', 'object': object_address,
                                'selectable': selectable})
            self._return(cpu, stack, 4)
            return
        elif address == PROCESS_SCRIPT:
            object_address = cpu.reg_read(UC_X86_REG_ECX)
            event_name, parameters, third = self.read(stack + 4, '3I')
            self.events.append({'op': 'ProcessScript', 'object': object_address,
                                'eventName': event_name, 'parameters': parameters,
                                'thirdArgument': third})
            self._return(cpu, stack, 12)
            return
        elif address == self.child_removed_stub:
            self.events.append({'op': 'ChildRemoved', 'parent': cpu.reg_read(UC_X86_REG_ECX),
                                'child': self.read(stack + 4, 'I')[0]})
            self._return(cpu, stack, 4)
            return
        elif address == self.descendant_removed_stub:
            self.events.append({'op': 'DescendantRemoved', 'ancestor': cpu.reg_read(UC_X86_REG_ECX),
                                'child': self.read(stack + 4, 'I')[0]})
            self._return(cpu, stack, 4)
            return
        elif address == self.context_dtor_stub:
            self.events.append({'op': 'DestroyGc', 'object': cpu.reg_read(UC_X86_REG_ECX),
                                'flags': self.read(stack + 4, 'I')[0]})
            self._return(cpu, stack, 4)
            return
        elif address == self.gc_free_stub:
            value = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'FreeObject' if value in self.objects else 'FreeGc',
                                'object': value})
            self._return(cpu, stack, 4)
            return
        elif address == XWINDOW_DESTRUCTOR:
            # XWindow's complete destructor, including Core conditional/base
            # calls, is deliberately a leaf of this bounded oracle.
            self.events.append({'op': 'XWindowDestructor',
                                'object': cpu.reg_read(UC_X86_REG_ECX)})
            self._return(cpu, stack)
            return
        elif address == DELETING_DESTRUCTOR:
            self.events.append({'op': 'DeletingDestructor',
                                'object': cpu.reg_read(UC_X86_REG_ECX), 'flags': self.read(stack + 4, 'I')[0]})
        elif address == self.delete_stub:
            # Scalar deleting destructor calls Core ??3UObject(this,size).
            object_address = self.read(stack + 4, 'I')[0]
            size = self.read(stack + 8, 'I')[0]
            self.events.append({'op': 'FreeObject', 'object': object_address, 'size': size})
            # ??3UObject is cdecl; the deleting-destructor body removes its
            # two pushed arguments after the call.
            self._return(cpu, stack)
            return
        return super().on_instruction(cpu, address, size, data)

    def window(self, *, flags=2, lock=0, parent=0, type_value=3):
        address = self.alloc(0x700)
        self.cpu.mem_write(address, b'\0' * 0x700)
        self.write(address, 'I', self.vtable)
        self.write(address + OFF_TYPE, 'I', type_value)
        self.write(address + OFF_FLAGS, 'I', flags)
        self.write(address + OFF_LOCK, 'i', lock)
        self.write(address + OFF_PARENT, 'I', parent)
        self.objects.add(address)
        return address

    def node(self, next_node=0):
        address = self.alloc(0x40)
        self.cpu.mem_write(address, b'\0' * 0x40)
        self.write(address + OFF_NODE_NEXT, 'I', next_node)
        return address

    def context(self):
        address = self.alloc(0x40)
        self.cpu.mem_write(address, b'\0' * 0x40)
        self.write(address, 'I', self.context_vtable)
        return address

    def link_children(self, parent, children):
        self.write(parent + OFF_FIRST, 'I', children[0] if children else 0)
        self.write(parent + OFF_LAST, 'I', children[-1] if children else 0)
        for index, child in enumerate(children):
            self.write(child + OFF_PARENT, 'I', parent)
            self.write(child + OFF_PREVIOUS, 'I', children[index - 1] if index else 0)
            self.write(child + OFF_NEXT, 'I', children[index + 1] if index + 1 < len(children) else 0)

    def execute(self, name, root, *, frame_guard=0):
        self.case_name = name
        self.events = []
        self.writes = []
        self.frame = self.alloc(0x20)
        self.cpu.mem_write(self.frame, b'\0' * 0x20)
        self.write(self.frame + OFF_FRAME_GUARD, 'I', frame_guard)
        result = self.call(EXEC_DESTROY, root, struct.pack('<I', self.frame))
        return {
            'result': result,
            'resultIsTrue': bool(result),
            'events': list(self.events),
            'writes': list(self.writes),
            'state': {
                'flags': self.read(root + OFF_FLAGS, 'I')[0],
                'lockCount': self.read(root + OFF_LOCK, 'i')[0],
                'parent': self.read(root + OFF_PARENT, 'I')[0],
                'firstChild': self.read(root + OFF_FIRST, 'I')[0],
                'lastChild': self.read(root + OFF_LAST, 'I')[0],
                'gcListA': self.read(root + OFF_GC_A, 'I')[0],
                'gcListB': self.read(root + OFF_GC_B, 'I')[0],
                'gcContextA': self.read(root + OFF_CONTEXT_A, 'I')[0],
                'gcContextB': self.read(root + OFF_CONTEXT_B, 'I')[0],
                'rootFocus': self.read(root + OFF_FOCUS, 'I')[0],
                'rootGrab': self.read(root + OFF_GRAB, 'I')[0],
                'frameGuard': self.read(self.frame + OFF_FRAME_GUARD, 'I')[0],
            },
        }

    def run(self):
        cases = {}
        cases['normal'] = self.execute('normal', self.window())
        cases['visible'] = self.execute('visible', self.window(flags=1))
        cases['locked'] = self.execute('locked', self.window(lock=1))
        cases['preflag'] = self.execute('preflag', self.window(flags=2 | BEING_DESTROYED))

        root = self.window()
        children = [self.window(type_value=0), self.window(type_value=0)]
        self.link_children(root, children)
        cases['children'] = self.execute('children', root)

        root = self.window()
        node_b = self.node()
        node_a = self.node(node_b)
        node_c = self.node()
        self.write(root + OFF_GC_A, 'I', node_a)
        self.write(root + OFF_GC_B, 'I', node_c)
        context_a = self.context()
        context_b = self.context()
        self.write(root + OFF_CONTEXT_A, 'I', context_a)
        self.write(root + OFF_CONTEXT_B, 'I', context_b)
        self.write(root + OFF_FOCUS, 'I', root)
        self.write(root + OFF_GRAB, 'I', root)
        cases['gc'] = self.execute('gc', root)

        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'execDestroy': EXEC_DESTROY,
                'safeDestroy': SAFE_DESTROY,
                'preDestroy': PRE_DESTROY,
                'killAllChildren': KILL_ALL_CHILDREN,
                'cleanUp': CLEAN_UP,
                'xwindowDestructor': XWINDOW_DESTRUCTOR,
                'deletingDestructor': DELETING_DESTRUCTOR,
                'setVisibility': SET_VISIBILITY,
                'setSelectability': SET_SELECTABILITY,
                'processScript': PROCESS_SCRIPT,
                'removeChild': REMOVE_CHILD,
                'extensionDestroyWindowName': DESTROY_NAME,
                'gMallocIat': GMALLOC_IAT,
                'childRemovedSlot': CHILD_REMOVED_SLOT,
                'descendantRemovedSlot': DESCENDANT_REMOVED_SLOT,
                'cleanUpSlot': XWINDOW_VTABLE_SLOT,
                'deletingDestructorSlot': DELETE_SLOT,
                'beingDestroyedBit': BEING_DESTROYED,
                'visibleChainBit': VISIBLE_CHAIN,
            },
            'cases': cases,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-destroy-oracle.py GAME_ROOT')
    print(json.dumps(WindowDestroyProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
