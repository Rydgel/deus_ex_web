"""Props for the study scenes and the late-night scene: glowing sheets (PNG feeds from video/film/panels.mjs on emissive planes),
the wall of validators, the white flash that opens and closes shots, a dark glossy floor, a desk and a lamp, and the small
tools the scenes share (easing, cameras keyed from a function of time, the crab's sideways gait).
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector

import stage
from crab import box, empty, material

PANELS = os.path.join(stage.OUT, 'film', 'panels')
FPS = stage.FPS


# ------------------------------------------------------------------------------------------------- small tools
def clamp(x, a=0.0, b=1.0):
    return min(b, max(a, x))


def ease(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def mix(a, b, k):
    return a + (b - a) * k


def mix3(a, b, k):
    return tuple(mix(p, q, k) for p, q in zip(a, b))


def pulse(t, t0, decay):
    """1 at t0, falling away exponentially (0 before)."""
    return math.exp(-(t - t0) / decay) if t >= t0 else 0.0


def curve(t, points):
    """Eased interpolation through (time, value) points (values are numbers or equal-length tuples); holds the first and last value."""
    if t <= points[0][0]:
        return points[0][1]
    for (t0, a), (t1, b) in zip(points, points[1:]):
        if t <= t1:
            k = ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
            return tuple(mix(p, q, k) for p, q in zip(a, b)) if isinstance(a, tuple) else mix(a, b, k)
    return points[-1][1]


def wrap(angle, around):
    """`angle` moved by whole turns to be the closest to `around` (degrees)."""
    return angle + 360 * round((around - angle) / 360)


# ------------------------------------------------------------------------------------------------- planes and sheets
def quad(name, width, height, collection, anchor='center'):
    """A quad in the XZ plane facing -Y (toward the default camera), UV 0..1; anchor 'center' or 'bottom' (origin at the bottom edge's middle)."""
    z0, z1 = (-height / 2, height / 2) if anchor == 'center' else (0.0, height)
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in ((-width / 2, 0, z0), (width / 2, 0, z0), (width / 2, 0, z1), (-width / 2, 0, z1))]
    face = bm.faces.new(verts)
    uv = bm.loops.layers.uv.new('uv')
    for loop, st in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = st
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def _math(nodes, links, op, a, b=None, clamp_result=False):
    """A Math node on a (socket or number) and b (socket or number); returns its output socket."""
    node = nodes.new('ShaderNodeMath')
    node.operation, node.use_clamp = op, clamp_result
    for i, value in enumerate((a, b)):
        if value is None:
            continue
        if isinstance(value, (int, float)):
            node.inputs[i].default_value = value
        else:
            links.new(value, node.inputs[i])
    return node.outputs[0]


def _value(nodes, name, value):
    node = nodes.new('ShaderNodeValue')
    node.name = node.label = name
    node.outputs[0].default_value = value
    return node


def load_image(path, frames=None, data=False):
    image = bpy.data.images.load(path)
    image.alpha_mode = 'STRAIGHT'
    if data:
        image.colorspace_settings.name = 'Non-Color'
    if frames:
        image.source = 'SEQUENCE'
    return image


