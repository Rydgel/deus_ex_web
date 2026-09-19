"""Original native-only Sound class defaults and full resource load boundary.

Package/name/allocator services are explicit. Captures and assets stay local.
"""
import importlib.util
import base64
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('texture', Path(__file__).with_name('native-texture-load-oracle.py'))
texture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(texture)


class Probe(texture.Probe):
    def __init__(self, root):
        super().__init__(root)
        self.write(0x10599de0, 'I', self.stub('ClassCtor', b'\xc2\x3c\x00'))
        self.cpu.mem_write(0x10103076, b'\xc3')
        self.stub_names[0x10103076] = 'RegisterBase'
        self.cpu.mem_write(0x10102e96, b'\x8b\xc1\xc2\x08\x00')
        self.stub_names[0x10102e96] = 'ConfigName'
        self.write(self.read(self.archive, 'I')[0] + 0x1c, 'I', 0x10163580)

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
        else:
            return super().on_instruction(cpu, address, size, data)

    def class_defaults(self):
        self.call(0x1036fbe0, 0, b'')
        args = self.registration
        cls, parent = 0x10580868, args[3]
        self.cpu.mem_write(cls, b'\0' * 0x4f4)
        self.cpu.mem_write(parent, b'\0' * 0x4f4)
        parent_defaults = self.alloc(0x28)
        self.write(parent, 'I', 0x101758f4)
        self.write(parent + 0x3c, 'I', 0x28)
        self.write(parent + 0x484, 'I', 0x13)
        self.write(parent + 0x4d4, '3I', parent_defaults, 0x28, 0x28)
        self.write(parent + 0x4e4, 'I', args[14])
        self.write(cls, 'I', 0x101758f4)
        self.write(cls + 0x24, 'I', 0x101f1c18)
        self.write(cls + 0x28, 'I', parent)
        self.write(cls + 0x3c, 'I', args[1])
        self.write(cls + 0x484, 'I', args[2] | 0x12)
        self.write(cls + 0x49c, 'I', args[4])
        self.write(cls + 0x4a0, 'I', args[11])
        self.write(cls + 0x4e0, '2I', args[13], args[14])
        self.events = []
        self.call(0x10127800, cls, b'')
        ptr, num, capacity = self.array(cls + 0x4d4)
        return {'registration': args, 'size': self.read(cls + 0x3c, 'I')[0],
                'classFlags': self.read(cls + 0x484, 'I')[0], 'num': num, 'max': capacity,
                'defaultTail': list(self.cpu.mem_read(ptr + 0x28, num - 0x28)),
                'events': list(self.events)}

    def snapshot(self):
        data, num, maximum = self.array(self.object + 0x34)
        return {'vtable': self.read(self.object, 'I')[0],
                'dataVtable': self.read(self.object + 0x28, 'I')[0],
                'attached': self.read(self.object + 0x2c, 'I')[0] == self.archive,
                'savedPosition': self.read(self.object + 0x30, 'i')[0],
                'ownerIsSelf': self.read(self.object + 0x40, 'I')[0] == self.object,
                'format': self.read(self.object + 0x44, 'I')[0],
                'byteCount': self.read(self.object + 0x48, 'I')[0],
                'duration': self.read(self.object + 0x4c, 'f')[0],
                'tail': self.read(self.object + 0x50, 'I')[0],
                'num': num, 'max': maximum,
                'bytes': list(self.cpu.mem_read(data, num)) if num else [],
                'position': self.position,
                'lazyGlobal': self.read(self.read(0x10599cc0, 'I')[0], 'I')[0]}

    def resource(self, config):
        self.events = []
        self.start = self.position = config['start']
        self.data = base64.b64decode(config['payload'])
        self.seed = {}
        self.prefix_size = config['prefixSize']
        self.write(self.read(0x10599cc0, 'I')[0], 'I', config.get('lazy', 0))
        self.cpu.mem_write(self.object, b'\xa5' * 0x54)
        self.cpu.mem_write(self.object, b'\0' * 0x28)
        self.write(self.object + 0x1c, 'I', 0x01000000)
        self.write(self.object + 0x24, 'I', 0x10580868)
        self.call(0x101520d0, 0, struct.pack('<5I', self.object, 0x54, 0x10580868, 0, 0))
        self.call(0x1034cdc0, self.object, b'')
        constructor = self.snapshot()
        self.write(self.archive + 4, 'I', config['version'])
        self.write(self.archive + 0xc, 'I', 1)
        self.write(self.archive + 0x10, 'I', 0)
        self.write(self.reader + 4, 'I', config['version'])
        self.write(self.reader + 0xc, 'I', 1)
        self.write(self.archive + 0x434, '3I', 0, 0, 0)
        name_map = config['nameMap']
        names = self.alloc(4 * len(name_map))
        self.write(names, str(len(name_map)) + 'I', *name_map)
        self.write(self.archive - 0x38, '2I', names, len(name_map))
        self.write(self.read(0x10599cc0, 'I')[0], 'I', config.get('lazy', 0))
        self.write(0x10580d5c, 'I', 0)
        self.events = []
        self.call(0x1036f900, self.object, struct.pack('<I', self.archive))
        serialized = self.snapshot()
        events = list(self.events)
        self.call(0x1036fb20, self.object, b'')
        post_flags = self.read(self.object + 0x1c, 'I')[0]
        self.events = []
        load = 0x1036f700 if config.get('special') else 0x1036f040
        self.call(load, self.object + 0x28, b'')
        self.call(load, self.object + 0x28, b'')
        return {'name': config['name'], 'constructor': constructor, 'serializeEvents': events,
                'serialized': serialized, 'postFlags': post_flags,
                'loadEvents': list(self.events), 'loaded': self.snapshot()}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    defaults = probe.class_defaults()
    cases = json.load(sys.stdin) if '--stdin' in sys.argv else []
    print(json.dumps({'hashes': texture.native.HASHES, 'classDefaults': defaults,
                      'cases': [probe.resource(case) for case in cases]}))
