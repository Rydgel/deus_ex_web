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
word 0x037f, as the existing scene-frame oracle does (`masterControlWord`
0x007f for a frame built inside the render pass, a ViewportWindow's); a case
with `render` {width, height, x, y} then edits the frame's X, Y, XB, YB and
calls ComputeRenderSize again at 0x007f, as XRootWindow::PreRender does
(Extension 0x1003a8cd). OccludeBsp runs under 0x007f, the precision control
URender::PreRender sets (appEnableFastMath(1) at 0x10b14629:
_controlfp(_PC_24, _MCW_PC)).

A case's sprite is either a screen rectangle and depth (the hook below plays
FDynamicSprite::Setup) or an actor fixture, for which the unchanged Setup
(0x10b23910) runs: Engine UMesh::GetRenderBoundingBox and GetAnimSeq, Core's
FBox/FCoords bodies, Render's BoundVisible and Project, Core appCeil. Its one
import outside the images, msvcrt `ceil`, is a bridge that rounds the double
toward +infinity with FRNDINT (precision control does not apply to FRNDINT,
so any x87 ceil gives this exact result). A case with `setupOnly` runs Setup
on each actor after CreateMasterFrame and skips OccludeBsp.

A model with `brushTracker` is a level the moving brush tracker has filtered
movers into (docs/brush-tracker.md): ULevel+0xfc gets a tracker object whose
vslot 3 is Engine's unchanged FMovingBrushTracker::SurfIsDynamic (0x1037ac10,
`iSurf >= iOriginalSurfs` at +0x20), which OccludeBsp calls before a node's
bound test (0x10b17ae5); its other slots trap.

