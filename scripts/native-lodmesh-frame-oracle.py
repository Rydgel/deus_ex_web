"""Complete original ULodMesh::GetFrame, with native loading and Core math.

FMemCache Create/Flush are allocation leaves. Original inlined lookups, locks,
all vertex/transform/blend instructions and GetAnimSeq execute unchanged.
"""
import base64
import hashlib
import importlib.util
import os
import json
import math
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('mesh', Path(__file__).with_name('native-mesh-load-oracle.py'))
mesh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh)
IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]


class Probe(mesh.Probe):
    def __init__(self, root):
        super().__init__(root)
        table = b''.join(struct.pack('<f', math.sin(i * 0.0003834951969714103)) for i in range(16384))
        assert hashlib.sha256(table).hexdigest() == '9893d14bd21e5c4194832659571b30363ddfb08d468ed662a4b6d5ae172262dc'
        self.cpu.mem_write(0x101b32a4, table)
        self.cpu.mem_write(0x101b32a4 + 4 * 8192, struct.pack('<I', 0x250d3000))  # the measured x87 FSIN entry (native-collision-oracle.py HARDWARE_TRIG)
        self.write(0x10599bc8, 'I', self.stub('CacheCreate', b'\xc2\x18\x00'))
        self.write(0x10599bcc, 'I', self.stub('CacheFlush', b'\xc2\x10\x00'))
        self.actors = {name: self.alloc(0x700) for name in ['actor', 'owner']}
        self.output, self.count_cell = self.alloc(0x10000), self.alloc(4)

    @staticmethod
    def bucket(low):
        return ((((low >> 12) ^ (low & 0x3fff000)) >> 12) ^ (low & 0x3fff)) * 4 + 0x10485c74

    def on_instruction(self, cpu, address, size, data):
        name = self.stub_names.get(address)
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if name == 'CacheCreate':
            low, high, out, count, align, padding = self.read(stack + 4, '6I')
            assert cpu.reg_read(UC_X86_REG_ECX) == 0x10485c50 and align == 8 and padding == 0
            key = (high << 32) | low
            assert key not in self.cache
            item, buffer = self.alloc(32), self.alloc(count)
            self.cpu.mem_write(buffer, b'\x33' * count)
            bucket = self.bucket(low)
            self.write(item, '3I', low, high, buffer)
            self.write(item + 0x10, 'I', 0x1000000)
            self.write(item + 0x1c, 'I', self.read(bucket, 'I')[0])
            self.write(bucket, 'I', item)
            self.write(out, 'I', item)
            self.cache[key] = (item, buffer, count)
            self.cache_events.append({'op': 'create', 'key': str(key), 'size': count})
            cpu.reg_write(UC_X86_REG_EAX, buffer)
            return
        if name == 'CacheFlush':
            low, high, mask, ignore_locked = self.read(stack + 4, '4I')
            key = (high << 32) | low
            assert mask == 0xffffffff and ignore_locked == 0
            item, buffer, count = self.cache.pop(key)
            assert self.read(item + 0x10, 'I')[0] == 0
            link = self.bucket(low)
            while self.read(link, 'I')[0] != item:
                link = self.read(link, 'I')[0] + 0x1c
            self.write(link, 'I', self.read(item + 0x1c, 'I')[0])
            self.write(0x10485c58, '3I', 0xffffffff, 0xffffffff, 0)
            self.cache_events.append({'op': 'flush', 'key': str(key)})
            return
        super().on_instruction(cpu, address, size, data)

    def fields(self, actor, fields):
        for name, value in fields.items():
            if name in ['AnimSequence', 'BlendAnimSequence']:
                offset = 0x54 if name == 'AnimSequence' else 0x68
                names = [value] if name == 'AnimSequence' else value
                for i, text in enumerate(names):
                    self.write(actor + offset + i * 4, 'I', self.names[text])
            elif name in ['AnimFrame', 'DrawScale']:
                self.write(actor + {'AnimFrame': 0x58, 'DrawScale': 0x17c}[name], 'f', value)
            elif name == 'BlendAnimFrame':
                self.write(actor + 0x78, '4f', *value)
            elif name in ['Location', 'PrePivot', 'Rotation']:
                self.write(actor + {'Location': 0x114, 'PrePivot': 0x180, 'Rotation': 0x120}[name],
                           '3i' if name == 'Rotation' else '3f', *value)
            elif name in ['bAnimByOwner', 'bParticles']:
                offset, bit = (0x28, 0x40) if name == 'bAnimByOwner' else (0x194, 4)
                word = self.read(actor + offset, 'I')[0]
                self.write(actor + offset, 'I', (word & ~bit) | (bit if value else 0))
            elif name == 'Owner':
                self.write(actor + 0x3c, 'I', self.actors.get(value, 0))
            else:
                raise ValueError(name)

    def run_frames(self, sample):
        self.names = sample['names']
        # No `frames` option: that older probe isolates the unpack loop, whereas
        # this runner must keep every GetFrame instruction unchanged.
        super().run(sample['mesh'])
        self.cache, self.cache_events = {}, []
        self.cpu.mem_write(0x10485c58, b'\0' * (0x10020))
        self.write(0x10485c58, '2I', 0xffffffff, 0xffffffff)
        for i, (name, actor) in enumerate(self.actors.items()):
            self.cpu.mem_write(actor, b'\0' * 0x700)
            self.write(actor + 4, 'I', 1001 + i)
            self.fields(actor, {'DrawScale': 1})
        count = self.read(self.object + 0xf0, 'I')[0]
        results = []
        for step in sample['steps']:
            self.cache_events = []
            for name, fields in step.get('actors', {}).items():
                self.fields(self.actors[name], fields)
            if step.get('invalidate'):
                for item, buffer, size in self.cache.values():
                    self.write(buffer, 'I', self.object + 0x10000)
            for offset, value in step.get('meshFloats', {}).items():
                self.write(self.object + int(offset), 'f', value)
            if 'special' in step:
                self.write(self.object + 0x184, 'i', step['special'])
            stride = step.get('stride', 20)
            # The output block's prior contents (DrawLodMesh's uninitialized GMem): 0x55 unless the step gives bytes.
            self.cpu.mem_write(self.output, base64.b64decode(step['pattern']) if 'pattern' in step else b'\x55' * (count * stride))
            self.write(self.count_cell, 'i', step.get('count', count))
            args = struct.pack('<II12fII', self.output, stride, *step.get('coords', IDENTITY),
                               self.actors['actor'], self.count_cell)
            before = {name: bytes(self.cpu.mem_read(a, 0x700)).hex() for name, a in self.actors.items()}
            # GetFrame's only caller is DrawLodMesh (Render 0x10b0ee0f), inside
            # the render pass: its x87 control word is render_control_word
            # (0x007f, precision control 24, unless argv[2] or ORACLE_CW says
            # otherwise); the mesh load above stays at the game thread's.
            loading, self.control_word = self.control_word, self.render_control_word
            self.call(0x10355360, self.object, args)
            self.control_word = loading
            after = {name: bytes(self.cpu.mem_read(a, 0x700)).hex() for name, a in self.actors.items()}
            assert before == after, 'GetFrame unexpectedly changed actor storage'
            caches = {}
            for key, (item, buffer, size) in self.cache.items():
                blob = bytearray(self.cpu.mem_read(buffer, size))
                blob[0:4] = b'\0' * 4  # Pointer identity checked separately.
                caches[str(key)] = {'data': base64.b64encode(blob).decode(),
                                   'sameMesh': self.read(buffer, 'I')[0] == self.object,
                                   'locks': self.read(item + 0x10, 'I')[0]}
            results.append({'name': step['name'], 'output': base64.b64encode(bytes(self.cpu.mem_read(self.output, count * stride))).decode(),
                            'count': self.read(self.count_cell, 'i')[0], 'cache': caches,
                            'events': self.cache_events, 'archivePosition': self.position,
                            'lazyPosition': self.read(self.object + 0x5c, 'i')[0]})
        return {'name': sample['name'], 'steps': results}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    probe.render_control_word = (int(sys.argv[2], 0) if len(sys.argv) > 2
                                 else int(os.environ.get('ORACLE_CW', '0x007f'), 0))
    print(json.dumps({'cases': [probe.run_frames(sample) for sample in json.load(sys.stdin)]}))
