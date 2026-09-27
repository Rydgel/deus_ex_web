"""Original ULevel::MoveActor zero-delta rotation cases with one based rider.

The hash, map scene, line queries, recursive MoveActor, and SetActorZone
instructions are original.  Script dispatch and the level-zone callback are
explicit controlled boundaries inherited from native-player-move-oracle.
"""
import importlib.util, json, struct, sys
from unicorn.x86_const import UC_X86_REG_EDX, UC_X86_REG_EBX
from pathlib import Path

spec = importlib.util.spec_from_file_location('player_move', Path(__file__).with_name('native-player-move-oracle.py'))
player_move = importlib.util.module_from_spec(spec)
spec.loader.exec_module(player_move)


class Native(player_move.Native):
    def run_rotation(self, case):
        p = self.actor_ptrs[case.get('source', '$player')]
        r = self.actor_ptrs[case.get('rider', '$rider')]
        # Most cases use the original PlayerPawn fixture. The Training
        # stacked-crate case instead preserves the exact non-Pawn map actor
        # and colliding rider captured by the route diagnostic.
        self.player = p
        self.call(0x103583a0, self.hash, struct.pack('<I', p))
        self.write(p + 0x114, '3f', *case['playerLocation'])
        self.write(p + 0x120, '3i', *case['oldRotation'])
        self.write(p + 0xd8, 'B', case.get('standingCount', 1))  # Nonzero enters 0x10399240.
        source_base = case.get('sourceBase')
        self.write(p + 0xc4, 'I', self.actor_ptrs.get(source_base, self.info if source_base == '$world' else 0))
        self.write(r + 0x114, '3f', *case['riderLocation'])
        self.write(r + 0x120, '3i', *case.get('riderRotation', [0, 0, 0]))
        self.write(r + 0xc4, 'I', p)  # Rider.Base = source pawn.
        self.write(r + 0xd8, 'B', case.get('riderStandingCount', 0))
        self.call(0x103580b0, self.hash, struct.pack('<I', p))
        self.player_events = []
        self.rider_calls = []
        self.hits = []
        self.encroachment_calls = []
        self.encroachment_pending = []
        self.encroachment_dispatches = []
        self.player_active = True
        self.rotation_active = True
        self.mover_trace = None
        hit = self.alloc(44)
        self.write(hit + 4, 'I', 0)
        self.write(hit + 36, 'fi', 1, -1)
        result = self.call(0x103990e0, self.level, struct.pack('<I3f3iI4I', p,
            0.0, 0.0, 0.0, *case['newRotation'], hit, 0, 0, 0, 0))
        self.player_active = False
        self.rotation_active = False
        return {
            'success': bool(result),
            'sourceLocation': self.read(p + 0x114, '3f'),
            'sourceRotation': self.read(p + 0x120, '3i'),
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
            'checkEncroachment': self.encroachment_calls,
            'checkEncroachmentDispatches': self.encroachment_dispatches,
            'events': self.player_events,
        }

    def on_instruction(self, cpu, address, size, data):
        if getattr(self, 'rotation_active', False):
            if address == 0x10399c59:  # vcall immediately before the CheckEncroachment candidate.
                level_vtable = cpu.reg_read(UC_X86_REG_EDX)
                self.encroachment_dispatches.append({'vtable': level_vtable,
                    'target': self.read(level_vtable + 0xb8, 'I')[0],
                    'source': self.actor_ids.get(cpu.reg_read(UC_X86_REG_EBX))})
            sp = cpu.reg_read(player_move.m.UC_X86_REG_ESP)
            if self.encroachment_pending and address == self.encroachment_pending[-1]['return']:
                pending = self.encroachment_pending.pop()
                self.encroachment_calls[pending['index']]['rejected'] = bool(
                    cpu.reg_read(player_move.m.UC_X86_REG_EAX))
            if address == 0x1039a350:  # Original ULevel::CheckEncroachment entry.
                source = self.read(sp + 4, 'I')[0]
                call = {'source': self.actor_ids.get(source),
                    'position': self.read(sp + 8, '3f'),
                    'rotation': self.read(sp + 20, '3i'),
                    'notify': self.read(sp + 32, 'I')[0]}
                self.encroachment_calls.append(call)
                self.encroachment_pending.append({'return': self.read(sp, 'I')[0],
                    'index': len(self.encroachment_calls) - 1})
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
