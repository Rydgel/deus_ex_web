"""Execute original APawn.physFlying (Engine.dll 0x103d3040) with controlled world callbacks.

The original physics/math instructions run in Unicorn, including calcVelocity
(0x103cd7a0, called with bFluid=1, bBrake=0, bBuoyant=0), Core FVector.SafeNormal,
stepUp (0x103ce4a0) and TwoWallAdjust. MoveActor and processHitWall
(0x103cecc0) are explicit test doubles from the falling harness, so this does not
prove world collision or the processHitWall body; it records their arguments.

Evidence and the branch map: docs/ladder-flying.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_falling', Path(__file__).with_name('native-falling-oracle.py'))
falling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(falling)
collision = falling.collision


class NativeFlying(falling.NativeFalling):
    def flying(self, case):
        self.case, self.last_hit = case, [0.0, 0.0, 0.0]
        self.responses, self.move_index = case['responses'], 0
        self.air_blocked = False
        cls = self.nonpawn_class if case.get('nonPlayer') else 0x1058c160
        self.write(self.pawn + 0x24, 'I', cls)
        self.write(self.pawn + 0x28, 'I', 0)
        self.write(self.pawn + 0x30, 'B', 4)  # PHYS_Flying
        # +0x1ec bit 0x100 is bJustTeleported; physFlying clears it before moving.
        self.write(self.pawn + 0x1ec, 'I', 0x100 if case.get('justTeleported') else 0)
        self.write(self.pawn + 0x318, 'I', 0x10 if case.get('walking') else 0)  # bIsWalking
        self.write(self.pawn + 0x114, '3f', *case['position'])
        self.write(self.pawn + 0x12c, '3f', 0, 0, 0)
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x380, 'f', case['airSpeed'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        self.write(self.pawn + 0x36c, 'f', case.get('desiredSpeed', 1))
        self.write(self.zone + 0x31c, '3f', *case['gravity'])
        self.write(self.zone + 0x328, '3f', *case['zoneVelocity'])
        self.write(self.zone + 0x338, 'f', case['fluidFriction'])
        self.events = []
        self.call(0x103d3040, self.pawn, struct.pack('<fi', case['dt'], 0))
        result = {'position': list(self.read(self.pawn + 0x114, '3f')),
                  'oldLocation': list(self.read(self.pawn + 0x12c, '3f')),
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                  'justTeleported': bool(self.read(self.pawn + 0x1ec, 'I')[0] & 0x100),
                  'events': self.events}
        self.events = None
        return result

    def on_instruction(self, cpu, address, size, data):
        # A MoveActor whose touch teleports the pawn sets bJustTeleported; the
        # case names the move index (the flag is otherwise never set here).
        if self.events is not None and address == self.move_thunk and self.case.get('teleportAtMove') == self.move_index:
            self.write(self.pawn + 0x1ec, 'I', self.read(self.pawn + 0x1ec, 'I')[0] | 0x100)
        super().on_instruction(cpu, address, size, data)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-flying-oracle.py GAME_ROOT CASES_JSON')
    native = NativeFlying(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.flying(case) for case in cases]}))
