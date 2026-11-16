"""The crab inside the game: renders its performance through the engine's own camera, frame for frame, and lays it over
the engine's frames (the plate, from video/film/plate-shot.mjs).

The engine's world is in Unreal units, left-handed (X forward, Y right, Z up); here it becomes metres, right-handed:
(x, -y, z) * 0.01905 (16 units to the foot), moved so the crab's first spot on the floor is the origin. The engine's
camera (a point; pitch and yaw in degrees; 75 degrees of horizontal field of view at any aspect) is a Blender camera at
that point with rotation (90 + pitch, 0, -90 - yaw) degrees and sensor fit HORIZONTAL. A floor plane catches the shadow.

  node video/film/plate-shot.mjs jc-a
  blender --background --factory-startup --python video/blender/game_shot.py -- --shot jc-a [--size 1280x720] [--samples 48] [--frames 1-124] [--step n]

writes the crab alone to video/out/film/plates/<id>/crab/ and the finished frames (plate, crab, a slow push) to
video/out/film/<id or the shot's `into`>/. With --step or a partial --frames only the crab frames are rendered;
with --composite the crab frames already there are laid over the plate again (after a plate was captured anew).

In a shot whose people walk, whoever is nearer the camera than the crab is laid back over it (people_in_front): the crab
then passes behind them as it should.
"""
import json
import math
import os
import subprocess
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import performances              # noqa: E402
import stage                     # noqa: E402
from crab import Crab, material  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
arg = lambda name, default=None: ARGS[ARGS.index(name) + 1] if name in ARGS else default
UU = 0.01905                                   # metres to an Unreal unit

# light for a place, around the crab (metres; +X is the map's +X, +Y the map's -Y): world colour, then (name, location, watts, size, colour)
LIGHTS = {
    # Liberty Island's dock at night: a little cold sky from above, the city's warm glow from the east
    'dock': ((0.012, 0.017, 0.028), [('sky', (-1.5, 1.2, 3.5), 44, 4.0, (0.6, 0.72, 1.0)), ('city', (4.0, -1.0, 1.1), 36, 1.5, (1.0, 0.74, 0.52)),
                                     ('fill', (-2.5, -2.0, 0.8), 10, 2.5, (0.62, 0.74, 1.0))]),
    # indoors under ceiling panels: soft and even from above
    'indoor': ((0.03, 0.032, 0.036), [('ceiling', (0.3, 0.2, 3.0), 70, 3.5, (0.95, 0.97, 1.0)), ('fill', (-2.0, -2.5, 1.0), 14, 3.0, (0.8, 0.86, 1.0))]),
    # a tiled station: cold green-white tubes
    'station': ((0.016, 0.03, 0.028), [('tubes', (0.5, 0.5, 2.8), 60, 3.0, (0.75, 1.0, 0.92)), ('fill', (-2.0, -2.0, 1.0), 12, 3.0, (0.7, 0.95, 0.9))]),
    # a night market: red lanterns, a cool sky
    'market': ((0.02, 0.016, 0.022), [('lanterns', (1.5, 1.0, 2.4), 48, 2.0, (1.0, 0.5, 0.42)), ('sky', (-1.5, -1.5, 3.2), 26, 4.0, (0.6, 0.72, 1.0))]),
}



def pixels(file):
    """An image as rows from the top, RGB, 0..1."""
    image = bpy.data.images.load(file, check_existing=False)
    w, h = image.size
    flat = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(flat)
    bpy.data.images.remove(image)
    return flat.reshape(h, w, 4)[::-1, :, :3]


def spread(mask, radius, grow):
    """A mask grown (or shrunk) by `radius` pixels: a square neighbourhood, one axis at a time."""
    pick = np.maximum if grow else np.minimum
    for axis in (0, 1):
        out = mask.copy()
        for k in range(1, radius + 1):
            for step in (k, -k):
                moved = np.roll(mask, step, axis=axis)
                edge = [slice(None), slice(None)]
                edge[axis] = slice(0, step) if step > 0 else slice(step, None)       # what rolled round from the other side does not count
                moved[tuple(edge)] = mask[tuple(edge)]
                out = pick(out, moved)
        mask = out
    return mask


