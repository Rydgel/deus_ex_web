"""Generate AttachDecal/DetachDecal reference cases on a map with the
original-code oracle (scripts/native-decal-oracle.py), for
scripts/validate-decal-attach.mjs.

  python scripts/native-decal-cases.py <game root> <model.json> [--compare]

The model JSON comes from scripts/decal-model-export.mjs. Prints the oracle
request (inputs only) and the results at control word 0x037f as JSON; with
--compare, also which scenarios differ at 0x027f and 0x007f.
Inputs come from the map: floor hits under pawns (Shadow), surfaces near
polygon edges found with the original UModel::LineCheck (blood, scorch, bullet
holes). Rotators come from the hit normal by FVector::Rotation's formula
(trunc(atan2 * 32768/pi)); they are inputs, not claims about Rotation itself.
"""
import importlib.util
import json
import math
import random
import struct
from pathlib import Path

import sys
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('decal', ROOT / 'scripts/native-decal-oracle.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
GAME = sys.argv[1]
EXPORT = Path(sys.argv[2])
COMPARE = '--compare' in sys.argv
data = json.loads(EXPORT.read_text())
model = data['model']
oracle = d.Attach(GAME)
oracle.run_scenario({'ops': []}, model)  # load the model for LineCheck probes
rng = random.Random(0x0dec41)
f = lambda b: struct.unpack('<f', struct.pack('<I', b))[0]
bits = d.f32bits
fr = lambda v: f(bits(v))

TEX = {'Shadow': {'name': 'DeusExItems.Skins.FlatFXTex40', 'USize': 32},
       'BloodPool': {'name': 'DeusExItems.Skins.FlatFXTex1', 'USize': 64},
       'ScorchMark': {'name': 'DeusExItems.Skins.FlatFXTex38', 'USize': 32},
       'ScorchMark39': {'name': 'DeusExItems.Skins.FlatFXTex39', 'USize': 32},
       'BulletHole': {'name': 'DeusExItems.Skins.FlatFXTex9', 'USize': 32},
       'BloodSplat': {'name': 'DeusExItems.Skins.FlatFXTex2', 'USize': 32}}


def msvc_rand(seed, n):
    out = []
    for _ in range(n):
        seed = (seed * 214013 + 2531011) & 0xffffffff
        out.append((seed >> 16) & 0x7fff)
    return out


def rotator(normal):
    x, y, z = normal
    k = 32768 / math.pi
    return [int(math.atan2(z, math.sqrt(x * x + y * y)) * k), int(math.atan2(y, x) * k), 0]


def pts(i):
    return [f(b) for b in model['pointBits'][i]]


def vec(i):
    return [f(b) for b in model['vectorBits'][i]]


def node_polygon(n):
    node = model['nodes'][n]
    return [pts(model['verts'][node['vertexPool'] + k][0]) for k in range(node['vertexCount'])]


def trace(start, end):
    return oracle.line_check([bits(v) for v in start], [bits(v) for v in end])


def edge_hit(kind, max_offset=14.0, nodes=None):
    """A LineCheck hit on a floor ('floor') or wall ('wall') polygon near one
    of its edges: HitLocation bits, HitNormal (floats), hit node. `nodes`
    restricts the polygon to a candidate list ('any' kind)."""
    while True:
        n = rng.choice(nodes) if nodes else rng.randrange(len(model['nodes']))
        node = model['nodes'][n]
        if node['vertexCount'] < 3:
            continue
        surf = model['surfs'][node['surface']]
        normal = vec(surf['normal'])
        if kind == 'floor' and normal[2] < 0.9:
            continue
        if kind == 'wall' and abs(normal[2]) > 0.2:
            continue
        poly = node_polygon(n)
        i = rng.randrange(len(poly))
        a, b = poly[i], poly[(i + 1) % len(poly)]
        e = [b[k] - a[k] for k in range(3)]
        length = math.sqrt(sum(c * c for c in e))
        if length < 24:
            continue
        perp = [normal[1] * e[2] - normal[2] * e[1], normal[2] * e[0] - normal[0] * e[2], normal[0] * e[1] - normal[1] * e[0]]
        pl = math.sqrt(sum(c * c for c in perp)) or 1
        centroid = [sum(p[k] for p in poly) / len(poly) for k in range(3)]
        u = rng.uniform(0.2, 0.8)
        point = [a[k] + e[k] * u for k in range(3)]
        sign = 1 if sum((centroid[k] - point[k]) * perp[k] for k in range(3)) > 0 else -1
        off = rng.uniform(-max_offset * 0.3, max_offset)
        point = [point[k] + sign * perp[k] / pl * off for k in range(3)]
        start = [point[k] + normal[k] * 24 for k in range(3)]
        end = [point[k] - normal[k] * 24 for k in range(3)]
        hit = trace(start, end)
        if not hit:
            continue
        hn = [f(b) for b in hit['normalBits']]
        if sum(hn[k] * normal[k] for k in range(3)) < 0.999:
            continue
        return hit['locationBits'], hn, n


def offset_bits(location_bits, normal, scale=1.0):
    """HitLocation + HitNormal (script vector add, float)."""
    return [bits(fr(f(location_bits[k]) + fr(normal[k] * scale))) for k in range(3)]


scenarios = []
counter = iter(range(1, 10000))


def add(name, ops, **extra):
    scenarios.append({'name': name, 'ops': ops, **extra})


# 1. Shadows under pawns and the player start: Shadow.Tick traces 480 down
# from the owner, SetLocation(HitLocation), SetRotation(Rotator(HitNormal)),
# AttachDecal(32, vect(0.1,0.1,0)); DetachDecal before each re-attach.
owners = [a for a in data['actors'] if a['className'] in ('PlayerStart', 'ScientistMale', 'UNATCOTroop', 'ScientistFemale', 'MedicalBot', 'RepairBot')]
rng.shuffle(owners)
shadow_count = 0
for owner in owners:
    if shadow_count >= 10:
        break
    loc = owner['location']
    hit = trace(loc, [loc[0], loc[1], loc[2] - 480])
    if not hit:
        continue
    normal = [f(b) for b in hit['normalBits']]
    ds = round(rng.uniform(0.2, 1.5), 3)
    moved = [loc[0] + rng.uniform(-24, 24), loc[1] + rng.uniform(-24, 24), loc[2]]
    hit2 = trace(moved, [moved[0], moved[1], moved[2] - 480])
    ops = [{'op': 'attach', 'actor': 'shadow', 'locationBits': hit['locationBits'], 'rotation': rotator(normal),
            'texture': TEX['Shadow'], 'drawScale': ds, 'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]}]
    if hit2:
        ops += [{'op': 'detach', 'actor': 'shadow'},
                {'op': 'attach', 'actor': 'shadow', 'locationBits': hit2['locationBits'],
                 'rotation': rotator([f(b) for b in hit2['normalBits']]), 'texture': TEX['Shadow'],
                 'drawScale': round(ds * 0.9, 3), 'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]}]
    ops.append({'op': 'detach', 'actor': 'shadow'})
    add(f'shadow-{owner["className"]}-{owner["name"]}', ops)
    shadow_count += 1
# The NPC startup path records Shadow's rotator as (16384, 0, 0) (docs/script-decal-startup.md);
# LineCheck's floor normal is (-0, -0, 1), whose Rotator is (16384, -32768, 0). Cover both.
for sc in list(scenarios[:3]):
    add(sc['name'] + '-yaw0', [dict(op, rotation=[16384, 0, 0]) if op['op'] == 'attach' else op for op in sc['ops']])
# Shadows near floor polygon edges (the footprint grid reaches neighbours).
for _ in range(4):
    loc_bits, normal, _n = edge_hit('floor', 20.0)
    add(f'shadow-edge-{next(counter)}', [
        {'op': 'attach', 'actor': 'shadow', 'locationBits': loc_bits, 'rotation': rotator(normal),
         'texture': TEX['Shadow'], 'drawScale': round(rng.uniform(0.6, 1.5), 3), 'multiDecalLevel': 4,
         'args': [32, [0.1, 0.1, 0]]},
        {'op': 'detach', 'actor': 'shadow'}])

# 2. BloodPool: spawned at HitLocation+HitNormal, Rotator(HitNormal);
# Decal.BeginPlay AttachDecal(100) (random direction); Tick grows DrawScale
# and ReattachDecal(vect(0.1,0.1,0)) = DetachDecal + AttachDecal(32, dir).
for level in [4, 3, 2, 1, 0, 4]:
    loc_bits, normal, _n = edge_hit('floor')
    loc = offset_bits(loc_bits, normal)
    base = {'actor': 'pool', 'locationBits': loc, 'rotation': rotator(normal), 'texture': TEX['BloodPool'],
            'multiDecalLevel': level}
    add(f'bloodpool-L{level}-{next(counter)}', [
        {'op': 'attach', **base, 'drawScale': 1.0, 'args': [100], 'rand': msvc_rand(rng.randrange(1 << 31), 64)},
        {'op': 'detach', 'actor': 'pool'},
        {'op': 'attach', **base, 'drawScale': 0.35, 'args': [32, [0.1, 0.1, 0]]},
        {'op': 'detach', 'actor': 'pool'},
        {'op': 'attach', **base, 'drawScale': round(rng.uniform(0.6, 1.2), 3), 'args': [32, [0.1, 0.1, 0]]},
        {'op': 'detach', 'actor': 'pool'}])

# 3. ScorchMark: spawned at HitLocation, Rotator(HitNormal); BeginPlay
# AttachDecal(100) (random), then DrawScale = FClamp(damage/30, 0.5, 3.0)
# and ReattachDecal() = DetachDecal + AttachDecal(32) (random again).
for kind, level in [('floor', 4), ('wall', 4), ('wall', 2), ('floor', 1), ('wall', 0), ('floor', 3)]:
    loc_bits, normal, _n = edge_hit(kind)
    tex = TEX['ScorchMark' if rng.random() < 0.5 else 'ScorchMark39']
    base = {'actor': 'scorch', 'locationBits': loc_bits, 'rotation': rotator(normal), 'texture': tex, 'multiDecalLevel': level}
    add(f'scorch-{kind}-L{level}-{next(counter)}', [
        {'op': 'attach', **base, 'drawScale': 1.0, 'args': [100], 'rand': msvc_rand(rng.randrange(1 << 31), 64)},
        {'op': 'detach', 'actor': 'scorch'},
        {'op': 'attach', **base, 'drawScale': round(rng.uniform(0.5, 3.0), 3), 'args': [32], 'rand': msvc_rand(rng.randrange(1 << 31), 64)},
        {'op': 'detach', 'actor': 'scorch'}])

# 4. BulletHole: TraceHitSpawner spawns at Location+Vector(Rotation) (the hit
# plus the normal), BeginPlay AttachDecal(32, vect(0.1,0.1,0)), DrawScale 0.1.
for kind in ['wall', 'wall', 'wall', 'floor', 'wall', 'floor']:
    loc_bits, normal, _n = edge_hit(kind, 4.0)
    add(f'bullethole-{kind}-{next(counter)}', [
        {'op': 'attach', 'actor': 'hole', 'locationBits': offset_bits(loc_bits, normal), 'rotation': rotator(normal),
         'texture': TEX['BulletHole'], 'drawScale': 0.1, 'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]},
        {'op': 'detach', 'actor': 'hole'}])

# 4b. Footprints crossing edges between non-coplanar surfaces: the curved
# walls (22.5 degree segments) and ramps of 00_Training, so the grid projects
# vertices onto a neighbour plane (|cos| > 0.7) or rejects it.
solid = lambda n: model['nodes'][n]['vertexCount'] >= 3 and not model['surfs'][model['nodes'][n]['surface']]['flags'] & 0x8
nz = lambda n: vec(model['surfs'][model['nodes'][n]['surface']]['normal'])
curved = [n for n in range(len(model['nodes'])) if solid(n) and abs(nz(n)[2]) < 0.1 and 0.05 < abs(nz(n)[0]) < 0.95]
ramps = [n for n in range(len(model['nodes'])) if solid(n) and 0.72 < abs(nz(n)[2]) < 0.995]
for label, candidates, level, ds in [('curved', curved, 4, 2.5), ('curved', curved, 3, 1.5), ('ramp', ramps, 4, 2.0), ('ramp', ramps, 2, 3.0)]:
    loc_bits, normal, _n = edge_hit('any', 6.0, candidates)
    add(f'neighbour-{label}-L{level}-{next(counter)}', [
        {'op': 'attach', 'actor': 'n', 'locationBits': offset_bits(loc_bits, normal), 'rotation': rotator(normal),
         'texture': TEX['ScorchMark'], 'drawScale': ds, 'multiDecalLevel': level, 'args': [32, [0.1, 0.1, 0]]},
        {'op': 'detach', 'actor': 'n'}])

# 5. Several decals on one spot: FDecal ordering by texture (insert before the
# first same-texture entry, else append) and DetachDecal removal.
loc_bits, normal, _n = edge_hit('floor', 6.0)
rot = rotator(normal)
ops = []
for ident, tex, ds in [('a', 'Shadow', 1.0), ('b', 'BloodPool', 0.5), ('c', 'Shadow', 0.8), ('d', 'BulletHole', 0.1),
                       ('e', 'BloodPool', 0.7), ('f', 'Shadow', 1.2)]:
    ops.append({'op': 'attach', 'actor': ident, 'locationBits': loc_bits, 'rotation': rot, 'texture': TEX[tex],
                'drawScale': ds, 'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]})
for ident in ['c', 'a', 'e', 'f', 'b', 'd']:
    ops.append({'op': 'detach', 'actor': ident})
add('ordering-six-decals', ops)
# The same decal attached twice without DetachDecal (SurfList and entries duplicate on the first surface).
add('double-attach', [ops[0], dict(ops[0]), {'op': 'detach', 'actor': 'a'}])

# 6. DecalDir parallel to the surface normal: the projection is below 1e-4 on
# every axis, so the direction becomes (surface base point - probe).
loc_bits, normal, _n = edge_hit('floor', 6.0)
add('degenerate-dir-floor', [{'op': 'attach', 'actor': 'x', 'locationBits': offset_bits(loc_bits, normal), 'rotation': rotator(normal),
                              'texture': TEX['Shadow'], 'drawScale': 1.0, 'multiDecalLevel': 4, 'args': [32, normal]},
                             {'op': 'detach', 'actor': 'x'}])
loc_bits, normal, _n = edge_hit('wall', 6.0)
add('degenerate-dir-wall', [{'op': 'attach', 'actor': 'x', 'locationBits': offset_bits(loc_bits, normal), 'rotation': rotator(normal),
                             'texture': TEX['BulletHole'], 'drawScale': 0.5, 'multiDecalLevel': 2, 'args': [32, [-v for v in normal]]},
                            {'op': 'detach', 'actor': 'x'}])

# 7. Gates.
loc_bits, normal, _n = edge_hit('floor', 6.0)
above = offset_bits(loc_bits, normal, 10.0)
add('gate-trace-miss', [{'op': 'attach', 'actor': 'g', 'locationBits': above, 'rotation': rotator(normal), 'texture': TEX['Shadow'],
                         'drawScale': 1.0, 'multiDecalLevel': 4, 'args': [5, [0.1, 0.1, 0]]}])
add('gate-clamp-9-and-negative', [
    {'op': 'attach', 'actor': 'g', 'locationBits': loc_bits, 'rotation': rotator(normal), 'texture': TEX['Shadow'],
     'drawScale': 1.0, 'multiDecalLevel': 9, 'args': [32, [0.1, 0.1, 0]]},
    {'op': 'detach', 'actor': 'g'},
    {'op': 'attach', 'actor': 'g', 'locationBits': loc_bits, 'rotation': rotator(normal), 'texture': TEX['Shadow'],
     'drawScale': 1.0, 'multiDecalLevel': -1, 'args': [32, [0.1, 0.1, 0]]},
    {'op': 'detach', 'actor': 'g'}])
# The one 00_Training surface with PF_AutoUPan|PF_AutoVPan (0x600).
pan = [n for n, node in enumerate(model['nodes']) if model['surfs'][node['surface']]['flags'] & 0x600 and node['vertexCount'] >= 3]
if pan:
    poly = node_polygon(pan[0])
    nrm = vec(model['surfs'][model['nodes'][pan[0]]['surface']]['normal'])
    centre = [sum(p[k] for p in poly) / len(poly) for k in range(3)]
    hit = trace([centre[k] + nrm[k] * 24 for k in range(3)], [centre[k] - nrm[k] * 24 for k in range(3)])
    if hit:
        hn = [f(b) for b in hit['normalBits']]
        add('gate-polyflags-autopan', [{'op': 'attach', 'actor': 'g', 'locationBits': offset_bits(hit['locationBits'], hn),
                                        'rotation': rotator(hn), 'texture': TEX['Shadow'], 'drawScale': 1.0,
                                        'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]}])
# Synthetic PolyFlags gates: no solid 00_Training surface has PF_AutoUPan or
# PF_AutoVPan (0x600; surface 5128 has them but is PF_NotSolid, so LineCheck
# never returns it). Override the first surface (gate) or a grid neighbour.
probe = dict(scenarios[[sc['name'] for sc in scenarios].index('ordering-six-decals')]['ops'][0], actor='p')
first = oracle.run_scenario({'ops': [probe]}, model)['ops'][0]['surfList'][0]
add('synthetic-polyflags-first-surface', [probe], surfaceFlags={str(first): model['surfs'][first]['flags'] | 0x200})
neighbour = next(sc for sc in scenarios if sc['name'].startswith('scorch-wall-L2'))['ops'][0]
extra = oracle.run_scenario({'ops': [neighbour]}, model)['ops'][0]['surfList'][-1]
add('synthetic-polyflags-neighbour', [dict(neighbour)], surfaceFlags={str(extra): model['surfs'][extra]['flags'] | 0x400})
oracle.run_scenario({'ops': []}, model)  # reload for the LineCheck probes below
# Rotation not facing the surface: the trace runs along -XAxis and misses.
add('gate-rotation-away', [{'op': 'attach', 'actor': 'g', 'locationBits': above, 'rotation': [-16384, 0, 0],
                            'texture': TEX['Shadow'], 'drawScale': 1.0, 'multiDecalLevel': 4, 'args': [32, [0.1, 0.1, 0]]}])

# 8. Synthetic: the hit surface's Actor is a Mover (no shipped level BSP
# surface is): MoverRotation is copied and SetBase(Owner) is called.
loc_bits, normal, n = edge_hit('floor', 2.0)
first = trace(f_loc := [f(b) for b in loc_bits], [f_loc[0], f_loc[1], f_loc[2] - 32])
surf_index = model['nodes'][first['item']]['surface'] if first else model['nodes'][n]['surface']
add('synthetic-mover-surface', [
    {'op': 'attach', 'actor': 'm', 'owner': f'surface:{surf_index}', 'locationBits': offset_bits(loc_bits, normal),
     'rotation': rotator(normal), 'texture': TEX['BulletHole'], 'drawScale': 0.5, 'multiDecalLevel': 0,
     'args': [32, [0.1, 0.1, 0]]},
    {'op': 'detach', 'actor': 'm'}], surfaceActors={str(surf_index): {'class': 'Mover', 'rotation': [1000, -2000, 300]}},
    note='synthetic: the first FindSurface result for this location may differ from the hit node surface; '
         'MoverRotation is only written when the selected surface is the overridden one')

# Run at 0x037f and compare with 0x027f / 0x007f.
def run_all(control_word):
    out = []
    for sc in scenarios:
        sc2 = json.loads(json.dumps(sc))
        for op in sc2['ops']:
            op['controlWord'] = control_word
        try:
            out.append(oracle.run_scenario(sc2, model))
        except RuntimeError as error:
            out.append({'name': sc['name'], 'error': str(error)})
    return out


primary = run_all(0x037f)
comparison = {}
strip = lambda r: json.dumps([{k: v for k, v in op.items() if k != 'controlWord'} for op in r.get('ops', [])] or r.get('error'))
if COMPARE:
    for cw in (0x027f, 0x007f):
        other = run_all(cw)
        diffs = [s['name'] for s, o in zip(primary, other) if strip(s) != strip(o)]
        comparison[hex(cw)] = {'differingScenarios': diffs, 'count': len(diffs)}
request = {'mode': 'attach', 'scenarios': scenarios}
print(json.dumps({'map': data['map'], 'hashes': d.native.HASHES, 'request': request, 'results0x037f': primary,
                  'controlWordComparison': comparison}))
