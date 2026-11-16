"""Scenes 2 to 5 of the film, "study" (bars 8 to 24, 0:16.5 to 0:49.7): the crab inside the game's data. Four shots:

  inside   bar 8   a wall of bytes from DeusEx.u, taller than it can see; it lands, looks around, is very small
  reading  bar 12  LightSwitch.Frob decoded, line by line on the kick; it tilts its head and reads
  qa       bar 16  Engine.dll's machine code and its Rust translation; a question and an answer on the piano, a check on each answer
  adds-up  bar 20  the validators turn green one after another; it runs through them, faster, into a burst of light

  node video/film/panels.mjs all                              the sheets first
  blender --background --factory-startup --python video/blender/scene_study.py -- --shot inside \
      [--size 1280x720] [--samples 48] [--frames 1-248] [--step 1] [--out DIR]

writes video/out/film/<shot>/f####.png (frame 1 is the shot's first frame: film time bar * score.bar; the shot's frame count is
round(t1 * 30) - round(t0 * 30)).
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage                                                          # noqa: E402
from crab import Crab, material                                       # noqa: E402
from props_study import (PANELS, clamp, curve, ease, feed_info, flash_plane, floor, gait, key, keyed_camera, mix, mix3, pulse,   # noqa: E402
                         sheet, validator_column, wrap)

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
arg = lambda name, default: ARGS[ARGS.index(name) + 1] if name in ARGS else default
SIZE = tuple(int(v) for v in arg('--size', '1280x720').split('x'))
SAMPLES = int(arg('--samples', '48'))
S = stage.score()
BAR, BEAT, STEP = S['bar'], S['beat'], S['step']
CYAN = (0.55, 0.78, 1.0)

MIDI = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def midi(name):
    """'G#4' -> 68."""
    note = MIDI[name[0]] + (1 if '#' in name else 0)
    return 12 * (int(name[-1]) + 1) + note


def f_of(t):
    """Shot-local time in seconds -> frame number (frame 1 is t = 0)."""
    return round(t * stage.FPS) + 1


class Ctx:
    """What a shot builder works with."""

    def __init__(self, bar, frames):
        self.bar, self.frames, self.t0 = bar, frames, bar * BAR
        self.scene = bpy.context.scene
        self.col = self.scene.collection
        self.crab = Crab()
        self.constant = []                                               # animated ids whose keys must hold their value until the next key

    def key_crab(self, pose, step=2):
        """Keys `pose(t) -> dict` (t = seconds into the shot) every `step` frames and on the last frame."""
        for f in range(1, self.frames + 1, step):
            self.crab.pose(**pose((f - 1) / stage.FPS)).key(f)
        if (self.frames - 1) % step:
            self.crab.pose(**pose((self.frames - 1) / stage.FPS)).key(self.frames)

    def finish_constant(self):
        for owner in self.constant:
            animation = owner.animation_data
            if not animation or not animation.action:
                continue
            for layer in animation.action.layers:
                for strip in layer.strips:
                    for bag in strip.channelbags:
                        for fc in bag.fcurves:
                            for k in fc.keyframe_points:
                                k.interpolation = 'CONSTANT'


def lamp(name, location, target, power, rect, color=CYAN, spot=None, size=0.5, glossy=False):
    """An area light (or a spot); it does not show as a hot spot in the glossy floor unless `glossy`."""
    obj = stage.light(name, location, target, power, size, color, spot=spot, rect=None if spot else rect)
    obj.visible_glossy = glossy
    return obj


def arpeggio_notes(first_bar, bars):
    """The arpeggio of the study section (score.mjs: ARP_WAVE over the chords), as (time, midi): one note a sixteenth."""
    wave = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 4, 3, 2, 1]
    chords = {'Am9': ['A4', 'C5', 'E5', 'B5'], 'Fmaj7': ['F4', 'A4', 'C5', 'E5'], 'Dm9': ['A4', 'C5', 'E5', 'F5'], 'Esus4': ['E4', 'A4', 'B4', 'E5'],
              'E': ['E4', 'G#4', 'B4', 'E5']}
    cycle = [['Am9'] * 16, ['Fmaj7'] * 16, ['Dm9'] * 16, ['Esus4'] * 8 + ['E'] * 8]
    notes = []
    for b in range(first_bar, first_bar + bars):
        for s in range(16):
            tones = chords[cycle[(b - 8) % 4][s]]
            k = wave[s]
            notes.append((b * BAR + s * STEP, midi(tones[k % 4]) + 12 * (k // 4), b, s))
    return notes


# ================================================================================================= shot 1: inside
TOWER_SHEET = (3.15, 6.3)                                              # one 2048 x 4096 sheet of the byte wall, in metres


def tower(ctx, letter, x, y, rot, strength=1.1, tint=(1, 1, 1), flip=False, controls=None):
    """Two sheets of DeusEx.u's bytes stacked (12.6 m), the file's start at the bottom."""
    for k in range(2):
        obj, c = sheet(f'tower_{letter}{k}_{x:.1f}', ctx.col, os.path.join(PANELS, 'bytes', f'{letter}{k}.png'), TOWER_SHEET,
                       (x, y, k * TOWER_SHEET[1]), rot_z=rot, anchor='bottom', strength=strength, tint=tint, band=True, falloff=9.0)
        if flip:
            obj.scale.x = -1
        if controls is not None:
            controls.append(c)


def build_inside(ctx):
    scene, col, crab = ctx.scene, ctx.col, ctx.crab
    towers = []
    # the back wall, bent a little around the landing; two more towers close in on either side; further ones fall into the dark
    for letter, x, y, rot, strength, tint, flip in (
            ('a', -1.7, 2.9, 5, 1.15, (1, 1, 1), False), ('b', 1.5, 3.0, -4, 1.05, (1, 1, 1), False),
            ('c', 4.7, 3.5, -16, 0.9, (0.9, 0.95, 1), False), ('d', -4.9, 3.4, 17, 0.9, (0.9, 0.95, 1), False),
            ('d', 7.2, 6.4, -30, 0.6, (0.7, 0.85, 1), True), ('c', -7.6, 6.8, 30, 0.6, (0.7, 0.85, 1), True),
            ('b', -1.0, 9.0, 0, 0.45, (0.6, 0.8, 1), True), ('a', 3.0, 9.4, -6, 0.45, (0.6, 0.8, 1), True)):
        tower(ctx, letter, x, y, rot, strength, tint, flip, towers)
    floor(col, color=(0.004, 0.007, 0.011, 1), roughness=0.26)
    # light: the wall is the lamp, the crab is lit from it and from a faint cold edge
    lamp('wall', (0.0, 2.2, 2.4), (0, 0, 0.3), 260, (6.0, 4.0), color=(0.62, 0.8, 1.0))
    lamp('fill', (-2.5, -4.0, 1.6), (0, 0, 0.3), 150, (3.0, 2.0), color=(0.95, 0.96, 1.0))
    lamp('rim', (1.4, 2.2, 1.8), (0, 0.5, 0.35), 400, None, color=(0.5, 0.75, 1.0), spot=25, size=0.15)

    # the crab: lands out of the white with the half-turn of its dive, looks around, looks up, is startled by the size of it, resolves
    gaze_x = [(0, 0), (1.0, 0), (1.4, 0.9), (2.0, 0.9), (2.5, -0.9), (3.1, -0.9), (3.6, 0), (6.4, 0), (6.9, 0.5), (7.6, 0)]
    gaze_y = [(0, 0.05), (3.8, 0.05), (4.3, 1.0), (5.7, 1.0), (6.2, 0.2), (7.0, 0.5)]
    body_turn = [(0, 0), (1.0, 0), (1.5, 10), (2.0, 10), (2.5, -12), (3.1, -12), (3.6, 0), (6.4, 0)]
    pitch = [(0, 0), (3.8, 0), (4.4, -9), (5.7, -9), (6.1, 2), (6.5, 0)]
    lean = [(0, 0), (6.3, 0), (6.9, 6), (7.8, 6)]
    claws = [(0, 0), (3.9, 0), (4.4, 22), (5.7, 22), (6.1, 6), (6.5, 0)]
    xpath = [(0, 0), (4.9, 0), (5.7, -0.34)]                 # two quick steps aside when it sees how big it is
    held = [(0, 'open')]

    def pose(t):
        land = 0.30
        if t < land:                                          # airborne from the dive, turning to land facing us
            k = t / land
            return dict(at=(0.0, mix(-0.32, 0.0, k)), heading=mix(180, 20, ease(k)), hop=0.32 * (1 - k * k), squash=1.14 - 0.14 * k, pitch=14 * (1 - k),
                        eyes='focus', gaze=(0, 0), arm_L=(25, 55, 34), arm_R=(25, 55, 34),
                        legs={'FL': (-0.03, 0.05, 0), 'FR': (0.03, 0.05, 0), 'BL': (-0.02, 0.08, 0), 'BR': (0.02, 0.08, 0)})
        u = t - land
        squash = 1.0
        if u < 0.14:
            squash = 1 - 0.2 * ease(u / 0.14)
        elif u < 0.7:
            squash = 0.8 + 0.2 * ease((u - 0.14) / 0.4) + 0.03 * math.sin((u - 0.14) * 16) * math.exp(-(u - 0.14) * 4)
        x = curve(t, xpath)
        dx = curve(t + 0.03, xpath) - curve(t - 0.03, xpath)
        legs, bob, roll = {}, 0.0, 0.0
        if abs(dx) > 1e-4:
            legs, bob, roll = gait(math.pi * abs(x - xpath[0][1]) / 0.06 if dx < 0 else math.pi * abs(x) / 0.06, -1 if dx < 0 else 1, 0.06)
        eyes = 'wide' if (0.45 < u < 1.2 or 4.3 < t < 5.7 or 6.1 < t < 6.5) else 'focus' if t > 7.3 else 'open'
        for blink in (3.75, 5.9, 7.7):
            if 0 <= t - blink < 0.14:
                eyes = 'blink'
        c = curve(t, claws)
        return dict(at=(x, 0.0), heading=20, squash=squash, height=-0.02 * (1 - ease(u / 0.5)) + bob, eyes=eyes, gaze=(curve(t, gaze_x), curve(t, gaze_y)),
                    turn=curve(t, body_turn), pitch=curve(t, pitch), lean=curve(t, lean) + roll * 0.0, legs=legs, arm_L=(0.5 * c, 0, c), arm_R=(0.5 * c, 0, c))

    ctx.key_crab(pose)

    def view(f):
        t = (f - 1) / stage.FPS
        k = ease(t / (4 * BAR))
        at = (mix(-1.9, -2.7, k), mix(-2.9, -6.6, k), mix(0.55, 1.15, k))
        to = (mix(0.0, 0.2, k), mix(0.4, 1.0, k), mix(0.8, 2.5, k))
        return {'at': at, 'to': to, 'lens': mix(32, 24, k), 'focus': (0, 0, 0.3)}

    cam = keyed_camera('cam', view, 1, ctx.frames, fstop=3.2)
    stage.cut(scene, 1, cam)
    veil = flash_plane(col, cam)
    for f in range(1, ctx.frames + 1, 2):
        t = (f - 1) / stage.FPS
        key(veil, f, 1.0 if t < 0.1 else 1 - ease((t - 0.1) / 0.5))
    # the wall's light follows the arpeggio: a band of extra light climbs and falls with the notes
    notes = arpeggio_notes(8, 4)
    for f in range(1, ctx.frames + 1):
        t = ctx.t0 + (f - 1) / stage.FPS
        here = [n for n in notes if n[0] <= t + 1e-6][-1:]
        z, amp = 1.0, 0.0
        if here:
            tn, m, b, s = here[0]
            z = 0.3 + (m - 60) * 0.26
            amp = (0.3 + 2.4 * (0.3 + 0.7 * (b - 8) / 15) * (0.5 if s % 4 else 1.0)) * math.exp(-(t - tn) / 0.16)
        gain = 0.3 + 0.7 * ease((t - ctx.t0) / 1.2)
        for c in towers:
            key(c['band_z'], f, z)
            key(c['band_amp'], f, amp)
            key(c['band_w'], f, 0.22)
            key(c['gain'], f, gain)
    for c in towers:
        ctx.constant.append(c['mat'].node_tree)
    return cam


# ================================================================================================= shot 2: reading
def backdrop(ctx, controls, strength=0.35):
    """The wall of bytes again, far and dim, behind a shot's real subject."""
    for letter, x, y, rot, flip in (('a', -3.4, 8.2, 8, False), ('b', 0.3, 8.8, -3, True), ('c', 4.0, 8.0, -14, False), ('d', -7.4, 7.4, 24, True), ('d', 7.9, 7.6, -26, True)):
        tower(ctx, letter, x, y, rot, strength, (0.75, 0.88, 1.0), flip, controls)


