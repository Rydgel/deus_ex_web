"""Original decal clipping and drawing reference (docs/decals.md "Drawing").

Optional research tool, never imported by the browser. For each requested
camera it builds the frame with the unchanged URender::CreateMasterFrame and
URender::OccludeBsp exactly as scripts/native-occlusion-oracle.py does (that
module is reused); with `children` OccludeBsp's CreateChildFrame calls run the
original 0x10b15a40 and every child (mirror) frame gets its own OccludeBsp.
It attaches FDecal fixtures to drawn surfaces of every frame and executes,
under control word 0x007f (the render pass precision, docs/bsp-occlusion.md
"Precision"):

* clip:  URender::ClipDecal (Render.dll 0x10b1bda0) for every (decal, draw
         item, saved polygon) of the decal's surface: return value, NumPts and
         every produced FTransTexture as raw dwords;
* draw:  UD3DRenderDevice::DrawGouraudPolygon (D3DDrv.dll 0x100056b0) on each
         nonempty clip result with PolyFlags 0x40 (PF_Modulated), as DrawFrame
         calls it: the vertex-buffer bytes, render/texture-stage state calls
         and the DrawPrimitiveVB arguments;
* block: URender::DrawFrame's decal block (0x10b1b0ca..0x10b1b34d) for a whole
         draw item: gates, texture Get/Lock/Unlock batching, the Nodes filter,
         ClipDecal and DrawGouraudPolygon calls, LastRenderedTime stamps and
         the DECAL# counter;
* uvScale: D3DDrv SetTexture's texture-coordinate scale instructions
         (0x10008e15..0x10008e97) for each texture fixture; the device's
         projection Q/-Q come from SetRes's own instructions 0x1000c40f..0x1000c455.

Everything else executed is original code. Bridges (no behavior invented):
msvcrt memmove behind Core appMemmove (C semantics); fake COM objects for the
IDirect3DDevice7 and vertex buffer (record and return D3D_OK); UTexture's
Update/Lock/Unlock in block mode (record; Lock fills the FTextureInfo fields
from the fixture as UTexture::Lock 0x103ecc90 does at LOD 0); D3DDrv SetTexture
(thunk 0x100010a5) replaced by a recorder that applies only the stage
bookkeeping of 0x10008a96..0x10008aab and 0x10009405..0x1000949e with the
scale values the original instructions produced in the uvScale step.

Fixtures supply only fields the instructions read; unmapped access and null
objects trap; unresolved imports trap. Input JSON on stdin, output JSON on
stdout. Original DLLs, inputs and results stay local.
"""
import importlib.util
import json
import random
import struct
import sys
from math import cos, sin, sqrt
from pathlib import Path

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_ECX, UC_X86_REG_EDI,
                               UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP, UC_X86_REG_FPCW,
                               UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('occlusion', Path(__file__).with_name('native-occlusion-oracle.py'))
occlusion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(occlusion)
native = occlusion.native

D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'
CLIP_DECAL = 0x10b1bda0            # URender::ClipDecal (thunk 0x10b01069)
CLIP_STATICS_GUARD = 0x10b5a608    # function-static init bits 1|2|4
WORLD_PTS, POLY_PTS, DIST = 0x10b504b8, 0x10b568e8, 0x10b59328
PTR_ARRAY, TRANS_PTS = 0x10b56a7c, 0x10b56ae0   # FTransTexture* [24], FTransTexture [24] (0x58)
BLOCK_START, BLOCK_END = 0x10b1b0ca, 0x10b1b34d
DECAL_COUNT = 0x10b595b4           # stat DECAL#
# Engine.dll class objects (PrivateStaticClass exports), compared by address.
AMOVER_CLASS, ABRUSH_CLASS = 0x1058bb58, 0x10582a28
D3D_VTABLE = 0x10018004            # ??_7UD3DRenderDevice@@6BUObject@@@
D3D_DRAW_GOURAUD = 0x100056b0
D3D_SET_TEXTURE_THUNK = 0x100010a5
UV_SNIPPET, UV_SNIPPET_END = 0x10008e15, 0x10008e97
SENTINEL = 0xcdcdcdcd
CW_RENDER = 0x007f


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


def from_bits(word):
    return struct.unpack('<f', struct.pack('<I', word & 0xffffffff))[0]


