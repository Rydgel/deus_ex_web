"""Look-development for the crab: a small dark studio, a sheet of stills (views and poses) and a short screen test.

  blender --background --factory-startup --python video/blender/lookdev.py -- --stills [--clip] [--only hero,front]

writes video/out/blender/lookdev/: <name>.png, sheet.png (via ffmpeg) and test/ frames + test.mp4 with --clip.
"""
import math
import os
import subprocess
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage                         # noqa: E402
from crab import Crab, material      # noqa: E402
from stage import aim, FPS           # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.join(stage.OUT, 'blender', 'lookdev')


def studio(scene):
    """A dark, slightly reflective floor under a night-blue void: warm key from the front left, cold rim from behind."""
    stage.world(scene, (0.006, 0.012, 0.022))
    bpy.ops.mesh.primitive_plane_add(size=60)
    floor = bpy.context.object
    floor.name = 'floor'
    floor.data.materials.append(material('floor', (0.008, 0.015, 0.022, 1), roughness=0.5))
    focus = (0, 0, 0.27)
    stage.light('key', (-1.7, -2.4, 2.3), focus, 195, 1.8, (1.0, 0.96, 0.92))
    stage.light('rim', (1.9, 2.6, 1.15), (0, 0, 0.36), 420, 0.2, (0.4, 0.7, 1.0), spot=17)      # a cold edge from behind, kept low and narrow: off the floor and the top
    stage.light('fill', (2.4, -1.8, 0.6), focus, 48, 2.4, (0.75, 0.86, 1.0))
    stage.light('top', (0, 0.2, 3.2), focus, 16, 3.0, (0.9, 0.95, 1.0))
    camera = stage.camera('camera', lens=70, fstop=5.6)
    scene.camera = camera
    return camera


def view(camera, azimuth, elevation, distance, target=(0, 0, 0.27)):
    """Camera on a sphere around the target: azimuth 0 is straight in front (-Y), positive goes to screen-right."""
    a, e = math.radians(azimuth), math.radians(elevation)
    camera.location = Vector(target) + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * distance
    aim(camera, target)
    camera.data.dof.focus_distance = distance


# name: (camera azimuth, elevation, distance), pose
STILLS = {
    'hero':     ((-28, 12, 2.5), dict()),
    'front':    ((0, 4, 2.6), dict()),
    'back':     ((-148, 14, 2.6), dict(gaze=(0.5, 0))),
    'wave':     ((-20, 10, 2.5), dict(eyes='smile', lean=-8, height=0.012, arm_R=(78, 30, 52), arm_L=(-8, 0, 10), turn=-10)),
    'focus':    ((24, 8, 2.4), dict(eyes='focus', pitch=9, height=-0.012, arm_L=(-6, 38, 26), arm_R=(-6, 38, 26), gaze=(0, -0.6))),
    'surprise': ((-12, 6, 2.5), dict(eyes='wide', hop=0.11, squash=1.08, arm_L=(38, 0, 46), arm_R=(38, 0, 46), gaze=(0, 0.3),
                                     legs={'FL': (-0.05, -0.02, 0), 'BL': (-0.03, 0.02, 0), 'BR': (0.03, 0.02, 0), 'FR': (0.05, -0.02, 0)})),
}


def walk(crab, start, frames, x0, x1, y=0.0):
    """A sideways scuttle from x0 to x1: diagonal leg pairs alternate, the body bobs and rocks with them."""
    period, direction = 10, 1 if x1 > x0 else -1
    stride = abs(x1 - x0) / frames * period / 2                # the ground a foot covers while it is planted
    for f in range(frames + 1):
        phase = 2 * math.pi * f / period
        feet = {}
        for keys, shift in ((('FL', 'BR'), 0.0), (('FR', 'BL'), math.pi)):
            p = (phase + shift) % (2 * math.pi)
            # half the cycle planted (the foot slides back under the moving body), half in the air (it swings forward)
            dx = (0.5 - p / math.pi) * stride if p < math.pi else (-0.5 + (p - math.pi) / math.pi) * stride
            dz = 0.0 if p < math.pi else math.sin(p - math.pi) * 0.035
            for k in keys:
                feet[k] = (dx * direction, 0, dz)
        crab.pose(at=(x0 + (x1 - x0) * f / frames, y), height=0.007 * math.cos(2 * phase), lean=3.0 * math.sin(phase) + 4 * direction,
                  arm_L=(6 + 5 * math.sin(phase), 0, 8), arm_R=(6 - 5 * math.sin(phase), 0, 8), gaze=(0.7 * direction, 0), legs=feet)
        crab.key(start + f)


