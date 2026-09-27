"""Unchanged AActor::performPhysics over the supplied actor heap image.

Movement bodies and physicsRotation are explicit call-boundary doubles. Their
arguments/order and the wrapper's real OldLocation/Velocity arithmetic execute
from Engine.dll. The same 0x400-byte actor image is used by the JS translation;
there are no live pointers in these dispatch cases (PendingTouch is zero).
Existing body-specific oracles establish Falling/Rolling/rotation/mover bodies.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

ENTRIES = {
    0x103d0a50: ('physFalling', 8), 0x103d4600: ('physProjectile', 8),
    0x103d4b80: ('physRolling', 8), 0x103dd8a0: ('physPathing', 4),
    0x103de690: ('physMovingBrush', 4), 0x103d7850: ('physTrailer', 4),
    0x103ca1e0: ('physicsRotation', 4),
}


class NativeActorPhysics(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.actor = self.alloc(0x1000)
        self.events = None

    def on_instruction(self, cpu, address, size, data):
        if self.events is not None and address in ENTRIES:
            name, count = ENTRIES[address]
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            assert cpu.reg_read(collision.UC_X86_REG_ECX) == self.actor
            event = {'body': name, 'seconds': self.read(stack + 4, 'f')[0]}
            if count == 8:
                event['iterations'] = self.read(stack + 8, 'i')[0]
            self.events.append(event)
            if name == 'physMovingBrush' and self.real_mover_gate:
                return super().on_instruction(cpu, address, size, data)
            if name != 'physicsRotation':
                for offset, hex_bytes in self.patches:
                    cpu.mem_write(self.actor + offset, bytes.fromhex(hex_bytes))
            cpu.reg_write(collision.UC_X86_REG_EIP, self.read(stack, 'I')[0])
            cpu.reg_write(collision.UC_X86_REG_ESP, stack + 4 + count)
            return
        return super().on_instruction(cpu, address, size, data)

    def run(self, case):
        raw = bytes.fromhex(case['heap'])
        assert len(raw) == 0x400
        self.cpu.mem_write(self.actor, raw)
        self.patches = case.get('bodyPatches', [])
        self.real_mover_gate = case.get('realMovingBrushGate', False)
        self.events = []
        self.call(0x103c9770, self.actor, struct.pack('<f', case['seconds']))
        result = {'heap': bytes(self.cpu.mem_read(self.actor, len(raw))).hex(), 'events': self.events}
        self.events = None
        return result


if __name__ == '__main__':
    native = NativeActorPhysics(Path(sys.argv[1]))
    cases = json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes': collision.HASHES, 'results': [native.run(case) for case in cases]}))
