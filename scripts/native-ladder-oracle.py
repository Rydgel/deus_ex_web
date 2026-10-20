"""Original walking surface prelude (0x103cc450) through its Ladder branch
(0x103cc519-0x103cc6ca) and the native physFlying it calls.

Extends the surface oracle: line queries and the WalkTexture event are the same
controlled callbacks. The scanned texture's Outer name is the case's `group`.
MoveActor (level vtable+0x88) answers every move unobstructed, so the blocked
physFlying branches are covered by native-flying-oracle.py instead. Evidence:
docs/ladder-flying.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('surface', Path(__file__).with_name('native-walking-surface-oracle.py'))
surface = importlib.util.module_from_spec(spec)
spec.loader.exec_module(surface)
b = surface.b
spec = importlib.util.spec_from_file_location('native_o3_replay', Path(__file__).with_name('native-o3-replay.py'))
o3r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o3r)


class NativeLadder(surface.NativeSurface):
    def __init__(self, root):
        super().__init__(root)
        self.move = 0x700fe000
        self.cpu.mem_write(self.move, bytes.fromhex('c2 30 00'))
        self.write(self.vtable + 0x88, 'I', self.move)
        self.actors = self.alloc(16)
        self.write(self.level + 0x2c, 'III', self.actors, 1, 1)
        self.write(self.actors, 'I', self.zone)
        self.write(self.pawn + 0xc8, 'I', self.zone)
        self.write(self.pawn + 0xd0, 'B', 1)
        self.write(self.pawn + 0x38c, 'f', 25)

    def o3(self, case):
        """A call Play recorded (scripts/o3-adapters.mjs, docs/stage-5-exit-criteria.md "O3"): the surface prelude, ordinary scan and Ladder branch, from
        Play's entry state. The scan's line queries (each with the texture its BSP surface gives) and the nested physFlying come from the recorded events."""
        cfg = case['config']
        if cfg['netMode'] != 0:
            raise RuntimeError('a network-mode prelude was recorded')
        self.case, self.index = {}, 0
        replay = self.replay = o3r.Replay(self, case, self.zone)
        self.write(self.pawn + 0x24, 'I', 0x1058c160 if cfg['isPlayerPawn'] else 0x1058c660)
        self.write(self.pawn + 0x120, '3i', *cfg['rotation'])
        self.write(self.pawn + 0x1d4, '2f', cfg['radius'], cfg['height'])
        for offset, key in [(0x378, 'groundSpeed'), (0x380, 'airSpeed'), (0x384, 'accelRate'), (0x36c, 'desiredSpeed')]:
            self.write(self.pawn + offset, 'f', cfg[key])
        self.write(self.pawn + 0x3dc, '3i', *cfg['viewRotation'])
        self.write(self.pawn + 0x318, 'I', o3r.IS_PLAYER if cfg['isPlayer'] else 0)
        replay.install(case['before']['state'])
        self.events = []
        try:
            handled = self.call(0x103cc450, 0, struct.pack('<Ifi', self.pawn, cfg['dt'], cfg['iterations']))
            replay.done()
            result = {'events': replay.events, 'after': replay.snapshot(), 'result': bool(handled & 255)}
        except o3r.Divergence as error:
            result = {'diverged': str(error), 'events': replay.events}
        self.events = self.replay = None
        return result

    def o3_service(self, cpu, address):
        replay, stack = self.replay, cpu.reg_read(b.UC_X86_REG_ESP)
        if address == 0x103cc519:
            return True  # Let the original Ladder branch run.
        if address == self.line:
            hit, actor, end, start, flags = self.read(stack + 4, '5I')
            extra = self.read(stack + 36, 'I')[0]
            recorded = replay.take('line', [list(self.read(start, '3f')), list(self.read(end, '3f')), list(self.read(stack + 24, '3f')), flags, extra])
            replay.install(recorded['post'])
            result = recorded['res']
            texture = result.get('texture')
            # The hit's BSP surface (node 0 -> surface 0) holds the recorded texture: its Outer's name, or no Outer, and its Friction; none when Play found none.
            self.write(self.surface, 'I', self.texture if texture else 0)
            if texture:
                self.write(self.texture + 0x18, 'I', self.outer if texture['outerName'] is not None else 0)
                if texture['outerName'] is not None:
                    self.cpu.mem_write(self.name_entry + 12, (texture['outerName'] + '\0').encode('utf-16-le'))
                self.write(self.texture + 0x70, 'f', texture['friction'])
            self.write(hit + 4, 'I', replay.pointer(result['actor']))
            self.write(hit + 8, '3f', *(result['location'] or list(self.read(end, '3f'))))
            self.write(hit + 20, '3f', *result['normal'])
            self.write(hit + 36, 'f', result['time'])
            self.write(hit + 40, 'i', 0)
            cpu.reg_write(b.UC_X86_REG_EAX, 1)
            return True
        if address == self.event:
            caller = self.read(stack, 'I')[0]
            if caller not in (0x103cc820, 0x103cc57c):
                raise o3r.Divergence(f'the native dispatched a script event from {caller:#x}')
            params = self.read(stack + 8, 'I')[0]
            recorded = replay.take('walkTexture', [bool(self.read(params, 'I')[0]), list(self.read(params + 4, '3f')), list(self.read(params + 16, '3f'))])
            replay.install(recorded['post'])
            return True
        if address == 0x103d3040:
            recorded = replay.take('flying', [self.read(stack + 4, 'f')[0], self.read(stack + 8, 'i')[0]])
            replay.install(recorded['post'])
            cpu.reg_write(b.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(b.UC_X86_REG_ESP, stack + 12)
            return True
        if address == self.move:
            raise o3r.Divergence('the native called MoveActor from the prelude')
        return False

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and getattr(self, 'replay', None) is not None and self.o3_service(cpu, address):
            return
        if self.events is not None and address == 0x103cc519:
            return  # Let the original Ladder branch run.
        if self.events is not None and address == self.event:
            st = cpu.reg_read(b.UC_X86_REG_ESP)
            if self.read(st, 'I')[0] == 0x103cc57c:
                params = self.read(st + 8, 'I')[0]
                self.events.append({'ladderWalkTexture': bool(self.read(params, 'I')[0]),
                                    'location': list(self.read(params + 4, '3f')),
                                    'normal': list(self.read(params + 16, '3f'))})
                return
        if self.events is not None and address == self.move:
            st = cpu.reg_read(b.UC_X86_REG_ESP)
            actor, *delta = self.read(st + 4, 'I3f')
            hit = self.read(st + 32, 'I')[0]
            if actor != self.pawn:
                raise RuntimeError('Unexpected MoveActor actor')
            self.events.append({'move': delta, 'velocity': list(self.read(self.pawn + 0x144, '3f'))})
            location = self.read(self.pawn + 0x114, '3f')
            self.write(self.pawn + 0x114, '3f', *[surface.b.struct.unpack('<f', surface.b.struct.pack('<f', a + c))[0]
                                                  for a, c in zip(location, delta)])
            self.write(hit + 4, 'I', 0)
            self.write(hit + 20, '3f', 0, 0, 0)
            self.write(hit + 36, 'f', 1)
            cpu.reg_write(b.UC_X86_REG_EAX, 1)
            return
        super().on_instruction(cpu, address, size, data)

    def ladder(self, case):
        self.write(self.pawn + 0x144, '3f', *case['velocity'])
        self.write(self.pawn + 0x150, '3f', *case['acceleration'])
        self.write(self.pawn + 0x378, 'f', case['groundSpeed'])
        self.write(self.pawn + 0x380, 'f', case['airSpeed'])
        self.write(self.pawn + 0x384, 'f', case['accelRate'])
        self.write(self.pawn + 0x36c, 'f', 1)
        self.write(self.pawn + 0x3dc, '3i', *case['viewRotation'])
        self.write(self.pawn + 0x318, 'I', 0x10 if case.get('walking') else 0)
        self.write(self.pawn + 0x1ec, 'I', 0)
        self.write(self.zone + 0x31c, '3f', 0, 0, -950)
        self.write(self.zone + 0x328, '3f', 0, 0, 0)
        self.write(self.zone + 0x338, 'f', case['fluidFriction'])
        result = self.run(case)
        result.update({'position': list(self.read(self.pawn + 0x114, '3f')),
                       'velocity': list(self.read(self.pawn + 0x144, '3f')),
                       'acceleration': list(self.read(self.pawn + 0x150, '3f')),
                       'walking': bool(self.read(self.pawn + 0x318, 'I')[0] & 0x10)})
        return result


if __name__ == '__main__':
    if len(sys.argv) not in (3, 4):
        sys.exit('Usage: native-ladder-oracle.py GAME_ROOT CASES_JSON [--o3]')
    native = NativeLadder(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    if '--o3' in sys.argv:
        print(json.dumps({'results': [native.o3(case) for case in cases]}))
        sys.exit(0)
    print(json.dumps({'results': [native.ladder(case) for case in cases]}))
