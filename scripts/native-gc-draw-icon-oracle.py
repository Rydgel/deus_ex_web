"""Unicorn oracle for UGC::DrawIcon (Extension native 1283).

Runs the real chain — exec trampoline 0x1202c460 -> method 0x120289c0 ->
icon leaf 0x12028850 -> draw sink 0x1202a820 -> clip helper 0x1202a4f0 ->
canvas vtable slot +0x5c — against a constructed GC object and records the
emitted DrawTile command stream.

DrawIcon emits sink(tX, DestX, DestY, f32(USize), f32(VSize), 0, 0,
f32(USize), f32(VSize), flagW=0, flagH=0): a single proportional-mode tile
whose dest size and source rect are both the texture dimensions.  The
flagW/flagH zeros mean the clip helper always takes the proportional path —
no pixel-tracking source adjustments for this native.
"""
import sys
from pathlib import Path
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'gc_draw_probe', Path(__file__).with_name('native-gc-draw-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)


def F(v):
    return {'f': v}


BASE_SPEC = {
    'vtable': 0x120598dc,
    'canvas': {'$canvas': {'z': F(0.5)}},
    'originX': F(0), 'originY': F(0),
    'clipX': F(0), 'clipY': F(0), 'clipWidth': F(640), 'clipHeight': F(480),
    'flags': 0x2,
    'polyFlags': 0x100,
    'tileColor': 0xff804020,
    'tileFloats': [F(1.0), F(0.5), F(0.25), F(0.0)],
    'hMultiplier': 1, 'vMultiplier': 1,
}

TEX64 = {'$texture': {'u': 64, 'v': 64}}


def case(spec=None, args=None, mode='exec', **extra):
    s = dict(BASE_SPEC)
    s.update(spec or {})
    return {'spec': s, 'args': args or [], 'mode': mode, **extra}


CASES = {
    # --- baseline: fully on-screen -----------------------------------------
    'on-screen': case(args=[F(10), F(20), TEX64]),
    'on-screen-method': case(args=[F(10), F(20), TEX64], mode='method'),
    'non-square': case(args=[F(10), F(20), {'$texture': {'u': 128, 'v': 32}}]),

    # --- partial clip, one edge at a time -----------------------------------
    'clip-left':   case(args=[F(-8), F(20), TEX64]),
    'clip-right':  case(args=[F(620), F(20), TEX64]),
    'clip-top':    case(args=[F(10), F(-4), TEX64]),
    'clip-bottom': case(args=[F(10), F(470), TEX64]),

    # --- fully clipped out: no command --------------------------------------
    'clip-out-left':   case(args=[F(-100), F(20), TEX64]),
    'clip-out-right':  case(args=[F(700), F(20), TEX64]),
    'clip-out-top':    case(args=[F(10), F(-100), TEX64]),
    'clip-out-bottom': case(args=[F(10), F(500), TEX64]),

    # --- degenerate texture dims ---------------------------------------------
    'zero-width':  case(args=[F(10), F(20), {'$texture': {'u': 0, 'v': 64}}]),
    'zero-height': case(args=[F(10), F(20), {'$texture': {'u': 64, 'v': 0}}]),
    'neg-width':   case(args=[F(10), F(20), {'$texture': {'u': -8, 'v': 64}}]),
    'neg-height':  case(args=[F(10), F(20), {'$texture': {'u': 64, 'v': -8}}]),

    # --- origin / clip-rect offsets ------------------------------------------
    'origin-shift': case(spec={'originX': F(5), 'originY': F(7)},
                         args=[F(10), F(20), TEX64]),
    'origin-shift-clip': case(spec={'originX': F(5), 'originY': F(7)},
                              args=[F(-10), F(-10), TEX64]),
    'clip-rect-offset': case(spec={'clipX': F(100), 'clipY': F(50),
                                  'clipWidth': F(200), 'clipHeight': F(100)},
                             args=[F(90), F(40), TEX64]),

    # --- integer scale multipliers --------------------------------------------
    'scale-mult-2x3': case(spec={'hMultiplier': 2, 'vMultiplier': 3},
                           args=[F(10), F(20), TEX64]),
    'scale-mult-clip': case(spec={'hMultiplier': 2, 'vMultiplier': 2},
                            args=[F(-4), F(20), TEX64]),

    # --- tile color + polyflags forwarding ------------------------------------
    'tile-color': case(spec={'tileFloats': [F(0.125), F(0.5), F(0.875), F(1.0)],
                            'polyFlags': 0x902},
                       args=[F(10), F(20), TEX64]),

    # --- gates -------------------------------------------------------------------
    'drawing-off':  case(spec={'flags': 0},
                         args=[F(10), F(20), TEX64]),
    'null-texture': case(args=[F(10), F(20), 0]),
    'no-canvas':    case(spec={'canvas': 0},
                         args=[F(10), F(20), TEX64]),

    # --- fractional coords -------------------------------------------------------
    'frac-round': case(args=[F(10.4), F(20.6), TEX64]),
    'frac-edge':  case(args=[F(10.95), F(20.89), TEX64]),
}


if __name__ == '__main__':
    _PROBE.oracle_main('drawIcon', CASES,
                       sys.argv[1] if len(sys.argv) > 1 else None)
