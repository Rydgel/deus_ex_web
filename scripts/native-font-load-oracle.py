"""Original native-only Font class defaults, constructor, Serialize and PostLoad.

UObject::Serialize, the archive object reference, clock and allocator leaves
are explicit services. The Font registration, UClass::Register, UFont
constructor, Serialize, FFontPage/FFontCharacter array serializers, TArray
destructor and the PostLoad thunk execute from the hash-checked DLLs.
Evidence: docs/script-font-load.md. Captures and assets stay outside Git.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('sound', Path(__file__).with_name('native-sound-graph-oracle.py'))
sound = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sound)

FONT_CLASS = 0x10587348
FONT_REGISTER = 0x103855b0
FONT_CTOR = 0x103853d0
FONT_SERIALIZE = 0x10385400
FONT_VTABLE = 0x10426878
FONT_POSTLOAD_THUNK = 0x1040c72e
GLAZYLOAD_CELL = 0x10599cc0


def decode_compact(data, at):
    b = data[at]
    value, shift, used = b & 0x3f, 6, 1
    more = b & 0x40
    while more:
        b = data[at + used]
        used += 1
        value |= (b & 0x7f) << shift
        shift += 7
        more = b & 0x80
    return (-value if data[at] & 0x80 else value), used


class Probe(sound.Probe):
    def __init__(self, root):
        super().__init__(root)
        vt = self.read(self.archive, 'I')[0]
        self.write(vt + 0x18, 'I', self.stub('ObjectRef', b'\x8b\xc1\xc2\x04\x00'))
        self.mip_load = self.stub('MipLoad', b'\xc3')
        self.fail_assert = self.read(0x10599a1c, 'I')[0]
        self.cpu.mem_write(self.fail_assert, b'\xc3')
        self.stub_names[self.fail_assert] = 'FailAssert'
        # CRT atexit (0x1041348c -> msvcrt __dllonexit): the initializer
        # registers the static class destructor 0x10385630. Record, not run.
        self.cpu.mem_write(0x1041348c, b'\xc3')
        self.stub_names[0x1041348c] = 'AtExit'
        self.textures = {}
        self.ref_config = {}

    def on_instruction(self, cpu, address, size, data):
        name = self.stub_names.get(address)
        sp, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if name == 'ObjectRef':
            target = self.read(sp + 4, 'I')[0]
            at = self.position - self.start
            index, used = decode_compact(self.data, at)
            self.position += used
            pointer = self.texture_for(index)
            self.write(target, 'I', pointer)
            self.events.append({'op': 'ObjectRef', 'index': index, 'bytes': used})
            if self.ref_config.get('clearLazyOnRef'):
                self.write(self.read(GLAZYLOAD_CELL, 'I')[0], 'I', 0)
            return
        if name == 'MipLoad':
            texture, mip = self.lazy_owner[this]
            self.events.append({'op': 'MipLoad', 'texture': texture, 'mip': mip})
            return
        if name == 'Free':
            self.events.append({'op': 'Free'})
        if name == 'AtExit':
            self.atexit = self.read(sp + 4, 'I')[0]
            return
        if name == 'FailAssert':
            expr, file, line = self.read(sp + 4, '3I')
            self.events.append({'op': 'FailAssert', 'line': line,
                                'expr': self.ascii(expr), 'file': self.ascii(file)})
            return
        return super().on_instruction(cpu, address, size, data)

    def ascii(self, address):
        out = bytearray()
        while True:
            c = self.cpu.mem_read(address + len(out), 1)[0]
            if not c:
                return out.decode()
            out.append(c)

    def texture_for(self, index):
        if index == 0:
            return 0
        if index in self.textures:
            return self.textures[index]
        mips = self.ref_config.get('mips', {}).get(str(index), 0)
        texture = self.alloc(0x100)
        self.cpu.mem_write(texture, b'\0' * 0x100)
        data = self.alloc(40 * max(mips, 1))
        self.cpu.mem_write(data, b'\0' * (40 * max(mips, 1)))
        for mip in range(mips):
            lazy = data + 40 * mip + 0x10
            vtable = self.alloc(16)
            self.write(vtable, 'I', self.mip_load)
            self.write(lazy, 'I', vtable)
            self.lazy_owner[lazy] = (index, mip)
        self.write(texture + 0xa4, '3I', data, mips, mips)
        self.textures[index] = texture
        return texture

    def font_class_defaults(self):
        self.call(FONT_REGISTER, 0, b'')
        args = self.registration
        cls, parent = FONT_CLASS, args[3]
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
        return {'registration': args, 'atexit': self.atexit, 'size': self.read(cls + 0x3c, 'I')[0],
                'classFlags': self.read(cls + 0x484, 'I')[0], 'num': num, 'max': capacity,
                'defaultTail': list(self.cpu.mem_read(ptr + 0x28, num - 0x28)),
                'strings': {'name': self.wide(args[9]), 'package': self.wide(args[10]),
                            'config': self.wide(args[11])},
                'events': list(self.events)}

    def wide(self, address):
        out = []
        while True:
            c = self.read(address + 2 * len(out), 'H')[0]
            if not c:
                return ''.join(out)
            out.append(chr(c))

    def font_state(self):
        ptr, num, capacity = self.array(self.object + 0x2c)
        pages = []
        for i in range(num):
            page = ptr + 16 * i
            texture = self.read(page, 'I')[0]
            cdata, cnum, cmax = self.array(page + 4)
            records = [list(self.read(cdata + 16 * j, '4i')) for j in range(cnum)]
            index = next((k for k, v in self.textures.items() if v == texture), None)
            pages.append({'texture': index, 'num': cnum, 'max': cmax, 'chars': records})
        return {'vtable': self.read(self.object, 'I')[0],
                'charactersPerPage': self.read(self.object + 0x28, 'i')[0],
                'num': num, 'max': capacity, 'pages': pages, 'position': self.position,
                'lazyGlobal': self.read(self.read(GLAZYLOAD_CELL, 'I')[0], 'I')[0]}

    def font(self, config):
        self.textures, self.lazy_owner, self.ref_config = {}, {}, config
        self.events = []
        self.cpu.mem_write(self.object, b'\xa5' * 0x38)
        self.cpu.mem_write(self.object, b'\0' * 0x28)
        self.write(self.object + 0x28, 'I', config.get('templatePerPage', 0x5a5a5a5a))
        self.write(self.object + 0x1c, 'I', 0x01000000)
        self.write(self.object + 0x24, 'I', FONT_CLASS)
        self.call(FONT_CTOR, self.object, b'')
        constructor = {'events': list(self.events), 'vtable': self.read(self.object, 'I')[0],
                       'words': {hex(o): self.read(self.object + o, 'I')[0] for o in (0x28, 0x2c, 0x30, 0x34)}}
        self.start = self.position = config['start']
        self.data = base64.b64decode(config['payload'])
        self.seed = {}
        self.prefix_size = config['prefixSize']
        self.write(self.archive + 4, 'I', config['version'])
        self.write(self.archive + 0xc, 'I', 1)
        self.write(self.archive + 0x10, 'I', 0)
        passes = []
        for _ in range(2 if config.get('reload') else 1):
            self.position = self.start
            self.write(self.read(GLAZYLOAD_CELL, 'I')[0], 'I', config.get('lazy', 0))
            self.events = []
            self.call(FONT_SERIALIZE, self.object, struct.pack('<I', self.archive))
            passes.append({'events': list(self.events), 'state': self.font_state()})
        flags_before = self.read(self.object + 0x1c, 'I')[0]
        self.events = []
        self.call(FONT_POSTLOAD_THUNK, self.object, b'')
        return {'name': config['name'], 'constructor': constructor, 'passes': passes,
                'post': {'events': list(self.events), 'flagsBefore': flags_before,
                         'flagsAfter': self.read(self.object + 0x1c, 'I')[0]}}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    vtable = [probe.read(FONT_VTABLE + 4 * i, 'I')[0] for i in range(21)]
    defaults = probe.font_class_defaults()
    cases = json.load(sys.stdin) if '--stdin' in sys.argv else []
    print(json.dumps({'hashes': sound.texture.native.HASHES, 'vtable': vtable,
                      'classDefaults': defaults, 'cases': [probe.font(case) for case in cases]}))
