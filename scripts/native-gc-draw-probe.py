"""Shared Unicorn probe for the recovered Extension UGC tile-draw boundary.

Maps hash-checked Extension.dll (rebased to 0x12000000), Core.dll, Engine.dll
and the shipped MSVCRT.dll so the real bodies execute unchanged — including
MSVCRT _ftol (0x78004dc1, which forces truncate mode internally) reached
through the Extension IAT thunk 0x1005480a, and the two Core FPlane
constructors the sink calls through IAT slots 0x120590bc (copy ctor,
Core 0x101030cb -> 0x10118280) and 0x1205912c (4-float ctor, Core 0x10102a8b
-> 0x10118300).  Both ctors are verified plain 4-float copies.

The render boundary is a fake Engine.Canvas object: its vtable slot +0x5c
(UCanvas::DrawTile) points at a recording stub holding `ret 0x50` — the same
thiscall cleanup the real UCanvas::DrawTile (Engine.dll 0x10376160, reached
through thunk 0x103019fb) performs.  The code hook captures the full pushed
argument block — 20 dwords: texture, 8 clipped/rounded f32 coords+UVs,
FSpanBuffer* (always 0), Z (canvas+0x4c), the 4-float Color and Fog planes,
polyFlags — as an ordered event, then execution continues into the stub ret.

Exec runs use the same fake FFrame/GNatives model as native-gc-probe.py:
frame+8 is `this`, frame+0xc a token stream the trampoline consumes; each
eval stub writes the next configured dword to the result pointer.

UGC object image: 0xb8 padded to 0x100, per-case fill byte (default 0xa5),
spec fields written as raw bit patterns ({'f': v} encodes an f32).  The case
can declare {'canvas': {'$canvas': {...}}} and arg entries {'$texture': {...}}
to get a fake canvas (with canvas+0x4c Z field and the recording vtable) and
fake UTexture objects (i32 USize at +0x34, VSize at +0x38 — the only texture
fields the clip helper reads, via fild).
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
)


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
MSVCRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'
IMAGES = {
    'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE},
    'MSVCRT.dll': MSVCRT_HASH,
}

EXT = EXTENSION_BASE
IMAGE_BASE = 0x10000000

# Exec trampoline / method body (rebased).  DrawStretchedTexture has no
# method body: its exec calls the tile sink directly.
NATIVES = {
    'drawTexture':           {'exec': EXT + 0x2c520, 'method': EXT + 0x28b00, 'kind': 'void'},
    'drawIcon':              {'exec': EXT + 0x2c460, 'method': EXT + 0x289c0, 'kind': 'void'},
    'drawPattern':           {'exec': EXT + 0x2c680, 'method': EXT + 0x28a60, 'kind': 'void'},
    'drawBox':               {'exec': EXT + 0x2c7e0, 'method': EXT + 0x28c50, 'kind': 'void'},
    'drawStretchedTexture':  {'exec': EXT + 0x2cbc0, 'method': None,          'kind': 'void'},
    'drawBorders':           {'exec': EXT + 0x2c970, 'method': EXT + 0x28df0, 'kind': 'void'},
    'drawText':              {'exec': EXT + 0x2c280, 'method': EXT + 0x28180, 'kind': 'void'},
}

# Extension IAT slots.
GNATIVES_IAT = EXT + 0x59064    # Core!GNatives table import
GPROPADDR_IAT = EXT + 0x590d0   # Core!GPropAddr import

# IAT slots the draw probe services with scratch stubs:
#   - FArray::Realloc / FArray::Remove (DrawText exec FString teardown)
#   - UObject::StaticAllocateObject / UObject::UObject / FName::FName
#     (the UGC::operator-new path inside PushGC, called by DrawText)
FARRAY_REALLOC_IAT = EXT + 0x5909c  # thiscall, 1 arg (this = FString*)
FARRAY_REMOVE_IAT = EXT + 0x59094   # thiscall, 3 args (this = FString*)
STATIC_ALLOC_IAT = EXT + 0x5906c    # cdecl, caller cleans 7 args
UOBJECT_CTOR_IAT = EXT + 0x5907c    # thiscall, no args
FNAME_CTOR_IAT = EXT + 0x59124      # thiscall, 1 arg

DRAW_TILE_SLOT = 0x5c           # UCanvas vtable slot for DrawTile
DRAW_GLYPH_SLOT = 0x7c          # FRenderInterface vtable slot the glyph path calls
CANVAS_Z = 0x4c                 # f32 forwarded as the DrawTile Z arg
CANVAS_VIEWPORT = 0x78          # canvas -> Viewport (renddevice-ish) object
CANVAS_SCENENODE = 0x7c         # canvas -> FSceneNode (glyph path's first arg)
VIEWPORT_RI = 0x64              # *sceneNode / viewport -> FRenderInterface
TEX_USIZE = 0x34                # i32 UBitmap.USize the clip helper reads
TEX_VSIZE = 0x38
TEX_LOCK_SLOT = 0x54            # UTexture vtable: Lock(FTextureInfo&, ...)
TEX_UNLOCK_SLOT = 0x58          # UTexture vtable: Unlock(FTextureInfo&)

# UFont runtime fields (glyph lookup 0x10026880 / mapper 0x10026950).
FONT_CHARS_PER_PAGE = 0x28
FONT_PAGES = 0x2c               # TArray<FPage> data
FONT_PAGE_COUNT = 0x30
FONT_PAGE_MAX = 0x34
FONT_PAGE_SIZE = 0x10           # {texture, chars, numChars, maxChars}
FONT_GLYPH_SIZE = 0x10          # {startU, startV, uSize, vSize} i32

# Extension .bss addresses (rebased) the realize cache 0x1002a370 uses.
TEXCACHE_RECORDS = EXT + 0xa2630   # 5 x 132-byte FTextureInfo records
TEXCACHE_COUNT = EXT + 0xa2dc4
TEXCACHE_HEAD = EXT + 0xa2dc8
TEXCACHE_STATIC = EXT + 0xaeb20    # returned for null/full-cache overflow
TEXCACHE_RECORD_SIZE = 0x84

UGC_VTABLE = EXT + 0x598dc

# Pointer fields canonicalised in dumps (same set as native-gc-probe.py).
GC_PTR_FIELDS = frozenset(('vtable', 'canvas', 'normalFont', 'boldFont',
                           'stackTop', 'freeList', 'owner'))

# UGC field layout: name -> (offset, struct fmt); raw bit patterns.
GC_FIELDS = {
    'vtable':         (0x00, 'I'),
    'canvas':         (0x28, 'I'),
    'originX':        (0x2c, 'I'),
    'originY':        (0x30, 'I'),
    'clipX':          (0x34, 'I'),
    'clipY':          (0x38, 'I'),
    'clipWidth':      (0x3c, 'I'),
    'clipHeight':     (0x40, 'I'),
    'style':          (0x44, 'B'),
    'flags':          (0x48, 'I'),
    'polyFlags':      (0x4c, 'I'),
    'textPolyFlags':  (0x50, 'I'),
    'tileColor':      (0x54, 'I'),
    'tileFloats':     (0x58, '4I'),
    'textColor':      (0x68, 'I'),
    'textFloats':     (0x6c, '4I'),
    'normalFont':     (0x7c, 'I'),
    'boldFont':       (0x80, 'I'),
    'unknown84':      (0x84, 'I'),
    'underlineHeight': (0x88, 'I'),
    'baselineOffset': (0x8c, 'I'),
    'textVSpacing':   (0x90, 'I'),
    'hAlign':         (0x94, 'B'),
    'vAlign':         (0x95, 'B'),
    'textFlags':      (0x98, 'I'),
    'hMultiplier':    (0x9c, 'I'),
    'vMultiplier':    (0xa0, 'I'),
    'nodeFlags':      (0xa4, 'I'),
    'depth':          (0xa8, 'I'),
    'stackTop':       (0xac, 'I'),
    'freeList':       (0xb0, 'I'),
    'owner':          (0xb4, 'I'),
}


def f32bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


class GcDrawProbe(_NATIVE.NativeCollision):
    """Run one UGC draw body against a constructed object image and record
    the DrawTile command stream emitted through the canvas vtable."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        # GC natives run from DrawWindow during PaintWindows, inside the render
        # pass (PostRenderFlash -> PostRenderWindows): ORACLE_CW (the audit).
        self.control_word = _NATIVE.render_control_word()
        self.events = []
        self.exec_params = []
        self.seen_ids = {}
        self.tex_ids = {}
        self.canvas_addr = 0
        self.cur_this = 0

        # Fake GNatives table: every token dispatches to the eval stub.
        self.gnative_stub = self.alloc(16)
        self.cpu.mem_write(self.gnative_stub, b'\xc3')
        self.gnatives = self.alloc(0x400)
        for i in range(0x100):
            self.write(self.gnatives + 4 * i, 'I', self.gnative_stub)
        self.write(GNATIVES_IAT, 'I', self.gnatives)
        self.gprop_global = self.read(GPROPADDR_IAT, 'I')[0]
        self.out_slot = self.alloc(0x40)

        # msvcrt __dllonexit resolves to real CRT code (its IAT slot carries
        # the export address, so it never lands in self.thunks).  DrawText's
        # realize-cache init and nextChar's palette init both register an
        # atexit callback through it — model the append at the resolved
        # address before real CRT code can reach kernel32 critical sections.
        self.dllonexit_addr = self.read(EXT + 0x593a8, 'I')[0]

        # Recording DrawTile stub: the code hook captures the argument block
        # at entry, then the real `ret 0x50` performs thiscall cleanup —
        # callee pops all 80 stack bytes, matching UCanvas::DrawTile.
        self.drawtile_stub = self.alloc(16)
        self.cpu.mem_write(self.drawtile_stub, b'\xc2\x50\x00')

        # DrawText's glyph path calls FRenderInterface::DrawTile directly —
        # vtable slot +0x7c of *(*(canvas+0x7c) + 0x64), the same boundary the
        # real UCanvas::DrawTile (Engine.dll 0x10376160) delegates to.  The
        # arg block is the full DrawTile layout plus one trailing dword:
        # (sceneNode, FTextureInfo record, X, Y, XL, YL, U, V, UL, VL, span,
        # Z, color[4], fog[4], polyFlags) — the text polyflags dword is
        # pushed before the FPlane ctor that fills the fog local, so it
        # survives the ctor's arg cleanup as the 21st dword.
        self.glyph_stub = self.alloc(16)
        self.cpu.mem_write(self.glyph_stub, b'\xc2\x54\x00')

        # Fake UTexture vtable leaves the realize cache calls:
        # Lock(this, &record, vp+0xb0, vp+0xb4, -1, RI) ret 0x14 and
        # Unlock(this, &record) ret 4.  The hook records the call and writes
        # the texture pointer into record+0, mirroring a real FTextureInfo.
        self.lock_stub = self.alloc(16)
        self.cpu.mem_write(self.lock_stub, b'\xc2\x14\x00')
        self.unlock_stub = self.alloc(16)
        self.cpu.mem_write(self.unlock_stub, b'\xc2\x04\x00')

        # DrawText exec FString teardown stubs: Realloc is a no-op and Remove
        # zeroes the FString header so the real GMalloc free check takes the
        # null path (same approach as native-gc-textmetrics-oracle.py).
        self.realloc_stub = self.alloc(16)
        self.cpu.mem_write(self.realloc_stub, b'\xc2\x04\x00')
        self.remove_stub = self.alloc(16)
        self.cpu.mem_write(self.remove_stub, b'\xc2\x0c\x00')
        self.write(FARRAY_REALLOC_IAT, 'I', self.realloc_stub)
        self.write(FARRAY_REMOVE_IAT, 'I', self.remove_stub)

        # The exec teardown frees the FString data through the real Core
        # GMalloc global (FMalloc::Free at vtable+8 — thiscall, one arg).
        # Redirect just that slot; the block lives in our scratch heap.
        self.free_stub = self.alloc(16)
        self.cpu.mem_write(self.free_stub, b'\xc2\x04\x00')
        gmalloc = self.read(EXT + 0x59060, 'I')[0]
        self.write(self.read(gmalloc, 'I')[0] + 8, 'I', self.free_stub)

        # PushGC's UGC::operator-new path (reached when freeList == 0):
        # StaticAllocateObject is cdecl (caller cleans 7 args), the ctor
        # leaves are thiscall.  Same allocator model as native-gc-probe.py.
        self.static_alloc_stub = self.alloc(16)
        self.cpu.mem_write(self.static_alloc_stub, b'\xc3')
        self.uobject_ctor_stub = self.alloc(16)
        self.cpu.mem_write(self.uobject_ctor_stub, b'\xc3')
        self.fname_ctor_stub = self.alloc(16)
        self.cpu.mem_write(self.fname_ctor_stub, b'\xc2\x04\x00')
        self.write(STATIC_ALLOC_IAT, 'I', self.static_alloc_stub)
        self.write(UOBJECT_CTOR_IAT, 'I', self.uobject_ctor_stub)
        self.write(FNAME_CTOR_IAT, 'I', self.fname_ctor_stub)

        self.block_ids = {}
        self.font_ids = {}
        self.text_ids = {}
        self.node_addr = 0
        self.vp_addr = 0
        self.ri_addr = 0

    # ----- thiscall leaf returns -------------------------------------------
    @staticmethod
    def _cdecl_return(cpu, stack, arg_bytes=0):
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    # ----- leaf dispatch -----------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address == self.dllonexit_addr:
            # CRT atexit-for-DLLs, reached once by the realize-cache init in
            # 0x1002a370 and the palette init in 0x100294d0.  The registered
            # list is only walked at DLL unload; a faithful append to the
            # begin/end globals is enough (native-gc-textmetrics-oracle.py).
            stack = cpu.reg_read(UC_X86_REG_ESP)
            func, pbegin, pend = self.read(stack + 4, '3I')
            begin, end = self.read(pbegin, 'I')[0], self.read(pend, 'I')[0]
            if not begin or begin == 0xffffffff:
                begin = end = self.alloc(16)
            self.write(end, 'I', func)
            self.write(pbegin, 'I', begin)
            self.write(pend, 'I', end + 4)
            cpu.reg_write(UC_X86_REG_EAX, func)
            return self._cdecl_return(cpu, stack)
        if address in self.thunks:
            raise RuntimeError(
                f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        if address == self.gnative_stub:
            self.on_gnative(cpu)
        elif address == self.drawtile_stub:
            self.on_draw_tile(cpu)
        elif address == self.glyph_stub:
            self.on_glyph_tile(cpu)
        elif address == self.lock_stub:
            self.on_texture_lock(cpu)
        elif address == self.unlock_stub:
            self.on_texture_unlock(cpu)
        elif address == self.realloc_stub:
            return self._cdecl_return(cpu, cpu.reg_read(UC_X86_REG_ESP), 4)
        elif address == self.remove_stub:
            self.write(cpu.reg_read(UC_X86_REG_ECX), '3I', 0, 0, 0)
            return self._cdecl_return(cpu, cpu.reg_read(UC_X86_REG_ESP), 0xc)
        elif address == self.static_alloc_stub:
            self.on_static_alloc(cpu)
        elif address == self.uobject_ctor_stub:
            self.events.append({'op': 'UObject::UObject',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
            self._cdecl_return(cpu, cpu.reg_read(UC_X86_REG_ESP))
        elif address == self.fname_ctor_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            self.write(cpu.reg_read(UC_X86_REG_ECX), 'I',
                       self.read(stack + 4, 'I')[0])
            self._cdecl_return(cpu, stack, 4)

    def on_gnative(self, cpu):
        """Model one param expression eval: (ecx=object, frame, resultPtr).

        Spec forms: a plain dword; {'gprop': addr} sets the global GPropAddr
        (the DrawBorders borders-array eval then uses it); {'local': [dwords]}
        leaves GPropAddr clear and writes an array payload to result_ptr;
        {'fstring': (data, num, max)} writes the three FString dwords."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result_ptr = self.read(stack + 4, '2I')
        if not self.exec_params:
            raise RuntimeError('GNatives eval with no configured param')
        spec = self.exec_params.pop(0)
        if isinstance(spec, dict):
            if 'gprop' in spec:
                self.write(self.gprop_global, 'I', spec['gprop'] & 0xffffffff)
                self.write(result_ptr, 'I', spec['gprop'] & 0xffffffff)
            elif 'local' in spec:
                for i, value in enumerate(spec['local']):
                    self.write(result_ptr + 4 * i, 'I', value & 0xffffffff)
            elif 'fstring' in spec:
                self.write(result_ptr, '3I', *spec['fstring'])
            else:
                raise ValueError('unsupported exec param spec %r' % (spec,))
        else:
            self.write(result_ptr, 'I', spec & 0xffffffff)
        self._cdecl_return(cpu, stack, 8)

    def on_draw_tile(self, cpu):
        """Capture the DrawTile argument block at the vtable boundary."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        args = self.read(stack + 4, '20I')
        (texture, x, y, xl, yl, u, v, ul, vl, span, z) = args[:11]
        color = list(args[11:15])
        fog = list(args[15:19])
        poly_flags = args[19]
        self.events.append({
            'op': 'DrawTile',
            'canvas': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
            'texture': self.canon(texture),
            'x': x, 'y': y, 'xl': xl, 'yl': yl,
            'u': u, 'v': v, 'ul': ul, 'vl': vl,
            'spanBuffer': span, 'z': z,
            'color': color, 'fog': fog,
            'polyFlags': poly_flags,
        })
        # Execution continues into the stub's own `ret 0x50`.

    def on_glyph_tile(self, cpu):
        """DrawText glyph emit — FRenderInterface::DrawTile at vtable +0x7c.
        The 21-dword block is (sceneNode, FTextureInfo*, X, Y, XL, YL, U, V,
        UL, VL, FSpanBuffer*, Z, Color FPlane, Fog FPlane, polyFlags): the
        leading object pair replaces the DrawTile texture and the text
        polyflags (GC+0x50) are the trailing arg — pushed before the FPlane
        ctor whose four zero args fill the fog local (fog.w stays 0)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        args = self.read(stack + 4, '21I')
        (node, record, x, y, xl, yl, u, v, ul, vl, span, z) = args[:12]
        self.events.append({
            'op': 'DrawGlyphTile',
            'ri': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
            'node': self.canon(node),
            'record': self.canon(record),
            'texture': self.canon(self.read(record, 'I')[0]),
            'x': x, 'y': y, 'xl': xl, 'yl': yl,
            'u': u, 'v': v, 'ul': ul, 'vl': vl,
            'spanBuffer': span, 'z': z,
            'color': list(args[12:16]), 'fog': list(args[16:20]),
            'polyFlags': args[20],
        })

    def on_texture_lock(self, cpu):
        """UTexture::Lock(this, &record, vp+0xb0, vp+0xb4, -1, RI) — the
        realize cache's fill call.  Records the args and writes the texture
        pointer into record+0 like a real FTextureInfo."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        record, b0, b4, minus_one, ri = self.read(stack + 4, '5I')
        tex = cpu.reg_read(UC_X86_REG_ECX)
        self.events.append({
            'op': 'TextureLock',
            'texture': self.canon(tex),
            'record': self.canon(record),
            'b0': self.canon(b0), 'b4': self.canon(b4),
            'arg3': minus_one, 'ri': self.canon(ri),
        })
        self.write(record, 'I', tex)

    def on_texture_unlock(self, cpu):
        """UTexture::Unlock(this, &record) — the realize cache's evict call."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        record = self.read(stack + 4, 'I')[0]
        self.events.append({
            'op': 'TextureUnlock',
            'texture': self.canon(cpu.reg_read(UC_X86_REG_ECX)),
            'record': self.canon(record),
        })

    def on_static_alloc(self, cpu):
        """UObject::StaticAllocateObject(Class, Outer, Name, SetFlags,
        Template, Error, Ptr) — cdecl; the operator-new wrapper cleans."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        cls, outer, name, set_flags, template, _error, ptr = \
            self.read(stack + 4, '7I')
        self.events.append({'op': 'StaticAllocateObject',
                            'class': self.canon(cls),
                            'outer': self.canon(outer),
                            'name': name,
                            'setFlags': set_flags,
                            'template': self.canon(template),
                            'ptr': self.canon(ptr)})
        address = self.alloc(0x100)
        self.cpu.mem_write(address, b'\0' * 0x100)
        self.block_ids[address] = 'h%d' % len(self.block_ids)
        cpu.reg_write(UC_X86_REG_EAX, address)
        self._cdecl_return(cpu, stack)

    def canon(self, ptr):
        """Stable pointer label: 'this' the GC, 'canvas' the fake canvas,
        'tex<i>' spec textures, 'scenenode'/'vp'/'ri' the glyph-path chain,
        'rec<i>'/'recStatic' the realize-cache records, 'h<N>' allocated
        PushGC blocks, 'font<i>'/'text<i>' built images, 'a<N>' anything else
        in encounter order."""
        if not ptr:
            return 0
        if ptr in (UGC_VTABLE, IMAGE_BASE + 0x598dc):
            return 'UGC::vtable'
        if ptr in (EXT + 0xa28c8, IMAGE_BASE + 0xa28c8):
            return 'UGC::PrivateStaticClass'
        if ptr == self.cur_this:
            return 'this'
        if ptr == self.canvas_addr:
            return 'canvas'
        if ptr == self.node_addr:
            return 'scenenode'
        if ptr == self.vp_addr:
            return 'vp'
        if ptr == self.ri_addr:
            return 'ri'
        if ptr == TEXCACHE_STATIC:
            return 'recStatic'
        if TEXCACHE_RECORDS <= ptr < TEXCACHE_RECORDS + 5 * TEXCACHE_RECORD_SIZE \
                and (ptr - TEXCACHE_RECORDS) % TEXCACHE_RECORD_SIZE == 0:
            return 'rec%d' % ((ptr - TEXCACHE_RECORDS) // TEXCACHE_RECORD_SIZE)
        if ptr in self.tex_ids:
            return self.tex_ids[ptr]
        if ptr in self.font_ids:
            return self.font_ids[ptr]
        if ptr in self.text_ids:
            return self.text_ids[ptr]
        if ptr in self.block_ids:
            return self.block_ids[ptr]
        if ptr in self.seen_ids:
            return self.seen_ids[ptr]
        label = 'a%d' % len(self.seen_ids)
        self.seen_ids[ptr] = label
        return label

    # ----- object images -----------------------------------------------------
    def _resolve_value(self, value):
        """{'f': v} -> f32 bits; plain ints pass through."""
        if isinstance(value, dict) and 'f' in value:
            return f32bits(value['f'])
        return value

    def build_canvas(self, spec=None):
        """Fake Engine.Canvas: vtable slot +0x5c -> recording stub.

        The glyph path needs the canvas's render graph: canvas+0x78 is the
        Viewport the realize cache reads (+0x64 = FRenderInterface, +0xb0 /
        +0xb4 forwarded as Lock args), canvas+0x7c is the FSceneNode the
        glyph call pushes, and *sceneNode+0x64 is the same FRenderInterface
        whose vtable slot +0x7c is the second recording stub."""
        spec = spec or {}
        canvas = self.alloc(0x80)
        vtable = self.alloc(0x100)
        self.cpu.mem_write(canvas, b'\0' * 0x80)
        self.cpu.mem_write(vtable, b'\0' * 0x100)
        self.write(vtable + DRAW_TILE_SLOT, 'I', self.drawtile_stub)
        self.write(canvas, 'I', vtable)
        self.write(canvas + CANVAS_Z, 'I',
                   self._resolve_value(spec.get('z', 0)) & 0xffffffff)
        ri_vtable = self.alloc(0x100)
        self.cpu.mem_write(ri_vtable, b'\0' * 0x100)
        self.write(ri_vtable + DRAW_GLYPH_SLOT, 'I', self.glyph_stub)
        ri = self.alloc(0x40)
        self.cpu.mem_write(ri, b'\0' * 0x40)
        self.write(ri, 'I', ri_vtable)
        vp = self.alloc(0xc0)
        self.cpu.mem_write(vp, b'\0' * 0xc0)
        self.write(vp + VIEWPORT_RI, 'I', ri)
        node = self.alloc(0x40)
        self.cpu.mem_write(node, b'\0' * 0x40)
        self.write(node, 'I', vp)          # *sceneNode+0x64 -> RI
        self.write(canvas + CANVAS_VIEWPORT, 'I', vp)
        self.write(canvas + CANVAS_SCENENODE, 'I', node)
        self.node_addr = node
        self.vp_addr = vp
        self.ri_addr = ri
        self.canvas_addr = canvas
        return canvas

    def build_texture(self, spec):
        """Fake UTexture: +0x34/+0x38 i32 dims the clip helper reads, plus a
        vtable with Lock/Unlock stubs for the DrawText realize cache."""
        tex = self.alloc(0x60)
        vtable = self.alloc(0x80)
        self.cpu.mem_write(tex, b'\0' * 0x60)
        self.cpu.mem_write(vtable, b'\0' * 0x80)
        self.write(tex, 'I', vtable)
        self.write(vtable + TEX_LOCK_SLOT, 'I', self.lock_stub)
        self.write(vtable + TEX_UNLOCK_SLOT, 'I', self.unlock_stub)
        self.write(tex + TEX_USIZE, 'i', spec.get('u', 0))
        self.write(tex + TEX_VSIZE, 'i', spec.get('v', 0))
        self.tex_ids[tex] = 'tex%d' % len(self.tex_ids)
        return tex

    def build_font(self, spec):
        """Runtime UFont image: +0x28 charsPerPage, +0x2c page table,
        +0x30/+0x34 TArray Num/Max; page records {texture, chars, num, max}.
        Page texture specs ('tex': {...}|0) build real lockable textures so
        the glyph path's realize/Lock sequence is exercised."""
        cpp = spec['charsPerPage']
        pages = spec['pages']
        # A page may pin its table index with 'page': i (sparse fonts put a
        # glyph on a high page, e.g. U+4E2D at index 0x4e for cpp=0x100).
        count = spec.get('pageCount')
        if count is None:
            count = max((p.get('page', i) + 1 for i, p in enumerate(pages)),
                        default=0)
        font = self.alloc(0x40)
        self.cpu.mem_write(font, b'\0' * 0x40)
        table = self.alloc(FONT_PAGE_SIZE * count)
        self.cpu.mem_write(table, b'\0' * (FONT_PAGE_SIZE * count))
        for i, page in enumerate(pages):
            p = page.get('page', i)
            chars = page['chars']
            if isinstance(chars, dict):
                # {remainder-index: [startU, startV, uSize, vSize]} — the
                # glyph array is indexed by codepoint % charsPerPage.
                n = max(chars) + 1 if chars else 0
                run = self.alloc(FONT_GLYPH_SIZE * max(n, 1))
                self.cpu.mem_write(run, b'\0' * (FONT_GLYPH_SIZE * max(n, 1)))
                for rem, rec in chars.items():
                    self.write(run + FONT_GLYPH_SIZE * rem, '4i', *rec)
                num = n
            else:
                run = self.alloc(FONT_GLYPH_SIZE * len(chars))
                for j, rec in enumerate(chars):
                    self.write(run + FONT_GLYPH_SIZE * j, '4i', *rec)
                num = len(chars)
            tex = self.build_texture(page['tex']) if page.get('tex') else 0
            self.write(table + FONT_PAGE_SIZE * p, '4I',
                       tex, run, num, num)
        self.write(font + FONT_CHARS_PER_PAGE, 'i', cpp)
        self.write(font + FONT_PAGES, 'I', table)
        self.write(font + FONT_PAGE_COUNT, 'i', count)
        self.write(font + FONT_PAGE_MAX, 'i', count)
        self.font_ids[font] = 'font%d' % len(self.font_ids)
        return font

    def build_text(self, units):
        """NUL-terminated UTF-16 buffer for a unit list; returns the data
        pointer.  The canon label lets events name the string identity."""
        buf = self.alloc(2 * (len(units) + 1))
        self.cpu.mem_write(buf, struct.pack('<%dH' % (len(units) + 1),
                                            *units, 0))
        self.text_ids[buf] = 'text%d' % len(self.text_ids)
        return buf

    def _write_fields(self, base, fields):
        for name, (offset, fmt) in GC_FIELDS.items():
            if name not in fields:
                continue
            value = fields[name]
            if fmt == '4I':
                self.write(base + offset, '4I',
                           *[self._resolve_value(v) & 0xffffffff for v in value])
            elif fmt == 'B':
                self.write(base + offset, 'B', self._resolve_value(value) & 0xff)
            elif name == 'canvas' and isinstance(value, dict) and '$canvas' in value:
                self.write(base + offset, 'I', self.build_canvas(value['$canvas']))
            elif isinstance(value, dict) and '$font' in value:
                self.write(base + offset, 'I', self.build_font(value['$font']))
            elif isinstance(value, dict) and '$texture' in value:
                self.write(base + offset, 'I', self.build_texture(value['$texture']))
            else:
                self.write(base + offset, 'I', self._resolve_value(value) & 0xffffffff)

    def gc_object(self, spec):
        this = self.alloc(0x100)
        self.cur_this = this
        fill = spec.get('fill', 0xa5) & 0xff
        self.cpu.mem_write(this, bytes([fill]) * 0x100)
        self._write_fields(this, spec)
        return this

    def _resolve_arg(self, arg):
        if isinstance(arg, dict):
            if 'f' in arg:
                return f32bits(arg['f'])
            if '$texture' in arg:
                return self.build_texture(arg['$texture'])
            if 'this' in arg:
                return self.cur_this
        return arg & 0xffffffff

    def _resolve_args(self, args, mode):
        """Expand structured arg specs.  Method mode passes raw dwords; exec
        mode produces eval specs consumed by on_gnative.

        {'$borders': [9 texture specs|0]} — the borders array eval: builds a
        9-dword array and points GPropAddr at it (the property-reference
        path).  {'$bordersLocal': [...]} leaves GPropAddr clear and writes the
        nine pointers to the eval result buffer (the by-value path).
        {'$text': str}/{'$units': [u16..]} — exec: {'fstring': (data,num,max)};
        method: the raw buffer pointer.  {'$font': {...}} — a UFont image."""
        built = []
        for a in args:
            if isinstance(a, dict) and ('$borders' in a or '$bordersLocal' in a):
                key = '$borders' if '$borders' in a else '$bordersLocal'
                ptrs = [self.build_texture(s) if s else 0 for s in a[key]]
                if mode == 'method':
                    built.extend(ptrs)
                elif key == '$borders':
                    base = self.alloc(4 * len(ptrs))
                    for i, p in enumerate(ptrs):
                        self.write(base + 4 * i, 'I', p)
                    built.append({'gprop': base})
                else:
                    built.append({'local': ptrs})
            elif isinstance(a, dict) and ('$text' in a or '$units' in a):
                units = a.get('$units')
                if units is None:
                    units = [ord(c) for c in a['$text']]
                buf = self.build_text(units)
                if mode == 'method':
                    built.append(buf)
                else:
                    num = len(units) + 1 if units else 0
                    built.append({'fstring': (buf if num else 0, num, num)})
            elif isinstance(a, dict) and '$font' in a:
                built.append(self.build_font(a['$font']))
            else:
                built.append(self._resolve_arg(a))
        return built

    # ----- case drivers --------------------------------------------------------
    def run_method(self, native, this, args):
        return self.call(NATIVES[native]['method'], this,
                         struct.pack('<%dI' % len(args), *args))

    def run_exec(self, native, this, args):
        frame = self.alloc(0x20)
        self.cpu.mem_write(frame, b'\0' * 0x20)
        code = self.alloc(0x40)
        self.cpu.mem_write(code, b'\x1c' * 0x40)  # token byte for every position
        self.write(frame + 8, 'I', this)
        self.write(frame + 0xc, 'I', code)
        self.exec_params = list(args)
        out = self.alloc(4)
        self.write(out, 'I', 0xdeadbeef)
        return self.call(NATIVES[native]['exec'], this,
                         struct.pack('<II', frame, out))

    def run_case(self, native, case):
        self.events = []
        self.seen_ids = {}
        self.tex_ids = {}
        self.font_ids = {}
        self.text_ids = {}
        self.canvas_addr = 0
        self.node_addr = 0
        self.vp_addr = 0
        self.ri_addr = 0
        this = self.gc_object(case['spec'])
        mode = case.get('mode', 'exec')
        args = self._resolve_args(case.get('args', []), mode)
        if mode == 'method':
            self.run_method(native, this, args)
        else:
            self.run_exec(native, this, args)
        return {'events': self.events}


def oracle_main(native_name, cases, root=None):
    root = Path(root or sys.argv[1])
    probe = GcDrawProbe(root)
    entry = NATIVES[native_name]
    results = {}
    for name, case in cases.items():
        if case.get('mode', 'exec') == 'method' and entry['method'] is None:
            raise ValueError('%s has no method body' % native_name)
        results[name] = {**case, **probe.run_case(native_name, case)}
    print(json.dumps({
        'hashes': {'Extension.dll': EXTENSION_HASH,
                   'Core.dll': _NATIVE.HASHES['Core.dll'],
                   'Engine.dll': _NATIVE.HASHES['Engine.dll'],
                   'MSVCRT.dll': MSVCRT_HASH},
        'extensionBase': EXT,
        'execBody': (entry['exec'] - EXT) + IMAGE_BASE,
        'methodBody': ((entry['method'] - EXT) + IMAGE_BASE
                       if entry['method'] else None),
        'cases': results,
    }))
