"""Original Render.dll BSP occlusion reference (docs/bsp-occlusion.md).

Optional research tool, never imported by the browser. Executes the unchanged
URender::CreateMasterFrame (with Engine's ComputeRenderCoords/ComputeRenderSize
and UModel::PointRegion) and URender::OccludeBsp over a map's compiled model,
then reads the frame's draw lists, the model's zone LastRenderTime and node
flags, and every CreateChildFrame request. Inputs arrive as JSON on stdin;
original DLLs, inputs and results stay local.

Fixtures supply only the fields the instructions read; every other byte is
zero, unmapped access traps, and reads below 0x10000 (a null object) trap.
Unresolved imports trap. Core appTan takes the request's tangent table (real
FPTAN is not authoritative under Unicorn). The frame is built with control
word 0x037f, as the existing scene-frame oracle does; OccludeBsp runs under
0x007f, the precision control URender::PreRender sets (appEnableFastMath(1)
at 0x10b14629: _controlfp(_PC_24, _MCW_PC)).
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from collections import deque
from unicorn import UC_HOOK_BLOCK, UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
                               UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

RENDER_HASH = '607f1077c5cd3e25f8a4cde1ffacf4cf9260aebc92a72be40721cd6955bd75d1'
URENDER_VTABLE, FEXEC_VTABLE = 0x10b2a02c, 0x10b2a028
GSCENEMEM, GDYNMEM = 0x10b32608, 0x10b32618
DYNAMICS_CACHE, FRAME_COUNTER = 0x10b5a6f0, 0x10b5a700
# URender::Init (0x10b13460): PointCache (GMalloc 0xfa000, stamps = Stamp),
# DynamicsCache (GMalloc 0x80000, zeroed) and VectorMem (FMemStack).
POINT_CACHE, STAMP, VECTOR_MEM = 0x10b56a10, 0x10b56a0c, 0x10b5a6e0
# Dynamics: GRender, the FDynamicSprite constructor (0x10b233c0) and the
# thunk of its Setup call (0x10b23431 -> 0x10b010e6 -> 0x10b23910).
GRENDER, SPRITE_CTOR, SPRITE_SETUP = 0x10b5a718, 0x10b233c0, 0x10b010e6
CREATE_MASTER_FRAME, OCCLUDE_BSP = 0x10b15690, 0x10b173d0
CORE_APPTAN = 0x10123260
GMATH_CTOR = 0x10102978

# Engine classes compared by identity in the inline IsA loops.
LEVELINFO_CLASS, ZONEINFO_CLASS = 0x1057bf00, 0x1057b018
SHOW_FLAGS = 0x480c  # Play's PlayerPawn ShowFlags (docs/render-visibility.md, ClearZ note)

HEAP, HEAP_SIZE = 0x30000000, 0x10000000  # fixtures and FMemStack arenas


class Occlusion(native.NativeCollision):
    def __init__(self, root, tangents):
        super().__init__(Path(root), {'Render.dll': RENDER_HASH})
        cpu = self.cpu
        # Narrow hooks: the base class traces every instruction.
        cpu.hook_del(self.code_hook)
        cpu.hook_add(UC_HOOK_CODE, self.on_thunk, begin=0x70000000, end=0x700fffff)
        cpu.hook_add(UC_HOOK_CODE, self.on_tan, begin=CORE_APPTAN, end=CORE_APPTAN)
        cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_null, begin=0x10, end=0xffff)
        self.blocks = deque(maxlen=24)
        cpu.hook_add(UC_HOOK_BLOCK, lambda uc, address, size, data: self.blocks.append(address))
        cpu.mem_map(HEAP, HEAP_SIZE)
        self.heap = HEAP
        self.tangents = tangents
        self.tan_result = self.alloc(8)
        # appTan body: fld qword [result]; ret (the tangent is injected first).
        cpu.mem_write(CORE_APPTAN, b'\xdd\x05' + struct.pack('<I', self.tan_result) + b'\xc3')
        self.call_native(GMATH_CTOR + 0, 0x101b3218, b'', 0x037f)  # Core GMath (ViewCoords)
        self.stub_ret = {}
        # Recording CreateChildFrame (vslot 0x68, thiscall, 9 args) and a
        # no-op render-device ComputeRenderSize callback (vslot 0xac, 1 arg).
        self.child_stub = self.code(b'\x31\xc0\xc2\x24\x00')
        self.device_stub = self.code(b'\xc2\x04\x00')
        self.trap_stub = self.code(b'\xf4')
        cpu.hook_add(UC_HOOK_CODE, self.on_child, begin=self.child_stub, end=self.child_stub)
        cpu.hook_add(UC_HOOK_CODE, self.on_trap_stub, begin=self.trap_stub, end=self.trap_stub)
        cpu.hook_add(UC_HOOK_CODE, self.on_setup, begin=SPRITE_SETUP, end=SPRITE_SETUP)
        self.vtable = self.alloc(0xc0)
        cpu.mem_write(self.vtable, bytes(cpu.mem_read(URENDER_VTABLE, 0xc0)))
        self.write(self.vtable + 0x68, 'I', self.child_stub)
        self.children = []

    # -- emulator plumbing ---------------------------------------------------
    def alloc(self, size, align=16):
        self.heap = (self.heap + align - 1) & ~(align - 1)
        address = self.heap
        self.heap += size
        if self.heap > HEAP + HEAP_SIZE:
            raise MemoryError('Occlusion oracle heap exhausted')
        return address

    def code(self, body):
        address = self.alloc(len(body))
        self.cpu.mem_write(address, body)
        return address

    def on_thunk(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address not in self.thunks:
            return  # a linked bridge (msvcrt _ftol)
        raise RuntimeError(f'Unresolved import {self.thunks.get(address)} at {address:#x}; blocks {[hex(b) for b in self.blocks]}')

    def on_tan(self, cpu, address, size, data):
        key = f'{self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, "Q")[0]:016x}'
        if key not in self.tangents:
            raise RuntimeError(f'No appTan result for double input {key}')
        self.write(self.tan_result, 'Q', int(self.tangents[key], 16))

    def on_null(self, cpu, access, address, size, value, data):
        raise RuntimeError(f'Null-object access at {address:#x} from {cpu.reg_read(UC_X86_REG_EIP):#x}; blocks {[hex(b) for b in self.blocks]}')

    def on_trap_stub(self, cpu, address, size, data):
        raise RuntimeError('Unexpected virtual call on a fixture object')

    def on_child(self, cpu, address, size, data):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        frame, span, level, i_surf, i_zone, mirror, near_clip, coords, bounds = self.read(esp + 4, '9I')
        self.children.append({
            'iSurf': i_surf, 'iZone': i_zone, 'mirrorBits': mirror,
            'nearClipBits': list(self.read(near_clip, '4I')), 'coordsBits': list(self.read(coords, '12I')),
            'boundsBits': list(self.read(bounds, '4I')) if bounds else None,
            'span': self.span(span)})

    def on_setup(self, cpu, address, size, data):
        """FDynamicSprite::Setup with the case's screen rectangle and depth:
        X1..Y2 at +0x98..+0xa4, Z at +8, returns 1 (thiscall, ret 4)."""
        sprite = cpu.reg_read(UC_X86_REG_ECX)
        x1, y1, x2, y2, z = self.setup_values
        self.write(sprite + 0x98, '4i', x1, y1, x2, y2)
        self.write(sprite + 8, 'I', z)
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(esp, 'I')[0]
        cpu.reg_write(UC_X86_REG_ESP, esp + 8)
        cpu.reg_write(UC_X86_REG_EAX, 1)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def call_native(self, address, this, args, control_word, count=0):
        esp = self.stack - 0x100
        self.write(esp, 'I', self.done)
        self.cpu.mem_write(esp + 4, args)
        for reg, value in [(UC_X86_REG_ESP, esp), (UC_X86_REG_ECX, this), (UC_X86_REG_FPCW, control_word),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.emu_start(address, self.done + 1, count=count)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError(f'Native call {address:#x} did not return')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def mem_stack(self, address, size):
        arena = self.alloc(size)
        chunk = self.alloc(16)  # FTaggedMemory header for TopChunk; never freed
        self.write(address, '4I', arena, arena + size, size, chunk)
        return arena

    def span(self, address):
        """An FSpanBuffer's lines as [[start, end], ...] per line."""
        start_y, end_y, valid, index = self.read(address, '4i')
        lines = []
        for i in range(max(0, end_y - start_y)):
            spans, link = [], self.read(index + 4 * i, 'I')[0]
            while link:
                s, e, link = self.read(link, 'iiI')
                spans.append([s, e])
            lines.append(spans)
        return {'startY': start_y, 'endY': end_y, 'validLines': valid, 'lines': lines}

    # -- level fixtures --------------------------------------------------------
    def load(self, request):
        model = request['model']
        nodes, surfs = model['nodes'], model['surfs']
        self.num_nodes = len(nodes)
        object_index = iter(range(1, 1 << 30))
        textures = []
        for texture in model['textures']:
            address = self.alloc(0x100)
            self.write(address + 4, 'I', next(object_index))
            self.write(address + 0x80, 'I', texture['polyFlags'])
            textures.append(address)
        self.level_info = self.alloc(0x1000)
        self.write(self.level_info + 4, 'I', next(object_index))
        self.write(self.level_info + 0x24, 'I', LEVELINFO_CLASS)
        zone_actors = {}
        for zone in model['zoneActors']:
            address = self.alloc(0x600)
            self.write(address + 4, 'I', next(object_index))
            self.write(address + 0x24, 'I', ZONEINFO_CLASS)
            zone_actors[zone['index']] = address
        m = self.model = self.alloc(0x104 + 24 * 64)
        node_data = self.alloc(64 * len(nodes))
        for i, node in enumerate(nodes):
            p = node_data + 64 * i
            self.write(p, '4I', *node['planeBits'])
            self.write(p + 16, 'II', *node['zoneMask'])
            self.write(p + 24, '8i', node['vertexPool'], node['surface'], node['back'], node['front'],
                       node['coplanar'], node['collisionBound'], node['renderBound'], 0)
            self.write(p + 52, '4B', *node['zones'], node['vertexCount'], node['flags'])
            self.write(p + 56, '2i', *node['leaves'])
        self.node_data = node_data
        self.write(m + 0x58, 'III', node_data, len(nodes), len(nodes))
        verts = self.alloc(8 * max(1, len(model['verts'])))
        self.cpu.mem_write(verts, struct.pack(f'<{2 * len(model["verts"])}i', *[v for pair in model['verts'] for v in pair]))
        self.write(m + 0x68, 'III', verts, len(model['verts']), len(model['verts']))
        points = self.alloc(12 * max(1, len(model['pointBits'])) + 16)
        self.cpu.mem_write(points, struct.pack(f'<{3 * len(model["pointBits"])}I', *[v for p in model['pointBits'] for v in p]))
        self.write(m + 0x88, 'III', points, len(model['pointBits']), len(model['pointBits']))
        surf_data = self.alloc(64 * len(surfs))
        for i, surf in enumerate(surfs):
            p = surf_data + 64 * i
            texture = textures[surf['texture']] if surf['texture'] is not None else 0
            self.write(p, 'II', texture, surf['flags'])
        self.write(m + 0x98, 'III', surf_data, len(surfs), len(surfs))
        bounds = self.alloc(28 * max(1, len(model['boundBits'])))
        for i, box in enumerate(model['boundBits']):
            self.write(bounds + 28 * i, '7I', *box)
        self.write(m + 0xc0, 'III', bounds, len(model['boundBits']), len(model['boundBits']))
        self.write(m + 0xf0, 'i', model['rootOutside'])
        self.write(m + 0x100, 'i', model['numZones'])
        for i, zone in enumerate(model['zones']):
            self.write(m + 0x104 + 24 * i, 'I', zone_actors.get(zone['actor'], 0))
        self.zone_actor_index = {address: index for index, address in zone_actors.items()}
        self.level = self.alloc(0x200)
        actors = self.alloc(16)
        self.write(actors, 'I', self.level_info)
        self.write(self.level + 0x2c, 'III', actors, 1, 1)
        self.write(self.level + 0x98, 'I', m)
        # Viewer, viewport, render device and the renderer.
        self.actor = self.alloc(0x1000)
        self.write(self.actor + 0xac, 'I', self.level)
        self.write(self.actor + 0x5fc, 'I', SHOW_FLAGS)
        self.write(self.actor + 0x600, 'I', 5)
        self.device = self.alloc(0x100)
        device_vtable = self.alloc(0x200)
        self.cpu.mem_write(device_vtable, struct.pack('<128I', *([self.trap_stub] * 128)))
        self.write(device_vtable + 0xac, 'I', self.device_stub)
        self.write(self.device, 'I', device_vtable)
        self.write(self.device + 0x5c, 'I', 1)  # ShinySurfaces
        self.viewport = self.alloc(0x200)
        self.write(self.viewport + 0x30, 'I', self.actor)
        self.write(self.viewport + 0x64, 'I', self.device)
        self.render = self.alloc(0x100)
        self.write(self.render, 'I', self.vtable)
        self.write(self.render + 0x28, 'I', FEXEC_VTABLE)
        self.write(GRENDER, 'I', self.render)
        self.dynamics = self.alloc(0x80000)
        self.write(DYNAMICS_CACHE, 'I', self.dynamics)
        self.write(POINT_CACHE, 'I', self.alloc(0xfa000))  # stamps 0 = Stamp at Init
        self.mem_stack(VECTOR_MEM, 0x2000000)
        # OccludeBsp's function-static FVector[32] (0x10b56608): guard bit set as
        # after its first construction (FVector's default ctor stores nothing),
        # skipping the atexit registration.
        self.write(0x10b50bf0, 'B', 1)
        self.mem_stack(native_gmem := 0x101e32b0, 0x2000000)
        self.mem_stack(GDYNMEM, 0x2000000)
        self.mem_stack(GSCENEMEM, 0x800000)
        self.stacks = {a: self.read(a, '4I') for a in (native_gmem, GDYNMEM, GSCENEMEM, VECTOR_MEM)}

    def node_flags(self):
        raw = bytes(self.cpu.mem_read(self.node_data, 64 * self.num_nodes))
        return raw[0x37::64]

    def draw_list(self, head):
        out = []
        while head:
            i_node, i_surf, i_zone, key, flags = self.read(head, '4iI')
            zone, nxt, surf_next, volumetrics, polys = self.read(head + 0x34, '5I')
            saved = []
            while polys:
                poly_next, poly_node, _, count = self.read(polys, 'IiII')
                points = []
                for k in range(count):
                    pt = self.read(polys + 16 + 4 * k, 'I')[0]
                    points.append(list(self.read(pt, '8I')))
                saved.append({'iNode': poly_node, 'points': points})
                polys = poly_next
            out.append({'iNode': i_node, 'iSurf': i_surf, 'iZone': i_zone, 'polyFlags': flags,
                        'zoneActor': self.zone_actor_index.get(zone, 'level' if zone == self.level_info else zone),
                        'polys': saved})
            head = nxt
        return out

    def run(self, case):
        self.children = []
        for address, fields in self.stacks.items():
            self.write(address, '4I', *fields)
        self.write(self.viewport + 0x78, 'ii', case['width'], case['height'])
        self.write(self.actor + 0x410, 'f', case['fov'])
        self.write(self.level_info + 0x478, 'I', case.get('timeBits', 0))
        self.write(FRAME_COUNTER, 'I', case.get('frameCounter', 0))
        self.write(self.render + 0x68, 'II', 0, 0)  # NodesDraw/PolysDraw, zeroed by PreRender
        location = struct.pack('<3I', *case['locationBits'])
        rotation = struct.pack('<3i', *case['rotation'])
        frame = self.call_native(CREATE_MASTER_FRAME, self.render,
                                 struct.pack('<I', self.viewport) + location + rotation + struct.pack('<I', 0), 0x037f)
        before = self.node_flags()
        times_before = [self.read(self.model + 0x108 + 24 * i, 'I')[0] for i in range(64)]
        # OccludeFrame's dynamics bookkeeping (0x10b1a0f6..0x10b1a14a), then
        # the case's sprites in order (SetupDynamics), all at node 0.
        post = self.alloc(4 * self.num_nodes)
        self.write(self.render + 0xec, 'II', 0, post)
        sprites = []
        for sprite in case.get('sprites', []):
            address = self.alloc(0x100)
            self.setup_values = (sprite['x1'], sprite['y1'], sprite['x2'], sprite['y2'], sprite['zBits'])
            self.call_native(SPRITE_CTOR, address, struct.pack('<3I', frame, 0, self.alloc(16)), 0x007f)
            sprites.append(address)
        self.call_native(OCCLUDE_BSP, self.render, struct.pack('<I', frame), 0x007f)
        drawn = []
        link = self.read(frame + 0xa4, 'I')[0]
        while link:
            span = self.read(link + 0xc, 'I')[0]
            drawn.append({'sprite': sprites.index(link), 'span': self.span(span)})
            link = self.read(link + 0x10, 'I')[0]
        count, post = self.read(self.render + 0xec, 'II')
        for i in range(count):
            self.write(self.read(post + 4 * i, 'I')[0], 'II', 0, 0)
        after = self.node_flags()
        times = [self.read(self.model + 0x108 + 24 * i, 'I')[0] for i in range(64)]
        result = {
            'zoneNumber': self.read(frame + 0x18, 'i')[0],
            'frameBits': list(self.read(frame + 0x34, '12I')) + list(self.read(frame + 0xb8, '17I')) +
                         list(self.read(frame + 0xfc, '28I')),
            'draw': [self.draw_list(self.read(frame + 0x98 + 4 * i, 'I')[0]) for i in range(3)],
            'children': self.children,
            'sprites': drawn,
            'uncoordsBits': list(self.read(frame + 0x64, '12I')),
            'zoneTimes': {i: t for i, (t, b) in enumerate(zip(times, times_before)) if t != b},
            'nodeFlags': {i: a for i, (a, b) in enumerate(zip(after, before)) if a != b},
            'counters': list(self.read(self.render + 0x68, '2I')),
        }
        return result


if __name__ == '__main__':
    request = json.load(sys.stdin)
    oracle = Occlusion(request['gameRoot'], request['tangents'])
    oracle.load(request)
    results = [oracle.run(case) for case in request['cases']]
    json.dump({'results': results}, sys.stdout, separators=(',', ':'))
    print()
