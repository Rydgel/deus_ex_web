"""Unicorn oracle for Extension GC.DrawActor (native 1288) and GC.ClearZ (1295).

Runs the real exec trampolines (0x1002cd80, 0x1002cee0) and the real method
bodies (XGC::DrawActor 0x1002aa60, XGC::ClearZ 0x1002ae40) at the render
pass's x87 control word 0x007f with the shipped MSVCRT (`_ftol`, reached
through IAT thunk 0x1005480a).  The three leaves the bodies call are
recording stubs that snapshot what they see at the call:

  - RenDev->ClearZ(Frame)                     canvas->Viewport(+0x78)->RenDev(+0x64), vtable +0x90
  - URenderBase::DrawActor(Frame, Actor)      canvas->Render(+0x80), vtable +0x74
  - FSceneNode::ComputeRenderSize()           Engine import, IAT slot 0x10059324

Object images (all filled with a per-case byte so a stray write shows):
GC (0x100, the base probe's), canvas (+0x78 viewport, +0x7c frame, +0x80
render), viewport (+0x64 rendev), frame (X +0xa8, Y +0xac, XB +0xb0, YB
+0xb4), actor (flags +0x28, Style +0x165, Skin +0x170, DrawScale +0x17c,
ScaleGlow +0x18c, bitfield word +0x194, MultiSkins +0x1a4).

Case spec: {'spec': GC fields (+ 'canvas': {'$actorCanvas': {'frame': {...},
'fill': n}}), 'actor': {image fields} | None, 'args': {...}, 'mode':
'exec' | 'method'}.  Float fields are {'f': v} (f32 bits) or {'bits': n}.
`args` omit a key to leave the exec default (omitted optional argument); the
method mode passes the raw dwords.
"""
import importlib.util
import json
from pathlib import Path
import random
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'gc_draw_probe', Path(__file__).with_name('native-gc-draw-probe.py'))
_P = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_P)

from unicorn.x86_const import UC_X86_REG_ESP  # noqa: E402

EXT = _P.EXT
IMAGE_BASE = _P.IMAGE_BASE

DRAW_ACTOR = {'exec': EXT + 0x2cd80, 'method': EXT + 0x2aa60}
CLEAR_Z = {'exec': EXT + 0x2cee0, 'method': EXT + 0x2ae40}
COMPUTE_RENDER_SIZE_IAT = EXT + 0x59324

CANVAS_VIEWPORT, CANVAS_FRAME, CANVAS_RENDER = 0x78, 0x7c, 0x80
VIEWPORT_RENDEV = 0x64
RENDEV_CLEARZ_SLOT = 0x90
RENDER_DRAWACTOR_SLOT = 0x74
FRAME_X, FRAME_Y, FRAME_XB, FRAME_YB = 0xa8, 0xac, 0xb0, 0xb4
FRAME_SIZE = 0x300
ACTOR_SIZE = 0x200
A_FLAGS, A_STYLE, A_SKIN, A_DRAWSCALE, A_SCALEGLOW, A_WORD194, A_MULTISKINS, A_LASTRENDER = \
    0x28, 0x165, 0x170, 0x17c, 0x18c, 0x194, 0x1a4, 0x34

f32bits = _P.f32bits


def F(v):
    return {'f': v}


