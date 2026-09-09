"""Run original stair/corner functions with explicitly controlled surroundings.

TwoWallAdjust runs directly from the supplied DLL, without function substitutes.
stepUp executes its original instructions, but MoveActor and processHitWall are
controlled callbacks. Those tests prove the step algorithm's requests/results,
not collision-world or script-event fidelity. These two bridges are explicit.
Research-only; the browser never loads or executes original native binaries.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)


class NativeSteps(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.pawn, self.level, self.vtable = self.alloc(0x1000), self.alloc(0x1000), self.alloc(0x100)
        self.hit = self.alloc(48)
        self.world_actor, self.decoration = self.alloc(0x400), self.alloc(0x400)
        self.move_thunk = 0x700fe000
        self.cpu.mem_write(self.move_thunk, bytes.fromhex('c2 30 00'))
        self.write(self.pawn + 0xac, 'I', self.level)
        self.write(self.level, 'I', self.vtable)
        self.write(self.vtable + 0x88, 'I', self.move_thunk)
        self.write(self.world_actor + 0x24, 'I', 0x1057bf00)  # ALevelInfo, non-decoration.
        self.write(self.decoration + 0x24, 'I', 0x10578d48)  # ADecoration.
        self.write(self.decoration + 0x31c, 'I', 1)  # bPushable.
        self.events = None

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and address == self.move_thunk:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            actor, *delta = self.read(stack + 4, 'I3f')
            hit, *flags = self.read(stack + 32, '5I')
            if actor != self.pawn or hit != self.hit or any(flags):
                raise RuntimeError('Unexpected MoveActor callback contract')
            if self.move_index >= len(self.responses):
                raise RuntimeError('Missing explicit MoveActor response')
            response = self.responses[self.move_index]
            self.move_index += 1
            self.events.append({'move': delta})
            pushable = response.get('pushableDecoration', False)
            hit_actor = self.decoration if pushable else self.world_actor
            self.write(self.decoration + 0x1f4, 'f', response.get('mass', 100))
            self.write(hit + 4, 'I', hit_actor)
            self.write(hit + 20, '3f', *response['normal'])
            self.write(hit + 36, 'f', response['time'])
            cpu.reg_write(collision.UC_X86_REG_EAX, 1)
            return
        if self.events is not None and address == 0x103cecc0:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            normal = list(self.read(stack + 4, '3f'))
            self.events.append({'wall': normal})
            if self.wall_index >= len(self.wall_physics):
                raise RuntimeError('Missing explicit processHitWall response')
            self.write(self.pawn + 0x30, 'B', self.wall_physics[self.wall_index])
            self.wall_index += 1
            cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(collision.UC_X86_REG_ESP, stack + 20)
            return
        super().on_instruction(cpu, address, size, data)

    def two_wall(self, case):
        vectors = [self.alloc(12) for _ in range(4)]
        for address, field in zip(vectors, ['desired', 'delta', 'normal', 'oldNormal']):
            self.write(address, '3f', *case[field])
        self.call(0x10323770, 0, struct.pack('<4If', *vectors, case['time']))
        return list(self.read(vectors[1], '3f'))

    def step(self, case):
        self.responses, self.wall_physics = case['responses'], case['wallPhysics']
        self.events, self.move_index, self.wall_index = [], 0, 0
        self.write(self.pawn + 0x24, 'I', 0x1058c160 if case['isPlayer'] else 0)
        self.write(self.pawn + 0x30, 'B', case['physics'])
        self.write(self.pawn + 0x38c, 'f', case['maxStepHeight'])
        self.write(self.pawn + 0x1f4, 'f', case['mass'])
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x1ec, 'I', 0)
        self.call(0x103ce4a0, self.pawn, struct.pack('<9fI', *case['gravity'], *case['desired'], *case['delta'], self.hit))
        result = {'events': self.events, 'physics': self.read(self.pawn + 0x30, 'B')[0],
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'justTeleported': bool(self.read(self.pawn + 0x1ec, 'I')[0] & 0x100),
                  'hit': {'time': self.read(self.hit + 36, 'f')[0], 'normal': list(self.read(self.hit + 20, '3f'))}}
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-steps-oracle.py GAME_ROOT CASES_JSON')
    native = NativeSteps(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.step(case) if case.get('type') == 'step' else native.two_wall(case) for case in cases]}))
