"""Original Core primitive-cast handlers (GCasts, registered into GNatives)
run unchanged in Unicorn: ByteToBool 0x3b, IntToBool 0x3e, BoolToByte 0x40,
BoolToInt 0x41, BoolToFloat 0x42 and FloatToBool 0x45.

Each handler is `execX(FFrame& Stack, RESULT_DECL)`: it reads one token byte,
calls GNatives[token] with a zero-initialised operand local, converts the
local and stores the result. The operand token is served by an evaluator that
writes the case value at the operand's own width (the same technique as
native-numeric-conversion-oracle.py). Cases are JSON on stdout; the Core
handler addresses come from the GNatives registration cells
(docs/script-core-casts.md). Run with the project's native probe Python.
"""
import importlib.util
import json
import math
import struct
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

# cast token -> (handler body, operand format, operand token, result format)
HANDLERS = {
    0x3b: (0x10131120, 'B', 0x24, 'I'),   # ByteToBool: setne on the byte
    0x3e: (0x101314c0, 'i', 0x1d, 'I'),   # IntToBool: test eax,eax; setne
    0x40: (0x101317b0, 'I', 0x27, 'B'),   # BoolToByte: and dl,1; store byte
    0x41: (0x10131850, 'I', 0x27, 'I'),   # BoolToInt: and edx,1; store dword
    0x42: (0x101318f0, 'I', 0x27, 'f'),   # BoolToFloat: and 1; fild; fstp dword
    0x45: (0x10131be0, 'f', 0x1e, 'I'),   # FloatToBool: fcomp 0.0; test ah,0x40
}
VALUES = {
    'B': [0, 1, 2, 0x7f, 0x80, 0xff],
    'i': [0, 1, -1, 0x7fffffff, -0x80000000, 256, 0x10000],
    'I': [0, 1, 2, 3, 0xffffffff, 0x80000000, 0x10000],
    'f': [0.0, -0.0, 1.0, -1.0, 0.5, 1e-45, -1e-45, 3.4028234663852886e38, math.inf, -math.inf, math.nan],
}


class CastProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.evaluator = self.alloc(16)
        self.cpu.mem_write(self.evaluator, bytes.fromhex('c2 08 00'))   # ret 8 (stdcall: Stack, Result)
        for token in (0x24, 0x1d, 0x27, 0x1e):
            self.write(0x101f41b8 + token * 4, 'I', self.evaluator)

    def on_instruction(self, cpu, address, size, data):
        if address == self.evaluator:
            sp = cpu.reg_read(native.UC_X86_REG_ESP)
            self.write(self.read(sp + 8, 'I')[0], self.operand_format, self.operand)
        return super().on_instruction(cpu, address, size, data)

    def convert(self, token, value):
        body, operand_format, operand_token, result_format = HANDLERS[token]
        self.operand_format, self.operand = operand_format, value
        code = self.alloc(16)
        self.cpu.mem_write(code, bytes([operand_token]))
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        output = self.alloc(8)
        self.write(output, 'Q', 0xa5a5a5a5a5a5a5a5)
        self.call(body, 0, struct.pack('<2I', frame, output))
        raw = bytes(self.cpu.mem_read(output, 8))
        width = struct.calcsize(result_format)
        result = struct.unpack('<' + result_format, raw[:width])[0]
        return {'token': token, 'input': value if operand_format != 'f' else (value if math.isfinite(value) else str(value)),
                'result': result, 'untouched': raw[width:].hex(),
                'codeAdvance': self.read(frame + 12, 'I')[0] - code}


if __name__ == '__main__':
    probe = CastProbe(Path(sys.argv[1]))
    print(json.dumps([probe.convert(token, value) for token, (_, fmt, _, _) in HANDLERS.items() for value in VALUES[fmt]]))
