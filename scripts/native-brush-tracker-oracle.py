"""Original Engine FMovingBrushTracker reference (docs/brush-tracker.md).

Optional research tool, never imported by the browser. Executes the unchanged
Engine.dll moving brush tracker (UnDynBsp.cpp) under Unicorn over a real map's
level UModel and its moving brushes' polygons:

* `construct`: GNewBrushTracker (0x1037c860): GMalloc 0x68 bytes and the
  constructor 0x1037ac40, which AddBrushes (0x1037b5c0) every non-static brush
  in Level.Actors order, grows the node and vertex pools and runs Update(NULL).
* `update`: the tracker's virtual Update (vslot 1, 0x1037a400) for one actor
  or NULL; `frame` calls it for every listed mover whose bHidden is clear, in
  Level.Actors order, as URender::SetupDynamics does (0x10b230d5..0x10b230e5).
* `flush` (vslot 2, 0x1037a290), `surfIsDynamic` (vslot 3, 0x1037ac10) and
  `destroy` (vslot 0, the scalar deleting destructor 0x1037b070).

After every step it reports what changed in Level->Model (nodes, surfs,
points, vectors, verts: added, changed and removed entries with every field as
a bit pattern; NodeFlags-only changes compactly), in the tracker's own state
(its 0x68-byte object, NodeMaps, the vertex owner pool and the point helper
array), on each mover (SavedPos, SavedRot, the flag word and its
Brush->MoverLink node chain) and the basic blocks first executed in the step
(`newBlocks`; the run's union is `coverage`). A step with `brief` reports
counts and a SHA-256 of that full report instead.

Fixtures supply only the fields the instructions read; every other byte is
zero. Level.Actors holds the request's movers in order, optionally preceded by
`fillers` ('null', 'noBrush', 'staticBrush'), which the tracker skips. Reads
and writes below 0x10000 (a null object) trap, unresolved imports trap,
appFailAssert traps. Stubs with no geometric behaviour of their own: GMalloc
(a bump heap with FMallocWindows' Malloc/Realloc/Free contract),
FOutputDevice::Logf on GLog and UObject::GetFullName (log text only), msvcrt
memmove (FArray::Remove in the destructor); a Logf on GError (CastChecked
failure, a fatal error in the original) traps. Core (the FGlobalMath tables
from its original constructor, FCoords, FScale, FSphere, FBox, SafeNormal,
appSqrt, FArray, FMemStack) runs unchanged.

Inputs arrive as JSON on stdin (.work/tracker/run.mjs builds them from a map);
original DLLs, inputs and results stay local. Each step's x87 control word is
the request's (`controlWord`, default 0x037f for construct and 0x007f for the
render-pass Update calls; see the notes for why).
"""
import hashlib
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

GNEW_BRUSH_TRACKER = 0x1037c860
TRACKER_VTABLE = 0x1042c578
ABRUSH_CLASS, AMOVER_CLASS = 0x10582a28, 0x1058bb58
GENGINEMEM = 0x10485c40
# Core exports (data and the thunk addresses Engine's IAT resolves to).
GMALLOC, GLOG, GERROR, GMEM, GUNDO = 0x101a7c44, 0x101a7c34, 0x101a7c38, 0x101e32b0, 0x101e3318
CORE_LOGF, CORE_LOGF_NAME, CORE_GETFULLNAME, CORE_FAILASSERT = 0x1010280b, 0x10102a95, 0x1010240f, 0x10102c70
GMATH, GMATH_CTOR = 0x101b3218, 0x10102978

HEAP, HEAP_SIZE = 0x30000000, 0x10000000
# Basic blocks reported as `coverage` (tracker bodies, SplitWithPlaneFast,
# SplitInHalf, FPoly::Transform, UModel::PrecomputeSphereFilter).
COVERAGE = [(0x1037a290, 0x1037d140), (0x10386ad0, 0x10386e77), (0x10386f70, 0x1038707e),
            (0x10387360, 0x10387757), (0x103f63a0, 0x103f651c)]
