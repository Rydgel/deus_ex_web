"""Unicorn oracle for UGC::DrawBorders (Extension native 1289).

Runs the real chain — exec 0x1202c970 -> method 0x12028df0 -> tile gate
0x12028770 (x9) -> draw sink -> clip helper -> canvas vtable +0x5c — and
records the emitted DrawTile command stream.

Exec-mode cases pass the borders array via {'$borders': [9 specs|0]} (the
*GPropAddr pointer path) or {'$bordersLocal': [...]} (the by-value local
buffer); method mode expands the same spec into nine stack dwords.

Emission: up to nine gate calls in TL,TR,BL,BR,L,R,T,B,C order with the
recovered max-fold widths/heights, margin overrides, negative-mid rescale
and per-edge stretch flags.
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

# Texture dims chosen so every fold/emission is distinguishable.  TL is
# deliberately dominant on both axes so a U/V fold swap shifts both
# accumulators.
TL = {'u': 20, 'v': 5}
TR = {'u': 6, 'v': 5}
BL = {'u': 5, 'v': 7}
BR = {'u': 7, 'v': 8}
L = {'u': 3, 'v': 30}
R = {'u': 8, 'v': 30}
T = {'u': 30, 'v': 6}
B = {'u': 30, 'v': 9}
C = {'u': 30, 'v': 30}
FULL9 = [TL, TR, BL, BR, L, R, T, B, C]


def borders(specs, local=False):
    key = '$bordersLocal' if local else '$borders'
    return {key: [s if s else 0 for s in specs]}


def case(spec=None, args=None, mode='exec', **extra):
    s = dict(BASE_SPEC)
    s.update(spec or {})
    return {'spec': s, 'args': args or [], 'mode': mode, **extra}


# DrawBorders(DestX, DestY, destW, destH, leftM, rightM, topM, botM,
#             borders[9], bStretchH, bStretchV)
CASES = {
    # --- full 9-texture border, no margins -------------------------------------
    'full-nostretch': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                                 F(0), F(0), borders(FULL9), 0, 0]),
    'full-both': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                            F(0), F(0), borders(FULL9), 1, 1]),
    'full-h': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                         F(0), F(0), borders(FULL9), 1, 0]),
    'full-v': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                         F(0), F(0), borders(FULL9), 0, 1]),
    'full-method': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1], mode='method'),
    'full-local': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                             F(0), F(0), borders(FULL9, local=True), 1, 1]),

    # --- margins override the texture-derived dims ------------------------------
    'margins': case(args=[F(10), F(20), F(100), F(80), F(12), F(14),
                          F(10), F(16), borders(FULL9), 1, 1]),
    'margins-zero': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                               F(0), F(0), borders(FULL9), 1, 1]),
    'margin-left-only': case(args=[F(10), F(20), F(100), F(80), F(20), F(0),
                                   F(0), F(0), borders(FULL9), 0, 0]),

    # --- negative middle: the rescale path --------------------------------------
    'overwide': case(args=[F(10), F(20), F(12), F(80), F(0), F(0),
                           F(0), F(0), borders(FULL9), 1, 1]),
    'overtall': case(args=[F(10), F(20), F(100), F(14), F(0), F(0),
                           F(0), F(0), borders(FULL9), 1, 1]),
    'overboth': case(args=[F(10), F(20), F(12), F(14), F(0), F(0),
                           F(0), F(0), borders(FULL9), 1, 1]),

    # --- missing textures ---------------------------------------------------------
    'edges-only': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                             F(0), F(0), borders([0, 0, 0, 0, L, R, T, B, 0]),
                             1, 1]),
    'corners-only': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                               F(0), F(0), borders([TL, TR, BL, BR, 0, 0, 0, 0, 0]),
                               0, 0]),
    'center-only': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders([0, 0, 0, 0, 0, 0, 0, 0, C]),
                              1, 1]),
    'empty': case(args=[F(10), F(20), F(100), F(80), F(0), F(0),
                        F(0), F(0), borders([0] * 9), 1, 1]),

    # --- partial clip --------------------------------------------------------------
    'clip-left':   case(args=[F(-20), F(20), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),
    'clip-right':  case(args=[F(600), F(20), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),
    'clip-top':    case(args=[F(10), F(-10), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),
    'clip-bottom': case(args=[F(10), F(450), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),

    # --- fully clipped out -----------------------------------------------------------
    'clip-out-left':   case(args=[F(-200), F(20), F(100), F(80), F(0), F(0),
                                  F(0), F(0), borders(FULL9), 1, 1]),
    'clip-out-bottom': case(args=[F(10), F(600), F(100), F(80), F(0), F(0),
                                  F(0), F(0), borders(FULL9), 1, 1]),

    # --- invalid dest dims --------------------------------------------------------------
    'zero-width':  case(args=[F(10), F(20), F(0), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),
    'neg-height':  case(args=[F(10), F(20), F(100), F(-8), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),

    # --- origin / multipliers ---------------------------------------------------------------
    'origin-shift': case(spec={'originX': F(5), 'originY': F(7)},
                         args=[F(10), F(20), F(100), F(80), F(0), F(0),
                               F(0), F(0), borders(FULL9), 1, 1]),
    'scale-mult': case(spec={'hMultiplier': 2, 'vMultiplier': 2},
                       args=[F(10), F(20), F(100), F(80), F(0), F(0),
                             F(0), F(0), borders(FULL9), 1, 1]),

    # --- gates ------------------------------------------------------------------------------
    'drawing-off': case(spec={'flags': 0},
                        args=[F(10), F(20), F(100), F(80), F(0), F(0),
                              F(0), F(0), borders(FULL9), 1, 1]),
}


if __name__ == '__main__':
    _PROBE.oracle_main('drawBorders', CASES,
                       sys.argv[1] if len(sys.argv) > 1 else None)
