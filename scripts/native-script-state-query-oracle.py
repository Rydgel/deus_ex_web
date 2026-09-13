"""Run the original Core IsInState/GetStateName bodies with explicit node chains."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class StateQueryProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))
        self.write(0x101f41b8 + 0x21 * 4, 'I', self.evaluator)

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.write(self.read(sp + 8, 'I')[0], 'I', self.test_name)
        return super().on_instruction(cpu, address, size, data)

    def query(self, names, test_name, has_frame=True):
        self.test_name = test_name
        node = 0
        for name in reversed(names):
            parent = node
            node = self.alloc(0x30)
            self.write(node + 0x20, 'I', name)
            self.write(node + 0x28, 'I', parent)
        state_frame = self.alloc(0x28)
        self.write(state_frame + 0x18, 'I', node)
        receiver = self.alloc(0x28)
        self.write(receiver + 0xc, 'I', state_frame if has_frame else 0)
        frame = self.alloc(0x20)
        code = self.alloc(16)
        self.cpu.mem_write(code, b'\x21\x16')
        self.write(frame + 8, '2I', receiver, code)
        result = self.alloc(4)
        self.call(0x1013ece0, receiver, struct.pack('<II', frame, result))
        inside = self.read(result, 'I')[0]
        advance = self.read(frame + 12, 'I')[0] - code
        self.write(frame + 12, 'I', code + 1)
        self.call(0x1013edb0, receiver, struct.pack('<II', frame, result))
        return {'names': names, 'testName': test_name, 'hasFrame': has_frame,
                'inside': inside, 'name': self.read(result, 'I')[0],
                'isInAdvance': advance, 'getNameAdvance': self.read(frame + 12, 'I')[0] - code - 1}


if __name__ == '__main__':
    probe = StateQueryProbe(Path(sys.argv[1]))
    print(json.dumps([probe.query(*args) for args in [
        ([7, 8], 7), ([7, 8], 8), ([7, 8], 9), ([7], 7, False),
        ([], 0), ([11, 12, 13], 12),
    ]]))
