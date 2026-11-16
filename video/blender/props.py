"""Props built by script: a CRT monitor from around 2000 whose screen plays a feed from video/film/screens.mjs, a keyboard."""
import math
import os

import bmesh
import bpy
from mathutils import Vector

from crab import box, empty, material, _finish


def feed_material(name, folder, frames, strength=5.0):
    """Glass that glows with a PNG sequence (frame N of the film shows fNNNN.png)."""
    image = bpy.data.images.load(os.path.join(folder, 'f0001.png'))
    image.source = 'SEQUENCE'
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.extension = 'EXTEND'
    tex.image_user.frame_duration, tex.image_user.frame_start, tex.image_user.frame_offset = frames, 1, 0
    tex.image_user.use_auto_refresh = True
    bsdf.inputs['Base Color'].default_value = (0.004, 0.005, 0.007, 1)
    bsdf.inputs['Roughness'].default_value = 0.08
    bsdf.inputs['Coat Weight'].default_value = 0.5
    links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = strength
    return mat, bsdf


def monitor(collection, feed, frames, name='crt'):
    """A beige CRT on its foot, facing -Y, origin on the floor. -> {root, screen: (x, y, z) centre, size, emission: the node}."""
    plastic = material(f'{name}_plastic', (0.36, 0.33, 0.28, 1), roughness=0.55)
    dark = material(f'{name}_bezel', (0.012, 0.012, 0.014, 1), roughness=0.3)
    glass, emission = feed_material(f'{name}_glass', feed, frames)
    w, d, h, z0 = 0.50, 0.46, 0.43, 0.075
    root = empty(name, collection)
    # the shell: a box whose back half narrows around the tube
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), plane_co=(0, -0.2, 0), plane_no=(0, 1, 0))
    for v in bm.verts:
        if v.co.y > 0.3:
            v.co.x *= 0.66
            v.co.z = 0.06 + (v.co.z - 0.06) * 0.66
        v.co = Vector((v.co.x * w, v.co.y * d, v.co.z * h))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.022, offset_type='OFFSET', segments=4, profile=0.5, affect='EDGES', clamp_overlap=True)
    shell = _finish(f'{name}_shell', bm, plastic, collection)
    shell.parent, shell.location = root, (0, 0.02, z0 + h / 2)
    front = 0.02 - d / 2
    sw, sh, sz = 0.38, 0.285, z0 + h / 2 + 0.018
    bezel = box(f'{name}_bezel', (sw + 0.03, 0.02, sh + 0.03), dark, collection, bevel=0.006, segments=3)
    bezel.parent, bezel.location = root, (0, front - 0.004, sz)
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in ((-sw / 2, 0, -sh / 2), (sw / 2, 0, -sh / 2), (sw / 2, 0, sh / 2), (-sw / 2, 0, sh / 2))]
    face = bm.faces.new(verts)
    uv = bm.loops.layers.uv.new('uv')
    for loop, st in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = st
    screen = _finish(f'{name}_screen', bm, glass, collection)
    screen.parent, screen.location = root, (0, front - 0.0145, sz)
    for part_name, size, location in ((f'{name}_neck', (0.16, 0.16, 0.05), (0, 0.04, 0.055)), (f'{name}_foot', (0.3, 0.27, 0.035), (0, 0.04, 0.0175))):
        part = box(part_name, size, plastic, collection, bevel=0.012, segments=3)
        part.parent, part.location = root, location
    led = box(f'{name}_led', (0.012, 0.006, 0.006), material(f'{name}_led', (0.1, 1.0, 0.25, 1), emission=6.0), collection, bevel=0.002, segments=2)
    led.parent, led.location = root, (w / 2 - 0.05, front - 0.002, z0 + 0.03)
    return {'root': root, 'screen': (0, front - 0.0145, sz), 'size': (sw, sh), 'emission': emission}


def keyboard(collection, name='keyboard'):
    """A beige keyboard, long side along X, origin on the floor under its centre."""
    plastic = material(f'{name}_plastic', (0.36, 0.33, 0.28, 1), roughness=0.55)
    caps = material(f'{name}_keys', (0.5, 0.47, 0.41, 1), roughness=0.5)
    root = empty(name, collection)
    slab = box(f'{name}_slab', (0.46, 0.17, 0.024), plastic, collection, bevel=0.008, segments=3)
    slab.parent, slab.location, slab.rotation_euler = root, (0, 0, 0.02), (math.radians(5), 0, 0)
    bm = bmesh.new()
    for row in range(5):
        for col in range(15):
            wide = 2 if (row == 4 and 4 <= col <= 9) else 1                 # a space bar
            if row == 4 and 5 <= col <= 9:
                continue
            made = bmesh.ops.create_cube(bm, size=1.0)
            for v in made['verts']:
                v.co = Vector((v.co.x * (0.0245 * wide * (3 if wide == 2 else 1) - 0.002 if wide == 2 else 0.0225), v.co.y * 0.0225, v.co.z * 0.012))
                v.co += Vector((-0.199 + col * 0.0284 + (0.057 if wide == 2 else 0), 0.057 - row * 0.0284, 0.0))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.003, offset_type='OFFSET', segments=2, profile=0.5, affect='EDGES', clamp_overlap=True)
    keys = _finish(f'{name}_keys', bm, caps, collection)
    keys.parent, keys.location = slab, (0, 0, 0.017)
    return root
