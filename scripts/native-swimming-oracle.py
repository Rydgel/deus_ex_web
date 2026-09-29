"""Execute original PHYS_Swimming (Engine.dll) with controlled world callbacks.

Mode 'swim' runs APawn::startSwimming (0x103d2b70) or APawn::physSwimming
(0x103d3cd0) natively, and with them APawn::Swim (0x103d3850),
APawn::findWaterLine (0x103d3b10), calcVelocity (0x103cd7a0, bFluid=1,
bBuoyant=1), stepUp (0x103ce4a0), TwoWallAdjust and Core's FVector helpers.
The controlled doubles are:
  - ULevel::MoveActor (vtable +0x88): the case's responses. Like the original
    it returns before touching Hit when every |Delta| component is below 1e-4
    (0x1039915a) and the rotation is unchanged. After a move it stands in for
    SetActorZone: Region, FootRegion (Location - CollisionHeight) and
    HeadRegion (Location + EyeHeight) take the water or dry zone of the case's
    planar water rule. `zonePhysics` stands in for a script ZoneChange that
    calls SetPhysics when Region changes water state.
  - UModel::PointRegion (thunk 0x1030391d): the same planar water rule.
  - the walking surface prelude 0x103cc450 (returns `preludeHandled`),
    processHitWall 0x103cecc0, physFalling 0x103d0a50 and physFlying
    0x103d3040 record their arguments and return.
  - AActor::setPhysics 0x103c95f0 writes Physics. The cases keep Base None,
    where the original body (0x103c95f0..0x103c96e9) does nothing else for
    PHYS_Falling.
Modes 'falling' and 'walking' run original physFalling/physWalking in the
falling/walking harnesses, flip Physics to PHYS_Swimming after the MoveActor
named by `swimAtMove` (a script ZoneChange double), and record the
startSwimming hand-off arguments at 0x103d2b70 instead of running it.

This proves the swimming translation around these doubles; it does not prove
world collision, PointRegion over BSP, or script event bodies.
Evidence and the branch map: docs/swimming.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_walking', Path(__file__).with_name('native-walking-oracle.py'))
walking = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walking)
falling = walking.b
collision = falling.collision
f = falling.f
ESP, EIP, EAX = collision.UC_X86_REG_ESP, collision.UC_X86_REG_EIP, collision.UC_X86_REG_EAX

START_SWIMMING, PHYS_SWIMMING, SWIM, FIND_WATER_LINE = 0x103d2b70, 0x103d3cd0, 0x103d3850, 0x103d3b10
PRELUDE, HIT_WALL, SET_PHYSICS, PHYS_FALLING, PHYS_FLYING = 0x103cc450, 0x103cecc0, 0x103c95f0, 0x103d0a50, 0x103d3040
POINT_REGION = 0x1030391d
# Instruction coverage of the translated bodies (their SEH unwind funclets excluded).
COVERAGE = {'startSwimming': (0x103d2b70, 0x103d2f0d), 'Swim': (0x103d3850, 0x103d3a4d),
            'findWaterLine': (0x103d3b10, 0x103d3c40), 'physSwimming': (0x103d3cd0, 0x103d43e4)}


class NativeSwimming(walking.NativeWalking):
    mode = None  # set per case; on_instruction also runs during base construction
    covered = set()

    def uncovered(self):
        from capstone import Cs, CS_ARCH_X86, CS_MODE_32
        md, result = Cs(CS_ARCH_X86, CS_MODE_32), {}
        for name, (lo, hi) in COVERAGE.items():
            code = bytes(self.cpu.mem_read(lo, hi - lo))
            missing = [i.address for i in md.disasm(code, lo) if i.address not in self.covered]
            ranges = []
            for a in missing:
                if ranges and a - ranges[-1][1] <= 16:
                    ranges[-1][1] = a
                else:
                    ranges.append([a, a])
            result[name] = [f'{a:#x}-{b:#x}' for a, b in ranges]
        return result

    def __init__(self, root):
        super().__init__(root)
        self.water_zone = self.alloc(0x1000)
        self.write(self.water_zone + 0x24, 'I', 0x1057bf00)
        self.write(self.water_zone + 0x388, 'I', 1)  # bWaterZone (bit 0, SDK AZoneInfo+0x388)
        self.write(self.zone + 0x388, 'I', 0)
        # A script Pawn class chain (IsA(Pawn) true, IsA(PlayerPawn) false).
        self.script_pawn_class = self.script_chain(0x1058c660, 2)

    # --- controlled world -------------------------------------------------
    def water_at(self, point):
        rule = self.case['water']
        value = point[rule['axis']]
        return value < rule['level']  # NaN compares false: dry

    def zone_at(self, point):
        return self.water_zone if self.water_at(point) else self.zone

    def update_regions(self):
        x, y, z = self.read(self.pawn + 0x114, '3f')
        height = self.read(self.pawn + 0x1d8, 'f')[0]
        eye = self.read(self.pawn + 0x3f8, 'f')[0]
        region = self.zone_at([x, y, z])
        self.write(self.pawn + 0xc8, 'I', region)
        self.write(self.pawn + 0xd0, 'B', 2 if region == self.water_zone else 1)
        self.write(self.pawn + 0x330, 'I', self.zone_at([x, y, f(z - height)]))
        self.write(self.pawn + 0x33c, 'I', self.zone_at([x, y, f(z + eye)]))
        return region

    def swim_move(self, cpu):
        stack = cpu.reg_read(ESP)
        actor, *delta = self.read(stack + 4, 'I3f')
        hit = self.read(stack + 32, 'I')[0]
        if actor != self.pawn:
            raise RuntimeError('Unexpected MoveActor actor')
        self.events.append({'move': delta, 'velocity': list(self.read(self.pawn + 0x144, '3f'))})
        cpu.reg_write(EAX, 1)
        if all(not (abs(c) >= 1e-4) for c in delta):
            return  # 0x1039915a: nearly zero Delta, unchanged rotation, Hit untouched.
        index = self.move_index
        self.move_index += 1
        if index >= len(self.responses):
            raise RuntimeError(f'Exhausted MoveActor responses; events={self.events}')
        response = self.responses[index]
        location = self.read(self.pawn + 0x114, '3f')
        self.write(self.pawn + 0x114, '3f', *[a + f(b * response['time']) for a, b in zip(location, delta)])
        self.write(hit + 8, '3f', *self.read(self.pawn + 0x114, '3f'))
        self.write(hit + 4, 'I', self.zone if response['time'] < 1 else 0)
        self.write(hit + 20, '3f', *response['normal'])
        self.write(hit + 36, 'f', response['time'])
        before = self.read(self.pawn + 0xc8, 'I')[0]
        after = self.update_regions()
        change = self.case.get('zonePhysics')
        if change and (before == self.water_zone) != (after == self.water_zone):
            physics = change.get('water' if after == self.water_zone else 'dry')
            if physics is not None:
                self.write(self.pawn + 0x30, 'B', physics)
        if self.case.get('teleportAtMove') == index:
            self.write(self.pawn + 0x1ec, 'I', self.read(self.pawn + 0x1ec, 'I')[0] | 0x100)
        event = self.case.get('velocityAtMove')
        if event and event['index'] == index:
            self.write(self.pawn + 0x144, '3f', *event['velocity'])

    def ret(self, cpu, pop, value=None):
        stack = cpu.reg_read(ESP)
        cpu.reg_write(EIP, self.read(stack, 'I')[0])
        cpu.reg_write(ESP, stack + 4 + pop)
        if value is not None:
            cpu.reg_write(EAX, value)

    def swim_hook(self, cpu, address):
        stack = cpu.reg_read(ESP)
        if address == self.move_thunk:
            self.swim_move(cpu)
            return True  # the thunk's own `ret 0x30` runs next
        if address == POINT_REGION:
            result, _level, x, y, z = self.read(stack + 4, 'II3f')
            zone = self.zone_at([x, y, z])
            self.events.append({'pointRegion': [x, y, z]})
            self.write(result, 'IiB', zone, -1, 2 if zone == self.water_zone else 1)
            self.ret(cpu, 20, result)
            return True
        if address == PRELUDE:
            self.events.append({'prelude': self.read(stack + 8, 'f')[0], 'iterations': self.read(stack + 12, 'i')[0]})
            self.ret(cpu, 0, int(self.case.get('preludeHandled', 0)))
            return True
        if address == HIT_WALL:
            self.events.append({'wall': list(self.read(stack + 4, '3f'))})
            if 'wallVelocityZ' in self.case:
                self.write(self.pawn + 0x14c, 'f', self.case['wallVelocityZ'])
            self.ret(cpu, 16)
            return True
        if address in (PHYS_FALLING, PHYS_FLYING):
            key = 'falling' if address == PHYS_FALLING else 'flying'
            self.events.append({key: self.read(stack + 4, 'f')[0], 'iterations': self.read(stack + 8, 'i')[0]})
            self.ret(cpu, 8)
            return True
        if address == SET_PHYSICS:
            physics = self.read(stack + 4, 'I')[0] & 0xff
            if self.read(self.pawn + 0xc4, 'I')[0]:
                raise RuntimeError('setPhysics double requires Base None')
            self.events.append({'physics': physics})
            self.write(self.pawn + 0x30, 'B', physics)
            self.ret(cpu, 8)
            return True
        if address == self.line_thunk or address == self.event_thunk:
            raise RuntimeError(f'Unexpected world query/event in swimming at {self.read(stack, "I")[0]:x}')
        return False

    def handoff_hook(self, cpu, address):
        """physFalling/physWalking harness: record startSwimming and flip Physics."""
        stack = cpu.reg_read(ESP)
        if address == START_SWIMMING:
            caller = self.read(stack, 'I')[0]
            self.sites.append({0x103cb453: 'walking 0x103cb3fd', 0x103d1cf5: 'falling 0x103d1cb6'}.get(caller)
                              or ('walking 0x103cb6d9' if self.floor_site else 'walking 0x103cb97d'))
            self.events.append({'startSwimming': {
                'oldVelocity': list(self.read(stack + 4, '3f')), 'timeTick': self.read(stack + 16, 'f')[0],
                'remaining': self.read(stack + 20, 'f')[0], 'iterations': self.read(stack + 24, 'i')[0],
                'position': list(self.read(self.pawn + 0x114, '3f')),
                'oldLocation': list(self.read(self.pawn + 0x12c, '3f')),
                'velocity': list(self.read(self.pawn + 0x144, '3f'))}})
            self.ret(cpu, 0x18)
            return True
        return False

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and any(lo <= address < hi for lo, hi in COVERAGE.values()):
            self.covered.add(address)
        if self.events is not None and self.mode == 'swim' and self.swim_hook(cpu, address):
            return
        if self.events is not None and self.mode in ('falling', 'walking'):
            if address == 0x103cb6e3:  # physWalking's floor-move PHYS_Swimming branch taken
                self.floor_site = True
            if self.handoff_hook(cpu, address):
                return
            if address == self.move_thunk:
                index = self.move_index if self.mode == 'falling' else self.mi
                if self.mode == 'falling':
                    falling.NativeFalling.on_instruction(self, cpu, address, size, data)
                else:
                    walking.NativeWalking.on_instruction(self, cpu, address, size, data)
                if self.case.get('swimAtMove') == index:
                    self.write(self.pawn + 0x30, 'B', 3)
                return
            if self.mode == 'falling':
                return falling.NativeFalling.on_instruction(self, cpu, address, size, data)
        if self.mode == 'swim':
            return collision.NativeCollision.on_instruction(self, cpu, address, size, data)
        super().on_instruction(cpu, address, size, data)

    # --- cases -------------------------------------------------------------
    def swim(self, case):
        self.mode, self.case, self.last_hit = 'swim', case, [0.0, 0.0, 0.0]
        self.responses, self.move_index = case['responses'], 0
        cls = self.script_pawn_class if case.get('nonPlayer') else 0x1058c160
        self.write(self.pawn + 0x24, 'I', cls)
        self.write(self.pawn + 0x28, 'I', 0)
        self.write(self.pawn + 0x30, 'B', case.get('physics', 3))
        self.write(self.pawn + 0xc4, 'I', 0)  # Base None
        self.write(self.pawn + 0x1ec, 'I', (0x10 if case.get('bounce') else 0) | (0x100 if case.get('justTeleported') else 0))
        self.write(self.pawn + 0x318, 'I', 0x10 if case.get('walking') else 0)
        self.write(self.pawn + 0x114, '3f', *case['position'])
        self.write(self.pawn + 0x12c, '3f', *case.get('oldLocation', [0, 0, 0]))
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x37c, 'f', case['waterSpeed'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        self.write(self.pawn + 0x36c, 'f', case.get('desiredSpeed', 1))
        self.write(self.pawn + 0x1f4, '2f', case['mass'], case['buoyancy'])
        self.write(self.pawn + 0x1d4, '2f', case['radius'], case['height'])
        self.write(self.pawn + 0x3f8, 'f', case['eyeHeight'])
        for zone, key in [(self.zone, 'dry'), (self.water_zone, 'water')]:
            values = case['zones'][key]
            self.write(zone + 0x31c, '3f', *values['gravity'])
            self.write(zone + 0x328, '3f', *values['zoneVelocity'])
            self.write(zone + 0x338, 'f', values['fluidFriction'])
        self.update_regions()
        self.events = []
        if case['entry'] == 'startSwimming':
            args = struct.pack('<3fffi', *case['oldVelocity'], case['timeTick'], case['remaining'], case.get('iterations', 0))
            self.call(START_SWIMMING, self.pawn, args)
        else:
            self.call(PHYS_SWIMMING, self.pawn, struct.pack('<fi', case['dt'], case.get('iterations', 0)))
        result = {'position': list(self.read(self.pawn + 0x114, '3f')),
                  'oldLocation': list(self.read(self.pawn + 0x12c, '3f')),
                  'velocity': list(self.read(self.pawn + 0x144, '3f')),
                  'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                  'physics': self.read(self.pawn + 0x30, 'B')[0],
                  'justTeleported': bool(self.read(self.pawn + 0x1ec, 'I')[0] & 0x100),
                  'events': self.events}
        self.events = None
        return result

    def handoff(self, case):
        self.mode = case['mode']
        # Restore the falling/walking harness state that swim cases change:
        # every region in the dry LevelInfo zone, the harness cylinder, flags.
        self.write(self.pawn + 0xc8, 'I', self.zone)
        self.write(self.pawn + 0xd0, 'B', 1)
        self.write(self.pawn + 0x330, 'I', self.zone)
        self.write(self.pawn + 0x33c, 'I', self.zone)
        self.write(self.pawn + 0x1d4, '2f', 20, 43)
        self.write(self.pawn + 0x318, 'I', 0)
        self.write(self.pawn + 0x1f4, '2f', 100, 100)
        self.write(self.zone + 0x338, 'f', 1.2)
        self.write(self.pawn + 0x12c, '3f', 0, 0, 0)
        self.sites, self.floor_site = [], False
        if self.mode == 'falling':
            result = self.falling(case)
        else:
            self.write(self.pawn + 0x24, 'I', 0x1058c160)
            result = self.walking(case)
        result['oldLocation'] = list(self.read(self.pawn + 0x12c, '3f'))
        result['site'] = self.sites  # the hand-off call site (not part of the comparison)
        return result

    def run(self, case):
        return self.swim(case) if case['mode'] == 'swim' else self.handoff(case)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-swimming-oracle.py GAME_ROOT CASES_JSON')
    native = NativeSwimming(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    results = [native.run(case) for case in cases]
    print(json.dumps({'hashes': collision.HASHES, 'results': results, 'uncovered': native.uncovered()}))