def sheet_material(name, path, frames=None, strength=3.0, tint=(1, 1, 1), diffuse=0.1, band=False, falloff=None):
    """
    An emissive, see-through glass for a feed: the image's colour glows, its alpha is the cut-out. `diffuse` is how much of its light
    reaches diffuse surfaces (lamps do that job; the thin text would only add noise). Returns (material, controls): Value nodes `gain`
    (a multiplier to key), and with band=True `band_z`, `band_amp`, `band_w`: a horizontal band of extra light across the world's height.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new('ShaderNodeOutputMaterial')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = load_image(path, frames)
    tex.extension = 'CLIP'
    if frames:
        tex.image_user.frame_duration, tex.image_user.frame_start, tex.image_user.frame_offset = frames, 1, 0
        tex.image_user.use_auto_refresh = True
    tinted = nodes.new('ShaderNodeMix')
    tinted.data_type, tinted.blend_type = 'RGBA', 'MULTIPLY'
    tinted.inputs['Factor'].default_value = 1.0
    links.new(tex.outputs['Color'], tinted.inputs['A'])
    tinted.inputs['B'].default_value = (*tint, 1)
    gain = _value(nodes, 'gain', 1.0)
    lp = nodes.new('ShaderNodeLightPath')
    only_camera = _math(nodes, links, 'SUBTRACT', 1.0, _math(nodes, links, 'MULTIPLY', lp.outputs['Is Diffuse Ray'], 1.0 - diffuse))
    level = _math(nodes, links, 'MULTIPLY', gain.outputs[0], only_camera)
    controls = {'gain': gain.outputs[0], 'mat': mat}
    if band or falloff:
        geo = nodes.new('ShaderNodeNewGeometry')
        sep = nodes.new('ShaderNodeSeparateXYZ')
        links.new(geo.outputs['Position'], sep.inputs[0])
    if falloff:                                                  # darker with height: exp(-z / falloff)
        level = _math(nodes, links, 'MULTIPLY', level, _math(nodes, links, 'EXPONENT', _math(nodes, links, 'MULTIPLY', _math(nodes, links, 'MAXIMUM', sep.outputs['Z'], 0.0), -1.0 / falloff)))
    if band:
        z0, amp, width = _value(nodes, 'band_z', 0.0), _value(nodes, 'band_amp', 0.0), _value(nodes, 'band_w', 0.12)
        d = _math(nodes, links, 'DIVIDE', _math(nodes, links, 'SUBTRACT', sep.outputs['Z'], z0.outputs[0]), width.outputs[0])
        bump = _math(nodes, links, 'EXPONENT', _math(nodes, links, 'MULTIPLY', _math(nodes, links, 'MULTIPLY', d, d), -1.0))
        boost = _math(nodes, links, 'ADD', 1.0, _math(nodes, links, 'MULTIPLY', bump, amp.outputs[0]))
        level = _math(nodes, links, 'MULTIPLY', level, boost)
        controls.update(band_z=z0.outputs[0], band_amp=amp.outputs[0], band_w=width.outputs[0])
    emission = nodes.new('ShaderNodeEmission')
    links.new(tinted.outputs['Result'], emission.inputs['Color'])
    scaled = _math(nodes, links, 'MULTIPLY', level, strength)
    links.new(scaled, emission.inputs['Strength'])
    clear = nodes.new('ShaderNodeBsdfTransparent')
    shader = nodes.new('ShaderNodeMixShader')
    links.new(tex.outputs['Alpha'], shader.inputs['Fac'])
    links.new(clear.outputs[0], shader.inputs[1])
    links.new(emission.outputs[0], shader.inputs[2])
    links.new(shader.outputs[0], out.inputs['Surface'])
    return mat, controls


def sheet(name, collection, path, size, location, rot_z=0.0, frames=None, anchor='center', **kw):
    """A glowing sheet of `size` metres at `location`, turned rot_z degrees about Z (0 faces -Y). -> (object, controls)."""
    obj = quad(name, size[0], size[1], collection, anchor)
    mat, controls = sheet_material(name, path, frames, **kw)
    obj.data.materials.append(mat)
    obj.location = location
    obj.rotation_euler = (0, 0, math.radians(rot_z))
    obj.visible_shadow = False                 # a sheet is light, not an obstacle
    return obj, controls


def key(socket, frame, value, interpolation=None):
    socket.default_value = value
    socket.keyframe_insert('default_value', frame=frame)


def feed_info(name):
    import json
    with open(os.path.join(PANELS, name, 'feed.json')) as f:
        return json.load(f)


# ------------------------------------------------------------------------------------------------- the wall of validators
def validator_column(name, collection, path, index, per_column, location, size, rot_z=0.0):
    """
    One column of the wall of validators. The image holds masks (red the names, green the dots, blue the outlines and ground); the
    shader lights a row when its order (index * per_column + row) has been reached by the keyed Value `count`, and flashes the newest.
    -> (object, count socket).
    """
    obj = quad(name, size[0], size[1], collection, 'bottom')
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new('ShaderNodeOutputMaterial')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = load_image(path, data=True)
    tex.extension = 'CLIP'
    sep = nodes.new('ShaderNodeSeparateColor')
    links.new(tex.outputs['Color'], sep.inputs['Color'])
    coord = nodes.new('ShaderNodeTexCoord')
    split = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['UV'], split.inputs[0])
    row = _math(nodes, links, 'FLOOR', _math(nodes, links, 'MULTIPLY', _math(nodes, links, 'SUBTRACT', 1.0, split.outputs['Y']), float(per_column)))
    order = _math(nodes, links, 'ADD', row, float(index * per_column))
    count = _value(nodes, 'count', 0.0)
    lit = _math(nodes, links, 'LESS_THAN', order, count.outputs[0])
    recent = _math(nodes, links, 'MULTIPLY', lit, _math(nodes, links, 'MAXIMUM', 0.0, _math(nodes, links, 'SUBTRACT', 1.0, _math(nodes, links, 'DIVIDE', _math(nodes, links, 'SUBTRACT', count.outputs[0], order), 14.0))))
    lp = nodes.new('ShaderNodeLightPath')
    only_camera = _math(nodes, links, 'SUBTRACT', 1.0, _math(nodes, links, 'MULTIPLY', lp.outputs['Is Diffuse Ray'], 0.9))

    def colour(base, hot, k):
        node = nodes.new('ShaderNodeMix')
        node.data_type = 'RGBA'
        node.inputs['A'].default_value, node.inputs['B'].default_value = (*base, 1), (*hot, 1)
        links.new(k, node.inputs['Factor'])
        return node.outputs['Result']

    names = nodes.new('ShaderNodeMix')                                   # name text: dim cyan -> bright mint-white, white-hot as it passes
    names.data_type, names.blend_type = 'RGBA', 'MULTIPLY'
    names.inputs['Factor'].default_value = 1.0
    links.new(colour((0.10, 0.26, 0.46), (0.55, 1.0, 0.78), lit), names.inputs['A'])
    links.new(colour((1, 1, 1), (3.0, 3.0, 3.0), recent), names.inputs['B'])
    # sum: R * names + G * dot colour * lit + B * outline colour
    emit = nodes.new('ShaderNodeEmission')
    r_part = nodes.new('ShaderNodeMix')
    r_part.data_type, r_part.blend_type = 'RGBA', 'MULTIPLY'
    r_part.inputs['Factor'].default_value = 1.0
    links.new(names.outputs['Result'], r_part.inputs['A'])
    r_vec = nodes.new('ShaderNodeCombineColor')
    for socket in r_vec.inputs:
        links.new(sep.outputs['Red'], socket)
    links.new(r_vec.outputs['Color'], r_part.inputs['B'])
    g_part = nodes.new('ShaderNodeMix')
    g_part.data_type, g_part.blend_type = 'RGBA', 'MULTIPLY'
    g_part.inputs['Factor'].default_value = 1.0
    g_mint = colour((0.0, 0.0, 0.0), (0.25, 1.0, 0.55), lit)
    links.new(g_mint, g_part.inputs['A'])
    g_vec = nodes.new('ShaderNodeCombineColor')
    for socket in g_vec.inputs:
        links.new(_math(nodes, links, 'MULTIPLY', sep.outputs['Green'], 3.0), socket)
    links.new(g_vec.outputs['Color'], g_part.inputs['B'])
    b_part = nodes.new('ShaderNodeMix')
    b_part.data_type, b_part.blend_type = 'RGBA', 'MULTIPLY'
    b_part.inputs['Factor'].default_value = 1.0
    links.new(colour((0.10, 0.28, 0.5), (0.25, 0.9, 0.6), lit), b_part.inputs['A'])
    b_vec = nodes.new('ShaderNodeCombineColor')
    for socket in b_vec.inputs:
        links.new(sep.outputs['Blue'], socket)
    links.new(b_vec.outputs['Color'], b_part.inputs['B'])
    add1 = nodes.new('ShaderNodeMix')
    add1.data_type, add1.blend_type = 'RGBA', 'ADD'
    add1.inputs['Factor'].default_value = 1.0
    links.new(r_part.outputs['Result'], add1.inputs['A'])
    links.new(g_part.outputs['Result'], add1.inputs['B'])
    add2 = nodes.new('ShaderNodeMix')
    add2.data_type, add2.blend_type = 'RGBA', 'ADD'
    add2.inputs['Factor'].default_value = 1.0
    links.new(add1.outputs['Result'], add2.inputs['A'])
    links.new(b_part.outputs['Result'], add2.inputs['B'])
    links.new(add2.outputs['Result'], emit.inputs['Color'])
    emit.inputs['Strength'].default_value = 1.6
    gain = _value(nodes, 'gain', 1.0)
    links.new(_math(nodes, links, 'MULTIPLY', _math(nodes, links, 'MULTIPLY', gain.outputs[0], 1.6), only_camera), emit.inputs['Strength'])
    alpha = _math(nodes, links, 'ADD', _math(nodes, links, 'ADD', sep.outputs['Red'], sep.outputs['Green']), _math(nodes, links, 'MULTIPLY', sep.outputs['Blue'], 0.9), True)
    clear = nodes.new('ShaderNodeBsdfTransparent')
    shader = nodes.new('ShaderNodeMixShader')
    links.new(alpha, shader.inputs['Fac'])
    links.new(clear.outputs[0], shader.inputs[1])
    links.new(emit.outputs[0], shader.inputs[2])
    links.new(shader.outputs[0], out.inputs['Surface'])
    obj.data.materials.append(mat)
    obj.location = location
    obj.rotation_euler = (0, 0, math.radians(rot_z))
    obj.visible_shadow = False
    return obj, {'count': count.outputs[0], 'gain': gain.outputs[0], 'mat': mat}


# ------------------------------------------------------------------------------------------------- the flash
def flash_plane(collection, camera, strength=1.7):
    """A white veil right in front of `camera` that also lights the scene; -> the Value node's socket `level` (0 clear .. 1 white) to key."""
    obj = quad('flash', 1.6, 0.9, collection)
    obj.parent = camera
    obj.rotation_euler = (math.radians(90), 0, 0)
    obj.location = (0, 0, -0.15)
    mat = bpy.data.materials.new('flash')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new('ShaderNodeOutputMaterial')
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (0.86, 0.94, 1.0, 1)
    emit.inputs['Strength'].default_value = strength
    clear = nodes.new('ShaderNodeBsdfTransparent')
    shader = nodes.new('ShaderNodeMixShader')
    level = _value(nodes, 'level', 0.0)
    links.new(level.outputs[0], shader.inputs['Fac'])
    links.new(clear.outputs[0], shader.inputs[1])
    links.new(emit.outputs[0], shader.inputs[2])
    links.new(shader.outputs[0], out.inputs['Surface'])
    obj.data.materials.append(mat)
    obj.visible_shadow = False
    return level.outputs[0]


