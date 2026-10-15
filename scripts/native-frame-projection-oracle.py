"""Original frame projection reference (docs/frame-projection.md).

Optional research tool, never imported by the browser. Executes the unchanged
vertex chain from a frame's camera-space points to the vertices URenderDevice
receives, so Play's GPU transform can be compared bit for bit:

  * BSP surfaces: Render.dll URender::CreateMasterFrame and OccludeBsp
    (ClipBspSurf transforms each model point into the frame's view space and
    projects it, Rasterize clamps ScreenY of polygons that leave the frame)
    through scripts/native-occlusion-oracle.py, then D3DDrv.dll
    UD3DRenderDevice::DrawComplexSurface over each draw list's saved polygons
    (Engine FSurfaceFacet), once per frame (the main frame and every child
    frame). The vertex buffer it fills is read back: ScreenX/Y + XB/YB - 0.5,
    depth and RHW, 0x24 bytes a vertex (single-texture path).
  * Meshes: DrawLodMesh's outcode loop (0x10b0efd3..0x10b0f073) and vertex
    projection (0x10b10a53..0x10b10a96) on camera-space points, then
    UD3DRenderDevice::DrawGouraudPolygon, 0x20 bytes a vertex.
  * D3DDrv's depth constants: UD3DRenderDevice::SetRes' projection matrix
    (0x1000c40f..0x1000c45b) at the case's ViewportColorBits.

D3DDrv.dll and Render.dll run at the render pass's control word 0x007f
(URender::PreRender's appEnableFastMath, docs/render-pass-precision.md).
SetTexture (0x100010a5) and the Direct3D COM objects are replaced by stubs
that return success and record their arguments; Lock hands out a vertex
buffer. SetBlending (0x10008270) is the original's. Every other instruction
of the two functions is the original's.

The detail-texture pass (D3DDrv 0x1000486e..0x10004d0b, docs/frame-projection.md
"Detail textures"): a draw list's surface that has a DetailTexture runs it as
`Surface + 0x18`. Its inputs come from the original too: the facet's MapCoords
in view space are Render.dll DrawFrame's own block (0x10b1aab7..0x10b1ab23, the
origin) and Core's FVector::TransformVectorBy (0x10119e40, the texture axes)
over the frame's Coords; the stage values SetTexture(0, DetailTexture) leaves
(UIndex, VIndex, UScale, VScale: SetTexture's body at 0x10008e15..0x10008e97
and 0x10009405..0x100094b0) are those instructions' run over the detail
texture's FTextureInfo on a scratch device. What the stubs leave out of
SetTexture, the cache's size choice (the first mip within the device's maximum
size, the shift), is an input: the first mip's size, shift 0. The calls the
pass makes (SetBlending's SetRenderState calls, SetTextureStageState,
SetRenderState, SetTexture, DrawPrimitiveVB with each fan's vertices and the
layer and polygon it was built for) are recorded in order.

Inputs arrive as JSON on stdin (the occlusion oracle's request with
`d3d: true`, or `{"projection": [...]}` cases); results are written to stdout.
A case with `detail: true` runs the pass for the surfaces whose model entry
(`surfs[i].detail`) has a detail texture.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EIP, UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_ESI,
                               UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('occ', Path(__file__).with_name('native-occlusion-oracle.py'))
occ = importlib.util.module_from_spec(spec)
spec.loader.exec_module(occ)
native = occ.native

D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'
RENDER_PASS_CW = 0x007f
# D3DDrv.dll.
SET_TEXTURE = 0x100010a5                                    # thunk (4 stdcall-style arguments)
DRAW_COMPLEX_SURFACE, DRAW_GOURAUD_POLYGON = 0x10003900, 0x100056b0
SET_RES_DEPTH = (0x1000c40f, 0x1000c45b)                    # ZBias/ZScale of the projection matrix
# SetTexture: a new cache bin's UIndex/VIndex/UMult/VMult (from the mip's size, the shift and the info's UScale/VScale), then the
# stage's fields from the bin.
SETTEXTURE_BIN = (0x10008e15, 0x10008e97)
SETTEXTURE_STAGE = (0x10009405, 0x100094b0)
# Render.dll DrawLodMesh: the outcode block of one vertex (it leaves al = the
# flags and stores them at [ecx+0xc]) and the projection of an inside vertex.
MESH_OUTCODE = (0x10b0efd3, 0x10b0f076)
MESH_PROJECT = (0x10b10a53, 0x10b10a96)
# Render.dll DrawFrame: a surface's MapCoords origin into view space (esi = [ebp-0x4c] the world origin, edx = [ebp-0x18] the
# frame's Coords, edi = [ebp-0x28] the result); the texture axes are Core's FVector::TransformVectorBy (thiscall, a result
# pointer and the FCoords on the stack).
FACET_ORIGIN = (0x10b1aab7, 0x10b1ab23)
TRANSFORM_VECTOR_BY = 0x10119e40
PF_PORTAL = 0x04000000   # Render.dll's gate: no detail texture on these (0x10b1a8e6)
VB_BYTES = 0x100000
PLAIN_VERTEX = 0x24     # DrawComplexSurface, one texture
GOURAUD_VERTEX = 0x20   # DrawGouraudPolygon


class FrameProjection(occ.Occlusion):
    def __init__(self, root, tangents):
        super().__init__(root, tangents)
        cpu, root = self.cpu, Path(root)
        d3d = native.Image(root / 'System' / 'D3DDrv.dll', D3D_HASH)
        cpu.mem_map(d3d.base, (d3d.size + 4095) & ~4095)
        cpu.mem_write(d3d.base, d3d.data[:1024])
        for _, _, virtual, raw_size, raw in d3d.sections:
            if raw_size:
                cpu.mem_write(d3d.base + virtual, d3d.data[raw:raw + raw_size])
        core = native.Image(root / 'System' / 'Core.dll', native.HASHES['Core.dll'])
        core_exports = core.exports()
        for _, symbol, slot in d3d.imports():
            if symbol == '?GUglyHackFlags@@3KA':
                self.write(slot, 'I', core_exports[symbol])
            elif symbol in ('GTimestamp', '?GIsEditor@@3HA', '?GLog@@3PAVFOutputDevice@@A'):
                self.write(slot, 'I', self.alloc(16))     # pointers to zeroed variables
        # SetTexture(4 arguments) returns at once; its hook records the call and leaves the stage fields the detail texture's
        # SetTexture would have (stage_for).
        cpu.mem_write(SET_TEXTURE, bytes.fromhex('c21000'))
        cpu.hook_add(UC_HOOK_CODE, self.on_set_texture, begin=SET_TEXTURE, end=SET_TEXTURE)
        self.recording, self.calls, self.detail_stage = False, [], {}
        self.vb = self.alloc(VB_BYTES)
        lock = bytes.fromhex('8b44240cc700') + struct.pack('<I', self.vb) + bytes.fromhex('31c0c21000')
        self.vb_object = self.com({0xc: lock, 0x10: bytes.fromhex('31c0c20400')})
        # IDirect3DDevice7: SetRenderState (+0x50, 2 arguments), DrawPrimitiveVB (+0x7c, 5), SetTextureStageState (+0x94, 3).
        self.d3d_object = self.com({0x50: self.recording_stub('rs', 3, 0xc), 0x7c: self.recording_stub('draw', 6, 0x18),
                                    0x94: self.recording_stub('tss', 4, 0x10)})
        # The devices live outside the cases' fixtures (a case's allocations
        # are released and zeroed after it).
        self.devices = {}
        for color_bits in (16, 32):
            self.d3d_device(color_bits)
        self.current_frame = None

    def call_native(self, address, this, args, control_word, count=0):
        try:
            return super().call_native(address, this, args, control_word, count)
        except UcError as error:
            raise RuntimeError(f'{error} at {self.cpu.reg_read(UC_X86_REG_EIP):#x}; blocks {[hex(b) for b in self.blocks]}') from error

    def load(self, request):
        self.request_model = request['model']
        super().load(request)

    def com(self, methods):
        vtable, obj = self.alloc(4 * 64), self.alloc(16)
        self.write(obj, 'I', vtable)
        for offset, code in methods.items():
            self.write(vtable + offset, 'I', code if isinstance(code, int) else self.code(code))
        return obj

    def recording_stub(self, kind, words, pop):
        """A COM method that returns 0 (`ret pop`) and, while a DrawComplexSurface runs, records its arguments (the `words`
        stack words after the return address are `this` and the arguments) in order."""
        address = self.code(bytes.fromhex('31c0c2') + struct.pack('<H', pop))

        def on_call(cpu, at, size, data):
            if not self.recording:
                return
            esp = cpu.reg_read(UC_X86_REG_ESP)
            event = {'op': kind, 'args': list(self.read(esp + 8, f'{words - 1}I'))}
            if kind == 'draw':
                # DrawComplexSurface's frame: [ebp-0x40] the layers left (2 - the layer), [ebp-0x14] the polygon's first vertex.
                ebp = cpu.reg_read(UC_X86_REG_EBP)
                prim, vb, start, count = event['args'][:4]
                event.update(prim=prim, start=start, count=count, layer=2 - self.read(ebp - 0x40, 'i')[0],
                             first=self.read(ebp - 0x14, 'i')[0],
                             vertices=self.vertices(self.vb + PLAIN_VERTEX * start, count, PLAIN_VERTEX, 9))
            self.calls.append(event)
        self.cpu.hook_add(UC_HOOK_CODE, on_call, begin=address, end=address)
        return address

    def on_set_texture(self, cpu, address, size, data):
        if not self.recording:
            return
        esp = cpu.reg_read(UC_X86_REG_ESP)
        stage, info = self.read(esp + 4, '2I')
        self.calls.append({'op': 'texture', 'stage': stage, 'info': 'detail' if info in self.detail_stage else 'base'})
        if info in self.detail_stage:
            # The stage fields SetTexture(0, DetailTexture) leaves: UIndex, VIndex, UScale, VScale.
            device = cpu.reg_read(UC_X86_REG_ECX)
            self.write(device + 0xab4, '4I', *self.detail_stage[info])

    # -- UD3DRenderDevice ---------------------------------------------------------
    def d3d_device(self, color_bits):
        """A device object whose depth constants SetRes computed (the real
        instructions 0x1000c40f..0x1000c45b, game-thread control word)."""
        if color_bits in self.devices:
            return self.devices[color_bits]
        device = self.alloc(0x1000)
        self.write(device + 0xbc, 'I', self.vb_object)
        self.write(device + 0xc8, 'I', self.vb_object)
        self.write(device + 0x9a4, 'I', self.d3d_object)
        self.write(device + 0xe0, 'I', color_bits)
        self.write(device + 0x78, 'I', 1)                     # URenderDevice.DetailTextures (SetRes clears it without the cap)
        self.write(device + 0xa00, 'I', 4)                    # the stage's saved COLOROP the pass restores (D3DTOP_MODULATE)
        self.write(device + 0xaa4, '3f', 1.0, 1.0, 1.0)      # Stages[0].MaxColor
        self.write(device + 0xab4, 'ii', 0, 1)                # UIndex, VIndex
        self.write(device + 0xabc, 'ff', 1.0, 1.0)            # UScale, VScale
        cpu = self.cpu
        cpu.reg_write(UC_X86_REG_ESI, device)
        cpu.reg_write(UC_X86_REG_EBX, 0)
        cpu.reg_write(UC_X86_REG_ESP, self.stack - 0x100)
        for reg, value in [(UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            cpu.reg_write(reg, value)
        cpu.emu_start(SET_RES_DEPTH[0], SET_RES_DEPTH[1])
        self.devices[color_bits] = device
        return device

    def depth_constants(self, color_bits):
        device = self.d3d_device(color_bits)
        return {'zBias': self.read(device + 0xa30, 'I')[0], 'm34': self.read(device + 0xa34, 'I')[0],
                'zScale': self.read(device + 0xa40, 'I')[0]}

    def vertices(self, base, count, stride, fields=4):
        raw = bytes(self.cpu.mem_read(base, stride * count))
        return [list(struct.unpack_from(f'<{fields}I', raw, stride * i)) for i in range(count)]

    def draw_gouraud(self, frame, points, color_bits=32):
        """DrawGouraudPolygon(Frame, Info, Pts, NumPts, PolyFlags, Span) over
        FTransTexture records already in memory: its vertices (sx, sy, sz, rhw)."""
        device = self.d3d_device(color_bits)
        self.write(device + 0xc0, 'II', 0, 0)
        array = self.alloc(4 * len(points))
        self.write(array, f'{len(points)}I', *points)
        self.call_native(DRAW_GOURAUD_POLYGON, device, struct.pack('<6I', frame, 0, array, len(points), 0, 0), RENDER_PASS_CW)
        return self.vertices(self.vb, len(points), GOURAUD_VERTEX)

    def run_block(self, bounds, ebp, **registers):
        """Run `bounds` (begin, until) with an ebp frame the caller filled and the pass' control word."""
        cpu = self.cpu
        for name, value in registers.items():
            cpu.reg_write({'esi': UC_X86_REG_ESI}[name], value)
        cpu.reg_write(UC_X86_REG_EBP, ebp)
        cpu.reg_write(UC_X86_REG_ESP, ebp - 0x100)
        for reg, value in [(UC_X86_REG_FPCW, RENDER_PASS_CW), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            cpu.reg_write(reg, value)
        cpu.emu_start(bounds[0], bounds[1])

    def stage_for(self, info, detail):
        """UIndex, VIndex, UScale, VScale (words) that SetTexture(0, info) leaves in stage 0: its instructions over a scratch
        device and cache bin, with the first mip's size and shift 0 (the cache's size choice is an input)."""
        scratch, device, bin_ = self.alloc(0x400), self.alloc(0x1000), self.alloc(0x80)
        ebp = scratch + 0x300
        self.write(ebp + 8, 'II', 0, info)               # Tex, Info
        self.write(ebp + 0x10, '2I', 0, 0)
        self.write(ebp - 0x14, 'I', device)
        self.write(ebp - 0x1c, 'I', detail['uSize'])     # the mip's U size, V size and the shift
        self.write(ebp - 0x44, 'I', detail['vSize'])
        self.write(ebp - 0x24, 'I', 0)
        self.write(ebp - 0x28, 'I', 1)
        self.run_block(SETTEXTURE_BIN, ebp, esi=bin_)
        self.run_block(SETTEXTURE_STAGE, ebp, esi=bin_)
        return list(self.read(device + 0xab4, '4I'))

    def facet_view(self, frame, surf):
        """The surface's MapCoords in the frame's view space, as Render.dll DrawFrame makes them: the origin (its inline
        block) and the U and V axes (FVector::TransformVectorBy over the frame's Coords). Float words: origin, U, V."""
        model = self.request_model
        scratch = self.alloc(0x400)
        ebp = scratch + 0x300
        coords = frame + 0x34
        source, result = scratch, scratch + 0x20
        self.write(source, '3I', *model['pointBits'][surf['base']])
        self.write(ebp - 0x4c, 'I', source)
        self.write(ebp - 0x18, 'I', coords)
        self.write(ebp - 0x28, 'I', result)
        self.run_block(FACET_ORIGIN, ebp)
        out = [list(self.read(result, '3I'))]
        for index in (surf['textureU'], surf['textureV']):
            vector, answer = scratch + 0x40, scratch + 0x60
            self.write(vector, '3I', *model['vectorBits'][index])
            self.call_native(TRANSFORM_VECTOR_BY, vector, struct.pack('<2I', answer, coords), RENDER_PASS_CW)
            out.append(list(self.read(answer, '3I')))
        return out

    def draw_complex_surface(self, frame, polys, color_bits=32, detail=None, facet_view=None):
        """DrawComplexSurface(Frame, Surface, Facet) for one draw list's saved
        polygons (single texture, no light map): its vertices per polygon. With
        `detail` (the surface's detail texture: sizes, UScale/VScale and Pan words) and
        the facet's view-space coordinates, Surface.DetailTexture is set and the pass'
        recorded calls are left in `self.calls`."""
        device = self.d3d_device(color_bits)
        self.write(device + 0xc0, 'II', 0, 0)
        self.write(device + 0xcc, 'II', 0, 0)
        self.write(device + 0x9b4, 'I', 0)         # multitexture off: the single-texture path
        self.write(device + 0xa6c, 'I', 0)         # SetBlending's remembered flags: each call starts from the same state
        self.write(device + 0xab4, 'ii', 0, 1)
        self.write(device + 0xabc, 'ff', 1.0, 1.0)
        surface, texture, facet = self.alloc(0x40), self.alloc(0x100), self.alloc(0x80)
        self.write(surface + 0xc, 'I', texture)
        self.detail_stage = {}
        if detail:
            info, max_color = self.alloc(0x100), self.alloc(16)
            self.write(info + 4, '2I', 1, 0)                           # CacheID
            self.write(info + 0x14, '3I', *detail['panBits'], 0)       # Pan
            self.write(info + 0x20, 'I', max_color)                    # MaxColor, which the pass sets to white
            self.write(info + 0x28, '2I', *detail['scaleBits'])        # UScale, VScale
            self.write(surface + 0x18, 'I', info)
            self.detail_stage = {info: self.stage_for(info, detail)}
        if facet_view:
            self.write(facet, '9I', *facet_view[0], *facet_view[1], *facet_view[2])
            self.write(facet + 0x24, '3f', 0, 0, 0)
        else:
            self.write(facet, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        self.write(facet + 0x30, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        self.write(facet + 0x64, 'I', polys)
        count, link = 0, polys
        while link:
            count += self.read(link + 0xc, 'I')[0]
            link = self.read(link, 'I')[0]
        self.calls, self.recording = [], True
        try:
            self.call_native(DRAW_COMPLEX_SURFACE, device, struct.pack('<3I', frame, surface, facet), RENDER_PASS_CW)
        finally:
            self.recording = False
        return self.vertices(self.vb, count, PLAIN_VERTEX)

    # -- BSP surfaces ---------------------------------------------------------------
    def occlude_frame(self, frame, specs, root):
        self.current_frame = frame
        self.point_pv = {}
        return super().occlude_frame(frame, specs, root)

    def model_points(self):
        """FTransform pointer -> model point index for the last OccludeBsp's
        point cache (entries stamped with the current Stamp)."""
        cache = self.read(occ.POINT_CACHE, 'I')[0]
        stamp = self.read(occ.STAMP, 'I')[0]
        raw = bytes(self.cpu.mem_read(cache, 8 * int(self.read(self.model + 0x88 + 4, 'I')[0])))
        found = {}
        for pv, (pointer, entry_stamp) in enumerate(struct.iter_unpack('<II', raw)):
            if entry_stamp == stamp and pointer:
                found[pointer] = pv
        return found

    def draw_list(self, head):
        out = super().draw_list(head)
        if not getattr(self, 'd3d', False) or self.current_frame is None:
            return out
        frame = self.current_frame
        pv = self.model_points()
        link = head
        for entry in out:
            polys, saved = self.read(link + 0x44, 'I')[0], []
            poly = polys
            while poly:
                saved.append(poly)
                poly = self.read(poly, 'I')[0]
            surf = self.request_model['surfs'][entry['iSurf']] if 0 <= entry['iSurf'] < len(self.request_model['surfs']) else None
            detail = surf.get('detail') if surf and getattr(self, 'detail', False) and not entry['polyFlags'] & PF_PORTAL else None
            facet_view = self.facet_view(frame, surf) if detail and polys else None
            vertices = self.draw_complex_surface(frame, polys, self.color_bits, detail, facet_view) if polys else []
            if detail and polys:
                entry['detail'] = {'facet': facet_view, 'stage': next(iter(self.detail_stage.values())), 'calls': self.calls,
                                   'counts': [len(r['points']) for r in entry['polys']]}
            cursor = 0
            for poly, record in zip(saved, entry['polys']):
                count = len(record['points'])
                pointers = [self.read(poly + 16 + 4 * k, 'I')[0] for k in range(count)]
                record['pv'] = [pv.get(p, -1) for p in pointers]
                record['d3d'] = vertices[cursor:cursor + count]
                cursor += count
            link = self.read(link + 0x38, 'I')[0]
        return out

    def run_case(self, case):
        self.d3d = bool(case.get('d3d'))
        self.detail = bool(case.get('detail'))
        self.color_bits = case.get('colorBits', 32)
        result = super().run_case(case)
        if self.d3d:
            result['depth'] = self.depth_constants(self.color_bits)
            result['depth16'] = self.depth_constants(16)
        return result

    # -- meshes ---------------------------------------------------------------------
    def run_projection(self, case):
        mark = self.heap
        try:
            return self.mesh_points(case)
        finally:
            self.heap = mark

    def mesh_points(self, case):
        """The master frame of `case` (CreateMasterFrame and the render pass'
        ComputeRenderSize, as run_case does), then every camera-space point:
        DrawLodMesh's outcode block, its projection when the flags are zero
       , and DrawGouraudPolygon's vertices."""
        self.write(self.viewport + 0x78, 'ii', case['width'], case['height'])
        self.write(self.actor + 0x410, 'f', case['fov'])
        location = struct.pack('<3I', *case['locationBits'])
        rotation = struct.pack('<3i', *case['rotation'])
        frame = self.call_native(occ.CREATE_MASTER_FRAME, self.render,
                                 struct.pack('<I', self.viewport) + location + rotation + struct.pack('<I', 0),
                                 case.get('masterControlWord', 0x037f))
        render = case.get('render')
        if render:
            self.write(frame + 0xa8, '2i', render['width'], render['height'])
            self.write(frame + 0xb0, '2i', render.get('x', 0), render.get('y', 0))
            self.call_native(occ.COMPUTE_RENDER_SIZE, frame, b'', 0x007f)
        color_bits = case.get('colorBits', 32)
        scratch = self.alloc(0x400)
        out = []
        for point in case['pointBits']:
            record = self.alloc(0x60)
            self.write(record, '3I', *point)
            self.write(record + 0xc, 'I', 0)
            self.write(record + 0x30, '3f', 0.5, 0.5, 0.5)
            ebp = scratch + 0x200
            self.write(ebp + 8, 'I', frame)
            self.write(ebp - 0x18, 'I', record)
            self.run_range(MESH_OUTCODE, record, ebp, frame)
            record_out = {'flags': self.read(record + 0xc, 'B')[0], 'point': list(point)}
            if record_out['flags'] == 0:
                self.run_range(MESH_PROJECT, record, ebp, frame)
                record_out['transform'] = list(self.read(record, '8I'))
                record_out['d3d'] = self.draw_gouraud(frame, [record] * 3, color_bits)[0]
            out.append(record_out)
        return {'frameBits': list(self.read(frame + 0x34, '12I')) + list(self.read(frame + 0xb8, '17I')) +
                             list(self.read(frame + 0xfc, '28I')),
                'xb': list(self.read(frame + 0xa8, '4i')), 'points': out,
                'depth': self.depth_constants(color_bits)}

    def run_range(self, bounds, record, ebp, frame):
        cpu = self.cpu
        cpu.reg_write(UC_X86_REG_ECX, record)
        cpu.reg_write(UC_X86_REG_ESI, record)
        cpu.reg_write(UC_X86_REG_EBP, ebp)
        cpu.reg_write(UC_X86_REG_ESP, ebp - 0x100)
        cpu.reg_write(UC_X86_REG_EAX, frame)
        for reg, value in [(UC_X86_REG_FPCW, RENDER_PASS_CW), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            cpu.reg_write(reg, value)
        cpu.emu_start(bounds[0], bounds[1])


if __name__ == '__main__':
    request = json.load(sys.stdin)
    oracle = FrameProjection(request['gameRoot'], request.get('tangents', {}))
    oracle.load(request)
    results = [oracle.run(case) for case in request.get('cases', [])]
    projection = [oracle.run_projection(case) for case in request.get('projection', [])]
    json.dump({'results': results, 'projection': projection}, sys.stdout, separators=(',', ':'))
    print()
