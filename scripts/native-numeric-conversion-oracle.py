"""Original Core FloatToInt with explicit operand evaluator and existing _ftol bridge."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NumericProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))
        self.write(0x101f41b8 + 0x1e * 4, 'I', self.evaluator)

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.write(self.read(sp + 8, 'I')[0], 'f', self.number)
        return super().on_instruction(cpu, address, size, data)

    def convert(self, number):
        self.number = number
        code = self.alloc(16)
        self.cpu.mem_write(code, b'\x1e')
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        output = self.alloc(4)
        self.call(0x10131b40, 0, struct.pack('<2I', frame, output))
        return {'input': number, 'output': self.read(output, 'i')[0],
                'codeAdvance': self.read(frame + 12, 'I')[0] - code}


if __name__ == '__main__':
    probe = NumericProbe(Path(sys.argv[1]))
    print(json.dumps([probe.convert(value) for value in [0, 300.9, -300.9, 2147483520, 2147483648]]))