# ------------------------------------------------------------------------------------------------- floors
def floor(collection, color=(0.006, 0.010, 0.015, 1), roughness=0.24, size=80, z=0.0, specular=0.5):
    """A dark, slightly glossy floor (the sheets show in it); `specular` is the Principled specular level (lower: fainter reflections)."""
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in ((-size, -size, z), (size, -size, z), (size, size, z), (-size, size, z))]
    bm.faces.new(verts)
    mesh = bpy.data.meshes.new('floor')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('floor', mesh)
    collection.objects.link(obj)
    mat = material('floor', color, roughness=roughness)
    next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Specular IOR Level'].default_value = specular
    obj.data.materials.append(mat)
    return obj


# ------------------------------------------------------------------------------------------------- cameras keyed from a function of time
def _aim_euler(location, target, previous=None):
    rot = (Vector(target) - Vector(location)).to_track_quat('-Z', 'Y')
    return rot.to_euler('XYZ', previous) if previous else rot.to_euler('XYZ')


def keyed_camera(name, view, first, last, step=2, fstop=4.0, collection=None):
    """
    A camera whose position, aim, lens and focus follow `view(frame) -> {'at': (x,y,z), 'to': (x,y,z), 'lens': mm, 'focus': (x,y,z) | metres | None}`,
    keyed every `step` frames from `first` to `last`.
    """
    cam = stage.camera(name, lens=35, fstop=fstop)
    previous = None
    frames = list(range(first, last + 1, step))
    if frames[-1] != last:
        frames.append(last)
    for f in frames:
        v = view(f)
        cam.location = v['at']
        previous = _aim_euler(v['at'], v['to'], previous)
        cam.rotation_euler = previous
        cam.data.lens = v.get('lens', 35)
        focus = v.get('focus')
        if focus is None:
            focus = v['to']
        cam.data.dof.focus_distance = focus if isinstance(focus, (int, float)) else (Vector(focus) - Vector(v['at'])).length
        cam.keyframe_insert('location', frame=f)
        cam.keyframe_insert('rotation_euler', frame=f)
        cam.data.keyframe_insert('lens', frame=f)
        if cam.data.dof.use_dof:
            cam.data.dof.keyframe_insert('focus_distance', frame=f)
    return cam


