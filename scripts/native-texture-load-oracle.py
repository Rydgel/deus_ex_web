"""Original texture/palette constructors, serialization, lazy bytes and PostLoad.

UObject construction/serialization, clock, allocation and file-archive leaves
are explicit services. Texture/mip/palette bodies and the original linker lazy
attachment run from the hash-checked DLLs. Captures stay outside Git.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def compact(value):
    out = bytearray([value & 63])
    value >>= 6
    if value:
        out[0] |= 64
    while value:
        chunk, value = value & 127, value >> 7
        out.append(chunk | (128 if value else 0))
    return bytes(out)


def payload(chains, version, start=4096):
    out = bytearray()
    for chain in chains:
        out += compact(len(chain))
        for mip in chain:
            data = bytes(mip.get('data', []))
            blob = compact(len(data)) + data
            if version > 61:
                out += struct.pack('<I', start + len(out) + 4 + len(blob))
            out += blob
            out += struct.pack('<IIBB', mip['width'], mip['height'], mip['uBits'], mip['vBits'])
    return bytes(out)


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events, self.sizes = [], {}
        self.position, self.data = 4096, b''
        self.stub_names = {}
        self.object, self.archive, self.reader = [self.alloc(0x600) for _ in range(3)]
        self.palette = self.alloc(0x100)
        self.clock = self.alloc(8)
        self.write(self.clock, 'd', 12.5)
        vt, reader_vt, malloc, malloc_vt = [self.alloc(0x100) for _ in range(4)]
        self.write(self.archive, 'I', vt)
        self.write(self.reader, 'I', reader_vt)
        self.write(self.archive + 0x440, 'I', self.reader)
        self.write(malloc, 'I', malloc_vt)
        self.write(0x101a7c44, 'I', malloc)
        self.write(self.read(0x10599dac, 'I')[0], 'I', 0)
        for slot, name, code in [(4, 'Read', b'\xc2\x08\x00'),
                (0x14, 'CountBytes', b'\xc2\x08\x00'), (0x28, 'Tell', b'\xc3'),
                (0x34, 'Seek', b'\xc2\x04\x00')]:
            stub = self.stub(name, code)
            self.write(vt + slot, 'I', stub)
            self.write(reader_vt + slot, 'I', stub)
        self.write(vt + 0x38, 'I', 0x101017d0)  # real AttachLazyLoader
        self.write(vt + 0x3c, 'I', 0x10101a5a)  # real DetachLazyLoader
        for slot, name, cleanup in [(0, 'Malloc', 8), (4, 'Realloc', 12), (8, 'Free', 4)]:
            self.write(malloc_vt + slot, 'I', self.stub(name, b'\xc2' + struct.pack('<H', cleanup)))
        self.write(0x10599b10, 'I', self.stub('ObjectSerialize', b'\xc2\x04\x00'))
        self.write(0x10599da4, 'I', self.stub('Seconds', b'\xdd\x05' + struct.pack('<I', self.clock) + b'\xc3'))
        self.cpu.mem_write(0x1030308f, b'\xc3')
        self.stub_names[0x1030308f] = 'AllocatePalette'
        self.cpu.mem_write(0x10102c70, b'\xc3')
        self.stub_names[0x10102c70] = 'Assert'
        for address, imported in self.thunks.items():
            if imported == ('msvcrt.dll', 'memmove'):
                self.cpu.mem_write(address, b'\xc3')
                self.stub_names[address] = 'Memmove'

    def stub(self, name, code):
        ptr = self.alloc(32)
        self.cpu.mem_write(ptr, code)
        self.stub_names[ptr] = name
        return ptr

    def realloc(self, old, count):
        ptr = self.alloc(count) if count else 0
        if ptr:
            self.cpu.mem_write(ptr, b'\0' * count)
            if old:
                size = min(count, self.sizes.get(old, 0))
                if size:
                    self.cpu.mem_write(ptr, bytes(self.cpu.mem_read(old, size)))
            self.sizes[ptr] = count
        return ptr

    def on_instruction(self, cpu, address, size, data):
        stack, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        name = self.stub_names.get(address)
        if name == 'Memmove':
            dst, src, count = self.read(stack + 4, '3I')
            if count:
                cpu.mem_write(dst, bytes(cpu.mem_read(src, count)))
            cpu.reg_write(UC_X86_REG_EAX, dst)
            return
        elif name == 'Read':
            dst, count = self.read(stack + 4, '2I')
            at = self.position - self.start
            chunk = self.data[at:at + count]
            if at < 0 or len(chunk) != count:
                raise RuntimeError(f'archive read beyond payload at {self.position} size {count}')
            if count:
                cpu.mem_write(dst, chunk)
            self.events.append({'op': 'Read', 'at': self.position, 'size': count})
            self.position += count
        elif name == 'CountBytes':
            amount, maximum = self.read(stack + 4, '2I')
            self.events.append({'op': name, 'amount': amount, 'maximum': maximum})
        elif name == 'Tell':
            cpu.reg_write(UC_X86_REG_EAX, self.position)
            self.events.append({'op': name, 'position': self.position})
        elif name == 'Seek':
            self.position = self.read(stack + 4, 'I')[0]
            self.events.append({'op': name, 'position': self.position})
        elif name in ['Malloc', 'Realloc']:
            args = self.read(stack + 4, '3I')
            old, count = (0, args[0]) if name == 'Malloc' else args[:2]
            cpu.reg_write(UC_X86_REG_EAX, self.realloc(old, count))
        elif name == 'Free':
            self.sizes.pop(self.read(stack + 4, 'I')[0], None)
        elif name == 'ObjectSerialize':
            self.events.append({'op': name})
            self.position += self.prefix_size
            for offset, value in self.seed.items():
                self.write(self.object + int(offset), 'I', value)
        elif address == 0x1014f340:
            self.events.append({'op': 'ObjectCtor', 'object': 'palette' if this == self.palette else 'texture'})
        elif name == 'Seconds':
            self.events.append({'op': name})
        elif name == 'AllocatePalette':
            count, outer, fname, flags = self.read(stack + 4, '4I')
            self.events.append({'op': name, 'size': count, 'sameOuter': outer == 0x1234,
                                'name': fname, 'flags': flags})
            cpu.reg_write(UC_X86_REG_EAX, self.palette)
        elif name == 'Assert':
            raise RuntimeError(f'original assertion line {self.read(stack + 12, "I")[0]:x}')
        elif address == 0x10162bf0:
            self.events.append({'op': 'Attach', 'position': self.position})
        elif address == 0x10162dd0:
            self.events.append({'op': 'Detach'})
        elif address == 0x10145440:
            self.events.append({'op': 'Realloc', 'elementSize': self.read(stack + 4, 'I')[0],
                                'num': self.read(this + 4, 'I')[0], 'max': self.read(this + 8, 'I')[0]})
        return super().on_instruction(cpu, address, size, data)

    def array(self, ptr):
        data, num, maximum = self.read(ptr, '3I')
        return data, num, maximum

    def mips(self, offset):
        ptr, count, capacity = self.array(self.object + offset)
        rows = []
        for i in range(count):
            mip = ptr + 40 * i
            data, num, maximum = self.array(mip + 0x1c)
            rows.append({'width': self.read(mip + 4, 'I')[0], 'height': self.read(mip + 8, 'I')[0],
                         'uBits': self.read(mip + 0xc, 'B')[0], 'vBits': self.read(mip + 0xd, 'B')[0],
                         'savedPosition': self.read(mip + 0x18, 'i')[0],
                         'attached': self.read(mip + 0x14, 'I')[0] == self.archive,
                         'data': list(self.cpu.mem_read(data, num)) if num else [], 'num': num, 'max': maximum})
        return {'num': count, 'max': capacity, 'mips': rows}

    def run(self, config):
        self.cpu.mem_write(self.object, b'\0' * 0x600)
        self.cpu.mem_write(self.palette, b'\0' * 0x100)
        self.write(self.archive + 0x434, '3I', 0, 0, 0)
        self.write(self.archive + 4, 'I', config.get('version', 68))
        self.write(self.archive + 0xc, 'I', 1)
        self.write(self.archive + 0x10, 'I', 0)
        self.write(self.object + 0x18, 'I', 0x1234)
        self.write(self.object + 0x1c, 'I', 0x1000000)
        self.start = config.get('start', 4096)
        self.position = self.start
        self.prefix_size = config.get('prefixSize', 0)
        self.seed = config.get('seed', {})
        self.events = []
        self.write(self.read(0x10599cc0, 'I')[0], 'I', config.get('lazy', 0))
        self.write(0x1058f044, 'I', 0)
        if 'bias' in config:
            engine = self.alloc(0x100)
            self.write(engine + 0x74, 'i', config['bias'])
            self.write(0x1058f044, 'I', engine)
        kind = config.get('kind', 'texture')
        self.call(0x103ef3c0 if kind == 'palette' else 0x103ed3d0, self.object, b'')
        constructor = {'vtable': self.read(self.object, 'I')[0]}
        if kind == 'texture':
            constructor.update({'time': self.read(self.object + 0x4c, 'd')[0],
                'words': {hex(offset): self.read(self.object + offset, 'I')[0]
                          for offset in [0x28, 0x2c, 0x30, 0x34, 0x38, 0x44, 0x48, 0x60, 0x64, 0x68, 0x6c, 0x70, 0x74]}})
        if 'payload' in config:
            self.data = base64.b64decode(config['payload'])
        elif kind == 'palette':
            self.data = compact(len(config['colors'])) + bytes(sum(config['colors'], []))
        else:
            self.data = payload(config['chains'], config.get('version', 68), self.start)
            self.seed = {'132': config.get('flags', 0)}
        self.events = []
        self.call(0x103ef430 if kind == 'palette' else 0x103ed470, self.object, struct.pack('<I', self.archive))
        serialize_events = list(self.events)
        if kind == 'palette':
            ptr, num, maximum = self.array(self.object + 0x28)
            return {'spec': config, 'constructor': constructor, 'events': serialize_events,
                    'position': self.position, 'colors': list(self.cpu.mem_read(ptr, num * 4)), 'num': num, 'max': maximum}
        result = {'spec': config, 'constructor': constructor, 'events': serialize_events,
                  'position': self.position, 'primary': self.mips(0xa4), 'compressed': self.mips(0xb0),
                  'lazyAfter': self.read(self.read(0x10599cc0, 'I')[0], 'I')[0],
                  'attachedCount': self.read(self.archive + 0x438, 'I')[0]}
        if config.get('reload'):
            self.events = []
            self.position = self.start
            self.call(0x103ed470, self.object, struct.pack('<I', self.archive))
            result['reload'] = {'events': list(self.events), 'primary': self.mips(0xa4),
                                'position': self.position,
                                'attachedCount': self.read(self.archive + 0x438, 'I')[0]}
        if config.get('loadDeferred'):
            self.events = []
            ptr, count, _ = self.array(self.object + 0xa4)
            for i in range(count):
                self.call(0x1030cbb0, ptr + i * 40 + 0x10, b'')
                self.call(0x1030cbb0, ptr + i * 40 + 0x10, b'')
            result['deferred'] = {'events': list(self.events), 'primary': self.mips(0xa4), 'position': self.position}
        self.events = []
        self.write(self.object + 0x2c, 'I', 0 if config.get('noPalette') else self.palette)
        self.write(self.object + 0x34, '4i', *config.get('postSize', [16, 8]),
                   config.get('uClamp', -2), config.get('vClamp', 20))
        self.write(self.object + 0xa0, 'I', 0xdeadbeef)
        self.call(0x103ed8f0, self.object, b'')
        palette_data, palette_num, _ = self.array(self.palette + 0x28)
        result['post'] = {'events': self.events, 'flags': self.read(self.object + 0x1c, 'I')[0],
                          'uClamp': self.read(self.object + 0x3c, 'i')[0],
                          'vClamp': self.read(self.object + 0x40, 'i')[0],
                          'clearA0': self.read(self.object + 0xa0, 'I')[0],
                          'time': self.read(self.object + 0x4c, 'd')[0],
                          'samePalette': self.read(self.object + 0x2c, 'I')[0] == self.palette,
                          'palette': list(self.cpu.mem_read(palette_data, palette_num * 4)) if palette_num else []}
        return result


MIPS = [{'width': 2, 'height': 2, 'uBits': 1, 'vBits': 1, 'data': [1, 2, 3, 4]},
        {'width': 1, 'height': 1, 'uBits': 0, 'vBits': 0, 'data': [5]}]
CASES = [
    {'name': 'eager', 'chains': [MIPS]},
    {'name': 'lazy', 'chains': [MIPS], 'lazy': 1, 'loadDeferred': True},
    {'name': 'bias-clamped', 'chains': [MIPS], 'bias': 99, 'loadDeferred': True},
    {'name': 'legacy61', 'chains': [MIPS], 'version': 61},
    {'name': 'compressed', 'chains': [MIPS, MIPS[:1]], 'flags': 32},
    {'name': 'clear-temporal', 'chains': [MIPS], 'flags': 8, 'reload': True},
    {'name': 'empty-and-missing-palette', 'chains': [[]], 'noPalette': True, 'uClamp': 99, 'vClamp': 3},
    {'name': 'palette68', 'kind': 'palette', 'colors': [[1, 2, 3, 4], [240, 230, 220, 210]]},
    {'name': 'palette65', 'kind': 'palette', 'version': 65, 'colors': [[1, 2, 3, 4], [240, 230, 220, 210]]},
]

if __name__ == '__main__':
    root = Path(sys.argv[1])
    cases = json.load(sys.stdin) if '--stdin' in sys.argv else CASES
    probe = Probe(root)
    print(json.dumps({'hashes': native.HASHES, 'cases': [probe.run(case) for case in cases]}))
