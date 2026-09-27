"""Focused original APawn::performPhysics tail oracle.

Uses the same loaded Training world and ProcessEvent boundary stub as the
player-sequence oracle; physics, x87 tail and PendingTouch unlink run in the
original Engine.dll. The PostTouch script body is intentionally a boundary.
"""
import hashlib, importlib.util, json, struct, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('sequence', Path(__file__).with_name('native-player-sequence-oracle.py'))
sequence = importlib.util.module_from_spec(spec); spec.loader.exec_module(sequence)

root, scene_path, cases_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
scene_bytes, cases_bytes = scene_path.read_bytes(), cases_path.read_bytes()
scene, cases = json.loads(scene_bytes), json.loads(cases_bytes)
native = sequence.Native(root, scene)
pawn = native.pawn

def run_tail(dt):
    native.write(pawn + 0x30, 'B', 1)  # Walking; the reachable original dry physics leaf.
    native.write(pawn + 0x144, '3f', 0, 0, 0)
    native.write(pawn + 0x150, '3f', 0, 0, 0)
    native.write(pawn + 0x21c, 'I', 0)
    for key, old, timer in [(case['name'], case['old'], case['timer']) for case in cases['avgPhysicsTime']]:
        if key != dt['name']: continue
        native.write(pawn + 0x32c, 'f', old)
        native.write(pawn + 0x348, 'f', timer)
        native.call(0x103c9a70, pawn, struct.pack('<f', dt['dt']))
        return {'name': key, 'old': old, 'dt': dt['dt'], 'timer': timer,
                'avgPhysicsTime': native.read(pawn + 0x32c, 'f')[0],
                'moveTimer': native.read(pawn + 0x348, 'f')[0]}
    raise KeyError(dt['name'])

results = [run_tail(case) for case in cases['avgPhysicsTime']]
initial = native.actor_ptrs[cases['pendingTouch']['initial']]
next_actor = native.actor_ptrs[cases['pendingTouch']['next']]
native.write(pawn + 0x30, 'B', 1)
native.write(pawn + 0x21c, 'I', initial)
native.write(initial + 0x21c, 'I', next_actor)
native.write(next_actor + 0x21c, 'I', 0)
native.sequence_active = True
native.sequence_trace = []
native.call(0x103c9a70, pawn, struct.pack('<f', cases['pendingTouch']['dt']))
pending_events = [event for event in native.sequence_trace if event.get('caller') == '0x103c9c78']
report = {
    'sceneSha256': hashlib.sha256(scene_bytes).hexdigest(),
    'casesSha256': hashlib.sha256(cases_bytes).hexdigest(),
    'avgPhysicsTime': results,
    'pendingTouch': {
        'initial': cases['pendingTouch']['initial'], 'next': cases['pendingTouch']['next'],
        'dt': cases['pendingTouch']['dt'],
        'head': next((name for name, ptr in native.actor_ptrs.items() if ptr == native.read(pawn + 0x21c, 'I')[0]), None),
        'initialNext': native.read(initial + 0x21c, 'I')[0],
        'eventBoundaries': pending_events,
        'eventStubOnly': True,
    },
}
print(json.dumps(report))