# ------------------------------------------------------------------------------------------------- the crab's gait
def gait(phase, direction, stride):
    """
    Feet and body for a sideways scuttle at `phase` (radians; one cycle = 2 pi): diagonal leg pairs alternate, half the cycle planted
    (the foot slides back under the moving body), half in the air. -> (legs dict for Crab.pose, bob height, roll degrees).
    `stride` is the ground a foot covers while it is planted, in metres.
    """
    feet = {}
    for keys, shift in ((('FL', 'BR'), 0.0), (('FR', 'BL'), math.pi)):
        p = (phase + shift) % (2 * math.pi)
        dx = (0.5 - p / math.pi) * stride if p < math.pi else (-0.5 + (p - math.pi) / math.pi) * stride
        dz = 0.0 if p < math.pi else math.sin(p - math.pi) * 0.035
        for k in keys:
            feet[k] = (dx * direction, 0, dz)
    return feet, 0.007 * math.cos(2 * phase), 3.0 * math.sin(phase) + 4 * direction


# ------------------------------------------------------------------------------------------------- the late-night props
def _along(obj, start, end):
    """Orient an object built along +Z so that it runs from `start` to `end`."""
    d = Vector(end) - Vector(start)
    obj.location = start
    obj.rotation_euler = Vector((0, 0, 1)).rotation_difference(d).to_euler()
    return d.length


