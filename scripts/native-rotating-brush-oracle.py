"""Research harness: a rotating moving brush through the original AActor::performPhysics.

Each case places one Mover (the 09_NYC_ShipFan fans, a real brush model at its real pose) in the original level
(native-mover-move-oracle.py's scene: the real collision hash, CheckEncroachment, IsBlockedBy, BeginTouch/EndTouch,
IsOverlapping, moveSmooth of a pushed actor) and enters the unchanged AActor::performPhysics (0x103c9770) once per
entry of `dts`, on one process, so the actor, the hash and the touch slots carry from tick to tick:

  Physics 9 (PHYS_MovingBrush; bInterpolating clear: AMover::physMovingBrush 0x103de690 returns at once) or 5
  (PHYS_Rotating) -> the OldLocation/Velocity bracket (9 only) -> the tail 0x103c98ed: the RotationRate low-word gate,
  AActor::physicsRotation (0x103ca1e0), fixedTurn (0x103c9dc0), the REAL ULevel::MoveActor (0x103990e0) with the brush
  source and its whole tail (run_tail: past 0x10399d17), the EndTouch pass, SetActorZone (a recorded boundary), PendingTouch.

Boundaries recorded in order: physicsRotation (dt), moveActor (Delta, NewRotation), CheckEncroachment, the hash
queries (ActorEncroachmentCheck), moveSmooth of a pushed actor, script events (EncroachingOn, EncroachedBy, Touch,
UnTouch, Bump), hash remove/add, zoneBoundary.  Script bodies and SetActorZone are controlled stand-ins, as in
native-mover-move-oracle.py; nothing here is Play's code.
"""
import importlib.util, json, struct, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('mover_oracle', Path(__file__).with_name('native-mover-move-oracle.py'))
mover_oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mover_oracle)
from unicorn.x86_const import UC_X86_REG_ESP

PERFORM_PHYSICS, PHYSICS_ROTATION, MOVE_ACTOR = 0x103c9770, 0x103ca1e0, 0x103990e0


class Chain(mover_oracle.Native):
    def __init__(self, root, scene):
        super().__init__(root, scene)
        self.run_tail = True

    def on_instruction(self, cpu, address, size, data):
        if self.mover_trace is not None:
            sp = cpu.reg_read(UC_X86_REG_ESP)
            if address == PHYSICS_ROTATION:
                self.mover_trace.append({'physicsRotation': self.read(sp + 4, 'f')[0]})
            elif address == MOVE_ACTOR and self.read(sp + 4, 'I')[0] == self.moving:   # a pushed actor's nested MoveActor is its moveSmooth entry
                actor, *rest = self.read(sp + 4, 'I3f3iI4I')
                self.mover_trace.append({'moveActor': self.actor_ids.get(actor), 'delta': rest[0:3], 'rotation': rest[3:6], 'flags': rest[7:11]})
        return super().on_instruction(cpu, address, size, data)

    def snapshot(self, actor):
        slots = lambda p: [self.actor_ids.get(x) for x in self.read(p + 0xe8, '4I')]
        return {'position': self.read(actor + 0x114, '3f'), 'rotation': list(self.read(actor + 0x120, '3i')),
                'oldLocation': self.read(actor + 0x12c, '3f'), 'velocity': self.read(actor + 0x144, '3f'),
                'physics': self.read(actor + 0x30, 'B')[0], 'motion': self.read(actor + 0x1ec, 'I')[0],
                'trace': self.mover_trace,
                'touching': {k: slots(p) for k, p in self.actor_ptrs.items()},
                'actors': {k: self.read(p + 0x114, '3f') for k, p in self.actor_ptrs.items()},
                'rotations': {k: list(self.read(p + 0x120, '3i')) for k, p in self.actor_ptrs.items()}}

    def run(self, c):
        actor = self.actor_ptrs[c['actor']]
        self.moving = actor
        self.encroach_reject = c.get('reject', 0)
        self.calls = []
        # The mover is in the hash at its fixture pose with the scene's collision word. A case that moves it or clears its
        # collision takes it out first, as SetLocation/SetCollision would, and puts it back only if bCollideActors is set.
        if c.get('flags') is not None or c.get('location') is not None:
            self.call(0x103583a0, self.hash, struct.pack('<I', actor))
            if c.get('location') is not None:
                self.write(actor + 0x114, '3f', *c['location'])
            if c.get('flags') is not None:
                self.write(actor + 0x1dc, 'I', c['flags'])
            if self.read(actor + 0x1dc, 'I')[0] & 1:
                self.call(0x103580b0, self.hash, struct.pack('<I', actor))
        for index, other in enumerate(c.get('touching', [])):
            q = self.actor_ptrs[other]
            self.write(actor + 0xe8 + 4 * index, 'I', q)
            self.write(q + 0xe8, 'I', actor)
        self.write(actor + 0x30, 'B', c['physics'])
        self.write(actor + 0x120, '3i', *c['rotation'])
        self.write(actor + 0x1fc, '3i', *c['rate'])
        self.write(actor + 0x208, '3i', *c.get('desired', [0, 0, 0]))
        self.write(actor + 0x1ec, 'I', (0x20 if c['fixed'] else 0) | (0x40 if c.get('toDesired') else 0))
        self.write(actor + 0x12c, '3f', *self.read(actor + 0x114, '3f'))
        steps = []
        for dt in c['dts']:
            self.mover_trace = []
            self.call(PERFORM_PHYSICS, actor, struct.pack('<f', dt))
            steps.append(self.snapshot(actor))
        self.mover_trace = None
        return {'steps': steps}


def _init(root, scene_path):
    """Per-worker inputs: every case builds its own Native (a Unicorn instance lives in exactly one process, and the actor,
    the hash and the touch slots of one case must not leak into the next)."""
    global _ROOT, _SCENE
    _ROOT, _SCENE = Path(root), json.loads(Path(scene_path).read_text())


def _case(case):
    n = Chain(_ROOT, _SCENE)
    for name, position in dict(case.get('positions', {})).items():
        p = n.actor_ptrs[name]
        n.call(0x103583a0, n.hash, struct.pack('<I', p))
        n.write(p + 0x114, '3f', *position)
        n.call(0x103580b0, n.hash, struct.pack('<I', p))
    return n.run(case)


if __name__ == '__main__':
    pool_spec = importlib.util.spec_from_file_location('oracle_pool', Path(__file__).with_name('oracle_pool.py'))
    oracle_pool = importlib.util.module_from_spec(pool_spec)
    pool_spec.loader.exec_module(oracle_pool)
    cases = json.loads(Path(sys.argv[3]).read_text())
    # At most 4 workers: each holds a whole original level image (NATIVE_ORACLE_JOBS=1 is the serial path).
    results = oracle_pool.pooled_map(_case, _init, (sys.argv[1], sys.argv[2]), cases, jobs=min(4, oracle_pool.oracle_jobs()))
    print(json.dumps({'results': results, 'hashes': mover_oracle.m.base.HASHES}))
