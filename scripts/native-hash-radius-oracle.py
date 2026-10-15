"""The original FCollisionHash::ActorRadiusCheck (Engine.dll 0x103589e0, vtable +0x18) on a hash filled by the original
AddActor, reusing native-hash-oracle.py's fixture (original constructor, CRT rand/srand, extent conversion, insertion and
FMemStack run; only the primitive bounding-box callback is a fixture). The result list's FCheckResult nodes come from
Core's GMem (initialised here with a bounded block).

Input: JSON {seed, actors: [{id, bounds: {min, max}, location}], queries: [{location, radius}]}.
Output per query: the cell box the body computed (read from its locals at 0x10358b61) and the hit actor ids in list order.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EBP, UC_X86_REG_ESI

_SPEC = importlib.util.spec_from_file_location('native_hash', Path(__file__).with_name('native-hash-oracle.py'))
_HASH = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_HASH)
base = _HASH.base

RADIUS_CHECK = 0x103589e0
LOOP_START = 0x10358b61


class RadiusHash(_HASH.NativeHash):
    def __init__(self, root, seed):
        super().__init__(root, seed)
        core = base.Image(Path(root) / 'System' / 'Core.dll', base.HASHES['Core.dll'])
        gmem = core.exports()['?GMem@@3VFMemStack@@A']
        block = self.alloc(0x100000)
        self.write(gmem, 'II', block, block + 0x100000)
        self.radius_cells = None

    def on_instruction(self, cpu, address, size, data):
        if address == LOOP_START and self.radius_cells is None:
            bp = cpu.reg_read(UC_X86_REG_EBP)
            self.radius_cells = {'min': [cpu.reg_read(UC_X86_REG_ESI), self.read(bp - 0x2c, 'i')[0], self.read(bp - 0x30, 'i')[0]],
                                 'max': [self.read(bp - 0x14, 'i')[0], self.read(bp - 0x20, 'i')[0], self.read(bp - 0x28, 'i')[0]]}
        return super().on_instruction(cpu, address, size, data)

    def radius(self, query):
        self.radius_cells = None
        head = self.call(RADIUS_CHECK, self.hash, struct.pack('<I3ffI', self.memstack, *query['location'], query['radius'], 0))
        hits = []
        while head:
            actor = self.read(head + 4, 'I')[0]
            hits.append(self.actors[actor]['id'])
            head = self.read(head, 'I')[0]
        return {'cells': self.radius_cells, 'hits': hits}


def main():
    if len(sys.argv) != 3:
        sys.exit('Usage: native-hash-radius-oracle.py GAME_ROOT CASES_JSON')
    cases = json.loads(Path(sys.argv[2]).read_text())
    results = []
    for case in cases:
        n = RadiusHash(Path(sys.argv[1]), case.get('seed', 1))
        registrations = [n.add(actor) for actor in case['actors']]
        results.append({'registrations': registrations, 'queries': [n.radius(q) for q in case['queries']]})
    print(json.dumps({'results': results}))


if __name__ == '__main__':
    main()
