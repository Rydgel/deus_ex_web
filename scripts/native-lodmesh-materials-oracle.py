"""Original skin workers/exec and explicitly bounded full-resolution surface reads.

Render ranges are data-layout references, not whole DrawLodMesh executions.
Original binaries and reference captures stay local. See script-lodmesh-materials.md.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX,
                              UC_X86_REG_EDI, UC_X86_REG_ESI, UC_X86_REG_EBP,
                              UC_X86_REG_ESP)

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'
DEUSEX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'Render.dll': RENDER_HASH})
        self.events = []
        engine = native.Image(root / 'System' / 'Engine.dll')
        assert engine.read(0x104268dc + 0x80 - engine.base, 'I')[0] == 0x103016f9
        assert engine.read(0x10426994 + 0x80 - engine.base, 'I')[0] == 0x103016f9
        assert engine.read(0x1042942c + 0x74 - engine.base, 'I')[0] == 0x103032b5
        deus = native.Image(root / 'System' / 'DeusEx.dll', DEUSEX_HASH)
        for vt in [0x10027568, 0x10027624]:
            assert deus.read(vt + 0x80 - deus.base, 'I')[0] == 0x1001af26
        assert deus.read(0x1001af26 - deus.base, '6B') == (0xff, 0x25, 0x1c, 0x72, 0x02, 0x10)
        assert ('engine.dll', '?GetSkin@AActor@@UAEPAVUTexture@@H@Z', 0x1002721c) in list(deus.imports())
        self.warn = 0x700e2000
        self.cpu.mem_write(self.warn, b'\xc3')
        self.write(0x10599a68, 'I', self.warn)
        core = native.Image(root / 'System' / 'Core.dll').exports()
        table = self.alloc(1024)
        self.write(0x10599a38, 'I', table)
        for token, name in [(0x0b, 'Nothing'), (0x1d, 'IntConst')]:
            self.write(table + token * 4, 'I', core[f'?exec{name}@UObject@@QAEXAAUFFrame@@QAX@Z'])
        self.frame, self.code, self.output = self.alloc(0x30), self.alloc(16), self.alloc(4)

    def on_instruction(self, cpu, address, size, data):
        if address == 0x10367eb0:
            self.events.append({'op': 'GetSkin', 'index': self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'i')[0]})
        elif address == self.warn:
            frame, text = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, '2I')
            assert frame == self.frame and text == 0x10482288
            self.events.append({'op': 'warning', 'text': 'GetMeshTexture: No mesh'})
        return super().on_instruction(cpu, address, size, data)

    def texture(self, sample):
        self.events = []
        actor, mesh = self.alloc(0x700), self.alloc(0x1b0)
        textures = sample.get('textures', [11, 22, 0, 44, 0, 66, 0, 88, 99])
        array = self.alloc(max(4, len(textures) * 4))
        self.write(array, f'{len(textures)}I', *textures)
        self.write(mesh, 'I', 0x1042942c)
        self.write(mesh + 0xd8, '3I', array, len(textures), len(textures))
        self.write(actor, 'I', 0x104268dc)
        self.write(actor + 0x170, '2I', sample.get('skin', 0), 0 if sample.get('noMesh') else mesh)
        self.write(actor + 0x1a4, '8I', *sample.get('multi', [0] * 8))
        before = bytes(self.cpu.mem_read(actor, 0x700))
        index = sample.get('index', 0)
        advance = None
        if sample['mode'] == 'exec':
            code = b'\x0b' if sample.get('nothing') else b'\x1d' + struct.pack('<i', index)
            self.cpu.mem_write(self.code, code + b'\x16')
            self.write(self.frame + 8, '2I', actor, self.code)
            self.write(self.output, 'I', 0x55555555)
            self.call(0x103e17c0, actor, struct.pack('<2I', self.frame, self.output))
            result = self.read(self.output, 'I')[0]
            advance = self.read(self.frame + 12, 'I')[0] - self.code
            assert advance == len(code) + 1
        elif sample['mode'] == 'skin':
            result = self.call(0x10367eb0, actor, struct.pack('<i', index))
        else:
            result = self.call(0x1031c0a0, mesh, struct.pack('<iI', index, 0 if sample.get('noActor') else actor))
        assert bytes(self.cpu.mem_read(actor, 0x700)) == before
        return {'name': sample['name'], 'result': result, 'events': self.events, 'advance': advance}

    def surfaces(self, sample):
        mesh = self.alloc(0x1b0)
        frame = self.alloc(0x200) + 0x140
        for offset, array in sample['arrays'].items():
            data = base64.b64decode(array['data'])
            address = self.alloc(max(4, len(data)))
            self.cpu.mem_write(address, data)
            self.write(mesh + int(offset), '3I', address, array['num'], array['num'])
        vertices = self.alloc(sample['frameVerts'] * 88)
        ordinary = vertices + sample['special'] * 88
        scratch = self.alloc(sample['arrays'][str(0x15c)]['num'] * 4)
        self.write(frame - 0x60, 'I', mesh)
        self.write(frame - 0x5c, 'I', ordinary)
        self.write(frame - 0x34, 'I', scratch)
        self.write(frame - 0x58, 'i', -1)
        self.write(frame + 0x28, 'I', sample.get('flags', 0))
        result = []
        done = self.done
        try:
            for i in range(sample['arrays'][str(0x144)]['num']):
                self.cpu.reg_write(UC_X86_REG_EBP, frame)
                self.cpu.reg_write(UC_X86_REG_EAX, i)
                self.done = 0x10b101e8
                try:
                    self.call(0x10b10123, 0, b'')
                except Exception as error:
                    raise RuntimeError(f'{sample["name"]} face {i}: {list(self.trace)}') from error
                indices = [(self.cpu.reg_read(reg) - vertices) // 88
                           for reg in [UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_ECX]]
                face = self.read(frame - 0x38, 'I')[0]
                wedges = self.read(face, '3H')
                material, flags = self.read(frame - 0x58, '2I')
                packed = [self.read(scratch + wedge * 4, 'I')[0] for wedge in wedges]
                self.cpu.reg_write(UC_X86_REG_EAX, material)
                self.done = 0x10b10b24
                self.call(0x10b10b0a, 0, b'')
                assert self.cpu.reg_read(UC_X86_REG_EBX) == flags
                texture = self.cpu.reg_read(UC_X86_REG_EAX)
                texture = texture if texture < 0x80000000 else texture - 0x100000000
                result.append({'wedges': list(wedges), 'vertices': indices, 'packed': packed,
                               'material': material, 'flags': flags, 'texture': texture})
        finally:
            self.done = done
        return {'name': sample['name'], 'faces': result}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    samples = json.load(sys.stdin)
    print(json.dumps({'textures': [probe.texture(x) for x in samples['textures']],
                      'surfaces': [probe.surfaces(x) for x in samples['surfaces']]}))
