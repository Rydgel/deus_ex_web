"""The crab's performances in the game shots: for each, a function of the shot's time t (seconds) giving where it is in
the map (`uu`: Unreal x, y), which way it faces (`yaw`: Unreal degrees) and its pose (the keyword arguments of Crab.pose).
`walk`: (direction (x, y) in the map, phase in cycles, stride in Unreal units) makes game_shot.py step its feet that way.
`cue` holds the shot's own cue times (seconds from its first frame): cursor blips, theme notes, kicks, snares.
"""
import math


def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def span(t, a, b):
    """0 before a, 1 after b, eased between."""
    return ease((t - a) / (b - a))


def pulse(t, at, length):
    """A bump from 0 to 1 and back, starting at `at`."""
    return math.sin(math.pi * (t - at) / length) if at <= t < at + length else 0.0


def breathing(t, rate=0.3):
    return 1 + 0.012 * math.sin(2 * math.pi * rate * t)


def blinking(t, times, eyes='open'):
    return 'blink' if any(0 <= t - b < 0.12 for b in times) else eyes


def mix(a, b, k):
    return tuple(x + (y - x) * k for x, y in zip(a, b))


def scuttle(t, t0, t1, a, b, cycle=0.34):
    """Walking from a to b between t0 and t1 (eased at both ends): -> (position, walk) for the pose."""
    k = span(t, t0, t1)
    direction = (b[0] - a[0], b[1] - a[1])
    length = math.hypot(*direction) or 1.0
    moving = t0 < t < t1
    speed = length / (t1 - t0)                                  # Unreal units a second, on average
    return mix(a, b, k), ((direction[0] / length, direction[1] / length), (t - t0) / cycle, speed * cycle * 0.5) if moving else None


# ------------------------------------------------------------------------------------------------ denton: the dock
SPOT = (-4705, 10386)            # where it stands when JC appears
JC_AT = (-4550, 10431)


def dock(t, T, cue):
    """Alone, looking back at the water. Something behind it: it turns, and looks up."""
    hears, turned = 2.25, 3.05
    k = span(t, hears + 0.25, turned)
    pose = dict(uu=SPOT, yaw=215 + (15.5 - 215 + 360) * k, squash=breathing(t), gaze=(0.15 * (1 - k), 0.2 + 0.7 * span(t, turned, turned + 0.5)),
                eyes=blinking(t, cue['cursor'][:1] + [1.6]), pitch=-9 * span(t, turned, turned + 0.6))
    if hears <= t < turned + 0.25:
        pose['eyes'] = 'wide'
        pose['height'] = 0.014 * pulse(t, hears, 0.3)
    return pose


def jc_a(t, T, cue):
    """From behind, low: it looks up at him, very still. One small step closer."""
    step = span(t, 1.9, 2.5)
    at = (SPOT[0] + 9 * step, SPOT[1] + 2.5 * step)
    pose = dict(uu=at, yaw=15.5, squash=breathing(t), gaze=(0, 0.9), pitch=-9, arm_R=(10 + 14 * span(t, 3.0, 3.8), 0, 8))
    if 1.9 < t < 2.5:
        pose['walk'] = ((0.97, 0.26), (t - 1.9) / 0.3, 4.5)
    return pose


LINE = 2.45                      # seconds into the shot: JC says "Maybe you should try getting a job." (film/storyboard.mjs VOICE)


def jc_b(t, T, cue):
    """Over his shoulder: it looks up, raises a claw, beams. JC speaks. The smile goes, the claw comes down."""
    at = (SPOT[0] + 9, SPOT[1] + 2.5)
    wave = span(t, 0.6, 1.25) - span(t, LINE + 0.7, LINE + 1.45)
    eyes = blinking(t, [0.35])
    if 1.3 < t < LINE + 0.45:
        eyes = 'smile'
    elif t >= LINE + 0.45:
        eyes = 'blink' if LINE + 0.95 <= t < LINE + 1.07 else ('sleepy' if t > LINE + 1.07 else 'open')     # it sinks in
    return dict(uu=at, yaw=15.5, squash=breathing(t) * (1 - 0.05 * pulse(t, 1.2, 0.22)) * (1 - 0.035 * span(t, LINE + 0.9, LINE + 1.4)), gaze=(0, 0.9),
                pitch=-10 + 4 * span(t, LINE + 0.9, LINE + 1.5), eyes=eyes, arm_R=(52 * wave, 14 * wave, 26 * wave), hop=0.045 * pulse(t, 1.32, 0.3),
                lean=-3 * span(t, LINE + 1.0, LINE + 1.5))