A case with `children` runs the unchanged CreateChildFrame (0x10b15a40,
with Engine's ComputeRenderSize under the case's tangent table) instead of
the recorder, then OccludeFrame's recursion (0x10b1a267..0x10b1a27c): each
child of a frame, newest first (Child, then Sibling), gets its sprites
constructed for it (SetupDynamics; a sprite with `rootExcluded` only in a
child frame, as OccludeFrame passes no excluded actor and SetupDynamics
skips the ViewTarget only at Recursion 0) and OccludeBsp, then its own
children (a case's `frameSprites`, by visit index, gives a child its own
sprites: each frame's SetupDynamics runs its iterators again). Each child is
reported with its FSceneNode fields and span as
OccludeBsp receives it. A zone actor or the LevelInfo can carry a SkyZone
fixture (+0x384: Location +0x114, Rotation +0x120, Region.ZoneNumber +0xd0).
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
# FDynamicSprite::Setup's body and the constructor's test of its result.
SETUP_BODY, CTOR_SETUP_RESULT = 0x10b23910, 0x10b23436
# UMesh::GetRenderBoundingBox (vslot 0x5c) and GetAnimSeq's thunk (vslot 0x68).
MESH_BOUNDS, MESH_GET_ANIM_SEQ = 0x103a6850, 0x10301e29
# msvcrt ceil(double): fld qword [esp+4]; FRNDINT with RC up; ret.
CEIL_BRIDGE = bytes.fromhex('dd44240483ec04d93c24668b04246625fff3660d00086689442402d96c2402d9fcd92c2483c404c3')
CREATE_MASTER_FRAME, OCCLUDE_BSP = 0x10b15690, 0x10b173d0
SURF_IS_DYNAMIC = 0x1037ac10  # Engine FMovingBrushTracker vslot 3
CREATE_CHILD_FRAME = 0x10b15a40
# Engine FSceneNode::ComputeRenderSize's thunk (body 0x10372980), as the scene-frame oracle calls it.
COMPUTE_RENDER_SIZE = 0x10302d6f
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
        self.heap = self.heap_used = HEAP
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
        cpu.hook_add(UC_HOOK_CODE, self.on_child, begin=CREATE_CHILD_FRAME, end=CREATE_CHILD_FRAME)
        cpu.hook_add(UC_HOOK_CODE, self.on_trap_stub, begin=self.trap_stub, end=self.trap_stub)
        cpu.hook_add(UC_HOOK_CODE, self.on_setup, begin=SPRITE_SETUP, end=SPRITE_SETUP)
        cpu.hook_add(UC_HOOK_CODE, self.on_setup_result, begin=CTOR_SETUP_RESULT, end=CTOR_SETUP_RESULT)
        self.setup_values, self.setup_result = None, None
        for address, (dll, symbol) in list(self.thunks.items()):
            if dll == 'msvcrt.dll' and symbol == 'ceil':
                cpu.mem_write(address, CEIL_BRIDGE)
                self.thunks.pop(address)
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
        # A case's fixtures reuse the previous case's memory (run): zeroed.
        if address < self.heap_used:
            self.cpu.mem_write(address, bytes(min(size, self.heap_used - address)))
        self.heap_used = max(self.heap_used, self.heap)
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

    def on_setup_result(self, cpu, address, size, data):
        self.setup_result = cpu.reg_read(UC_X86_REG_EAX)

    def on_setup(self, cpu, address, size, data):
        """FDynamicSprite::Setup with the case's screen rectangle and depth:
        X1..Y2 at +0x98..+0xa4, Z at +8, returns 1 (thiscall, ret 4). For an
        actor fixture (no values) the original Setup runs."""
        if self.setup_values is None:
            return
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

    # -- Setup's fixtures -----------------------------------------------------
    def mesh_fixture(self, mesh):
        """The UMesh fields GetRenderBoundingBox reads: BoundingBox (+0x28),
        AnimSeqs (+0x84: Name, Group, StartFrame, NumFrames per 32 bytes),
        BoundingBoxes (+0xa8, 28 bytes each), Scale, Origin, RotOrigin."""
        address, vtable = self.alloc(0x200), self.alloc(0x100)
        self.cpu.mem_write(vtable, struct.pack('<64I', *([self.trap_stub] * 64)))
        self.write(vtable + 0x5c, 'I', MESH_BOUNDS)
        self.write(vtable + 0x68, 'I', MESH_GET_ANIM_SEQ)
        self.write(address, 'I', vtable)
        self.write(address + 0x28, '7I', *mesh['boxBits'])
        sequences = mesh.get('sequences', [])
        data = self.alloc(32 * max(1, len(sequences)))
        for i, seq in enumerate(sequences):
            self.write(data + 32 * i, '4i', seq['name'], 0, seq['startFrame'], seq['numFrames'])
        self.write(address + 0x84, '3I', data, len(sequences), len(sequences))
        boxes = mesh.get('boxes', [])
        data = self.alloc(28 * max(1, len(boxes)))
        for i, box in enumerate(boxes):
            self.write(data + 28 * i, '7I', *box)
        self.write(address + 0xa8, '3I', data, len(boxes), len(boxes))
        self.write(address + 0x100, '6I', *mesh['scaleBits'], *mesh['originBits'])
        self.write(address + 0x118, '3i', *mesh['rotOrigin'])
        return address

    def actor_fixture(self, actor):
        """The AActor fields Setup and GetRenderBoundingBox read."""
        address = self.alloc(0x600)
        self.write(address + 0x54, 'iI', actor.get('sequence', 0), actor.get('animFrameBits', 0))
        self.write(address + 0x114, '3I', *actor['locationBits'])
        self.write(address + 0x120, '3i', *actor.get('rotation', [0, 0, 0]))
        self.write(address + 0x164, 'B', actor.get('drawType', 2))
        texture, mesh = actor.get('texture'), actor.get('mesh')
        self.write(address + 0x16c, 'I', self.sprite_textures[texture] if texture is not None else 0)
        self.write(address + 0x174, 'I', self.meshes[mesh] if mesh is not None else 0)
        self.write(address + 0x17c, 'I', actor.get('drawScaleBits', 0x3f800000))
        self.write(address + 0x180, '3I', *actor.get('prePivotBits', [0, 0, 0]))
        self.write(address + 0x18c, 'I', actor.get('scaleGlowBits', 0x3f800000))
        self.write(address + 0x194, 'I', 4 if actor.get('particles') else 0)
        return address

    def setup_record(self, sprite, result):
        """Setup's result and the sprite fields it writes: X1, Y1, X2, Y2,
        Z, and the sprite path's ScreenX, ScreenY and Persp."""
        return {'result': result, 'rect': list(self.read(sprite + 0x98, '4i')), 'zBits': self.read(sprite + 8, 'I')[0],
                'screenBits': list(self.read(sprite + 0xa8, '3I'))}

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

        def sky_fixture(owner, sky):
            if not sky:
                return
            address = self.alloc(0x200)
            self.write(address + 4, 'I', next(object_index))
            self.write(address + 0x114, '3I', *sky['locationBits'])
            self.write(address + 0x120, '3i', *sky['rotation'])
            self.write(address + 0xd0, 'B', sky['zone'])
            self.write(owner + 0x384, 'I', address)
        sky_fixture(self.level_info, model.get('levelSky'))
        zone_actors = {}
        for zone in model['zoneActors']:
            address = self.alloc(0x600)
            self.write(address + 4, 'I', next(object_index))
            self.write(address + 0x24, 'I', ZONEINFO_CLASS)
            sky_fixture(address, zone.get('sky'))
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
        if model.get('brushTracker') is not None:
            tracker_vtable = self.alloc(0x40)
            self.cpu.mem_write(tracker_vtable, struct.pack('<16I', *([self.trap_stub] * 16)))
            self.write(tracker_vtable + 0xc, 'I', SURF_IS_DYNAMIC)
            tracker = self.alloc(0x68)
            self.write(tracker, 'I', tracker_vtable)
            self.write(tracker + 0x20, 'i', model['brushTracker']['originalSurfs'])
            self.write(self.level + 0xfc, 'I', tracker)
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
        self.meshes = [self.mesh_fixture(mesh) for mesh in request.get('meshes', [])]
        self.sprite_textures = []
        for texture in request.get('spriteTextures', []):
            address = self.alloc(0x100)
            self.write(address + 0x34, 'ii', texture['uSize'], texture['vSize'])
            self.sprite_textures.append(address)

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
        # Per-case fixtures (sprites, actors, the post-dynamics list) are
        # released after the case.
        mark = self.heap
        try:
            return self.run_case(case)
        finally:
            self.heap = mark

    def run_case(self, case):
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
                                 struct.pack('<I', self.viewport) + location + rotation + struct.pack('<I', 0),
                                 case.get('masterControlWord', 0x037f))
        render = case.get('render')
        if render:
            # The render pass's ComputeRenderSize (docs/render-pass-precision.md):
            # XRootWindow::PreRender (Extension 0x1003a7dd..0x1003a8cb) leaves the
            # frame's XB, YB, X, Y the root's render rectangle, then calls
            # FSceneNode::ComputeRenderSize again (0x1003a8cd) at control word
            # 0x007f; a ViewportWindow's Draw does the same inside the HUD paint.
            # The screen span stays the viewport's (CreateMasterFrame's).
            self.write(frame + 0xa8, '2i', render['width'], render['height'])
            self.write(frame + 0xb0, '2i', render.get('x', 0), render.get('y', 0))
            self.call_native(COMPUTE_RENDER_SIZE, frame, b'', 0x007f)
        if case.get('setupOnly'):
            # Setup alone on each actor (thiscall, the frame its argument).
            setups = []
            for actor in case['actors']:
                sprite = self.alloc(0x100)
                self.write(sprite + 0x94, 'I', self.actor_fixture(actor))
                result = self.call_native(SETUP_BODY, sprite, struct.pack('<I', frame), 0x007f)
                setups.append(self.setup_record(sprite, result))
            return {'zoneNumber': self.read(frame + 0x18, 'i')[0],
                    'frameBits': list(self.read(frame + 0x34, '12I')) + list(self.read(frame + 0xb8, '17I')) +
                                 list(self.read(frame + 0xfc, '28I')),
                    'uncoordsBits': list(self.read(frame + 0x64, '12I')), 'setups': setups}
        before = self.node_flags()
        times_before = [self.read(self.model + 0x108 + 24 * i, 'I')[0] for i in range(64)]
        children = bool(case.get('children'))
        self.write(self.vtable + 0x68, 'I', CREATE_CHILD_FRAME if children else self.child_stub)
        drawn, setups = self.occlude_frame(frame, case.get('sprites', []), True)
        # The root frame's results before its children run (they share the
        # transformed points, which Rasterize clamps in place).
        result = {
            'zoneNumber': self.read(frame + 0x18, 'i')[0],
            'frameBits': list(self.read(frame + 0x34, '12I')) + list(self.read(frame + 0xb8, '17I')) +
                         list(self.read(frame + 0xfc, '28I')),
            'draw': [self.draw_list(self.read(frame + 0x98 + 4 * i, 'I')[0]) for i in range(3)],
            'children': self.children,
            'sprites': drawn,
            'setups': setups,
            'uncoordsBits': list(self.read(frame + 0x64, '12I')),
        }
        if children:
            frames = []
            self.occlude_children(frame, 0, case.get('sprites', []), frames, case.get('frameSprites', {}))
            result['frames'] = frames
        after = self.node_flags()
        times = [self.read(self.model + 0x108 + 24 * i, 'I')[0] for i in range(64)]
        result.update({
            'zoneTimes': {i: t for i, (t, b) in enumerate(zip(times, times_before)) if t != b},
            'nodeFlags': {i: a for i, (a, b) in enumerate(zip(after, before)) if a != b},
            'counters': list(self.read(self.render + 0x68, '2I')),
        })
        return result

    def occlude_frame(self, frame, specs, root):
        """OccludeFrame's dynamics bookkeeping (0x10b1a0f6..0x10b1a14a), the
        frame's sprites in order (SetupDynamics), all at node 0, OccludeBsp,
        then the post-dynamics reset. Returns Frame->Sprite (each sprite's
        index in `specs` and span) and the actor sprites' Setup records."""
        post = self.alloc(4 * self.num_nodes)
        self.write(self.render + 0xec, 'II', 0, post)
        sprites, setups = {}, []
        for index, sprite in enumerate(specs):
            if root and sprite.get('rootExcluded'):
                continue
            address = self.alloc(0x100)
            if 'actor' in sprite:
                self.setup_values, actor = None, self.actor_fixture(sprite['actor'])
            else:
                if not root:
                    continue
                self.setup_values = (sprite['x1'], sprite['y1'], sprite['x2'], sprite['y2'], sprite['zBits'])
                actor = self.alloc(16)
            self.setup_result = None
            self.call_native(SPRITE_CTOR, address, struct.pack('<3I', frame, 0, actor), 0x007f)
            if 'actor' in sprite:
                setups.append(self.setup_record(address, self.setup_result))
            sprites[address] = index
        self.call_native(OCCLUDE_BSP, self.render, struct.pack('<I', frame), 0x007f)
        drawn = []
        link = self.read(frame + 0xa4, 'I')[0]
        while link:
            span = self.read(link + 0xc, 'I')[0]
            drawn.append({'sprite': sprites[link], 'span': self.span(span)})
            link = self.read(link + 0x10, 'I')[0]
        count, post = self.read(self.render + 0xec, 'II')
        for i in range(count):
            self.write(self.read(post + 4 * i, 'I')[0], 'II', 0, 0)
        return drawn, setups

    def occlude_children(self, parent, parent_index, specs, frames, frame_specs={}):
        """OccludeFrame on each child of `parent`, newest first, depth first.
        A child's SetupDynamics builds its sprites from `frame_specs[visit
        index]` when the case gives that frame its own (iterators run again
        in each frame), else from the root frame's `specs`."""
        child = self.read(parent + 0x10, 'I')[0]
        while child:
            index = len(frames) + 1
            record = {
                'index': index, 'parent': parent_index, 'iSurf': self.read(child + 0x14, 'i')[0],
                'zoneNumber': self.read(child + 0x18, 'i')[0], 'recursion': self.read(child + 0x1c, 'i')[0],
                'mirrorBits': self.read(child + 0x20, 'I')[0], 'nearClipBits': list(self.read(child + 0x24, '4I')),
                'frameBits': list(self.read(child + 0x34, '12I')) + list(self.read(child + 0xb8, '17I')) +
                             list(self.read(child + 0xfc, '28I')),
                'uncoordsBits': list(self.read(child + 0x64, '12I')),
                'span': self.span(self.read(child + 0x94, 'I')[0]),
            }
            frames.append(record)
            self.children = []
            drawn, setups = self.occlude_frame(child, frame_specs.get(str(index), specs), False)
            record.update({
                'draw': [self.draw_list(self.read(child + 0x98 + 4 * i, 'I')[0]) for i in range(3)],
                'children': self.children, 'sprites': drawn, 'setups': setups})
            self.occlude_children(child, index, specs, frames, frame_specs)
            child = self.read(child + 0xc, 'I')[0]


if __name__ == '__main__':
    request = json.load(sys.stdin)
    oracle = Occlusion(request['gameRoot'], request['tangents'])
    oracle.load(request)
    results = [oracle.run(case) for case in request['cases']]
    json.dump({'results': results}, sys.stdout, separators=(',', ':'))
    print()
