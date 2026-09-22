"""Execute original AActor.physFalling with controlled world callbacks.

Original DLL physics/math instructions run in Unicorn. MoveActor, line queries,
processHitWall and processLanded are explicit test doubles, so this harness does
not prove world collision or landing-handler parity. The original empty
Pawn.WalkTexture event is a named, checked callback.

bBounce cases (actor+0x1ec bit 0x10) reach the original direct script HitWall
dispatch (ProcessEvent from 0x103d1dcf). Its script body is a named, controlled
test double selected per case (`hitWallMode`): it does not prove UnrealScript VM
arithmetic, only what physFalling does around the event.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)
f = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]


class NativeFalling(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = None
        self.call(0x10102978, 0x101b3218, b'')  # Original FGlobalMath constructor, including trig tables.
        self.pawn, self.level, self.zone = self.alloc(0x1000), self.alloc(0x1000), self.alloc(0x1000)
        self.vtable, self.actor_table = self.alloc(0x200), self.alloc(16)
        self.move_thunk, self.line_thunk = 0x700fe000, 0x700fe010
        self.event_thunk = 0x700fe020
        self.actor_vtable = self.alloc(0x20)
        self.cpu.mem_write(self.move_thunk, bytes.fromhex('c2 30 00'))
        self.cpu.mem_write(self.line_thunk, bytes.fromhex('c2 24 00'))
        self.cpu.mem_write(self.event_thunk, bytes.fromhex('c2 0c 00'))
        self.write(self.actor_vtable + 0x10, 'I', self.event_thunk)
        self.write(self.pawn, 'I', self.actor_vtable)
        self.write(self.vtable + 0x88, 'I', self.move_thunk)
        self.write(self.vtable + 0xc0, 'I', self.line_thunk)
        self.write(self.level, 'I', self.vtable)
        self.write(self.level + 0x2c, 'III', self.actor_table, 1, 1)
        self.write(self.actor_table, 'I', self.zone)
        self.write(self.zone + 0x24, 'I', 0x1057bf00)  # ALevelInfo.
        self.write(0x1058c160 + 0x28, 'I', 0x1058c660)  # PlayerPawn extends Pawn.
        self.write(self.pawn + 0x24, 'I', 0x1058c160)
        self.write(self.pawn + 0xac, 'I', self.level)
        self.write(self.pawn + 0xc8, 'I', self.zone)
        self.write(self.pawn + 0xd0, 'B', 1)  # Valid world zone.
        self.write(self.pawn + 0x330, 'I', self.zone)  # FootRegion.Zone.
        self.write(self.pawn + 0x31, 'B', 4)  # ROLE_Authority.
        self.write(self.pawn + 0x1d4, '2f', 20, 43)
        self.write(self.pawn + 0x38c, 'f', 25)
        # A non-Pawn class (e.g. a pushed Decoration) whose SuperField chain reaches
        # neither Pawn (0x1058c660) nor PlayerPawn (0x1058c160) nor ADecoration
        # (0x10578d48, whose bBobbing half-gravity integration at 0x103d0f42 tests
        # Decoration+0x31c bit 8, not bBounce). physFalling reads +0x24 only through its inlined IsA walks
        # (each reads class->SuperField at +0x28), so a null SuperField makes every
        # IsA(target) false: the air-control/accel-clamp prelude and both Pawn-only
        # integration branches are skipped, leaving the general integration path.
        self.nonpawn_class = self.alloc(0x40)
        self.write(self.nonpawn_class + 0x28, 'I', 0)
        # Real non-Pawn ancestry for the fragment and inventory cases:
        # WoodFragment -> DeusExFragment -> Fragment -> AProjectile -> AActor and
        # Lockpick -> SkilledTool -> DeusExPickup -> Pickup -> AInventory -> AActor.
        # The script classes are fake UClass records (the inlined IsA walks read
        # only SuperField +0x28); the native parents are the DLL's own static
        # classes (?PrivateStaticClass@AProjectile/AInventory/AActor exports).
        self.actor_class, self.projectile_class, self.inventory_class = 0x1057cdf0, 0x10578850, 0x10576f70
        self.write(self.actor_class + 0x28, 'I', 0)
        self.ancestry = {'fragment': self.script_chain(self.projectile_class, 3),
                         'inventory': self.script_chain(self.inventory_class, 4)}
        self.events = None

    def script_chain(self, native_parent, depth):
        self.write(native_parent + 0x28, 'I', self.actor_class)
        parent = native_parent
        for _ in range(depth):
            cls = self.alloc(0x40)
            self.write(cls + 0x28, 'I', parent)
            parent = cls
        return parent

    def actor_name(self, pointer):
        if pointer == self.zone:
            return 'level'
        if pointer == 0:
            return None
        raise RuntimeError(f'Unexpected hit actor {pointer:x}')

    def hit_wall_script(self, normal):
        """Controlled script HitWall body for a bouncing source (case hitWallMode)."""
        mode = self.case.get('hitWallMode', 'none')
        velocity = list(self.read(self.pawn + 0x144, '3f'))
        location = list(self.read(self.pawn + 0x114, '3f'))

        def reflect(v):
            # Fragment.HitWall: Velocity = Elasticity*((Velocity dot HitNormal)*HitNormal*(-2.0) + Velocity)
            e = f(self.case['elasticity'])
            d = f((v[0] * normal[0] + v[1] * normal[1]) + v[2] * normal[2])
            return [f(e * f(f(f(d * n) * -2.0) + a)) for a, n in zip(v, normal)]

        def stop():
            # SetPhysics(PHYS_None): the original setPhysics zeroes Velocity and
            # Acceleration on entering PHYS_None; bBounce = false follows.
            self.write(self.pawn + 0x30, 'B', 0)
            self.write(self.pawn + 0x144, '3f', 0, 0, 0)
            self.write(self.pawn + 0x150, '3f', 0, 0, 0)
            self.write(self.pawn + 0x1ec, 'I', self.read(self.pawn + 0x1ec, 'I')[0] & ~0x10)

        if mode == 'none':
            return
        if mode == 'stop':
            return stop()
        if mode == 'clearBounce':
            self.write(self.pawn + 0x1ec, 'I', self.read(self.pawn + 0x1ec, 'I')[0] & ~0x10)
            return
        if mode == 'reflect':
            self.write(self.pawn + 0x144, '3f', *reflect(velocity))
            return
        if mode == 'fragment':
            # DeusExFragment.HitWall: stuck -> zero, else reflect; then rest on a
            # floor when slow ((speed < 60 && HitNormal.Z > 0.7) || speed == 0).
            v = [0.0, 0.0, 0.0] if location == self.last_hit else reflect(velocity)
            self.write(self.pawn + 0x144, '3f', *v)
            speed = f(math.sqrt((v[0] * v[0] + v[1] * v[1]) + v[2] * v[2]))
            if (speed < 60 and normal[2] > 0.7) or speed == 0:
                stop()
            self.last_hit = location
            return
        raise RuntimeError(f'Unknown hitWallMode {mode}')

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and address in [0x103cecc0, 0x103cef60]:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            normal = list(self.read(stack + 4, '3f'))
            event = {'wall': normal} if address == 0x103cecc0 else {
                'landed': normal, 'remaining': self.read(stack + 20, 'f')[0],
                'iterations': self.read(stack + 24, 'i')[0], 'velocity': list(self.read(self.pawn + 0x144, '3f'))}
            self.events.append(event)
            if address == 0x103cef60:
                self.write(self.pawn + 0x30, 'B', 1)
            cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(collision.UC_X86_REG_ESP, stack + (20 if address == 0x103cecc0 else 28))
            return
        if self.events is not None and address == self.event_thunk:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            caller = self.read(stack, 'I')[0]
            if caller == 0x103d1dcf:
                # bBounce: ProcessEvent(FindFunctionChecked(NAME_HitWall), &Parms)
                # with Parms {HitNormal, Wall} built at 0x103d1d8c-0x103d1db2.
                parameters = self.read(stack + 8, 'I')[0]
                normal = list(self.read(parameters, '3f'))
                self.events.append({'hitWallEvent': normal, 'actor': self.actor_name(self.read(parameters + 12, 'I')[0]),
                                    'velocity': list(self.read(self.pawn + 0x144, '3f'))})
                self.hit_wall_script(normal)
                return
            if caller not in [0x103cc820, 0x103cc57c]:
                raise RuntimeError(f'Unsupported script event caller {caller:x}')
            self.events.append({'event': 'WalkTexture'})
            return
        if self.events is not None and address in [self.move_thunk, self.line_thunk]:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            if address == self.move_thunk:
                actor, *delta = self.read(stack + 4, 'I3f')
                hit = self.read(stack + 32, 'I')[0]
                if actor != self.pawn:
                    raise RuntimeError('Unexpected MoveActor actor')
                self.events.append({'move': delta, 'velocity': list(self.read(self.pawn + 0x144, '3f'))})
                response = self.responses[self.move_index]
                self.move_index += 1
                location = self.read(self.pawn + 0x114, '3f')
                self.write(self.pawn + 0x114, '3f', *[a + f(b * response['time']) for a, b in zip(location, delta)])
                self.write(hit + 8, '3f', *self.read(self.pawn + 0x114, '3f'))
                self.write(hit + 4, 'I', self.zone if response['time'] < 1 else 0)
                self.write(hit + 20, '3f', *response['normal'])
                self.write(hit + 36, 'f', response['time'])
                if self.case.get('deleteAtMove') == self.move_index - 1:
                    # A touch/bump during this MoveActor destroyed the source.
                    self.write(self.pawn + 0x28, 'I', self.read(self.pawn + 0x28, 'I')[0] | 0x80)
            else:
                hit, actor, end, start, flags = self.read(stack + 4, '5I')
                self.events.append({'line': {'start': list(self.read(start, '3f')), 'end': list(self.read(end, '3f')),
                                             'extent': list(self.read(stack + 24, '3f')), 'flags': flags}})
                self.write(hit + 8, '3f', *self.read(end, '3f'))
                air_probe = self.read(stack, 'I')[0] == 0x103d0d08
                self.write(hit + 4, 'I', self.zone if air_probe and self.air_blocked else 0)
                self.write(hit + 20, '3f', 0, 0, 0)
                self.write(hit + 36, 'f', .5 if air_probe and self.air_blocked else 1)
            cpu.reg_write(collision.UC_X86_REG_EAX, 1)
            return
        super().on_instruction(cpu, address, size, data)

    def falling(self, case):
        self.case, self.last_hit = case, [0.0, 0.0, 0.0]
        self.responses, self.move_index = case['responses'], 0
        self.air_blocked = case['airBlocked']
        # Select a Pawn (default), a non-Pawn actor such as a pushed Decoration
        # (null SuperField), or a real fragment/inventory ancestry.
        cls = self.ancestry.get(case.get('ancestry'))
        if cls is None:
            cls = self.nonpawn_class if case.get('nonPawn') else 0x1058c160
        self.write(self.pawn + 0x24, 'I', cls)
        self.write(self.pawn + 0x28, 'I', 0)
        self.write(self.pawn + 0x30, 'B', 2)
        self.write(self.pawn + 0x1ec, 'I', 0x10 if case.get('bounce') else 0)
        self.write(self.pawn + 0x114, '3f', *case['position'])
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x378, 'f', case['groundSpeed'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        self.write(self.pawn + 0x390, 'f', case['airControl'])
        self.write(self.zone + 0x31c, '3f', *case['gravity'])
        self.write(self.zone + 0x328, '3f', *case['zoneVelocity'])
        self.write(self.zone + 0x33c, 'f', case['terminalVelocity'])
        self.events = []
        self.call(0x103d0a50, self.pawn, struct.pack('<fi', case['dt'], 0))
        result = {'position': list(self.read(self.pawn + 0x114, '3f')),
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                  'physics': self.read(self.pawn + 0x30, 'B')[0], 'events': self.events}
        if case.get('bounce') or case.get('ancestry'):
            flags = self.read(self.pawn + 0x1ec, 'I')[0]
            result['bounce'] = bool(flags & 0x10)
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-falling-oracle.py GAME_ROOT CASES_JSON')
    native = NativeFalling(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.falling(case) for case in cases]}))
