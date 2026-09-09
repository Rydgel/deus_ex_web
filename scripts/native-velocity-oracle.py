"""Direct comparison oracle for original single-player APawn.calcVelocity.

Shares the hash-gated PE loader and strict import handling with collision research.
Minimal Pawn/LevelInfo memory supplies the fields read by this native function.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)


class NativeVelocity(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.pawn = self.alloc(0x1000)
        level, info, actors = self.alloc(0x1000), self.alloc(0x1000), self.alloc(16)
        self.write(self.pawn + 0x24, 'I', 0x1058c160)  # APlayerPawn class, used by IsA.
        self.write(self.pawn + 0xac, 'I', level)
        self.write(level + 0x2c, 'III', actors, 1, 1)
        self.write(actors, 'I', info)
        self.write(info + 0x24, 'I', 0x1057bf00)  # ALevelInfo class.
        self.write(info + 0x518, 'B', 0)  # NM_Standalone.

    def velocity(self, case):
        # Pawn's fifth boolean is bIsWalking (original Pawn source + native mask).
        self.write(self.pawn + 0x318, 'I', 0x10 if case['walking'] else 0)
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        # physWalking supplies bFluid=0, bBrake=1, bBuoyant=0.
        args = struct.pack('<6f3i', *case['direction'], case['dt'], case['maxSpeed'], case['friction'], 0, 1, 0)
        self.call(0x103cd7a0, self.pawn, args)
        return {'velocity': self.read(self.pawn + 0x144, '3f'),
                'acceleration': self.read(self.pawn + 0x150, '3f')}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-velocity-oracle.py GAME_ROOT CASES_JSON')
    native = NativeVelocity(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.velocity(case) for case in cases]}))
