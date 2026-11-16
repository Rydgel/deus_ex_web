"""The crab: Claude's orange mascot as a posable 3D puppet, built entirely by this script (no modelling by hand).

The shape follows the terminal sprite's pixel grid (one sprite column = U wide, one quarter-block row = 2 U tall):
a body 12 x 8, two dark eyes 1 x 2 set two columns in from each side in the upper half, an arm 2 x 2 at mid-height on
each side, four legs 1 x 2 under it (the outer pair in front, the inner pair behind, so a front view shows all four).
In 3D the arms are split into two jaws so they can open as claws, and every edge is rounded like a vinyl toy.

It is a rigid puppet, not a skinned mesh: each part is its own object with its origin on its joint, parented under
empties, and is animated through object transforms. Crab.pose() sets a whole pose from a few named controls and
Crab.key() keys it. 'L' and 'R' are screen-left (-X) and screen-right (+X) when the crab faces the camera (-Y).
"""
import math

import bmesh
import bpy
from mathutils import Euler, Vector

U = 0.05                                  # one sprite column, metres: the crab stands 0.5 m tall and 0.6 m wide
BODY = (12 * U, 7 * U, 8 * U)             # width, depth, height
LEG = (1.3 * U, 1.3 * U, 2 * U)
ARM = (2.1 * U, 2.2 * U, 2.2 * U)         # reach, depth, height (both jaws together)
EYE = (1.3 * U, 0.5 * U, 2.4 * U)
EYE_X, EYE_Z = 3.5 * U, 1.0 * U           # eye centres, from the body's centre
ARM_Z = -1.0 * U                          # arm joint height, from the body's centre
LEGS = {'FL': (-4.5 * U, -1.8 * U), 'BL': (-2.5 * U, 1.8 * U), 'BR': (2.5 * U, 1.8 * U), 'FR': (4.5 * U, -1.8 * U)}


def srgb(code):
    """'#D97757' -> linear RGBA."""
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (*(lin(int(code[i:i + 2], 16) / 255) for i in (1, 3, 5)), 1.0)


ORANGE = srgb('#D97757')


def material(name, color, roughness=0.5, coat=0.0, subsurface=0.0, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = 0.12
    if subsurface:
        bsdf.inputs['Subsurface Weight'].default_value = subsurface
        bsdf.inputs['Subsurface Radius'].default_value = (0.05, 0.02, 0.01)
        bsdf.inputs['Subsurface Scale'].default_value = 1.0
    if emission:
        bsdf.inputs['Emission Color'].default_value = color
        bsdf.inputs['Emission Strength'].default_value = emission
    return mat


def _finish(name, bm, mat, collection):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.modifiers.new('normals', 'WEIGHTED_NORMAL').keep_sharp = True        # flat faces stay flat, the rounding shades smooth
    return obj


def box(name, size, mat, collection, pivot=(0, 0, 0), bevel=0.01, segments=5, flat=0):
    """
    A rounded box whose object origin is `pivot` (given from the box's centre). flat=+1 or -1 leaves the top or bottom face
    with sharp edges: two such boxes laid face to face read as one rounded block with a seam (a closed claw).
    """
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    edges = [e for e in bm.edges if not (flat and all(v.co.z * flat > 0 for v in e.verts))]
    for e in bm.edges:
        e.smooth = e in edges                                  # the flat face keeps a crisp outline
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) - Vector(pivot)
    if bevel:
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, offset_type='OFFSET', segments=segments, profile=0.5, affect='EDGES', clamp_overlap=True)
    return _finish(name, bm, mat, collection)


