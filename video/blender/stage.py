"""Shared stage tools for the film's Blender scenes: a clean scene, Cycles on the GPU, lights, cameras, cuts, the score's clock."""
import json
import math
import os

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', 'out'))
FPS = 30


def frame(t):
    """Film time in seconds -> frame number (frame 1 is t = 0)."""
    return round(t * FPS) + 1


def score():
    with open(os.path.join(OUT, 'music', 'score.json')) as f:
        return json.load(f)


def reset():
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.actions, bpy.data.images):
        for item in list(collection):
            collection.remove(item)
    for marker in list(bpy.context.scene.timeline_markers):
        bpy.context.scene.timeline_markers.remove(marker)


def cycles(scene, samples, size, transparent=False):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for device in prefs.devices:
        device.use = device.type == 'OPTIX'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPTIX'
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.fps = FPS
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'Standard'      # the crab's orange as specified, not a film curve's version of it


def world(scene, color, strength=1.0):
    scene.world = scene.world or bpy.data.worlds.new('world')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (*color, 1)
    background.inputs['Strength'].default_value = strength


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def light(name, location, target, power, size, color, spot=None, rect=None):
    """An area light (rect=(width, height) for a rectangle), or a spot of `spot` degrees with a soft radius `size`."""
    data = bpy.data.lights.new(name, 'SPOT' if spot else 'AREA')
    data.energy, data.color = power, color
    if spot:
        data.spot_size, data.spot_blend, data.shadow_soft_size = math.radians(spot), 0.6, size
    elif rect:
        data.shape, data.size, data.size_y = 'RECTANGLE', rect[0], rect[1]
    else:
        data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
    return obj


def camera(name, lens=50, fstop=None):
    data = bpy.data.cameras.new(name)
    data.lens = lens
    data.clip_start = 0.02
    if fstop:
        data.dof.use_dof, data.dof.aperture_fstop = True, fstop
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def shoot(cam, at, location, target, focus=None):
    """Keys a camera position at frame `at`, looking at `target` (focused on `focus`, default the target)."""
    cam.location = location
    aim(cam, target)
    cam.keyframe_insert('location', frame=at)
    cam.keyframe_insert('rotation_euler', frame=at)
    if cam.data.dof.use_dof:
        cam.data.dof.focus_distance = (Vector(focus or target) - Vector(location)).length
        cam.data.dof.keyframe_insert('focus_distance', frame=at)


def cut(scene, at, cam):
    """From frame `at` the scene renders through `cam`."""
    marker = scene.timeline_markers.new(cam.name, frame=at)
    marker.camera = cam
    if at <= scene.frame_start:
        scene.camera = cam
