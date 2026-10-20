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
spec = importlib.util.spec_from_file_location('native_o3_replay', Path(__file__).with_name('native-o3-replay.py'))
o3r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o3r)


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

    def o3(self, case):
        """A call Play recorded (scripts/o3-adapters.mjs, docs/stage-5-exit-criteria.md "O3"): physFlying from Play's entry state, its MoveActor and
        processHitWall answered from the recorded events. Returns the native's events and final tracked state."""
        cfg = case['config']
        if cfg['netMode'] != 0 or cfg['zoneNumber'] == 0 and cfg['collideWorld']:
            raise RuntimeError('an unsupported physFlying configuration was recorded (network mode or out of the world)')
        self.case, self.last_hit, self.responses, self.move_index, self.air_blocked = {}, [0.0] * 3, [], 0, False
        replay = self.replay = o3r.Replay(self, case, self.zone)
        self.write(self.pawn + 0x24, 'I', 0x1058c160 if cfg['isPlayerPawn'] else self.nonpawn_class)
        self.write(self.pawn + 0x28, 'I', 0)
        self.write(self.pawn + 0x1dc, 'I', 2 if cfg['collideWorld'] else 0)
        self.write(self.pawn + 0xd0, 'B', cfg['zoneNumber'])
        self.write(self.pawn + 0x318, 'I', o3r.IS_PLAYER if cfg['isPlayer'] else 0)
        for offset, key in [(0x380, 'airSpeed'), (0x384, 'accelRate'), (0x36c, 'desiredSpeed'), (0x1f4, 'mass'), (0x38c, 'maxStepHeight')]:
            self.write(self.pawn + offset, 'f', cfg[key])
        self.write(self.pawn + 0x1d4, '2f', cfg['radius'], cfg['height'])
        self.write(self.zone + 0x31c, '3f', *cfg['gravity'])
        self.write(self.zone + 0x328, '3f', *cfg['zoneVelocity'])
        self.write(self.zone + 0x338, 'f', cfg['fluidFriction'])
        replay.install(case['before']['state'])
        self.events = []
        try:
            self.call(0x103d3040, self.pawn, struct.pack('<fi', cfg['dt'], cfg['iterations']))
            replay.done()
            result = {'events': replay.events, 'after': replay.snapshot()}
        except o3r.Divergence as error:
            result = {'diverged': str(error), 'events': replay.events}
        self.events = self.replay = None
        return result

    def on_instruction(self, cpu, address, size, data):
        # A MoveActor whose touch teleports the pawn sets bJustTeleported; the
        # case names the move index (the flag is otherwise never set here).
        if self.events is not None and address == self.move_thunk and self.case.get('teleportAtMove') == self.move_index:
            self.write(self.pawn + 0x1ec, 'I', self.read(self.pawn + 0x1ec, 'I')[0] | 0x100)
        super().on_instruction(cpu, address, size, data)


if __name__ == '__main__':
    if len(sys.argv) not in (3, 4):
        sys.exit('Usage: native-flying-oracle.py GAME_ROOT CASES_JSON [--o3]')
    native = NativeFlying(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    if '--o3' in sys.argv:
        print(json.dumps({'hashes': collision.HASHES, 'results': [native.o3(case) for case in cases]}))
        sys.exit(0)
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.flying(case) for case in cases]}))