# FPoly::Transform(Coords, PreSubtract, PostAdd, Orientation), thiscall: the
# entry and its `ret 0x10`. The FPoly (this) is read back at the return:
# Base +0x0, Vertex[] +0x30, NumVertices +0x100, iLink +0x104 (the 0x110-byte FPoly
# the fixtures write: PolyFlags 0xf0, Actor, Texture, ItemName, NumVertices, iLink).
TRANSFORM_ENTRY, TRANSFORM_RET = 0x10387360, 0x10387754

# Field offsets (SDK 1112f layouts, confirmed by the instructions).
A_CLASS, A_FLAGS, A_LOCATION, A_ROTATION, A_BRUSH, A_PREPIVOT = 0x24, 0x28, 0x114, 0x120, 0x178, 0x180
A_SPECIALLIT, A_MAINSCALE, A_POSTSCALE, A_SAVEDPOS, A_SAVEDROT = 0x1ec, 0x32c, 0x340, 0x4ac, 0x4d0
M_POLYS, M_NODES, M_VERTS, M_VECTORS, M_POINTS, M_SURFS, M_MOVERLINK = 0x54, 0x58, 0x68, 0x78, 0x88, 0x98, 0xf8
L_ACTORS, L_MODEL, L_TRACKER = 0x2c, 0x98, 0xfc
ARRAYS = {'nodes': (M_NODES, 64), 'surfs': (M_SURFS, 64), 'points': (M_POINTS, 12),
          'vectors': (M_VECTORS, 12), 'verts': (M_VERTS, 8)}


def bits_list(raw, fmt):
    return list(struct.unpack('<' + fmt, raw))


