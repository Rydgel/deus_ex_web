"""Original walking surface prelude (0x103cc450) through its Ladder branch
(0x103cc519-0x103cc6ca) and the native physFlying it calls.

Extends the surface oracle: line queries and the WalkTexture event are the same
controlled callbacks. The scanned texture's Outer name is the case's `group`.
MoveActor (level vtable+0x88) answers every move unobstructed, so the blocked
physFlying branches are covered by native-flying-oracle.py instead. Evidence:
docs/ladder-flying.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('surface', Path(__file__).with_name('native-walking-surface-oracle.py'))
surface = importlib.util.module_from_spec(spec)
spec.loader.exec_module(surface)
b = surface.b


class NativeLadder(surface.NativeSurface):
    def __init__(self, root):
        super().__init__(root)
        self.move = 0x700fe000
        self.cpu.mem_write(self.move, bytes.fromhex('c2 30 00'))
        self.write(self.vtable + 0x88, 'I', self.move)
        self.actors = self.alloc(16)
        self.write(self.level + 0x2c, 'III', self.actors, 1, 1)
        self.write(self.actors, 'I', self.zone)
        self.write(self.pawn + 0xc8, 'I', self.zone)
        self.write(self.pawn + 0xd0, 'B', 1)
        self.write(self.pawn + 0x38c, 'f', 25)

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and address == 0x103cc519:
            return  # Let the original Ladder branch run.
        if self.events is not None and address == self.event:
            st = cpu.reg_read(b.UC_X86_REG_ESP)
            if self.read(st, 'I')[0] == 0x103cc57c:
                params = self.read(st + 8, 'I')[0]
                self.events.append({'ladderWalkTexture': bool(self.read(params, 'I')[0]),
                                    'location': list(self.read(params + 4, '3f')),
                                    'normal': list(self.read(params + 16, '3f'))})
                return
        if self.events is not None and address == self.move:
            st = cpu.reg_read(b.UC_X86_REG_ESP)
            actor, *delta = self.read(st + 4, 'I3f')
            hit = self.read(st + 32, 'I')[0]
            if actor != self.pawn:
                raise RuntimeError('Unexpected MoveActor actor')
            self.events.append({'move': delta, 'velocity': list(self.read(self.pawn + 0x144, '3f'))})
            location = self.read(self.pawn + 0x114, '3f')
            self.write(self.pawn + 0x114, '3f', *[surface.b.struct.unpack('<f', surface.b.struct.pack('<f', a + c))[0]
                                                  for a, c in zip(location, delta)])
            self.write(hit + 4, 'I', 0)
            self.write(hit + 20, '3f', 0, 0, 0)
            self.write(hit + 36, 'f', 1)
            cpu.reg_write(b.UC_X86_REG_EAX, 1)
            return
        super().on_instruction(cpu, address, size, data)

    def ladder(self, case):
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x378, 'f', case['groundSpeed'])
        self.write(self.pawn + 0x380, 'f', case['airSpeed'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        self.write(self.pawn + 0x36c, 'f', 1)
        self.write(self.pawn + 0x3dc, '3i', *case['viewRotation'])
        self.write(self.pawn + 0x318, 'I', 0x10 if case.get('walking') else 0)
        self.write(self.pawn + 0x1ec, 'I', 0)
        self.write(self.zone + 0x31c, '3f', 0, 0, -950)
        self.write(self.zone + 0x328, '3f', 0, 0, 0)
        self.write(self.zone + 0x338, 'f', case['fluidFriction'])
        result = self.run(case)
        result.update({'position': list(self.read(self.pawn + 0x114, '3f')),
                       'velocity': list(self.read(self.pawn + 0x144, '3f')),
                       'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                       'walking': bool(self.read(self.pawn + 0x318, 'I')[0] & 0x10)})
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-ladder-oracle.py GAME_ROOT CASES_JSON')
    native = NativeLadder(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'results': [native.ladder(case) for case in cases]}))
