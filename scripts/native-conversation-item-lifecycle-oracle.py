"""Execute the original ConSys ConListItem constructor and scalar release.

This is a bounded native evidence probe for the installed GOTY binaries.  The
ConSys constructor and deleting wrapper execute unchanged in the x86 emulator.
Only Core lifecycle calls that need a live UObject process are serviced at
their verified import boundaries: ConditionalDestroy, UObject::~UObject,
UObject::operator delete, and the UObject.Destroy target reached by the
ConObject/ConListItem vtable thunk.  The callbacks record their arguments and
return without claiming Core's process-global registry or allocator state.
"""
import importlib.util
import json
from pathlib import Path
import sys

from unicorn import UC_HOOK_MEM_WRITE


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


CONSYS_HASH = 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa'
CONSYS = {'ConSys.dll': CONSYS_HASH}

CONSTRUCTOR = 0x1000ecc0
DELETING_WRAPPER = 0x10002ed0
CONLISTITEM_VTABLE = 0x1001346c
CONOBJECT_VTABLE = 0x100131c4
CORE_VTABLE = 0x10179dfc
DESTROY_THUNK = 0x100110c2

IAT = {
    'destroy': 0x10013054,
    'uobjectDestructor': 0x10013078,
    'conditionalDestroy': 0x1001307c,
    'uobjectConstructor': 0x10013080,
    'operatorDelete': 0x1001308c,
}

# The Core export is a small import thunk; its direct target is the body that
# writes the base vtable.  Recording both addresses proves the call crossed
# the original IAT and entered the recovered implementation.
CORE_UOBJECT_CONSTRUCTOR_THUNK = 0x101021c6
CORE_UOBJECT_CONSTRUCTOR_BODY = 0x1014f340


