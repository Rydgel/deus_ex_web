"""Original ULevel::MoveActor zero-delta rotation cases with one based rider.

The hash, map scene, line queries, recursive MoveActor, and SetActorZone
instructions are original.  Script dispatch and the level-zone callback are
explicit controlled boundaries inherited from native-player-move-oracle.
"""
import importlib.util, json, struct, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('player_move', Path(__file__).with_name('native-player-move-oracle.py'))
player_move = importlib.util.module_from_spec(spec)
spec.loader.exec_module(player_move)


class Native(player_move.Native):
    def run_rotation(self, case):
        p, r = self.player, self.actor_ptrs['$rider']
        self.call(0x103583a0, self.hash, struct.pack('<I', p))
        self.write(p + 0x114, '3f', *case['playerLocation'])
        self.write(p + 0x120, '3i', *case['oldRotation'])
        self.write(p + 0xd8, 'B', 1)  # StandingCount forces 0x10399240.
        self.write(p + 0xc4, 'I', 0)
        self.write(r + 0x114, '3f', *case['riderLocation'])
        self.write(r + 0x120, '3i', *case.get('riderRotation', [0, 0, 0]))
        self.write(r + 0xc4, 'I', p)  # Rider.Base = source pawn.
        self.call(0x103580b0, self.hash, struct.pack('<I', p))
        self.player_events = []
        self.rider_calls = []
        self.hits = []
        self.player_active = True
        self.mover_trace = None
        hit = self.alloc(44)
        self.write(hit + 4, 'I', 0)
        self.write(hit + 36, 'fi', 1, -1)
        result = self.call(0x103990e0, self.level, struct.pack('<I3f3iI4I', p,
            0.0, 0.0, 0.0, *case['newRotation'], hit, 0, 0, 0, 0))
        self.player_active = False
        return {
            'success': bool(result),
            'playerLocation': self.read(p + 0x114, '3f'),
            'playerRotation': self.read(p + 0x120, '3i'),
            'riderLocation': self.read(r + 0x114, '3f'),
            'riderRotation': self.read(r + 0x120, '3i'),
            'playerHashLocation': self.read(p + 0x138, '3f'),
            'riderHashLocation': self.read(r + 0x138, '3f'),
            'time': self.read(hit + 36, 'f')[0],
            'hitActor': self.actor_ids.get(self.read(hit + 4, 'I')[0]),
            'hits': self.hits,
            'riderMoveCalls': self.rider_calls,
            'events': self.player_events,
        }

    def on_instruction(self, cpu, address, size, data):
        if self.player_active and address == 0x10399b51:
            sp = cpu.reg_read(player_move.m.UC_X86_REG_ESP)
            actor = self.read(sp, 'I')[0]
            self.rider_calls.append({
                'actor': self.actor_ids.get(actor),
                'delta': self.read(sp + 4, '3f'),
                'rotation': self.read(sp + 16, '3i'),
                'flags': self.read(sp + 32, '4I'),
            })
        return super().on_instruction(cpu, address, size, data)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('Usage: native-set-rotation-riders-oracle.py GAME_ROOT SCENE_JSON CASES_JSON')
    scene = json.loads(Path(sys.argv[2]).read_text())
    cases = json.loads(Path(sys.argv[3]).read_text())
    results = []
    for case in cases:
        native = Native(Path(sys.argv[1]), scene)
        results.append(native.run_rotation(case))
    print(json.dumps({'hashes': player_move.m.m.base.HASHES, 'results': results}))
