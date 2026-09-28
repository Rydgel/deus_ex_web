"""Execute the original Render.dll moving-light lightmap path.

Optional research tool, never imported by the browser. Runs the hash-pinned
Render.dll and Engine.dll bodies documented in docs/dynamic-lighting.md:
the light-manager square-root table, ComputeFromActor's radius, colour and
rectangle segments, Engine FGetHSV, the NonIncidence spatial function, the
colour merge and FDynamicLight::Filter over a supplied BSP. Core imports are
replaced only by appSqrt's own body (fld/fsqrt/ret) and a bump allocator for
FMemStack::PushBytes; any other import traps. Cases arrive as JSON on stdin.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI,
                               UC_X86_REG_EDI, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_FPCW,
                               UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'

TRAP = 0x0f000000          # unmapped import targets land here and fail
STUBS = 0x0e000000         # appSqrt and PushBytes stand-ins
HEAP = 0x20000000          # fixtures, stacks and allocator arenas
HEAP_SIZE = 0x4000000
RETURN = STUBS + 0x100     # return address for driven calls

# Render.dll globals (docs/dynamic-lighting.md).
LIGHTMAP = 0x10b49e20
FACET = 0x10b49e08
PAN_U, PAN_V, SCALE_U, SCALE_V, CLAMP_U, CLAMP_V, SIZE_U = 0x10b49e34, 0x10b49e38, 0x10b49e48, 0x10b49e4c, 0x10b49e58, 0x10b49e5c, 0x10b49e50
START, STEP_U, STEP_V = 0x10b38a90, 0x10b49e10, 0x10b3d378
ILLUM_BYTES, ILLUM_PAD = 0x10b38a84, 0x10b3df84
SQRT_TABLE = 0x10b3e1b8
GDYNMEM = 0x10b32618
DYNAMICS_CACHE, SURF_LIGHTS, LEAF_LIGHTS, GRENDER = 0x10b5a6f0, 0x10b5a6f8, 0x10b5a6fc, 0x10b5a718
NUM_DYN_LIGHT_SURFS, DYN_LIGHT_SURFS = 0x10b5a6d8, 0x10b57324
FILTER = 0x10b24a10
DYNAMIC_LIGHT_VTABLE = 0x10b2b80c


class Oracle:
    def __init__(self, root, control_word):
        system = Path(root) / 'System'
        self.render = native.Image(system / 'Render.dll', RENDER_HASH)
        self.engine = native.Image(system / 'Engine.dll')
        self.control_word = control_word
        cpu = self.cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        for image in (self.render, self.engine):
            cpu.mem_map(image.base, (image.size + 4095) & ~4095)
            for _, _, virtual, raw_size, raw in image.sections:
                if raw_size:
                    cpu.mem_write(image.base + virtual, image.data[raw:raw + raw_size])
        cpu.mem_map(STUBS, 0x1000)
        cpu.mem_map(HEAP, HEAP_SIZE)
        self.stub_sqrt = STUBS
        cpu.mem_write(STUBS, bytes.fromhex('dd442404d9fac3'))  # Core appSqrt 0x10123290
        # FMemStack::PushBytes(size, align): top = align(top); result = top; top += size.
        self.stub_push = STUBS + 0x20
        cpu.mem_write(self.stub_push, bytes.fromhex(
            '8b01' '8b542408' '4a' '01d0' 'f7d2' '21d0' '89c2' '03542404' '8911' 'c20800'))
        cpu.mem_write(RETURN, b'\xf4')
        engine_exports = self.engine.exports()
        self.world_light_radius = engine_exports['?WorldLightRadius@AActor@@UBEMXZ']
        self.fgethsv_address = engine_exports['?FGetHSV@@YA?AVFPlane@@EEE@Z']
        self.gmem = HEAP + 0x100
        for image in (self.render, self.engine):
            for library, symbol, slot in image.imports():
                target = TRAP
                if symbol == '?appSqrt@@YANN@Z':
                    target = self.stub_sqrt
                elif symbol == '?PushBytes@FMemStack@@QAEPAEHH@Z':
                    target = self.stub_push
                elif symbol == '?GMem@@3VFMemStack@@A':
                    target = self.gmem
                elif library == 'engine.dll' and symbol in engine_exports:
                    target = engine_exports[symbol]
                cpu.mem_write(slot, struct.pack('<I', target))
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.invalid)
        self.alloc_top = HEAP + 0x1000
        self.stack = self.alloc(0x10000)

    @staticmethod
    def invalid(cpu, access, address, size, value, data):
        raise RuntimeError(f'Original code reached unmapped {address:#x}; an unsupported import or fixture field')

    def alloc(self, size, align=16):
        self.alloc_top = (self.alloc_top + align - 1) & ~(align - 1)
        address = self.alloc_top
        self.alloc_top += size
        if self.alloc_top > HEAP + HEAP_SIZE - 0x100000:
            raise RuntimeError('Oracle fixture heap exhausted')
        self.cpu.mem_write(address, bytes(size))
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, bytes(self.cpu.mem_read(address, struct.calcsize('<' + fmt))))

    def reset_fpu(self):
        for register, value in [(UC_X86_REG_FPCW, self.control_word), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(register, value)

    def frame(self):
        """The shared stack, with ebp 0x400 above esp."""
        ebp = self.stack + 0xe000
        self.cpu.reg_write(UC_X86_REG_EBP, ebp)
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x400)
        return ebp

    def run(self, start, stop, count=0):
        self.reset_fpu()
        self.cpu.emu_start(start, stop, count=count)

    def call(self, address, args, this=None):
        """cdecl/thiscall with a halt return address."""
        esp = self.frame() - 0x800
        stack = [RETURN] + list(args)
        self.cpu.mem_write(esp, struct.pack('<' + 'I' * len(stack), *stack))
        self.cpu.reg_write(UC_X86_REG_ESP, esp)
        if this is not None:
            self.cpu.reg_write(UC_X86_REG_ECX, this)
        self.run(address, RETURN)
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def actor(self, light):
        actor = self.alloc(0x800)
        vtable = self.alloc(0x100)
        self.write(vtable + 0x60, 'I', self.world_light_radius)
        self.write(actor, 'I', vtable)
        self.write(actor + 0x114, 'fff', *light['location'])
        self.write(actor + 0x1e0, 'BBBBBB', light.get('type', 1), light.get('effect', 13), light['brightness'],
                   light.get('hue', 0), light.get('saturation', 0), light['radius'])
        self.write(actor + 0x1ea, 'B', 0)
        self.write(actor + 0x1ec, 'I', 1 if light.get('specialLit') else 0)
        return actor

    # Light manager init: the 2048-entry square-root table.
    def sqrt_table(self):
        self.frame()
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.run(0x10b0225b, 0x10b022d0)
        return list(self.read(SQRT_TABLE, '2048I'))

    # ComputeFromActor 0x10b05fc3-0x10b0602c: radius, reciprocal, 4093/R^2.
    def radius_constants(self, radius):
        info = self.alloc(0x100)
        actor = self.actor({'location': (0, 0, 0), 'brightness': 1, 'radius': radius})
        self.write(info, 'I', actor)
        ebp = self.frame()
        self.write(ebp + 0xc, 'I', self.alloc(0x100))
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.run(0x10b05fc3, 0x10b0602c)
        return self.read(info + 0x14, 'III')

    # Engine FGetHSV(H, S, V) as ComputeFromActor's GlobalLighting calls it.
    def fgethsv(self, hue, saturation, value):
        result = self.alloc(0x10)
        self.call(self.fgethsv_address, [result, hue, saturation, value])
        return self.read(result, 'III')

    # Brightness (0x10b060b1), colour multiply (0x10b06122) and table (0x10b064ff).
    def color_table(self, brightness, level_brightness, hsv):
        info, level, cache = self.alloc(0x100), self.alloc(0x600), self.alloc(0x440)
        actor = self.actor({'location': (0, 0, 0), 'brightness': brightness, 'radius': 1})
        self.write(info, 'I', actor)
        self.write(actor + 0xa8, 'I', level)
        self.write(level + 0x500, 'I', level_brightness)
        self.write(info + 0x6c, 'III', *hsv)
        self.frame()
        self.cpu.reg_write(UC_X86_REG_EAX, actor)
        self.cpu.reg_write(UC_X86_REG_EDI, info + 0x20)
        self.run(0x10b060b1, 0x10b060d0)
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.cpu.reg_write(UC_X86_REG_ESI, info + 0x6c)
        self.cpu.reg_write(UC_X86_REG_EDI, info + 0x20)
        self.run(0x10b06122, 0x10b0614b)
        self.cpu.reg_write(UC_X86_REG_ESI, cache)
        self.run(0x10b064ff, 0x10b065e2)
        return {'brightness': self.read(info + 0x20, 'I')[0], 'color': list(self.read(info + 0x6c, 'III')),
                'table': list(self.read(cache + 0xc, '256I'))}

    def lightmap_globals(self, facet):
        self.write(PAN_U, 'II', *facet['pan'])
        self.write(SCALE_U, 'II', *facet['scale'])
        self.write(CLAMP_U, 'ii', *facet['clamp'])
        self.write(SIZE_U, 'i', 1 << (facet['clamp'][0] - 1).bit_length())
        bytes_per_row = (facet['clamp'][0] + 7) >> 3
        self.write(ILLUM_BYTES, 'i', bytes_per_row)
        self.write(ILLUM_PAD, 'i', bytes_per_row * 8 - facet['clamp'][0])

    # ComputeFromActor 0x10b0660e-0x10b06868: the reachable texel rectangle.
    def rect(self, light, facet):
        info = self.alloc(0x100)
        actor = self.actor(light)
        self.write(info, 'I', actor)
        coords = self.alloc(0x40)
        self.write(coords, '12I', *facet['origin'], *facet['axisU'], *facet['axisV'], *facet['normal'])
        self.write(FACET, 'I', coords)
        self.lightmap_globals(facet)
        ebp = self.frame()
        self.write(ebp - 0x2c, 'I', info)
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.cpu.reg_write(UC_X86_REG_ECX, coords)  # loaded from 0x10b49e08 at 0x10b065e8
        self.cpu.reg_write(UC_X86_REG_EAX, 0)
        self.run(0x10b0660e, 0x10b06868)
        return list(self.read(info + 0x34, 'iiii'))

    # NonIncidence spatial 0x10b054e0 then the merge 0x10b03040 onto a copy
    # of the supplied static texels.
    def spatial_merge(self, light, facet, grid, rect, constants, table, static):
        width, height = facet['clamp']
        stride = ((width + 7) >> 3) * 8
        info, actor = self.alloc(0x100), self.actor(light)
        illum, spatial = self.alloc(stride * height + 16), self.alloc(width * height + 16)
        self.cpu.mem_write(illum, b'\x7f' * (stride * height))
        self.write(info, 'I', actor)
        self.write(info + 0x18, 'II', constants['rradius'], constants['rr2'])
        self.write(info + 0x34, 'iiii', *rect)
        self.write(START, 'III', *grid['start'])
        self.write(STEP_U, 'III', *grid['stepU'])
        self.write(STEP_V, 'III', *grid['stepV'])
        self.lightmap_globals(facet)
        self.call(0x10b054e0, [LIGHTMAP, info, illum, spatial])
        bytes_out = list(self.read(spatial, f'{width * height}B'))
        size_u = 1 << (width - 1).bit_length()
        colors = self.alloc(0x400)
        self.write(colors, '256I', *table)
        self.write(info + 0x8c, 'I', colors)
        self.write(info + 0x28, 'I', spatial)
        source, target = self.alloc(size_u * height * 4 + 16), self.alloc(size_u * height * 4 + 16)
        for y in range(height):
            self.write(source + y * size_u * 4, f'{width}I', *static[y * width:(y + 1) * width])
        self.call(0x10b03040, [LIGHTMAP, 13, 0, info, source, target])
        merged = []
        inside = lambda x, y: rect[0] <= x < rect[1] and rect[2] <= y < rect[3]
        for y in range(height):
            row = self.read(target + y * size_u * 4, f'{width}I')
            merged.extend(row[x] if inside(x, y) else static[y * width + x] for x in range(width))
        return {'spatial': bytes_out, 'merged': merged}

    # FDynamicLight::Filter 0x10b24a10, driven the way OccludeBsp visits nodes.
    def filter(self, model, light):
        nodes, surfaces = model['nodes'], model['surfaces']
        node_array = self.alloc(len(nodes) * 64)
        blob = bytearray(len(nodes) * 64)
        for index, (px, py, pz, pw, surface, back, front, coplanar) in enumerate(nodes):
            struct.pack_into('<ffff', blob, index * 64, px, py, pz, pw)
            struct.pack_into('<iiii', blob, index * 64 + 0x1c, surface, back, front, coplanar)
            struct.pack_into('<ii', blob, index * 64 + 0x38, -1, -1)
        self.cpu.mem_write(node_array, bytes(blob))
        surf_array = self.alloc(len(surfaces) * 64)
        blob = bytearray(len(surfaces) * 64)
        for index, (flags, light_map) in enumerate(surfaces):
            struct.pack_into('<I', blob, index * 64 + 4, flags)
            struct.pack_into('<i', blob, index * 64 + 0x18, light_map)
        self.cpu.mem_write(surf_array, bytes(blob))
        model_object = self.alloc(0x100)
        self.write(model_object + 0x58, 'I', node_array)
        self.write(model_object + 0x98, 'I', surf_array)
        self.write(model_object + 0xa8, 'I', self.alloc(0x40))
        self.write(model_object + 0xac, 'i', model['lightMaps'])
        level, view_actor, viewport, frame = self.alloc(0x100), self.alloc(0x100), self.alloc(0x100), self.alloc(0x200)
        self.write(level + 0x98, 'I', model_object)
        self.write(view_actor + 0xac, 'I', level)
        self.write(viewport + 0x30, 'I', view_actor)
        dynamics = self.alloc(len(nodes) * 8)
        self.write(DYNAMICS_CACHE, 'I', dynamics)
        surf_lights = self.alloc(len(surfaces) * 4)
        self.write(SURF_LIGHTS, 'I', surf_lights)
        self.write(LEAF_LIGHTS, 'I', self.alloc(0x100))
        grender = self.alloc(0x200)
        self.write(grender + 0xf0, 'I', self.alloc(len(nodes) * 4 + 16))
        self.write(GRENDER, 'I', grender)
        self.write(NUM_DYN_LIGHT_SURFS, 'i', 0)
        arena = self.alloc(len(nodes) * 0x40 + 0x10000)
        self.write(GDYNMEM, 'II', arena, arena + len(nodes) * 0x40 + 0x10000)
        links = self.alloc(len(surfaces) * 16 + 0x1000)
        self.write(self.gmem, 'II', links, links + len(surfaces) * 16 + 0x1000)
        actor = self.actor(light)
        item = self.alloc(0x20)
        self.write(item, 'IIIIII', DYNAMIC_LIGHT_VTABLE, 0, 0, actor, 0, 0)
        pending, visited = [(0, item)], 0
        while pending:
            node, item = pending.pop()
            visited += 1
            self.call(FILTER, [viewport, frame, node, 0], this=item)
            record = nodes[node]
            for child in (record[6], record[5]):
                if child < 0:
                    continue
                head, _ = self.read(dynamics + child * 8, 'II')
                while head:
                    pending.append((child, head))
                    head = self.read(head + 4, 'I')[0]
                self.write(dynamics + child * 8, 'II', 0, 0)
        count = self.read(NUM_DYN_LIGHT_SURFS, 'i')[0]
        order = list(self.read(DYN_LIGHT_SURFS, f'{count}i')) if count else []
        lit = [index for index, link in enumerate(self.read(surf_lights, f'{len(surfaces)}I')) if link]
        return {'surfaces': sorted(lit), 'dynLightSurfs': order, 'visited': visited}


def main():
    root, control_word = sys.argv[1], int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x037f
    cases = json.load(sys.stdin)
    oracle = Oracle(root, control_word)
    out = {'controlWord': control_word}
    if cases.get('sqrtTable'):
        out['sqrtTable'] = oracle.sqrt_table()
    out['radii'] = [oracle.radius_constants(radius) for radius in cases.get('radii', [])]
    out['hsv'] = [oracle.fgethsv(*triple) for triple in cases.get('hsv', [])]
    out['colors'] = [oracle.color_table(case['brightness'], case['levelBrightness'], case['hsv'])
                     for case in cases.get('colors', [])]
    out['rects'] = [oracle.rect(case['light'], case['facet']) for case in cases.get('rects', [])]
    out['spatial'] = [oracle.spatial_merge(case['light'], case['facet'], case['grid'], case['rect'],
                                           case['constants'], case['table'], case['static'])
                      for case in cases.get('spatial', [])]
    model = cases.get('model')
    out['filters'] = [oracle.filter(model, light) for light in cases.get('filters', [])] if model else []
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
