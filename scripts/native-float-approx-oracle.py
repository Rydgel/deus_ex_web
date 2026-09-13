"""Execute Core's original ComplementEqual_FloatFloat (native 210).

The operand evaluator is the only replacement: it writes the requested value
to the four-byte temporary that Core's native body loads with ``fld dword``.
The comparison body, x87 flags, threshold load, result store, and frame cursor
advance all execute from the hash-verified GOTY Core.dll.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

BODY = 0x101357E0
EVALUATOR_TABLE = 0x101F41B8
FLOAT_CONST_OPCODE = 0x1E


class FloatApproxProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        # A stdcall return matches the evaluator call's two stack arguments:
        # FFrame* followed by the temporary float destination.
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))
        self.write(EVALUATOR_TABLE + FLOAT_CONST_OPCODE * 4, 'I', self.evaluator)

    @staticmethod
    def bits(value):
        return struct.unpack('<I', struct.pack('<f', value))[0]

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            stack = cpu.reg_read(native.UC_X86_REG_ESP)
            output = self.read(stack + 8, 'I')[0]
            self.write(output, 'I', self.bits(self.operands[self.evaluation]))
            self.evaluation += 1
        return super().on_instruction(cpu, address, size, data)

    def compare(self, name, a, b):
        self.operands = [a, b]
        self.evaluation = 0
        code = self.alloc(16)
        # The final EX_EndFunctionParms byte is consumed by the native body
        # after its two P_GET_FLOAT evaluations.
        self.cpu.mem_write(code, bytes.fromhex('1e 1e 16'))
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        result = self.alloc(4)
        self.call(BODY, 0, struct.pack('<2I', frame, result))
        return {
            'name': name,
            'aBits': self.bits(a),
            'bBits': self.bits(b),
            'result': bool(self.read(result, 'I')[0]),
            'codeAdvance': self.read(frame + 12, 'I')[0] - code,
        }


CASES = [
    ('equal', 1.0, 1.0),
    ('operand-rounding', 1.0, 1.0 + 2 ** -25),
    ('signed-zero-left', -0.0, 0.0),
    ('signed-zero-right', 0.0, -0.0),
    ('threshold-nearest-below', 0.0001, 0.0),
    ('threshold-nearest-above', 0.000100000004, 0.0),
    ('threshold-nearest-above-negative', 0.0, 0.000100000004),
    ('unordered-left', float('nan'), 3.0),
    ('unordered-right', 3.0, float('nan')),
    ('infinite-equal', float('inf'), float('inf')),
    ('infinite-finite', float('inf'), 1.0),
    ('negative-infinite-finite', -float('inf'), 1.0),
]


if __name__ == '__main__':
    probe = FloatApproxProbe(Path(sys.argv[1]))
    results = [probe.compare(name, a, b) for name, a, b in CASES]
    print(json.dumps({
        'hashes': native.HASHES,
        'body': hex(BODY),
        'results': results,
    }))
