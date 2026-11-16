"""Scene 1, "boot" (bars 1 to 8, 0:00 to 0:16.5): black, a cursor, the game's files, the request; the crab wakes in front
of the terminal, reads, and on the cymbal's peak dives into the screen.

  node video/film/screens.mjs boot            the terminal feed first
  blender --background --factory-startup --python video/blender/scene_boot.py -- [--size 1280x720] [--samples 64] [--frames 1-498]

writes video/out/film/boot/f####.png (and boot.mp4 with the music when the whole range is rendered).
"""
import json
import math
import os
import subprocess
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage                            # noqa: E402
from crab import Crab, material         # noqa: E402
from props import keyboard, monitor     # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
arg = lambda name, default: ARGS[ARGS.index(name) + 1] if name in ARGS else default
SIZE = tuple(int(v) for v in arg('--size', '1280x720').split('x'))
SAMPLES = int(arg('--samples', '64'))
FEED = os.path.join(stage.OUT, 'film', 'screens', 'boot')
DEST = os.path.join(stage.OUT, 'film', 'boot')
HOME = (0.0, -1.0)                       # where the crab sits, facing the screen (+Y)


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def crab_at(t, S):
    """The crab's whole pose at film time t."""
    bar = S['bar']
    bells = [bar * b for b in (2, 3, 4, 5)]
    pose = dict(at=HOME, heading=180, squash=1 + 0.012 * math.sin(2 * math.pi * 0.28 * t), eyes='open', gaze=(0.0, 0.1))
    if t < bells[0]:                                                    # asleep
        pose.update(eyes='blink', squash=0.955 + 0.01 * math.sin(2 * math.pi * 0.2 * t), height=-0.008)
    elif t < bells[0] + 0.5:                                            # the first file wakes it
        pose.update(eyes='sleepy', height=-0.008 * (1 - ease((t - bells[0]) / 0.5)))
    for bell in bells:                                                  # a small start at each new line
        if 0 <= t - bell < 0.5:
            pose['height'] = pose.get('height', 0) + 0.014 * math.sin(math.pi * (t - bell) / 0.5) * (1 - (t - bell) / 0.5)
    for blink in (bar * 3.55, bar * 5.3, bar * 6.5, bar * 7.05):
        if 0 <= t - blink < 0.13:
            pose['eyes'] = 'blink'
    typing0, typing1 = bar * 6 + 0.2, bar * 6 + 0.2 + 37 / 13.5          # the request being typed: the eyes follow it
    if typing0 <= t:
        pose['gaze'] = (0.6 - 1.2 * ease((t - typing0) / (typing1 - typing0)), -0.05)
    tilt = bar * 6.5                                                    # the last bell: a curious tilt
    if tilt <= t < tilt + 1.4:
        pose['lean'] = 6 * math.sin(math.pi * ease((t - tilt) / 1.4))
    enter = bar * 7.5                                                   # Enter: it understood
    if t >= enter:
        pose['gaze'] = (0, 0.15)
        pose['eyes'] = 'wide' if t < enter + 0.3 else 'focus'
    crouch, leap, land = bar * 8 - 0.62, bar * 8 - 0.36, bar * 8
    if crouch <= t < leap:
        k = ease((t - crouch) / (leap - crouch))
        pose.update(squash=1 - 0.2 * k, height=-0.022 * k, arm_L=(-10 * k, 20 * k, 10), arm_R=(-10 * k, 20 * k, 10))
    elif t >= leap:                                                     # the dive into the screen
        k = min(1.0, (t - leap) / (land - leap))
        pose.update(at=(0, HOME[1] + 0.68 * k), hop=0.02 + 0.3 * math.sin(math.pi * min(1, k * 0.8)) + 0.12 * k, squash=1.14, pitch=14 * k,
                    arm_L=(25, 55, 34), arm_R=(25, 55, 34), eyes='focus',
                    legs={'FL': (-0.03, 0.05, 0), 'FR': (0.03, 0.05, 0), 'BL': (-0.02, 0.08, 0), 'BR': (0.02, 0.08, 0)})
    return pose


