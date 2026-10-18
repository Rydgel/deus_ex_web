"""Original dry Pawn processLanded and setPhysics with named controlled callbacks.

World queries/fitting/relocation, Landed, support basing, walking and CRT rand
are supplied by each case. Original Core appFrand and SafeNormal still execute.
This isolates landing decisions; it does not establish callback implementation
parity, damage/audio behavior, full walking or random-sequence compatibility.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)


class NativeLanding(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = None
        self.pawn, self.level, self.floor = self.alloc(0x1000), self.alloc(0x1000), self.alloc(0x1000)
        self.vtable, self.actor_vtable = self.alloc(0x200), self.alloc(0x20)
        self.line_thunk, self.fit_thunk, self.far_thunk = 0x700fe000, 0x700fe010, 0x700fe020
        self.event_thunk, self.rand_thunk = 0x700fe030, 0x700fe040
        for address, cleanup in [(self.line_thunk, 36), (self.fit_thunk, 24), (self.far_thunk, 24), (self.event_thunk, 12)]:
            self.cpu.mem_write(address, b'\xc2' + struct.pack('<H', cleanup))
        self.cpu.mem_write(self.rand_thunk, b'\xc3')
        self.write(0x102ab4fc, 'I', self.rand_thunk)  # Only CRT rand is controlled; original appFrand executes.
        self.write(self.vtable + 0xc0, 'I', self.line_thunk)
        self.write(self.vtable + 0xb0, 'I', self.fit_thunk)
        self.write(self.vtable + 0x8c, 'I', self.far_thunk)
        self.write(self.actor_vtable + 0x10, 'I', self.event_thunk)
        self.write(self.level, 'I', self.vtable)
        self.write(self.pawn, 'I', self.actor_vtable)
        self.write(self.pawn + 0x24, 'I', 0x1058c660)  # Pawn.
        self.write(self.pawn + 0xac, 'I', self.level)
        self.write(self.pawn + 0xc8, 'I', self.floor)  # Dry zone, bounce-velocity flag clear.
        # Decoration source: processLanded's IsA(Pawn) at 0x103cf124 is false, so it
        # takes the non-Pawn path (0x103cf597); IsA(0x10578d48) is true there, so the
        # decoration landing-footprint branch (0x103cf5f7) is reachable. Give the
        # decoration class a null SuperField so IsA(Pawn) walks off the chain.
        self.decoration_class = 0x10578d48
        self.write(self.decoration_class + 0x28, 'I', 0)
        # ACarcass (static class 0x10573db8, super ADecoration): the footprint
        # block's slide test (0x103d0159) walks the class chain for it.
        self.carcass_class = 0x10573db8
        self.write(self.carcass_class + 0x28, 'I', self.decoration_class)
        # Non-Decoration non-Pawn ancestry: fake script classes chained to the
        # DLL's own AInventory (Lockpick -> SkilledTool -> DeusExPickup -> Pickup
        # -> AInventory) and AProjectile (WoodFragment -> DeusExFragment ->
        # Fragment -> AProjectile), both -> AActor (0x1057cdf0) -> none.
        actor_class = 0x1057cdf0
        self.write(actor_class + 0x28, 'I', 0)
        self.ancestry = {}
        for name, native, depth in [('inventory', 0x10576f70, 4), ('projectile', 0x10578850, 3)]:
            self.write(native + 0x28, 'I', actor_class)
            parent = native
            for _ in range(depth):
                cls = self.alloc(0x40)
                self.write(cls + 0x28, 'I', parent)
                parent = cls
            self.ancestry[name] = parent
        # A separate ZoneInfo for the bBounceVelocity cases (other cases keep the
        # floor actor as their zone, as before).
        self.zone = self.alloc(0x1000)

    def actor_name(self, pointer):
        if pointer not in [0, self.floor]:
            raise RuntimeError(f'Unexpected actor {pointer:x}')
        return 'floor' if pointer else None

    def skip(self, stack, cleanup):
        self.cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
        self.cpu.reg_write(collision.UC_X86_REG_ESP, stack + 4 + cleanup)

    def on_instruction(self, cpu, address, size, data):
        if self.events is None:
            return super().on_instruction(cpu, address, size, data)
        stack = cpu.reg_read(collision.UC_X86_REG_ESP)
        case = self.case
        if address == self.line_thunk:
            hit, actor, end, start, flags = self.read(stack + 4, '5I')
            if actor != self.pawn:
                raise RuntimeError('Unexpected query actor')
            self.events.append({'line': {'start': list(self.read(start, '3f')), 'end': list(self.read(end, '3f')),
                                         'extent': list(self.read(stack + 24, '3f')), 'flags': flags,
                                         'extra': self.read(stack + 36, 'I')[0]}})
            self.write(hit + 36, 'f', case['supportTime'])
            # The decoration footprint block (0x103cf5f7) reads Hit.Actor after the
            # centre probe and each corner probe's UBOOL return (1: clear). A case's
            # `lines` gives them per call, in order: [hitActor, clear].
            lines = case.get('lines')
            if lines is not None:
                hit_actor, clear = lines[self.line_index]
                self.line_index += 1
                self.write(hit + 4, 'I', self.floor if hit_actor else 0)
                cpu.reg_write(collision.UC_X86_REG_EAX, clear)
        elif address == self.fit_thunk:
            location = self.read(stack + 16, 'I')[0]
            self.events.append({'fit': {'position': list(self.read(location, '3f')), 'extent': list(self.read(stack + 4, '3f')),
                                       'options': list(self.read(stack + 20, '2I'))}})
            if case['fitPosition'] is not None:
                self.write(location, '3f', *case['fitPosition'])
            cpu.reg_write(collision.UC_X86_REG_EAX, int(case['fitPosition'] is not None))
        elif address == self.far_thunk:
            actor, *position = self.read(stack + 4, 'I3f')
            if actor != self.pawn:
                raise RuntimeError('Unexpected relocation actor')
            self.events.append({'farMove': position, 'options': list(self.read(stack + 20, '2I'))})
            if case['farSuccess']:
                self.write(self.pawn + 0x114, '3f', *position)
            cpu.reg_write(collision.UC_X86_REG_EAX, int(case['farSuccess']))
        elif address == self.event_thunk:
            if self.read(stack, 'I')[0] != 0x103d0326:
                raise RuntimeError(f'Unsupported script event caller {self.read(stack, "I")[0]:x}')
            parameters = self.read(stack + 8, 'I')[0]
            self.events.append({'landed': list(self.read(parameters, '3f')), 'velocity': list(self.read(self.pawn + 0x144, '3f'))})
            if case['eventPhysics'] is not None:
                self.write(self.pawn + 0x30, 'B', case['eventPhysics'])
        elif address == self.rand_thunk:
            value = case['randomIntegers'][self.random_index]
            self.random_index += 1
            self.events.append({'rand': value})
            cpu.reg_write(collision.UC_X86_REG_EAX, value)
        elif address == 0x103c95f0:
            physics, actor = self.read(stack + 4, '2I')
            self.events.append({'setPhysics': physics, 'actor': self.actor_name(actor)})
            return super().on_instruction(cpu, address, size, data)  # Execute original setPhysics.
        elif address == 0x103c9390:
            actor = self.read(stack + 4, 'I')[0]
            self.events.append({'supportBase': self.actor_name(actor)})
            self.write(self.pawn + 0xc4, 'I', actor)  # Controlled SupportActor/SetBase callback.
            self.skip(stack, 4)
        elif address == 0x103ca540:
            remaining, iterations = self.read(stack + 4, 'fi')
            self.events.append({'walking': remaining, 'iterations': iterations,
                                'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                                'velocity': list(self.read(self.pawn + 0x144, '3f'))})
            self.skip(stack, 8)
        else:
            return super().on_instruction(cpu, address, size, data)

    def landed(self, case):
        self.case, self.random_index, self.line_index = case, 0, 0
        # A Pawn (default), a non-Pawn decoration (class 0x10578d48), or an
        # inventory/projectile ancestry.
        cls = self.ancestry.get(case.get('ancestry'))
        if cls is None:
            cls = self.carcass_class if case.get('carcass') else self.decoration_class if case.get('decoration') else 0x1058c660
        self.write(self.pawn + 0x24, 'I', cls)
        self.write(self.pawn + 0x28, 'I', 0x800000 if case.get('bIsPawn') else 0)
        zone = case.get('zone')
        if zone is None:
            self.write(self.pawn + 0xc8, 'I', self.floor)
        else:
            signed = [-0.0 if value == '-0' else value for value in zone['velocity']]
            self.write(self.zone + 0x388, 'I', 0x200 if zone['bBounceVelocity'] else 0)
            self.write(self.zone + 0x328, '3f', *signed)
            self.write(self.pawn + 0xc8, 'I', self.zone)
        self.write(self.pawn + 0x324, 'I', case.get('landingCounter', 0))
        # Carcass +0x348 bit 2 is bSlidingCarcass (bReducedHeight 1, bDecorative 2).
        self.write(self.pawn + 0x348, 'I', 4 if case.get('slidingCarcass') else 0)
        self.write(self.pawn + 0x30, 'B', case['physics'])
        self.write(self.pawn + 0xc4, 'I', self.floor if case['base'] else 0)
        self.write(self.pawn + 0x114, '3f', *case['position'])
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x1d4, '2f', case['radius'], case['height'])
        self.events = []
        self.call(0x103cef60, self.pawn, struct.pack('<3fIfi', *case['normal'], self.floor, case['remaining'], case['iterations']))
        result = {'position': list(self.read(self.pawn + 0x114, '3f')),
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                  'physics': self.read(self.pawn + 0x30, 'B')[0],
                  'landingCounter': self.read(self.pawn + 0x324, 'I')[0],
                  'base': self.actor_name(self.read(self.pawn + 0xc4, 'I')[0]), 'events': self.events}
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-landing-oracle.py GAME_ROOT CASES_JSON')
    native = NativeLanding(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.landed(case) for case in cases]}))
