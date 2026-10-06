"""Original Render.dll light coronas (docs/coronas.md).

Runs unchanged Render.dll code over fabricated frames, viewports, levels and
lights (Render, Core and Engine hash-pinned, native-dynamic-light-oracle.py):
- the visibility helper 0x10b1bc00 (cdecl Frame, Cache, &Next, Light, Delta)
  with XLevel's SingleLineCheck (vtable +0xc0) answering from the case and
  Engine's own ULevel::GetActorIndex;
- the draw loop 0x10b1b745-0x10b1bafc over a prepared 32-entry cache, the
  canvas DrawIcon (Viewport+0x5c, vtable +0x60) recording its arguments.
Core's FPlane constructors run natively; UObject::IsValid (the entries'
assertion) answers 1.

  native-coronas-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_ECX, UC_X86_REG_ESI

spec = importlib.util.spec_from_file_location('lighting', Path(__file__).with_name('native-dynamic-light-oracle.py'))
lighting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lighting)
HELPER, LOOP, LOOP_END = 0x10b1bc00, 0x10b1b745, 0x10b1bafc
STUBS = 0x700e0000


class CoronaOracle(lighting.Oracle):
    def __init__(self, root):
        self.trace_stub, self.icon_stub, self.valid_stub = STUBS, STUBS + 0x40, STUBS + 0x80
        # The pass runs in DrawFrame, inside the render pass: precision
        # control 24, 0x007f (docs/render-pass-precision.md); ORACLE_CW (the
        # audit) selects another word.
        super().__init__(root, lighting.native.render_control_word(0x007f))
        self.cpu.mem_map(STUBS, 0x1000)
        # SingleLineCheck(Hit, Source, End, Start, Flags, Extent, NodeFlags): 7 dwords + FVector = 0x24 bytes.
        self.cpu.mem_write(self.trace_stub, bytes.fromhex('c22400'))
        # DrawIcon(Texture, X, Y, XL, YL, Span, Z, Color, Fog, PolyFlags) = 0x40 bytes.
        self.cpu.mem_write(self.icon_stub, bytes.fromhex('c24000'))
        self.cpu.mem_write(self.valid_stub, bytes.fromhex('b801000000c3'))
        core = self.core.exports()
        for symbol, slot in (('??0FPlane@@QAE@MMMM@Z', 0x10b5d528), ('??0FPlane@@QAE@ABV0@@Z', 0x10b5d530),
                             ('??0FPlane@@QAE@ABVFVector@@@Z', 0x10b5d5c4)):
            self.write(slot, 'I', core[symbol])
        self.write(0x10b5d5c8, 'I', self.valid_stub)     # UObject::IsValid
        self.answers, self.traces, self.icons = [], [], []
        self.case_top = self.alloc_top

    def on_trace(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        hit, source, end, start, flags = self.read(esp + 4, '5I')
        outside, actor = self.answers.pop(0)
        self.traces.append([flags, list(self.read(end, '3I')), list(self.read(start, '3I'))])
        self.write(hit + 4, 'I', actor)
        cpu.reg_write(lighting.UC_X86_REG_EAX, outside)

    def on_icon(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        args = self.read(esp + 4, '16I')
        self.icons.append({'canvas': cpu.reg_read(UC_X86_REG_ECX), 'texture': args[0], 'x': args[1], 'y': args[2], 'xl': args[3],
                           'yl': args[4], 'span': args[5], 'z': args[6], 'color': list(args[7:11]), 'fog': list(args[11:15]),
                           'flags': args[15]})

    def hook(self, cpu, address, size, data):
        if address == self.trace_stub:
            self.on_trace(cpu)
        elif address == self.icon_stub:
            self.on_icon(cpu)

    def world(self, case):
        level, vtable = self.alloc(0x100), self.alloc(0x200)
        self.write(level, 'I', vtable)
        self.write(vtable + 0xc0, 'I', self.trace_stub)
        lights = []
        for light in case['lights']:
            actor = self.alloc(0x400)
            self.write(actor + 0xac, 'I', level)
            self.write(actor + 0x114, '3I', *light['location'])
            self.write(actor + 0x28, 'I', light.get('flags', 0))
            self.write(actor + 0x170, 'I', 0x7000 + len(lights) if light.get('skin', True) else 0)
            self.write(actor + 0x17c, 'I', light['drawScale'])
            self.write(actor + 0x1e3, '2B', light['hue'], light['saturation'])
            self.write(actor + 0x1ec, 'I', light.get('lighting', 4))
            lights.append(actor)
        player = self.alloc(0x400)
        actors = [player] + lights
        array = self.alloc(4 * len(actors) + 4)
        self.write(array, f'{len(actors)}I', *actors)
        self.write(level + 0x2c, 'Ii', array, len(actors))
        self.write(player + 0xac, 'I', level)
        canvas, canvas_vtable = self.alloc(0x40), self.alloc(0x100)
        self.write(canvas, 'I', canvas_vtable)
        self.write(canvas_vtable + 0x60, 'I', self.icon_stub)
        viewport = self.alloc(0x200)
        self.write(viewport + 0x30, 'I', player)
        self.write(viewport + 0x5c, 'I', canvas)
        frame = self.alloc(0x200)
        self.write(frame, 'II', viewport, level)
        self.write(frame + 0x34, '12I', *case['coords'])
        self.write(frame + 0xa8, 'i', case['width'])
        self.write(frame + 0xc8, '2I', *case['fx2fy2'])
        self.write(frame + 0xdc, 'I', case['projZ'])
        return frame, viewport, player, lights

    def run_case(self, case):
        frame, viewport, player, lights = self.world(case)
        cache = self.alloc(32 * 12)
        entries = case.get('entries', [])
        for i, entry in enumerate(entries):
            if entry is not None:
                self.write(cache + 12 * i, 'IiI', lights[entry['light']], entry['index'], entry['brightness'])
        nxt = self.alloc(16)
        self.write(nxt, 'i', 0)
        # The fade loop 0x10b1b682-0x10b1b6b1 (ESI the cache, EDI 0, the
        # float delta at [ebp-0x48]).
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x1000)
        self.write(ebp - 0x48, 'I', case['delta'])
        self.cpu.reg_write(UC_X86_REG_ESI, cache)
        self.cpu.reg_write(lighting.UC_X86_REG_EDI, 0)
        self.run(0x10b1b682, 0x10b1b6b1)
        faded = [list(self.read(cache + 12 * i, 'IiI')) for i in range(32)]
        self.traces = []
        for seen in case.get('seen', []):
            self.answers = [(a[0], player if a[1] == 'viewer' else (lights[0] if a[1] == 'other' else 0)) for a in seen['answers']]
            stack = self.frame() - 0x1000
            self.write(stack, '6I', lighting.RETURN, frame, cache, nxt, lights[seen['light']], case['delta'])
            self.cpu.reg_write(UC_X86_REG_ESP, stack)
            self.cpu.emu_start(HELPER, lighting.RETURN)
        after_seen = [list(self.read(cache + 12 * i, 'IiI')) for i in range(32)]
        self.icons = []
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x1000)
        self.write(ebp + 8, 'I', frame)
        self.write(ebp - 0x1c, 'I', viewport)
        self.write(ebp - 0x54, 'I', cache)
        self.write(ebp - 0xb0, 'I', 0)
        self.cpu.reg_write(UC_X86_REG_ESI, cache)   # the loop reloads ESI from [ebp-0x54] only after an entry
        self.run(LOOP, LOOP_END)
        light_of = {address: i for i, address in enumerate(lights)}
        return {'faded': [[light_of.get(a, -1 if a == 0 else -2), index, bits] for a, index, bits in faded],
                'cache': [[light_of.get(a, -1 if a == 0 else -2), index, bits] for a, index, bits in after_seen],
                'next': self.read(nxt, 'i')[0], 'traces': self.traces,
                'icons': [{**icon, 'texture': icon['texture'] - 0x7000, 'canvas': None} for icon in self.icons]}


if __name__ == '__main__':
    oracle = CoronaOracle(Path(sys.argv[1]))
    oracle.cpu.hook_add(lighting.UC_HOOK_CODE, oracle.hook, begin=STUBS, end=STUBS + 0x100)
    out = []
    for case in json.load(sys.stdin):
        out.append(oracle.run_case(case))
        oracle.alloc_top = oracle.case_top
    json.dump(out, sys.stdout)
