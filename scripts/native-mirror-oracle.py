"""Original Render.dll mirror frame and D3DDrv.dll blend-state reference.

Inputs/outputs and all original binaries stay local. Executes the unchanged
OccludeBsp mirror segment, stopping immediately before CreateChildFrame, and
the complete SetBlending function with a recording COM device. See
docs/mirror-surfaces.md. No render, visibility or blend arithmetic is stubbed.
"""
import importlib.util
import json
from pathlib import Path
import sys
from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('lighting', Path(__file__).with_name('native-dynamic-light-oracle.py'))
lighting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lighting)
D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'


class Oracle(lighting.Oracle):
    def __init__(self, root):
        # The pass runs in DrawFrame (render pass); ORACLE_CW (the precision
        # audit, docs/render-pass-precision.md) overrides the 0x037f default.
        super().__init__(root, lighting.native.render_control_word())
        core = self.core.exports()
        for lib, symbol, slot in self.render.imports():
            if lib == 'core.dll' and symbol in core:
                self.write(slot, 'I', core[symbol])
        d3d = lighting.native.Image(Path(root) / 'System' / 'D3DDrv.dll', D3D_HASH)
        self.cpu.mem_map(d3d.base, (d3d.size + 4095) & ~4095)
        for _, _, virtual, size, raw in d3d.sections:
            if size:
                self.cpu.mem_write(d3d.base + virtual, d3d.data[raw:raw + size])
        for _, _, slot in d3d.imports():
            self.write(slot, 'I', lighting.TRAP)
        # Page 0 (the SEH prologue's fs:[0]) is mapped by the lighting oracle.
        self.states = []
        self.record_state = lighting.STUBS + 0x200
        self.cpu.mem_write(self.record_state, bytes.fromhex('31c0c20c00'))  # HRESULT S_OK; stdcall 3 args.
        self.cpu.hook_add(UC_HOOK_CODE, self.record, begin=self.record_state, end=self.record_state)

    def record(self, cpu, address, size, _):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        _, state, value = self.read(esp + 4, 'III')
        self.states.append([state, value])

    def mirror(self, case):
        if not hasattr(self, 'mirror_buffers'):
            self.mirror_buffers = self.alloc(0x100), self.alloc(16), self.alloc(0x100), self.alloc(0x100)
        frame, plane, render, spans = self.mirror_buffers
        for address, size in zip(self.mirror_buffers, (0x100, 16, 0x100, 0x100)):
            self.cpu.mem_write(address, bytes(size))
        self.write(frame + 0x34, '12f', *case['coords'])
        self.write(frame + 0x20, 'f', case.get('mirror', 1))
        self.write(plane, '4f', *case['plane'])
        ebp = self.frame()
        # OccludeBsp's locals reach ebp-0xd94 (the FCoords at 10b189d6); keep
        # pushes and Core callees below all of them.
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x1000)
        self.write(ebp + 8, 'I', frame)
        self.write(ebp - 0x1c, 'I', plane)
        self.write(ebp - 0x24, 'I', render)
        self.write(ebp - 0x44, 'I', spans)
        self.write(ebp - 0x74, 'I', 1)
        self.run(0x10b188ce, 0x10b18b55)
        esp = self.cpu.reg_read(UC_X86_REG_ESP)
        args = self.read(esp, '9I')
        return {'coords': self.read(args[7], '12f'), 'clip': self.read(args[6], '4f'),
                'mirror': self.read(esp + 20, 'f')[0]}

    def after_child(self, flags):
        """10b18b58-10b18b93, after CreateChildFrame: the surface flags the
        parent draws with. [ebp-0x30] is flags & 0x47 (10b182d9-10b182de);
        [ebp-0x4c] is Viewport->RenDev, whose +0x48 (SpanBased) D3DDrv never
        sets."""
        if not hasattr(self, 'render_device'):
            self.render_device = self.alloc(0x100)
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x1000)
        self.write(ebp - 0x20, 'I', flags)
        self.write(ebp - 0x30, 'I', flags & 0x47)
        self.write(ebp - 0x4c, 'I', self.render_device)
        self.write(self.render_device + 0x48, 'I', 0)
        self.run(0x10b18b58, 0x10b18b93)
        return self.read(ebp - 0x20, 'I')[0]

    def blending(self, flags):
        render, device, vtable = self.alloc(0xb00), self.alloc(4), self.alloc(0x100)
        self.write(render + 0x9a4, 'I', device)
        self.write(device, 'I', vtable)
        self.write(vtable + 0x50, 'I', self.record_state)
        # Start from zero blend flags so the required state transitions execute.
        self.states = []
        self.call(0x10008270, [flags], render)
        return {'states': self.states, 'flags': self.read(render + 0xa6c, 'I')[0]}


if __name__ == '__main__':
    oracle = Oracle(sys.argv[1])
    cases = json.load(sys.stdin)
    json.dump({'frames': [oracle.mirror(c) for c in cases['frames']],
               'blends': [oracle.blending(c) for c in cases['blends']],
               'afterChild': [oracle.after_child(c) for c in cases.get('afterChild', [])]}, sys.stdout)
