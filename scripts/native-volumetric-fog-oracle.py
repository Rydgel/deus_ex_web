"""Original Render.dll volumetric lighting (docs/volumetric-fog.md).

Runs unchanged Render.dll segments over fabricated light infos (FLightInfo,
0x94 bytes) and globals:
- ComputeFromActor's volumetric tail: 0x10b06873-0x10b068dd (the volume
  colour copy and VolumeFog), then 0x10b06a35-0x10b06c1c with the caller's
  table buffer in ESI (the GCache lookup in between is skipped): the colour
  table and the radius, brightness, distance and inside fields;
- SetupForSurf's per-light fog loop 0x10b073bb-0x10b07c44 over a light list
  in the case's (camera-depth) order, the light-map grid globals, the frame
  coords, the fog buffer and the early-out flag 0x10b4ea00.
The fast square-root table and the fog attenuation table come from the
light-manager init (0x10b0225b-0x10b022d0, 0x10b020cf-0x10b02112).

  native-volumetric-fog-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EBX, UC_X86_REG_ESI, UC_X86_REG_EAX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('lighting', Path(__file__).with_name('native-dynamic-light-oracle.py'))
lighting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lighting)

LIGHT_LIST, LIGHT_END = 0x10b3db84, 0x10b3cad8
FRAME_PTR, GRID_BASE, GRID_U, GRID_V = 0x10b38a7c, 0x10b38a90, 0x10b49e10, 0x10b3d378
FOG_DATA, STRIDE, WIDTH, HEIGHT, MISS = 0x10b38aa0, 0x10b3d328, 0x10b3d330, 0x10b3d334, 0x10b4ea00


class FogOracle(lighting.Oracle):
    def __init__(self, root):
        super().__init__(root, 0x037f)
        # GTimestamp (Render IAT 0x10b5d4c8) reads as 0: the cycle-count
        # statistics take the non-rdtsc path.
        self.timestamp = self.alloc(16)
        self.write(0x10b5d4c8, 'I', self.timestamp)
        # FLightManager::Fog's out-of-line Core calls: FVector::operator| and
        # SizeSquared (Render IAT 0x10b5d4d0, 0x10b5d4cc).
        core = self.core.exports()
        self.write(0x10b5d4d0, 'I', core['??UFVector@@QBEMABV0@@Z'])
        self.write(0x10b5d4cc, 'I', core['?SizeSquared@FVector@@QBEMXZ'])
        self.sqrt_table()                  # fast square-root table 0x10b3e1b8
        self.frame()
        self.init_run(0x10b020cf, 0x10b02112)   # fog attenuation table 0x10b38ac8
        self.case_top = self.alloc_top

    def low_frame(self):
        ebp = self.frame()
        self.cpu.reg_write(UC_X86_REG_ESP, ebp - 0x1000)
        return ebp

    def volumetric(self, case):
        info, actor, table = self.alloc(0x94), self.alloc(0x400), self.alloc(0x410)
        self.write(info, 'I', actor)
        self.write(info + 8, '3I', *case['location'])
        self.write(info + 0x20, 'I', case['brightness'])
        self.write(info + 0x30, 'I', 1)
        self.write(info + 0x6c, '4I', *case['color'], 0)
        self.write(actor + 0x1e9, '3B', case['volumeBrightness'], case['volumeRadius'], case['volumeFog'])
        self.low_frame()
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.run(0x10b06873, 0x10b068dd)
        self.low_frame()
        self.cpu.reg_write(UC_X86_REG_EBX, info)
        self.cpu.reg_write(UC_X86_REG_ESI, table)
        self.run(0x10b06a35, 0x10b06c1c)
        fields = self.read(info, '37I')
        return info, {'fog': fields[0x88 // 4], 'radius': fields[0x44 // 4], 'radiusSq': fields[0x48 // 4],
                      'brightness': fields[0x4c // 4], 'distanceSq': fields[0x50 // 4], 'invRadius': fields[0x54 // 4],
                      'invRadiusSq': fields[0x58 // 4], 'inside': fields[0x5c // 4],
                      'tableAt': fields[0x90 // 4] - table, 'table': list(self.cpu.mem_read(table + 0x10, 0x400))}

    def fog(self, case):
        infos = [self.volumetric(light) for light in case['lights']]
        frame = self.alloc(0x100)
        self.write(frame + 0x34, '12I', *case['coords'])
        self.write(FRAME_PTR, 'I', frame)
        self.write(GRID_BASE, '3I', *case['grid']['base'])
        self.write(GRID_U, '3I', *case['grid']['stepU'])
        self.write(GRID_V, '3I', *case['grid']['stepV'])
        width, height = case['width'], case['height']
        stride = 1 << (width - 1).bit_length() if width > 1 else 1
        data = self.alloc(stride * height * 4 + 16)
        self.cpu.mem_write(data, bytes(stride * height * 4))
        self.write(FOG_DATA, 'I', data)
        self.write(STRIDE, 'i', stride)
        self.write(WIDTH, 'ii', width, height)
        self.write(MISS, 'I', case.get('missFlag', 0))
        order = [infos[i][0] for i in case['order']]
        self.write(LIGHT_LIST, f'{len(order)}I', *order)
        end = LIGHT_LIST + 4 * len(order)
        self.write(LIGHT_END, 'I', end)
        ebp = self.low_frame()
        self.write(ebp - 0x8c, 'I', 1)
        self.cpu.reg_write(UC_X86_REG_EAX, end)
        self.cpu.reg_write(UC_X86_REG_EBX, 0)
        self.run(0x10b073bb, 0x10b07c44)
        texels = []
        for v in range(height):
            texels += list(self.cpu.mem_read(data + v * stride * 4, width * 4))
        flag = self.read(MISS, 'I')[0]
        # FLightManager::Fog (0x10b02c00, PolyFlags PF_RenderFog) for mesh
        # vertices in frame space, after the surface, over the same sorted
        # list and early-out flag.
        vertices = []
        point, plane = self.alloc(0x40), self.alloc(0x10)
        for vertex in case.get('vertices', []):
            self.write(point, '3I', *vertex)
            self.call(0x10b02c00, [plane, point, 0x40000000], 0x10b3d2f0)
            vertices.append(list(self.read(plane, '4I')))
        return {'lights': [info for _, info in infos], 'texels': texels, 'missFlag': flag,
                'vertices': vertices, 'vertexMissFlag': self.read(MISS, 'I')[0]}


if __name__ == '__main__':
    oracle = FogOracle(Path(sys.argv[1]))
    # The tables above come from the light manager's init on the game thread.
    # The per-surface segments run inside DrawWorld, where URender::PreRender
    # sets 24-bit precision control (docs/bsp-occlusion.md "Precision"):
    # argv[2] = 0x007f runs them so. The translation was validated at the
    # default 0x037f; at 0x007f ComputeFromActor's constants already differ
    # (docs/volumetric-fog.md, the render-pass precision audit).
    oracle.control_word = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x037f
    cases = json.load(sys.stdin)
    out = []
    for case in cases:
        out.append(oracle.fog(case))
        oracle.alloc_top = oracle.case_top   # fixtures are per case
    json.dump(out, sys.stdout)