def people_in_front(spec, plates, crab_at):
    """The mattes of the people nearer the camera than the crab, one per frame -> their folder, or None when nobody ever is.

    plate-shot.mjs captured each frame twice, with the level's people and without them (clean/), and listed where each person was
    (name, x, y, z, collision radius and half height). Where the two frames differ there is a person; the difference inside the screen
    boxes of the people who stand nearer the camera than the crab is the matte (the others are behind it, and it covers them)."""
    w, h = spec['size']
    focal = (w / 2) / math.tan(math.radians(spec['horizontalFov'] / 2))
    out = os.path.join(plates, 'front')
    os.makedirs(out, exist_ok=True)
    blank = bpy.data.images.new('matte', w, h, alpha=False)
    rgba = np.zeros((h, w, 4), dtype=np.float32)
    rgba[..., 3] = 1
    any_front, worst = 0, 0.0
    for f, here in enumerate(spec['people']):
        view = spec['cameras'][min(f, len(spec['cameras']) - 1)]
        cx, cy, cz = view['position']
        yaw, pitch = math.radians(view['yaw']), math.radians(view['pitch'])
        ahead = (math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), math.sin(pitch))
        right = (-math.sin(yaw), math.cos(yaw), 0.0)
        up = (-math.sin(pitch) * math.cos(yaw), -math.sin(pitch) * math.sin(yaw), math.cos(pitch))
        along = lambda p, axis: (p[0] - cx) * axis[0] + (p[1] - cy) * axis[1] + (p[2] - cz) * axis[2]
        crab_depth = along(crab_at[min(f, len(crab_at) - 1)], ahead)
        boxes = []
        for _name, x, y, z, radius, half in here:
            depth = along((x, y, z), ahead)
            if depth >= crab_depth or depth + radius < 2:                      # behind the crab, or behind the camera
                continue
            near, far = max(depth - radius, 6.0), max(depth + radius, 6.0)
            side, rise = along((x, y, z), right), along((x, y, z), up)
            reach, tall = radius * 2.4, half * 1.2                             # limbs swing out of the collision cylinder
            xs = [w / 2 + (side + sx * reach) / d * focal for sx in (-1, 1) for d in (near, far)]
            ys = [h / 2 - (rise + sy * tall) / d * focal for sy in (-1, 1) for d in (near, far)]
            x0, x1, y0, y1 = max(0, int(min(xs))), min(w, int(max(xs)) + 1), max(0, int(min(ys))), min(h, int(max(ys)) + 1)
            if x1 > x0 and y1 > y0:
                boxes.append((x0, x1, y0, y1))
        matte = np.zeros((h, w), dtype=np.float32)
        if boxes:
            name = f'f{f + 1:04d}.png'
            differ = np.abs(pixels(os.path.join(plates, name)) - pixels(os.path.join(plates, 'clean', name))).max(axis=2) > 0.016      # 4 of 255: the two runs are the same picture wherever nobody stands
            inside = np.zeros((h, w), dtype=bool)
            for x0, x1, y0, y1 in boxes:
                inside[y0:y1, x0:x1] = True
            worst = max(worst, float((differ & ~inside).mean()))               # what differs with nobody there: the two runs drifting apart
            matte = spread(spread((differ & inside).astype(np.float32), 8, True), 8, False)      # close the pinholes where a coat matches the wall
            matte = (matte + np.roll(matte, 1, 0) + np.roll(matte, -1, 0) + np.roll(matte, 1, 1) + np.roll(matte, -1, 1)) / 5     # a soft edge
            any_front += 1
        rgba[..., :3] = matte[::-1, :, None]
        blank.pixels.foreach_set(rgba.ravel())
        blank.filepath_raw, blank.file_format = os.path.join(out, f'f{f + 1:04d}.png'), 'PNG'
        blank.save()
    bpy.data.images.remove(blank)
    print(f"people in front of the crab in {any_front} of {len(spec['people'])} frames; outside their boxes the two runs differ in at most {worst * 100:.2f}% of a frame")
    return out if any_front else None


