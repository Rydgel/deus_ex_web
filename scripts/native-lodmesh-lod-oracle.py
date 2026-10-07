"""Unchanged original DrawLodMesh LOD ranges (docs/script-lodmesh-lod.md).

Executes the original Render.dll bytes of URender::DrawLodMesh's three LOD
ranges at the render pass's x87 control word (0x007f, precision control 24;
docs/render-pass-precision.md; ORACLE_CW overrides it):

* selection `10b0eb52..10b0ed53`: the requested vertex count, the float
  detail, the LOD and morph flags;
* post-frame morph `10b0ee34..10b0ef6e` after GetFrame's returned count;
* reduced face admission and wedge collapse `10b0fc6f..10b0fe60` (a face
  above the count leaves at `10b10117`), or the full-resolution corner reads
  `10b10123..10b101e8` when the LOD flag is clear.

GetFrame is not executed: the sample supplies its output buffer and the
returned count (docs/script-lodmesh-frame.md validates GetFrame itself).
Core's appTan (FLD m64, FPTAN, FSTP st(0)) runs, but Unicorn computes FPTAN
in double precision, which is not the hardware's extended result; the
caller's FSTP m32 of the tangent is therefore replaced at `10b0ebe5` by the
sample's `tanBits` for the recorded argument (the hardware-measured model,
scripts/validate-x87-tan-hardware.mjs), and Unicorn's own value is recorded.

stdin: a JSON list of meshes {name, arrays: {offset: {num, data}}, scalars,
frameVerts, vertices (88-byte FTransTexture buffer, base64), cases: [...]}.
argv: game root, optional control word. Captures stay outside Git.
"""
import base64
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX,
                              UC_X86_REG_EDI, UC_X86_REG_ESI, UC_X86_REG_EBP,
                              UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_FPCW,
                              UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('materials', Path(__file__).with_name('native-lodmesh-materials-oracle.py'))
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)
APP_TAN = 0x10123260  # Core appTan body: FLD m64, FPTAN, FSTP st(0), RET.
TAN_STORED = 0x10b0ebe5  # after DrawLodMesh's FST m64 / FSTP m32 of appTan's result.
STRIDE = 88  # sizeof(FTransTexture); +0x50 is U, where the morph stores alpha.
STOPS = [0x10b0ed53, 0x10b0ef6e, 0x10b0fe60, 0x10b10117, 0x10b101e8]


