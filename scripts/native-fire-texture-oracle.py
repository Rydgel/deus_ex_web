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
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_EIP

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

        def on_code(uc, address, size, data):
            if address in self.slots:
                raise RuntimeError(f'Unresolved Fire.dll import reached: {self.slots[address]}')
        cpu.hook_add(UC_HOOK_CODE, on_code, begin=self.trap, end=self.trap + 0x10000)

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
            self.write(slot, 'I', address)
        self.write(PENTIUM_PRO_IMPORT, 'I', self.pentium_pro)
        self.free = self.heap + 0x100
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
            elif c.get('entry') == 'flash':
                entry = 0x105022f0
                x, y, xd, yd, c1, c2 = c['flash']
                esp -= 12
                self.write(esp, 'I4B2I', self.done, x, y, xd, yd, c1, c2)
                cpu.reg_write(UC_X86_REG_ESP, esp)
            cpu.emu_start(entry, self.done, count=50_000_000)
            n = c['fields']['USize'] * c['fields']['VSize']
            spark_data, spark_num = self.read(texture + 0xf4, '2I')
            steps.append({
                'pixels': bytes(cpu.mem_read(pixels, n)).hex(),
                'sparks': bytes(cpu.mem_read(spark_data, spark_num * 8)).hex(),
                'fields': {name: self.read(texture + offset, fmt)[0] for name, (offset, fmt) in FIELDS.items()},
                'random': bytes(cpu.mem_read(RANDOM, 256)).hex(),
                'randomIndex': self.read(RANDOM_INDEX, 'I')[0],
            })
        return {'steps': steps}


def main():
    probe = FireProbe(sys.argv[1])
    results = [probe.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]
    print(json.dumps({'fireSha256': FIRE_HASH, 'results': results}))


if __name__ == '__main__':
    main()
