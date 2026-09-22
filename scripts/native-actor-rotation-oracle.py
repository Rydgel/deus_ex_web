"""Execute the original AActor::performPhysics tail and AActor::physicsRotation.

Each case enters the unchanged AActor::performPhysics (0x103c9770) with Physics
PHYS_None, so its Physics switch takes the default and only the original tail
runs: the RotationRate low-word gate (0x103c98ed), physicsRotation (0x103ca1e0)
and fixedTurn (0x103c9dc0), the level's virtual MoveActor, and the PendingTouch
PostTouch/unlink (0x103c9917). MoveActor is the REAL ULevel::MoveActor
(0x103990e0) reached through the level vtable slot +0x88; only its zero-delta
early paths are supported (entering the full path at 0x10399240 raises).
Core's IsProbing, FindFunctionChecked and _ftol bridge execute from the images.
The two script events (EndedRotation, PostTouch) are recorded at a controlled
ProcessEvent thunk and have no script body.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

PERFORM_PHYSICS, PHYSICS_ROTATION, MOVE_ACTOR, MOVE_ACTOR_FULL = 0x103c9770, 0x103ca1e0, 0x103990e0, 0x10399240
ENDED_ROTATION_RETURN, POST_TOUCH_RETURN = 0x103ca44a, 0x103c9943


class NativeActorRotation(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = None
        self.event_thunk = 0x700fe020
        self.cpu.mem_write(self.event_thunk, bytes.fromhex('c2 0c 00'))  # ProcessEvent(Function, Parms, Result)
        self.actor_vtable, self.level_vtable = self.alloc(0x40), self.alloc(0x200)
        self.write(self.actor_vtable + 0x10, 'I', self.event_thunk)
        self.write(self.level_vtable + 0x88, 'I', MOVE_ACTOR)  # ULevel::MoveActor
        self.level = self.alloc(0x2000)
        self.write(self.level, 'I', self.level_vtable)
        # WoodFragment -> DeusExFragment -> Fragment -> AProjectile -> AActor.
        actor_class, parent = 0x1057cdf0, 0x10578850
        self.write(actor_class + 0x28, 'I', 0)
        self.write(parent + 0x28, 'I', actor_class)
        for _ in range(3):
            cls = self.alloc(0x40)
            self.write(cls + 0x28, 'I', parent)
            parent = cls
        self.fragment_class = parent
        self.actor = self.new_actor()
        self.touches = [self.new_actor(), self.new_actor()]
        self.frame = self.alloc(0x40)  # FStateFrame; ProbeMask qword at +0x1c

    def new_actor(self):
        actor = self.alloc(0x1000)
        self.write(actor, 'I', self.actor_vtable)
        self.write(actor + 0x24, 'I', self.fragment_class)
        self.write(actor + 0xac, 'I', self.level)
        return actor

    def name(self, pointer):
        names = {0: None, self.actor: 'actor', self.touches[0]: 'touch0', self.touches[1]: 'touch1'}
        if pointer not in names:
            raise RuntimeError(f'Unexpected actor {pointer:x}')
        return names[pointer]

    def on_instruction(self, cpu, address, size, data):
        if self.events is None:
            return super().on_instruction(cpu, address, size, data)
        stack = cpu.reg_read(collision.UC_X86_REG_ESP)
        if address == PHYSICS_ROTATION:
            self.events.append({'physicsRotation': self.read(stack + 4, 'f')[0]})
        elif address == MOVE_ACTOR:
            actor, *rest = self.read(stack + 4, 'I3f3iI4I')
            self.events.append({'moveActor': {'actor': self.name(actor), 'delta': rest[0:3], 'rotation': rest[3:6],
                                              'hitTime': self.read(rest[6] + 0x24, 'f')[0], 'flags': rest[7:11]}})
        elif address == MOVE_ACTOR_FULL:
            raise RuntimeError('Full MoveActor path (riders/brush/nonzero delta) is outside this harness')
        elif address == self.event_thunk:
            caller = self.read(stack, 'I')[0]
            this = cpu.reg_read(collision.UC_X86_REG_ECX)
            if caller == ENDED_ROTATION_RETURN:
                self.events.append({'event': 'EndedRotation', 'target': self.name(this),
                                    'parms': self.read(stack + 8, 'I')[0]})
            elif caller == POST_TOUCH_RETURN:
                parms = self.read(stack + 8, 'I')[0]
                self.events.append({'event': 'PostTouch', 'target': self.name(this),
                                    'other': self.name(self.read(parms, 'I')[0])})
            else:
                raise RuntimeError(f'Unsupported script event caller {caller:x}')
        return super().on_instruction(cpu, address, size, data)

    def run(self, case):
        actor = self.actor
        flags = (0x20 if case['fixed'] else 0) | (0x40 if case['toDesired'] else 0)
        self.write(actor + 0x0c, 'I', 0 if case['probing'] is None else self.frame)
        if case['probing'] is not None:
            # ProbeMask bit (325 - 300) = 25 is EndedRotation; other bits are noise.
            mask = 0x0f0f0f0f_0f0f0f0f & ~(1 << 25) | ((1 << 25) if case['probing'] else 0)
            self.write(self.frame + 0x1c, 'Q', mask)
        self.write(actor + 0x28, 'I', (0x80000 if case['movable'] else 0) | (1 if case['static'] else 0))
        # PHYS_None (0) or PHYS_Rotating (5): performPhysics' switch does nothing.
        if case['physics'] not in (0, 5):
            raise RuntimeError('Only Physics None/Rotating reach the tail without a physics mode')
        self.write(actor + 0x30, 'B', case['physics'])
        self.write(actor + 0xd8, 'B', 0)  # StandingCount
        self.write(actor + 0x178, 'I', 0)  # Brush
        self.write(actor + 0x120, '3i', *case['rotation'])
        self.write(actor + 0x1ec, 'I', flags)
        self.write(actor + 0x1fc, '3i', *case['rotationRate'])
        self.write(actor + 0x208, '3i', *case['desiredRotation'])
        chain = [actor] + self.touches[:case['pendingTouch']]
        for current, following in zip(chain, chain[1:] + [0]):
            self.write(current + 0x21c, 'I', following)
        for touch in self.touches[case['pendingTouch']:]:
            self.write(touch + 0x21c, 'I', 0)
        self.events = []
        self.call(PERFORM_PHYSICS, actor, struct.pack('<f', case['dt']))
        result = {'rotation': list(self.read(actor + 0x120, '3i')),
                  'pendingTouch': [self.name(self.read(a + 0x21c, 'I')[0]) for a in [actor] + self.touches],
                  'events': self.events}
        self.events = None
        return result


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: native-actor-rotation-oracle.py GAME_ROOT CASES_JSON')
    native = NativeActorRotation(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.run(case) for case in cases]}))