def _cone(name, collection, r1, r2, depth, mat, open_ends=True, segments=40):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=not open_ends, cap_tris=False, segments=segments, radius1=r1, radius2=r2, depth=depth)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def desk_lamp(collection, base, joint, head, aim, power=420.0, color=(1.0, 0.70, 0.40)):
    """
    A desk lamp: weighted base, two arms, a conical shade with a warm bulb, and a spot light in it aimed at `aim`.
    base/joint/head are (x, y, z) in metres. -> the light object.
    """
    metal = material('lamp_metal', (0.03, 0.04, 0.04, 1), roughness=0.32, coat=0.2)
    inner = material('lamp_inner', (0.9, 0.55, 0.25, 1), roughness=0.5, emission=0.8)
    bulb_mat = material('lamp_bulb', (1.0, 0.8, 0.5, 1), emission=40.0)
    foot = box('lamp_foot', (0.2, 0.2, 0.03), metal, collection, pivot=(0, 0, -0.015), bevel=0.012, segments=3)
    foot.location = base
    low = box('lamp_arm1', (0.016, 0.016, 1.0), metal, collection, pivot=(0, 0, -0.5), bevel=0.005, segments=2)
    length = _along(low, (base[0], base[1], base[2] + 0.03), joint)
    low.scale = (1, 1, length)
    up = box('lamp_arm2', (0.016, 0.016, 1.0), metal, collection, pivot=(0, 0, -0.5), bevel=0.005, segments=2)
    length = _along(up, joint, head)
    up.scale = (1, 1, length)
    knob = box('lamp_joint', (0.04, 0.04, 0.04), metal, collection, bevel=0.012, segments=3)
    knob.location = joint
    d = (Vector(aim) - Vector(head)).normalized()
    shade = _cone('lamp_shade', collection, 0.035, 0.17, 0.2, metal)
    shade.location = Vector(head) + d * 0.06
    shade.rotation_euler = Vector((0, 0, 1)).rotation_difference(-d).to_euler()          # narrow end up, the wide mouth toward the aim
    cone_in = _cone('lamp_shade_in', collection, 0.032, 0.166, 0.196, inner)
    cone_in.location, cone_in.rotation_euler = shade.location, shade.rotation_euler
    bulb = box('lamp_bulb', (0.06, 0.06, 0.06), bulb_mat, collection, bevel=0.025, segments=3)
    bulb.location = Vector(head) + d * 0.1
    bulb.visible_shadow = False
    bulb.visible_glossy = False
    cone_in.visible_glossy = False
    light = stage.light('lamp', Vector(head) + d * 0.1, aim, power, 0.05, color, spot=75)
    light.data.spot_blend = 0.8
    light.visible_glossy = False
    return light