class Tracker(native.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root))
        cpu = self.cpu
        cpu.hook_del(self.code_hook)  # the base class traces every instruction
        cpu.hook_add(UC_HOOK_CODE, self.on_thunk, begin=0x70000000, end=0x700fffff)
        cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_null, begin=0x10, end=0xffff)
        self.blocks = deque(maxlen=32)
        self.coverage, self.reported = set(), set()
        def on_block(uc, address, size, data):
            self.blocks.append(address)
            if any(lo <= address < hi for lo, hi in COVERAGE):
                self.coverage.add(address)
        cpu.hook_add(UC_HOOK_BLOCK, on_block)
        # What FPoly::Transform left in each polygon it ran on (Update's
        # FMemStack copies are gone when the step returns): reported next to a
        # step's report, outside the digest of the report itself.
        self.transforms, self.transform_this = [], 0
        def on_transform_entry(uc, address, size, data):
            self.transform_this = uc.reg_read(UC_X86_REG_ECX)
        def on_transform_ret(uc, address, size, data):
            poly = self.transform_this
            count = self.read(poly + 0x100, "I")[0]
            self.transforms.append({'iLink': self.read(poly + 0x104, "i")[0],
                                    'baseBits': list(self.read(poly, '3I')),
                                    'vertexBits': [list(self.read(poly + 0x30 + 12 * k, '3I')) for k in range(count)]})
        cpu.hook_add(UC_HOOK_CODE, on_transform_entry, begin=TRANSFORM_ENTRY, end=TRANSFORM_ENTRY)
        cpu.hook_add(UC_HOOK_CODE, on_transform_ret, begin=TRANSFORM_RET, end=TRANSFORM_RET)
        cpu.mem_map(HEAP, HEAP_SIZE)
        self.heap = HEAP
        self.sizes = {}
        # GMalloc: an FMalloc whose Malloc/Realloc/Free (vslots 0, 1, 2) are
        # Python stubs; other slots trap.
        self.stubs = {}
        trap = self.stub(lambda: self.fail('Unexpected FMalloc virtual'))
        vtable = self.alloc(0x40)
        self.write(vtable, '16I', *([trap] * 16))
        self.write(vtable + 0, 'I', self.stub(self.on_malloc))
        self.write(vtable + 4, 'I', self.stub(self.on_realloc))
        self.write(vtable + 8, 'I', self.stub(self.on_free))
        self.malloc = self.alloc(16)
        self.write(self.malloc, 'I', vtable)
        self.write(GMALLOC, 'I', self.malloc)
        self.write(GUNDO, 'I', 0)
        self.empty_string = self.alloc(16)
        for address, handler in [(CORE_LOGF, self.on_logf_error), (CORE_LOGF_NAME, self.on_logf),
                                 (CORE_GETFULLNAME, self.on_full_name), (CORE_FAILASSERT, self.on_assert)]:
            cpu.hook_add(UC_HOOK_CODE, self.on_stub, begin=address, end=address)
            self.stubs[address] = handler
        self.call_native(GMATH_CTOR, GMATH, b'', 0x037f)  # Core FGlobalMath, trig tables
        self.mem_stack(GMEM, 0x4000000)
        self.mem_stack(GENGINEMEM, 0x1000000)
        self.logs = []

    # -- emulator plumbing ---------------------------------------------------
    def alloc(self, size, align=16):
        self.heap = (self.heap + align - 1) & ~(align - 1)
        address = self.heap
        self.heap += max(size, 1)
        if self.heap > HEAP + HEAP_SIZE:
            raise MemoryError('Brush tracker oracle heap exhausted')
        self.sizes[address] = size
        return address

    def fail(self, message):
        raise RuntimeError(f'{message}; blocks {[hex(b) for b in self.blocks]}')

    def stub(self, handler):
        address = self.alloc(4)
        self.cpu.mem_write(address, b'\xf4')
        self.cpu.hook_add(UC_HOOK_CODE, self.on_stub, begin=address, end=address)
        self.stubs[address] = handler
        return address

    def on_stub(self, cpu, address, size, data):
        result = self.stubs[address]()
        if result is None:
            return
        value, pop = result
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(esp, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def args(self, count):
        return self.read(self.cpu.reg_read(UC_X86_REG_ESP) + 4, f'{count}I')

    def on_malloc(self):  # thiscall Malloc(Count, Tag)
        count, _ = self.args(2)
        return self.alloc(count), 8

    def on_realloc(self):  # thiscall Realloc(Original, Count, Tag)
        original, count, _ = self.args(3)
        if count == 0:
            return 0, 12
        address = self.alloc(count)
        if original:
            keep = min(self.sizes.get(original, 0), count)
            if keep:
                self.cpu.mem_write(address, bytes(self.cpu.mem_read(original, keep)))
        return address, 12

    def on_free(self):  # thiscall Free(Original)
        return 0, 4

    def on_logf(self):  # cdecl Logf(Device, EName, Fmt, ...): GLog text only
        return 0, 0

    def on_logf_error(self):
        device = self.args(1)[0]
        if device == self.read(GERROR, 'I')[0]:
            self.fail('GError->Logf (CastChecked failure in the original: fatal)')
        return 0, 0

    def on_full_name(self):  # thiscall GetFullName(Str)
        return self.empty_string, 4

    def on_assert(self):
        expr, file, line = self.args(3)
        text = bytes(self.cpu.mem_read(expr, 128)).split(b'\0')[0].decode('latin1')
        self.fail(f'appFailAssert({text}) line {line}')

    def on_thunk(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address not in self.thunks:
            return  # linked bridge (msvcrt _ftol)
        if self.thunks[address] in (('msvcrt.dll', 'memmove'), ('msvcrt.dll', 'memcpy')):
            # cdecl memmove(Dest, Src, Count): FArray::Remove's element shift
            # (only the destructor's restore reaches it).
            esp = cpu.reg_read(UC_X86_REG_ESP)
            ret, dest, src, count = self.read(esp, '4I')
            if count:
                cpu.mem_write(dest, bytes(cpu.mem_read(src, count)))
            cpu.reg_write(UC_X86_REG_EAX, dest)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            return
        self.fail(f'Unresolved import {self.thunks.get(address)} at {address:#x}')

    def on_null(self, cpu, access, address, size, value, data):
        self.fail(f'Null-object access at {address:#x} from {cpu.reg_read(UC_X86_REG_EIP):#x}')

    def call_native(self, address, this, args, control_word):
        esp = self.stack - 0x100
        self.write(esp, 'I', self.done)
        self.cpu.mem_write(esp + 4, args)
        for reg, value in [(UC_X86_REG_ESP, esp), (UC_X86_REG_ECX, this), (UC_X86_REG_FPCW, control_word),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.emu_start(address, self.done + 1)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            self.fail(f'Native call {address:#x} did not return')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def mem_stack(self, address, size):
        arena = self.alloc(size)
        chunk = self.alloc(16)  # FTaggedMemory header for TopChunk; never freed
        self.write(address, '4I', arena, arena + size, size, chunk)

    def array(self, base, data, count, element):
        address = self.alloc(max(element, len(data)))
        if data:
            self.cpu.mem_write(address, data)
        self.write(base, 'III', address, count, count)
        return address

    # -- fixtures --------------------------------------------------------------
    def load(self, request):
        model = request['model']
        self.textures, self.texture_key = {}, {}
        for key in sorted({s['texture'] for s in model['surfs'] if s['texture'] is not None} |
                          {p['texture'] for a in request['actors'] for p in a['brush']['polys']
                           if p['texture'] is not None}):
            address = self.alloc(0x40)
            self.textures[key], self.texture_key[address] = address, key
        m = self.model = self.alloc(0x110)
        nodes = bytearray()
        for n in model['nodes']:
            nodes += struct.pack('<4I2I7i4B2i', *n['planeBits'], *n['zoneMask'], n['vertexPool'], n['surface'],
                                 n['back'], n['front'], n['coplanar'], n['collisionBound'], n['renderBound'],
                                 *n['zones'], n['vertexCount'], n['flags'], *n['leaves'])
        self.array(m + M_NODES, bytes(nodes), len(model['nodes']), 64)
        self.array(m + M_VERTS, struct.pack(f'<{2 * len(model["verts"])}i', *[v for p in model['verts'] for v in p]),
                   len(model['verts']), 8)
        self.array(m + M_POINTS, struct.pack(f'<{3 * len(model["pointBits"])}I', *[v for p in model['pointBits'] for v in p]),
                   len(model['pointBits']), 12)
        self.array(m + M_VECTORS, struct.pack(f'<{3 * len(model["vectorBits"])}I',
                                              *[v for p in model['vectorBits'] for v in p]), len(model['vectorBits']), 12)
        surfs = bytearray()
        for s in model['surfs']:
            surfs += struct.pack('<2I6i2hI24x', self.textures[s['texture']] if s['texture'] is not None else 0, s['flags'],
                                 s['base'], s['normal'], s['textureU'], s['textureV'], s['lightMap'], s['brushPoly'],
                                 *s['pan'], 0)
        self.array(m + M_SURFS, bytes(surfs), len(model['surfs']), 64)
        # Class chains for the inline IsA loops (UField.SuperField at +0x28).
        classes = {'engine.mover': AMOVER_CLASS, 'engine.brush': ABRUSH_CLASS}
        def class_of(chain):
            for i, key in enumerate(chain):
                if key not in classes:
                    classes[key] = self.alloc(0x40)
            for key, parent in zip(chain, chain[1:] + [None]):
                self.write(classes[key] + 0x28, 'I', classes[parent] if parent else 0)
            return classes[chain[0]]
        self.actors, self.actor_name = [], {}
        level_actors = []
        # Level.Actors entries that are not moving brushes, ahead of the
        # movers: a null slot, an actor without a Brush and a static brush.
        for filler in request.get('fillers', []):
            if filler == 'null':
                level_actors.append(0)
                continue
            actor = self.alloc(0x540)
            if filler == 'noBrush':
                self.write(actor + A_CLASS, 'I', class_of(['engine.actor', 'core.object']))
            elif filler == 'staticBrush':
                self.write(actor + A_CLASS, 'I', class_of(['engine.brush', 'engine.actor', 'core.object']))
                self.write(actor + A_FLAGS, 'I', 1)  # bStatic
                self.write(actor + A_BRUSH, 'I', self.alloc(0x110))
            else:
                raise ValueError(f'Unknown filler {filler}')
            level_actors.append(actor)
        for a in request['actors']:
            actor = self.alloc(0x540)
            self.write(actor + A_CLASS, 'I', class_of(a['classes']))
            self.write(actor + A_FLAGS, 'I', a['flags'])
            self.write(actor + A_LOCATION, '3I', *a['locationBits'])
            self.write(actor + A_ROTATION, '3i', *a['rotation'])
            self.write(actor + A_PREPIVOT, '3I', *a['prePivotBits'])
            self.write(actor + A_SPECIALLIT, 'B', 1 if a['specialLit'] else 0)
            for offset, scale in [(A_MAINSCALE, a['mainScale']), (A_POSTSCALE, a['postScale'])]:
                self.write(offset + actor, '4IB', *scale['scaleBits'], scale['sheerRateBits'], scale['sheerAxis'])
            # AMover::PostLoad (0x103af80f..0x103af886): SavedPos, SavedRot, iLink = i.
            self.write(actor + A_SAVEDPOS, '3f', -12345.0, -12345.0, -12345.0)
            self.write(actor + A_SAVEDROT, '3i', 123, 456, 789)
            brush = self.alloc(0x110)
            polys = self.alloc(0x40)
            data = bytearray()
            for i, p in enumerate(a['brush']['polys']):
                vertices = [v for vertex in p['vertexBits'] for v in vertex]
                data += struct.pack('<12I', *p['baseBits'], *p['normalBits'], *p['textureUBits'], *p['textureVBits'])
                data += struct.pack(f'<{len(vertices)}I', *vertices) + bytes(12 * (16 - len(p['vertexBits'])))
                data += struct.pack('<IIIIiiihh', p['flags'], 0, self.textures[p['texture']] if p['texture'] is not None else 0,
                                    0, len(p['vertexBits']), i, p['iBrushPoly'], *p['pan'])
            self.array(polys + 0x28, bytes(data), len(a['brush']['polys']), 0x110)
            self.write(brush + M_POLYS, 'I', polys)
            self.write(brush + M_MOVERLINK, 'i', -1)
            self.write(actor + A_BRUSH, 'I', brush)
            self.actors.append({'name': a['name'], 'address': actor, 'brush': brush})
            self.actor_name[actor] = a['name']
        self.by_name = {a['name']: a for a in self.actors}
        self.level = self.alloc(0x200)
        level_actors += [a['address'] for a in self.actors]
        self.array(self.level + L_ACTORS, struct.pack(f'<{len(level_actors)}I', *level_actors), len(level_actors), 4)
        self.write(self.level + L_MODEL, 'I', m)
        self.tracker = 0
        self.snap = self.snapshot()

    # -- state reads -----------------------------------------------------------
    def tarray(self, base, element):
        data, num, maximum = self.read(base, 'III')
        raw = bytes(self.cpu.mem_read(data, num * element)) if num and data else b''
        return num, maximum, raw

    def snapshot(self):
        out = {name: self.tarray(self.model + offset, size) for name, (offset, size) in ARRAYS.items()}
        if self.tracker:
            out['trackerWords'] = bytes(self.cpu.mem_read(self.tracker, 0x68))
            out['nodeMaps'] = self.tarray(self.tracker + 0x50, 8)
            out['vertOwners'] = self.tarray(self.tracker + 0x5c, 4)
            out['pointHelper'] = self.tarray(self.tracker + 0x44, 4)
        out['movers'] = {a['name']: self.mover_state(a) for a in self.actors}
        return out

    def ref(self, value):
        if value in self.actor_name:
            return self.actor_name[value]
        if value in self.texture_key:
            return {'texture': self.texture_key[value]}
        return value

    def node(self, raw):
        p = struct.unpack('<4I2I7i4B2i', raw)
        return {'planeBits': list(p[0:4]), 'zoneMask': list(p[4:6]), 'iVertPool': p[6], 'iSurf': p[7],
                'iBack': p[8], 'iFront': p[9], 'iPlane': p[10], 'iCollisionBound': p[11], 'iRenderBound': p[12],
                'iZone': list(p[13:15]), 'numVertices': p[15], 'nodeFlags': p[16], 'iLeaf': list(p[17:19])}

    def surf(self, raw):
        p = struct.unpack('<2I6i2hI6I', raw)
        return {'texture': self.ref(p[0]), 'polyFlags': p[1], 'pBase': p[2], 'vNormal': p[3], 'vTextureU': p[4],
                'vTextureV': p[5], 'iLightMap': p[6], 'iBrushPoly': p[7], 'panU': p[8], 'panV': p[9],
                'actor': self.ref(p[10]), 'decals': [p[12], p[13]], 'nodes': [p[15], p[16]]}

    def decode(self, name, raw):
        if name == 'nodes':
            return self.node(raw)
        if name == 'surfs':
            return self.surf(raw)
        if name == 'verts':
            return list(struct.unpack('<2i', raw))
        return bits_list(raw, '3I')

    def mover_state(self, a):
        chain, seen = [], set()
        link = self.read(a['brush'] + M_MOVERLINK, 'i')[0]
        nodes, count = self.read(self.model + M_NODES, 'II')
        while link != -1 and link not in seen and 0 <= link < count:
            seen.add(link)
            chain.append(link)
            link = self.read(nodes + 64 * link + 0x30, 'i')[0]
        return {'savedPosBits': list(self.read(a['address'] + A_SAVEDPOS, '3I')),
                'savedRot': list(self.read(a['address'] + A_SAVEDROT, '3i')),
                'flags': self.read(a['address'] + A_FLAGS, 'I')[0],
                'locationBits': list(self.read(a['address'] + A_LOCATION, '3I')),
                'rotation': list(self.read(a['address'] + A_ROTATION, '3i')), 'moverLink': chain}

    def diff_array(self, name, before, after, size, decode):
        (n0, m0, raw0), (n1, m1, raw1) = before, after
        out = {'num': n1, 'max': m1}
        changed, flags_only, added = [], [], []
        common = min(n0, n1)
        step = 64 * size
        for chunk in range(0, common * size, step):
            if raw0[chunk:chunk + step] == raw1[chunk:chunk + step]:
                continue
            for i in range(chunk // size, min(common, (chunk + step) // size)):
                a, b = raw0[i * size:(i + 1) * size], raw1[i * size:(i + 1) * size]
                if a == b:
                    continue
                if name == 'nodes' and a[:55] == b[:55] and a[56:] == b[56:]:
                    flags_only.append([i, a[55], b[55]])
                else:
                    changed.append([i, decode(b)])
        for i in range(common, n1):
            added.append([i, decode(raw1[i * size:(i + 1) * size])])
        if changed:
            out['changed'] = changed
        if flags_only:
            out['flagsChanged'] = flags_only
        if added:
            out['added'] = added
        if n1 < n0:
            out['removed'] = [n1, n0]
        return out

    def report(self, step, result=None):
        now = self.snapshot()
        out = {'op': step['op']}
        if result is not None:
            out['result'] = result
        for name, (_, size) in ARRAYS.items():
            out[name] = self.diff_array(name, self.snap[name], now[name], size, lambda raw, n=name: self.decode(n, raw))
        if self.tracker:
            words = struct.unpack('<26I', now['trackerWords'])
            out['tracker'] = {
                'vtable': words[0], 'normalBits': list(words[2:5]), 'iNodeCursor': words[5], 'iVertCursor': words[6],
                'firstDynamicPoint': words[7], 'originalSurfs': words[8], 'originalVectors': words[9],
                'originalPoints': words[10], 'originalNodes': words[11], 'originalVerts': words[12],
                'currentActor': self.ref(words[13]), 'updateListStale': words[15] != 0,
                'pointFreeHead': struct.unpack('<i', struct.pack('<I', words[16]))[0]}
            zero = (0, 0, b'')
            for name, size in [('nodeMaps', 8), ('vertOwners', 4), ('pointHelper', 4)]:
                decoder = (lambda raw: [self.ref(struct.unpack('<I', raw[:4])[0]), struct.unpack('<i', raw[4:])[0]]) \
                    if name == 'nodeMaps' else (lambda raw: self.ref(struct.unpack('<I', raw)[0]))
                out['tracker'][name] = self.diff_array(name, self.snap.get(name, zero), now[name], size, decoder)
        movers = {k: v for k, v in now['movers'].items() if v != self.snap['movers'].get(k)}
        if movers:
            out['movers'] = movers
        out['newBlocks'] = sorted(self.coverage - self.reported)
        self.reported = set(self.coverage)
        self.snap = now
        transforms, self.transforms = self.transforms, []
        if step.get('brief'):
            # Counts and a digest of the full report instead of the report.
            text = json.dumps(out, separators=(',', ':'), sort_keys=True)
            counts = {name: {k: len(out[name].get(k, [])) for k in ('added', 'changed', 'flagsChanged')}
                      for name in ARRAYS}
            return {'op': out['op'], 'brief': True, 'sha256': hashlib.sha256(text.encode()).hexdigest(),
                    'counts': counts, 'newBlocks': out['newBlocks'],
                    'chains': {k: len(v['moverLink']) for k, v in out.get('movers', {}).items()},
                    'cursors': [out['tracker']['iNodeCursor'], out['tracker']['iVertCursor'],
                                out['tracker']['pointFreeHead']] if self.tracker else None,
                    'transforms': transforms}
        out['transforms'] = transforms
        return out

    # -- steps ----------------------------------------------------------------
    def set_actor(self, name, fields):
        a = self.by_name[name]['address']
        if 'locationBits' in fields:
            self.write(a + A_LOCATION, '3I', *fields['locationBits'])
        if 'rotation' in fields:
            self.write(a + A_ROTATION, '3i', *fields['rotation'])
        if 'hidden' in fields:
            flags = self.read(a + A_FLAGS, 'I')[0]
            self.write(a + A_FLAGS, 'I', (flags | 2) if fields['hidden'] else (flags & ~2))

    def virtual(self, slot, args, control_word):
        target = self.read(self.read(self.tracker, 'I')[0] + 4 * slot, 'I')[0]
        return self.call_native(target, self.tracker, args, control_word)

    def step(self, step):
        for name, fields in step.get('set', {}).items():
            self.set_actor(name, fields)
        op = step['op']
        if op == 'construct':
            self.tracker = self.call_native(GNEW_BRUSH_TRACKER, 0, struct.pack('<I', self.level),
                                            step.get('controlWord', 0x037f))
            self.write(self.level + L_TRACKER, 'I', self.tracker)
            return self.report(step)
        cw = step.get('controlWord', 0x007f)
        if op == 'update':
            actor = self.by_name[step['actor']]['address'] if step.get('actor') else 0
            self.virtual(1, struct.pack('<I', actor), cw)
        elif op == 'frame':
            for a in self.actors:
                if step.get('actors') is not None and a['name'] not in step['actors']:
                    continue
                if self.read(a['address'] + A_FLAGS, 'I')[0] & 2:  # bHidden: SetupDynamics skips it
                    continue
                self.virtual(1, struct.pack('<I', a['address']), cw)
        elif op == 'flush':
            self.virtual(2, struct.pack('<I', self.by_name[step['actor']]['address']), cw)
        elif op == 'surfIsDynamic':
            return self.report(step, [self.virtual(3, struct.pack('<i', i), cw) for i in step['iSurfs']])
        elif op == 'destroy':
            self.virtual(0, struct.pack('<I', 1), cw)
            self.tracker = 0
            self.write(self.level + L_TRACKER, 'I', 0)
        else:
            raise ValueError(f'Unknown step {op}')
        return self.report(step)


if __name__ == '__main__':
    request = json.load(sys.stdin)
    oracle = Tracker(request['gameRoot'])
    oracle.load(request)
    results = [oracle.step(step) for step in request['steps']]
    json.dump({'hashes': native.HASHES, 'results': results, 'coverage': sorted(oracle.coverage)},
              sys.stdout, separators=(',', ':'))
    print()