class Probe(materials.Probe):
    def __init__(self, root, control_word):
        super().__init__(root)
        self.control_word = control_word
        self.stops, self.tan_input, self.tan_events, self.inject = set(), None, [], None
        # Hooks at the addresses this probe acts on instead of a Python call
        # per instruction; unresolved imports (the thunk page) still fail.
        self.cpu.hook_del(self.code_hook)
        for address in [APP_TAN, TAN_STORED, *STOPS, self.done]:
            self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=address, end=address)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=0x70000000, end=0x700fffff)

    def on_instruction(self, cpu, address, size, data):
        if address in self.stops:
            cpu.emu_stop()
            return
        if address == APP_TAN:
            self.tan_input = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'Q')[0]
        elif address == TAN_STORED:
            at = cpu.reg_read(UC_X86_REG_EBP) - 0x3c
            emulated = self.read(at, 'I')[0]
            argument = f'{self.tan_input:016x}'
            injected = self.inject.get(argument) if self.inject else None
            if injected is None and self.control_word == 0x007f:
                raise RuntimeError(f'No measured appTan float for argument {argument}')
            # Another control word (the precision audit) computes another
            # argument; Unicorn's double-precision tangent stands for it.
            if injected is None:
                injected = emulated
            self.write(at, 'I', injected)
            self.tan_events.append({'argument': argument, 'unicorn': emulated, 'injected': injected})
        super().on_instruction(cpu, address, size, data)

    def execute_range(self, start, stops, this=0):
        self.stops = set(stops)
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this), (UC_X86_REG_FPCW, self.control_word),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.emu_start(start, self.done + 1, count=2000000)
        stopped = self.cpu.reg_read(UC_X86_REG_EIP)
        if stopped not in self.stops:
            raise RuntimeError(f'Unexpected LOD range exit {stopped:x}: {list(self.trace)}')
        self.stops = set()
        return stopped

    def run_mesh(self, sample):
        mesh, renderer, actor, viewer, viewport, scene = [self.alloc(n) for n in [0x1b0, 0x100, 0x700, 0x700, 0x100, 0x180]]
        frame = self.alloc(0x200) + 0x140
        coords = self.alloc(48)
        for offset, array in sample['arrays'].items():
            data = base64.b64decode(array['data'])
            address = self.alloc(max(4, len(data)))
            self.cpu.mem_write(address, data)
            self.write(mesh + int(offset), '3I', address, array['num'], array['num'])
        frame_verts = sample['frameVerts']
        vertices = self.alloc(frame_verts * STRIDE)
        wedge_count = sample['arrays'][str(0x15c)]['num']
        scratch = self.alloc(max(4, wedge_count * 4))
        face_count = sample['arrays'][str(0x144)]['num']
        self.write(viewport + 0x30, 'I', viewer)
        self.write(scene, 'I', viewport)
        rows = []
        for case in sample['cases']:
            self.tan_events = []
            self.inject = case['tanBits']
            self.cpu.mem_write(frame - 0x140, b'\0' * 0x200)
            for offset, value in sample['scalars'].items():
                self.write(mesh + int(offset), 'I', value)
            for offset, value in case.get('meshBits', {}).items():
                self.write(mesh + int(offset), 'I', value)
            collapse = sample['arrays'][str(0x12c)]['num']
            self.write(mesh + 0x130, 'I', 0 if case.get('noCollapse') else collapse)
            settings = case['settings']
            self.write(renderer + 0x40, '2fif', settings['shapeLOD'], settings['adjust'], settings['mode'], settings['fix'])
            self.write(actor + 0x64, 'I', case['lodBiasBits'])
            self.write(actor + 0x114, '3I', *case['locationBits'])
            self.write(actor + 0x17c, 'I', case['drawScaleBits'])
            self.write(viewer + 0x410, 'I', case['fovBits'])
            self.write(scene + 0xb8, 'I', case['fxBits'])
            self.write(coords, '12I', *case['coordsBits'])
            self.write(frame + 8, 'I', scene)
            self.write(frame + 0xc, 'I', actor)
            self.write(frame + 0x1c, 'I', coords)
            self.write(frame - 0x40, 'I', renderer)
            self.cpu.reg_write(UC_X86_REG_EBP, frame)
            self.cpu.reg_write(UC_X86_REG_EBX, mesh)
            self.cpu.reg_write(UC_X86_REG_EDI, renderer)
            self.cpu.reg_write(UC_X86_REG_ESI, 0)
            self.execute_range(0x10b0eb52, [0x10b0ed53], viewport)
            selection = {'detailBits': self.read(frame - 0x54, 'I')[0], 'requested': self.read(frame - 0x14, 'i')[0],
                         'active': self.read(frame - 0x28, 'I')[0], 'morph': self.read(frame - 0xb4, 'I')[0],
                         'location': list(self.read(frame - 0x7c, '3I')),
                         'tan': self.tan_events}
            # GetFrame's in/out count: the sample's reduction of the request.
            count = case.get('returnedCount', selection['requested'])
            if not (0 < count <= selection['requested'] <= frame_verts):
                raise RuntimeError(f'{case["name"]}: invalid returned count {count} for {selection}')
            self.write(frame - 0x14, 'i', count)
            self.cpu.mem_write(vertices, base64.b64decode(sample['vertices']))
            ordinary = vertices + self.read(mesh + 0x184, 'I')[0] * STRIDE
            # DrawLodMesh reuses these slots for the GetFrame buffer pointers.
            self.write(frame - 0x58, 'I', vertices)
            self.write(frame - 0x5c, 'I', ordinary)
            self.write(frame - 0x60, 'I', mesh)
            self.cpu.reg_write(UC_X86_REG_EBX, mesh)
            self.execute_range(0x10b0ee34, [0x10b0ef6e])
            state = {'active': self.read(frame - 0x28, 'I')[0], 'morph': self.read(frame - 0xb4, 'I')[0],
                     'start': self.read(frame - 0xa4, 'i')[0], 'count': count,
                     'startBits': self.read(frame + 0x1c, 'I')[0]}
            output = base64.b64encode(bytes(self.cpu.mem_read(vertices, frame_verts * STRIDE))).decode()
            # The face loop's state as 0x10b0fbf2..0x10b0fc54 leaves it.
            self.cpu.mem_write(scratch, b'\0' * max(4, wedge_count * 4))
            self.write(frame - 0x34, '3I', scratch, wedge_count, wedge_count)
            self.write(frame - 0x58, 'i', -1)
            self.write(frame - 0x54, 'I', 0)
            self.write(frame + 0x28, 'I', 0x4000)
            faces = []
            for i in range(face_count):
                self.cpu.reg_write(UC_X86_REG_EBP, frame)
                self.cpu.reg_write(UC_X86_REG_EAX, i)
                self.write(frame - 0x3c, 'i', i)
                if state['active']:
                    stop = self.execute_range(0x10b0fc6f, [0x10b0fe60, 0x10b10117])
                    if stop == 0x10b10117:
                        faces.append({'face': i, 'admitted': False})
                        continue
                    pointers = self.read(frame - 0x4c, '3I')
                else:
                    self.execute_range(0x10b10123, [0x10b101e8])
                    pointers = [self.cpu.reg_read(reg) for reg in [UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_ECX]]
                material, flags = self.read(frame - 0x58, '2I')
                if any((p - ordinary) % STRIDE for p in pointers):
                    raise RuntimeError(f'{case["name"]} face {i}: unaligned vertex pointer')
                faces.append({'face': i, 'admitted': True, 'vertices': [(p - ordinary) // STRIDE for p in pointers],
                              'material': material, 'flags': flags})
            rows.append({'name': case['name'], 'selection': selection, 'state': state, 'output': output, 'faces': faces,
                         'scratch': base64.b64encode(bytes(self.cpu.mem_read(scratch, wedge_count * 4))).decode()})
        return {'name': sample['name'], 'cases': rows}


if __name__ == '__main__':
    word = int(sys.argv[2], 0) if len(sys.argv) > 2 else materials.native.render_control_word(0x007f)
    probe = Probe(Path(sys.argv[1]), word)
    rows = [probe.run_mesh(sample) for sample in json.load(sys.stdin)]
    print(json.dumps({'controlWord': word, 'meshes': rows}))
