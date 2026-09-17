"""Unicorn oracle for UGC::DrawStretchedTexture (Extension native 1287).

Runs the real exec trampoline 0x1202cbc0 — which gates on tX!=0 and the
GC+0x48 drawing bit, then calls the draw sink 0x1202a820 directly (no
method body) with flagW/flagH literal zeros — and records the emitted
DrawTile command stream.

Emission: sink(tX, DestX, DestY, destW, destH, srcX, srcY, srcW, srcH, 0, 0)
— a single proportional-clip tile with an arbitrary source rect.
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
    'on-screen': case(args=[F(10), F(20), F(32), F(16), F(0), F(0),
                            F(64), F(64), TEX64]),

    # --- partial clip, one edge at a time -----------------------------------
    'clip-left':   case(args=[F(-8), F(20), F(32), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),
    'clip-right':  case(args=[F(620), F(20), F(32), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),
    'clip-top':    case(args=[F(10), F(-4), F(32), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),
    'clip-bottom': case(args=[F(10), F(470), F(32), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),

    # --- fully clipped out ----------------------------------------------------
    'clip-out-left':   case(args=[F(-100), F(20), F(32), F(16), F(0), F(0),
                                  F(64), F(64), TEX64]),
    'clip-out-right':  case(args=[F(700), F(20), F(32), F(16), F(0), F(0),
                                  F(64), F(64), TEX64]),
    'clip-out-top':    case(args=[F(10), F(-100), F(32), F(16), F(0), F(0),
                                  F(64), F(64), TEX64]),
    'clip-out-bottom': case(args=[F(10), F(500), F(32), F(16), F(0), F(0),
                                  F(64), F(64), TEX64]),

    # --- invalid dest dims ------------------------------------------------------
    'zero-width':  case(args=[F(10), F(20), F(0), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),
    'zero-height': case(args=[F(10), F(20), F(32), F(0), F(0), F(0),
                              F(64), F(64), TEX64]),
    'neg-width':   case(args=[F(10), F(20), F(-8), F(16), F(0), F(0),
                              F(64), F(64), TEX64]),
    'neg-height':  case(args=[F(10), F(20), F(32), F(-8), F(0), F(0),
                              F(64), F(64), TEX64]),

    # --- zero source dims: gate's (srcSize==0) flags only fire for gate -------
    # calls; this native calls the sink directly with literal 0 flags, so a
    # zero source extent is still proportional mode (UL<=0 post-check kills it).
    'zero-src-w': case(args=[F(10), F(20), F(32), F(16), F(0), F(0),
                             F(0), F(64), TEX64]),
    'zero-src-h': case(args=[F(10), F(20), F(32), F(16), F(0), F(0),
                             F(64), F(0), TEX64]),

    # --- origin / clip-rect offsets ------------------------------------------
    'origin-shift': case(spec={'originX': F(5), 'originY': F(7)},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0),
                               F(64), F(64), TEX64]),
    'clip-rect-offset': case(spec={'clipX': F(100), 'clipY': F(50),
                                  'clipWidth': F(200), 'clipHeight': F(100)},
                             args=[F(90), F(40), F(64), F(90), F(0), F(0),
                                   F(64), F(64), TEX64]),

    # --- multipliers / color / texture identity --------------------------------
    'scale-mult-2x3': case(spec={'hMultiplier': 2, 'vMultiplier': 3},
                           args=[F(10), F(20), F(32), F(16), F(0), F(0),
                                 F(64), F(64), TEX64]),
    'tile-color': case(spec={'tileFloats': [F(0.125), F(0.5), F(0.875), F(1.0)],
                            'polyFlags': 0x902},
                       args=[F(10), F(20), F(32), F(16), F(0), F(0),
                             F(64), F(64), TEX64]),

    # --- source-rect offsets + texture-edge clamps ------------------------------
    'src-offset': case(args=[F(10), F(20), F(32), F(16), F(8), F(4),
                             F(32), F(32), TEX64]),
    'src-left-clamp':   case(args=[F(10), F(20), F(32), F(16), F(-8), F(0),
                                   F(32), F(64), TEX64]),
    'src-right-clamp':  case(args=[F(10), F(20), F(32), F(16), F(48), F(0),
                                   F(32), F(64), TEX64]),
    'src-top-clamp':    case(args=[F(10), F(20), F(32), F(16), F(0), F(-4),
                                   F(64), F(32), TEX64]),
    'src-bottom-clamp': case(args=[F(10), F(20), F(32), F(16), F(0), F(60),
                                   F(64), F(32), TEX64]),

    # --- non-1:1 stretch ---------------------------------------------------------
    'stretch-down': case(args=[F(10), F(20), F(16), F(8), F(0), F(0),
                               F(64), F(64), TEX64]),
    'stretch-up':   case(args=[F(10), F(20), F(128), F(96), F(0), F(0),
                               F(64), F(64), TEX64]),
    'stretch-clip': case(args=[F(-8), F(20), F(128), F(96), F(0), F(0),
                               F(64), F(64), TEX64]),

    # --- gates -------------------------------------------------------------------
    'drawing-off':  case(spec={'flags': 0},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0),
                               F(64), F(64), TEX64]),
    'null-texture': case(args=[F(10), F(20), F(32), F(16), F(0), F(0),
                               F(64), F(64), 0]),
    'no-canvas':    case(spec={'canvas': 0},
                         args=[F(10), F(20), F(32), F(16), F(0), F(0),
                               F(64), F(64), TEX64]),

    # --- fractionals ----------------------------------------------------------------
    'frac-round': case(args=[F(10.4), F(20.6), F(31.5), F(16.5),
                             F(0.5), F(0.25), F(64.5), F(63.5), TEX64]),
}


if __name__ == '__main__':
    _PROBE.oracle_main('drawStretchedTexture', CASES,
                       sys.argv[1] if len(sys.argv) > 1 else None)
