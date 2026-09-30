"""Original full noncolliding MoveActor, with only SetActorZone observed.

The original CheckEncroachment body executes. No scene-mutation instructions
are skipped. The zone virtual call is the declared boundary; zone.rs already
has its separate original reference. JSON stdin supplies cases.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Oracle(native.NativeCollision):
    def __init__(self, root):
        self.active = False
        super().__init__(root)
        self.source, self.level, self.world, self.hit = [self.alloc(n) for n in (0x800, 0x1200, 0x800, 48)]
        table, actors, cls = self.alloc(0x100), self.alloc(4), self.alloc(0x100)
        self.write(self.level, 'I', table)
        self.write(self.level + 0x2c, 'III', actors, 1, 1)
        self.write(actors, 'I', self.world)
        self.write(cls + 0x28, 'I', 0x1057cdf0)  # a subclass of original Actor, not Pawn/Brush
        self.write(self.source + 0x24, 'I', cls)
        self.write(self.source + 0xa8, 'I', self.world)
        self.write(table + 0xb8, 'I', 0x1039a350)  # original CheckEncroachment
        self.zone = 0x700fd000
        self.cpu.mem_write(self.zone, bytes.fromhex('c20c00'))
        self.write(table + 0xac, 'I', self.zone)

    def on_instruction(self, cpu, address, size, data):
        if self.active:
            if address == 0x1039a350:
                self.encroachments += 1
            if address == self.zone:
                sp = cpu.reg_read(native.UC_X86_REG_ESP)
                actor, test, force = self.read(sp + 4, 'III')
                if actor != self.source:
                    raise RuntimeError('Unexpected zone actor')
                self.zones.append({'test': test, 'force': force,
                                   'position': self.read(actor + 0x114, '3f'),
                                   'rotation': self.read(actor + 0x120, '3i')})
        super().on_instruction(cpu, address, size, data)

    def capture(self, case):
        p = self.source
        self.write(p + 0x28, 'I', 0x80000)
        self.write(p + 0x114, '3f', *case['position'])
        self.write(p + 0x120, '3i', *case.get('rotation', [0, 0, 0]))
        self.write(p + 0x12c, '3f', *case.get('oldLocation', [11, 22, 33]))
        self.write(p + 0x1d4, '2f', *case.get('extent', [17, 42]))
        self.write(p + 0x1dc, 'I', 0)
        self.write(self.hit, '44s', bytes(44))
        self.write(self.hit + 36, 'fi', 1, -1)
        self.zones, self.encroachments = [], 0
        self.active = True
        result = self.call(0x103990e0, self.level, struct.pack('<I3f3iI4I', p,
            *case['delta'], *case.get('newRotation', [0, 0, 0]), self.hit, 0, 0, 1, 0))
        self.active = False
        return {'success': bool(result), 'position': self.read(p + 0x114, '3f'),
                'rotation': self.read(p + 0x120, '3i'), 'oldLocation': self.read(p + 0x12c, '3f'),
                'time': self.read(self.hit + 36, 'f')[0], 'hit': self.read(self.hit + 4, 'I')[0],
                'zones': self.zones, 'encroachments': self.encroachments}


if __name__ == '__main__':
    oracle = Oracle(Path(sys.argv[1]))
    cases = json.load(sys.stdin)
    print(json.dumps({'hashes': native.HASHES, 'results': [oracle.capture(case) for case in cases]}))