def arc(name, radius, thickness, depth, mat, collection, start=20, end=160, steps=14):
    """An arch in the XZ plane (a closed, smiling eye), origin at the arch's centre."""
    bm = bmesh.new()
    rings = []
    for k in range(steps + 1):
        a = math.radians(start + (end - start) * k / steps)
        ring = []
        for r in (radius - thickness / 2, radius + thickness / 2):
            for y in (-depth / 2, depth / 2):
                ring.append(bm.verts.new((r * math.cos(a), y, r * math.sin(a))))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i, j in ((0, 1), (1, 3), (3, 2), (2, 0)):
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new((rings[0][0], rings[0][2], rings[0][3], rings[0][1]))
    bm.faces.new((rings[-1][0], rings[-1][1], rings[-1][3], rings[-1][2]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=thickness * 0.22, offset_type='OFFSET', segments=2, profile=0.5, affect='EDGES', clamp_overlap=True)
    return _finish(name, bm, mat, collection)


def empty(name, collection, parent=None, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.03
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    return obj


# eye shapes: (scale x, scale z, tilt in degrees: positive leans both eyes' tops outward), or 'smile' for the closed arches
EYES = {'open': (1, 1, 0), 'blink': (1.05, 0.1, 0), 'wide': (1.2, 1.22, 0), 'focus': (1.05, 0.72, 13), 'sad': (1, 0.85, -13),
        'sleepy': (1.05, 0.42, 0), 'squint': (1.1, 0.5, 6)}


class Crab:
    """Builds the puppet under `collection`. Parts: root > hips > body, face > eyes; arms > jaws; legs."""

    def __init__(self, collection=None, name='crab'):
        col = collection or bpy.context.scene.collection
        self.shell = material(f'{name}_shell', ORANGE, roughness=0.45, coat=0.18, subsurface=0.04)
        self.gloss = material(f'{name}_eye', (0.006, 0.005, 0.007, 1), roughness=0.2, coat=0.45)      # glossy, but not a mirror: a screen in front of it must not white the eyes out
        self.glint = material(f'{name}_glint', (1, 0.97, 0.93, 1), roughness=0.3, emission=1.6)
        w, d, h = BODY
        self.root = empty(name, col)                                              # on the ground, between the feet
        self.hips = empty(f'{name}_hips', col, self.root, (0, 0, LEG[2]))         # the body's underside: bob, lean, squash from here
        self.body = box(f'{name}_body', BODY, self.shell, col, pivot=(0, 0, -h / 2), bevel=0.9 * U, segments=7)
        self.body.parent = self.hips
        self.face = empty(f'{name}_face', col, self.body, (0, -d / 2, h / 2 + EYE_Z))
        self.eyes, self.smiles, self.arms, self.jaws, self.legs = {}, {}, {}, {}, {}
        for side, sx in (('L', -1), ('R', 1)):
            eye = box(f'{name}_eye_{side}', EYE, self.gloss, col, bevel=0.3 * U, segments=4)
            eye.parent = self.face
            eye.location = (sx * EYE_X, -0.12 * U, 0)
            self.eyes[side] = eye
            glint = box(f'{name}_glint_{side}', (0.34 * U, 0.1 * U, 0.34 * U), self.glint, col, bevel=0.05 * U, segments=2)
            glint.parent = eye
            glint.location = (-0.26 * U, -EYE[1] / 2, 0.62 * U)
            smile = arc(f'{name}_smile_{side}', 0.85 * U, 0.42 * U, 0.4 * U, self.gloss, col)
            smile.parent = self.face
            smile.location = (sx * EYE_X, -0.1 * U, -0.45 * U)
            smile.scale = (0, 0, 0)
            self.smiles[side] = smile
            arm = empty(f'{name}_arm_{side}', col, self.body, (sx * (w / 2 - 0.25 * U), 0, h / 2 + ARM_Z))
            self.arms[side] = arm
            for part, sz in (('top', 1), ('bot', -1)):
                jaw_h = ARM[2] / 2 - 0.025 * U                              # closed, the two jaws make one cube with a hairline between
                jaw = box(f'{name}_jaw_{side}_{part}', (ARM[0] + 0.25 * U, ARM[1], jaw_h), self.shell, col,
                          pivot=(-sx * (ARM[0] + 0.25 * U) / 2, 0, -sz * (jaw_h / 2 + 0.025 * U)), bevel=0.42 * U, segments=5, flat=-sz)
                jaw.parent = arm
                self.jaws[side, part] = jaw
        for key, (x, y) in LEGS.items():
            leg = box(f'{name}_leg_{key}', LEG, self.shell, col, pivot=(0, 0, LEG[2] / 2), bevel=0.3 * U, segments=4)
            leg.parent = self.hips
            leg.location = (x, y, 0.3 * U)                                        # the joint sits just inside the body
            self.legs[key] = leg
        # sunglasses, JC's kind: two dark lenses, a bridge, short arms round the corners, a square glint on each lens. Off until asked for.
        self.lens = material(f'{name}_lens', (0.003, 0.006, 0.016, 1), roughness=0.34, coat=0.3)      # dark whatever lamp is in front of them
        self.shades = empty(f'{name}_shades', col, self.body, (0, -d / 2 - 0.72 * U, h / 2 + EYE_Z + 0.1 * U))
        for sx in (-1, 1):
            lens = box(f'{name}_lens_{sx}', (3.1 * U, 0.34 * U, 2.25 * U), self.lens, col, bevel=0.3 * U, segments=3)
            lens.parent, lens.location = self.shades, (sx * 3.45 * U, 0, 0)
            arm = box(f'{name}_temple_{sx}', (0.3 * U, 2.6 * U, 0.34 * U), self.lens, col, bevel=0.08 * U, segments=2)
            arm.parent, arm.location = self.shades, (sx * (w / 2 + 0.16 * U), 1.45 * U, 0.55 * U)
            shine = box(f'{name}_shine_{sx}', (0.42 * U, 0.1 * U, 0.42 * U), self.glint, col, bevel=0.05 * U, segments=2)
            shine.parent, shine.location = self.shades, (sx * 3.45 * U - 0.85 * U, -0.2 * U, 0.55 * U)
        bridge = box(f'{name}_bridge', (4.2 * U, 0.3 * U, 0.34 * U), self.lens, col, bevel=0.08 * U, segments=2)
        bridge.parent, bridge.location = self.shades, (0, 0, 0.6 * U)
        self.shades.scale = (0, 0, 0)
        self.parts = [self.root, self.hips, self.body, self.face, *self.eyes.values(), *self.smiles.values(), *self.arms.values(),
                      *self.jaws.values(), *self.legs.values(), self.shades]
        self.pose()

    def pose(self, at=None, heading=None, height=0.0, lean=0.0, pitch=0.0, turn=0.0, squash=1.0, eyes='open', gaze=(0.0, 0.0),
             arm_L=(0, 0, 0), arm_R=(0, 0, 0), legs=None, hop=0.0, shades=0.0):
        """
        at: (x, y) on the ground; heading: degrees about Z (0 faces the camera side, -Y). hop: metres off the ground.
        height: body up/down on its legs; lean: degrees of roll (positive toward +X); pitch: degrees, positive bows forward;
        turn: degrees the body twists on its legs; squash: body height factor (volume kept).
        eyes: a name in EYES or 'smile'; gaze: (-1..1, -1..1), where the eyes look (right, up).
        arm_L / arm_R: (raise, forward, open) in degrees: lift the arm, swing it forward, open the claw.
        shades: 0 none; up to 1 the sunglasses come down from above onto its face (at 1 they are on, and hide the eyes).
        legs: {'FL': (dx, dy, dz), ...}: where each foot is, in metres from its rest spot on the ground (dz lifts it).
        The legs reach from the body to their feet whatever the body does on top of them (lean, bow, bob, twist).
        """
        rad = math.radians
        if at is not None:
            self.root.location.x, self.root.location.y = at
        if heading is not None:
            self.root.rotation_euler = (0, 0, rad(heading))
        self.root.location.z = hop
        self.hips.location.z = LEG[2] + height
        self.hips.rotation_euler = (rad(pitch), rad(lean), rad(turn))
        wide = 1 / math.sqrt(squash)
        self.body.scale = (wide, wide, squash)
        self.face.location = (gaze[0] * 0.45 * U, -BODY[1] / 2, BODY[2] / 2 + EYE_Z + gaze[1] * 0.4 * U)
        on = min(1.0, max(0.0, shades))
        drop = (1 - on) ** 2
        self.shades.scale = (1, 1, 1) if on > 0 else (0, 0, 0)
        self.shades.location = (0, -BODY[1] / 2 - 0.72 * U, BODY[2] / 2 + EYE_Z + 0.1 * U + drop * 5.5 * U)
        self.shades.rotation_euler = (rad(-14 * drop), 0, 0)
        for side, sx in (('L', -1), ('R', 1)):
            eye, smile = self.eyes[side], self.smiles[side]
            if on >= 0.97:
                eye.scale, smile.scale = (0, 0, 0), (0, 0, 0)                 # behind the lenses
            elif eyes == 'smile':
                eye.scale, smile.scale = (0, 0, 0), (1, 1, 1)
            else:
                ex, ez, tilt = EYES[eyes]
                eye.scale, smile.scale = (ex, 1, ez), (0, 0, 0)
                eye.rotation_euler = (0, rad(tilt * sx), 0)
            lift, forward, opening = arm_L if side == 'L' else arm_R
            self.arms[side].rotation_euler = (0, rad(-sx * lift), rad(-sx * forward))
            self.jaws[side, 'top'].rotation_euler = (0, rad(-sx * opening / 2), 0)
            self.jaws[side, 'bot'].rotation_euler = (0, rad(sx * opening / 2), 0)
        hips = Euler(self.hips.rotation_euler).to_matrix()
        for key, (x, y) in LEGS.items():
            dx, dy, dz = (legs or {}).get(key, (0, 0, 0))
            joint = Vector((x, y, 0.3 * U))                                               # in the hips' frame
            reach = Vector((x + dx, y + dy, dz)) - (Vector(self.hips.location) + hips @ joint)   # joint to foot, in the root's frame
            local = hips.inverted() @ reach
            self.legs[key].rotation_euler = Vector((0, 0, -1)).rotation_difference(local).to_euler()
            self.legs[key].scale = (1, 1, max(0.3, local.length / LEG[2]))
        return self

    def key(self, frame):
        """Keys every control at `frame`."""
        for obj in self.parts:
            for path in ('location', 'rotation_euler', 'scale'):
                obj.keyframe_insert(path, frame=frame)
        return self
