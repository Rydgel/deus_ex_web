"""The crab alone on a transparent background, for graphics shots: one posed still, lit as in the look-dev studio.

  blender --background --factory-startup --python video/blender/sprite.py -- --out file.png [--size 800x800] [--view az,el,dist]
      [--pose '{"eyes": "smile", "arm_R": [70, 20, 40], "lean": -6}'] [--samples 64]

--view: camera azimuth (0 = straight in front, negative = from screen-left), elevation, distance in metres; it looks at the
body's middle with a 70 mm lens. --pose: the keyword arguments of Crab.pose (crab.py). The floor is not drawn and casts nothing.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage           # noqa: E402
from crab import Crab  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
arg = lambda name, default=None: ARGS[ARGS.index(name) + 1] if name in ARGS else default

stage.reset()
scene = bpy.context.scene
stage.cycles(scene, int(arg('--samples', '64')), tuple(int(v) for v in arg('--size', '800x800').split('x')), transparent=True)
stage.world(scene, (0.02, 0.03, 0.05))
focus = (0, 0, 0.27)
stage.light('key', (-1.7, -2.4, 2.3), focus, 195, 1.8, (1.0, 0.96, 0.92))
stage.light('rim', (1.9, 2.6, 1.15), (0, 0, 0.36), 420, 0.2, (0.4, 0.7, 1.0), spot=17)
stage.light('fill', (2.4, -1.8, 0.6), focus, 48, 2.4, (0.75, 0.86, 1.0))
pose = json.loads(arg('--pose', '{}'))
for key in ('gaze', 'arm_L', 'arm_R', 'at'):
    if key in pose:
        pose[key] = tuple(pose[key])
Crab().pose(**pose)
az, el, dist = (float(v) for v in arg('--view', '-20,10,2.6').split(','))
cam = stage.camera('camera', lens=70)
a, e = math.radians(az), math.radians(el)
cam.location = Vector(focus) + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
stage.aim(cam, focus)
scene.camera = cam
scene.render.image_settings.color_mode = 'RGBA'
scene.render.filepath = os.path.abspath(arg('--out'))
bpy.ops.render.render(write_still=True)