class ConversationItemProbe(_NATIVE.NativeCollision):
    """Run the original ConListItem bodies with explicit Core boundaries."""

    HOOKS = {
        'conditionalDestroy': 0x700f0000,
        'uobjectDestructor': 0x700f0010,
        'operatorDelete': 0x700f0020,
        'destroy': 0x700f0030,
    }

    def __init__(self, root):
        super().__init__(Path(root), CONSYS)
        self.events = []
        self.writes = []
        self.object = None
        self.phase = None
        self.reached = []
        self.destroy_target = self.read(IAT['destroy'], 'I')[0]
        self.import_targets = {name: self.read(address, 'I')[0]
                               for name, address in IAT.items()}

        # The imported Core methods are explicit synchronous boundaries.  The
        # original ConSys instructions still perform all calls and stack
        # cleanup; these callbacks only return at the correct convention.
        for name, address in IAT.items():
            hook_name = 'destroy' if name == 'destroy' else name
            if hook_name in self.HOOKS:
                self.write(address, 'I', self.HOOKS[hook_name])
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    def on_write(self, cpu, access, address, size, value, data):
        if self.object is None or not (self.object <= address < self.object + 0x30):
            return
        self.writes.append({
            'offset': address - self.object,
            'size': size,
            'value': value,
            'phase': self.phase,
        })

    @staticmethod
    def _return(cpu, stack, stack_delta=4):
        """Return from a serviced boundary, preserving caller cleanup.

        ConditionalDestroy, UObject::~UObject, and Destroy are __thiscall
        calls whose callee consumes only the return address.  operator delete
        is cdecl; the wrapper performs its own ``add esp,8``, so this callback
        also consumes only the return address.
        """
        return_address = cpu.mem_read(stack, 4)
        return_address = int.from_bytes(return_address, 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + stack_delta)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def on_instruction(self, cpu, address, size, data):
        # These addresses are code hooks rather than guessed machine-code
        # replacements.  Returning here leaves the original caller and its
        # stack convention in control.
        if address == CORE_UOBJECT_CONSTRUCTOR_THUNK:
            self.reached.append(address)
        elif address == CORE_UOBJECT_CONSTRUCTOR_BODY:
            self.reached.append(address)

        if address == self.HOOKS['conditionalDestroy']:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            object_pointer = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            table = self.read(object_pointer, 'I')[0]
            slot = self.read(table + 0x24, 'I')[0]
            self.events.append({
                'op': 'ConditionalDestroy',
                'object': 'item',
                'vtable': table,
                'destroySlot': slot,
                'destroyIat': self.destroy_target,
            })
            # The native service is intentionally a boundary stub.  It does
            # not emulate Core's global flags or virtual Destroy side effects.
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, 1)
            self._return(cpu, stack)
            return

        if address == self.HOOKS['uobjectDestructor']:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            object_pointer = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({
                'op': 'UObjectDestructor',
                'object': 'item',
                'vtableBefore': self.read(object_pointer, 'I')[0],
            })
            # This is the first observable write in the recovered Core body.
            # It is included so the wrapper's final state matches the native
            # base-destructor boundary without running registry-dependent code.
            self.cpu.mem_write(object_pointer, CORE_VTABLE.to_bytes(4, 'little'))
            self._return(cpu, stack)
            return

        if address == self.HOOKS['operatorDelete']:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            object_pointer = self.read(stack + 4, 'I')[0]
            size_value = self.read(stack + 8, 'I')[0]
            self.events.append({
                'op': 'operatorDelete',
                'object': 'item',
                'size': size_value,
            })
            # cdecl caller cleanup follows the call, so pop only the return
            # address here.  The wrapper's add esp,8 consumes object and size.
            self._return(cpu, stack)
            return

        if address == self.HOOKS['destroy']:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            object_pointer = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({
                'op': 'UObjectDestroy',
                'object': 'item',
                'vtable': self.read(object_pointer, 'I')[0],
            })
            self._return(cpu, stack)
            return

        return super().on_instruction(cpu, address, size, data)

    def new_item(self):
        """Seed a 0x30-byte object with sentinels before native construction."""
        item = self.alloc(0x30)
        self.object = item
        self.cpu.mem_write(item, b'\xaa' * 0x30)
        # +0x1c is ObjectFlags.  It must survive the constructor untouched.
        self.write(item + 0x1c, 'I', 0x55555555)
        self.write(item + 0x28, 'I', 0x11111111)
        self.write(item + 0x2c, 'I', 0x22222222)
        return item

    def run_case(self, flags):
        item = self.new_item()
        self.phase = 'constructor'
        self.writes = []
        self.reached = []
        self.call(CONSTRUCTOR, item, b'')
        constructor = {
            'vtable': self.read(item, 'I')[0],
            'con': self.read(item + 0x28, 'I')[0],
            'next': self.read(item + 0x2c, 'I')[0],
            'objectFlags': self.read(item + 0x1c, 'I')[0],
            'writes': list(self.writes),
            'coreConstructorIat': self.import_targets['uobjectConstructor'],
            'coreConstructorTrace': list(self.reached),
        }

        # Call the vtable thunk once through its patched IAT.  The destructor
        # callbacks below record the same static slot without pretending that
        # ConditionalDestroy itself ran Core's process-global Destroy path.
        self.phase = 'destroyThunk'
        self.events = []
        self.call(DESTROY_THUNK, item, b'')
        destroy_thunk = {
            'thunk': DESTROY_THUNK,
            'iat': IAT['destroy'],
            'originalTarget': self.destroy_target,
            'call': list(self.events),
        }

        self.phase = 'release'
        self.events = []
        self.writes = []
        result = self.call(DELETING_WRAPPER, item, flags.to_bytes(4, 'little'))
        release = {
            'flags': flags,
            'returnIsObject': result == item,
            'events': list(self.events),
            'writes': list(self.writes),
            'finalVtable': self.read(item, 'I')[0],
        }
        return {'constructor': constructor, 'destroyThunk': destroy_thunk,
                'release': release}

    def run(self):
        # Verify the static vtable layout from the mapped ConSys image.  The
        # deleting slot is part of the evidence even though the direct call is
        # made to its recovered body address.
        static = {
            'conListItemVtable': CONLISTITEM_VTABLE,
            'conObjectVtable': CONOBJECT_VTABLE,
            'conListItemDeletingSlot': self.read(CONLISTITEM_VTABLE + 0x0c, 'I')[0],
            'conListItemDestroySlot': self.read(CONLISTITEM_VTABLE + 0x24, 'I')[0],
            'conObjectDestroySlot': self.read(CONOBJECT_VTABLE + 0x24, 'I')[0],
            'destroyThunkTarget': self.destroy_target,
        }
        return {
            'hashes': {'ConSys.dll': CONSYS_HASH, **_NATIVE.HASHES},
            'addresses': {
                'constructor': CONSTRUCTOR,
                'deletingWrapper': DELETING_WRAPPER,
                'conListItemDestructor': 0x10002df0,
                'conListItemVtable': CONLISTITEM_VTABLE,
                'conObjectVtable': CONOBJECT_VTABLE,
                'coreVtable': CORE_VTABLE,
                'destroyThunk': DESTROY_THUNK,
                'imports': IAT,
            },
            'imports': self.import_targets,
            'staticVtables': static,
            'cases': {
                'flags0': self.run_case(0),
                'flags1': self.run_case(1),
            },
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-conversation-item-lifecycle-oracle.py GAME_ROOT')
    print(json.dumps(ConversationItemProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
