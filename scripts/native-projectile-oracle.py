"""Execute original AActor::physProjectile (Engine.dll 0x103d4600) with a controlled world.

The body's own instructions (zone test, fluid friction, acceleration, the
Projectile.MaxSpeed clamp through Core's FVector::SafeNormal, the substep loop,
the bounce refund and the final displacement velocity) run in Unicorn from the
hash-checked DLLs. The reached boundaries are controlled doubles:
ULevel::MoveActor (vtable +0x88) moves through a floor plane and axis walls,
ULevel::DestroyActor (+0x94) and physFalling (thunk 0x10302fef) are recorded,
and the HitWall ProcessEvent runs a named script double per case
(`hitWallMode`). This proves physProjectile's arithmetic and control flow, not
MoveActor's geometry or any script body. `coverage` lists the body's
instructions no case executed.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_falling', Path(__file__).with_name('native-falling-oracle.py'))
falling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(falling)
collision = falling.collision
f = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]

PHYS_PROJECTILE = (0x103d4600, 0x103d4a1e)  # up to the SEH unwind funclet
HIT_WALL_CALLER = 0x103d4946                # after ProcessEvent (vtable +0x10)
PHYS_FALLING_THUNK = 0x10302fef             # jmp 0x103d0a50


class NativeProjectile(falling.NativeFalling):
    def __init__(self, root):
        self.projectile_events = None
        self.covered_projectile = set()
        super().__init__(root)
        self.destroy_thunk = 0x700fe030
        self.cpu.mem_write(self.destroy_thunk, bytes.fromhex('c2 08 00'))
        self.write(self.vtable + 0x94, 'I', self.destroy_thunk)

    def world_hit(self, start, delta):
        """First intersection of a point moving by delta with the case's floor
        plane (through the origin) and axis walls [axis, sign, plane]."""
        time, normal = 1.0, [0, 0, 0]
        floor = self.world.get('floorNormal')
        if floor is not None:
            depth = sum(floor[i] * delta[i] for i in range(3))
            if depth < 0:
                candidate = -sum(floor[i] * start[i] for i in range(3)) / depth
                if 0 <= candidate < time:
                    time, normal = candidate, list(floor)
        for axis, sign, plane in self.world.get('walls', []):
            if delta[axis] * sign > 0:
                candidate = (plane - start[axis]) / delta[axis]
                if 0 <= candidate < time:
                    time = candidate
                    normal = [0, 0, 0]
                    normal[axis] = float(sign)
        return time, normal

    def flags(self, set_bits=0, clear_bits=0):
        value = self.read(self.pawn + 0x1ec, 'I')[0]
        self.write(self.pawn + 0x1ec, 'I', (value | set_bits) & ~clear_bits)

    def on_instruction(self, cpu, address, size, data):
        if self.projectile_events is None:
            return super().on_instruction(cpu, address, size, data)
        if PHYS_PROJECTILE[0] <= address < PHYS_PROJECTILE[1]:
            self.covered_projectile.add(address)
        stack = cpu.reg_read(collision.UC_X86_REG_ESP)
        if address == PHYS_FALLING_THUNK:
            self.projectile_events.append({'physFalling': [self.read(stack + 4, 'I')[0], self.read(stack + 8, 'i')[0]]})
            cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(collision.UC_X86_REG_ESP, stack + 12)
            return
        if address == self.destroy_thunk:
            if self.read(stack + 4, 'I')[0] != self.pawn:
                raise RuntimeError('Unexpected DestroyActor actor')
            self.projectile_events.append({'destroy': self.read(stack + 8, 'I')[0]})
            cpu.reg_write(collision.UC_X86_REG_EAX, 1)
            return
        if address == self.event_thunk:
            if self.read(stack, 'I')[0] != HIT_WALL_CALLER:
                raise RuntimeError(f'Unexpected script event caller {self.read(stack, "I")[0]:x}')
            parameters = self.read(stack + 8, 'I')[0]
            normal = list(self.read(parameters, '3I'))
            self.projectile_events.append({'hitWall': normal, 'actor': self.actor_name(self.read(parameters + 12, 'I')[0])})
            mode = self.case.get('hitWallMode', 'none')
            if mode == 'falling':
                self.write(self.pawn + 0x30, 'B', 2)
            elif mode == 'destroy':
                self.write(self.pawn + 0x28, 'I', self.read(self.pawn + 0x28, 'I')[0] | 0x80)
            elif mode == 'teleport':
                self.flags(0x100)
            else:
                self.hit_wall_script([f(struct.unpack('<f', struct.pack('<I', n))[0]) for n in normal])
            return
        if address == self.move_thunk:
            actor, *delta = self.read(stack + 4, 'I3f')
            if actor != self.pawn:
                raise RuntimeError('Unexpected MoveActor actor')
            hit = self.read(stack + 32, 'I')[0]
            start = list(self.read(self.pawn + 0x114, '3f'))
            time, normal = self.world_hit(start, delta)
            location = [f(a + f(b * time)) for a, b in zip(start, delta)]
            self.write(self.pawn + 0x114, '3f', *location)
            self.write(hit + 4, 'I', self.zone if time < 1 else 0)
            self.write(hit + 8, '3f', *location)
            self.write(hit + 20, '3f', *normal)
            self.write(hit + 36, 'f', f(time))
            self.projectile_events.append({'move': list(self.read(stack + 8, '3I')), 'time': f(time),
                                           'normal': [f(v) for v in normal]})
            moves = sum(1 for event in self.projectile_events if 'move' in event) - 1
            if self.case.get('deleteAtMove') == moves:
                self.write(self.pawn + 0x28, 'I', self.read(self.pawn + 0x28, 'I')[0] | 0x80)
            if self.case.get('teleportAtMove') == moves:
                self.flags(0x100)
            cpu.reg_write(collision.UC_X86_REG_EAX, 1)
            return
        if address == self.line_thunk:
            raise RuntimeError('physProjectile reached an unexpected line query')
        super().on_instruction(cpu, address, size, data)

    def projectile(self, case):
        self.case, self.world, self.last_hit = case, case, [0.0, 0.0, 0.0]
        # Engine.Projectile ancestry (the MaxSpeed clamp's IsA at 0x103d47b6)
        # or an unrelated non-Pawn class.
        self.write(self.pawn + 0x24, 'I', self.ancestry['fragment'] if case.get('projectile', True) else self.nonpawn_class)
        self.write(self.pawn + 0x28, 'I', 0)
        self.write(self.pawn + 0x30, 'B', 6)
        self.write(self.pawn + 0xd0, 'B', case.get('zoneNumber', 1))
        self.write(self.pawn + 0x1ec, 'I', (0x10 if case.get('bounce') else 0) | (0x100 if case.get('justTeleported') else 0))
        self.write(self.pawn + 0x114, '3I', *case['position'])
        self.write(self.pawn + 0x12c, '3I', 0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5)
        self.write(self.pawn + 0x144, '3I', *case['velocity'])
        self.write(self.pawn + 0x150, '3I', *case['acceleration'])
        self.write(self.pawn + 0x120, '3i', 0, 0, 0)
        self.write(self.pawn + 0x31c, 'I', case.get('maxSpeed', 0))
        self.write(self.zone + 0x388, 'I', 1 if case.get('water') else 0)
        self.write(self.zone + 0x338, 'I', case.get('fluidFriction', 0))
        self.projectile_events = []
        self.call(0x103d4600, self.pawn, struct.pack('<Ii', case['dt'], case.get('iterations', 0)))
        flags = self.read(self.pawn + 0x1ec, 'I')[0]
        result = {'position': list(self.read(self.pawn + 0x114, '3I')),
                  'oldPosition': list(self.read(self.pawn + 0x12c, '3I')),
                  'velocity': list(self.read(self.pawn + 0x144, '3I')),
                  'physics': self.read(self.pawn + 0x30, 'B')[0],
                  'bounce': bool(flags & 0x10), 'justTeleported': bool(flags & 0x100),
                  'events': self.projectile_events}
        self.projectile_events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-projectile-oracle.py GAME_ROOT CASES_JSON')
    native = NativeProjectile(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    results = [native.projectile(case) for case in cases]
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    lo, hi = PHYS_PROJECTILE
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    body = [i.address for i in md.disasm(bytes(native.cpu.mem_read(lo, hi - lo)), lo)]
    print(json.dumps({'hashes': collision.HASHES, 'results': results,
                      'uncovered': [hex(a) for a in body if a not in native.covered_projectile]}))
