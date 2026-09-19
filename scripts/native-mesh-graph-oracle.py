"""Original native-only Primitive/Mesh/LodMesh registration and resource load.

Class registration runs after explicitly supplied Core.Object defaults. The
class/name registration leaves, allocation and package I/O are host services;
mesh constructors, serializers, lazy loaders and PostLoad run original code.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('mesh', Path(__file__).with_name('native-mesh-load-oracle.py'))
mesh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh)


class Probe(mesh.Probe):
    def __init__(self, root):
        super().__init__(root)
        self.write(0x10599de0, 'I', self.stub('ClassCtor', b'\xc2\x3c\x00'))
        self.cpu.mem_write(0x10103076, b'\xc3')
        self.stub_names[0x10103076] = 'RegisterBase'
        self.cpu.mem_write(0x10102e96, b'\x8b\xc1\xc2\x08\x00')
        self.stub_names[0x10102e96] = 'ConfigName'
        for address, imported in self.thunks.items():
            if imported == ('msvcrt.dll', '__dllonexit'):
                self.cpu.mem_write(address, b'\xc3')
                self.stub_names[address] = 'AtExit'

    def on_instruction(self, cpu, address, size, data):
        name = self.stub_names.get(address)
        sp, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if name == 'ClassCtor':
            self.registration = list(self.read(sp + 4, '15I'))
            cpu.reg_write(UC_X86_REG_EAX, this)
        elif name == 'RegisterBase':
            self.events.append({'op': name})
        elif name == 'ConfigName':
            self.write(this, 'I', 1)
            self.events.append({'op': name})
        elif name == 'AtExit':
            cpu.reg_write(UC_X86_REG_EAX, self.read(sp + 4, 'I')[0])
        elif name in ['NameRef', 'ObjectRef']:
            index = self.compact_ref()
            value = self.name_map[index] if name == 'NameRef' else self.object_map.get(str(index), index)
            self.write(self.read(sp + 4, 'I')[0], 'I', value & 0xffffffff)
            self.events.append({'op': name, 'value': value})
            cpu.reg_write(UC_X86_REG_EAX, self.archive)
        else:
            return super().on_instruction(cpu, address, size, data)

    def class_defaults(self):
        parent = 0x1029e0d0
        self.cpu.mem_write(parent, b'\0' * 0x4f4)
        self.write(parent, 'I', 0x101758f4)
        self.write(parent + 0x3c, 'I', 0x28)
        self.write(parent + 0x484, 'I', 0x13)
        self.write(parent + 0x4d4, '3I', self.alloc(0x28), 0x28, 0x28)
        self.write(parent + 0x4e4, 'I', 0x10101041)
        result = []
        for name, initializer, cls in [('Primitive', 0x103d8200, 0x1058d368),
                ('Mesh', 0x103a6770, 0x10589758), ('LodMesh', 0x10354f40, 0x105359d0)]:
            self.call(initializer, 0, b'')
            args = self.registration
            self.cpu.mem_write(cls, b'\0' * 0x4f4)
            self.write(cls, 'I', 0x101758f4)
            self.write(cls + 0x24, 'I', 0x101f1c18)
            self.write(cls + 0x28, 'I', args[3])
            self.write(cls + 0x3c, 'I', args[1])
            self.write(cls + 0x484, 'I', args[2] | 0x12)
            self.write(cls + 0x49c, 'I', args[4])
            self.write(cls + 0x4a0, 'I', args[11])
            self.write(cls + 0x4e0, '2I', args[13], args[14])
            self.events = []
            self.call(0x10127800, cls, b'')
            ptr, num, capacity = self.array(cls + 0x4d4)
            result.append({'name': name, 'registration': args, 'size': self.read(cls + 0x3c, 'I')[0],
                'classFlags': self.read(cls + 0x484, 'I')[0], 'num': num, 'max': capacity,
                'defaultTail': bytes(self.cpu.mem_read(ptr + 0x28, num - 0x28)).hex(),
                'events': list(self.events)})
        return result

    def initialize_object(self, config):
        self.cpu.mem_write(self.object, b'\xa5' * 0x600)
        self.cpu.mem_write(self.object, b'\0' * 0x28)
        self.write(self.object + 0x1c, 'I', 0x01000000)
        self.write(self.object + 0x24, 'I', 0x105359d0)
        self.call(0x101520d0, 0, struct.pack('<5I', self.object, 0x1b0, 0x105359d0, 0, 0))
        self.call(0x1034a760, self.object, b'')

    def run(self, config):
        self.name_map = config.get('nameMap', list(range(65536)))
        self.object_map = config.get('objectMap', {})
        result = super().run(config)
        # Read the original object's virtual PostLoad slot; no assumed base
        # dispatch based only on class ancestry.
        fn = self.read(self.read(self.object, 'I')[0] + 0x20, 'I')[0]
        result['postLoadVirtual'] = fn
        self.call(fn, self.object, b'')
        result['postFlags'] = self.read(self.object + 0x1c, 'I')[0]
        return result


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    defaults = probe.class_defaults()
    cases = json.load(sys.stdin)
    print(json.dumps({'hashes': mesh.texture.native.HASHES, 'classDefaults': defaults,
                     'cases': [probe.run(case) for case in cases]}))
