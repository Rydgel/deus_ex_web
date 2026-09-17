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

# Exec trampoline / method body (rebased).
NATIVES = {
    'drawTexture': {'exec': EXT + 0x2c520, 'method': EXT + 0x28b00, 'kind': 'void'},
}

# Extension IAT slots.
GNATIVES_IAT = EXT + 0x59064    # Core!GNatives table import
GPROPADDR_IAT = EXT + 0x590d0   # Core!GPropAddr import

DRAW_TILE_SLOT = 0x5c           # UCanvas vtable slot for DrawTile
CANVAS_Z = 0x4c                 # f32 forwarded as the DrawTile Z arg
TEX_USIZE = 0x34                # i32 UBitmap.USize the clip helper reads
TEX_VSIZE = 0x38

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

        # Recording DrawTile stub: the code hook captures the argument block
        # at entry, then the real `ret 0x50` performs thiscall cleanup —
        # callee pops all 80 stack bytes, matching UCanvas::DrawTile.
        self.drawtile_stub = self.alloc(16)
        self.cpu.mem_write(self.drawtile_stub, b'\xc2\x50\x00')

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
        if address in self.thunks:
            raise RuntimeError(
                f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        if address == self.gnative_stub:
            self.on_gnative(cpu)
        elif address == self.drawtile_stub:
            self.on_draw_tile(cpu)

    def on_gnative(self, cpu):
        """Model one param expression eval: (ecx=object, frame, resultPtr)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result_ptr = self.read(stack + 4, '2I')
        if not self.exec_params:
            raise RuntimeError('GNatives eval with no configured param')
        spec = self.exec_params.pop(0)
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

    def canon(self, ptr):
        """Stable pointer label: 'this' the GC, 'canvas' the fake canvas,
        'tex<i>' spec textures, 'a<N>' anything else in encounter order."""
        if not ptr:
            return 0
        if ptr in (UGC_VTABLE, IMAGE_BASE + 0x598dc):
            return 'UGC::vtable'
        if ptr == self.cur_this:
            return 'this'
        if ptr == self.canvas_addr:
            return 'canvas'
        if ptr in self.tex_ids:
            return self.tex_ids[ptr]
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
        """Fake Engine.Canvas: vtable slot +0x5c -> recording stub."""
        spec = spec or {}
        canvas = self.alloc(0x80)
        vtable = self.alloc(0x100)
        self.cpu.mem_write(canvas, b'\0' * 0x80)
        self.cpu.mem_write(vtable, b'\0' * 0x100)
        self.write(vtable + DRAW_TILE_SLOT, 'I', self.drawtile_stub)
        self.write(canvas, 'I', vtable)
        self.write(canvas + CANVAS_Z, 'I',
                   self._resolve_value(spec.get('z', 0)) & 0xffffffff)
        self.canvas_addr = canvas
        return canvas

    def build_texture(self, spec):
        """Fake UTexture stand-in: only +0x34/+0x38 (i32 dims) are read."""
        tex = self.alloc(0x60)
        self.cpu.mem_write(tex, b'\0' * 0x60)
        self.write(tex + TEX_USIZE, 'i', spec.get('u', 0))
        self.write(tex + TEX_VSIZE, 'i', spec.get('v', 0))
        self.tex_ids[tex] = 'tex%d' % len(self.tex_ids)
        return tex

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
        self.canvas_addr = 0
        this = self.gc_object(case['spec'])
        args = [self._resolve_arg(a) for a in case.get('args', [])]
        if case.get('mode', 'exec') == 'method':
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
        'methodBody': (entry['method'] - EXT) + IMAGE_BASE,
        'cases': results,
    }))