def key_sheet(controls, frames, value_at):
    for f in range(1, frames + 1):
        key(controls['gain'], f, value_at((f - 1) / stage.FPS))


def build_reading(ctx):
    scene, col, crab = ctx.scene, ctx.col, ctx.crab
    info = feed_info('bytecode')
    cues = info['cues']
    far = []
    backdrop(ctx, far, 0.4)
    floor(col, color=(0.004, 0.007, 0.011, 1), roughness=0.26)
    SHEET = (1.45, 1.9, 1.35)
    obj, sc = sheet('bytecode', col, os.path.join(PANELS, 'bytecode', 'f0001.png'), (4.0, 2.0), SHEET, rot_z=-24, frames=info['frames'], strength=2.0, diffuse=0.1)
    crab_at = (-0.75, 0.0)
    kicks = [b * BAR + h * BAR / 2 for b in range(4) for h in range(2)]                 # beats 1 and 3: the heartbeat
    glow = lamp('sheet_glow', (SHEET[0] - 0.6, SHEET[1] - 0.8, SHEET[2] - 0.1), (crab_at[0], crab_at[1], 0.4), 160, (3.2, 1.6), color=(0.62, 0.82, 1.0))
    lamp('fill', (-2.4, -3.2, 1.4), (crab_at[0], 0, 0.3), 70, (3.0, 2.0), color=(0.85, 0.92, 1.0))
    lamp('rim', (1.2, 2.6, 1.5), (crab_at[0], 0.2, 0.35), 380, None, color=(0.5, 0.75, 1.0), spot=25, size=0.15)

    def heartbeat(t):
        return max([pulse(t, k, 0.28) for k in kicks] or [0.0])

    for f in range(1, ctx.frames + 1):
        t = (f - 1) / stage.FPS
        hb = heartbeat(t)
        key(sc['gain'], f, 1.0 + 0.35 * hb)
        glow.data.energy = 160 * (1 + 0.5 * hb)
        glow.data.keyframe_insert('energy', frame=f)
        for c in far:
            key(c['gain'], f, 0.5 + 0.5 * ease(t / 1.5))
    ctx.constant.append(sc['mat'].node_tree)
    ctx.constant.append(glow.data)

    lines = cues['lines']                                                # when each line starts to arrive (title first)
    # where the eyes go: down the sheet as lines arrive (up-right of the crab), along each line as it is typed, then a second pass
    def gaze(t):
        n = sum(1 for x in lines if x <= t) - 1
        if t < lines[-1] + 0.5:
            n = max(0, n)
            typed = clamp((t - lines[n]) / 0.35)
            return (-0.2 + 0.9 * typed, 0.75 - 0.075 * n * 1.0)
        if t < cues['sweep'][0]:
            return (0.4, 0.1)
        row = clamp((t - cues['sweep'][0]) / cues['sweepStep'], 0, 9)
        within = row - math.floor(row)
        return (-0.2 + 0.9 * (within ** 0.5), 0.7 - 0.08 * row)

    def pose(t):
        hb = heartbeat(t)
        u = cues['understood']
        eyes = 'open'
        if 1.6 < t < 4.4 or 5.0 < t < u:
            eyes = 'focus'
        if u <= t < u + 0.35:
            eyes = 'wide'
        elif u + 0.35 <= t < u + 1.15:
            eyes = 'smile'
        elif t >= u + 1.15:
            eyes = 'focus' if t < u + 1.6 else 'open'
        for blink in (1.3, 4.9, 8.0):
            if 0 <= t - blink < 0.14:
                eyes = 'blink'
        hop = 0.0
        if t >= u:
            hop = 0.1 * math.sin(math.pi * clamp((t - u) / 0.45)) if t < u + 0.45 else 0.0
        squash = 1 - 0.035 * hb
        if u - 0.28 <= t < u:
            squash = 1 - 0.1 * ease((t - (u - 0.28)) / 0.28)                    # crouch before the hop
        elif u <= t < u + 0.45:
            squash = 1.07
        elif u + 0.45 <= t < u + 0.7:
            squash = 0.9 + 0.1 * ease((t - u - 0.45) / 0.25)
        lean = curve(t, [(0, 0), (1.9, 0), (2.6, 8), (5.2, 8), (5.8, 3), (u - 0.3, 3), (u + 0.5, -3), (u + 1.5, 0)])
        pitch = curve(t, [(0, 0), (5.2, 0), (5.6, 4), (u - 0.2, 4), (u + 0.3, -3), (u + 1.2, 0)])
        arm = curve(t, [(0, 0), (u - 0.1, 0), (u + 0.25, 70), (u + 0.9, 70), (u + 1.5, 4)])
        gx, gy = gaze(min(t, u - 0.01)) if t < u else mix3(gaze(u - 0.01) + (0,), (0.0, 0.1, 0), ease((t - u) / 0.6))[:2]
        return dict(at=crab_at, heading=30, squash=squash, hop=hop, height=-0.004 * hb, eyes=eyes, gaze=(gx, gy), lean=lean, pitch=pitch,
                    arm_L=(arm, 0, 10 + arm * 0.4), arm_R=(arm, 0, 10 + arm * 0.4), turn=-4 * hb)

    ctx.key_crab(pose, step=1)

    def view_a(f):
        t = (f - 1) / stage.FPS
        k = ease(t / (2 * BAR))
        return {'at': (mix(-1.9, -1.3, k), mix(-3.3, -2.9, k), mix(0.5, 0.65, k)), 'to': (mix(0.1, 0.2, k), 0.8, mix(0.75, 0.85, k)), 'lens': 30, 'focus': (crab_at[0], crab_at[1], 0.3)}

    def view_b(f):                                                       # its face, from the front: the sheet's light on it, the lines in its eyes
        t = (f - 1) / stage.FPS
        k = clamp((t - 2 * BAR) / BAR)
        return {'at': (mix(0.0, -0.2, k), mix(-2.05, -1.8, k), mix(0.42, 0.45, k)), 'to': (mix(-0.75, -0.74, k), 0.0, mix(0.36, 0.38, k)), 'lens': 42, 'focus': (crab_at[0], crab_at[1] - 0.17, 0.4)}

    def view_c(f):                                                       # back out: the crab and the whole sheet for the last sweep and the hop
        t = (f - 1) / stage.FPS
        k = clamp((t - 3 * BAR) / BAR)
        return {'at': (mix(-1.5, -1.2, k), mix(-2.9, -2.6, k), mix(0.5, 0.6, k)), 'to': (mix(0.15, 0.25, k), 0.8, mix(0.8, 0.85, k)), 'lens': 32, 'focus': (crab_at[0], crab_at[1], 0.3)}

    cam_a = keyed_camera('cam_a', view_a, 1, f_of(2 * BAR) - 1, fstop=3.2)
    cam_b = keyed_camera('cam_b', view_b, f_of(2 * BAR), f_of(3 * BAR) - 1, fstop=2.4)
    cam_c = keyed_camera('cam_c', view_c, f_of(3 * BAR), ctx.frames, fstop=3.2)
    stage.cut(scene, 1, cam_a)
    stage.cut(scene, f_of(2 * BAR), cam_b)
    stage.cut(scene, f_of(3 * BAR), cam_c)


