"""XRootWindow::GenerateSnapshot (Extension.dll 0x10039410, native 1524) executed unchanged under Unicorn.

The method runs from the hash-pinned Extension.dll (rebased to 0x12000000) with Engine.dll and Core.dll. The exec calls it with
no existing texture, bFilter and zero flags; this oracle calls the method itself with an existing fake texture (so the
`operator new` of a UTexture is not reached) and the grey-path flags the exec passes. Everything between the viewport read and the
last byte store is original code: the FColor constructors, the _ftol calls, the x87 averaging. The stand-ins are the boundary
leaves, each recorded:
  * URenderDevice::ReadPixels (RenDev vtable +0xa0): copies the case's SizeX x SizeY dwords into the buffer the method allocates;
  * GMalloc's Malloc and Free (vtable +0 / +8): bump allocation from the probe heap;
  * the texture's Init(U, V) (vtable +0x64), vtable +0x20 and UTexture::CreateColorRange (an import): recorded events;
  * the texture's own storage: palette (texture +0x2c -> +0x28 -> 256 dwords) and the mip data (+0xa4 -> +0x1c).

Cases arrive as JSON on stdin:
  {"cases": [{"sizeX": n, "sizeY": n, "snapW": n, "snapH": n, "pixels": [dword x sizeX*sizeY]}]}
and the answer is {"results": [{"data": hex of the P8 bytes, "palette": hex, "events": [...]}]}.

  native-root-snapshot-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXT = 0x12000000
METHOD = EXT + 0x39410
GRENDERDEVICE_IAT, GMALLOC_IAT, CREATE_COLOR_RANGE_IAT = EXT + 0x59168, EXT + 0x59060, EXT + 0x59380
STUBS = 0x700f0000
READ_PIXELS, MALLOC, FREE, INIT, V20 = STUBS, STUBS + 0x20, STUBS + 0x40, STUBS + 0x60, STUBS + 0x80


class Snapshot(c.NativeCollision):
    def __init__(self, root):
        super().__init__(root, {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXT}})
        self.active, self.events, self.pixels = False, [], []
        for address, code in [(READ_PIXELS, 'c2 04 00'), (MALLOC, 'c2 08 00'), (FREE, 'c2 04 00'), (INIT, 'c2 08 00'), (V20, 'c3')]:
            self.cpu.mem_write(address, bytes.fromhex(code))
        # GRenderDevice -> URenderDevice (+0x34 Viewport) -> Viewport (+0x78 SizeX, +0x7c SizeY, +0x64 RenDev -> vtable +0xa0 ReadPixels).
        self.viewport, self.device, self.render_device = self.alloc(0x100), self.alloc(0x100), self.alloc(0x100)
        render_vtable, malloc_vtable = self.alloc(0x100), self.alloc(0x40)
        self.write(self.device + 0x34, 'I', self.viewport)
        self.write(self.viewport + 0x64, 'I', self.render_device)
        self.write(self.render_device, 'I', render_vtable)
        self.write(render_vtable + 0xa0, 'I', READ_PIXELS)
        variable = self.read(EXT + 0x59168, 'I')[0]            # the address of Core's GRenderDevice variable
        self.write(variable, 'I', self.device)
        malloc_object = self.alloc(0x10)
        self.write(malloc_object, 'I', malloc_vtable)
        self.write(malloc_vtable, 'II', MALLOC, 0)
        self.write(malloc_vtable + 8, 'I', FREE)
        self.write(self.read(GMALLOC_IAT, 'I')[0], 'I', malloc_object)
        # The fake texture: vtable (+0x64 Init, +0x20), palette at +0x2c, mip storage at +0xa4.
        self.texture, texture_vtable = self.alloc(0x200), self.alloc(0x100)
        self.palette_object, self.palette_data, self.mip = self.alloc(0x40), self.alloc(0x400), self.alloc(0x40)
        self.write(self.texture, 'I', texture_vtable)
        self.write(texture_vtable + 0x64, 'I', INIT)
        self.write(texture_vtable + 0x20, 'I', V20)
        self.write(self.texture + 0x2c, 'I', self.palette_object)
        self.write(self.palette_object + 0x28, 'I', self.palette_data)
        self.write(self.texture + 0xa4, 'I', self.mip)
        self.root = self.alloc(0x800)
        self.create_color_range = self.read(CREATE_COLOR_RANGE_IAT, 'I')[0]

    def on_instruction(self, cpu, address, size, data):
        if self.active:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            if address == READ_PIXELS:
                (buffer,) = self.read(stack + 4, 'I')
                self.cpu.mem_write(buffer, struct.pack(f'<{len(self.pixels)}I', *self.pixels))
                self.events.append(['ReadPixels', len(self.pixels)])
                return
            if address == MALLOC:
                request, _tag = self.read(stack + 4, '2I')
                block = self.alloc(request + 16)
                self.events.append(['Malloc', request])
                cpu.reg_write(UC_X86_REG_EAX, block)
                return
            if address == FREE:
                self.events.append(['Free'])
                return
            if address == INIT:
                self.events.append(['Init', *self.read(stack + 4, '2I')])
                return
            if address == V20:
                self.events.append(['Slot20'])
                return
            if address == self.create_color_range:
                self.events.append(['CreateColorRange'])
                cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])    # ret
                cpu.reg_write(UC_X86_REG_ESP, stack + 4)
                return
        super().on_instruction(cpu, address, size, data)

    def call(self, address, this, args):
        # The base call's 4,000,000-instruction budget is too small for a frame's worth of constructor and averaging loops.
        for reg, value in [(c.UC_X86_REG_ESP, self.stack), (c.UC_X86_REG_ECX, this), (c.UC_X86_REG_FPCW, self.control_word),
                           (c.UC_X86_REG_FPSW, 0), (c.UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.mem_write(self.stack + 4, args)
        self.cpu.emu_start(address, self.done + 1, count=80000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError('Native instruction budget exceeded')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def run(self, case):
        size_x, size_y, snap_w, snap_h = case['sizeX'], case['sizeY'], case['snapW'], case['snapH']
        self.pixels = case['pixels']
        self.write(self.viewport + 0x78, '2I', size_x, size_y)
        self.write(self.root + 0x738, '2I', snap_w, snap_h)
        # The mip data: the method assumes Init allocated the pitch x height bytes.
        pitch, height = pot(snap_w), pot(snap_h)
        data = self.alloc(max(pitch * height, 16))
        self.cpu.mem_write(data, bytes(max(pitch * height, 16)))
        self.write(self.mip + 0x1c, 'I', data)
        self.cpu.mem_write(self.palette_data, bytes(0x400))
        self.events, self.active = [], True
        try:
            # (existing texture, bFilter, colour flag, 4th) -- the exec passes 0, bFilter, 0, 0 with no texture; the oracle supplies one.
            result = self.call(METHOD, self.root, struct.pack('<4I', self.texture, 0, 0, 0))
        finally:
            self.active = False
        return {'returned': result == self.texture, 'pitch': pitch, 'height': height,
                'data': bytes(self.cpu.mem_read(data, pitch * height)).hex(), 'palette': bytes(self.cpu.mem_read(self.palette_data, 0x400)).hex(),
                'events': self.events, 'maxColor': self.read(self.texture + 0x48, 'I')[0]}


def pot(size):
    size &= 0xffffffff
    if size == 0:
        return 0
    power = 1
    while power <= 0x8000:
        if size <= power:
            return power
        power *= 2
    return 0 if size > 0x10000 else 0x10000


def main():
    oracle = Snapshot(Path(sys.argv[1]))
    cases = json.load(sys.stdin)['cases']
    print(json.dumps({'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
