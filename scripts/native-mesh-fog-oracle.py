"""Execute the original mesh fog path: FLightManager::Fog, URender's mesh face
helper and D3DDrv's DrawGouraudPolygon.

Optional research tool, never imported by the browser. Inputs, DLLs and
outputs stay local. The contract is recorded in .work/meshfog/notes.md until a
doc lands. Unchanged original code that runs here:

  Render.dll (607f1077...bd75d1)
    - FLightManager::Fog 0x10b02c00 over volumetric light infos prepared by
      ComputeFromActor's volumetric tail (0x10b06873-0x10b068dd and
      0x10b06a35-0x10b06c1c, as native-volumetric-fog-oracle.py runs them);
    - DrawLodMesh's per-vertex outcode block 0x10b10945-0x10b109e8 and its
      projection block 0x10b10a53-0x10b10a96;
    - the mesh face helper 0x10b0bab0 (environment and unlit pre-passes,
      frustum clipping with the FTransTexture operators 0x10b126a0,
      0x10b12810, 0x10b12530, the near-plane clipper 0x10b0cca0, the screen
      clamp) and its RenDev call (Frame->Viewport->RenDev vtable +0x78);
  D3DDrv.dll (9e0f8a42...d8ac9f)
    - UD3DRenderDevice::DrawGouraudPolygon 0x100056b0, reached through the
      real UD3DRenderDevice vtable 0x10018004, with the real SetBlending
      0x10008270;
    - SetTexture's stage MaxColor segment 0x10009439-0x1000949b (run once per
      case to give the device's +0xaa4 colour scale).

Serviced in Python (outside the contract; recorded, never invented):
    - SetTexture's body (0x10008a60) is replaced by `ret 0x10`; its MaxColor
      scale comes from the original segment above, and the stage U/V index
      and scale fields (+0xab4..+0xac0) come from the case;
    - IDirect3DDevice7 SetRenderState (+0x50), SetTextureStageState (+0x94),
      DrawPrimitiveVB (+0x7c) and IDirect3DVertexBuffer7 Lock (+0x0c) and
      Unlock (+0x10) are recorded; Lock hands out a local buffer;
    - FMemStack::PushBytes is the base oracle's bump allocator.
Every other import traps.

Precision: the render pass runs with x87 precision control 24
(docs/bsp-occlusion.md, "Precision"), so the default control word is 0x007f.
The light-manager tables (square root, fog attenuation) are built at 0x037f,
as the existing oracles do (FLightManager::Init runs outside the render pass;
the game thread's own control word there is still open).

  native-mesh-fog-oracle.py GAME_ROOT [CONTROL_WORD] < cases.json > out.json

Case kinds ("kind"):
  vertexFog  lights/order/vertices/missFlag as native-volumetric-fog-oracle.py
             -> per-vertex Fog FPlanes and the early-out flag;
  draw       device + frame + points (FTransTexture fields as float bits)
             -> DrawGouraudPolygon's vertex buffer, render/stage states;
  face       device + frame + points in camera space (+ Light, Fog or a
             vertexFog block computing Fog per point) + polyFlags
             -> outcodes, projection, face helper, D3D vertex buffer.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESI, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('volfog', Path(__file__).with_name('native-volumetric-fog-oracle.py'))
volfog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volfog)
lighting = volfog.lighting
native = lighting.native

D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'

# Render.dll
LIGHT_MANAGER, FOG = 0x10b3d2f0, 0x10b02c00
FACE_HELPER = 0x10b0bab0
OUTCODE = (0x10b10945, 0x10b109e8)
PROJECT = (0x10b10a53, 0x10b10a96)
UNLIT_COLOR = 0x10b4ea38           # three floats, DrawLodMesh 0x10b0f6d2
ENV_SCALE_U, ENV_SCALE_V = 0x10b4eac8, 0x10b4eaec
LIGHT_LIST, LIGHT_END, MISS = volfog.LIGHT_LIST, volfog.LIGHT_END, volfog.MISS
CORE_MATH = (                       # Render imports linked to Core's own bodies
    '?UnsafeNormal@FVector@@QBE?AV1@XZ', '??DFVector@@QBE?AV0@M@Z', '??GFVector@@QBE?AV0@ABV0@@Z',
    '??HFVector@@QBE?AV0@ABV0@@Z', '?TransformVectorBy@FVector@@QBE?AV1@ABVFCoords@@@Z',
    '?MirrorByVector@FVector@@QBE?AV1@ABV1@@Z', '??0FPlane@@QAE@ABV0@@Z', '??0FPlane@@QAE@MMMM@Z',
    '??0FVector@@QAE@MMM@Z', '??UFVector@@QBEMABV0@@Z', '?SizeSquared@FVector@@QBEMXZ')

# D3DDrv.dll
D3D_VTABLE = 0x10018004             # ??_7UD3DRenderDevice@@6BUObject@@@ (+0x78 DrawGouraudPolygon)
D3D_DRAW_GOURAUD, D3D_SET_TEXTURE, D3D_SET_BLENDING = 0x100056b0, 0x10008a60, 0x10008270
MAXCOLOR_SEGMENT = (0x10009439, 0x1000949b)
DEV_SIZE = 0xc00

HOOKS = lighting.STUBS + 0x800      # Python-serviced COM methods (0x800..0xfff)


def f32(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


class MeshFogOracle(volfog.FogOracle):
    def __init__(self, root, control_word):
        super().__init__(root)       # tables at 0x037f (see module doc)
        self.control_word = control_word
        cpu = self.cpu
        self.d3d = native.Image(Path(root) / 'System' / 'D3DDrv.dll', D3D_HASH)
        cpu.mem_map(self.d3d.base, (self.d3d.size + 4095) & ~4095)
        for _, _, virtual, raw_size, raw in self.d3d.sections:
            if raw_size:
                cpu.mem_write(self.d3d.base + virtual, self.d3d.data[raw:raw + raw_size])
        self.zero_cell, self.ugly_cell = self.alloc(16), self.alloc(16)
        self.hooks, cursor = {}, HOOKS

        def hook(name, handler, pop):
            nonlocal cursor
            address = cursor
            cpu.mem_write(address, struct.pack('<BH', 0xc2, pop) if pop else b'\xc3')
            self.hooks[address] = (name, handler)
            cursor += 0x10
            return address

        fail = hook('appFailAssert', self.fail_assert, 0)
        for library, symbol, slot in self.d3d.imports():
            target = lighting.TRAP
            if symbol == 'GTimestamp':
                target = self.zero_cell
            elif symbol == '?GUglyHackFlags@@3KA':
                target = self.ugly_cell
            elif symbol == '?appFailAssert@@YAXPBD0H@Z':
                target = fail
            self.write(slot, 'I', target)
        core = self.core.exports()
        for library, symbol, slot in self.render.imports():
            if library == 'core.dll' and symbol in CORE_MATH:
                self.write(slot, 'I', core[symbol])
            elif symbol == '?appFailAssert@@YAXPBD0H@Z':
                self.write(slot, 'I', fail)
        # COM objects: the device (+0x9a4) and the vertex buffer (+0xbc).
        self.device_vtable, self.vb_vtable = self.alloc(0x100), self.alloc(0x40)
        self.write(self.device_vtable + 0x50, 'I', hook('SetRenderState', self.set_render_state, 0xc))
        self.write(self.device_vtable + 0x94, 'I', hook('SetTextureStageState', self.set_stage_state, 0x10))
        self.write(self.device_vtable + 0x7c, 'I', hook('DrawPrimitiveVB', self.draw_primitive, 0x18))
        self.write(self.vb_vtable + 0x0c, 'I', hook('Lock', self.vb_lock, 0x10))
        self.write(self.vb_vtable + 0x10, 'I', hook('Unlock', self.vb_unlock, 4))
        cpu.hook_add(UC_HOOK_CODE, self.service, begin=HOOKS, end=HOOKS + 0x7ff)
        # SetTexture's body is outside the contract: `ret 0x10` (see module doc).
        cpu.mem_write(D3D_SET_TEXTURE, struct.pack('<BH', 0xc2, 0x10))
        cpu.hook_add(UC_HOOK_CODE, self.on_set_texture, begin=D3D_SET_TEXTURE, end=D3D_SET_TEXTURE)
        cpu.hook_add(UC_HOOK_CODE, self.on_draw_gouraud, begin=D3D_DRAW_GOURAUD, end=D3D_DRAW_GOURAUD)
        # The base oracle's GMem: Top/End for the face helper's inline pushes.
        self.arena = self.alloc(0x100000)
        self.case_top = self.alloc_top

    # -- Python-serviced COM methods -------------------------------------------------
    def service(self, cpu, address, size, data):
        if address in self.hooks:
            self.hooks[address][1](cpu)

    def arg(self, index):
        return self.read(self.cpu.reg_read(UC_X86_REG_ESP) + 4 + index * 4, 'I')[0]

    def fail_assert(self, cpu):
        raise RuntimeError('Original code failed an assertion; the fixture is incomplete')

    def set_render_state(self, cpu):
        self.events.append(['renderState', self.arg(1), self.arg(2)])
        cpu.reg_write(UC_X86_REG_EAX, 0)

    def set_stage_state(self, cpu):
        self.events.append(['stageState', self.arg(1), self.arg(2), self.arg(3)])
        cpu.reg_write(UC_X86_REG_EAX, 0)

    def vb_lock(self, cpu):
        self.write(self.arg(2), 'I', self.vertex_buffer)
        self.events.append(['lock', self.arg(1)])
        cpu.reg_write(UC_X86_REG_EAX, 0)

    def vb_unlock(self, cpu):
        cpu.reg_write(UC_X86_REG_EAX, 0)

    def draw_primitive(self, cpu):
        kind, start, count = self.arg(1), self.arg(3), self.arg(4)
        words = self.read(self.vertex_buffer + start * 32, f'{8 * count}I')
        self.events.append(['draw', kind, start, count])
        self.draws.append({'primitive': kind, 'start': start,
                           'vertices': [list(words[i * 8:i * 8 + 8]) for i in range(count)]})
        cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_set_texture(self, cpu, address, size, data):
        self.events.append(['setTexture', self.arg(0), self.arg(2)])

    def on_draw_gouraud(self, cpu, address, size, data):
        """The points DrawGouraudPolygon receives: Render's clipped/modified
        FTransTexture records (Screen, RZ, Light, Fog, U, V)."""
        pts, count, flags = self.arg(2), self.arg(3), self.arg(4)
        points = []
        for i in range(count):
            p = self.read(pts + i * 4, 'I')[0]
            w = self.read(p, '22I')
            points.append({'point': list(w[0:3]), 'outcode': w[3] & 0xff, 'screen': list(w[4:6]), 'intY': w[6],
                           'rz': w[7], 'light': list(w[12:16]), 'fog': list(w[16:20]), 'uv': list(w[20:22])})
        self.gouraud.append({'polyFlags': flags, 'points': points})

    # -- Fixtures ----------------------------------------------------------------------
    def reset_case(self):
        self.alloc_top = self.case_top
        self.events, self.draws, self.gouraud = [], [], []
        self.write(self.gmem, 'II', self.arena, self.arena + 0x100000)

    def max_color_scale(self, max_color):
        """SetTexture's stage MaxColor scale (0x10009439-0x1000949b), as
        native-mesh-light-oracle.py runs it, into a scratch device."""
        device, texture = self.alloc(DEV_SIZE), self.alloc(0x80)
        self.write(texture + 0x48, 'BBB', *max_color)
        ebp = self.frame()
        self.write(ebp - 0x4c, 'I', 0)
        self.cpu.reg_write(UC_X86_REG_ESI, texture)
        self.cpu.reg_write(lighting.UC_X86_REG_EDI, device)
        self.run(*MAXCOLOR_SEGMENT)
        return list(self.read(device + 0xaa4, '3I'))

    def device(self, spec):
        dev = self.alloc(DEV_SIZE)
        d3d, vb = self.alloc(0x10), self.alloc(0x10)
        self.write(d3d, 'I', self.device_vtable)
        self.write(vb, 'I', self.vb_vtable)
        self.vertex_buffer = self.alloc(0x500 * 32)
        scale = spec.get('scale') or self.max_color_scale(spec.get('maxColor', [255, 255, 255]))
        self.write(dev, 'I', D3D_VTABLE)
        self.write(dev + 0x9a4, 'I', d3d)
        self.write(dev + 0xbc, 'I', vb)
        self.write(dev + 0xc0, 'II', 0, spec.get('vbCursor', 0))
        self.write(dev + 0x9d0, 'I', spec.get('useVertexSpecular', 1))
        self.write(dev + 0x9fc, 'I', spec.get('stageScheme', 0))
        self.write(dev + 0xa6c, 'I', spec.get('currentPolyFlags', 0))
        self.write(dev + 0xaa4, '3I', *scale)
        self.write(dev + 0xa30, 'I', spec.get('proj33', f32(1.0)))
        self.write(dev + 0xa40, 'I', spec.get('proj43', f32(-1.0)))
        self.write(dev + 0xab4, 'II', spec.get('uIndex', 0), spec.get('vIndex', 1))
        self.write(dev + 0xabc, 'II', spec.get('uScale', f32(1 / 256)), spec.get('vScale', f32(1 / 256)))
        self.write(dev + 0xe0, 'I', spec.get('colorBits', 32))
        self.write(self.ugly_cell, 'I', spec.get('uglyHackFlags', 0))
        return dev, scale

    def scene_frame(self, spec, dev):
        """FSceneNode (SDK UnRender.h): Viewport, Mirror, NearClip, Coords,
        Uncoords, X/Y, XB/YB, FX..FY2, Proj, RProj, PrjXM..PrjYP."""
        frame, viewport = self.alloc(0x200), self.alloc(0x100)
        self.write(viewport + 0x64, 'I', dev)
        self.write(frame, 'I', viewport)
        self.write(frame + 0x20, 'I', spec.get('mirror', f32(1.0)))
        self.write(frame + 0x24, '4I', *spec.get('nearClip', [0, 0, 0, 0]))
        self.write(frame + 0x34, '12I', *spec.get('coords', [0] * 12))
        self.write(frame + 0x64, '12I', *spec.get('uncoords', [0] * 12))
        self.write(frame + 0xa8, 'iiii', *spec['size'], *spec.get('origin', [0, 0]))
        for offset, name in ((0xb8, 'fx'), (0xbc, 'fy'), (0xc0, 'fx15'), (0xc4, 'fy15'), (0xc8, 'fx2'),
                             (0xcc, 'fy2'), (0xd0, 'zoom'), (0xd4, 'projX'), (0xd8, 'projY'), (0xdc, 'projZ'),
                             (0xe0, 'rprojX'), (0xe4, 'rprojY'), (0xe8, 'rprojZ'), (0xec, 'prjXM'),
                             (0xf0, 'prjYM'), (0xf4, 'prjXP'), (0xf8, 'prjYP')):
            self.write(frame + offset, 'I', spec.get(name, 0))
        return frame

    def trans_texture(self, p):
        """FTransTexture (0x58): Point, outcode byte (+0xc), ScreenX/Y, IntY,
        RZ, Normal, Light, Fog, U, V."""
        record = self.alloc(0x58)
        self.write(record, '3I', *p['point'])
        if 'screen' in p:
            self.write(record + 0x10, '2I', *p['screen'])
        if 'rz' in p:
            self.write(record + 0x1c, 'I', p['rz'])
        self.write(record + 0x20, '4I', *p.get('normal', [0, 0, 0, 0]))
        self.write(record + 0x30, '4I', *p.get('light', [0, 0, 0, 0]))
        self.write(record + 0x40, '4I', *p.get('fog', [0, 0, 0, 0]))
        self.write(record + 0x50, '2I', *p.get('uv', [0, 0]))
        return record

    # -- Vertex fog (FLightManager::Fog) ------------------------------------------------
    def setup_volumetrics(self, spec):
        infos = [self.volumetric(light)[0] for light in spec['lights']]
        order = spec.get('order')
        if order is None:   # SetupForActor's qsort: a.z < b.z returns 1 (farther first)
            z = [struct.unpack('<f', struct.pack('<I', light['location'][2]))[0] for light in spec['lights']]
            order = sorted(range(len(infos)), key=lambda i: -z[i])
        self.write(LIGHT_LIST, f'{len(order)}I', *[infos[i] for i in order]) if order else None
        self.write(LIGHT_END, 'I', LIGHT_LIST + 4 * len(order))
        self.write(MISS, 'I', spec.get('missFlag', 0))
        return infos

    def vertex_fog(self, position, flags=0x40000000):
        point, plane = self.alloc(0x58), self.alloc(0x10)
        self.write(point, '3I', *position)
        self.call(FOG, [plane, point, flags], LIGHT_MANAGER)
        return list(self.read(plane, '4I'))

    def case_vertex_fog(self, case):
        self.setup_volumetrics(case)
        flags = case.get('flags', 0x40000000)
        planes = [self.vertex_fog(v, flags) for v in case['vertices']]
        return {'vertices': planes, 'missFlag': self.read(MISS, 'I')[0]}

    # -- D3D DrawGouraudPolygon directly -------------------------------------------------
    def case_draw(self, case):
        dev, scale = self.device(case.get('device', {}))
        frame = self.scene_frame(case['frame'], dev)
        records = [self.trans_texture(p) for p in case['points']]
        pts = self.alloc(4 * len(records))
        self.write(pts, f'{len(records)}I', *records)
        info = self.alloc(0x80)
        self.call(D3D_DRAW_GOURAUD, [frame, info, pts, len(records), case['polyFlags'], 0], this=dev)
        return {'scale': scale, 'draws': self.draws, 'events': self.events,
                'currentPolyFlags': self.read(dev + 0xa6c, 'I')[0]}

    # -- Render face helper -> D3D --------------------------------------------------------
    def case_face(self, case):
        dev, scale = self.device(case.get('device', {}))
        frame = self.scene_frame(case['frame'], dev)
        if 'unlit' in case:
            self.write(UNLIT_COLOR, '3I', *case['unlit'])
        if 'envScale' in case:
            self.write(ENV_SCALE_U, 'I', case['envScale'][0])
            self.write(ENV_SCALE_V, 'I', case['envScale'][1])
        records = [self.trans_texture(p) for p in case['points']]
        fog = case.get('vertexFog')
        if fog:     # DrawLodMesh's per-vertex Fog, in vertex order, before the faces
            self.setup_volumetrics(fog)
            for p, record in zip(case['points'], records):
                self.write(record + 0x40, '4I', *self.vertex_fog(p['point'], fog.get('flags', 0x40000000)))
        prepared = []
        for record in records:
            ebp = self.frame()
            self.write(ebp + 8, 'I', frame)
            self.write(ebp + 0x10, 'I', record)
            self.run(*OUTCODE)
            if self.read(record + 0xc, 'B')[0] == 0:
                ebp = self.frame()
                self.write(ebp + 8, 'I', frame)
                self.cpu.reg_write(UC_X86_REG_ESI, record)
                self.run(*PROJECT)
            w = self.read(record, '22I')
            prepared.append({'outcode': w[3] & 0xff, 'screen': list(w[4:6]), 'intY': w[6], 'rz': w[7],
                             'fog': list(w[16:20])})
        pts = self.alloc(16)
        self.write(pts, '3I', *records[:3])
        info, span = self.alloc(0x80), 0
        self.call(FACE_HELPER, [frame, info, span, pts, case['polyFlags'], case.get('depth', 0)])
        after = [list(self.read(record + 0x30, '4I')) for record in records]
        return {'scale': scale, 'prepared': prepared, 'gouraud': self.gouraud, 'draws': self.draws,
                'events': self.events, 'lightAfter': after, 'missFlag': self.read(MISS, 'I')[0]}

    def run_case(self, case):
        self.reset_case()
        kind = case['kind']
        if kind == 'vertexFog':
            return self.case_vertex_fog(case)
        if kind == 'draw':
            return self.case_draw(case)
        if kind == 'face':
            return self.case_face(case)
        raise ValueError(f'unknown case kind {kind}')


def main():
    root = Path(sys.argv[1])
    control_word = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x007f
    cases = json.load(sys.stdin)
    oracle = MeshFogOracle(root, control_word)
    out = []
    for case in cases:
        try:
            out.append(oracle.run_case(case))
        except Exception as error:   # a fixture gap is reported per case, never papered over
            out.append({'error': f'{type(error).__name__}: {error}'})
    json.dump({'controlWord': control_word, 'results': out}, sys.stdout)


if __name__ == '__main__':
    main()
