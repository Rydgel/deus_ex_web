"""Execute the original Render.dll moving-light lightmap path.

Optional research tool, never imported by the browser. Runs the hash-pinned
Render.dll and Engine.dll bodies documented in docs/dynamic-lighting.md:
the light-manager square-root/normal tables, ComputeFromActor's radius, colour,
incidence and rectangle segments, Engine FGetHSV, the normal/NonIncidence
spatial functions, colour merge and FDynamicLight::Filter over a supplied BSP.
Core's original FVector constructor runs unchanged; appSqrt uses its own body
(fld/fsqrt/ret), and FMemStack::PushBytes uses a bump allocator. Other imports
trap unless explicitly linked below. Cases arrive as JSON on stdin.
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
NUM_DYN_LIGHT_LEAVES, DYN_LIGHT_LEAVES = 0x10b595fc, 0x10b59600
FILTER = 0x10b24a10
DYNAMIC_LIGHT_VTABLE = 0x10b2b80c


def extended_of_double(value):
    """The 80-bit extended encoding (10 bytes, little-endian) of a double."""
    bits = struct.unpack('<Q', struct.pack('<d', value))[0]
    sign, exponent, mantissa = bits >> 63, (bits >> 52) & 0x7ff, bits & ((1 << 52) - 1)
    if exponent == 0 and mantissa == 0:
        return struct.pack('<QH', 0, sign << 15)
    if exponent == 0:  # subnormal: normalize
        shift = 53 - mantissa.bit_length()
        mantissa <<= shift
        exponent = 1 - shift
    significand = (mantissa | (1 << 52)) << 11
    return struct.pack('<QH', significand & ((1 << 64) - 1), (sign << 15) | (exponent - 1023 + 16383))


# The spatial function of each effect (table 0x10b2a0f0).
SPATIAL = {4: 0x10b03770, 5: 0x10b03de0, 6: 0x10b040b0, 7: 0x10b04380, 9: 0x10b043a0, 10: 0x10b046f0,
           14: 0x10b05740, 16: 0x10b04c80, 18: 0x10b03ae0, 0: 0x10b03360, 13: 0x10b054e0}
LEVEL_INFO = 0x10b3df88    # Level->Actors(0), read for TimeSeconds (+0x478)


class Oracle:
    def __init__(self, root, control_word):
        system = Path(root) / 'System'
        self.render = native.Image(system / 'Render.dll', RENDER_HASH)
        self.engine = native.Image(system / 'Engine.dll')
        self.core = native.Image(system / 'Core.dll')
        self.control_word = control_word
        # The light-manager tables come from FLightManager::Init, which
        # URender::Init (0x10b1358d) calls on the game thread, before any
        # render pass: they are built at this word whatever control_word the
        # per-frame bodies run at (docs/render-pass-precision.md).
        self.init_control_word = 0x037f
        cpu = self.cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        for image in (self.render, self.engine, self.core):
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
        # appPow(x, y) and appIsNan(x): Python's double pow loaded onto the
        # x87 stack (the host's choice for this transcendental, as in
        # static-lighting.mjs), and the NaN test.
        self.stub_pow = STUBS + 0x60
        self.pow_slot = STUBS + 0x80
        cpu.mem_write(self.stub_pow, bytes.fromhex('dd05') + struct.pack('<I', self.pow_slot) + bytes.fromhex('c3'))
        self.stub_isnan = STUBS + 0x90
        cpu.mem_write(self.stub_isnan, bytes.fromhex('c3'))
        # SEH frames go through fs:[0] with a zero FS base.
        cpu.mem_map(0, 0x1000)
        # msvcrt _ftol as the truncating x87 sequence (native-fire-texture-oracle.py).
        self.stub_ftol = STUBS + 0x100 + 0x40
        cpu.mem_write(self.stub_ftol, bytes.fromhex('83ec0c' 'd93c24' '668b0424' '660d000c' '6689442402' 'd96c2402'
                                                    'df7c2404' 'd92c24' '8b442404' '8b542408' '83c40c' 'c3'))
        # appFrand: the case's scripted doubles, loaded onto the x87 stack.
        self.stub_frand = STUBS + 0xc0
        self.frand_slot = STUBS + 0xe0
        cpu.mem_write(self.stub_frand, bytes.fromhex('dd05') + struct.pack('<I', self.frand_slot) + bytes.fromhex('c3'))
        self.frand_values = []

        def on_frand(uc, address, size, data):
            uc.mem_write(self.frand_slot, struct.pack('<d', self.frand_values.pop(0)))
        cpu.hook_add(UC_HOOK_CODE, on_frand, begin=self.stub_frand, end=self.stub_frand)
        # UObject::IsA(Class): a fabricated light is never a Pawn.
        self.stub_isa = STUBS + 0xa0
        cpu.mem_write(self.stub_isa, bytes.fromhex('31c0' 'c20400'))

        def on_stub(uc, address, size, data):
            import math
            esp = uc.reg_read(UC_X86_REG_ESP)
            if address == self.stub_pow:
                x, y = struct.unpack('<dd', uc.mem_read(esp + 4, 16))
                try:
                    value = math.pow(x, y)
                except (OverflowError, ZeroDivisionError):
                    value = math.inf
                except ValueError:  # pow(0, negative) is +inf, a negative base NaN
                    value = math.inf if x == 0 else math.nan
                uc.mem_write(self.pow_slot, struct.pack('<d', value))
            elif address == self.stub_isnan:
                x = struct.unpack('<d', uc.mem_read(esp + 4, 8))[0]
                uc.reg_write(UC_X86_REG_EAX, 1 if x != x else 0)
        cpu.hook_add(UC_HOOK_CODE, on_stub, begin=self.stub_pow, end=self.stub_isnan)
        # Core appAtan2(Y, X) is `fld Y; fld X; fpatan` (0x10123280); Unicorn's
        # FPATAN goes through a host double, so the extended result comes
        # from `self.fpatan` (measured on x87 hardware, keyed by the two
        # double bit patterns) and is loaded with FLD m80. Every requested
        # pair is recorded; a pair without a measurement is listed in
        # `self.atan_missing` and answered from Python's double atan2.
        # appFmod (msvcrt _CIfmod: an fprem loop, exact for finite
        # operands) is Python's exact math.fmod loaded as a double.
        self.stub_atan2 = STUBS + 0x200
        self.atan_slot = STUBS + 0x220
        cpu.mem_write(self.stub_atan2, bytes.fromhex('db2d') + struct.pack('<I', self.atan_slot) + bytes.fromhex('c3'))
        self.stub_fmod = STUBS + 0x240
        self.fmod_slot = STUBS + 0x260
        cpu.mem_write(self.stub_fmod, bytes.fromhex('dd05') + struct.pack('<I', self.fmod_slot) + bytes.fromhex('c3'))
        self.fpatan, self.atan_pairs, self.atan_missing = {}, [], set()

        def on_math(uc, address, size, data):
            import math
            esp = uc.reg_read(UC_X86_REG_ESP)
            if address == self.stub_atan2:
                yb, xb = struct.unpack('<QQ', uc.mem_read(esp + 4, 16))
                key = f'{yb:016x}:{xb:016x}'
                self.atan_pairs.append(key)
                value = self.fpatan.get(key)
                if value is None:
                    self.atan_missing.add(key)
                    y, x = struct.unpack('<dd', struct.pack('<QQ', yb, xb))
                    value = extended_of_double(math.atan2(y, x))
                uc.mem_write(self.atan_slot, value)
            else:
                x, y = struct.unpack('<dd', uc.mem_read(esp + 4, 16))
                uc.mem_write(self.fmod_slot, struct.pack('<d', math.fmod(x, y)))
        cpu.hook_add(UC_HOOK_CODE, on_math, begin=self.stub_atan2, end=self.stub_atan2)
        cpu.hook_add(UC_HOOK_CODE, on_math, begin=self.stub_fmod, end=self.stub_fmod)
        # appMemset(dest, value, count): rep stosb.
        self.stub_memset = STUBS + 0x40
        cpu.mem_write(self.stub_memset, bytes.fromhex('57' '8b7c2408' '8b44240c' '8b4c2410' 'f3aa' '5f' 'c3'))
        cpu.mem_write(RETURN, b'\xf4')
        engine_exports = self.engine.exports()
        core_exports = self.core.exports()
        self.world_light_radius = engine_exports['?WorldLightRadius@AActor@@UBEMXZ']
        self.fgethsv_address = engine_exports['?FGetHSV@@YA?AVFPlane@@EEE@Z']
        self.gmem = HEAP + 0x100
        for image in (self.render, self.engine, self.core):
            for library, symbol, slot in image.imports():
                target = TRAP
                if symbol == '?appSqrt@@YANN@Z':
                    target = self.stub_sqrt
                elif symbol == '?appMemset@@YAXPAXHH@Z':
                    target = self.stub_memset
                elif symbol == '?appPow@@YANNN@Z':
                    target = self.stub_pow
                elif symbol == '?appIsNan@@YAHN@Z':
                    target = self.stub_isnan
                elif library == 'msvcrt.dll' and symbol == '_ftol':
                    target = self.stub_ftol
                elif symbol == '?appFrand@@YAMXZ':
                    target = self.stub_frand
                elif symbol == '?IsA@UObject@@QBEHPAVUClass@@@Z':
                    target = self.stub_isa
                elif symbol == '?appAtan2@@YANNN@Z':
                    target = self.stub_atan2
                elif symbol == '?appFmod@@YANNN@Z':
                    target = self.stub_fmod
                elif library == 'core.dll' and symbol in ('?GMath@@3VFGlobalMath@@A', '??_0FCoords@@QAEAAV0@ABVFRotator@@@Z'):
                    target = core_exports[symbol]
                elif symbol == '?PushBytes@FMemStack@@QAEPAEHH@Z':
                    target = self.stub_push
                elif symbol == '?GMem@@3VFMemStack@@A':
                    target = self.gmem
                elif library == 'engine.dll' and symbol in engine_exports:
                    target = engine_exports[symbol]
                elif library == 'core.dll' and symbol == '??0FVector@@QAE@MMM@Z':
                    target = core_exports[symbol]
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

    def reset_fpu(self, control_word=None):
        word = self.control_word if control_word is None else control_word
        for register, value in [(UC_X86_REG_FPCW, word), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
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

    def init_run(self, start, stop):
        """A light-manager init segment, at the init control word."""
        self.reset_fpu(self.init_control_word)
        self.cpu.emu_start(start, stop)

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
        self.init_run(0x10b0225b, 0x10b022d0)
        return list(self.read(SQRT_TABLE, '2048I'))

    def normal_table(self):
        self.frame()
        self.init_run(0x10b022fe, 0x10b02352)
        return list(self.read(0x10b34a6c, '4096I'))

    # Light-manager init 0x10b02112-0x10b0225b (the local 8x8 shadow weight
    # matrix) and 0x10b02352-0x10b0243e: the 128-pattern table at 0x10b3cae0.
    def shadow_table(self):
        if getattr(self, 'shadow_ready', False):
            return list(self.read(0x10b3cae0, '512I'))
        self.frame()
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.init_run(0x10b02112, 0x10b0225b)
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.init_run(0x10b02352, 0x10b0243e)
        self.shadow_ready = True
        return list(self.read(0x10b3cae0, '512I'))

    # 0x10b02650(LightMap, ShadowBits, Out): the static light's illumination
    # bytes, rows padded to whole shadow bytes (ILLUM_BYTES * 8 texels).
    def illumination(self, case):
        self.shadow_table()
        width, height = case['clamp']
        pitch = (width + 7) >> 3
        self.write(ILLUM_BYTES, 'i', pitch)
        self.write(0x10b3cad4, 'i', pitch * height)
        self.write(CLAMP_U, 'ii', width, height)
        bits = bytes.fromhex(case['bits']) if case.get('bits') is not None else None
        shadow = 0
        if bits is not None:
            shadow = self.alloc(len(bits) + 16)
            self.cpu.mem_write(shadow, bits)
        out = self.alloc(pitch * 8 * (height + 1) + 16)
        self.cpu.mem_write(out, b'\xcd' * (pitch * 8 * (height + 1)))
        self.call(0x10b02650, [LIGHTMAP, shadow, out])
        return bytes(self.read(out, f'{pitch * 8 * (height + 1)}B')).hex()

    # SetupForSurf 0x10b07fcc-0x10b080cf: the zone ambient FGetHSV(hue,
    # saturation, brightness) as the static map's fill texel (BGRA).
    def ambient(self, hue, saturation, brightness):
        result = self.alloc(0x10)
        self.call(self.fgethsv_address, [result, hue, saturation, brightness])
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_EAX, result)
        self.run(0x10b07fd2, 0x10b080cf)
        return self.read(ebp + 0xc, 'I')[0]

    # Init 0x10b022d0-0x10b022e4: the x^-0.5 tables (0x10b33650, 0x10b3d384).
    def rsqrt_tables(self):
        self.frame()
        self.init_run(0x10b022d0, 0x10b022e4)
        return {'mantissa': list(self.read(0x10b33650, '1024I')), 'exponent': list(self.read(0x10b3d384, '512I'))}

    # GMath's UnitCoords and trig table for Core's FCoords /= FRotator; the
    # caller supplies coords.mjs's sine table (its own validation).
    def gmath(self, sines):
        gmath = self.core.exports()['?GMath@@3VFGlobalMath@@A']
        self.write(gmath + 0x18, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        self.write(0x101b32a4, f'{len(sines)}I', *sines)

    # Spot 0x10b04f80 and the merge, as spatial_merge; the light's Rotation
    # (+0x120) and LightCone (+0x1e8) come from the case.
    def spot_merge(self, case):
        light, facet, grid, rect, constants = case['light'], case['facet'], case['grid'], case['rect'], case['constants']
        width, height = facet['clamp']
        stride = ((width + 7) >> 3) * 8
        info, actor = self.alloc(0x100), self.actor(light)
        self.write(actor + 0x120, 'iii', *light.get('rotation', (0, 0, 0)))
        self.write(actor + 0x1e8, 'B', light.get('cone', 0))
        illum, spatial = self.alloc(stride * height + 16), self.alloc(width * height + 16)
        self.cpu.mem_write(illum, bytes.fromhex(case['illumination'])[:stride * height])
        self.write(info, 'I', actor)
        self.write(info + 0x18, 'II', constants['rradius'], constants['rr2'])
        self.write(info + 0x24, 'I', constants['incidence'])
        self.write(info + 0x34, 'iiii', *rect)
        self.write(START, 'III', *grid['start'])
        self.write(STEP_U, 'III', *grid['stepU'])
        self.write(STEP_V, 'III', *grid['stepV'])
        self.lightmap_globals(facet)
        self.call(case.get('address', 0x10b04f80), [LIGHTMAP, info, illum, spatial])
        return {'spatial': list(self.read(spatial, f'{width * height}B'))}

    # The light manager's square-root (0x10b3e1b8) and normal falloff
    # (0x10b34a6c) tables as supplied (float bit patterns), instead of the
    # init code's, so a spatial body is compared on Play's own tables.
    def set_tables(self, tables):
        self.write(SQRT_TABLE, '2048I', *tables['sqrt'])
        self.write(0x10b34a6c, '4096I', *tables['normal'])
        self.write(0x10b34a5c, 'B', 1)  # the normal body's local static guard

    # A spatial function of the effect table (SPATIAL) over one light map
    # rectangle: the light's location, LightPeriod (+0x1e6) and LightPhase
    # (+0x1e7), info's 1/R (+0x18), rr2 (+0x1c), incidence (+0x24) and
    # rectangle (+0x34), Level.TimeSeconds at [0x10b3df88]+0x478, the grid
    # globals and rectangle-relative illumination bytes (null: 0x7f, a
    # moving light). Returns the rectangle's spatial bytes and the appAtan2
    # pairs the body asked for, in order.
    def spatial_dynamic(self, case):
        if not hasattr(self, 'spatial_buffers'):
            self.spatial_buffers = (self.alloc(0x100), self.alloc(0x800), self.alloc(0x100), self.alloc(0x600),
                                    self.alloc(1 << 20), self.alloc(1 << 20))
        vtable, actor, info, level, illum, out = self.spatial_buffers
        width, height = case['clamp']
        minU, maxU, minV, maxV = case['rect']
        pitch = (width + 7) >> 3
        stride = pitch * 8
        if stride * height > (1 << 20) or width * height > (1 << 20):
            raise ValueError('light map too large for the spatial fixture')
        self.write(vtable + 0x60, 'I', self.world_light_radius)
        self.write(actor, 'I', vtable)
        self.write(actor + 0x114, 'III', *case['location'])
        self.write(actor + 0x1e1, 'B', case['effect'])
        self.write(actor + 0x1e6, 'BB', case.get('period', 0), case.get('phase', 0))
        self.write(info, 'I', actor)
        constants = case['constants']
        self.write(info + 0x18, 'II', constants['rradius'], constants['rr2'])
        self.write(info + 0x24, 'I', constants['incidence'])
        self.write(info + 0x34, 'iiii', minU, maxU, minV, maxV)
        self.write(level + 0x478, 'I', case['time'])
        self.write(LEVEL_INFO, 'I', level)
        self.write(START, 'III', *case['grid']['start'])
        self.write(STEP_U, 'III', *case['grid']['stepU'])
        self.write(STEP_V, 'III', *case['grid']['stepV'])
        self.write(CLAMP_U, 'ii', width, height)
        self.write(SIZE_U, 'i', 1 << (width - 1).bit_length())
        self.write(ILLUM_BYTES, 'i', pitch)
        self.write(ILLUM_PAD, 'i', stride - width)
        rw = max(0, maxU - minU)
        source = bytes.fromhex(case['illumination']) if case.get('illumination') is not None else None
        buffer = bytearray([0x7f]) * (stride * height)
        if source is not None:
            for v in range(minV, maxV):
                buffer[v * stride + minU:v * stride + maxU] = source[(v - minV) * rw:(v - minV + 1) * rw]
        self.cpu.mem_write(illum, bytes(buffer))
        self.cpu.mem_write(out, b'\xcd' * (width * height))
        self.atan_pairs = []
        self.call(case.get('address', SPATIAL[case['effect']]), [LIGHTMAP, info, illum, out])
        rows = [bytes(self.read(out + v * width + minU, f'{rw}B')) for v in range(minV, maxV)] if rw else []
        return {'spatial': b''.join(rows).hex(), 'pairs': self.atan_pairs}

    # The per-frame noise 0x10b13080(time) over a sequence of times.
    def noise(self, case):
        self.frand_values = list(case['frand'])
        self.write(0x10b50248, 'i', case.get('last', 0))
        for table in (0x10b4fa44, 0x10b4fe44, 0x10b4f640):
            self.cpu.mem_write(table, bytes(0x404))
        steps = []
        for time in case['times']:
            self.call(0x10b13080, [struct.unpack('<I', struct.pack('<f', time))[0]])
            steps.append({'A': list(self.read(0x10b4fa44, '256I')), 'W': list(self.read(0x10b4fe44, '256I')),
                          'S': list(self.read(0x10b4f644, '256I')), 'last': self.read(0x10b50248, 'i')[0]})
        return {'steps': steps, 'left': len(self.frand_values)}

    # GlobalLighting 0x10b05e90(animate, actor, &brightness, &colour) per
    # frame for one light: LightType/Period/Phase, Level.TimeSeconds, the
    # noise table A and the shared strobe state.
    def light_type(self, case):
        light = case['light']
        actor, level = self.actor({'location': (0, 0, 0), 'brightness': light['brightness'], 'radius': 1,
                                   'type': light['type'], 'hue': light.get('hue', 0), 'saturation': light.get('saturation', 0)}), self.alloc(0x600)
        self.write(actor + 0x1e6, 'BB', light.get('period', 0), light.get('phase', 0))
        self.write(actor + 0xa8, 'I', level)
        self.write(0x10b49ea4, 'II', *case.get('strobe', (0, 0)))
        out = []
        for frame in case['frames']:
            self.write(level + 0x478, 'f', frame['time'])
            self.write(0x10b4fa44, '256I', *frame['A'])
            brightness, color = self.alloc(4), self.alloc(16)
            self.write(brightness, 'I', frame['brightness'])
            self.call(0x10b05e90, [case.get('animate', 1), actor, brightness, color])
            out.append({'brightness': self.read(brightness, 'I')[0], 'strobe': list(self.read(0x10b49ea4, 'II'))})
        return {'frames': out, 'flickerKey': actor & 0xff}

    # The merge 0x10b03040 with a merge-dynamic effect (1-3): noise tables,
    # start index, spatial bytes and colour table from the case.
    def merge_mod(self, case):
        width, height = case['clamp']
        self.write(CLAMP_U, 'ii', width, height)
        self.write(0x10b4fa44, '256I', *case['A'])
        self.write(0x10b4fe44, '256I', *case['W'])
        size_u = 1 << (width - 1).bit_length()
        self.write(SIZE_U, 'i', size_u)
        info, spatial, colors = self.alloc(0x100), self.alloc(width * height + 16), self.alloc(0x400)
        self.cpu.mem_write(spatial, bytes(case['spatial']))
        self.write(colors, '256I', *case['table'])
        self.write(info + 0x8c, 'I', colors)
        self.write(info + 0x28, 'I', spatial)
        self.write(info + 0x34, 'iiii', *case['rect'])
        source, target = self.alloc(size_u * height * 4 + 16), self.alloc(size_u * height * 4 + 16)
        for y in range(height):
            self.write(source + y * size_u * 4, f'{width}I', *case['static'][y * width:(y + 1) * width])
        self.call(0x10b03040, [LIGHTMAP, case['effect'], case['index'], info, source, target])
        rect = case['rect']
        merged = []
        for y in range(height):
            row = self.read(target + y * size_u * 4, f'{width}I')
            merged.extend(row[x] if rect[0] <= x < rect[1] and rect[2] <= y < rect[3] else case['static'][y * width + x] for x in range(width))
        return {'merged': merged}

    # Class 2 lights over successive frames as SetupForSurf sets them up
    # each frame (0x10b0850f-0x10b088f9). Per frame: Level.TimeSeconds and
    # the noise tables A (0x10b4fa44) and W (0x10b4fe44). Per light:
    # ComputeFromActor's brightness (0x10b060b1), GlobalLighting (0x10b05e90:
    # the LightType function, Flicker's table A at the actor's low address
    # byte, the shared strobe state at 0x10b49ea4) and the colour and colour
    # table (0x10b06122, 0x10b064ff). Per reached surface: the radius
    # constants (0x10b05fc3), incidence (0x10b06325), the rectangle
    # (0x10b0660e), the unshadowed illumination (0x7f, as 0x10b02650 with no
    # shadow bits), the effect row's spatial function (table 0x10b2a0f0) and
    # the merge 0x10b03040 from index 0 onto a zero map: the texels' colour
    # entries. The case's `flickerKey` places the actor at that low byte.
    def moving_frames(self, case):
        if not getattr(self, 'moving_ready', False):
            self.sqrt_table()
            self.normal_table()
            self.rsqrt_tables()
            self.moving_ready = True
        if case.get('sines'):
            self.gmath(case['sines'])
        level = self.alloc(0x600)
        self.write(level + 0x500, 'I', case['levelBrightness'])
        self.write(0x10b49ea4, 'II', *case.get('strobe', (0, 0)))
        frames = []
        for frame in case['frames']:
            mark = self.alloc_top
            self.write(level + 0x478, 'I', frame['time'])
            self.write(0x10b4fa44, '256I', *frame['A'])
            self.write(0x10b4fe44, '256I', *frame['W'])
            lights = []
            for light in frame['lights']:
                # An actor whose address has the light's flicker key as its low byte.
                base = self.alloc(0x900, align=0x100)
                actor = base + (light.get('flickerKey', 0) & 0xff)
                vtable = self.alloc(0x100)
                self.cpu.mem_write(actor, bytes(0x800))
                self.write(vtable + 0x60, 'I', self.world_light_radius)
                self.write(actor, 'I', vtable)
                self.write(actor + 0xa8, 'I', level)
                self.write(actor + 0x114, 'III', *light['location'])
                self.write(actor + 0x120, 'iii', *light.get('rotation', (0, 0, 0)))
                self.write(actor + 0x1e0, 'BBBBBB', light['type'], light['effect'], light['brightness'],
                           light.get('hue', 0), light.get('saturation', 0), light['radius'])
                self.write(actor + 0x1e6, 'BBB', light.get('period', 0), light.get('phase', 0), light.get('cone', 0))
                info, cache = self.alloc(0x100), self.alloc(0x440)
                self.write(info, 'I', actor)
                self.frame()
                self.cpu.reg_write(UC_X86_REG_EAX, actor)
                self.cpu.reg_write(UC_X86_REG_EDI, info + 0x20)
                self.run(0x10b060b1, 0x10b060d0)
                self.call(0x10b05e90, [1, actor, info + 0x20, info + 0x6c])
                self.frame()
                self.cpu.reg_write(UC_X86_REG_EBX, info)
                self.cpu.reg_write(UC_X86_REG_ESI, info + 0x6c)
                self.cpu.reg_write(UC_X86_REG_EDI, info + 0x20)
                self.run(0x10b06122, 0x10b0614b)
                self.cpu.reg_write(UC_X86_REG_ESI, cache)
                self.run(0x10b064ff, 0x10b065e2)
                table = cache + 0xc
                row = self.read(0x10b2a0f0 + 12 * (light['effect'] if light['effect'] < 20 else 0), 'III')
                contributions = []
                for item in light['contributions']:
                    facet, grid = item['facet'], item['grid']
                    width, height = facet['clamp']
                    ebp = self.frame()
                    self.write(ebp + 0xc, 'I', self.alloc(0x100))
                    self.cpu.reg_write(UC_X86_REG_EBX, info)
                    self.run(0x10b05fc3, 0x10b0602c)
                    coords = self.alloc(0x40)
                    self.write(coords, '12I', *facet['origin'], *facet['axisU'], *facet['axisV'], *facet['normal'])
                    self.write(FACET, 'I', coords)
                    self.frame()
                    self.cpu.reg_write(UC_X86_REG_EBX, info)
                    self.run(0x10b06325, 0x10b0639e)
                    self.lightmap_globals(facet)
                    ebp = self.frame()
                    self.write(ebp - 0x2c, 'I', info)
                    self.cpu.reg_write(UC_X86_REG_EBX, info)
                    self.cpu.reg_write(UC_X86_REG_ECX, coords)
                    self.cpu.reg_write(UC_X86_REG_EAX, 0)
                    self.run(0x10b0660e, 0x10b06868)
                    rect = list(self.read(info + 0x34, 'iiii'))
                    out = {'rect': rect, 'constants': list(self.read(info + 0x14, 'III')), 'incidence': self.read(info + 0x24, 'I')[0]}
                    if rect[0] < rect[1] and rect[2] < rect[3]:
                        stride = ((width + 7) >> 3) * 8
                        illum, spatial = self.alloc(stride * height + 16), self.alloc(width * height + 16)
                        self.cpu.mem_write(illum, bytes([0x7f]) * (stride * height))
                        self.write(START, 'III', *grid['start'])
                        self.write(STEP_U, 'III', *grid['stepU'])
                        self.write(STEP_V, 'III', *grid['stepV'])
                        self.write(0x10b34a5c, 'B', 1)  # the normal body's local static guard
                        self.call(row[0], [LIGHTMAP, info, illum, spatial])
                        size_u = 1 << (width - 1).bit_length()
                        target = self.alloc(size_u * height * 4 + 16)
                        self.write(info + 0x8c, 'I', table)
                        self.write(info + 0x28, 'I', spatial)
                        self.call(0x10b03040, [LIGHTMAP, light['effect'], 0, info, target, target])
                        rw = rect[1] - rect[0]
                        out['spatial'] = b''.join(bytes(self.read(spatial + v * width + rect[0], f'{rw}B'))
                                                  for v in range(rect[2], rect[3])).hex()
                        out['merged'] = [word for v in range(rect[2], rect[3])
                                         for word in self.read(target + (v * size_u + rect[0]) * 4, f'{rw}I')]
                    contributions.append(out)
                lights.append({'brightness': self.read(info + 0x20, 'I')[0], 'color': list(self.read(info + 0x6c, 'III')),
                               'table': list(self.read(table, '256I')), 'contributions': contributions})
            frames.append({'lights': lights, 'strobe': list(self.read(0x10b49ea4, 'II'))})
            self.alloc_top = mark
        return {'frames': frames}

    def incidence(self, light, facet, reciprocal):
        info, coords = self.alloc(0x100), self.alloc(0x40)
        actor = self.actor(light)
        self.write(info, 'I', actor)
        self.write(info + 0x18, 'I', reciprocal)
        self.write(coords, '12I', *facet['origin'], *facet['axisU'], *facet['axisV'], *facet['normal'])
        self.write(FACET, 'I', coords)
        self.frame()
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.run(0x10b06325, 0x10b0639e)
        return self.read(info + 0x24, 'I')[0]

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

    # Normal 0x10b03360 / NonIncidence 0x10b054e0, then merge 0x10b03040
    # onto a copy of the supplied static texels.
    def spatial_merge(self, light, facet, grid, rect, constants, table, static, illumination=0x7f):
        width, height = facet['clamp']
        stride = ((width + 7) >> 3) * 8
        info, actor = self.alloc(0x100), self.actor(light)
        illum, spatial = self.alloc(stride * height + 16), self.alloc(width * height + 16)
        if isinstance(illumination, str):
            self.cpu.mem_write(illum, bytes.fromhex(illumination)[:stride * height])
        else:
            self.cpu.mem_write(illum, bytes([illumination]) * (stride * height))
        self.write(info, 'I', actor)
        self.write(info + 0x18, 'II', constants['rradius'], constants['rr2'])
        self.write(info + 0x24, 'I', constants.get('incidence', 0))
        self.write(info + 0x34, 'iiii', *rect)
        self.write(START, 'III', *grid['start'])
        self.write(STEP_U, 'III', *grid['stepU'])
        self.write(STEP_V, 'III', *grid['stepV'])
        self.lightmap_globals(facet)
        effect = light.get('effect', 13)
        if effect not in (0, 13):
            raise ValueError(f'Unsupported oracle spatial effect {effect}')
        # Normal's local static registers an empty CRT destructor once. Supply
        # its initialized guard; the numerical body still runs unchanged.
        self.write(0x10b34a5c, 'B', 1)
        self.call(0x10b03360 if effect == 0 else 0x10b054e0, [LIGHTMAP, info, illum, spatial])
        bytes_out = list(self.read(spatial, f'{width * height}B'))
        size_u = 1 << (width - 1).bit_length()
        colors = self.alloc(0x400)
        self.write(colors, '256I', *table)
        self.write(info + 0x8c, 'I', colors)
        self.write(info + 0x28, 'I', spatial)
        source, target = self.alloc(size_u * height * 4 + 16), self.alloc(size_u * height * 4 + 16)
        for y in range(height):
            self.write(source + y * size_u * 4, f'{width}I', *static[y * width:(y + 1) * width])
        self.call(0x10b03040, [LIGHTMAP, effect, 0, info, source, target])
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
        for index, (px, py, pz, pw, surface, back, front, coplanar, *leaves) in enumerate(nodes):
            struct.pack_into('<ffff', blob, index * 64, px, py, pz, pw)
            struct.pack_into('<iiii', blob, index * 64 + 0x1c, surface, back, front, coplanar)
            # FBspNode.iLeaf[back, front]; -1 when the fixture omits leaves.
            struct.pack_into('<ii', blob, index * 64 + 0x38, *(leaves or (-1, -1)))
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
        leaf_count = max([max(node[8:10]) for node in nodes if len(node) > 8] + [0]) + 1
        leaf_lights = self.alloc(leaf_count * 4 + 0x100)
        self.write(LEAF_LIGHTS, 'I', leaf_lights)
        self.write(NUM_DYN_LIGHT_LEAVES, 'i', 0)
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
        leaf_total = self.read(NUM_DYN_LIGHT_LEAVES, 'i')[0]
        leaves = list(self.read(DYN_LIGHT_LEAVES, f'{leaf_total}i')) if leaf_total else []
        return {'surfaces': sorted(lit), 'dynLightSurfs': order, 'visited': visited, 'leaves': leaves}


def main():
    # argv[2]: the control word of the per-frame bodies: the render pass's
    # precision control 24, 0x007f, by default (docs/render-pass-precision.md;
    # the audit's ORACLE_CW also selects it). argv[3]: the light-manager init
    # tables' word (default 0x037f, the game thread's).
    root = sys.argv[1]
    control_word = int(sys.argv[2], 0) if len(sys.argv) > 2 else native.render_control_word(0x007f)
    cases = json.load(sys.stdin)
    oracle = Oracle(root, control_word)
    if len(sys.argv) > 3:
        oracle.init_control_word = int(sys.argv[3], 0)
    out = {'controlWord': control_word, 'initControlWord': oracle.init_control_word}
    if cases.get('sqrtTable'):
        out['sqrtTable'] = oracle.sqrt_table()
    if cases.get('normalTable'):
        out['normalTable'] = oracle.normal_table()
    out['radii'] = [oracle.radius_constants(radius) for radius in cases.get('radii', [])]
    out['hsv'] = [oracle.fgethsv(*triple) for triple in cases.get('hsv', [])]
    out['colors'] = [oracle.color_table(case['brightness'], case['levelBrightness'], case['hsv'])
                     for case in cases.get('colors', [])]
    out['rects'] = [oracle.rect(case['light'], case['facet']) for case in cases.get('rects', [])]
    out['incidence'] = [oracle.incidence(case['light'], case['facet'], case['rradius'])
                        for case in cases.get('incidence', [])]
    out['spatial'] = [oracle.spatial_merge(case['light'], case['facet'], case['grid'], case['rect'],
                                           case['constants'], case['table'], case['static'], case.get('illumination', 0x7f))
                      for case in cases.get('spatial', [])]
    if cases.get('shadowTable'):
        out['shadowTable'] = oracle.shadow_table()
    out['illumination'] = [oracle.illumination(case) for case in cases.get('illumination', [])]
    out['ambient'] = [oracle.ambient(*triple) for triple in cases.get('ambient', [])]
    if cases.get('rsqrtTables') or cases.get('spots'):
        out['rsqrtTables'] = oracle.rsqrt_tables()
    if cases.get('sines'):
        oracle.gmath(cases['sines'])
    out['spots'] = [oracle.spot_merge(case) for case in cases.get('spots', [])]
    out['noise'] = [oracle.noise(case) for case in cases.get('noise', [])]
    out['lightTypes'] = [oracle.light_type(case) for case in cases.get('lightTypes', [])]
    out['mergeMods'] = [oracle.merge_mod(case) for case in cases.get('mergeMods', [])]
    out['movingFrames'] = [oracle.moving_frames(case) for case in cases.get('movingFrames', [])]
    if cases.get('spatialDynamic'):
        oracle.fpatan = {key: bytes.fromhex(value)[::-1] for key, value in cases.get('fpatan', {}).items()}
        oracle.set_tables(cases['tables'])
        out['spatialDynamic'] = [oracle.spatial_dynamic(case) for case in cases['spatialDynamic']]
        out['atanMissing'] = sorted(oracle.atan_missing)
    model = cases.get('model')
    out['filters'] = [oracle.filter(model, light) for light in cases.get('filters', [])] if model else []
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