# ================================================================================================= shot 3: question and answer
def build_qa(ctx):
    scene, col, crab = ctx.scene, ctx.col, ctx.crab
    info = feed_info('qa')
    cues = info['cues']
    qs, ans = cues['questions'], cues['answers']
    far = []
    backdrop(ctx, far, 0.4)
    floor(col, color=(0.004, 0.007, 0.011, 1), roughness=0.26)
    L, R = (-2.15, 1.0, 1.35), (2.15, 1.0, 1.35)
    ol, cl = sheet('code', col, os.path.join(PANELS, 'qa', 'left', 'f0001.png'), (3.0, 3.0), L, rot_z=24, frames=info['frames'], strength=1.6)
    orr, cr = sheet('rust', col, os.path.join(PANELS, 'qa', 'right', 'f0001.png'), (3.0, 3.0), R, rot_z=-24, frames=info['frames'], strength=1.6)
    crab_at = (0.0, -1.1)
    lamp_l = lamp('glow_l', (L[0] + 0.9, L[1] - 1.0, L[2]), (0, crab_at[1], 0.4), 90, (2.8, 2.8), color=(0.62, 0.82, 1.0))
    lamp_r = lamp('glow_r', (R[0] - 0.9, R[1] - 1.0, R[2]), (0, crab_at[1], 0.4), 90, (2.8, 2.8), color=(0.62, 0.82, 1.0))
    lamp('fill', (0.0, -3.4, 1.6), (0, crab_at[1], 0.3), 70, (3.0, 2.0), color=(0.85, 0.92, 1.0))
    lamp('rim', (0.0, 2.4, 2.0), (0, 0.0, 0.35), 380, None, color=(0.5, 0.75, 1.0), spot=30, size=0.15)
    checks = [a[3] for a in ans]

    def phase(t):
        """-1 while the question is asked (looking left), +1 while it is answered (right), eased across the bar line."""
        return curve(t, [(0, -1), (BAR - 0.25, -1), (BAR + 0.1, 1), (2 * BAR - 0.25, 1), (2 * BAR + 0.1, -1), (3 * BAR - 0.25, -1), (3 * BAR + 0.1, 1)])

    for f in range(1, ctx.frames + 1):
        t = (f - 1) / stage.FPS
        flash = max([pulse(t, c, 0.45) for c in checks] or [0.0])
        side = phase(t)
        key(cr['gain'], f, (0.55 + 0.45 * ease((side + 1) / 2)) * (1.0 + 0.7 * flash))
        key(cl['gain'], f, 0.55 + 0.45 * ease((1 - side) / 2))
        for lp, base in ((lamp_l, 0.55 + 0.45 * ease((1 - side) / 2)), (lamp_r, 0.55 + 0.45 * ease((side + 1) / 2))):
            lp.data.energy = 90 * base + (170 * flash if lp is lamp_r else 0)
            lp.data.keyframe_insert('energy', frame=f)
        lamp_r.data.color = mix3((0.62, 0.82, 1.0), (0.45, 1.0, 0.75), min(1.0, flash * 1.2))
        lamp_r.data.keyframe_insert('color', frame=f)
        for c in far:
            key(c['gain'], f, 0.5 + 0.5 * ease(t / 1.5))
    ctx.constant += [cr['mat'].node_tree, cl['mat'].node_tree, lamp_r.data, lamp_l.data]

    def pose(t):
        side = phase(t)
        pitch = lean = hop = 0.0
        eyes = 'open'
        squash = 1.0
        arm = 0.0
        for k, (q, a) in enumerate(zip(qs, ans)):
            if q[0] - 0.05 <= t < a[0] - 0.3:                              # a rising question: the head tilts up a little with each note
                n = sum(1 for x in q[:3] if x <= t)
                lean = -(3 + 2.4 * n) * (1 if t < q[3] else 1) * ease((t - q[0] + 0.05) / 0.2) if t < q[3] + 0.6 else lean
                lean = -(3 + 2.4 * n) if t < q[3] + 0.9 else -4
                pitch = -3 - 1.5 * n
                eyes = 'wide' if t >= q[3] else 'focus'
            if a[0] - 0.05 <= t < a[3] + 1.4:                              # the answer comes down in three nods; the last note resolves it
                n = sum(1 for x in a[:3] if x <= t)
                if t < a[3]:
                    pitch = 3.5 * (n > 0) * (0.5 + 0.5 * math.sin((t - a[max(0, n - 1)]) * 18 + 1.0))
                    eyes = 'focus'
                else:
                    u = t - a[3]
                    hop = 0.12 * math.sin(math.pi * clamp(u / 0.4)) if u < 0.4 else 0.0
                    squash = 0.9 + 0.1 * ease(u / 0.12) + (0.08 * math.sin(math.pi * clamp(u / 0.4)) if u < 0.4 else 0.0) if u < 0.4 else 1.0
                    eyes = 'smile' if u < 1.0 else 'open'
                    arm = 80 * ease(u / 0.2) * (1 - ease((u - 0.5) / 0.7))
        gx = 0.9 * side * (1 if side < 0 else 1)
        gy = 0.5 if (side < 0) else 0.2
        for blink in (1.7, 3.8, 5.9, 7.9):
            if 0 <= t - blink < 0.14:
                eyes = 'blink'
        return dict(at=crab_at, heading=34 * side, squash=squash, hop=hop, eyes=eyes, gaze=(gx, gy), lean=lean, pitch=pitch,
                    arm_L=(arm * (1 if side > 0 else 0.4), 0, 10 + arm * 0.5), arm_R=(arm, 0, 10 + arm * 0.5), turn=0)

    ctx.key_crab(pose, step=1)

    def view(f):
        t = (f - 1) / stage.FPS
        cx = curve(t, [(0, -0.8), (BAR - 0.3, -0.8), (BAR + 0.45, 0.8), (2 * BAR - 0.3, 0.8), (2 * BAR + 0.45, -0.8), (3 * BAR - 0.3, -0.8), (3 * BAR + 0.45, 0.7), (4 * BAR, 0.0)])
        push = ease(t / (4 * BAR))
        return {'at': (cx, mix(-4.4, -3.9, push), mix(0.72, 0.68, push)), 'to': (cx * 1.4, 1.0, mix(0.98, 0.9, push)), 'lens': mix(26, 28, push), 'focus': (crab_at[0], crab_at[1], 0.3)}

    cam = keyed_camera('cam', view, 1, ctx.frames, fstop=3.5)
    stage.cut(scene, 1, cam)