def main():
    S = stage.score()
    bar = S['bar']
    feed = json.load(open(os.path.join(FEED, 'feed.json')))
    last = feed['frames']
    stage.reset()
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, last
    stage.cycles(scene, SAMPLES, SIZE)
    stage.world(scene, (0.0015, 0.003, 0.006))
    col = scene.collection
    bpy.ops.mesh.primitive_plane_add(size=60)
    bpy.context.object.data.materials.append(material('floor', (0.006, 0.01, 0.015, 1), roughness=0.32))
    crt = monitor(col, FEED, last)
    board = keyboard(col)
    board.location = (0.02, -0.5, 0)
    crab = Crab()

    # the screen is the scene's lamp: off until the cursor's first blip, brighter as it fills, white at the dive
    sx, sy, sz = crt['screen']
    glow = stage.light('screen_glow', (sx, sy - 0.03, sz), (sx, sy - 1, sz - 0.02), 0, 0, (0.62, 0.82, 1.0), rect=crt['size'])
    for t, watts, emit in ((0, 0, 0), (bar - 0.02, 0, 0), (bar + 0.3, 2.6, 4), (bar * 5.5, 5, 5), (bar * 7.5, 6, 5.5), (bar * 8 - 0.3, 30, 14), (bar * 8, 380, 40)):
        glow.data.energy = watts
        glow.data.keyframe_insert('energy', frame=stage.frame(t))
        crt['emission'].inputs['Emission Strength'].default_value = emit
        crt['emission'].inputs['Emission Strength'].keyframe_insert('default_value', frame=stage.frame(t))
    stage.light('moon', (-1.6, -3.1, 2.1), (0, -1.0, 0.3), 55, 2.5, (0.55, 0.7, 1.0))                  # just enough to find its back in the dark
    stage.light('edge', (1.5, -0.3, 1.3), (0, -1.0, 0.4), 70, 0.2, (0.4, 0.66, 1.0), spot=20)

    for f in range(1, last + 1, 2):
        crab.pose(**crab_at((f - 1) / stage.FPS, S)).key(f)
    crab.pose(**crab_at((last - 1) / stage.FPS, S)).key(last)

    # three shots, cut on bars 3 and 7
    close = stage.camera('close', lens=30, fstop=5.6)                    # the dark glass, the sleeping crab reflected in it
    stage.shoot(close, 1, (0.07, -0.8, 0.375), (sx, sy, sz - 0.005))
    stage.shoot(close, stage.frame(bar * 2), (0.045, -0.7, 0.355), (sx, sy, sz))
    over = stage.camera('over', lens=46, fstop=4)                        # over its back, down at the screen
    stage.shoot(over, stage.frame(bar * 2), (0.9, -2.6, 1.42), (0.03, -0.55, 0.3), focus=(sx, sy, sz))
    stage.shoot(over, stage.frame(bar * 6), (0.72, -2.3, 1.27), (0.02, -0.55, 0.3), focus=(sx, sy, sz))
    face = stage.camera('face', lens=32, fstop=4)                        # from beside the monitor: its face in the screen's light
    stage.shoot(face, stage.frame(bar * 6), (-0.8, -0.0, 0.47), (0.0, -0.92, 0.3), focus=(0, -0.84, 0.35))
    stage.shoot(face, stage.frame(bar * 8), (-0.73, -0.05, 0.44), (0.0, -0.88, 0.31), focus=(0, -0.84, 0.35))
    stage.cut(scene, 1, close)
    stage.cut(scene, stage.frame(bar * 2), over)
    stage.cut(scene, stage.frame(bar * 6), face)

    os.makedirs(DEST, exist_ok=True)
    first, final = (int(v) for v in arg('--frames', f'1-{last}').split('-'))
    step = int(arg('--step', '1'))
    scene.frame_start, scene.frame_end, scene.frame_step = first, final, step
    scene.render.filepath = os.path.join(DEST, 'f')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(DEST, 'boot.blend'))
    bpy.ops.render.render(animation=True)
    if (first, final, step) == (1, last, 1):
        music = os.path.join(stage.OUT, 'music', 'score.wav')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', str(stage.FPS), '-i', os.path.join(DEST, 'f%04d.png'), '-i', music,
                        '-vf', f'fade=t=out:st={bar * 8 - 0.2:.3f}:d=0.2:color=white', '-af', f'afade=t=out:st={bar * 8 - 0.05:.3f}:d=1.2',
                        '-t', f'{bar * 8 + 1.2:.3f}', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-c:a', 'aac', '-b:a', '256k',
                        os.path.join(DEST, 'boot.mp4')], check=True)


main()
