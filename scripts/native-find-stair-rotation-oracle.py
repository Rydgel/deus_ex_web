"""APawn::execFindStairRotation (Engine.dll 0x103bb880, native 524) executed unchanged under Unicorn.

The registered exec runs from the hash-pinned Engine.dll with Core.dll (FCoords::operator/=(FRotator), the sine table GMath
fills, the FVector constructors) and the CRT _ftol the exec calls: the DeltaTime float comes through a GNatives evaluator
stub that reads it from the fake FFrame's code (the exec-diff contract), and the only stub standing in for the original is
the level's ULevel::SingleLineCheck (vtable +0xc0 of Actor+0xac, ret 0x24): it records the arguments the exec built (End and
Start vectors, flags, extent, extra node flags, the source) and answers Hit.Time from the case (1.0 for a clear trace, as
the original leaves it: src/runtime/line-filter.mjs, validated against the original).

Pawn fields (APawn): Level +0xac, Location +0x114, CollisionRadius +0x1d4, CollisionHeight +0x1d8, ViewRotation +0x3dc,
EyeHeight +0x3f4. Cases arrive as JSON on stdin, every float as its uint32 bit pattern:
  {"cases": [{"dt": bits, "location": [bits x3], "rotation": [pitch, yaw, roll], "eye": bits, "radius": bits, "height": bits,
              "times": [bits x5]}]}
and the answer is {"results": [{"result": int, "pitchAfter": int, "calls": [...], "consumed": n}]}.

  native-find-stair-rotation-oracle.py GAME_ROOT < cases.json
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('collision', Path(__file__).with_name('native-collision-oracle.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

EXEC = 0x103bb880
GMATH, GMATH_CTOR = 0x101b3218, 0x10102978   # Core's FGlobalMath instance and its constructor
GNATIVES = 0x101f41b8       # Core's GNatives array (the Engine IAT slot 0x10599a38 points at it)
TOK_FLOAT, TOK_END = 0x1e, 0x16
SLC = 0x700fc060            # the stubbed ULevel::SingleLineCheck
FLOAT_EVAL = 0x700fc100
# GNatives evaluator for a float operand: copies the dword at *frame.Code to *out and advances Code by 4 (stdcall, ret 8).
FLOAT_EVAL_CODE = bytes.fromhex('56' '8b442408' '8b500c' '8b4c240c' '8b32' '8931' '83400c04' '5e' 'c20800')


def bits_to_float(value):
    return struct.unpack('<f', struct.pack('<I', value))[0]


class Stair(c.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.active, self.calls, self.times = False, [], []
        # Core's FGlobalMath constructor fills GMath: the sine table FCoords /= FRotator reads (with the measured FSIN entry) and UnitCoords.
        self.call(GMATH_CTOR, GMATH, b'')
        self.cpu.mem_write(SLC, bytes.fromhex('c2 24 00'))
        self.cpu.mem_write(FLOAT_EVAL, FLOAT_EVAL_CODE)
        self.write(GNATIVES + 4 * TOK_FLOAT, 'I', FLOAT_EVAL)
        self.pawn = self.alloc(0x600)
        level, vtable = self.alloc(0x40), self.alloc(0x200)
        self.write(self.pawn + 0xac, 'I', level)
        self.write(level, 'I', vtable)
        self.write(vtable + 0xc0, 'I', SLC)
        self.frame, self.code, self.result = self.alloc(0x40), self.alloc(0x40), self.alloc(16)

    def on_instruction(self, cpu, address, size, data):
        if self.active and address == SLC:
            stack = cpu.reg_read(c.UC_X86_REG_ESP)
            hit, source, end, start, flags = self.read(stack + 4, '5I')
            extent = self.read(stack + 0x18, '3I')
            extra = self.read(stack + 0x24, 'I')[0]
            self.calls.append({'source': source == self.pawn, 'end': list(self.read(end, '3I')), 'start': list(self.read(start, '3I')),
                               'flags': flags, 'extent': list(extent), 'extra': extra})
            time = bits_to_float(self.times[len(self.calls) - 1])
            # A blocking hit overwrites the result; a clear trace leaves Time 1.0 and Actor NULL (line-filter.mjs).
            self.write(hit + 4, 'I', 0 if time == 1.0 else 0x1234)
            self.write(hit + 0x24, 'I', self.times[len(self.calls) - 1])
            cpu.reg_write(c.UC_X86_REG_EAX, 1 if time == 1.0 else 0)
            return
        super().on_instruction(cpu, address, size, data)

    def run(self, case):
        self.write(self.pawn + 0x114, '3I', *case['location'])
        self.write(self.pawn + 0x1d4, 'I', case['radius'])
        self.write(self.pawn + 0x1d8, 'I', case['height'])
        self.write(self.pawn + 0x3dc, '3i', *case['rotation'])
        self.write(self.pawn + 0x3f4, 'I', case['eye'])
        self.cpu.mem_write(self.code, bytes([TOK_FLOAT]) + struct.pack('<I', case['dt']) + bytes([TOK_END]) + bytes(0x20))
        self.write(self.frame + 8, 'I', self.pawn)
        self.write(self.frame + 0xc, 'I', self.code)
        self.write(self.result, '4I', 0xcdcdcdcd, 0, 0, 0)
        self.times, self.calls, self.active = case['times'], [], True
        try:
            self.call(EXEC, self.pawn, struct.pack('<II', self.frame, self.result))
        finally:
            self.active = False
        return {'result': self.read(self.result, 'i')[0], 'pitchAfter': self.read(self.pawn + 0x3dc, 'i')[0], 'calls': self.calls,
                'consumed': self.read(self.frame + 0xc, 'I')[0] - self.code}


def main():
    oracle = Stair(Path(sys.argv[1]))
    cases = json.load(sys.stdin)['cases']
    print(json.dumps({'hashes': c.HASHES, 'results': [oracle.run(case) for case in cases]}))


if __name__ == '__main__':
    main()