def turn(t, T, cue):
    """Seen from the front, beside JC. It takes his advice in. Then sunglasses like his come down onto its face."""
    on = span(t, 1.9, 2.5)
    landed = t >= 2.5
    grow = span(t, 2.6, T - 0.3)
    return dict(uu=(-4566, 10393), yaw=9.3, squash=breathing(t) * (1 - 0.07 * pulse(t, 2.5, 0.22)) * (1 - 0.1 * span(t, T - 0.3, T)),
                gaze=(-0.8 * (1 - span(t, 1.1, 1.6)), 0.8 * (1 - span(t, 1.1, 1.6)) + 0.1), eyes='sleepy' if t < 1.2 else 'focus', shades=on,
                pitch=3.5 * pulse(t, 2.5, 0.3) - 4 * grow, height=0.016 * grow - 0.02 * span(t, T - 0.3, T),
                arm_L=(8 * grow, 26 * span(t, 2.7, 3.3), 6), arm_R=(8 * grow, 26 * span(t, 2.7, 3.3), 6), lean=-3 * grow if landed else 0.0)


# ------------------------------------------------------------------------------- places seen from the engine's camera
def place(cue, ahead, right):
    """A point on the floor `ahead` of the engine's camera and `right` of its axis (Unreal units)."""
    cam = cue['camera']
    a = math.radians(cam['yaw'])
    return (cam['position'][0] + ahead * math.cos(a) - right * math.sin(a), cam['position'][1] + ahead * math.sin(a) + right * math.cos(a))


def facing_camera(cue):
    return cue['camera']['yaw'] + 180


def _run(t, t0, t1, a, b, pose, cycle=0.3):
    at, walk = scuttle(t, t0, t1, a, b, cycle)
    if walk:
        pose['walk'] = walk
    return at


def cross(t, T, cue, sign=1, ahead=150):
    """Scuttles across the picture, stops in the middle to look at us, and goes on."""
    wide = ahead * 0.78 + 46
    left, mid, right = place(cue, ahead, -wide * sign), place(cue, ahead, -8 * sign), place(cue, ahead, (wide + 5) * sign)
    stop, go = T * 0.4, T * 0.62
    pose = dict(yaw=facing_camera(cue), squash=breathing(t, 0.5), eyes=blinking(t, [stop + 0.25]), gaze=(0.6 * sign if t < stop or t > go else 0.0, 0.1))
    pose['uu'] = _run(t, 0.1, stop, left, mid, pose) if t < go else _run(t, go, T - 0.05, mid, right, pose)
    if stop <= t < go:
        pose['arm_R'] = (44 * pulse(t, stop + 0.1, go - stop - 0.15), 12, 30 * pulse(t, stop + 0.1, go - stop - 0.15))
        pose['lean'] = -4 * pulse(t, stop, go - stop)
    return pose


def cross_back(t, T, cue):
    return cross(t, T, cue, sign=-1, ahead=104)      # near us: in front of the people who pass


def skid(t, T, cue):
    """Runs in, brakes too late on the polished floor, slides, and is pleased with itself."""
    a, b, c = place(cue, 170, -175), place(cue, 170, 10), place(cue, 170, 62)
    brake, rest = T * 0.36, T * 0.6
    pose = dict(yaw=facing_camera(cue), squash=breathing(t, 0.5), gaze=(0.5, 0.0), eyes='open')
    if t < brake:
        pose['uu'] = _run(t, 0.05, brake, a, b, pose, cycle=0.24)
    else:
        k = 1 - (1 - min(1.0, (t - brake) / (rest - brake))) ** 2                     # the slide dies away
        pose['uu'] = mix(b, c, k)
        sliding = t < rest
        pose.update(lean=-13 * (1 - k) if sliding else 0.0, eyes='wide' if sliding else ('smile' if t > rest + 0.35 else 'open'), gaze=(0.0, 0.1),
                    arm_L=(30 * (1 - k), 0, 30 * (1 - k)), arm_R=(30 * (1 - k), 0, 30 * (1 - k)), hop=0.04 * pulse(t, rest + 0.4, 0.3))
    return pose


def approach(t, T, cue):
    """Comes up the alley toward us, looking at everything, and stops."""
    far, near = place(cue, 430, 30), place(cue, 150, -20)
    stop = T * 0.72
    pose = dict(yaw=facing_camera(cue), squash=breathing(t, 0.5), gaze=(0.8 * math.sin(2.6 * t), 0.5 + 0.3 * math.sin(1.9 * t)), eyes=blinking(t, [1.4, 2.9]))
    pose['uu'] = _run(t, 0.0, stop, far, near, pose, cycle=0.3)
    if t >= stop:
        pose.update(gaze=(0.0, 0.7), eyes='wide', pitch=-8 * span(t, stop, stop + 0.4))
    return pose