def mug(collection, at):
    ceramic = material('mug', (0.55, 0.52, 0.48, 1), roughness=0.35, coat=0.3)
    coffee = material('coffee', (0.012, 0.007, 0.004, 1), roughness=0.08)
    body = _cone('mug', collection, 0.045, 0.045, 0.1, ceramic, open_ends=True)
    body.location = (at[0], at[1], 0.05)
    liquid = _cone('coffee', collection, 0.043, 0.043, 0.002, coffee, open_ends=False)
    liquid.location = (at[0], at[1], 0.085)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    handle = box('mug_handle', (0.02, 0.012, 0.06), ceramic, collection, bevel=0.005, segments=2)
    handle.location = (at[0] + 0.055, at[1], 0.05)
    bm.free()
    base = _cone('mug_base', collection, 0.0, 0.045, 0.002, ceramic, open_ends=False)
    base.location = (at[0], at[1], 0.001)


def city_lights(collection, count=60, seed=7):
    """Far, small emitters in a band behind the scene: with a wide aperture they become soft discs, a window onto a sleeping city."""
    import random
    rng = random.Random(seed)
    cool = material('far_cool', (0.7, 0.85, 1.0, 1), emission=3.2)
    warm = material('far_warm', (1.0, 0.72, 0.4, 1), emission=3.0)
    white = material('far_white', (1.0, 0.97, 0.92, 1), emission=2.4)
    for i in range(count):
        mat = rng.choice([cool] * 5 + [warm] * 2 + [white] * 3)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=rng.uniform(0.05, 0.1))
        mesh = bpy.data.meshes.new(f'far_{i}')
        bm.to_mesh(mesh)
        bm.free()
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(f'far_{i}', mesh)
        collection.objects.link(obj)
        obj.location = (rng.uniform(-4.5, 6.5), rng.uniform(7.0, 10.0), rng.uniform(0.15, 1.5))
        obj.visible_shadow = False
