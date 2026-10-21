"""Execute the original Render.dll URender::DrawMesh (0x10b0d1a0) on a classic UMesh.

Optional research tool, never imported by the browser. The unchanged DrawMesh
body runs from its entry (the dispatch to DrawLodMesh is not taken: the mesh is
not a ULodMesh), and with it the shared face helper 0x10b0bab0, Core's FVector
and FPlane operators and the light manager's rsqrt tables (built by the original
FLightManager::Init code, as native-mesh-light-oracle.py does). Serviced by
Python, because they are outside this translation's contract and validated on
their own: the mesh's GetFrame (vtable +0x70; it writes the case's
camera-space points), UMesh::GetTexture (+0x74), UTexture::Lock/Unlock/Tick
(they fill the FTextureInfo the case gives), FLightManager::SetupForActor, Light,
Fog and FinishActor (a deterministic colour of the vertex index; the arguments are
recorded) and the render device's DrawGouraudPolygon (+0x78; the polygon and the
vertex records it is handed are recorded, after the helper's environment and
unlit preparations).

Cases arrive as JSON on stdin; floats are binary32 and cross as numbers.
"""
import base64
import importlib.util
import json
import struct
import sys
from pathlib import Path

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('mesh_light', Path(__file__).with_name('native-mesh-light-oracle.py'))
mesh_light = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh_light)
dyn = mesh_light.dyn

DRAW_MESH = 0x10b0d1a0
GLIGHT_MANAGER = 0x10b3059c          # class FLightManagerBase *GLightManager
TEXTURE_INFO, ENVIRONMENT_INFO, TEXTURE_ARRAY = 0x10b4ebd8, 0x10b4ea48, 0x10b4f3f8
UNLIT_COLOR = 0x10b4ea38
HAND_FLAG = 0x10b4eb10
PLAYER_PAWN_CLASS_CELL = 0x10b5d6ac  # import cell of APlayerPawn::PrivateStaticClass
STUB_BASE = dyn.STUBS + 0x800

EXTRA_CORE = ['??UFVector@@QBEMABV0@@Z', '?SafeNormal@FVector@@QBE?AV1@XZ', '?UnsafeNormal@FVector@@QBE?AV1@XZ',
              '??HFVector@@QBE?AV0@ABV0@@Z', '?TransformVectorBy@FVector@@QBE?AV1@ABVFCoords@@@Z',
              '?SizeSquared@FVector@@QBEMXZ', '??0FPlane@@QAE@ABVFVector@@@Z', '??0FVector@@QAE@XZ',
              '??0FPlane@@QAE@XZ', '??KFVector@@QBE?AV0@M@Z', '??GFVector@@QBE?AV0@XZ',
              '?TransformPointBy@FVector@@QBE?AV1@ABVFCoords@@@Z']


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def light_of(index):
    """The colour the Light stub returns for vertex `index` (exact in binary32)."""
    return [(index % 97) / 128, ((index * 3) % 89) / 128, ((index * 7) % 83) / 128, index / 1024]


def fog_of(index):
    return [((index * 5) % 79) / 128, ((index * 11) % 73) / 128, ((index * 13) % 71) / 128, ((index * 2) % 61) / 128]


