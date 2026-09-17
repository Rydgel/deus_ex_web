"""Unicorn oracle for UGC::DrawTexture (Extension native 1284).

Runs the real chain — exec trampoline 0x1202c520 -> method 0x12028b00 ->
tile-emit gate 0x12028770 -> draw sink 0x1202a820 -> clip helper 0x1202a4f0
-> canvas vtable slot +0x5c — against a constructed GC object and records
the emitted DrawTile command stream.

DrawTexture forwards (DestX, DestY, destWidth, destHeight, srcX, srcY) plus
srcW=destWidth, srcH=destHeight and the texture pointer to the gate, so the
zero-source-size flags never fire through this native (they stay in the
shared model for the other draws).

Case spec fields are raw GC bit patterns; {'f': v} writes an f32.  Every
case needs the drawing bit (flags bit1) plus explicit hMultiplier /
vMultiplier ints — the fill byte otherwise leaves garbage multipliers.
Cases marked 'canvas' get the fake canvas whose +0x4c f32 is forwarded as
the DrawTile Z arg.
"""
import json
import sys
from pathlib import Path
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'gc_draw_probe', Path(__file__).with_name('native-gc-draw-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)


def F(v):
    return {'f': v}


# Baseline GC drawing state: clipping to a 640x480 screen, drawing enabled,
# unit multipliers, a recognizable tile color and polyflags.
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
    'on-screen': case(args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'on-screen-method': case(args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64],
                             mode='method'),

    # --- partial clip, one edge at a time -----------------------------------
    'clip-left':   case(args=[F(-8), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'clip-right':  case(args=[F(620), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'clip-top':    case(args=[F(10), F(-4), F(32), F(16), F(0), F(0), TEX64]),
    'clip-bottom': case(args=[F(10), F(470), F(32), F(16), F(0), F(0), TEX64]),

    # --- fully clipped out: no command --------------------------------------
    'clip-out-left':   case(args=[F(-100), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'clip-out-right':  case(args=[F(700), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'clip-out-top':    case(args=[F(10), F(-100), F(32), F(16), F(0), F(0), TEX64]),
    'clip-out-bottom': case(args=[F(10), F(500), F(32), F(16), F(0), F(0), TEX64]),

    # --- invalid sizes --------------------------------------------------------
    'zero-width':  case(args=[F(10), F(20), F(0), F(16), F(0), F(0), TEX64]),
    'zero-height': case(args=[F(10), F(20), F(32), F(0), F(0), F(0), TEX64]),
    'neg-width':   case(args=[F(10), F(20), F(-8), F(16), F(0), F(0), TEX64]),
    'neg-height':  case(args=[F(10), F(20), F(32), F(-8), F(0), F(0), TEX64]),

    # --- origin / clip-rect offsets ------------------------------------------
    'origin-shift': case(spec={'originX': F(5), 'originY': F(7)},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'origin-shift-clip': case(spec={'originX': F(5), 'originY': F(7)},
                              args=[F(-10), F(-10), F(32), F(16), F(0), F(0), TEX64]),
    'clip-rect-offset': case(spec={'clipX': F(100), 'clipY': F(50),
                                  'clipWidth': F(200), 'clipHeight': F(100)},
                             args=[F(90), F(40), F(64), F(90), F(0), F(0), TEX64]),

    # --- integer scale multipliers (GC+0x9c/+0xa0) ----------------------------
    'scale-mult-2x3': case(spec={'hMultiplier': 2, 'vMultiplier': 3},
                           args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'scale-mult-clip': case(spec={'hMultiplier': 2, 'vMultiplier': 2},
                            args=[F(-4), F(20), F(32), F(16), F(0), F(0), TEX64]),

    # --- tile color + polyflags forwarding ------------------------------------
    'tile-color': case(spec={'tileFloats': [F(0.125), F(0.5), F(0.875), F(1.0)],
                            'polyFlags': 0x902},
                       args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),

    # --- texture identity + source-rect offsets --------------------------------
    'src-offset': case(args=[F(10), F(20), F(32), F(16), F(8), F(4), TEX64]),
    'texture-128': case(args=[F(10), F(20), F(32), F(16), F(0), F(0),
                              {'$texture': {'u': 128, 'v': 32}}]),

    # --- source-rect clamps against the texture edges ---------------------------
    'src-left-clamp':   case(args=[F(10), F(20), F(32), F(16), F(-8), F(0), TEX64]),
    'src-right-clamp':  case(args=[F(10), F(20), F(32), F(16), F(48), F(0), TEX64]),
    'src-top-clamp':    case(args=[F(10), F(20), F(32), F(16), F(0), F(-4), TEX64]),
    'src-bottom-clamp': case(args=[F(10), F(20), F(32), F(16), F(0), F(60), TEX64]),

    # --- gates -------------------------------------------------------------------
    'drawing-off':  case(spec={'flags': 0},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),
    'null-texture': case(args=[F(10), F(20), F(32), F(16), F(0), F(0), 0]),
    'no-canvas':    case(spec={'canvas': 0},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0), TEX64]),

    # --- fractional coords: _ftol(v + 0.1) truncation --------------------------
    'frac-round': case(args=[F(10.4), F(20.6), F(31.5), F(16.5),
                             F(0), F(0), TEX64]),
    'frac-edge':  case(args=[F(10.95), F(20.89), F(32.1), F(15.9),
                             F(0), F(0), TEX64]),
}


if __name__ == '__main__':
    _PROBE.oracle_main('drawTexture', CASES,
                       sys.argv[1] if len(sys.argv) > 1 else None)