def main():
    name = arg('--shot')
    plates = os.path.join(stage.OUT, 'film', 'plates', name)
    spec = json.load(open(os.path.join(plates, 'plate.json')))
    size = tuple(int(v) for v in arg('--size', '1280x720').split('x'))
    frames, T = spec['frames'], spec['frames'] / stage.FPS
    S = stage.score()
    t0 = S['bar'] * spec.get('bar', 0)
    cue = {key: [v - t0 for v in S['cues'][key] if 0 <= v - t0 < T] for key in ('cursor', 'kick', 'snare', 'crash', 'impact')}
    cue['theme'] = [n['t'] - t0 for n in S['cues']['theme'] if 0 <= n['t'] - t0 < T]
    act = getattr(performances, spec['crab'])
    cue['camera'] = spec['cameras'][0]                             # the engine's camera at the frame being posed
    first = act(0.0, T, cue)
    origin = (first['uu'][0], first['uu'][1], spec['floor'])
    to_m = lambda p: Vector(((p[0] - origin[0]) * UU, -(p[1] - origin[1]) * UU, (p[2] - origin[2]) * UU))

    stage.reset()
    scene = bpy.context.scene
    stage.cycles(scene, int(arg('--samples', '48')), size, transparent=True)
    world_color, lights = LIGHTS[spec.get('light', 'dock')]
    gain = spec.get('gain', 1.0)                                   # a darker or brighter place than the rig was made for
    stage.world(scene, tuple(c * gain for c in world_color))
    rig = bpy.data.objects.new('rig', None)                        # the lights travel with the crab (they stand for the place's light, wherever it walks)
    scene.collection.objects.link(rig)
    for k, (light_name, location, power, light_size, color) in enumerate(lights):
        lamp = stage.light(light_name, location, (0, 0, 0.25), power * gain, light_size, color)
        lamp.data.use_shadow = k == 0                              # one shadow, under it, from the rig's first light: it stands on the floor
        lamp.parent = rig
    bpy.ops.mesh.primitive_plane_add(size=60)                     # the floor under it, seen only as the shadow it receives
    floor = bpy.context.object
    floor.is_shadow_catcher = True
    floor.data.materials.append(material('catcher', (0.2, 0.2, 0.2, 1), roughness=0.9))

    cam = stage.camera('engine', lens=18 / math.tan(math.radians(spec['horizontalFov'] / 2)))
    cam.data.sensor_width, cam.data.sensor_fit = 36, 'HORIZONTAL'
    cam.data.clip_start, cam.data.clip_end = 0.02, 700
    scene.camera = cam
    crab = Crab()
    crab_at = []                                                   # where it stands in each frame (Unreal units), for who is in front of it
    for f in range(1, frames + 1):
        view = spec['cameras'][min(f - 1, len(spec['cameras']) - 1)]
        cam.location = to_m(view['position'])
        cam.rotation_euler = (math.radians(90 + view['pitch']), 0, math.radians(-90 - view['yaw']))
        if len(spec['cameras']) > 1 or f == 1:
            cam.keyframe_insert('location', frame=f)
            cam.keyframe_insert('rotation_euler', frame=f)
        cue['camera'] = view
        pose = dict(act((f - 1) / stage.FPS, T, cue))
        uu, yaw, walk = pose.pop('uu'), pose.pop('yaw'), pose.pop('walk', None)
        crab_at.append((uu[0], uu[1], spec['floor'] + 20.0))
        heading = 90 - yaw
        if walk:                                                    # step the feet along the way it goes, in its own frame
            (dx, dy), phase, stride = walk
            a = math.radians(-heading)
            lx, ly = dx * math.cos(a) + dy * math.sin(a), dx * math.sin(a) - dy * math.cos(a)      # the map's direction (x, -y) turned into the crab's frame
            feet = {}
            for keys, shift in ((('FL', 'BR'), 0.0), (('FR', 'BL'), 0.5)):
                p = (phase + shift) % 1.0
                along = (0.5 - 2 * p) if p < 0.5 else (-0.5 + 2 * (p - 0.5))
                lift = 0.0 if p < 0.5 else math.sin(math.pi * 2 * (p - 0.5)) * 0.03
                for key in keys:
                    feet[key] = (lx * along * stride * UU, ly * along * stride * UU, lift)
            pose['legs'] = feet
            pose.setdefault('height', 0.0)
            pose['height'] += 0.006 * math.cos(4 * math.pi * phase)
            pose['lean'] = pose.get('lean', 0.0) + 2.5 * math.sin(2 * math.pi * phase)
        for key in ('gaze', 'arm_L', 'arm_R'):
            if key in pose:
                pose[key] = tuple(pose[key])
        at = to_m((uu[0], uu[1], spec['floor']))
        crab.pose(at=(at.x, at.y), heading=heading, **pose).key(f)
        rig.location = (at.x, at.y, 0)
        rig.keyframe_insert('location', frame=f)

    crab_dir = os.path.join(plates, 'crab')
    os.makedirs(crab_dir, exist_ok=True)
    a, b = (int(v) for v in arg('--frames', f'1-{frames}').split('-'))
    step = int(arg('--step', '1'))
    scene.frame_start, scene.frame_end, scene.frame_step = a, b, step
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.filepath = os.path.join(crab_dir, 'f')
    if '--composite' not in ARGS:
        bpy.ops.render.render(animation=True)
    if (a, b, step) != (1, frames, 1):
        return
    # plate + crab, then a slow push on the finished picture (zoompan on a doubled frame, so the push is smooth)
    dest = os.path.join(stage.OUT, 'film', spec.get('into', name))
    os.makedirs(dest, exist_ok=True)
    w, h = size
    z0, z1 = spec.get('zoom', [1.0, 1.0])
    plate = ['-framerate', '30', '-i', os.path.join(plates, 'f%04d.png')] if spec['plateFrames'] > 1 else ['-loop', '1', '-framerate', '30', '-i', os.path.join(plates, 'f0001.png')]
    background = f"[0]scale={2 * w}:{2 * h}:flags=lanczos[bg]"
    if spec.get('reveal'):
        # the picture draws itself outward from a point: big blocks first, the real frame a moment behind them
        start, length = spec['reveal']
        cx, cy = spec.get('around', [0.5, 0.5])
        ring = lambda delay: (f"color=black:s=160x90:r=30,format=gray,geq=lum='clip(255*(({1.25}*hypot(160\\,90))*clip((T-{start + delay})/{length}\\,0\\,1)"
                              f"-hypot(X-{160 * cx}\\,Y-{90 * cy}))/14\\,0\\,255)',scale={2 * w}:{2 * h}:flags=bilinear")
        background = (f"[0]scale={2 * w}:{2 * h}:flags=lanczos,split[p1][p2];[p1]scale={w // 20}:{h // 20}:flags=area,scale={2 * w}:{2 * h}:flags=neighbor,format=rgba[blocks];"
                      f"{ring(0)}[m1];{ring(0.9)}[m2];[blocks][m1]alphamerge[a];[p2]format=rgba[p3];[p3][m2]alphamerge[b];"
                      f"color=white:s={2 * w}x{2 * h}:r=30,fade=t=out:st=0:d=0.3[k];[k][a]overlay=shortest=1[k2];[k2][b]overlay=shortest=1[bg]")    # the cut before it ends in white: the white dies away into the dark
    # whoever walks nearer the camera than the crab goes back over it: the plate again, through the matte of those people
    front = people_in_front(spec, plates, crab_at) if spec.get('people') else None
    over = (f"[over];[2]scale={2 * w}:{2 * h}:flags=bilinear,format=gray[m];[3]scale={2 * w}:{2 * h}:flags=lanczos,format=rgba[pp];[pp][m]alphamerge[front];"
            f"[over][front]overlay=format=auto") if front else ''
    more = ['-framerate', '30', '-i', os.path.join(front, 'f%04d.png'), *plate] if front else []
    graph = (f"{background};[1]scale={2 * w}:{2 * h}:flags=lanczos[fg];[bg][fg]overlay=format=auto{over},"
             f"zoompan=z='{z0}+({z1}-{z0})*on/{max(1, frames - 1)}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={w}x{h}:fps=30")
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *plate, '-framerate', '30', '-i', os.path.join(crab_dir, 'f%04d.png'), *more, '-filter_complex', graph,
                    '-frames:v', str(frames), '-start_number', str(spec.get('offset', 0) + 1), os.path.join(dest, 'f%04d.png')], check=True)


main()
