"""Execute the original APawn::physicsRotation (Engine.dll 0x103c9f30).

The unchanged body runs on a Pawn-class actor (or a PlayerPawn for the control): the class-chain
tests (PlayerPawn 0x1058c160, Pawn 0x1058c660), the two _ftol conversions, fixRotation (0x10303b34
into the original body), the Pitch clamp and the final comparison. ULevel::MoveActor is a controlled
stub behind the level vtable slot +0x88 that records its NewRotation (the real body is covered by
native-actor-rotation-oracle.py); `ret 0x30` takes its twelve argument dwords. Output per case: the
motion word (+0x1ec) afterwards and the MoveActor calls (rotation args), or none.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

PAWN_PHYSICS_ROTATION = 0x103c9f30
PLAYER_PAWN, PAWN = 0x1058c160, 0x1058c660


class NativePawnRotation(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = None
        self.move_thunk = 0x700fe060
        self.cpu.mem_write(self.move_thunk, bytes.fromhex('c2 30 00'))  # ULevel::MoveActor stub
        self.level_vtable, self.level = self.alloc(0x200), self.alloc(0x2000)
        self.write(self.level_vtable + 0x88, 'I', self.move_thunk)
        self.write(self.level, 'I', self.level_vtable)
        # PlayerPawn extends Pawn extends (the chain's end).
        self.write(PAWN + 0x28, 'I', 0)
        self.write(PLAYER_PAWN + 0x28, 'I', PAWN)
        # A ScriptedPawn-like class: its SuperField chain reaches Pawn, never PlayerPawn.
        self.script_class = self.alloc(0x40)
        self.write(self.script_class + 0x28, 'I', PAWN)
        # A class that is not a Pawn (an actor class): the chain ends without reaching either.
        self.other_class = self.alloc(0x40)
        self.write(self.other_class + 0x28, 'I', 0)
        self.pawn = self.alloc(0x1000)

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and address == self.move_thunk:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            actor, *rest = self.read(stack + 4, 'I3f3iI4I')
            self.events.append({'moveActor': {'delta': rest[0:3], 'rotation': rest[3:6]}})
        return super().on_instruction(cpu, address, size, data)

    def run(self, case):
        pawn = self.pawn
        cls = {'script': self.script_class, 'player': PLAYER_PAWN, 'pawn': PAWN, 'other': self.other_class}[case['class']]
        self.write(pawn, 'I', 0)
        self.write(pawn + 0x24, 'I', cls)
        self.write(pawn + 0xac, 'I', self.level)
        self.write(pawn + 0x30, 'B', case['physics'])
        self.write(pawn + 0x120, '3i', *case['rotation'])
        self.write(pawn + 0x1ec, 'I', case['motion'])
        self.write(pawn + 0x1fc, '3i', *case['rotationRate'])
        self.write(pawn + 0x208, '3i', *case['desiredRotation'])
        self.events = []
        # physicsRotation(FLOAT DeltaTime, FVector OldVelocity): `ret 0x10`.
        self.call(PAWN_PHYSICS_ROTATION, pawn, struct.pack('<4f', case['dt'], 0, 0, 0))
        result = {'motion': self.read(pawn + 0x1ec, 'I')[0], 'events': self.events}
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-pawn-rotation-oracle.py GAME_ROOT CASES_JSON')
    native = NativePawnRotation(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.run(case) for case in cases]}))
