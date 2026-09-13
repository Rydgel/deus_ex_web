"""Unchanged Extension ProcessScript + Core FindFunction[Checked] bodies.

Initialized class/function hash fixtures and a ProcessEvent leaf isolate the
new lookup-to-event boundary. No replacement code is patched into DLL bodies.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('window_child', Path(__file__).with_name('native-window-child-oracle.py'))
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)
n = child._NATIVE


class Probe(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), child.EXTENSION)
        self.events = []
        self.object = self.alloc(0x200)
        self.cls = self.alloc(0x500)
        self.function = self.alloc(0x100)
        self.vtable = self.alloc(0x100)
        self.event_stub = self.alloc(16)
        self.write(self.object, 'I', self.vtable)
        self.write(self.object + 0x24, 'I', self.cls)
        self.write(self.vtable + 0x10, 'I', self.event_stub)
        self.write(self.function + 0x24, 'I', 0x101f1718)  # UFunction class
        self.name = 73  # initialized FName fixture, not a live name-table index
        self.write(self.function + 0x20, 'I', self.name)
        literal = bytes(self.cpu.mem_read(child.EXTENSION_BASE + 0x98388, 22)).decode('utf-16-le')
        if literal != 'InitWindow\0':
            raise RuntimeError('Original InitWindow spelling changed')

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(n.UC_X86_REG_ESP)
        if address == 0x10150bf0:
            self.events.append({'op': 'isScriptable', 'value': bool(self.read(0x101e5540, 'I')[0])})
        if address == 0x10150b50:
            event, global_lookup = self.read(stack + 4, '2I')
            self.events.append({'op': 'findFunction', 'object': cpu.reg_read(n.UC_X86_REG_ECX),
                                'event': event, 'global': bool(global_lookup)})
        if address == self.event_stub:
            function, parameters, result = self.read(stack + 4, '3I')
            self.events.append({'op': 'processEvent', 'object': cpu.reg_read(n.UC_X86_REG_ECX),
                                'record': function, 'parameters': parameters, 'result': result, 'virtualSlot': 0x10})
            child.WindowChildProbe._return(cpu, stack, 12)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, checked, found=True, scriptable=True):
        self.write(self.cls + 0x84 + (self.name & 255) * 4, 'I', self.function if found else 0)
        self.write(0x101e5540, 'I', int(scriptable))
        self.events = []
        self.call(child.PROCESS_SCRIPT, self.object, struct.pack('<3I', self.name, 0, checked))
        return {'events': self.events, 'object': self.object, 'function': self.function, 'name': self.name}


if __name__ == '__main__':
    probe = Probe(sys.argv[1])
    print(json.dumps({'hashes': {**n.HASHES, 'Extension.dll': child.EXTENSION_HASH},
                      'cases': {'checkedFound': probe.case(1), 'uncheckedFound': probe.case(0),
                                'uncheckedMissing': probe.case(0, False),
                                'checkedDisabled': probe.case(1, True, False)}}))
