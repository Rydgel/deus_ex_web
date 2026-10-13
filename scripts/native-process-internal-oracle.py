"""Original UObject::ProcessInternal (Core.dll 0x1013f690): the ProbeMask gate in front of every script function.

ProcessInternal executes a script function's bytecode (the loop at 0x1013f76c) for every call, an `A.Trigger()` made by script as much as an
event the engine raises. Before it does, 0x1013f6c6-0x1013f6fe tests the function's *name*: an index in [0x12c, 0x16c) (the 64 probe
names) on an object that has a StateFrame runs only if bit (name - 0x12c) of the frame's ProbeMask (+0x1c, +0x20) is set. The fixture
supplies an object with a StateFrame, a UFunction with a name and flags, and bytecode `EX_Return EX_Nothing`; ProcessRemoteFunction
(vtable +0x18) answers 0 (local); GNatives' EX_Nothing is the original body. Observed: whether the bytecode was consumed (Stack.Code
moved), which is whether the body ran.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

PROCESS_INTERNAL, GNATIVES, EXEC_UNDEFINED = 0x1013f690, 0x101f41b8, 0x10101e60
EX_RETURN, EX_NOTHING = 0x04, 0x0b


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, None)
        self.cpu.mem_write(GNATIVES, struct.pack('<4096I', *[EXEC_UNDEFINED] * 4096))
        self.write(GNATIVES + 4 * EX_NOTHING, 'I', 0x10102095)          # UObject::execNothing
        self.vtable = self.alloc(0x100)
        stub = self.alloc(16)
        self.cpu.mem_write(stub, bytes.fromhex('31c0c20c00'))            # xor eax, eax; ret 0xc  (ProcessRemoteFunction: not remote)
        self.write(self.vtable + 0x18, 'I', stub)

    def run(self, name, mask, state_frame=True, flags=0):
        obj, frame, function = self.alloc(0x200), self.alloc(0x40), self.alloc(0x100)
        self.write(obj, 'I', self.vtable)
        if state_frame:
            self.write(obj + 0xc, 'I', frame)
            self.write(frame + 0x1c, '2I', *mask)                        # StateFrame ProbeMask
        self.write(function + 0x20, 'I', name)                           # UFunction name
        self.write(function + 0x6c, 'I', flags)                          # FunctionFlags
        code, caller_locals = self.alloc(16), self.alloc(0x40)
        self.cpu.mem_write(code, bytes([EX_RETURN, EX_NOTHING]))
        stack = self.alloc(0x40)                                         # the function's FFrame
        self.write(stack + 4, 'I', function)                             # Node
        self.write(stack + 8, 'I', obj)                                  # Object
        self.write(stack + 0xc, 'I', code)                               # Code
        self.write(stack + 0x10, 'I', caller_locals)                     # Locals
        self.call(PROCESS_INTERNAL, obj, struct.pack('<II', stack, self.alloc(16)))
        moved = self.read(stack + 0xc, 'I')[0] - code
        return {'bodyRan': moved != 0, 'codeAdvance': moved}

    def capture(self):
        bit = lambda n: (1 << n) & 0xffffffff
        cases = {}
        for label, name, mask, kw in [
            ('probeBitSet', 0x12c + 4, (bit(4), 0), {}),
            ('probeBitClear', 0x12c + 4, (bit(5), 0), {}),
            ('probeMaskZero', 0x12c + 4, (0, 0), {}),
            ('firstProbeBitClear', 0x12c, (0xfffffffe, 0xffffffff), {}),
            ('firstProbeBitSet', 0x12c, (1, 0), {}),
            ('word1BitClear', 0x12c + 40, (0xffffffff, bit(7)), {}),
            ('word1BitSet', 0x12c + 40, (0, bit(8)), {}),
            ('lastProbeBitClear', 0x16b, (0xffffffff, 0x7fffffff), {}),
            ('lastProbeBitSet', 0x16b, (0, 0x80000000), {}),
            ('firstOutsideRangeMaskZero', 0x16c, (0, 0), {}),
            ('belowRangeMaskZero', 0x12b, (0, 0), {}),
            ('noStateFrameProbeName', 0x12c + 4, (0, 0), {'state_frame': False}),
        ]:
            cases[label] = self.run(name, mask, **kw)
        return cases


if __name__ == '__main__':
    print(json.dumps({'hashes': native.HASHES, 'cases': Probe(Path(sys.argv[1])).capture()}))
