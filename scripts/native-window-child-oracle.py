"""Execute Extension.dll's XWindow::CreateNewWindow body unchanged.

The original helper is run in the x86 oracle.  Core construction, the
class-selected Init vtable, ProcessScript/InitWindow, visibility,
reconfiguration, FName, and SafeDestroy are explicit boundary leaves.  The
probe does not claim to emulate Core's UObject registry or XWindow::Init.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_MEM_WRITE


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
REBASE = EXTENSION_BASE - 0x10000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

CREATE_NEW_WINDOW = EXTENSION_BASE + 0x4df70
FNAME_NONE_IAT = EXTENSION_BASE + 0x59124
STATIC_CONSTRUCT_IAT = EXTENSION_BASE + 0x59150
GERROR_IAT = EXTENSION_BASE + 0x59070
PROCESS_SCRIPT = EXTENSION_BASE + 0x4ded0
SET_VISIBILITY = EXTENSION_BASE + 0x4c7d0
ASK_RECONFIGURE = EXTENSION_BASE + 0x4e060
SAFE_DESTROY = EXTENSION_BASE + 0x4c0b0
INIT_NAME = EXTENSION_BASE + 0x9b3a4
INIT_SLOT = 0x54
BEING_DESTROYED = 0x10


class WindowChildProbe(_NATIVE.NativeCollision):
    """Run CreateNewWindow with explicit synchronous leaves."""

    def __init__(self, root):
        # Extension.dll is deliberately rebased away from the preferred Core
        # and Engine images.  Do not map another package at this base.
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.writes = []
        self.case_name = None
        self.child = None
        self.vtable = self.alloc(0x100)
        self.fname_stub = self.alloc(16)
        self.static_stub = self.alloc(16)
        self.init_stub = self.alloc(16)
        self.process_stub = self.alloc(16)
        self.visibility_stub = self.alloc(16)
        self.reconfigure_stub = self.alloc(16)
        self.safe_destroy_stub = self.alloc(16)
        for address in (self.fname_stub, self.static_stub, self.init_stub,
                        self.process_stub, self.visibility_stub,
                        self.reconfigure_stub, self.safe_destroy_stub):
            self.cpu.mem_write(address, b'\xc3')

        self.original_imports = {
            'fNameNone': self.read(FNAME_NONE_IAT, 'I')[0],
            'staticConstructObject': self.read(STATIC_CONSTRUCT_IAT, 'I')[0],
            'gError': self.read(GERROR_IAT, 'I')[0],
        }
        self.write(FNAME_NONE_IAT, 'I', self.fname_stub)
        self.write(STATIC_CONSTRUCT_IAT, 'I', self.static_stub)

        # CreateNewWindow reads [GError IAT] and then dereferences that slot
        # before passing the resulting FOutputDevice pointer to Core.
        self.error_slot = self.alloc(4)
        self.error_device = 0x45454545
        self.write(self.error_slot, 'I', self.error_device)
        self.write(GERROR_IAT, 'I', self.error_slot)
        self.write(INIT_NAME, 'I', 0x494e4954)  # diagnostic FName value
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(_NATIVE.UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def on_write(self, cpu, access, address, size, value, data):
        if self.child is None or not (self.child <= address < self.child + 0x200):
            return
        self.writes.append({
            'offset': address - self.child,
            'size': size,
            'value': value,
            'phase': self.case_name,
        })

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        if address == self.fname_stub:
            target = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            enum_value = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'FName', 'this': target,
                                'enum': enum_value, 'value': 0})
            self.write(target, 'I', 0)
            self._return(cpu, stack, 4)  # FName::FName(EName) __thiscall
            return
        if address == self.static_stub:
            args = self.read(stack + 4, '6I')
            class_object, outer, name, flags, template, error = args
            self.events.append({
                'op': 'StaticConstructObject',
                'class': class_object,
                'outer': outer,
                'name': name,
                'flags': flags,
                'template': template,
                'error': error,
            })
            if self.case_name == 'nullClass':
                raise RuntimeError('StaticConstructObject reached null-class case')
            child = self.alloc(0x200)
            self.child = child
            self.cpu.mem_write(child, b'\xaa' * 0x200)
            self.write(child, 'I', self.vtable)
            self.write(child + 0x30, 'I', 0)
            self.write(child + 0x34, 'I', 0)
            self.write(self.vtable + INIT_SLOT, 'I', self.init_stub)
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, child)
            self._return(cpu, stack)
            return
        if address == self.init_stub:
            child = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            parent = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'InitVtable', 'object': child,
                                'parent': parent, 'slot': INIT_SLOT})
            self._return(cpu, stack, 4)
            return
        if address == PROCESS_SCRIPT:
            child = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            event_name, params, third = self.read(stack + 4, '3I')
            self.events.append({'op': 'ProcessScript', 'object': child,
                                'eventName': event_name, 'parameters': params,
                                'thirdArgument': third})
            if self.case_name == 'deletionDuringInitWindow':
                current = self.read(child + 0x30, 'I')[0]
                self.write(child + 0x30, 'I', current | BEING_DESTROYED)
                self.events.append({'op': 'InitWindowSetBeingDestroyed',
                                    'object': child, 'bit': BEING_DESTROYED})
            self._return(cpu, stack, 12)  # ProcessScript(FName,void*,int)
            return
        if address == SET_VISIBILITY:
            child = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            visible = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'SetVisibility', 'object': child,
                                'visible': visible})
            self._return(cpu, stack, 4)
            return
        if address == ASK_RECONFIGURE:
            child = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({'op': 'AskParentForReconfigure', 'object': child})
            self._return(cpu, stack)
            return
        if address == SAFE_DESTROY:
            child = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            self.events.append({'op': 'SafeDestroy', 'object': child})
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, 1)
            self._return(cpu, stack)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, name, class_object, parent, show=True):
        self.case_name = name
        self.events = []
        self.writes = []
        self.child = None
        # CreateNewWindow's null guard is before the first service call.
        result = self.call(CREATE_NEW_WINDOW, 0, struct.pack(
            '<3I', class_object, parent, int(show)))
        child = self.child
        state = None if child is None else {
            'flags': self.read(child + 0x30, 'I')[0],
            'lockCount': self.read(child + 0x34, 'i')[0],
        }
        return {
            'result': result,
            'resultIsChild': child is not None and result == child,
            'child': child,
            'state': state,
            'events': list(self.events),
            'writes': list(self.writes),
        }

    def run(self):
        class_object = self.alloc(0x40)
        parent = self.alloc(0x200)
        cases = {
            'nullClass': self.case('nullClass', 0, parent),
            'normal': self.case('normal', class_object, parent),
            'deletionDuringInitWindow': self.case(
                'deletionDuringInitWindow', class_object, parent),
        }
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'addresses': {
                'createNewWindow': CREATE_NEW_WINDOW,
                'fNameNoneIat': FNAME_NONE_IAT,
                'staticConstructObjectIat': STATIC_CONSTRUCT_IAT,
                'gErrorIat': GERROR_IAT,
                'processScript': PROCESS_SCRIPT,
                'setVisibility': SET_VISIBILITY,
                'askParentForReconfigure': ASK_RECONFIGURE,
                'safeDestroy': SAFE_DESTROY,
                'extensionInitWindowName': INIT_NAME,
                'initVtableSlot': INIT_SLOT,
                'beingDestroyedBit': BEING_DESTROYED,
            },
            'originalImports': self.original_imports,
            'cases': cases,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-child-oracle.py GAME_ROOT')
    print(json.dumps(WindowChildProbe(Path(sys.argv[1])).run()))


if __name__ == '__main__':
    main()
