"""Original GOTY ULodMesh construction, serialization and lazy-array loading.

Uses the original array vtables and Core linker attachment, unlike the older
sequence-only probe. File I/O, allocation, UObject's tagged prefix and compact
name/object reference resolution are explicit external services.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP,
                              UC_X86_REG_EBX, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI)

spec = importlib.util.spec_from_file_location('texture', Path(__file__).with_name('native-texture-load-oracle.py'))
texture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(texture)


class Probe(texture.Probe):
    # The class under test: ULodMesh by default (constructor 0x1034a760,
    # Serialize 0x10354ab0). A `classic` case (run) takes the classic UMesh
    # (0x103a6130, 0x103a63b0, which ends at +0xe4) through the same code.
    CONSTRUCTOR, SERIALIZE, OBJECT_SIZE = 0x1034a760, 0x10354ab0, 0x1b0
    ARRAYS = [0x60, 0x78, 0x84, 0x9c, 0xa8, 0xb4, 0xcc, 0xd8, 0xe4,
              0x12c, 0x138, 0x144, 0x150, 0x15c, 0x168, 0x174, 0x1a0]

    def __init__(self, root):
        super().__init__(root)
        vt = self.read(self.archive, 'I')[0]
        for offset, name in [(0x18, 'ObjectRef'), (0x1c, 'NameRef')]:
            self.write(vt + offset, 'I', self.stub(name, b'\xc2\x04\x00'))
        self.transfers = []
        self.array_info = {}

    def compact_ref(self):
        at = self.position - self.start
        first = self.data[at]
        at += 1
        value, more, shift = first & 63, first & 64, 6
        while more:
            byte = self.data[at]
            at += 1
            value |= (byte & 127) << shift
            more, shift = byte & 128, shift + 7
        self.position = self.start + at
        return -value if first & 128 else value

    def on_instruction(self, cpu, address, size, data):
        stack, this = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        name = self.stub_names.get(address)
        if name in ['ObjectRef', 'NameRef']:
            dst = self.read(stack + 4, 'I')[0]
            value = self.compact_ref()
            self.write(dst, 'i', value)
            cpu.reg_write(UC_X86_REG_EAX, self.archive)
            self.events.append({'op': name, 'value': value})
            return
        if name == 'Read':
            dst, count = self.read(stack + 4, '2I')
            self.transfers.append({'at': self.position - self.start,
                                   'dst': dst, 'size': count})
        elif address == 0x10145440:
            self.array_info[this] = self.read(stack + 4, 'I')[0]
        return super().on_instruction(cpu, address, size, data)

    def snapshot(self):
        result = {}
        for offset in self.ARRAYS:
            at = self.object + offset
            ptr, num, maximum = self.array(at)
            size = self.array_info.get(at)
            blob = bytes(self.cpu.mem_read(ptr, num * size)) if num and size else b''
            notifies = []
            if offset == 0x84:
                blob = bytearray(blob)
                for i in range(num):
                    notify_ptr, notify_num, notify_max = self.array(ptr + i * 32 + 20)
                    notify_data = bytes(self.cpu.mem_read(notify_ptr, notify_num * 8)) if notify_num else b''
                    notifies.append({'num': notify_num, 'max': notify_max,
                        'data': base64.b64encode(notify_data).decode()})
                    blob[i * 32 + 20:i * 32 + 24] = b'\0' * 4
            result[hex(offset)] = {'num': num, 'max': maximum, 'elementSize': size,
                'sha256': hashlib.sha256(blob).hexdigest(), 'head': blob[:64].hex(),
                'data': base64.b64encode(blob).decode(), 'notifies': notifies}
        return {'arrays': result,
            'object': bytes(self.cpu.mem_read(self.object, self.OBJECT_SIZE)).hex(),
            'lazy': {hex(offset): {'savedPosition': self.read(self.object + offset + 8, 'i')[0],
                'attached': self.read(self.object + offset + 4, 'I')[0] == self.archive}
                     for offset in [0x54, 0x6c, 0x90, 0xc0]}}

    def initialize_object(self, config):
        self.cpu.mem_write(self.object, b'\0' * 0x600)
        self.call(self.CONSTRUCTOR, self.object, b'')

    def run(self, config):
        # `classic`: the Mesh class itself (UMesh::UMesh 0x103a6130, UMesh::Serialize
        # 0x103a63b0, 0x12c bytes), the five classic meshes of the game.
        if config.get('classic'):
            self.CONSTRUCTOR, self.SERIALIZE, self.OBJECT_SIZE = 0x103a6130, 0x103a63b0, 0x12c
            self.ARRAYS = [0x60, 0x78, 0x84, 0x9c, 0xa8, 0xb4, 0xcc, 0xd8, 0xe4]
        else:
            self.CONSTRUCTOR, self.SERIALIZE, self.OBJECT_SIZE = Probe.CONSTRUCTOR, Probe.SERIALIZE, Probe.OBJECT_SIZE
            self.ARRAYS = Probe.ARRAYS
        self.write(self.archive + 0x434, '3I', 0, 0, 0)
        self.write(self.archive + 4, 'I', config.get('version', 68))
        self.write(self.archive + 0xc, 'I', 1)
        self.write(self.archive + 0x10, 'I', 0)
        self.start = config['start']
        self.position = self.start
        self.prefix_size, self.seed = config.get('prefixSize', 1), {}
        self.data = base64.b64decode(config['payload'])
        self.events, self.transfers, self.array_info = [], [], {}
        self.write(self.read(0x10599cc0, 'I')[0], 'I', config.get('lazy', 0))
        self.initialize_object(config)
        constructor = bytes(self.cpu.mem_read(self.object, self.OBJECT_SIZE)).hex()
        constructor_events = list(self.events)
        self.events, self.transfers = [], []
        self.call(self.SERIALIZE, self.object, struct.pack('<I', self.archive))
        result = {'name': config.get('name'), 'constructor': constructor, 'constructorEvents': constructor_events,
                  'position': self.position - self.start, **self.snapshot(),
                  'events': list(self.events), 'transfers': list(self.transfers),
                  'attachedCount': self.read(self.archive + 0x438, 'I')[0]}
        if config.get('loadDeferred'):
            self.events, self.transfers = [], []
            for offset in [0x54, 0x6c, 0x90, 0xc0]:
                at = self.object + offset
                fn = self.read(self.read(at, 'I')[0], 'I')[0]
                self.call(fn, at, b'')
                self.call(fn, at, b'')
            result['deferred'] = {'position': self.position - self.start,
                **self.snapshot(), 'events': self.events, 'transfers': self.transfers}
        if config.get('frames'):
            vertices = self.object + 0x54
            self.call(self.read(self.read(vertices, 'I')[0], 'I')[0], vertices, b'')
            count = self.read(self.object + 0xf0, 'I')[0]
            cache, locals_base = self.alloc(count * 12 + 20), self.alloc(0x200) + 0x100
            # Execute the unchanged original unpack loop, stopping before its
            # next LOD/cache stage. Caller frame selection/transforms are not claimed.
            self.cpu.mem_write(0x103557d9, b'\xc3')
            result['frames'] = {}
            for frame in config['frames']:
                self.write(locals_base - 0x40, 'I', frame * count)
                self.write(locals_base - 0x38, 'I', count)
                for reg, value in [(UC_X86_REG_EBP, locals_base), (UC_X86_REG_EBX, self.object),
                                   (UC_X86_REG_ESI, 0), (UC_X86_REG_EDI, cache)]:
                    self.cpu.reg_write(reg, value)
                self.call(0x10355779, count, b'')
                result['frames'][str(frame)] = base64.b64encode(bytes(self.cpu.mem_read(cache + 20, count * 12))).decode()
        return result


if __name__ == '__main__':
    root = Path(sys.argv[1])
    cases = json.load(sys.stdin)
    probe = Probe(root)
    print(json.dumps({'hashes': texture.native.HASHES, 'cases': [probe.run(case) for case in cases]}))
