"""Scene "nights" (bars 40 to 44, 1:22.8 to 1:31.1): late at night a desk lamp, the monitor from scene 1 scrolling `git log`, the crab working.

  node video/film/panels.mjs nights                     the monitor's log first
  blender --background --factory-startup --python video/blender/scene_nights.py -- [--size 1280x720] [--samples 48] [--frames 1-248] [--step 1] [--out DIR]

writes video/out/film/nights/f####.png (248 frames; frame 1 is film time 40 * score.bar). Three cameras, cut on bars 42 and 43.
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage                                                          # noqa: E402
from crab import Crab                                                 # noqa: E402
from props import keyboard, monitor                                   # noqa: E402
from props_study import (PANELS, clamp, city_lights, curve, desk_lamp, ease, feed_info, floor, gait, key, keyed_camera, mix, mix3, mug, pulse)   # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
arg = lambda name, default: ARGS[ARGS.index(name) + 1] if name in ARGS else default
SIZE = tuple(int(v) for v in arg('--size', '1280x720').split('x'))
SAMPLES = int(arg('--samples', '48'))
S = stage.score()
BAR, BEAT, STEP = S['bar'], S['beat'], S['step']
FRAMES = 248
CRAB_AT = (0.0, -0.84)


def f_of(t):
    return round(t * stage.FPS) + 1


def taps():
    """When the claws hit the keys: the groove's bass hits (steps 0 3 6 8 11 14 of each bar) and, between them, a few more at a typist's uneven pace."""
    out = []
    for b in range(4):
        for s in range(16):
            h = math.sin((b * 16 + s) * 12.9898 + 3.1) * 43758.5453
            if s in (0, 3, 6, 8, 11, 14) or (h - math.floor(h)) < 0.42:
                out.append((b * BAR + s * STEP, len(out) % 2))
    return out


def main():
    stage.reset()
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, FRAMES
    stage.cycles(scene, SAMPLES, SIZE)
    stage.world(scene, (0.0015, 0.003, 0.006))
    col = scene.collection
    info = feed_info('nights')
    floor(col, color=(0.006, 0.010, 0.015, 1), roughness=0.42)
    crt = monitor(col, os.path.join(PANELS, 'nights'), info['frames'])
    board = keyboard(col)
    board.location = (0.02, -0.5, 0)
    board.scale = (1.35, 1.35, 1.35)
    crab = Crab()
    sx, sy, sz = crt['screen']
    key(crt['emission'].inputs['Emission Strength'], 1, 5.0)
    glow = stage.light('screen_glow', (sx, sy - 0.03, sz), (sx, sy - 1, sz - 0.02), 14, 0, (0.62, 0.82, 1.0), rect=crt['size'])
    glow.visible_glossy = False
    lamp_light = desk_lamp(col, (1.15, -0.1, 0.0), (0.85, -0.15, 0.6), (0.42, -0.3, 0.8), (0.0, -0.6, 0.05), power=120.0)
    mug(col, (-0.62, -0.18))
    city_lights(col)
    cool = stage.light('moon', (-1.9, -3.0, 2.1), (0, -0.7, 0.3), 70, 2.5, (0.55, 0.7, 1.0))
    cool.visible_glossy = False
    edge = stage.light('edge', (-1.5, 0.9, 1.1), (0, -0.7, 0.4), 120, 0.2, (0.4, 0.66, 1.0), spot=25)
    rim_lamp = stage.light('lamp_rim', (1.9, 0.8, 1.1), (0.7, -0.15, 0.6), 160, 0.2, (0.5, 0.75, 1.0), spot=18)
    edge.visible_glossy = rim_lamp.visible_glossy = False

    tap = taps()
    for f in range(1, FRAMES + 1):
        t = (f - 1) / stage.FPS
        face = ease((t - 3 * BAR + 0.05) / 0.05)                          # in the close-up the screen's light and the lamp's balance toward the cool
        glow.data.energy = mix(14, 11, face)
        glow.data.keyframe_insert('energy', frame=f)
        lamp_light.data.energy = mix(120, 34, face)
        lamp_light.data.keyframe_insert('energy', frame=f)

    def pose(t):
        legs = {}
        eyes = 'open'
        # slow blinks: heavy lids, shut, open again
        for blink in (0.9, 3.7, 5.6, 7.5):
            u = t - blink
            if 0 <= u < 0.18:
                eyes = 'sleepy'
            elif 0.18 <= u < 0.46:
                eyes = 'blink'
            elif 0.46 <= u < 0.62:
                eyes = 'sleepy'
        gx = 0.35 * math.sin(t * 0.9) + 0.0
        gy = -0.15 + 0.2 * math.sin(t * 0.37 + 1.0)
        arms = []
        for side in (0, 1):
            hit = max([pulse(t, tt, 0.07) for tt, sd in tap if sd == side and tt <= t] or [0.0])
            arms.append((10 - 22 * hit, 52 + 4 * hit, 8))
        pitch = 3 + 1.5 * math.sin(t * 0.6)
        lean = 0.0
        stretch = curve(t, [(5.9, 0), (6.3, 1), (6.9, 1), (7.4, 0)])        # a stretch after a long run: claws up, then back to work
        squash = 1 + 0.012 * math.sin(2 * math.pi * 0.28 * t) + 0.03 * stretch
        if stretch > 0.01:
            arms = [(10 + 55 * stretch, 52 - 40 * stretch, 8 + 20 * stretch)] * 2
            pitch -= 6 * stretch
            eyes = 'wide' if stretch > 0.5 and eyes == 'open' else eyes
        if t > 7.6:
            eyes = 'focus' if eyes == 'open' else eyes
        return dict(at=CRAB_AT, heading=180, squash=squash, eyes=eyes, gaze=(gx, gy), pitch=pitch, lean=lean, arm_L=arms[0], arm_R=arms[1], height=-0.004, legs=legs)

    for f in range(1, FRAMES + 1):
        crab.pose(**pose((f - 1) / stage.FPS)).key(f)

    # three cameras: wide from behind, over its shoulder at the screen, its face in the screen's light
    def view_a(f):
        t = (f - 1) / stage.FPS
        k = ease(t / (2 * BAR))
        return {'at': (mix(-3.9, -3.2, k), mix(-5.2, -4.3, k), mix(0.9, 0.8, k)), 'to': (mix(0.45, 0.4, k), -0.4, mix(0.38, 0.4, k)), 'lens': mix(62, 56, k), 'focus': (CRAB_AT[0], CRAB_AT[1], 0.3)}

    def view_b(f):
        t = (f - 1) / stage.FPS
        k = clamp((t - 2 * BAR) / BAR)
        return {'at': (mix(0.62, 0.5, k), mix(-1.55, -1.42, k), mix(0.92, 0.84, k)), 'to': (0.0, -0.21, mix(0.3, 0.28, k)), 'lens': 40, 'focus': (0, sy, sz)}

    def view_c(f):
        t = (f - 1) / stage.FPS
        k = clamp((t - 3 * BAR) / BAR)
        return {'at': (mix(-1.15, -0.95, k), mix(-0.0, -0.05, k), mix(0.34, 0.34, k)), 'to': (mix(-0.03, -0.02, k), -0.68, 0.36), 'lens': 38, 'focus': (CRAB_AT[0], CRAB_AT[1] + 0.17, 0.4)}

    cam_a = keyed_camera('cam_a', view_a, 1, f_of(2 * BAR) - 1, fstop=1.4)
    cam_b = keyed_camera('cam_b', view_b, f_of(2 * BAR), f_of(3 * BAR) - 1, fstop=3.6)
    cam_c = keyed_camera('cam_c', view_c, f_of(3 * BAR), FRAMES, fstop=2.2)
    stage.cut(scene, 1, cam_a)
    stage.cut(scene, f_of(2 * BAR), cam_b)
    stage.cut(scene, f_of(3 * BAR), cam_c)
    ctx_constant = [glow.data, lamp_light.data]
    for owner in ctx_constant:
        for layer in owner.animation_data.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        for k in fc.keyframe_points:
                            k.interpolation = 'CONSTANT'

    dest = arg('--out', os.path.join(stage.OUT, 'film', 'nights'))
    os.makedirs(dest, exist_ok=True)
    first, final = (int(v) for v in arg('--frames', f'1-{FRAMES}').split('-'))
    scene.frame_start, scene.frame_end, scene.frame_step = first, final, int(arg('--step', '1'))
    scene.render.filepath = os.path.join(dest, 'f')
    if '--save' in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(dest, 'nights.blend'))
    bpy.ops.render.render(animation=True)


main()