class DrawOracle(mesh_light.MeshOracle):
    def __init__(self, root, control_word):
        super().__init__(root, control_word)
        cpu = self.cpu
        core_exports = self.core.exports()
        for library, symbol, slot in self.render.imports():
            if library == 'core.dll' and symbol in EXTRA_CORE:
                self.write(slot, 'I', core_exports[symbol])
        self.stubs, cursor = {}, STUB_BASE

        def stub(name, pop):
            nonlocal cursor
            address = cursor
            cpu.mem_write(address, struct.pack('<BH', 0xc2, pop) if pop else b'\xc3')
            self.stubs[address] = name
            cursor += 0x10
            return address

        self.s_setup, self.s_finish = stub('SetupForActor', 0x10), stub('FinishActor', 0)
        self.s_light, self.s_fog = stub('Light', 0xc), stub('Fog', 0xc)
        self.s_frame, self.s_texture = stub('GetFrame', 0x3c), stub('GetTexture', 8)
        self.s_lock, self.s_unlock, self.s_tick = stub('Lock', 0x14), stub('Unlock', 4), stub('Tick', 8)
        self.s_draw = stub('DrawGouraudPolygon', 0x18)
        cpu.hook_add(UC_HOOK_CODE, self.stub_service, begin=STUB_BASE, end=STUB_BASE + 0x1ff)
        # The light manager: its vtable +8 SetupForActor, +0x14 FinishActor, +0x18 Light, +0x1c Fog.
        self.light_manager, light_vtable = self.alloc(0x20), self.alloc(0x40)
        for slot, address in [(8, self.s_setup), (0x14, self.s_finish), (0x18, self.s_light), (0x1c, self.s_fog)]:
            self.write(light_vtable + slot, 'I', address)
        self.write(self.light_manager, 'I', light_vtable)
        self.write(GLIGHT_MANAGER, 'I', self.light_manager)
        self.arena = self.alloc(0x200000)
        self.mark = self.alloc_top  # each case's fixtures are allocated above it and dropped after

    def reset(self, case):
        self.log = {'setup': [], 'light': [], 'fog': [], 'draws': [], 'locks': [], 'unlocks': [], 'textures': [], 'frame': []}
        self.case = case
        self.vbase = None

    # -- fixture ---------------------------------------------------------------------------------------
    def build(self, case):
        n = case['frameVerts']
        tris, connects, links = (base64.b64decode(case[k]) for k in ('tris', 'connects', 'links'))
        tri_ptr, con_ptr, link_ptr = self.alloc(len(tris) + 16), self.alloc(len(connects) + 16), self.alloc(len(links) + 16)
        self.cpu.mem_write(tri_ptr, tris)
        self.cpu.mem_write(con_ptr, connects)
        self.cpu.mem_write(link_ptr, links)
        mesh, vtable = self.alloc(0x200), self.alloc(0x100)
        self.write(vtable + 0x70, 'I', self.s_frame)
        self.write(vtable + 0x74, 'I', self.s_texture)
        self.write(mesh, 'I', vtable)
        self.write(mesh + 0x78, 'II', tri_ptr, len(tris) // 20)
        self.write(mesh + 0x9c, 'II', con_ptr, len(connects) // 8)
        self.write(mesh + 0xcc, 'II', link_ptr, len(links) // 4)
        self.write(mesh + 0xdc, 'I', case['textureCount'])
        self.write(mesh + 0xf0, 'I', n)
        self.mesh = mesh
        # Textures: one object each, the same vtable (+0x54 Lock, +0x58 Unlock, +0x78 Tick).
        texture_vtable = self.alloc(0x100)
        for slot, address in [(0x54, self.s_lock), (0x58, self.s_unlock), (0x78, self.s_tick)]:
            self.write(texture_vtable + slot, 'I', address)
        self.texture_ids, self.texture_infos = {}, {}

        def make_texture(spec, tag):
            if spec is None:
                return 0
            pointer = self.alloc(0x100)
            self.write(pointer, 'I', texture_vtable)
            self.write(pointer + 0x80, 'I', spec['polyFlags'])
            self.texture_ids[pointer], self.texture_infos[pointer] = tag, spec
            return pointer
        self.mesh_textures = [make_texture(spec, ['tex', i]) for i, spec in enumerate(case['textures'])]
        self.environment = make_texture(case.get('environment'), ['env'])
        # The viewing player: a PlayerPawn (the class chain's first link is the static class), and its Sprite.
        viewer = self.alloc(0x800)
        self.write(viewer + 0x24, 'I', self.read(PLAYER_PAWN_CLASS_CELL, 'I')[0])
        self.viewer = viewer
        sprite = case.get('sprite')
        self.sprite = make_texture(sprite, ['sprite']) if sprite else 0
        self.write(viewer + 0x168, 'I', self.sprite)
        # The render device: SpanBased (+0x48) false.
        self.rendev, rendev_vtable = self.alloc(0x100), self.alloc(0x100)
        self.write(self.rendev, 'I', rendev_vtable)
        self.write(rendev_vtable + 0x78, 'I', self.s_draw)
        self.write(self.rendev + 0x48, 'I', 0)
        viewport = self.alloc(0x200)
        self.write(viewport + 0x30, 'I', viewer)
        self.write(viewport + 0x64, 'I', self.rendev)
        self.write(viewport + 0xb0, 'd', case.get('time', 12.5))
        # The frame.
        frame = self.alloc(0x200)
        fr = case['frame']
        self.write(frame, 'I', viewport)
        self.write(frame + 0x20, 'f', fr['mirror'])
        self.write(frame + 0x30, 'f', 0.0)
        self.write(frame + 0x34, '12f', *fr['coords'])
        self.write(frame + 0x64, '12f', *fr['uncoords'])
        self.write(frame + 0xb8, '2f', *fr.get('size', [640.0, 480.0]))
        self.write(frame + 0xc0, '2f', *fr.get('center', [320.0, 240.0]))
        self.write(frame + 0xdc, 'f', fr.get('projZ', 320.0))
        self.write(frame + 0xec, '4f', *fr['prj'])
        self.scene_frame = frame
        # The actor.
        a = case['actor']
        actor = self.alloc(0x800)
        self.write(actor + 4, 'I', 1234)
        self.write(actor + 0x174, 'I', mesh)
        self.write(actor + 0x3c, 'I', viewer if case.get('ownedByViewer') else 0)
        self.write(actor + 0x16c, 'I', self.environment)
        self.write(actor + 0x18c, 'f', a['scaleGlow'])
        self.write(actor + 0x190, 'BB', a['ambientGlow'], a['fatness'])
        self.write(actor + 0x194, 'I', a.get('flags', 0))
        self.owner = actor
        # URender (`this`): Engine +0x2c, its Client +0x44, whose +0x40 field is read once.
        urender, engine, client = self.alloc(0x100), self.alloc(0x100), self.alloc(0x100)
        self.write(urender + 0x2c, 'I', engine)
        self.write(engine + 0x44, 'I', client)
        self.write(client + 0x40, 'I', case.get('clientFlag', 1))
        self.urender = urender
        self.coords_arg = self.alloc(0x40)
        self.write(self.coords_arg, '12f', *fr['coords'])
        # GMem (a bump arena), the sprite span and the output vertex buffer's base (set by GetFrame).
        self.write(self.gmem, 'I', self.arena)

    # -- stub services ---------------------------------------------------------------------------------------
    def sarg(self, i):
        return self.read(self.cpu.reg_read(UC_X86_REG_ESP) + 4 + 4 * i, 'I')[0]

    def vertex_index(self, pointer):
        return (pointer - self.vbase) // 0x58

    def record(self, pointer):
        words = lambda at, n: list(self.read(pointer + at, f'{n}I'))
        return {'index': self.vertex_index(pointer), 'point': words(0, 3), 'outcode': self.read(pointer + 0xc, 'B')[0],
                'normal': words(0x20, 4), 'light': words(0x30, 4), 'fog': words(0x40, 4), 'u': words(0x50, 1)[0], 'v': words(0x54, 1)[0]}

    def stub_service(self, cpu, address, size, data):
        name = self.stubs.get(address)
        if name is None:
            return
        esp = cpu.reg_read(UC_X86_REG_ESP)
        if name == 'SetupForActor':
            self.log['setup'].append([self.sarg(i) for i in range(4)])
            cpu.reg_write(UC_X86_REG_EAX, self.case['setupFlags'])
        elif name == 'Light' or name == 'Fog':
            result, vertex, flags = (self.sarg(i) for i in range(3))
            record = self.record(vertex)
            index = record['index']
            colour = (light_of if name == 'Light' else fog_of)(index)
            self.write(result, '4f', *colour)
            self.log['light' if name == 'Light' else 'fog'].append({**record, 'flags': flags})
            cpu.reg_write(UC_X86_REG_EAX, result)
        elif name == 'GetFrame':
            output, stride = self.sarg(0), self.sarg(1)
            self.vbase = output
            self.log['frame'].append({'stride': stride, 'actor': self.sarg(14)})
            for i, point in enumerate(self.case['points']):
                self.write(output + i * stride, '3f', *point)
        elif name == 'GetTexture':
            index = self.sarg(0)
            self.log['textures'].append(index)
            cpu.reg_write(UC_X86_REG_EAX, self.mesh_textures[index] if 0 <= index < len(self.mesh_textures) else 0)
        elif name == 'Lock':
            info = self.sarg(0)
            this = cpu.reg_read(UC_X86_REG_ECX)
            spec = self.texture_infos[this]
            self.write(info, 'I', this)
            self.write(info + 0x28, '2f', spec['uScale'], spec['vScale'])
            self.write(info + 0x30, '2i', spec['uSize'], spec['vSize'])
            self.log['locks'].append({'texture': self.texture_ids[this], 'info': info, 'lod': self.sarg(4)})
        elif name == 'Unlock':
            self.log['unlocks'].append(self.sarg(0))
        elif name == 'DrawGouraudPolygon':
            frame, info, pts, count, flags, span = (self.sarg(i) for i in range(6))
            vertices = [self.record(self.read(pts + 4 * k, 'I')[0]) for k in range(count)]
            self.log['draws'].append({'info': self.info_name(info), 'count': count, 'flags': flags, 'pts': vertices,
                                      'uFactor': None})

    def info_name(self, info):
        if info == ENVIRONMENT_INFO:
            return ['env']
        index = (info - TEXTURE_INFO) // 0x80
        return ['tex', index]

    # -- a case -----------------------------------------------------------------------------------------------
    def run_case(self, case):
        self.alloc_top = self.mark
        self.reset(case)
        self.build(case)
        self.cpu.mem_write(HAND_FLAG, b'\0\0\0\0')
        self.write(UNLIT_COLOR, '3I', 0, 0, 0)
        args = [self.scene_frame, self.owner, self.owner, 0xfeed0001, 0xfeed0002, self.coords_arg, 0xfeed0003, 0xfeed0004, case['polyFlags']]
        self.call(DRAW_MESH, args, this=self.urender)
        unlit = list(self.read(UNLIT_COLOR, '3I'))
        return {'name': case['name'], **self.log, 'unlit': unlit,
                'textureArray': [self.read(TEXTURE_ARRAY + 4 * i, 'I')[0] for i in range(len(case['textures']))],
                'textureIds': {str(p): i for p, i in self.texture_ids.items()}}


def main():
    root = sys.argv[1]
    control_word = int(sys.argv[2], 0) if len(sys.argv) > 2 else dyn.native.render_control_word(0x007f)
    cases = json.load(sys.stdin)
    oracle = DrawOracle(root, control_word)
    json.dump({'controlWord': control_word, 'cases': [oracle.run_case(case) for case in cases]}, sys.stdout)


if __name__ == '__main__':
    main()
