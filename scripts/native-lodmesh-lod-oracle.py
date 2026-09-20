"""Unchanged original DrawLodMesh LOD ranges; whole-renderer behavior is excluded.

Inputs supply the verified mesh arrays and GetFrame output boundary. Selection,
position morphing, face admission and wedge/UV collapse execute original bytes.
Core appTan inputs/results are recorded for separate x87 hardware confirmation.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX,
                              UC_X86_REG_EDX, UC_X86_REG_EDI, UC_X86_REG_ESI,
                              UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_EIP,
                              UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('materials', Path(__file__).with_name('native-lodmesh-materials-oracle.py'))
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)


class Probe(materials.Probe):
    def __init__(self, root):
        super().__init__(root)
        self.stops, self.tangents = set(), {}

    def on_instruction(self, cpu, address, size, data):
        if address in self.stops:
            cpu.emu_stop()
            return
        if address == 0x10123260:
            self.tan_input = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'Q')[0]
        elif address == 0x10b0ebe5:
            self.tangents[f'{self.tan_input:016x}'] = self.read(cpu.reg_read(UC_X86_REG_EBP) - 0x3c, 'I')[0]
        super().on_instruction(cpu, address, size, data)

    def execute_range(self, start, stops, this=0):
        self.stops = set(stops)
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.emu_start(start, self.done + 1, count=1000000)
        stopped = self.cpu.reg_read(UC_X86_REG_EIP)
        if stopped not in self.stops:
            raise RuntimeError(f'Unexpected LOD range exit {stopped:x}: {list(self.trace)}')
        self.stops = set()
        return stopped

    def run_mesh(self, sample):
        mesh, renderer, actor, viewport, scene = [self.alloc(n) for n in [0x1b0, 0x100, 0x700, 0x100, 0x180]]
        frame = self.alloc(0x200) + 0x140
        coords = self.alloc(48)
        for offset, array in sample['arrays'].items():
            data = base64.b64decode(array['data'])
            address = self.alloc(max(4, len(data)))
            self.cpu.mem_write(address, data)
            self.write(mesh + int(offset), '3I', address, array['num'], array['num'])
        vertices = self.alloc(sample['frameVerts'] * 88)
        scratch_size = sample['arrays'][str(0x15c)]['num'] * 4
        scratch = self.alloc(scratch_size)
        self.write(viewport + 0x30, 'I', actor)
        self.write(scene, 'I', viewport)
        rows = []
        for case in sample['cases']:
            self.cpu.mem_write(frame - 0x140, b'\0' * 0x200)
            for offset, value in sample['scalars'].items():
                self.write(mesh + int(offset), 'I', value)
            for offset, value in case.get('meshFloats', {}).items():
                self.write(mesh + int(offset), 'f', value)
            self.write(mesh + 0x130, 'I', 0 if case.get('noCollapse') else sample['arrays'][str(0x12c)]['num'])
            settings = {'factor': 0.25, 'scale': 1, 'mode': 1, 'force': 1, **case.get('settings', {})}
            self.write(renderer + 0x40, '2fif', settings['factor'], settings['scale'], settings['mode'], settings['force'])
            self.write(actor + 0x64, 'f', case.get('bias', 1))
            self.write(actor + 0x114, '3f', *case.get('location', [0, 0, 0]))
            self.write(actor + 0x17c, 'f', case.get('drawScale', 1))
            self.write(actor + 0x410, 'f', case.get('fov', 90))
            self.write(scene + 0xb8, 'f', case.get('width', 640))
            self.write(coords, '12f', *case.get('coords', [0, 0, -case.get('depth', 350), 1, 0, 0, 0, 1, 0, 0, 0, 1]))
            self.write(frame + 8, 'I', scene)
            self.write(frame + 0xc, 'I', actor)
            self.write(frame + 0x1c, 'I', coords)
            self.write(frame - 0x40, 'I', renderer)
            self.cpu.reg_write(UC_X86_REG_EBP, frame)
            self.cpu.reg_write(UC_X86_REG_EBX, mesh)
            self.cpu.reg_write(UC_X86_REG_EDI, renderer)
            self.cpu.reg_write(UC_X86_REG_ESI, 0)
            self.execute_range(0x10b0eb52, [0x10b0ed53], viewport)
            selection = {'detailBits': self.read(frame - 0x54, 'I')[0],
                         'vertexCount': self.read(frame - 0x14, 'i')[0],
                         'active': bool(self.read(frame - 0x28, 'I')[0]),
                         'morph': bool(self.read(frame - 0xb4, 'I')[0])}
            count = case.get('returnedCount', selection['vertexCount'])
            assert 0 < count <= selection['vertexCount'] <= sample['frameVerts']
            self.write(frame - 0x14, 'i', count)
            self.cpu.mem_write(vertices, base64.b64decode(sample['vertices']))
            ordinary = vertices + self.read(mesh + 0x184, 'I')[0] * 88
            self.write(frame - 0x5c, 'I', ordinary)
            self.write(frame - 0x60, 'I', mesh)
            self.cpu.reg_write(UC_X86_REG_EBX, mesh)
            self.execute_range(0x10b0ee34, [0x10b0ef6e])
            state = {'active': bool(self.read(frame - 0x28, 'I')[0]),
                     'morph': bool(self.read(frame - 0xb4, 'I')[0]),
                     'start': self.read(frame - 0xa4, 'i')[0], 'vertexCount': count}
            output = base64.b64encode(bytes(self.cpu.mem_read(vertices, sample['frameVerts'] * 88))).decode()
            self.cpu.mem_write(scratch, b'\0' * scratch_size)
            self.write(frame - 0x34, 'I', scratch)
            self.write(frame - 0x58, 'i', -1)
            self.write(frame - 0x54, 'I', 0)
            self.write(frame + 0x28, 'I', 0x4000)
            faces = []
            for i in range(sample['arrays'][str(0x144)]['num']):
                self.cpu.reg_write(UC_X86_REG_EAX, i)
                self.write(frame - 0x3c, 'i', i)
                if state['active']:
                    stop = self.execute_range(0x10b0fc6f, [0x10b0fe60, 0x10b10117])
                    if stop == 0x10b10117:
                        continue
                    face = self.read(frame - 0x18, 'I')[0]
                    pointers = self.read(frame - 0x4c, '3I')
                else:
                    self.execute_range(0x10b10123, [0x10b101e8])
                    face = self.read(frame - 0x38, 'I')[0]
                    pointers = [self.cpu.reg_read(reg) for reg in [UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_ECX]]
                wedges = self.read(face, '3H')
                faces.append({'face': i, 'vertices': [(p-vertices)//88 for p in pointers],
                              'packed': [self.read(scratch + w*4, 'I')[0] for w in wedges]})
            rows.append({'name': case['name'], 'selection': selection, 'state': state, 'output': output,
                         'faces': faces, 'scratch': base64.b64encode(bytes(self.cpu.mem_read(scratch, scratch_size))).decode()})
        return {'name': sample['name'], 'cases': rows}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    rows = [probe.run_mesh(sample) for sample in json.load(sys.stdin)]
    print(json.dumps({'meshes': rows, 'tangents': probe.tangents}))
