"""Execute original AActor.physRolling (Engine.dll 0x103d4b80) with controlled world.

Original friction/substep/drop/falling instructions run in Unicorn. ULevel::MoveActor
is a controlled world model (floor plane + axis walls) and script event dispatch,
setPhysics/SetSupportBase/physFalling are named boundaries: this proves physRolling's
decision logic and arithmetic, not MoveActor's own geometry or the script bodies.
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
f = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]

# Event dispatch return addresses inside physRolling 0x103d4b80-0x103d58c5.
ROLLING_EVENT_CALLERS = {0x103d4fd3: 'HitWall', 0x103d51e3: 'HitWall', 0x103d56b4: 'Falling'}
PHYS_FALLING_THUNK = 0x10302fef  # jmp 0x103d0a50


class NativeRolling(falling.NativeFalling):
    def __init__(self, root):
        self.rolling_events = None
        self.world = None
        super().__init__(root)

    def world_hit(self, start, delta):
        """First intersection of a point travelling by delta against the controlled
        world: a floor plane (normal, through origin) and axis walls [axis,sign,plane]."""
        time, normal = 1.0, [0, 0, 0]
        floor = self.world.get('floorNormal', [0, 0, 1])
        depth = sum(floor[i] * delta[i] for i in range(3))
        if depth < 0:
            candidate = -sum(floor[i] * start[i] for i in range(3)) / depth
            if 0 <= candidate < time:
                time, normal = candidate, list(floor)
        for axis, sign, plane in self.world.get('walls', []):
            speed = delta[axis] * sign
            if speed > 0:
                candidate = (plane - start[axis]) / delta[axis]
                if 0 <= candidate < time:
                    time = candidate
                    normal = [0, 0, 0]
                    normal[axis] = float(sign)
        return time, normal

    def on_instruction(self, cpu, address, size, data):
        if self.rolling_events is None:
            return super().on_instruction(cpu, address, size, data)
        stack = cpu.reg_read(collision.UC_X86_REG_ESP)
        if address == PHYS_FALLING_THUNK:
            self.rolling_events.append({'physFalling': [self.read(stack + 4, 'f')[0], self.read(stack + 8, 'i')[0]]})
            cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(collision.UC_X86_REG_ESP, stack + 12)
            return
        if address == self.event_thunk:
            caller = self.read(stack, 'I')[0]
            name = ROLLING_EVENT_CALLERS.get(caller)
            if name is None:
                raise RuntimeError(f'Unexpected rolling event caller {caller:x}')
            self.rolling_events.append({'event': name})
            return
        if address == self.move_thunk:
            actor, *delta = self.read(stack + 4, 'I3f')
            if actor != self.pawn:
                raise RuntimeError('Unexpected rolling MoveActor actor')
            hit = self.read(stack + 32, 'I')[0]
            start = list(self.read(self.pawn + 0x114, '3f'))
            time, normal = self.world_hit(start, delta)
            location = [f(a + f(b * time)) for a, b in zip(start, delta)]
            self.write(self.pawn + 0x114, '3f', *location)
            self.write(hit + 8, '3f', *location)
            self.write(hit + 4, 'I', 0)
            self.write(hit + 20, '3f', *normal)
            self.write(hit + 36, 'f', f(time))
            self.rolling_events.append({'move': [f(v) for v in delta], 'time': f(time),
                                        'normal': [f(v) for v in normal], 'position': location})
            cpu.reg_write(collision.UC_X86_REG_EAX, 1)
            return
        if address == self.line_thunk:
            raise RuntimeError('physRolling reached an unexpected line query')
        super().on_instruction(cpu, address, size, data)

    def rolling(self, case):
        self.world = case
        self.write(self.pawn + 0x24, 'I', 0x1058c160)  # PlayerPawn class keeps event lookup resolvable.
        self.write(self.pawn + 0x30, 'B', case.get('physics', 7))
        # +0x1ec bitfield: bJustTeleported (0x100) and bBounce (0x10, the physRolling
        # wall branch at 0x103d4fd3 that refunds time and skips the slide).
        self.write(self.pawn + 0x1ec, 'I', (0x100 if case.get('justTeleported') else 0) | (0x10 if case.get('bounce') else 0))
        self.write(self.pawn + 0x114, '3f', *case['position'])
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x120, '3f', 0, 0, 0)
        self.write(self.pawn + 0xc4, 'I', case.get('base', 0) or 0)
        self.write(self.zone + 0x31c, '3f', *case['zone']['ZoneGravity'])
        self.write(self.zone + 0x328, '3f', *case['zone']['ZoneVelocity'])
        self.write(self.zone + 0x334, 'f', case['zone']['ZoneGroundFriction'])
        self.write(self.zone + 0x338, 'f', case['zone']['ZoneFluidFriction'])
        self.write(self.zone + 0x33c, 'f', case['zone'].get('ZoneTerminalVelocity', 2500))
        self.rolling_events = []
        self.call(0x103d4b80, self.pawn, struct.pack('<fi', case['dt'], case.get('iterations', 0)))
        result = {'position': list(self.read(self.pawn + 0x114, '3f')),
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                  'physics': self.read(self.pawn + 0x30, 'B')[0],
                  'base': self.read(self.pawn + 0xc4, 'I')[0],
                  'events': self.rolling_events}
        self.rolling_events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-rolling-oracle.py GAME_ROOT CASES_JSON')
    native = NativeRolling(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.rolling(case) for case in cases]}))