# ================================================================================================= shot 4: it adds up
WALL_X0, COL_W, COL_H, ROWS = -2.0, 2.24, 3.84, 40


def build_adds_up(ctx):
    scene, col, crab = ctx.scene, ctx.col, ctx.crab
    info = feed_info('validators')
    count_total, columns = info['count'], info['columns']
    floor(col, color=(0.004, 0.007, 0.011, 1), roughness=0.36, specular=0.3)
    cols = []
    for k in range(columns):
        obj, c = validator_column(f'validators_{k}', col, os.path.join(PANELS, 'validators', info['files'][k]), k, ROWS,
                                  (WALL_X0 + COL_W * (k + 0.5), 1.4, 0.0), (COL_W, COL_H))
        cols.append(c)
    # a faint backdrop of the byte wall behind it, so the dark is not empty
    far = []
    for letter, x, flip in (('a', 4.0, False), ('b', 10.5, True), ('c', 17.0, False), ('d', 24.0, True), ('a', 30.5, True), ('b', 37.0, False), ('c', 43.0, True)):
        tower(ctx, letter, x, 9.5, 0, 0.3, (0.7, 0.85, 1.0), flip, far)

    # the run: speed in m/s through the shot, integrated to a distance; the wall's count is the lit front, which stays ahead of the crab
    speed = [(0, 0.9), (1.5, 1.3), (4.14, 3.8), (6.2, 6.6), (7.24, 8.4), (8.27, 8.8)]
    lead = [(0, 1.8), (4.14, 2.6), (8.27, 5.2)]
    dt, xs, x = 1 / 600, [], 1.0
    for i in range(int(8.3 / dt) + 1):
        xs.append(x)
        x += curve(i * dt, speed) * dt
    X = lambda t: xs[min(len(xs) - 1, int(t / dt))]
    COUNT = lambda t: clamp(ROWS * (X(t) + lead_at(t) - WALL_X0) / COL_W, 0, count_total + 16)
    lead_at = lambda t: curve(t, lead)
    print('adds-up: crab x at the end %.1f m, count at the end %.0f of %d, wall ends at %.1f m' % (X(8.27), COUNT(8.27), count_total, WALL_X0 + COL_W * columns))

    runlight = lamp('runlight', (0, 0.9, 2.2), (0, 0, 0.3), 350, (3.0, 2.0), color=(0.5, 0.95, 0.8))
    fillight = lamp('fill', (0, -3.0, 1.5), (0, 0, 0.3), 90, (3.0, 2.0), color=(0.85, 0.95, 1.0))
    rimlight = lamp('rim', (0, 2.2, 1.6), (0, 0.0, 0.35), 450, None, color=(0.5, 0.85, 1.0), spot=30, size=0.15)
    for f in range(1, ctx.frames + 1, 2):
        t = (f - 1) / stage.FPS
        cx = X(t)
        for lp, off in ((runlight, (0.6, 0.9 - 0.0, 2.2)), (fillight, (-0.8, -3.0, 1.5)), (rimlight, (1.4, 2.2, 1.6))):
            lp.location = (cx + off[0], off[1], off[2])
            lp.keyframe_insert('location', frame=f)

    phase = 0.0
    phases = {}
    for f in range(1, ctx.frames + 1):
        t = (f - 1) / stage.FPS
        v = curve(t, speed)
        phases[f] = phase
        phase += 2 * math.pi * clamp(1.6 + 0.45 * v, 3.0, 5.2) / stage.FPS

    def pose(t):
        f = f_of(t)
        v = curve(t, speed)
        freq = clamp(1.6 + 0.45 * v, 3.0, 5.2)
        stride = min(0.2, v / (2 * freq))
        legs, bob, roll = gait(phases[f], 1, stride)
        run = clamp((v - 4.5) / 3.5)
        hop = 0.05 * run * (0.5 + 0.5 * math.sin(2 * phases[f] - math.pi / 2))
        eyes = 'open' if t < 0.8 else 'focus'
        if t > 7.24:
            eyes = 'wide'
        if t > 7.8:
            hop = 0.45 * math.sin(math.pi * clamp((t - 7.8) / 0.95))
            eyes = 'smile'
        arm = 8 + 25 * run + (50 if t > 7.8 else 0)
        for blink in (0.9, 2.6):
            if 0 <= t - blink < 0.12:
                eyes = 'blink'
        return dict(at=(X(t), 0.0), heading=0, squash=1.0 + 0.04 * run * math.sin(2 * phases[f]), hop=hop, height=bob, eyes=eyes, gaze=(0.8, 0.1), legs=legs, lean=9 * run + roll * 0.4,
                    pitch=-3 * run, arm_L=(arm, 0, 10), arm_R=(arm, 0, 10), turn=-6 * run)

    ctx.key_crab(pose, step=1)

    def view_a(f):                                                       # alongside, close: the names legible while it is slow
        t = (f - 1) / stage.FPS
        x = X(t)
        k = ease(t / (2 * BAR))
        return {'at': (x + mix(1.0, 1.6, k), mix(-3.4, -3.9, k), mix(0.55, 0.62, k)), 'to': (x + mix(1.2, 2.0, k), 1.4, mix(0.9, 1.0, k)), 'lens': 28, 'focus': (x, 0.0, 0.3)}

    def view_b(f):                                                       # ahead of it, low, looking back as it runs at us; in at the end
        t = (f - 1) / stage.FPS
        x = X(t)
        close = ease((t - 6.9) / 1.35)
        return {'at': (x + mix(2.4, 1.2, close), mix(-2.3, -1.7, close), mix(0.38, 0.32, close)), 'to': (x, 0.0, mix(0.36, 0.42, close)), 'lens': mix(26, 32, close), 'focus': (x, 0.0, 0.3)}

    cut = f_of(2 * BAR)
    cam_a = keyed_camera('cam_a', view_a, 1, cut - 1, step=1, fstop=8.0)
    cam_b = keyed_camera('cam_b', view_b, cut, ctx.frames, step=1, fstop=4.5)
    stage.cut(scene, 1, cam_a)
    stage.cut(scene, cut, cam_b)

    # the count, the wall's light and the burst on the cymbal's peak at the last frame
    for f in range(1, ctx.frames + 1):
        t = (f - 1) / stage.FPS
        burst = clamp((t - 7.3) / 0.967)
        for c in cols:
            key(c['count'], f, COUNT(t) if t < 7.9 else count_total + 16)
            key(c['gain'], f, 1.0 + 1.0 * burst * burst)
        for c in far:
            key(c['gain'], f, 0.5 + 0.6 * burst)
        runlight.data.energy = 350 + 500 * burst * burst
        runlight.data.keyframe_insert('energy', frame=f)
    veil = flash_plane(col, cam_b)
    for f in range(1, ctx.frames + 1):
        t = (f - 1) / stage.FPS
        key(veil, f, clamp((t - 7.0) / 1.267) ** 4.2)
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.45
    ctx.constant += [c['mat'].node_tree for c in cols] + [c['mat'].node_tree for c in far] + [runlight.data]


SHOTS = {
    'inside': dict(bar=8, frames=248, build=build_inside),
    'reading': dict(bar=12, frames=248, build=build_reading),
    'qa': dict(bar=16, frames=248, build=build_qa),
    'adds-up': dict(bar=20, frames=249, build=build_adds_up),
}


def main():
    name = arg('--shot', 'inside')
    shot = SHOTS[name]
    stage.reset()
    scene = bpy.context.scene
    last = shot['frames']
    scene.frame_start, scene.frame_end = 1, last
    stage.cycles(scene, SAMPLES, SIZE)
    stage.world(scene, (0.0015, 0.003, 0.006))
    ctx = Ctx(shot['bar'], last)
    shot['build'](ctx)
    ctx.finish_constant()
    dest = arg('--out', os.path.join(stage.OUT, 'film', name))
    os.makedirs(dest, exist_ok=True)
    first, final = (int(v) for v in arg('--frames', f'1-{last}').split('-'))
    scene.frame_start, scene.frame_end, scene.frame_step = first, final, int(arg('--step', '1'))
    scene.render.filepath = os.path.join(dest, 'f')
    if '--save' in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(dest, f'{name}.blend'))
    bpy.ops.render.render(animation=True)


main()