class DecalRender(occlusion.Occlusion):
    def __init__(self, root, tangents):
        super().__init__(root, tangents)
        self.root = Path(root)
        self.load_d3d()
        cpu = self.cpu
        # The three function statics of ClipDecal (two FVector[24] with
        # FVector's empty constructor and an FTransTexture[24] without one)
        # count as constructed, which skips the atexit registrations.
        self.write(CLIP_STATICS_GUARD, 'B', 7)
        self.events = None
        self.hooks = {}
        cpu.hook_add(UC_HOOK_CODE, self.on_stub, begin=occlusion.HEAP, end=occlusion.HEAP + occlusion.HEAP_SIZE - 1)
        # msvcrt memmove behind Core appMemmove (0x10123370).
        core = native.Image(self.root / 'System' / 'Core.dll', native.HASHES['Core.dll'])
        memmove = self.stub(0, self.on_memmove, cdecl=True)
        for dll, symbol, iat in core.imports():
            if dll == 'msvcrt.dll' and symbol == 'memmove':
                self.write(iat, 'I', memmove)
        cpu.hook_add(UC_HOOK_CODE, self.on_set_texture, begin=D3D_SET_TEXTURE_THUNK, end=D3D_SET_TEXTURE_THUNK)
        cpu.hook_add(UC_HOOK_CODE, self.on_clip_entry, begin=CLIP_DECAL, end=CLIP_DECAL)
        cpu.hook_add(UC_HOOK_CODE, self.on_draw_entry, begin=D3D_DRAW_GOURAUD, end=D3D_DRAW_GOURAUD)
        self.make_d3d()

    # -- images and stubs ------------------------------------------------------
    def load_d3d(self):
        cpu = self.cpu
        image = native.Image(self.root / 'System' / 'D3DDrv.dll', D3D_HASH)
        cpu.mem_map(image.base, (image.size + 4095) & ~4095)
        cpu.mem_write(image.base, image.data[:1024])
        for _, _, virtual, size, raw in image.sections:
            if size:
                cpu.mem_write(image.base + virtual, image.data[raw:raw + size])
        exports = {name.lower(): native.Image(self.root / 'System' / name, digest).exports()
                   for name, digest in native.HASHES.items()}
        thunk = 0x70080000
        for dll, symbol, iat in image.imports():
            address = exports.get(dll, {}).get(symbol)
            if address is None:
                address = thunk
                thunk += 16
                self.thunks[address] = (dll, symbol)
            self.write(iat, 'I', address)

    def stub(self, arg_bytes, handler, cdecl=False):
        """A heap stub `ret N` whose handler runs before the ret executes."""
        address = self.code(b'\xc3' if cdecl else b'\xc2' + struct.pack('<H', arg_bytes))
        self.hooks[address] = handler
        return address

    def on_stub(self, cpu, address, size, data):
        handler = self.hooks.get(address)
        if handler:
            handler(cpu.reg_read(UC_X86_REG_ESP))

    def on_memmove(self, esp):
        dst, src, count = self.read(esp + 4, '3I')
        if count:
            self.cpu.mem_write(dst, bytes(self.cpu.mem_read(src, count)))
        self.cpu.reg_write(UC_X86_REG_EAX, dst)

    def com_object(self, methods):
        """A COM object whose listed vtable slots are recording stubs."""
        obj = self.alloc(16)
        vtable = self.alloc(0x200)
        self.cpu.mem_write(vtable, struct.pack('<128I', *([self.trap_stub] * 128)))
        for slot, (arg_bytes, handler) in methods.items():
            self.write(vtable + slot, 'I', self.stub(arg_bytes, handler))
        self.write(obj, 'I', vtable)
        return obj

    # -- D3D device fixture ----------------------------------------------------
    def make_d3d(self):
        """UD3DRenderDevice fields DrawGouraudPolygon/SetBlending read."""
        self.vertex_buffer = self.alloc(0x500 * 0x20 + 0x100)
        self.d3d_device = self.com_object({
            0x50: (0xc, self.on_render_state), 0x94: (0x10, self.on_stage_state),
            0x7c: (0x18, self.on_draw_primitive_vb), 0x8c: (0xc, self.on_d3d_set_texture)})
        self.d3d_vb = self.com_object({0x0c: (0x10, self.on_vb_lock), 0x10: (4, self.on_vb_unlock)})
        dev = self.dev = self.alloc(0x1000)
        self.write(dev, 'I', D3D_VTABLE)

    def setup_d3d(self, config):
        dev = self.dev
        self.cpu.mem_write(dev + 4, bytes(0x1000 - 4))
        self.write(dev + 0x48, 'I', config.get('spanBased', 0))
        self.write(dev + 0x9a4, 'I', self.d3d_device)
        self.write(dev + 0xbc, 'I', self.d3d_vb)
        self.write(dev + 0xc0, 'II', 0, config.get('vertexOffset', 0))
        self.write(dev + 0xe0, 'I', config.get('colorBits', 32))
        self.write(dev + 0x9d0, 'I', config.get('fog', 0))
        self.write(dev + 0xa6c, 'I', config.get('currentPolyFlags', 0x80000000))
        self.write(dev + 0x9fc, 'I', config.get('multitexture', 1))
        self.write(dev + 0x9ac, 'II', config.get('useMipmapping', 1), config.get('useTrilinear', 0))
        self.write(dev + 0x1b0, 'I', config.get('has8888', 1))
        # SetRes 0x1000c40f..0x1000c455 (projection _33/_43), executed below.
        self.run_snippet(0x1000c40f, 0x1000c45b, {UC_X86_REG_ESI: dev}, CW_RENDER)
        self.stage_cache = {}

    def run_snippet(self, start, end, registers, control_word, frame=None):
        esp = self.stack - 0x800
        regs = {UC_X86_REG_ESP: esp, UC_X86_REG_EBP: frame or (self.stack - 0x400),
                UC_X86_REG_FPCW: control_word, UC_X86_REG_FPSW: 0, UC_X86_REG_FPTAG: 0xffff}
        regs.update(registers)
        for reg, value in regs.items():
            self.cpu.reg_write(reg, value)
        self.cpu.emu_start(start, end)
        if self.cpu.reg_read(UC_X86_REG_EIP) != end:
            raise RuntimeError(f'Snippet {start:#x} did not reach {end:#x}')

    # -- recorders -------------------------------------------------------------
    def log(self, *entry):
        if self.events is not None:
            self.events.append(list(entry))

    def on_render_state(self, esp):
        _, state, value = self.read(esp + 4, '3I')
        self.log('SetRenderState', state, value)
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_stage_state(self, esp):
        _, stage, state, value = self.read(esp + 4, '4I')
        self.log('SetTextureStageState', stage, state, value)
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_d3d_set_texture(self, esp):
        _, stage, surface = self.read(esp + 4, '3I')
        self.log('D3DSetTexture', stage, surface)
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_vb_lock(self, esp):
        _, flags, out, size = self.read(esp + 4, '4I')
        self.write(out, 'I', self.vertex_buffer)
        self.log('VBLock', flags)
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_vb_unlock(self, esp):
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_draw_primitive_vb(self, esp):
        _, primitive, vb, start, count, flags = self.read(esp + 4, '6I')
        vertices = [list(self.read(self.vertex_buffer + 0x20 * (start + i), '8I')) for i in range(count)]
        self.log('DrawPrimitiveVB', primitive, start, count, flags, vertices)
        self.cpu.reg_write(UC_X86_REG_EAX, 0)

    def on_set_texture(self, cpu, address, size, data):
        """SetTexture(Stage, Info, PolyFlags, bPrecache): the stage cache test
        of 0x10008a96..0x10008aab and, on a miss, the stage copy of
        0x10009405..0x1000949e (the upload itself is not modelled)."""
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret, stage, info, flags, precache = self.read(esp, '5I')
        dev = cpu.reg_read(UC_X86_REG_ECX)
        cache = self.read(info + 4, 'II')
        st = dev + 0xa9c + stage * 0x2c
        hit = tuple(self.read(st, 'II')) == cache
        self.log('SetTexture', stage, list(cache), flags, precache, 'hit' if hit else 'miss')
        if not hit and not precache:
            item = self.uv_items[cache]
            self.write(st + 0x20, 'II', item['uMultBits'], item['vMultBits'])
            self.write(st + 0x18, 'II', item['uSlot'], item['vSlot'])
            self.write(st, 'II', *cache)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + 0x10)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def on_clip_entry(self, cpu, address, size, data):
        if self.events is None:
            return
        esp = cpu.reg_read(UC_X86_REG_ESP)
        _, frame, decal, model, surf, poly = self.read(esp, '6I')
        self.log('ClipDecal', self.decal_index.get(decal, decal), self.poly_index.get(poly, poly))

    def on_draw_entry(self, cpu, address, size, data):
        if self.events is None:
            return
        esp = cpu.reg_read(UC_X86_REG_ESP)
        _, frame, info, pts, count, flags, span = self.read(esp, '7I')
        self.log('DrawGouraudPolygon', count, flags, self.span_index.get(span, span),
                 list(self.read(info + 4, 'II')))

    # -- textures --------------------------------------------------------------
    def make_textures(self, specs):
        """UTexture fixtures: vtable slots Update 0x78 (FTime), Lock 0x54,
        Unlock 0x58; AnimCur at +0x90 (docs/texture-animation.md)."""
        self.textures = []
        for i, spec in enumerate(specs):
            t = self.alloc(0x100)
            vtable = self.alloc(0x200)
            self.cpu.mem_write(vtable, struct.pack('<128I', *([self.trap_stub] * 128)))
            self.write(vtable + 0x78, 'I', self.stub(8, lambda esp, i=i: self.on_tex_update(i, esp)))
            self.write(vtable + 0x54, 'I', self.stub(0x14, lambda esp, i=i: self.on_tex_lock(i, esp)))
            self.write(vtable + 0x58, 'I', self.stub(4, lambda esp, i=i: self.on_tex_unlock(i, esp)))
            self.write(t, 'I', vtable)
            self.write(t + 4, 'I', 0x1000 + i)
            self.textures.append(t)
        for t, spec in zip(self.textures, specs):
            if spec.get('animCur') is not None:
                self.write(t + 0x90, 'I', self.textures[spec['animCur']])
        self.texture_index = {t: i for i, t in enumerate(self.textures)}
        self.texture_specs = specs
        # D3DDrv SetTexture's scale instructions per texture (mode uvScale).
        self.uv_items = {}
        out = []
        for i, spec in enumerate(specs):
            info = self.texture_info(i, self.alloc(0x90))
            item = self.alloc(0x60)
            frame = self.alloc(0x100) + 0x80
            self.write(frame - 0x28, 'I', 0)
            self.write(frame - 0x1c, 'I', spec['usize'])
            self.write(frame - 0x44, 'I', spec['vsize'])
            self.write(frame + 0xc, 'I', info)
            self.write(frame - 0x18, 'I', 0)
            self.write(frame - 0x24, 'I', spec.get('mip', 0))
            self.write(frame - 0x14, 'I', self.dev)
            self.write(frame - 0x2c, 'I', 0)
            self.run_snippet(UV_SNIPPET, UV_SNIPPET_END, {UC_X86_REG_ESI: item}, CW_RENDER, frame=frame)
            u_slot, v_slot, u_mult, v_mult = self.read(item + 0x38, '4I')
            entry = {'uSlot': u_slot, 'vSlot': v_slot, 'uMultBits': u_mult, 'vMultBits': v_mult}
            self.uv_items[tuple(self.read(info + 4, 'II'))] = entry
            out.append(entry)
        return out

    def texture_info(self, index, info):
        """FTextureInfo as UTexture::Lock (Engine 0x103ecc90) leaves it at
        LOD 0: UScale = VScale = f32((Mips[0].USize/Mips[0].USize) * Scale)."""
        spec = self.texture_specs[index]
        self.cpu.mem_write(info, bytes(0x88))
        self.write(info, 'I', self.textures[index])
        self.write(info + 4, 'II', 0x1000 + index, 0xe0)
        self.write(info + 0x20, 'I', self.textures[index] + 0x48)
        self.write(info + 0x24, 'I', spec.get('format', 0))
        self.write(info + 0x28, 'II', spec['scaleBits'], spec['scaleBits'])
        self.write(info + 0x30, '4i', spec['usize'], spec['vsize'], spec['usize'], spec['vsize'])
        self.write(info + 0x40, 'ii', 1, 0)
        return info

    def on_tex_update(self, index, esp):
        self.log('Update', index, list(self.read(esp + 4, 'II')))

    def on_tex_lock(self, index, esp):
        info, t0, t1, lod, rendev = self.read(esp + 4, '5I')
        self.log('Lock', index, lod, 'renDev' if rendev == self.dev else rendev)
        self.texture_info(index, info)

    def on_tex_unlock(self, index, esp):
        self.log('Unlock', index)

    # -- level fixtures --------------------------------------------------------
    def load(self, request):
        super().load(request)
        model = request['model']
        vectors = model['vectorBits']
        data = self.alloc(12 * max(1, len(vectors)))
        self.cpu.mem_write(data, struct.pack(f'<{3 * len(vectors)}I', *[v for t in vectors for v in t]))
        self.write(self.model + 0x78, 'III', data, len(vectors), len(vectors))
        self.surf_data = self.read(self.model + 0x98, 'I')[0]
        for i, surf in enumerate(model['surfs']):
            self.write(self.surf_data + 64 * i + 8, '4i', surf['base'], surf['normal'], surf['textureU'], surf['textureV'])
        self.model_json = model
        # Surface-owner fixtures for the IsA(AMover) walk: a brush, and a mover
        # whose class's SuperField is Engine's AMover class object.
        self.brush = self.alloc(0x200)
        self.write(self.brush + 0x24, 'I', ABRUSH_CLASS)
        mover_class = self.alloc(0x40)
        self.write(mover_class + 0x28, 'I', AMOVER_CLASS)
        self.mover = self.alloc(0x200)
        self.write(self.mover + 0x24, 'I', mover_class)
        self.client = self.alloc(0x100)
        self.write(self.viewport + 0x18, 'I', self.client)
        self.write(self.actor + 0xa8, 'I', self.level_info)

    def point(self, index):
        return [from_bits(v) for v in self.model_json['pointBits'][index]]

    def vector(self, index):
        return [from_bits(v) for v in self.model_json['vectorBits'][index]]

    def node_polygon(self, i_node):
        node = self.model_json['nodes'][i_node]
        verts = self.model_json['verts']
        return [self.point(verts[node['vertexPool'] + k][0]) for k in range(node['vertexCount'])]

    # -- frames ----------------------------------------------------------------
    def draw_items(self, frame):
        items = []
        for lst in range(3):
            head, k = self.read(frame + 0x98 + 4 * lst, 'I')[0], 0
            while head:
                i_node, i_surf, i_zone, key, flags = self.read(head, '4iI')
                polys, p = [], self.read(head + 0x44, 'I')[0]
                while p:
                    nxt, poly_node, _, n = self.read(p, 'IiII')
                    pts = [list(self.read(self.read(p + 16 + 4 * j, 'I')[0], '8I')) for j in range(n)]
                    polys.append({'address': p, 'iNode': poly_node, 'points': pts})
                    p = nxt
                items.append({'list': lst, 'index': k, 'address': head, 'iNode': i_node, 'iSurf': i_surf,
                              'polyFlags': flags, 'polys': polys})
                head, k = self.read(head + 0x38, 'I')[0], k + 1
        return items

    def frames(self, camera, children=False):
        """CreateMasterFrame + OccludeBsp as native-occlusion-oracle.py run().
        With children, OccludeBsp's CreateChildFrame calls (vslot 0x68) run the
        original 0x10b15a40 and each child gets its own OccludeBsp after its
        parent, depth first in Child/Sibling order, as OccludeFrame
        (0x10b19fc0) recurses (its SetupDynamics/light bookkeeping omitted)."""
        for address, fields in self.stacks.items():
            self.write(address, '4I', *fields)
        self.write(self.viewport + 0x78, 'ii', camera['width'], camera['height'])
        self.write(self.actor + 0x410, 'f', camera['fov'])
        self.write(self.level_info + 0x478, 'I', camera.get('timeBits', 0))
        self.write(occlusion.FRAME_COUNTER, 'I', camera.get('frameCounter', 0))
        self.write(self.render + 0x68, 'II', 0, 0)
        location = struct.pack('<3I', *camera['locationBits'])
        rotation = struct.pack('<3i', *camera['rotation'])
        master = self.call_native(occlusion.CREATE_MASTER_FRAME, self.render,
                                  struct.pack('<I', self.viewport) + location + rotation + struct.pack('<I', 0), 0x037f)
        if children:
            self.write(self.vtable + 0x68, 'I', self.read(occlusion.URENDER_VTABLE + 0x68, 'I')[0])
        out = []
        try:
            def occlude(frame, parent, depth):
                post = self.alloc(4 * self.num_nodes)
                self.write(self.render + 0xec, 'II', 0, post)
                self.call_native(occlusion.OCCLUDE_BSP, self.render, struct.pack('<I', frame), CW_RENDER)
                count, post = self.read(self.render + 0xec, 'II')
                for i in range(count):
                    self.write(self.read(post + 4 * i, 'I')[0], 'II', 0, 0)
                index = len(out)
                out.append({'address': frame, 'parent': parent, 'depth': depth, 'items': self.draw_items(frame)})
                child = self.read(frame + 0x10, 'I')[0]
                while child:
                    occlude(child, index, depth + 1)
                    child = self.read(child + 0xc, 'I')[0]
            occlude(master, None, 0)
        finally:
            self.write(self.vtable + 0x68, 'I', self.child_stub)
        return out

    # -- decals ----------------------------------------------------------------
    def decal_actor(self, spec):
        actor = self.alloc(0x340)
        self.write(actor + 0xa8, 'I', self.level_info)
        texture = spec.get('texture')
        self.write(actor + 0x16c, 'I', self.textures[texture] if texture is not None else 0)
        self.write(actor + 0x17c, 'I', spec['drawScaleBits'])
        self.write(actor + 0x18c, 'I', spec['scaleGlowBits'])
        self.write(actor + 0x190, 'B', spec['ambientGlow'])
        self.write(actor + 0x31c, 'I', SENTINEL)
        return actor

    def write_decal(self, address, spec, actor):
        self.cpu.mem_write(address, bytes(0x4c))
        self.write(address, '12I', *[w for v in spec['vertexBits'] for w in v])
        nodes = spec.get('nodes', [])
        data = self.alloc(4 * max(1, len(nodes)))
        if nodes:
            self.write(data, f'{len(nodes)}i', *nodes)
        self.write(address + 0x30, 'IIii', actor, data if nodes else 0, len(nodes), len(nodes))
        self.write(address + 0x40, '3i', *spec.get('moverRotation', [0, 0, 0]))

    def set_surf_actor(self, i_surf, owner):
        surf = self.surf_data + 64 * i_surf
        if owner is None:
            self.write(surf + 0x24, 'I', 0)
        elif owner == 'brush':
            self.write(surf + 0x24, 'I', self.brush)
        else:
            self.write(self.mover + 0x120, '3i', *owner['mover'])
            self.write(surf + 0x24, 'I', self.mover)

    def clip(self, frame, decal, i_surf, poly, control_word=CW_RENDER):
        """One ClipDecal call; the statics are filled with a sentinel first so
        fields the original never writes stay visible as 0xcdcdcdcd."""
        self.cpu.mem_write(TRANS_PTS, b'\xcd' * (24 * 0x58))
        self.cpu.mem_write(PTR_ARRAY, b'\xcd' * (24 * 4))
        out = self.alloc(8)
        self.write(out, 'II', SENTINEL, SENTINEL)
        surf = self.surf_data + 64 * i_surf
        ret = self.call_native(CLIP_DECAL, self.render,
                               struct.pack('<7I', frame, decal, self.model, surf, poly, out, out + 4), control_word)
        pts, num = self.read(out, 'II')
        points = []
        if num != SENTINEL and 0 < num <= 24:
            for i in range(num):
                p = self.read(pts + 4 * i, 'I')[0]
                points.append(list(self.read(p, '22I')))
        return {'ret': ret, 'numPts': num, 'ptsArray': pts, 'points': points}

    def draw(self, frame, info, num, span):
        """DrawGouraudPolygon(Frame, Info, Pts, NumPts, PF_Modulated, Span) on
        the last ClipDecal output, as DrawFrame 0x10b1b286..0x10b1b2a7 calls it."""
        self.events = []
        self.call_native(D3D_DRAW_GOURAUD, self.dev,
                         struct.pack('<6I', frame, info, PTR_ARRAY, num, 0x40, span), CW_RENDER)
        events, self.events = self.events, None
        return events

    def candidates(self, items):
        return [it for it in items if it['polys'] and self.model_json['nodes'][it['iNode']]['vertexCount'] >= 3]

    def make_spec(self, rng, item, location, kind=None):
        """One synthetic but realistic FDecal on a drawn surface: a quad in the
        surface plane around a point inside / on an edge / at a vertex of one
        of the item's node polygons, or under the camera; offsets from the
        surface base as AttachDecal stores them (vertex order V0..V3 with
        V1-V0 along the decal U axis and V3-V0 along V)."""
        surf = self.model_json['surfs'][item['iSurf']]
        n = self.vector(surf['normal'])
        length = sqrt(sum(c * c for c in n)) or 1.0
        n = [c / length for c in n]
        base = self.point(surf['base'])
        poly = rng.choice(item['polys'])
        verts = self.node_polygon(poly['iNode'] if poly['iNode'] >= 0 else item['iNode'])
        kind = kind or rng.choice(['inside', 'inside', 'edge', 'edge', 'vertex', 'big', 'camera'])
        if kind in ('inside', 'big'):
            w = [rng.random() + 0.05 for _ in verts]
            total = sum(w)
            c = [sum(wk * v[a] for wk, v in zip(w, verts)) / total for a in range(3)]
        elif kind == 'edge':
            k, u = rng.randrange(len(verts)), rng.random()
            a, b = verts[k], verts[(k + 1) % len(verts)]
            c = [a[i] + (b[i] - a[i]) * u for i in range(3)]
        elif kind == 'vertex':
            c = list(rng.choice(verts))
        else:
            c = list(location)
        d = sum((c[i] - base[i]) * n[i] for i in range(3))
        c = [c[i] - d * n[i] for i in range(3)]
        tu = self.vector(surf['textureU'])
        dot = sum(tu[i] * n[i] for i in range(3))
        tu = [tu[i] - dot * n[i] for i in range(3)]
        tl = sqrt(sum(x * x for x in tu)) or 1.0
        tu = [x / tl for x in tu]
        tv = [n[1] * tu[2] - n[2] * tu[1], n[2] * tu[0] - n[0] * tu[2], n[0] * tu[1] - n[1] * tu[0]]
        angle = rng.choice([0.0, 0.0, rng.uniform(0, 6.283185307179586)])
        ua = [cos(angle) * tu[i] + sin(angle) * tv[i] for i in range(3)]
        va = [n[1] * ua[2] - n[2] * ua[1], n[2] * ua[0] - n[0] * ua[2], n[0] * ua[1] - n[1] * ua[0]]
        if rng.random() < 0.3:
            va = [-x for x in va]
        h = rng.choice([1.5, 4, 8, 16, 32, 64]) * rng.uniform(0.75, 1.25)
        if kind in ('big', 'camera'):
            h *= 8
        hv = h * rng.choice([1.0, 1.0, 0.5, 2.0])
        corners = [[c[i] + su * h * ua[i] + sv * hv * va[i] for i in range(3)]
                   for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        spec = {
            'iSurf': item['iSurf'], 'kind': kind,
            'vertexBits': [[bits(p[i] - base[i]) for i in range(3)] for p in corners],
            'drawScaleBits': bits(rng.choice([1.0, 1.0, 0.5, 0.25, 1.4, 2.0])),
            'scaleGlowBits': bits(rng.choice([1.0, 1.0, 0.5, 2.0, 0.0])),
            'ambientGlow': rng.choice([0, 0, 64, 255]),
            'texture': rng.randrange(len(self.textures)),
            'surfActor': 'brush',
        }
        r = rng.random()
        if r < 0.12:
            rot = [rng.randrange(-4096, 4096), rng.randrange(0, 65536), rng.randrange(-2048, 2048)]
            spec['surfActor'] = {'mover': rot}
            spec['moverRotation'] = rot if rng.random() < 0.5 else [
                rot[0] + rng.randrange(-600, 600), rot[1] + rng.randrange(-3000, 3000), rot[2]]
        elif r < 0.2:
            spec['surfActor'] = None
        return spec

    def generate(self, rng, camera, items, config):
        decals = []
        candidates = self.candidates(items)
        rng.shuffle(candidates)
        location = [from_bits(v) for v in camera['locationBits']]
        for item in candidates[:config.get('surfaces', 12)]:
            for _ in range(config.get('perSurface', 3)):
                decals.append(self.make_spec(rng, item, location))
        return decals

    def generate_blocks(self, rng, camera, items, config):
        """DrawFrame decal-block fixtures: 2-5 decals on one surface, runs of
        equal textures (batching), an AnimCur texture, a null texture
        (DefaultTexture), Nodes lists that admit one polygon / none / all,
        and the gates (Client.Decals 0, SpanBased 1) and Sprite override."""
        blocks = []
        candidates = self.candidates(items)
        rng.shuffle(candidates)
        location = [from_bits(v) for v in camera['locationBits']]
        variants = config.get('variants', ['plain', 'plain', 'override', 'noDecals', 'spanBased', 'plain'])
        for b, item in enumerate(candidates[:config.get('count', 6)]):
            specs = []
            texture = rng.randrange(len(self.textures))
            for k in range(rng.randrange(2, 6)):
                spec = self.make_spec(rng, item, location, kind=rng.choice(['inside', 'edge', 'big']))
                spec['surfActor'] = 'brush'
                spec.pop('moverRotation', None)
                if rng.random() < 0.4:
                    texture = rng.randrange(len(self.textures))
                spec['texture'] = None if rng.random() < 0.1 else texture
                r = rng.random()
                if r < 0.25:
                    spec['nodes'] = [rng.choice(item['polys'])['iNode']]
                elif r < 0.35:
                    spec['nodes'] = [len(self.model_json['nodes']) + 7]
                specs.append(spec)
            variant = variants[b % len(variants)]
            block = {'item': [item['list'], item['index']], 'decals': specs, 'variant': variant}
            if variant == 'override':
                block['override'] = rng.randrange(len(self.textures))
            elif variant == 'noDecals':
                block['clientDecals'] = 0
            elif variant == 'spanBased':
                block['spanBased'] = 1
            blocks.append(block)
        return blocks

    def run_frame(self, request_frame, d3d_config):
        camera = request_frame['camera']
        frames = self.frames(camera, request_frame.get('children', False))
        rng = random.Random(request_frame.get('seed', 1))
        self.setup_d3d(d3d_config)
        out = []
        for f_index, fr in enumerate(frames):
            frame, items = fr['address'], fr['items']
            decals = [d for d in request_frame.get('decals', []) if d.get('frame', 0) == f_index]
            if 'generate' in request_frame:
                decals += self.generate(rng, camera, items, request_frame['generate'])
            by_surf = {}
            for k, it in enumerate(items):
                by_surf.setdefault(it['iSurf'], []).append(k)
            cases = []
            for d_index, spec in enumerate(decals):
                surf_json = self.model_json['surfs'][spec['iSurf']]
                spec['surfBaseBits'] = self.model_json['pointBits'][surf_json['base']]
                spec['surfNormalBits'] = self.model_json['vectorBits'][surf_json['normal']]
                actor = self.decal_actor(spec)
                decal = self.alloc(0x4c)
                self.write_decal(decal, spec, actor)
                self.set_surf_actor(spec['iSurf'], spec.get('surfActor', 'brush'))
                texture = spec.get('texture')
                info = self.texture_info(texture, self.alloc(0x90)) if texture is not None else None
                for k in by_surf.get(spec['iSurf'], []):
                    item = items[k]
                    for p_index, poly in enumerate(item['polys']):
                        if d3d_config.get('compare037f'):
                            other = self.clip(frame, decal, spec['iSurf'], poly['address'], 0x037f)
                        result = self.clip(frame, decal, spec['iSurf'], poly['address'])
                        case = {'decal': d_index, 'item': [item['list'], item['index']], 'poly': p_index,
                                'iNode': poly['iNode'],
                                'nodesAdmit': (not spec.get('nodes')) or poly['iNode'] in spec['nodes']}
                        case.update({k2: v for k2, v in result.items() if k2 != 'ptsArray'})
                        case['ptsArrayIsStatic'] = result['ptsArray'] == PTR_ARRAY
                        if d3d_config.get('compare037f'):
                            case['differsAt037f'] = (other['numPts'], other['points']) != (result['numPts'], result['points'])
                        if result['points'] and info is not None and d3d_config.get('draw', True):
                            case['d3d'] = self.draw(frame, info, result['numPts'], item['address'] + 0x14)
                        cases.append(case)
                self.set_surf_actor(spec['iSurf'], 'brush')
            block_specs = [b for b in request_frame.get('blocks', []) if b.get('frame', 0) == f_index]
            if 'generateBlocks' in request_frame:
                block_specs += self.generate_blocks(rng, camera, items, request_frame['generateBlocks'])
            blocks = [dict(self.run_block(frame, items, block, d3d_config), spec=block) for block in block_specs]
            out.append({
                'parent': fr['parent'], 'depth': fr['depth'],
                'frame': {'mirrorBits': self.read(frame + 0x20, 'I')[0], 'iSurf': self.read(frame + 0x14, 'i')[0],
                          'zoneNumber': self.read(frame + 0x18, 'i')[0],
                          'nearClipBits': list(self.read(frame + 0x24, '4I')),
                          'coordsBits': list(self.read(frame + 0x34, '12I')),
                          'uncoordsBits': list(self.read(frame + 0x64, '12I')),
                          'sizeAndProj': list(self.read(frame + 0xa8, '21I'))},
                'items': [{'list': it['list'], 'index': it['index'], 'iNode': it['iNode'], 'iSurf': it['iSurf'],
                           'polyFlags': it['polyFlags'],
                           'polys': [{'iNode': p['iNode'], 'points': p['points']} for p in it['polys']]} for it in items],
                'decals': decals, 'cases': cases, 'blocks': blocks})
        return {'camera': camera, 'frames': out}

    # -- DrawFrame decal block -------------------------------------------------
    def run_block(self, frame, items, block, d3d_config):
        """Execute 0x10b1b0ca..0x10b1b34d for one draw item with the block's
        decals as Surf->Decals. Frame locals as DrawFrame holds them there:
        [ebp+8] Frame, edi = [ebp-0x1c] Viewport, [ebp-0x24] D, [ebp-0x54]
        Surf, [ebp-0x78] this, [ebp-0xa8] Model, [ebp-0xac]/[ebp-0xb0] the
        PlayerPawn Sprite override, [ebp-0x170] Facet.Polys = D->Polys."""
        item = next(it for it in items if [it['list'], it['index']] == block['item'])
        i_surf = item['iSurf']
        surf = self.surf_data + 64 * i_surf
        specs = block['decals']
        array = self.alloc(0x4c * max(1, len(specs)))
        actors = []
        for k, spec in enumerate(specs):
            actor = self.decal_actor(spec)
            actors.append(actor)
            self.write_decal(array + 0x4c * k, spec, actor)
        saved = bytes(self.cpu.mem_read(surf + 0x24, 0x10))
        self.write(surf + 0x28, 'Iii', array, len(specs), len(specs))
        self.set_surf_actor(i_surf, block.get('surfActor', 'brush'))
        self.setup_d3d(dict(d3d_config, spanBased=block.get('spanBased', 0)))
        self.write(self.client + 0x4c, 'I', block.get('clientDecals', 1))
        self.write(self.viewport + 0xb0, 'II', *block.get('currentTimeWords', [0, 0x40240000]))
        self.write(self.level_info + 0x508, 'I', self.textures[block.get('defaultTexture', 0)])
        saved_dev = self.read(self.viewport + 0x64, 'I')[0]
        self.write(self.viewport + 0x64, 'I', self.dev)
        # DrawFrame's frame on the emulator stack: its locals reach ebp-0x438,
        # and ClipDecal / DrawGouraudPolygon run below esp.
        ebp = self.stack - 0x4000
        self.cpu.mem_write(ebp - 0x500, bytes(0x600))
        self.write(ebp + 8, 'I', frame)
        self.write(ebp - 0x1c, 'I', self.viewport)
        self.write(ebp - 0x24, 'I', item['address'])
        self.write(ebp - 0x54, 'I', surf)
        self.write(ebp - 0x78, 'I', self.render)
        self.write(ebp - 0xa8, 'I', self.model)
        override = block.get('override')
        self.write(ebp - 0xb0, 'II', 1 if override is not None else 0,
                   self.textures[override] if override is not None else 0)
        self.write(ebp - 0x170, 'I', self.read(item['address'] + 0x44, 'I')[0])
        self.decal_index = {array + 0x4c * k: k for k in range(len(specs))}
        self.poly_index = {}
        p, k = self.read(item['address'] + 0x44, 'I')[0], 0
        while p:
            self.poly_index[p] = k
            p, k = self.read(p, 'I')[0], k + 1
        self.span_index = {item['address'] + 0x14: 'D->Span'}
        before = self.read(DECAL_COUNT, 'I')[0]
        self.events = []
        esp = ebp - 0x480
        for reg, value in [(UC_X86_REG_ESP, esp), (UC_X86_REG_EBP, ebp), (UC_X86_REG_EDI, self.viewport),
                           (UC_X86_REG_FPCW, CW_RENDER), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.emu_start(BLOCK_START, BLOCK_END, count=20000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != BLOCK_END:
            raise RuntimeError('DrawFrame decal block did not reach its end')
        events, self.events = self.events, None
        stamps = [self.read(a + 0x31c, 'I')[0] for a in actors]
        self.write(self.viewport + 0x64, 'I', saved_dev)
        self.cpu.mem_write(surf + 0x24, saved)
        self.decal_index = self.poly_index = self.span_index = {}
        return {'item': block['item'], 'events': events, 'stampBits': stamps,
                'timeSecondsBits': self.read(self.level_info + 0x478, 'I')[0],
                'decalCount': self.read(DECAL_COUNT, 'I')[0] - before}


def main():
    request = json.load(sys.stdin)
    oracle = DecalRender(request['gameRoot'], request['tangents'])
    oracle.decal_index = oracle.poly_index = oracle.span_index = {}
    oracle.load(request)
    uv = oracle.make_textures(request['textures'])
    views = [oracle.run_frame(f, request.get('d3d', {})) for f in request['frames']]
    json.dump({'uvScale': uv, 'textures': request['textures'], 'views': views}, sys.stdout, separators=(',', ':'))
    print()


if __name__ == '__main__':
    main()
