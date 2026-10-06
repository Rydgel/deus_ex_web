"""Execute the original Render.dll mesh-lighting path.

Optional research tool, never imported by the browser. Runs the hash-pinned
Render.dll and Engine.dll bodies documented in docs/mesh-lighting.md: the
whole FLightManager::SetupForActor (with the original AddLight,
ComputeFromActor, URender::GlobalLighting, FGetHSV and WorldLightRadius), the
per-vertex FLightManager::Light and FinishActor, the light-manager power tables
(0x10b024b0), DrawLodMesh's face-normal and vertex-normal blocks, and D3DDrv's
DrawGouraudPolygon diffuse conversion.

Core's FVector/FPlane operators run unchanged. These imports are serviced by
Python instead, because they are outside the translated contract:
  - GCache lookups/creation (FMemCache::Create), keyed exactly like the inline
    hash probe at 0x10b08fb7;
  - UObject::GetIndexedObject, answered from the fixture's object table;
  - UModel::LineCheck, answered from the fixture (the BSP line check has its own
    validation) and recorded so the caller can check which pairs were traced;
  - CRT pow/isnan used by the table builder (docs/mesh-lighting.md explains
    why table bits do not depend on the CRT's last-ulp behaviour);
  - msvcrt _ftol, as the equivalent truncating x87 sequence.
Every other import traps. Cases arrive as JSON on stdin.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI,
                               UC_X86_REG_EBP, UC_X86_REG_ESP)

spec = importlib.util.spec_from_file_location('dyn', Path(__file__).with_name('native-dynamic-light-oracle.py'))
dyn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dyn)
native = dyn.native

D3D_HASH = '9e0f8a4293de6edb4f88b1ba9972fe98b4e80a1115f9667e57f8ef3d51d8ac9f'
HOOKS = dyn.STUBS + 0x200          # Python-serviced import stubs
FTOL = dyn.STUBS + 0x600
POW_CELL = dyn.STUBS + 0x700

# Render.dll addresses (docs/mesh-lighting.md).
LIGHT_MANAGER = 0x10b3d2f0
LIGHT_MANAGER_VTABLE = 0x10b2a93c
SETUP_FOR_ACTOR, LIGHT, FINISH_ACTOR = 0x10b08c70, 0x10b027f0, 0x10b098d0
GLOBAL_LIGHTING = 0x10b05e90
POWER_TABLES = 0x10b024b0
RSQRT_MANTISSA, RSQRT_EXPONENT = 0x10b33650, 0x10b3d384
LOCK_STACK, LOCK_STACK_BASE = 0x10b38a80, 0x10b34654
FIRST_LIGHT, LAST_LIGHT = 0x10b401c0, 0x10b49df4
AMBIENT, SCALE_GLOW = 0x10b3d2e0, 0x10b33648
FACE_NORMAL = (0x10b0fe60, 0x10b0ff88)
VERTEX_NORMAL = (0x10b10863, 0x10b10912)
D3D_DIFFUSE = (0x10005942, 0x100059ac)


class MeshOracle(dyn.Oracle):
    def __init__(self, root, control_word):
        super().__init__(root, control_word)
        cpu = self.cpu
        # Page 0 (the SEH prologue's fs:[0]) is mapped by the lighting oracle.
        self.d3d = native.Image(Path(root) / 'System' / 'D3DDrv.dll', D3D_HASH)
        cpu.mem_map(self.d3d.base, (self.d3d.size + 4095) & ~4095)
        for _, _, virtual, raw_size, raw in self.d3d.sections:
            if raw_size:
                cpu.mem_write(self.d3d.base + virtual, self.d3d.data[raw:raw + raw_size])
        core_exports, engine_exports = self.core.exports(), self.engine.exports()
        self.zero_cell = self.alloc(0x10)
        self.gcache = self.alloc(0x24 + 0x4000 * 4)
        self.level_info_class = self.alloc(0x100)
        self.hooks, cursor = {}, HOOKS

        def hook(name, handler, pop=0, code=b''):
            nonlocal cursor
            address = cursor
            cpu.mem_write(address, code + (struct.pack('<BH', 0xc2, pop) if pop else b'\xc3'))
            self.hooks[address] = (name, handler)
            cursor += 0x10
            return address

        pow_code = b'\xdd\x05' + struct.pack('<I', POW_CELL)  # fld qword [POW_CELL]
        stubs = {
            '?GetIndexedObject@UObject@@SAPAV1@H@Z': hook('GetIndexedObject', self.get_indexed_object),
            '?Create@FMemCache@@QAEPAE_KAAPAVFCacheItem@1@HHH@Z': hook('FMemCache::Create', self.cache_create, 0x18),
            '?appPow@@YANNN@Z': hook('appPow', self.app_pow, code=pow_code),
            '?appIsNan@@YAHN@Z': hook('appIsNan', self.app_isnan),
            '?appFailAssert@@YAXPBD0H@Z': hook('appFailAssert', self.fail_assert),
        }
        self.line_check = hook('UModel::LineCheck', self.model_line_check, 0x30)
        self.set_actor_zone = hook('ULevel::SetActorZone', self.fail('SetActorZone is outside the fixture'), 0xc)
        # _ftol: truncate st(0) to a 64-bit integer in edx:eax and pop it.
        ftol = bytes.fromhex('83ec0c' 'd93c24' '668b0424' '660d000c' '6689442402' 'd96c2402'
                             'df7c2404' 'd92c24' '8b442404' '8b542408' '83c40c' 'c3')
        cpu.mem_write(FTOL, ftol)
        for library, symbol, slot in self.render.imports():
            target = None
            if symbol in stubs:
                target = stubs[symbol]
            elif symbol in ('GTimestamp', '?GIsEditor@@3HA'):
                target = self.zero_cell
            elif symbol == '?GCache@@3VFMemCache@@A':
                target = self.gcache
            elif symbol == '?PrivateStaticClass@ALevelInfo@@0VUClass@@A':
                target = self.level_info_class
            elif symbol == '_ftol':
                target = FTOL
            elif library == 'core.dll' and symbol in (
                    '?PlaneDot@FPlane@@QBEMABVFVector@@@Z', '??DFVector@@QBE?AV0@M@Z', '??GFVector@@QBE?AV0@ABV0@@Z',
                    '??0FVector@@QAE@MMM@Z', '??0FPlane@@QAE@MMMM@Z', '??0FPlane@@QAE@ABV0@@Z'):
                target = core_exports[symbol]
            if target is not None:
                self.write(slot, 'I', target)
        cpu.hook_add(UC_HOOK_CODE, self.service, begin=HOOKS, end=HOOKS + 0x3ff)
        self.write(LIGHT_MANAGER, 'I', LIGHT_MANAGER_VTABLE)
        self.write(LOCK_STACK, 'I', LOCK_STACK_BASE)
        grender, vtable = self.alloc(0x40), self.alloc(0x100)
        self.write(vtable + 0x88, 'I', GLOBAL_LIGHTING)
        self.write(grender, 'I', vtable)
        self.write(dyn.GRENDER, 'I', grender)
        self.objects = {}
        self.visibility, self.traced, self.light_by_location = {}, [], {}
        self.cache_items = 0
        # Light-manager Init's tables: the square root and the reciprocal
        # square root (mantissa/exponent) used by Light and DrawLodMesh.
        self.sqrt = self.sqrt_table()
        self.power = self.power_tables()

    # -- Python-serviced imports ------------------------------------------------
    def service(self, cpu, address, size, data):
        if address in self.hooks:
            self.hooks[address][1](cpu)

    def arg(self, index, fmt='I'):
        esp = self.cpu.reg_read(UC_X86_REG_ESP)
        return self.read(esp + 4 + index * 4, fmt)[0]

    @staticmethod
    def fail(message):
        def handler(cpu):
            raise RuntimeError(message)
        return handler

    def fail_assert(self, cpu):
        raise RuntimeError('Original code failed an assertion; the fixture is incomplete')

    def get_indexed_object(self, cpu):
        cpu.reg_write(UC_X86_REG_EAX, self.objects.get(self.arg(0, 'i'), 0))

    def cache_create(self, cpu):
        lo, hi, item_ref, size, align = (self.arg(i) for i in range(5))
        item, data = self.alloc(0x20), self.alloc(size + 16, max(align, 8))
        self.write(item, 'IIIHH', lo, hi, data, 0, 0)
        self.write(item + 0x10, 'I', 0x1000000)
        index = ((((lo >> 12) ^ (lo & 0x3fff000)) >> 12) ^ (lo & 0x3fff))
        slot = self.gcache + 0x24 + index * 4
        self.write(item + 0x1c, 'I', self.read(slot, 'I')[0])
        self.write(slot, 'I', item)
        self.write(item_ref, 'I', item)
        self.cache_items += 1
        cpu.reg_write(UC_X86_REG_EAX, data)

    def app_pow(self, cpu):
        x, y = self.arg(0, 'd'), self.read(self.cpu.reg_read(UC_X86_REG_ESP) + 12, 'd')[0]
        # C pow(+0, y<0) is +inf; Python raises instead.
        self.write(POW_CELL, 'd', math.inf if x == 0 and y < 0 else math.pow(x, y))

    def app_isnan(self, cpu):
        cpu.reg_write(UC_X86_REG_EAX, 1 if math.isnan(self.arg(0, 'd')) else 0)

    def model_line_check(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        end = self.read(esp + 12, '3I')
        start = self.read(esp + 24, '3I')
        light = self.light_by_location.get(end)
        if light is None or light not in self.visibility:
            raise RuntimeError(f'LineCheck to an unexpected end {end}')
        self.traced.append(light)
        cpu.reg_write(UC_X86_REG_EAX, 1 if self.visibility[light] else 0)

    # -- Light-manager tables ------------------------------------------------------
    def power_tables(self):
        self.write(dyn.STUBS + 0x780, 'f', -0.5)
        # Built by FLightManager::Init on the game thread (init control word).
        render, self.control_word = self.control_word, self.init_control_word
        self.call(POWER_TABLES, [RSQRT_MANTISSA, RSQRT_EXPONENT, self.read(dyn.STUBS + 0x780, 'I')[0]])
        self.control_word = render
        return {'mantissa': list(self.read(RSQRT_MANTISSA, '1024I')), 'exponent': list(self.read(RSQRT_EXPONENT, '512I'))}

    # -- Scene fixture -----------------------------------------------------------------
    def build_scene(self, scene):
        level_info = self.alloc(0x800)
        self.write(level_info + 0x24, 'I', self.level_info_class)
        self.write(level_info + 0x38c, 'BBB', *scene['levelInfo']['ambient'])
        self.write(level_info + 0x478, 'f', scene['levelInfo'].get('timeSeconds', 0.0))
        self.write(level_info + 0x500, 'I', scene['levelInfo']['brightness'])
        zones = {'levelInfo': level_info}
        for name, zone in scene.get('zones', {}).items():
            actor = self.alloc(0x800)
            self.write(actor + 0x38c, 'BBB', *zone['ambient'])
            zones[name] = actor
        light_vtable = self.alloc(0x100)
        self.write(light_vtable + 0x60, 'I', self.world_light_radius)
        lights = {}
        for light in scene['lights']:
            actor = self.alloc(0x800)
            flags = ((1 if light.get('bStatic') else 0) | (0x80 if light.get('bDeleteMe') else 0)
                     | (0x400 if light.get('bLightChanged') else 0) | (0x80000 if light.get('bMovable') else 0))
            self.write(actor, 'I', light_vtable)
            self.write(actor + 4, 'i', light['index'])
            self.write(actor + 0x28, 'I', flags)
            self.write(actor + 0xa8, 'I', level_info)
            self.write(actor + 0x114, '3I', *light['location'])
            self.write(actor + 0x1e0, 'BBBBBBBB', light.get('type', 1), light.get('effect', 0), light['brightness'],
                       light.get('hue', 0), light.get('saturation', 0), light['radius'], light.get('period', 0),
                       light.get('phase', 0))
            self.write(actor + 0x1ec, 'I', 1 if light.get('bSpecialLit') else 0)
            lights[light['id']] = actor
            self.objects[light['index']] = actor
            self.light_by_location[tuple(light['location'])] = light['id']
        model, model_vtable = self.alloc(0x200), self.alloc(0x100)
        self.write(model_vtable + 0x58, 'I', self.line_check)
        self.write(model, 'I', model_vtable)
        leaves = scene['model']['leaves']
        leaf_array = self.alloc(max(1, len(leaves)) * 20)
        for index, permeating in enumerate(leaves):
            self.write(leaf_array + index * 20 + 4, 'i', permeating)
        self.write(model + 0xd8, 'Ii', leaf_array, len(leaves))
        refs = scene['model']['lights']
        light_array = self.alloc(max(1, len(refs)) * 4)
        for index, ref in enumerate(refs):
            self.write(light_array + index * 4, 'I', lights[ref] if ref else 0)
        self.write(model + 0xe4, 'I', light_array)
        level, level_vtable = self.alloc(0x200), self.alloc(0x100)
        self.write(level_vtable + 0xac, 'I', self.set_actor_zone)
        self.write(level, 'I', level_vtable)
        actors = self.alloc(0x10)
        self.write(actors, 'I', level_info)
        self.write(level + 0x2c, 'I', actors)
        self.write(level + 0x98, 'I', model)
        client, player, viewport, frame = self.alloc(0x100), self.alloc(0x800), self.alloc(0x200), self.alloc(0x200)
        self.write(client + 0x48, 'I', scene.get('noLighting', 0))
        self.write(client + 0x50, 'I', scene.get('noDynamicLights', 0))
        self.write(player + 0x5fc, 'Ii', scene.get('showFlags', 0x480c), scene.get('rendMap', 5))
        self.write(viewport + 0x18, 'I', client)
        self.write(viewport + 0x30, 'I', player)
        self.write(frame, 'II', viewport, level)
        self.write(frame + 0x20, 'f', 1.0)
        coords = scene['coords']
        self.write(frame + 0x34, '12I', *coords['origin'], *coords['x'], *coords['y'], *coords['z'])
        source = scene['actor']
        actor = self.alloc(0x800)
        self.write(actor + 4, 'i', source['index'])
        self.write(actor + 0xa8, 'I', level_info)
        zone = source.get('zone')
        self.write(actor + 0xc8, 'Ii', zones[zone] if zone else 0, source['iLeaf'])
        self.write(actor + 0xd0, 'B', source.get('zoneNumber', 1))
        self.write(actor + 0x114, '3I', *source['location'])
        self.write(actor + 0x18c, 'IB', source['scaleGlow'], source.get('ambientGlow', 0))
        self.write(actor + 0x194, 'I', 1 if source.get('bUnlit') else 0)
        self.write(actor + 0x1ec, 'I', 1 if source.get('bSpecialLit') else 0)
        leaf_lights = 0
        for ref in reversed(scene.get('leafLights', [])):
            link = self.alloc(0x20)
            self.write(link + 0xc, 'II', lights[ref], leaf_lights)
            leaf_lights = link
        return {'frame': frame, 'viewport': viewport, 'actor': actor, 'lights': lights, 'leafLights': leaf_lights}

    def setup_frame(self, fixture, frame_case, scene):
        viewport = fixture['viewport']
        self.write(viewport + 0x70, 'd', frame_case['lastUpdateTime'])
        self.write(viewport + 0x84, 'i', frame_case['frameCount'])
        self.write(viewport + 0xb0, 'd', frame_case['currentTime'])
        self.visibility = {int(key): value for key, value in frame_case.get('lineChecks', {}).items()}
        self.traced = []
        flags = self.call(SETUP_FOR_ACTOR, [fixture['frame'], fixture['actor'], fixture['leafLights'], 0],
                          this=LIGHT_MANAGER)
        ids = {address: light_id for light_id, address in fixture['lights'].items()}
        infos = []
        last = self.read(LAST_LIGHT, 'I')[0]
        for info in range(FIRST_LIGHT, last, 0x94):
            actor, kind = self.read(info, 'Ii')
            infos.append({'light': ids[actor], 'class': kind, 'location': list(self.read(info + 8, '3I')),
                          'radius': self.read(info + 0x14, 'I')[0], 'rradius': self.read(info + 0x18, 'I')[0],
                          'color': list(self.read(info + 0x6c, '3I'))})
        tags = {light_id: list(self.read(address + 0x100, 'i')) + list(self.read(address + 0x110, 'i'))
                for light_id, address in fixture['lights'].items()}
        vertices = []
        sample, result = self.alloc(0x58), self.alloc(0x10)
        for vertex in frame_case.get('vertices', []):
            self.write(sample, '3I', *vertex['point'])
            self.write(sample + 0x20, '4I', *vertex['normal'])
            self.call(LIGHT, [result, sample, vertex.get('flags', frame_case.get('polyFlags', 0x4000) | flags)],
                      this=LIGHT_MANAGER)
            vertices.append(list(self.read(result, '4I')))
        out = {'flags': flags, 'ambient': list(self.read(AMBIENT, '4I')), 'scaleGlow': self.read(SCALE_GLOW, 'I')[0],
               'infos': infos, 'tags': tags, 'traced': self.traced, 'vertices': vertices,
               'cache': self.cache_entries(scene['actor']['index'], ids)}
        self.call(FINISH_ACTOR, [], this=LIGHT_MANAGER)
        return out

    def cache_entries(self, index, ids):
        """The actor's GCache item (id Index*256+0x30): count, then 12-byte entries."""
        lo = (index * 256 + 0x30) & 0xffffffff
        item = self.read(self.gcache + 0x24 + ((((lo >> 12) ^ (lo & 0x3fff000)) >> 12) ^ (lo & 0x3fff)) * 4, 'I')[0]
        while item and self.read(item, 'I')[0] != lo:
            item = self.read(item + 0x1c, 'I')[0]
        if not item:
            return None
        data = (self.read(item + 8, 'I')[0] + 7) & ~7
        count = self.read(data, 'i')[0]
        return [[ids[self.read(data + 0xc + i * 12, 'I')[0]], self.read(data + 0x10 + i * 12, 'B')[0],
                 self.read(data + 0x14 + i * 12, 'i')[0]] for i in range(count)]

    def setup(self, scene):
        fixture = self.build_scene(scene)
        return [self.setup_frame(fixture, frame_case, scene) for frame_case in scene['frames']]

    # -- DrawLodMesh normal blocks ------------------------------------------------------
    def face_normal(self, case):
        records = [self.alloc(0x58) for _ in range(3)]
        for record, vertex in zip(records, case['vertices']):
            self.write(record, '3I', *vertex['point'])
            self.write(record + 0x20, '3I', *vertex['normal'])
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_ESI, records[0])
        self.cpu.reg_write(UC_X86_REG_EDX, records[1])
        self.cpu.reg_write(UC_X86_REG_ECX, records[2])
        self.run(*FACE_NORMAL)
        return {'face': list(self.read(ebp - 0x6c, '3I')),
                'normals': [list(self.read(record + 0x20, '3I')) for record in records]}

    def vertex_normal(self, case):
        record = self.alloc(0x58)
        self.write(record, '3I', *case['point'])
        self.write(record + 0x20, '3I', *case['normal'])
        self.frame()
        self.cpu.reg_write(UC_X86_REG_ESI, record)
        self.run(*VERTEX_NORMAL)
        return list(self.read(record + 0x20, '4I'))

    # -- D3DDrv diffuse conversion --------------------------------------------------------
    def d3d_diffuse(self, lights, max_color=(255, 255, 255)):
        """SetTexture's stage MaxColor scale (0x10009439-0x1000949b) for a cached
        texture whose MaxColor is `max_color` (8888 devices use 255s), then the
        unfogged DrawGouraudPolygon diffuse packing (0x10005942-0x100059ac)."""
        device, texture, vertex, pointer = self.alloc(0xc00), self.alloc(0x80), self.alloc(0x20), self.alloc(0x10)
        self.write(texture + 0x48, 'BBB', *max_color)
        ebp = self.frame()
        self.write(ebp - 0x4c, 'I', 0)
        self.cpu.reg_write(UC_X86_REG_ESI, texture)
        self.cpu.reg_write(UC_X86_REG_EDI, device)
        self.run(0x10009439, 0x1000949b)
        scale = list(self.read(device + 0xaa4, '3I'))
        sample = self.alloc(0x58)
        out = []
        for light in lights:
            self.write(sample + 0x30, '3I', *light)
            self.write(pointer, 'I', sample)
            ebp = self.frame()
            self.cpu.reg_write(UC_X86_REG_ESI, device)
            self.cpu.reg_write(UC_X86_REG_ECX, vertex)
            self.cpu.reg_write(UC_X86_REG_EAX, pointer)
            self.run(*D3D_DIFFUSE)
            out.append(self.cpu.reg_read(UC_X86_REG_EDX) & 0xffffffff)
        return {'scale': scale, 'diffuse': out}


def main():
    root, control_word = sys.argv[1], int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x037f
    cases = json.load(sys.stdin)
    out = {'controlWord': control_word}
    oracle = MeshOracle(root, control_word)
    if cases.get('tables'):
        out['sqrtTable'] = oracle.sqrt
        out['power'] = oracle.power
    out['faceNormals'] = [oracle.face_normal(case) for case in cases.get('faceNormals', [])]
    out['vertexNormals'] = [oracle.vertex_normal(case) for case in cases.get('vertexNormals', [])]
    if cases.get('diffuse'):
        out['diffuse'] = oracle.d3d_diffuse(cases['diffuse'])
    # Each scene gets a fresh emulator: light tags, the per-actor cache and the
    # per-call stamp persist only across that scene's frames.
    out['setups'] = [MeshOracle(root, control_word).setup(scene) for scene in cases.get('setups', [])]
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