class ActorProbe(_P.GcDrawProbe):
    def __init__(self, root):
        super().__init__(root)
        self.clearz_stub = self.alloc(16)
        self.cpu.mem_write(self.clearz_stub, b'\xc2\x04\x00')      # thiscall, 1 arg
        self.drawactor_stub = self.alloc(16)
        self.cpu.mem_write(self.drawactor_stub, b'\xc2\x08\x00')   # thiscall, 2 args
        self.crs_stub = self.alloc(16)
        self.cpu.mem_write(self.crs_stub, b'\xc3')                 # thiscall, no args
        self.write(COMPUTE_RENDER_SIZE_IAT, 'I', self.crs_stub)
        self.names = {}
        self.actor_addr = 0
        self.frame_addr = 0
        self.actor_tex = {}

    # ----- hooks ---------------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.clearz_stub:
            return self.on_clear_z(cpu)
        if address == self.drawactor_stub:
            return self.on_draw_actor(cpu)
        if address == self.crs_stub:
            return self.on_compute_render_size(cpu)
        return super().on_instruction(cpu, address, size, data)

    def on_gnative(self, cpu):
        """Param eval: a plain dword, or None for an omitted optional
        argument (EX_Nothing writes nothing, the exec's default stays)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result_ptr = self.read(stack + 4, '2I')
        if not self.exec_params:
            raise RuntimeError('GNatives eval with no configured param')
        spec = self.exec_params.pop(0)
        if spec is not None:
            self.write(result_ptr, 'I', spec & 0xffffffff)
        self._cdecl_return(cpu, stack, 8)

    def frame_state(self):
        f = self.frame_addr
        return {'x': self.read(f + FRAME_X, 'i')[0], 'y': self.read(f + FRAME_Y, 'i')[0],
                'xb': self.read(f + FRAME_XB, 'i')[0], 'yb': self.read(f + FRAME_YB, 'i')[0]}

    def actor_state(self, actor):
        flags = self.read(actor + A_FLAGS, 'I')[0]
        word = self.read(actor + A_WORD194, 'I')[0]
        skins = [self.canon(self.read(actor + A_MULTISKINS + 4 * i, 'I')[0]) for i in range(8)]
        skins.append(self.canon(self.read(actor + A_SKIN, 'I')[0]))
        return {'hidden': (flags >> 1) & 1, 'unlit': word & 1, 'style': self.read(actor + A_STYLE, 'B')[0],
                'drawScale': self.read(actor + A_DRAWSCALE, 'I')[0],
                'scaleGlow': self.read(actor + A_SCALEGLOW, 'I')[0], 'skins': skins}

    def on_clear_z(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        frame = self.read(stack + 4, 'I')[0]
        self.events.append({'op': 'ClearZ', 'renDev': self.canon(cpu.reg_read(_P.UC_X86_REG_ECX)),
                            'frame': self.canon(frame), 'frameState': self.frame_state()})

    def on_draw_actor(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        frame, actor = self.read(stack + 4, '2I')
        self.events.append({'op': 'DrawActor', 'render': self.canon(cpu.reg_read(_P.UC_X86_REG_ECX)),
                            'frame': self.canon(frame), 'actor': self.canon(actor),
                            'actorState': self.actor_state(actor), 'frameState': self.frame_state()})

    def on_compute_render_size(self, cpu):
        self.events.append({'op': 'ComputeRenderSize', 'frame': self.canon(cpu.reg_read(_P.UC_X86_REG_ECX)),
                            'frameState': self.frame_state()})

    # ----- labels ----------------------------------------------------------
    def canon(self, ptr):
        if not ptr:
            return 0
        if ptr in self.names:
            return self.names[ptr]
        return super().canon(ptr)

    def texture(self, k):
        if k not in self.actor_tex:
            addr = self.alloc(0x40)
            self.cpu.mem_write(addr, b'\0' * 0x40)
            self.actor_tex[k] = addr
            self.names[addr] = 'tex%d' % k
        return self.actor_tex[k]

    # ----- images ----------------------------------------------------------
    def build_canvas(self, spec=None):
        """canvas -> viewport -> rendev (ClearZ stub in its vtable) and
        render (DrawActor stub in its vtable); the scene frame."""
        spec = spec or {}
        fill = spec.get('fill', 0x3c) & 0xff
        canvas = self.alloc(0x100)
        self.cpu.mem_write(canvas, bytes([fill]) * 0x100)
        viewport = self.alloc(0xc0)
        self.cpu.mem_write(viewport, b'\0' * 0xc0)
        rendev = self.alloc(0x40)
        rendev_vt = self.alloc(0x100)
        self.cpu.mem_write(rendev_vt, b'\0' * 0x100)
        self.write(rendev_vt + RENDEV_CLEARZ_SLOT, 'I', self.clearz_stub)
        self.cpu.mem_write(rendev, b'\0' * 0x40)
        self.write(rendev, 'I', rendev_vt)
        self.write(viewport + VIEWPORT_RENDEV, 'I', rendev)
        render = self.alloc(0x40)
        render_vt = self.alloc(0x100)
        self.cpu.mem_write(render_vt, b'\0' * 0x100)
        self.write(render_vt + RENDER_DRAWACTOR_SLOT, 'I', self.drawactor_stub)
        self.cpu.mem_write(render, b'\0' * 0x40)
        self.write(render, 'I', render_vt)
        frame = self.alloc(FRAME_SIZE)
        self.cpu.mem_write(frame, bytes([0x5a]) * FRAME_SIZE)
        fs = spec.get('frame', {})
        self.write(frame, 'I', 0)
        self.write(frame + FRAME_X, 'i', fs.get('x', 640))
        self.write(frame + FRAME_Y, 'i', fs.get('y', 480))
        self.write(frame + FRAME_XB, 'i', fs.get('xb', 0))
        self.write(frame + FRAME_YB, 'i', fs.get('yb', 0))
        self.write(canvas + CANVAS_VIEWPORT, 'I', viewport)
        self.write(canvas + CANVAS_FRAME, 'I', frame)
        self.write(canvas + CANVAS_RENDER, 'I', render)
        self.canvas_addr = canvas
        self.frame_addr = frame
        self.names.update({canvas: 'canvas', viewport: 'viewport', rendev: 'rendev', render: 'render', frame: 'frame'})
        return canvas

    def build_actor(self, spec):
        actor = self.alloc(ACTOR_SIZE)
        fill = spec.get('fill', 0x77) & 0xff
        self.cpu.mem_write(actor, bytes([fill]) * ACTOR_SIZE)
        self.write(actor + A_FLAGS, 'I', spec.get('flags', 0) & 0xffffffff)
        self.write(actor + A_WORD194, 'I', spec.get('word194', 0) & 0xffffffff)
        self.write(actor + A_STYLE, 'B', spec.get('style', 1))
        self.write(actor + A_DRAWSCALE, 'I', _bits(spec.get('drawScale', F(1.0))))
        self.write(actor + A_SCALEGLOW, 'I', _bits(spec.get('scaleGlow', F(1.0))))
        self.write(actor + A_LASTRENDER, 'I', _bits(spec.get('lastRenderTime', F(0.0))))
        skins = spec.get('multiSkins', [0] * 8)
        for i in range(8):
            self.write(actor + A_MULTISKINS + 4 * i, 'I', self.texture(skins[i]) if skins[i] else 0)
        skin = spec.get('skin', 0)
        self.write(actor + A_SKIN, 'I', self.texture(skin) if skin else 0)
        self.names[actor] = 'actor'
        self.actor_addr = actor
        return actor

    def dump(self, this):
        actor = bytearray(self.cpu.mem_read(self.actor_addr, ACTOR_SIZE)) if self.actor_addr else b''
        if actor:
            for off in [A_SKIN] + [A_MULTISKINS + 4 * i for i in range(8)]:
                actor[off:off + 4] = b'\0' * 4
        gc = bytearray(self.cpu.mem_read(this + 0x28, 0x90))
        gc[0:4] = b'\0' * 4                                         # the canvas pointer
        frame = self.cpu.mem_read(self.frame_addr, FRAME_SIZE) if self.frame_addr else b''
        return {'actor': actor.hex(), 'actorSkins': self.actor_state(self.actor_addr)['skins'] if self.actor_addr else [],
                'gc': gc.hex(), 'frame': bytes(frame).hex()}

    # ----- runs --------------------------------------------------------------
    def run_case(self, native, case):
        self.events = []
        self.seen_ids = {}
        self.tex_ids = {}
        self.names = {}
        self.actor_tex = {}
        self.actor_addr = 0
        self.frame_addr = 0
        self.canvas_addr = 0
        spec = {k: (v['bits'] & 0xffffffff if isinstance(v, dict) and 'bits' in v else v) for k, v in case['spec'].items()}
        canvas_spec = spec.get('canvas')
        if isinstance(canvas_spec, dict) and '$actorCanvas' in canvas_spec:
            spec['canvas'] = 0
            this = self.gc_object(spec)
            self.write(this + 0x28, 'I', self.build_canvas(canvas_spec['$actorCanvas']))
        else:
            this = self.gc_object(spec)
        self.names[this] = 'this'
        actor = self.build_actor(case['actor']) if case.get('actor') is not None else 0
        args = case.get('args', {})
        mode = case.get('mode', 'exec')
        if native == 'drawActor':
            skin = args.get('skin')
            skin_ptr = self.texture(skin) if skin else 0
            values = [actor, args.get('bClearZ'), args.get('bConstrain'), args.get('bUnlit'),
                      _bits(args['drawScale']) if 'drawScale' in args else None,
                      _bits(args['scaleGlow']) if 'scaleGlow' in args else None,
                      skin_ptr if 'skin' in args else None]
            if mode == 'method':
                defaults = [actor, 0, 0, 0, 0x3f800000, 0x3f800000, 0]
                words = [d if v is None else v for v, d in zip(values, defaults)]
                self.call(DRAW_ACTOR['method'], this, struct.pack('<7I', *[w & 0xffffffff for w in words]))
            else:
                frame = self.alloc(0x20)
                self.cpu.mem_write(frame, b'\0' * 0x20)
                code = self.alloc(0x40)
                self.cpu.mem_write(code, b'\x1c' * 0x40)
                self.write(frame + 8, 'I', this)
                self.write(frame + 0xc, 'I', code)
                self.exec_params = list(values)
                out = self.alloc(4)
                self.write(out, 'I', 0xdeadbeef)
                self.call(DRAW_ACTOR['exec'], this, struct.pack('<II', frame, out))
                code_after = self.read(frame + 0xc, 'I')[0]
                self.events.append({'op': 'ExecEnd', 'codeAdvance': code_after - code})
        else:
            if mode == 'method':
                self.call(CLEAR_Z['method'], this, b'')
            else:
                frame = self.alloc(0x20)
                self.cpu.mem_write(frame, b'\0' * 0x20)
                code = self.alloc(0x40)
                self.cpu.mem_write(code, b'\x1c' * 0x40)
                self.write(frame + 8, 'I', this)
                self.write(frame + 0xc, 'I', code)
                self.exec_params = []
                out = self.alloc(4)
                self.call(CLEAR_Z['exec'], this, struct.pack('<II', frame, out))
                code_after = self.read(frame + 0xc, 'I')[0]
                self.events.append({'op': 'ExecEnd', 'codeAdvance': code_after - code})
        return {'events': self.events, 'state': self.dump(this)}


def _bits(v):
    if isinstance(v, dict):
        if 'bits' in v:
            return v['bits'] & 0xffffffff
        return f32bits(v['f'])
    return v & 0xffffffff


BASE_GC = {
    'vtable': 0x120598dc,
    'originX': F(0), 'originY': F(0),
    'clipX': F(0), 'clipY': F(0), 'clipWidth': F(640), 'clipHeight': F(480),
    'style': 3,
    'flags': 0x2 | 0x8,
    'polyFlags': 0x104,
    'hMultiplier': 1, 'vMultiplier': 1,
}


def case(gc=None, actor=None, args=None, frame=None, mode='exec', no_actor=False, canvas=True):
    spec = dict(BASE_GC)
    spec.update(gc or {})
    if canvas:
        spec['canvas'] = {'$actorCanvas': {'frame': frame or {'x': 640, 'y': 480, 'xb': 0, 'yb': 0}}}
    else:
        spec['canvas'] = 0
    base_actor = {'flags': 0x1002, 'word194': 0x10, 'style': 1, 'drawScale': F(1.5), 'scaleGlow': F(0.75),
                  'multiSkins': [1, 2, 0, 3, 0, 0, 4, 0], 'skin': 5, 'lastRenderTime': F(12.5)}
    if actor:
        base_actor.update(actor)
    return {'spec': spec, 'actor': None if no_actor else base_actor, 'args': args or {}, 'mode': mode}


# The vision augmentation's call: DrawActor(A, false, false, true, 1.0, 2.0, None).
VISION = {'bClearZ': 0, 'bConstrain': 0, 'bUnlit': 1, 'drawScale': F(1.0), 'scaleGlow': F(2.0), 'skin': 0}


def fixed_cases():
    c = {}
    c['vision-call'] = case(args=VISION)
    c['vision-call-method'] = case(args=VISION, mode='method')
    c['defaults-exec'] = case(args={})                      # every optional argument omitted
    c['defaults-method'] = case(args={}, mode='method')
    c['actor-display'] = case(args={'bUnlit': 1, 'drawScale': F(1.0), 'scaleGlow': F(1.0), 'skin': 0, 'bClearZ': 0,
                                    'bConstrain': 0})
    c['clear-z'] = case(args={'bClearZ': 1, 'bUnlit': 1, 'scaleGlow': F(2.0)})
    c['clear-z-dword'] = case(args={'bClearZ': 0x100, 'bUnlit': 0})
    c['unlit-bit-only'] = case(args={'bUnlit': 2}, actor={'word194': 0x11})
    c['unlit-clear'] = case(args={'bUnlit': 0}, actor={'word194': 0xffffffff})
    c['skin'] = case(args={'skin': 7, 'bUnlit': 1})
    c['skin-over-empty'] = case(args={'skin': 7}, actor={'multiSkins': [0] * 8, 'skin': 0})
    c['hidden-actor'] = case(args={'bUnlit': 1}, actor={'flags': 0xffffffff})
    c['visible-actor'] = case(args={'bUnlit': 1}, actor={'flags': 0xfffffffd})
    c['style-from-gc'] = case(gc={'style': 4}, args={'bUnlit': 1})
    c['drawscale-product'] = case(args={'drawScale': F(0.3), 'scaleGlow': F(1.7)}, actor={'drawScale': F(1.1)})
    c['drawscale-nan'] = case(args={'drawScale': {'bits': 0x7fc00000}}, actor={'drawScale': F(2.0)})
    c['scaleglow-raw-nan'] = case(args={'scaleGlow': {'bits': 0x7f800001}})
    # --- gates ---------------------------------------------------------------
    c['drawing-off'] = case(gc={'flags': 0x8}, args=VISION)
    c['drawing-off-method'] = case(gc={'flags': 0x8}, args=VISION, mode='method')
    c['no-canvas'] = case(args=VISION, canvas=False)
    c['no-canvas-method'] = case(args=VISION, canvas=False, mode='method')
    c['null-actor'] = case(args=VISION, no_actor=True)
    c['null-actor-method'] = case(args=VISION, no_actor=True, mode='method')
    # --- bConstrain: the clip box ------------------------------------------------
    k = {'bConstrain': 1, 'bUnlit': 1}
    c['constrain-full'] = case(args=k)
    c['constrain-box'] = case(gc={'originX': F(100), 'originY': F(50), 'clipX': F(10), 'clipY': F(20), 'clipWidth': F(200),
                                  'clipHeight': F(100)}, args=k)
    c['constrain-mult'] = case(gc={'hMultiplier': 2, 'vMultiplier': 3, 'originX': F(30.5), 'originY': F(10.25), 'clipX': F(1.5),
                                   'clipY': F(2.5), 'clipWidth': F(100.75), 'clipHeight': F(50.5)}, args=k)
    c['constrain-offset-frame'] = case(gc={'originX': F(40), 'originY': F(30), 'clipX': F(0), 'clipY': F(0), 'clipWidth': F(100),
                                           'clipHeight': F(100)}, args=k, frame={'x': 300, 'y': 200, 'xb': 20, 'yb': 10})
    c['constrain-left-of-frame'] = case(gc={'originX': F(-50), 'originY': F(-30), 'clipWidth': F(100), 'clipHeight': F(100)},
                                        args=k, frame={'x': 300, 'y': 200, 'xb': 20, 'yb': 10})
    c['constrain-wider-than-frame'] = case(gc={'clipWidth': F(1000), 'clipHeight': F(900)}, args=k,
                                           frame={'x': 300, 'y': 200, 'xb': 0, 'yb': 0})
    c['constrain-empty'] = case(gc={'clipWidth': F(0), 'clipHeight': F(0)}, args=k)
    c['constrain-negative'] = case(gc={'clipWidth': F(-40), 'clipHeight': F(-30)}, args=k)
    c['constrain-fractions'] = case(gc={'originX': F(10.9), 'originY': F(20.9), 'clipWidth': F(33.99), 'clipHeight': F(44.99)}, args=k)
    c['constrain-big-ints'] = case(args=k, frame={'x': 20000001, 'y': 16777217, 'xb': 16777219, 'yb': -16777221})
    c['constrain-nan-clip'] = case(gc={'clipX': {'bits': 0x7fc00000}, 'clipY': {'bits': 0x7fc00000}}, args=k)
    c['constrain-nan-width'] = case(gc={'clipWidth': {'bits': 0x7fc00000}, 'clipHeight': {'bits': 0x7fc00000}}, args=k)
    c['constrain-inf'] = case(gc={'clipWidth': {'bits': 0x7f800000}, 'clipHeight': {'bits': 0xff800000}}, args=k)
    c['constrain-huge'] = case(gc={'originX': F(3.0e38), 'clipWidth': F(3.0e38), 'originY': F(-3.0e38), 'clipHeight': F(3.0e38)}, args=k)
    # _ftol's 64-bit range: the clip left becomes XB - XB offsets of 2^63 and beyond (integer indefinite, low dword 0)
    for name, value in (('under-2pow63', 9.0e18), ('over-2pow63', 9.3e18), ('1e20', 1.0e20), ('neg-1e20', -1.0e20),
                        ('2pow53', 9007199254740993.0), ('3e9', 3.0e9), ('neg-3e9', -3.0e9)):
        c['constrain-ftol-' + name] = case(gc={'originX': F(value), 'originY': F(value), 'clipWidth': F(10), 'clipHeight': F(10)}, args=k,
                                           frame={'x': 100, 'y': 100, 'xb': 0, 'yb': 0})
    c['constrain-clearz-skin'] =case(gc={'originX': F(8), 'clipWidth': F(64), 'clipHeight': F(64)},
                                      args={'bConstrain': 1, 'bClearZ': 1, 'skin': 9, 'bUnlit': 1, 'scaleGlow': F(2.0)})
    c['constrain-method'] = case(gc={'originX': F(100), 'clipWidth': F(200), 'clipHeight': F(100)}, args=k, mode='method')
    c['constrain-dword'] = case(gc={'clipWidth': F(10), 'clipHeight': F(10)}, args={'bConstrain': 0x40000000})
    return c


def clearz_cases():
    c = {}
    c['clearz-exec'] = case()
    c['clearz-method'] = case(mode='method')
    c['clearz-no-canvas'] = case(canvas=False)
    c['clearz-no-canvas-method'] = case(canvas=False, mode='method')
    c['clearz-drawing-off'] = case(gc={'flags': 0})        # no drawing gate: still clears
    return c


def random_cases(count=160, seed=1288):
    rng = random.Random(seed)

    def flt():
        kind = rng.randrange(10)
        if kind == 0:
            return {'bits': rng.choice([0x7fc00000, 0x7f800000, 0xff800000, 0x80000000, 0x00000001])}
        if kind == 1:
            return F(rng.uniform(-3e38, 3e38))
        if kind == 2:
            return F(rng.randrange(-2000, 2000))
        if kind == 3:
            return F(rng.uniform(-10, 10))
        return F(round(rng.uniform(-300, 900), rng.choice([0, 1, 2, 5])))

    c = {}
    for i in range(count):
        gc = {'originX': flt(), 'originY': flt(), 'clipX': flt(), 'clipY': flt(), 'clipWidth': flt(), 'clipHeight': flt(),
              'hMultiplier': rng.choice([1, 1, 2, 3, 4, 0, -1, 1000, 16777217]), 'vMultiplier': rng.choice([1, 1, 2, 3, 4, 0, -2]),
              'style': rng.randrange(5)}
        frame = {k: rng.choice([0, 1, 7, 100, 640, 480, 1023, -5, 16777217, 20000000, 2147483647, -2147483648, rng.randrange(-5000, 5000)])
                 for k in ('x', 'y', 'xb', 'yb')}
        args = {'bConstrain': 1, 'bClearZ': rng.randrange(2), 'bUnlit': rng.randrange(2),
                'drawScale': flt() if rng.random() < .5 else F(1.0), 'scaleGlow': flt() if rng.random() < .5 else F(2.0),
                'skin': rng.choice([0, 0, 3, 8])}
        actor = {'drawScale': flt(), 'scaleGlow': flt(), 'style': rng.randrange(256), 'flags': rng.getrandbits(32),
                 'word194': rng.getrandbits(32)}
        c['fuzz-%03d' % i] = case(gc=gc, actor=actor, args=args, frame=frame, mode=rng.choice(['exec', 'method']))
    return c


def main():
    root = Path(sys.argv[1])
    probe = ActorProbe(root)
    results = {}
    for name, cs in fixed_cases().items():
        results[name] = {**cs, **probe.run_case('drawActor', cs)}
    for name, cs in clearz_cases().items():
        results[name] = {**cs, **probe.run_case('clearZ', cs), 'native': 'clearZ'}
    for name, cs in random_cases().items():
        results[name] = {**cs, **probe.run_case('drawActor', cs)}
    print(json.dumps({
        'hashes': {'Extension.dll': _P.EXTENSION_HASH, 'Core.dll': _P._NATIVE.HASHES['Core.dll'],
                    'Engine.dll': _P._NATIVE.HASHES['Engine.dll'], 'MSVCRT.dll': _P.MSVCRT_HASH},
        'extensionBase': EXT,
        'drawActorExec': (DRAW_ACTOR['exec'] - EXT) + IMAGE_BASE,
        'drawActorMethod': (DRAW_ACTOR['method'] - EXT) + IMAGE_BASE,
        'clearZExec': (CLEAR_Z['exec'] - EXT) + IMAGE_BASE,
        'clearZMethod': (CLEAR_Z['method'] - EXT) + IMAGE_BASE,
        'cases': results,
    }))


if __name__ == '__main__':
    main()