def arrive(t, T, cue):
    """Runs in from the right, stops short, stares."""
    a, b = place(cue, 150, 175), place(cue, 150, 35)
    stop = T * 0.55
    pose = dict(yaw=facing_camera(cue), squash=breathing(t, 0.5), gaze=(-0.5, 0.1), eyes='open')
    pose['uu'] = _run(t, 0.0, stop, a, b, pose, cycle=0.24)
    if t >= stop:
        pose.update(gaze=(0.0, 0.6), eyes='wide', hop=0.05 * pulse(t, stop + 0.15, 0.3))
    return pose


def gaze_up(t, T, cue):
    """Stands small under something big, looking up, both claws lifting."""
    lift = span(t, 0.3, 1.2)
    return dict(uu=place(cue, 140, -62), yaw=cue['camera']['yaw'] + 25, squash=breathing(t, 0.5), gaze=(0.2, 1.0), pitch=-13, eyes=blinking(t, [1.5], 'wide'),
                arm_L=(40 * lift, 0, 24 * lift), arm_R=(40 * lift, 0, 24 * lift))


# ---------------------------------------------------------------------------------------------- light: the island
def first_light(t, T, cue):
    """In the dark it looks about. The world draws itself; it turns to watch the city appear, then back to us, delighted."""
    spot = place(cue, 150, -22)
    away = span(t, 1.3, 2.3) - span(t, 5.3, 6.1)                                      # turned to the city, and back
    pose = dict(uu=spot, yaw=facing_camera(cue) + 180 * away, squash=breathing(t), gaze=(0.9 * math.sin(3.2 * t) * (1 - span(t, 0.9, 1.3)), 0.3 + 0.5 * away),
                eyes='wide' if 0.9 < t < 5.3 else blinking(t, [0.5]), pitch=-7 * away)
    if t > 6.1:
        pose.update(eyes='smile', hop=0.07 * pulse(t, 6.2, 0.36) + 0.05 * pulse(t, 6.75, 0.32), arm_L=(46, 0, 30), arm_R=(46, 0, 30), squash=1 + 0.06 * pulse(t, 6.2, 0.36))
    return pose


def statue(t, T, cue):
    """Walks to the rail, turns to the statue far across the water, and looks up. On the horns' high note, both claws."""
    a, b = place(cue, 285, -275), place(cue, 285, -70)
    stop, high = 2.9, 4.14
    pose = dict(squash=breathing(t), eyes='open', gaze=(0.6, 0.2))
    pose['uu'] = _run(t, 0.2, stop, a, b, pose, cycle=0.32)
    turned = span(t, stop, stop + 0.7)
    pose['yaw'] = facing_camera(cue) + 180 * turned
    if t >= stop:
        up = span(t, high, high + 0.6)
        pose.update(gaze=(0.0, 0.5 + 0.5 * turned), pitch=-13 * turned, eyes=blinking(t, [stop + 1.0, 6.4], 'wide'), arm_L=(62 * up, 0, 30 * up), arm_R=(62 * up, 0, 30 * up),
                    height=0.016 * up - 0.03 * span(t, T - 0.35, T), squash=breathing(t) * (1 - 0.12 * span(t, T - 0.35, T)))
    return pose


# ----------------------------------------------------------------------------------------------- the game, running
def it_runs(t, T, cue):
    """Leads the way through a place full of people, weaving, hopping on the snare."""
    weave = 46 * math.sin(2 * math.pi * t / 2.6)
    pose = dict(uu=place(cue, 150, weave - 10), yaw=cue['camera']['yaw'] + 180 * (span(t, 3.0, 3.5) - span(t, 4.9, 5.4)), squash=breathing(t, 0.6),
                gaze=(0.5 * math.sin(2 * math.pi * t / 1.7), 0.3), eyes='smile' if 3.3 < t < 5.0 else blinking(t, [1.1, 6.3]))
    a = math.radians(cue['camera']['yaw'])
    pose['walk'] = ((math.cos(a), math.sin(a)), t / 0.3, 9.0)
    pose['hop'] = sum(0.045 * pulse(t, s, 0.24) for s in cue['snare'])
    if 3.3 < t < 5.0:
        pose['arm_R'] = (60 + 16 * math.sin(2 * math.pi * t / 0.42), 14, 30)
    return pose


def together(t, T, cue):
    """Beside JC, a little ahead, in its sunglasses, keeping up with his stride and looking up at him."""
    x = -4680 + (-4150 + 4680) * t / 8.3
    glance = pulse(t, 2.2, 1.5) + pulse(t, 5.6, 1.6)
    pose = dict(uu=(x + 30, 10431 + 52), yaw=cue['camera']['yaw'] + 180 - 18, squash=breathing(t, 0.6), gaze=(-0.75 * glance, 0.25 + 0.6 * glance),
                eyes='smile' if glance > 0.35 else blinking(t, [1.2, 4.6, 7.4]), hop=0.02 * abs(math.sin(2 * math.pi * t / 0.62)), shades=1.0)
    pose['walk'] = ((1.0, 0.0), t / 0.31, 9.6)
    return pose