def screen_test(crab):
    """Six seconds: scuttle in from the left, stop, look around, notice the camera, hop, wave a snapping claw."""
    walk(crab, 1, 50, -1.5, 0.0)
    beats = [
        (56, dict(squash=0.93, height=-0.008)),                                              # settle
        (62, dict()),
        (74, dict(gaze=(-0.8, 0.1), turn=8)),
        (86, dict(gaze=(-0.8, 0.1), turn=8)),
        (89, dict(gaze=(-0.8, 0.1), turn=8, eyes='blink')),
        (92, dict(gaze=(0.8, 0.2), turn=-8)),
        (106, dict(gaze=(0.8, 0.2), turn=-8)),
        (112, dict(gaze=(0, 0), eyes='wide', height=0.01)),                                  # sees us
        (120, dict(eyes='wide', height=0.01)),
        (124, dict(eyes='smile', squash=0.86, height=-0.012, arm_R=(10, 0, 20), arm_L=(4, 0, 10))),   # crouch
        (130, dict(eyes='smile', hop=0.14, squash=1.1, arm_R=(70, 8, 40), arm_L=(30, 0, 30),
                   legs={'FL': (-0.045, -0.02, 0), 'BL': (-0.025, 0.02, 0), 'BR': (0.025, 0.02, 0), 'FR': (0.045, -0.02, 0)})),
        (136, dict(eyes='smile', squash=0.9, height=-0.01, arm_R=(70, 20, 40), arm_L=(-4, 0, 10), lean=-5, turn=-8)),  # land
        (141, dict(eyes='smile', arm_R=(86, 30, 56), lean=-9, turn=-10)),                    # wave: the claw up, snapping
        (146, dict(eyes='smile', arm_R=(60, 30, 6), lean=-5, turn=-8)),
        (151, dict(eyes='smile', arm_R=(86, 30, 56), lean=-9, turn=-10)),
        (156, dict(eyes='smile', arm_R=(60, 30, 6), lean=-5, turn=-8)),
        (161, dict(eyes='smile', arm_R=(86, 30, 56), lean=-9, turn=-10)),
        (166, dict(eyes='smile', arm_R=(64, 30, 8), lean=-6, turn=-8)),
        (176, dict(eyes='open', arm_R=(4, 0, 6))),
        (180, dict()),
    ]
    for frame, pose in beats:
        crab.pose(at=(0, 0), **pose)
        crab.key(frame)
    return 180


def main():
    stage.reset()
    scene = bpy.context.scene
    camera = studio(scene)
    crab = Crab()
    os.makedirs(OUT, exist_ok=True)
    only = ARGS[ARGS.index('--only') + 1].split(',') if '--only' in ARGS else None
    if '--stills' in ARGS:
        stage.cycles(scene, 96, (1280, 800))
        for name, (shot, pose) in STILLS.items():
            if only and name not in only:
                continue
            crab.pose(at=(0, 0), heading=0, **pose)
            view(camera, *shot)
            scene.render.filepath = os.path.join(OUT, name + '.png')
            bpy.ops.render.render(write_still=True)
        names = [n for n in STILLS if os.path.exists(os.path.join(OUT, n + '.png'))]
        if len(names) == 6:
            inputs = [arg for n in names for arg in ('-i', os.path.join(OUT, n + '.png'))]
            layout = '|'.join(f'{(k % 3) * 1280}_{(k // 3) * 800}' for k in range(6))
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', f'xstack=inputs=6:layout={layout}', os.path.join(OUT, 'sheet.png')], check=True)
    if '--clip' in ARGS:
        stage.cycles(scene, 40, (1280, 720))
        last = screen_test(crab)
        view(camera, -8, 8, 3.0, target=(-0.08, 0, 0.29))
        camera.data.lens = 58
        scene.frame_start, scene.frame_end = 1, last
        scene.render.filepath = os.path.join(OUT, 'test', 'f')
        bpy.ops.render.render(animation=True)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(OUT, 'test', 'f%04d.png'),
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', os.path.join(OUT, 'test.mp4')], check=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'crab.blend'))


main()
