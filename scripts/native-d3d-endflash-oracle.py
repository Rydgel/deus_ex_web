"""Execute the unchanged D3DDrv.dll UD3DRenderDevice::EndFlash (body 0x10007c90, vtable slot 0xa4, thunk 0x10001064).

The body runs as native x86 under a stubbed COM device: the IDirect3DDevice7 (this+0x9a4) and the
IDirect3DVertexBuffer7 (this+0xc8) are objects whose vtable entries are intercepted stubs that record their
arguments and return S_OK (Lock hands out a vertex memory block), and UD3DRenderDevice::SetBlending (0x1000103c) is
recorded, not run. Per case the oracle returns the calls in order and the four vertices EndFlash wrote (36 bytes
each at VertexBase + this+0xcc * 36).
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'
D3D_BASE = 0x13000000
END_FLASH = D3D_BASE + 0x7c90
END_FLASH_END = D3D_BASE + 0x80ab
SET_BLENDING = D3D_BASE + 0x103c
REG = _NATIVE


class EndFlashProbe(_NATIVE.NativeCollision):
    # EndFlash runs inside the render pass: URender::PreRender set precision control 24 (docs/render-pass-precision.md).
    control_word = 0x007f

    # (vtable offset) -> (name, argument dwords after this)
    DEVICE = {0x50: ('SetRenderState', 2), 0x7c: ('DrawPrimitiveVB', 5), 0x94: ('SetTextureStageState', 3)}
    BUFFER = {0xc: ('Lock', 3), 0x10: ('Unlock', 0)}

    def __init__(self, root):
        super().__init__(Path(root), {'D3DDrv.dll': {'hash': D3D_HASH, 'base': D3D_BASE}})
        self.device = self.alloc(0x40)
        self.buffer = self.alloc(0x40)
        self.viewport = self.alloc(0x100)
        self.render_device = self.alloc(0x1000)
        self.vertices = self.alloc(0x3000)
        self.dev_vtable = self.alloc(0x200)
        self.buf_vtable = self.alloc(0x100)
        self.stubs = {}
        self.calls = []
        stub = 0x70002000
        for owner, vtable, table in (('device', self.dev_vtable, self.DEVICE), ('buffer', self.buf_vtable, self.BUFFER)):
            for offset in range(0, 0x100, 4):
                self.stubs[stub] = (owner, offset, table.get(offset, (f'slot{offset:#x}', 0)))
                self.write(vtable + offset, 'I', stub)
                stub += 16
        self.write(self.device, 'I', self.dev_vtable)
        self.write(self.buffer, 'I', self.buf_vtable)
        self.running = False

    def on_instruction(self, cpu, address, size, data):
        if address in self.stubs and self.running:
            owner, offset, (name, nargs) = self.stubs[address]
            esp = cpu.reg_read(REG.UC_X86_REG_ESP)
            words = list(struct.unpack('<%dI' % (nargs + 2), cpu.mem_read(esp, 4 * (nargs + 2))))
            self.calls.append({'object': owner, 'method': name, 'args': words[2:2 + nargs]})
            if name == 'Lock':
                out = words[3]  # Lock(this, flags, void** ptr, hEvent)... stdcall: [ret, this, flags, ptr, event]
                self.write(out, 'I', self.vertices)
            cpu.reg_write(REG.UC_X86_REG_EAX, 0)
            cpu.reg_write(REG.UC_X86_REG_ESP, esp + 4 + 4 * (nargs + 1))
            cpu.reg_write(REG.UC_X86_REG_EIP, words[0])
            return
        if address == SET_BLENDING and self.running:
            esp = cpu.reg_read(REG.UC_X86_REG_ESP)
            ret, flags = struct.unpack('<II', cpu.mem_read(esp, 8))
            self.calls.append({'object': 'render', 'method': 'SetBlending', 'args': [flags]})
            cpu.reg_write(REG.UC_X86_REG_ESP, esp + 8)
            cpu.reg_write(REG.UC_X86_REG_EIP, ret)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, scale, fog, size_x, size_y, index, offset, normal_color_op, normal_alpha_op, z33, z43):
        self.cpu.mem_write(self.render_device, b'\x00' * 0x1000)
        self.cpu.mem_write(self.vertices, b'\x7e' * 0x3000)
        self.write(self.render_device + 0x34, 'I', self.viewport)
        self.write(self.viewport + 0x78, 'ii', size_x, size_y)
        self.write(self.render_device + 0x9a4, 'I', self.device)
        self.write(self.render_device + 0xc8, 'I', self.buffer)
        self.write(self.render_device + 0xcc, 'ii', index, offset)
        self.write(self.render_device + 0xa00, 'II', normal_color_op, normal_alpha_op)
        self.write(self.render_device + 0xa30, 'f', z33)
        self.write(self.render_device + 0xa40, 'f', z43)
        self.write(self.render_device + 0xa48, '8I', *[struct.unpack('<I', struct.pack('<f', v))[0] for v in (*scale, *fog)])
        self.calls = []
        self.running = True
        self.call(END_FLASH, self.render_device, b'')
        self.running = False
        out_index = self.read(self.render_device + 0xcc, 'i')[0]
        out_offset = self.read(self.render_device + 0xd0, 'i')[0]
        verts = bytes(self.cpu.mem_read(self.vertices + out_index * 36, 4 * 36)) if self.calls else b''
        drawn = any(c['method'] == 'DrawPrimitiveVB' for c in self.calls)
        return {'scale': list(scale), 'fog': list(fog), 'sizeX': size_x, 'sizeY': size_y, 'index': index, 'offset': offset,
                'normalColorOp': normal_color_op, 'normalAlphaOp': normal_alpha_op, 'z33': z33, 'z43': z43,
                'drawn': drawn, 'calls': self.calls, 'vertices': verts.hex(), 'outIndex': out_index, 'outOffset': out_offset}

    def run(self):
        neutral = (0.5, 0.5, 0.5, 0.0)
        black = (0.0, 0.0, 0.0, 0.0)
        scales = [neutral, (1.0, 1.0, 1.0, 0.0), (0.0, 0.0, 0.0, 0.0), (0.75, 0.75, 0.75, 0.0), (0.5039, 0.5039, 0.5039, 0.0),
                  (0.25, 0.25, 0.25, 0.0), (0.4999, 0.5, 0.5, 0.0), (0.5, 0.5, 0.5, 0.001), (0.9, 0.2, 0.1, 0.0), (0.52, 0.52, 0.52, 0.0)]
        fogs = [black, (0.1, 0.0, 0.0, 0.0), (1.0, 1.0, 1.0, 0.0), (0.05, 0.15, 0.0, 0.0), (0.0, 0.0, 0.5, 0.0), (0.0019531, 0.9961, 0.5, 0.0),
                (0.3, 0.6, 0.9, 0.0), (0.0, 0.0, 0.0, 0.2), (0.00195, 0.00196, 0.00391, 0.0), (0.7, 0.7, 0.7, 0.0)]
        cases = []
        for si, scale in enumerate(scales):
            for fi, fog in enumerate(fogs):
                if (si + fi) % 3 == 0 or scale == neutral or fog == black:
                    cases.append(self.case(scale, fog, 1440, 960, 0, 4, 4, 1, 1.0, 0.5))
        # Exact byte-valued products: v * 256 - 0.5 lands on n + 0.5 and fistp's round-to-nearest-even decides.
        ties = [k / 256 for k in (1, 2, 3, 25, 26, 127, 128, 129, 253, 254, 255)]
        for k in ties:
            cases.append(self.case((0.5, 0.5, 0.5, 0.0), (k, k, k, 0.0), 1440, 960, 0, 4, 4, 1, 1.0, 0.5))
        for k in (1, 3, 25, 26, 127, 129, 253, 255):
            cases.append(self.case((k / 512, 0.5, 0.5, 0.0), (0.0, 0.0, 0.0, 0.0), 1440, 960, 0, 4, 4, 1, 1.0, 0.5))
        # Buffer wrap (the discard path), another viewport and projection terms.
        cases.append(self.case((1.0, 1.0, 1.0, 0.0), (0.3, 0.6, 0.9, 0.0), 800, 600, 8000, 8000, 1, 2, 0.9, -0.25))
        cases.append(self.case((0.9, 0.9, 0.9, 0.0), (0.0, 0.2, 0.2, 0.0), 640, 480, 12, 16, 7, 3, 1.5, 0.125))
        image = _NATIVE.Image(self.root_path / 'System' / 'D3DDrv.dll', D3D_HASH)
        body = image.data[image.offset(END_FLASH - D3D_BASE):image.offset(END_FLASH_END - D3D_BASE)]
        return {'bodySha256': hashlib.sha256(body).hexdigest(), 'cases': cases}


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-d3d-endflash-oracle.py GAME_ROOT')
    probe = EndFlashProbe(sys.argv[1])
    probe.root_path = Path(sys.argv[1])
    print(json.dumps(probe.run()))


if __name__ == '__main__':
    main()
