"""Unicorn oracle for UGC::DrawText (Extension native 1282).

Runs the real chain — exec trampoline 0x1202c280 -> method 0x12028180 ->
PushGC -> Intersect -> GetTextExtent (vAlign) -> scanLine/nextChar ->
drawGlyph 0x12029e40 -> realize cache 0x1202a370 -> the render-interface
glyph slot (*(*(canvas+0x7c)+0x64) vtable +0x7c, the same boundary the
Engine UCanvas::DrawTile delegates to) — and records the captured
DrawGlyphTile command stream plus TextureLock/Unlock/PushGC-alloc events.
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


def glyph(u, v, w, h):
    return [u, v, w, h]


def FONT(cpp=0x100, pages=None):
    """$font spec — pages are {'page'?, 'tex': {'u','v'}|0, 'chars': {...}}."""
    return {'$font': {'charsPerPage': cpp, 'pages': pages or []}}


# charsPerPage=0x100 keeps ASCII on page 0; the map keys are code points.
def p0(tex, chars):
    return {'tex': tex, 'chars': chars}


STD_FONT = FONT(pages=[p0({'u': 64, 'v': 64}, {
    0x20: glyph(0, 0, 4, 10),      # space
    0x41: glyph(1, 1, 8, 12),      # 'A'
    0x42: glyph(10, 1, 7, 12),     # 'B'
    0x43: glyph(20, 1, 9, 12),     # 'C'
    0x61: glyph(30, 1, 8, 11),     # 'a'
    0x62: glyph(40, 1, 8, 11),     # 'b'
})])

WIDE_FONT = FONT(pages=[p0({'u': 128, 'v': 64}, {
    0x20: glyph(0, 0, 6, 10),
    0x41: glyph(1, 1, 20, 14),     # wide 'A'
    0x42: glyph(30, 1, 18, 14),    # wide 'B'
})])

BOLD_FONT = FONT(pages=[p0({'u': 64, 'v': 64}, {
    0x20: glyph(0, 0, 4, 10),
    0x41: glyph(2, 2, 10, 14),     # bold 'A'
    0x42: glyph(15, 2, 9, 14),     # bold 'B'
})])

# vSize=1 glyphs sit exactly at the 1.0f line-height floor — the space
# fallback must NOT fire (a floor of 2 would shift the second line).
TINY_FONT = FONT(pages=[p0({'u': 64, 'v': 64}, {
    0x20: glyph(0, 0, 4, 10),      # space — taller than the glyphs
    0x41: glyph(1, 1, 8, 1),       # 'A'
    0x42: glyph(10, 1, 8, 1),      # 'B'
})])

# Two-page font: 'A' on page 0, the ideograph 0x4e2d on page 0x4e.
TWO_PAGE_FONT = FONT(cpp=0x100, pages=[
    {'tex': {'u': 64, 'v': 64}, 'chars': {0x41: glyph(1, 1, 8, 12)}},
    {'page': 0x4e, 'tex': {'u': 128, 'v': 128},
     'chars': {0x2d: glyph(5, 5, 16, 16)}},
])

BASE_SPEC = {
    'vtable': 0x120598dc,
    'fill': 0,                          # un-set fields read 0
    'canvas': {'$canvas': {'z': F(0.5)}},
    'originX': F(0), 'originY': F(0),
    'clipX': F(0), 'clipY': F(0), 'clipWidth': F(640), 'clipHeight': F(480),
    'flags': 0x2,
    'textPolyFlags': 0x804,
    'textFloats': [F(1.0), F(0.5), F(0.25), F(1.0)],
    'normalFont': STD_FONT,
    'boldFont': 0,
    'textFlags': 0,
    'textVSpacing': F(0),
    'hAlign': 0, 'vAlign': 0,
    'baselineOffset': F(0), 'underlineHeight': F(0), 'unknown84': 0,
    'hMultiplier': 1, 'vMultiplier': 1,
    'stackTop': 0, 'freeList': 0, 'owner': 0, 'depth': 0,
}


def case(spec=None, args=None, mode='exec', **extra):
    s = dict(BASE_SPEC)
    s.update(spec or {})
    return {'spec': s, 'args': args or [], 'mode': mode, **extra}


def T(s):
    return {'$text': s}


def U(units):
    return {'$units': units}


CASES = {
    # --- baseline -------------------------------------------------------
    'basic': case(args=[F(10), F(20), F(200), F(40), T('ABC')]),
    'basic-method': case(args=[F(10), F(20), F(200), F(40), T('ABC')],
                         mode='method'),
    'frac-pos': case(args=[F(10.4), F(20.6), F(200), F(40), T('AB')]),
    'empty-exec': case(args=[F(10), F(20), F(200), F(40), T('')]),
    'empty-method': case(args=[F(10), F(20), F(200), F(40), T('')],
                         mode='method'),

    # --- gates -----------------------------------------------------------
    'drawing-off': case(spec={'flags': 0},
                        args=[F(10), F(20), F(200), F(40), T('ABC')]),
    'no-canvas': case(spec={'canvas': 0},
                      args=[F(10), F(20), F(200), F(40), T('ABC')]),
    'null-text': case(args=[F(10), F(20), F(200), F(40), 0], mode='method'),

    # --- no font / glyph misses -------------------------------------------
    'no-font': case(spec={'normalFont': 0},
                    args=[F(10), F(20), F(200), F(40), T('ABC')]),
    'missing-glyph': case(args=[F(10), F(20), F(200), F(40), T('AZC')]),
    'space-only': case(args=[F(10), F(20), F(200), F(40), T('   ')]),

    # --- newlines ---------------------------------------------------------
    'newline': case(args=[F(10), F(20), F(200), F(60), T('AB\nCA')]),
    'newline-trailing': case(args=[F(10), F(20), F(200), F(60), T('AB\n')]),
    'newline-dbl': case(args=[F(10), F(20), F(200), F(80), T('A\n\nC')]),
    'vspacing': case(spec={'textVSpacing': F(2.5)},
                     args=[F(10), F(20), F(200), F(60), T('AB\nCA')]),

    # --- horizontal alignment ----------------------------------------------
    'halign-center': case(spec={'hAlign': 1},
                          args=[F(10), F(20), F(200), F(40), T('AB')]),
    'halign-right': case(spec={'hAlign': 2},
                         args=[F(10), F(20), F(200), F(40), T('AB')]),
    'halign-center-odd': case(spec={'hAlign': 1},
                              args=[F(10), F(20), F(201), F(40), T('A')]),
    'halign-center-newline': case(spec={'hAlign': 1},
                                  args=[F(10), F(20), F(200), F(60), T('AB\nC')]),

    # --- vertical alignment (runs GetTextExtent internally) -----------------
    'valign-center': case(spec={'vAlign': 1},
                          args=[F(10), F(20), F(200), F(40), T('AB')]),
    'valign-bottom': case(spec={'vAlign': 2},
                          args=[F(10), F(20), F(200), F(40), T('AB')]),
    'valign-center-newline': case(spec={'vAlign': 1},
                                  args=[F(10), F(20), F(200), F(60), T('A\nB')]),
    'valign-3': case(spec={'vAlign': 3},
                     args=[F(10), F(20), F(200), F(40), T('AB')]),

    # --- word wrap ----------------------------------------------------------
    'wrap': case(spec={'textFlags': 1},
                 args=[F(10), F(20), F(30), F(60), T('AAA AAA')]),
    'wrap-frac-width': case(spec={'textFlags': 1},
                            args=[F(10), F(20), F(30.9), F(60), T('AAA AAA')]),
    'nowrap-width': case(args=[F(10), F(20), F(10), F(60), T('ABCA')]),

    # --- clipping ------------------------------------------------------------
    'clip-out-top': case(args=[F(10), F(-30), F(200), F(40), T('ABC')]),
    'clip-out-left': case(args=[F(-60), F(20), F(200), F(40), T('ABC')]),
    'clip-partial': case(spec={'clipX': F(0), 'clipWidth': F(20)},
                         args=[F(10), F(20), F(200), F(40), T('ABC')]),
    'clip-glyph-edge': case(spec={'clipX': F(0), 'clipWidth': F(15)},
                            args=[F(10), F(20), F(200), F(40), T('AB')]),
    'clip-height': case(spec={'clipY': F(0), 'clipHeight': F(25)},
                        args=[F(10), F(20), F(200), F(40), T('AB')]),
    'clip-rect-offset': case(spec={'clipX': F(50), 'clipY': F(50),
                                   'clipWidth': F(30), 'clipHeight': F(20)},
                             args=[F(40), F(40), F(200), F(40), T('ABC')]),

    # --- origin --------------------------------------------------------------
    'origin-shift': case(spec={'originX': F(5), 'originY': F(7)},
                         args=[F(10), F(20), F(200), F(40), T('AB')]),

    # --- multipliers ---------------------------------------------------------
    'scale-2x3': case(spec={'hMultiplier': 2, 'vMultiplier': 3},
                      args=[F(10), F(20), F(200), F(40), T('AB')]),
    'scale-neg': case(spec={'hMultiplier': -1, 'vMultiplier': -1},
                      args=[F(10), F(20), F(200), F(40), T('A')]),

    # --- special text ---------------------------------------------------------
    'special-bold': case(spec={'textFlags': 2, 'boldFont': BOLD_FONT},
                         args=[F(10), F(20), F(200), F(40), T('A|bBA|!bB')]),
    'special-color': case(spec={'textFlags': 2},
                          args=[F(10), F(20), F(200), F(40), T('A|c10203B')]),
    'special-color-off': case(spec={'textFlags': 2},
                              args=[F(10), F(20), F(200), F(40), T('|c10203A|!cB')]),
    'special-pal': case(spec={'textFlags': 2},
                        args=[F(10), F(20), F(200), F(40), T('A|p3B')]),
    'special-amp': case(spec={'textFlags': 2},
                        args=[F(10), F(20), F(200), F(40), T('A|&B')]),
    'special-unknown': case(spec={'textFlags': 2},
                            args=[F(10), F(20), F(200), F(40), T('A|xB')]),
    'special-off-flag': case(spec={'textFlags': 0},
                             args=[F(10), F(20), F(200), F(40), T('A|bB')]),

    # --- underline -------------------------------------------------------------
    'underline': case(spec={'textFlags': 2, 'baselineOffset': F(2),
                            'underlineHeight': F(1.5),
                            'unknown84': {'$texture': {'u': 16, 'v': 16}}},
                      args=[F(10), F(20), F(200), F(40), T('A|&B')]),
    'underline-no-tex': case(spec={'textFlags': 2, 'baselineOffset': F(2),
                                   'underlineHeight': F(1.5)},
                             args=[F(10), F(20), F(200), F(40), T('A|&B')]),
    'underline-no-height': case(spec={'textFlags': 2, 'baselineOffset': F(2),
                                      'unknown84': {'$texture': {'u': 16, 'v': 16}}},
                                args=[F(10), F(20), F(200), F(40), T('A|&B')]),
    'underline-clip': case(spec={'textFlags': 2, 'baselineOffset': F(2),
                                 'underlineHeight': F(1.5),
                                 'unknown84': {'$texture': {'u': 16, 'v': 16}},
                                 'clipX': F(0), 'clipWidth': F(15)},
                           args=[F(10), F(20), F(200), F(40), T('|&AB')]),
    # clipX sits right of DestX — the underline's left edge clips, shifting
    # its source U by -(x - clipLeft).
    'underline-clip-left': case(spec={'textFlags': 2, 'baselineOffset': F(2),
                                      'underlineHeight': F(1.5),
                                      'unknown84': {'$texture': {'u': 16, 'v': 16}},
                                      'clipX': F(15), 'clipWidth': F(30)},
                                args=[F(10), F(20), F(200), F(40), T('|&AB')]),

    # --- fonts / pages ----------------------------------------------------------
    'bold-default-font': case(spec={'textFlags': 2},
                              args=[F(10), F(20), F(200), F(40), T('A|bB|!bC')]),
    'two-page': case(spec={'normalFont': TWO_PAGE_FONT},
                     args=[F(10), F(20), F(200), F(40), U([0x41, 0x4e2d])]),

    # --- line-height floor ------------------------------------------------------
    'line-floor': case(spec={'normalFont': TINY_FONT},
                       args=[F(10), F(20), F(200), F(60), T('AB\nAB')]),

    # --- realize cache ----------------------------------------------------------
    'cache-evict': case(spec={'normalFont': FONT(cpp=0x20, pages=[
        {'page': p, 'tex': {'u': 32 + p, 'v': 32},
         'chars': {0x01: glyph(0, 0, 8, 8)}} for p in range(8)])},
        args=[F(10), F(20), F(400), F(40),
              U([0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0x41, 0x21])]),

    # --- pushGC / popGC effects ----------------------------------------------------
    'pushgc-restore': case(spec={'originX': F(3), 'originY': F(4)},
                           args=[F(10), F(20), F(200), F(40), T('AB')]),
}


if __name__ == '__main__':
    _PROBE.oracle_main('drawText', CASES,
                       sys.argv[1] if len(sys.argv) > 1 else None)
