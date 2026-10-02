"""Execute Fire.dll's original UFireTexture::ConstantTimeTick (0x10507ff0) on
fabricated fire textures.

Fire.dll (hash-pinned) is mapped alone. A case gives the UFireTexture fields
at their retail offsets (class size 0x50c, asserted by PostLoad), the sparks
array, the pixel buffer (Mips(0).DataPtr, FMipmap +0x1c), the RenderTable,
GIsPentiumPro and the module's global state: the sine table (0x1051723c), its
two derived tables (0x10518250, 0x10518f84) and the lagged-XOR random table
(0x10518358, 64 dwords) with its byte index (0x10518558). ConstantTimeTick
runs `ticks` times (RedrawSparks, the self-modifying fire update in .data,
PostDrawSparks); after each, every byte of the pixels, the sparks, the
texture fields and the random state is recorded.

  native-fire-texture-oracle.py GAME_ROOT CASES_JSON
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_ESI, UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_EIP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
FIRE_HASH = '64bdcd86329f205fbae1a1bbc55dfcc8d14de23be9b9c35331ff06ff03644d28'
CONSTANT_TIME_TICK = 0x10507ff0
SINE, SINE_CLAMPED, SINE_SIGNED = 0x1051723c, 0x10518250, 0x10518f84
RANDOM, RANDOM_INDEX = 0x10518358, 0x10518558
PENTIUM_PRO_IMPORT = 0x10510014
FIELDS = {  # retail offsets
    'UBits': (0x30, 'B'), 'VBits': (0x31, 'B'), 'USize': (0x34, 'i'), 'VSize': (0x38, 'i'),
    'UMask': (0xc0, 'i'), 'VMask': (0xc4, 'i'), 'LightOutput': (0xc8, 'i'), 'SoundOutput': (0xcc, 'i'),
    'GlobalPhase': (0xd0, 'i'), 'DrawPhase': (0xd4, 'B'), 'AuxPhase': (0xd5, 'B'),
    'SparkType': (0xd8, 'B'), 'RenderHeat': (0xd9, 'B'), 'bRising': (0xdc, 'I'),
    'FX_Heat': (0xe0, 'B'), 'FX_Size': (0xe1, 'B'), 'FX_AuxSize': (0xe2, 'B'), 'FX_Area': (0xe3, 'B'),
    'FX_Frequency': (0xe4, 'B'), 'FX_Phase': (0xe5, 'B'), 'FX_HorizSpeed': (0xe6, 'B'), 'FX_VertSpeed': (0xe7, 'B'),
    'DrawMode': (0xe8, 'B'), 'SparksLimit': (0xec, 'i'), 'ActiveSparkNum': (0xf0, 'i'),
    'OldRenderHeat': (0x100, 'i'), 'StarStatus': (0x508, 'B'), 'PenDownX': (0x509, 'B'), 'PenDownY': (0x50a, 'B'),
}


class FireProbe:
    def __init__(self, root):
        self.image = native.Image(Path(root) / 'System' / 'Fire.dll', FIRE_HASH)
        cpu = self.cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        image = self.image
        cpu.mem_map(image.base, (image.size + 4095) & ~4095)
        for _, _, virtual, raw_size, raw in image.sections:
            if raw_size:
                cpu.mem_write(image.base + virtual, image.data[raw:raw + raw_size])
        self.pristine = bytes(cpu.mem_read(image.base, (image.size + 4095) & ~4095))
        self.heap = 0x30000000
        cpu.mem_map(self.heap, 0x01000000)
        self.stack = 0x2f000000
        cpu.mem_map(self.stack - 0x100000, 0x100000)
        self.done = self.heap  # a ret target: emulation stops here
        self.free = self.heap + 0x100
        # Unresolved imports land on a trap page that names the slot.
        self.trap = 0x2e000000
        cpu.mem_map(self.trap, 0x10000)
        # SEH frames go through fs:[0] with a zero FS base.
        cpu.mem_map(0, 0x1000)
        self.slots, self.iat = {}, []
        for library, symbol, slot in image.imports():
            address = self.trap + 4 * len(self.slots)
            self.slots[address] = f'{library}!{symbol}'
            self.iat.append((slot, address))
        self.pentium_pro = self.alloc(4)
        # Leaves for the load-time entries: msvcrt _ftol as the truncating x87
        # sequence (as native-mesh-light-oracle.py), appSin as FSIN of the
        # double argument, appRand from the case's list, and FArray's
        # Remove/Realloc on the {Data, Num, Max} header.
        self.stubs = {}
        self.leaf = 0x2d000000
        cpu.mem_map(self.leaf, 0x1000)
        cpu.mem_write(self.leaf, bytes.fromhex('83ec0c' 'd93c24' '668b0424' '660d000c' '6689442402' 'd96c2402'
                                               'df7c2404' 'd92c24' '8b442404' '8b542408' '83c40c' 'c3'))
        cpu.mem_write(self.leaf + 0x40, bytes.fromhex('dd442404' 'd9fe' 'c3'))  # fld qword [esp+4]; fsin; ret
        for slot, address in self.iat:
            name = self.slots[address]
            if name.endswith('!_ftol'):
                self.stubs[slot] = self.leaf
            elif '?appSin@' in name:
                self.stubs[slot] = self.leaf + 0x40
        self.rand_values = []
        self.halt = set()

        def ret(uc, pop):
            esp = uc.reg_read(UC_X86_REG_ESP)
            back = struct.unpack('<I', uc.mem_read(esp, 4))[0]
            uc.reg_write(UC_X86_REG_ESP, esp + 4 + pop)
            uc.reg_write(UC_X86_REG_EIP, back)

        def on_code(uc, address, size, data):
            name = self.slots.get(address)
            if name is None:
                return
            esp = uc.reg_read(UC_X86_REG_ESP)
            if '?appRand@' in name:
                uc.reg_write(UC_X86_REG_EAX, self.rand_values.pop(0))
                return ret(uc, 0)
            if '?Remove@FArray@' in name:
                this = uc.reg_read(UC_X86_REG_ECX)
                index, count, size_ = struct.unpack('<3i', uc.mem_read(esp + 4, 12))
                data_, num, _max = struct.unpack('<3I', uc.mem_read(this, 12))
                tail = bytes(uc.mem_read(data_ + (index + count) * size_, (num - index - count) * size_))
                uc.mem_write(data_ + index * size_, tail)
                uc.mem_write(this + 4, struct.pack('<I', num - count))
                return ret(uc, 12)
            if '?Realloc@FArray@' in name:
                this = uc.reg_read(UC_X86_REG_ECX)
                size_ = struct.unpack('<i', uc.mem_read(esp + 4, 4))[0]
                data_, num, max_ = struct.unpack('<3I', uc.mem_read(this, 12))
                fresh = self.alloc(max_ * size_)
                old = bytes(uc.mem_read(data_, min(num, max_) * size_)) if data_ else b''
                uc.mem_write(fresh, bytes(max_ * size_))
                uc.mem_write(fresh, old[:max_ * size_])
                uc.mem_write(this, struct.pack('<I', fresh))
                return ret(uc, 4)
            raise RuntimeError(f'Unresolved Fire.dll import reached: {name}')
        cpu.hook_add(UC_HOOK_CODE, on_code, begin=self.trap, end=self.trap + 0x10000)

        def on_halt(uc, address, size, data):
            if address in self.halt:
                uc.emu_stop()
        cpu.hook_add(UC_HOOK_CODE, on_halt)

    def alloc(self, size):
        address = self.free
        self.free += (size + 15) & ~15
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, self.cpu.mem_read(address, struct.calcsize('<' + fmt)))

    def run(self, c):
        cpu, image = self.cpu, self.image
        # A fresh module image per case: the update routine patches itself.
        cpu.mem_write(image.base, self.pristine)
        for slot, address in self.iat:
            self.write(slot, 'I', self.stubs.get(slot, address))
        self.write(PENTIUM_PRO_IMPORT, 'I', self.pentium_pro)
        self.free = self.heap + 0x100
        if c.get('entry') == 'tables':
            return self.tables(c)
        if c.get('entry') == 'water':
            return self.water(c)
        if c.get('entry') == 'drops':
            return self.drops(c)
        self.pentium_pro = self.alloc(4)
        self.write(PENTIUM_PRO_IMPORT, 'I', self.pentium_pro)
        self.write(self.pentium_pro, 'I', c.get('pentiumPro', 1))
        cpu.mem_write(SINE, bytes.fromhex(c['sine']))
        cpu.mem_write(SINE_CLAMPED, bytes.fromhex(c['sineClamped']))
        cpu.mem_write(SINE_SIGNED, bytes.fromhex(c['sineSigned']))
        cpu.mem_write(RANDOM, bytes.fromhex(c['random']))
        self.write(RANDOM_INDEX, 'I', c['randomIndex'])
        texture = self.alloc(0x50c)
        cpu.mem_write(texture, bytes(0x50c))
        for name, (offset, fmt) in FIELDS.items():
            if name in c['fields']:
                self.write(texture + offset, fmt, c['fields'][name])
        cpu.mem_write(texture + 0x104, bytes.fromhex(c['renderTable']))
        pixels = self.alloc(c['fields']['USize'] * c['fields']['VSize'])
        cpu.mem_write(pixels, bytes.fromhex(c['pixels']))
        mips = self.alloc(0x40)
        self.write(mips + 0x1c, 'I', pixels)
        self.write(texture + 0xa4, '3I', mips, 1, 1)
        spark_bytes = bytes.fromhex(c['sparks'])
        sparks = self.alloc(max(len(spark_bytes), 8))
        cpu.mem_write(sparks, spark_bytes)
        count = len(spark_bytes) // 8
        self.write(texture + 0xf4, '3I', sparks, count, count)
        steps = []
        for _ in range(c['ticks']):
            esp = self.stack - 0x1000
            self.write(esp, 'I', self.done)
            cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.reg_write(UC_X86_REG_ECX, texture)
            cpu.reg_write(UC_X86_REG_FPCW, 0x037f)
            # 'redraw' runs RedrawSparks (0x105025b0) alone, without the fire
            # update; 'flash' calls DrawFlashRamp (0x105022f0) with c['flash'] =
            # [X, Y, XD, YD, Color1, Color2].
            entry = CONSTANT_TIME_TICK
            if c.get('entry') == 'redraw':
                entry = 0x105025b0
            elif c.get('entry') == 'postLoad':
                # UFireTexture::PostLoad from the RenderTable loop through the
                # spark array (0x10507d62), ebx = 0 as the function holds it.
                entry = 0x10507d62
                cpu.reg_write(UC_X86_REG_ESI, texture)
                cpu.reg_write(UC_X86_REG_EBX, 0)
                cpu.reg_write(UC_X86_REG_EBP, self.stack - 0x800)
                self.halt = {0x10507f36, 0x10507f7e}
            elif c.get('entry') == 'flash':
                entry = 0x105022f0
                x, y, xd, yd, c1, c2 = c['flash']
                esp -= 12
                self.write(esp, 'I4B2I', self.done, x, y, xd, yd, c1, c2)
                cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.emu_start(entry, self.done, count=50_000_000)
            self.halt = set()
            n = c['fields']['USize'] * c['fields']['VSize']
            spark_data, spark_num = self.read(texture + 0xf4, '2I')
            steps.append({
                'pixels': bytes(cpu.mem_read(pixels, n)).hex(),
                'sparks': bytes(cpu.mem_read(spark_data, spark_num * 8)).hex(),
                'fields': {name: self.read(texture + offset, fmt)[0] for name, (offset, fmt) in FIELDS.items()},
                'random': bytes(cpu.mem_read(RANDOM, 256)).hex(),
                'randomIndex': self.read(RANDOM_INDEX, 'I')[0],
                'renderTable': bytes(cpu.mem_read(texture + 0x104, 1028)).hex(),
                'sparkNum': spark_num,
            })
        return {'steps': steps}

    def water(self, c):
        """UWaterTexture::CalculateWater (0x105059c0) `ticks` times on a
        fabricated water texture: SourceFields, RenderTable (+0x8ec),
        WaveTable (+0xcf0), WaveParity (+0x12f0), USize/VSize, mip 0."""
        cpu = self.cpu
        w, h = c['size']
        texture = self.alloc(0x1400)
        cpu.mem_write(texture, bytes(0x1400))
        field = bytes.fromhex(c['field'])
        fields = self.alloc(len(field))
        cpu.mem_write(fields, field)
        pixels = self.alloc(w * h)
        cpu.mem_write(pixels, bytes.fromhex(c['pixels']))
        mips = self.alloc(0x40)
        self.write(mips + 0x1c, 'I', pixels)
        self.write(texture + 0xa4, 'I', mips)
        self.write(texture + 0x34, '2i', w, h)
        self.write(texture + 0x8e8, 'I', fields)
        cpu.mem_write(texture + 0x8ec, bytes.fromhex(c['renderTable']))
        cpu.mem_write(texture + 0xcf0, bytes.fromhex(c['waveTable']))
        self.write(texture + 0x12f0, 'B', c['parity'])
        steps = []
        for _ in range(c['ticks']):
            esp = self.stack - 0x1000
            self.write(esp, 'I', self.done)
            cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.reg_write(UC_X86_REG_ECX, texture)
            cpu.emu_start(0x105059c0, self.done, count=50_000_000)
            steps.append({'field': bytes(cpu.mem_read(fields, len(field))).hex(), 'pixels': bytes(cpu.mem_read(pixels, w * h)).hex(),
                          'parity': self.read(texture + 0x12f0, 'B')[0]})
        return {'steps': steps}

    def drops(self, c):
        """UWaterTexture::WaterRedrawDrops (0x10506410) `ticks` times: the
        drops (+0xe8, NumDrops +0xe4), the FX bytes (+0xd8..+0xe1), the masks,
        GlobalPhase and SourceFields, with the module tables and generator."""
        cpu = self.cpu
        cpu.mem_write(SINE, bytes.fromhex(c['sine']))
        cpu.mem_write(SINE_CLAMPED, bytes.fromhex(c['sineClamped']))
        cpu.mem_write(SINE_SIGNED, bytes.fromhex(c['sineSigned']))
        cpu.mem_write(RANDOM, bytes.fromhex(c['random']))
        self.write(RANDOM_INDEX, 'I', c['randomIndex'])
        w, h = c['size']
        texture = self.alloc(0x1400)
        cpu.mem_write(texture, bytes(0x1400))
        field = bytes.fromhex(c['field'])
        fields = self.alloc(len(field) + 64)
        cpu.mem_write(fields, field)
        ubits = w.bit_length() - 1
        self.write(texture + 0x30, '2B', ubits, h.bit_length() - 1)
        self.write(texture + 0x34, '2i', w, h)
        self.write(texture + 0xc0, '2i', w - 1, h - 1)
        self.write(texture + 0xd0, 'i', c['globalPhase'])
        cpu.mem_write(texture + 0xd8, bytes(c['fx']))
        self.write(texture + 0xe4, 'i', c['numDrops'])
        cpu.mem_write(texture + 0xe8, bytes.fromhex(c['drops']))
        self.write(texture + 0x8e8, 'I', fields)
        steps = []
        for _ in range(c['ticks']):
            esp = self.stack - 0x1000
            self.write(esp, 'I', self.done)
            cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.reg_write(UC_X86_REG_ECX, texture)
            cpu.reg_write(UC_X86_REG_FPCW, 0x037f)
            cpu.emu_start(0x10506410, self.done, count=50_000_000)
            steps.append({'field': bytes(cpu.mem_read(fields, len(field))).hex(), 'drops': bytes(cpu.mem_read(texture + 0xe8, 2048)).hex(),
                          'numDrops': self.read(texture + 0xe4, 'i')[0], 'globalPhase': self.read(texture + 0xd0, 'i')[0],
                          'random': bytes(cpu.mem_read(RANDOM, 256)).hex(), 'randomIndex': self.read(RANDOM_INDEX, 'I')[0]})
        return {'steps': steps}

    def tables(self, c):
        """The module tables' one-time construction (0x10501020) with the
        case's appRand values."""
        cpu = self.cpu
        self.write(0x10519580, 'I', 0)
        self.rand_values = list(c['rand'])
        esp = self.stack - 0x1000
        self.write(esp, 'I', self.done)
        cpu.reg_write(UC_X86_REG_ESP, esp)
        cpu.reg_write(UC_X86_REG_FPCW, c.get('fpcw', 0x037f))
        cpu.emu_start(0x10501020, self.done, count=10_000_000)
        return {'sine': bytes(cpu.mem_read(SINE, 256)).hex(), 'sineClamped': bytes(cpu.mem_read(SINE_CLAMPED, 256)).hex(),
                'sineSigned': bytes(cpu.mem_read(SINE_SIGNED, 256)).hex(), 'random': bytes(cpu.mem_read(RANDOM, 512)).hex(),
                'randomIndex': self.read(RANDOM_INDEX, 'I')[0], 'left': len(self.rand_values)}


def main():
    probe = FireProbe(sys.argv[1])
    results = [probe.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]
    print(json.dumps({'fireSha256': FIRE_HASH, 'results': results}))


if __name__ == '__main__':
    main()
