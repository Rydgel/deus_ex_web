"""Original UObject::GotoState / execGotoState / GotoLabel (Core.dll) over a fabricated state frame.

The instructions of Core's GotoState (0x1012e8f0), its exec wrapper (native 113, 0x1013dd00: the `GotoState(optional name
NewState, optional name Label)` script native) and GotoLabel (0x1012eb10) execute unchanged. The fixtures supply the pointer graph (an
object with a StateFrame, a class, two states with probe/ignore masks and label tables) and the exec's bytecode stream; the GNatives
table entries the wrapper reads its parameters through (EX_NameConst, EX_Nothing) are the original bodies. One explicit boundary: FindState
(0x10150c80, a StaticFindObject lookup by name) answers from the fixture's name table.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_EIP, UC_X86_REG_ESP, UC_X86_REG_EAX

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

GOTO_STATE, GOTO_LABEL, EXEC_GOTO_STATE, FIND_STATE = 0x1012e8f0, 0x1012eb10, 0x1013dd00, 0x10150c80
GNATIVES, EXEC_UNDEFINED = 0x101f41b8, 0x10101e60
NAME_BEGIN, NAME_AUTO = 0x64, 0x2a3
EX_NOTHING, EX_NAME_CONST, EX_END_PARMS = 0x0b, 0x21, 0x16


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root, None)
        self.states = {}      # FName index -> UState*
        self.entries = []     # (address, arguments) of GotoState / GotoLabel bodies reached
        # GNatives: every opcode undefined except the three the exec wrapper reads its parameters through.
        self.cpu.mem_write(GNATIVES, struct.pack('<4096I', *[EXEC_UNDEFINED] * 4096))
        for token, body in [(EX_NAME_CONST, 0x10101fc8), (EX_NOTHING, 0x10102095), (EX_END_PARMS, 0x1010103c)]:
            self.write(GNATIVES + 4 * token, 'I', body)
        vtable = self.alloc(0x100)
        self.write(vtable + 0x30, 'I', GOTO_STATE)
        self.write(vtable + 0x34, 'I', GOTO_LABEL)
        self.vtable = vtable
        self.klass = self.alloc(0x100)
        # state scripts: label tables are (FName, offset) pairs ended by a zero name, at the Script base + LabelTableOffset
        self.make_state(1001, 'S1', {1101: 0x10, 1102: 0x20})
        self.make_state(1002, 'S2', {1201: 0x30, NAME_BEGIN: 0x04})

    def make_state(self, name, key, labels):
        state, script = self.alloc(0x100), self.alloc(0x200)
        table = 0x100
        self.write(state + 0x20, 'I', name)
        self.write(state + 0x44, 'I', script)
        self.write(state + 0x80, 'H', table)
        for i, (label, offset) in enumerate(sorted(labels.items())):
            self.write(script + table + 8 * i, '2I', label, offset)
        self.write(script + table + 8 * len(labels), '2I', 0, 0)
        # probe and ignore masks: distinct per state so a recomputation is visible
        self.write(state + 0x6c, '2I', 0x00000100 if key == 'S1' else 0x00000200, 0)
        self.write(state + 0x74, '2I', 0xffffffff, 0xffffffff)
        self.states[name] = state
        setattr(self, key, state)
        setattr(self, key + '_script', script)

    def on_instruction(self, cpu, address, size, data):
        if address == FIND_STATE:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            name = self.read(esp + 4, 'I')[0]
            cpu.reg_write(UC_X86_REG_EAX, self.states.get(name, 0))
            cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
            cpu.reg_write(UC_X86_REG_ESP, esp + 8)
            return
        if address in (GOTO_STATE, GOTO_LABEL):
            esp = cpu.reg_read(UC_X86_REG_ESP)
            self.entries.append(('GotoState' if address == GOTO_STATE else 'GotoLabel', self.read(esp + 4, 'I')[0]))
        return super().on_instruction(cpu, address, size, data)

    def fixture(self, mask, latent=0x55, code_offset=0x40, state=None):
        obj, frame = self.alloc(0x200), self.alloc(0x40)
        state = state or self.S1
        script = {self.S1: self.S1_script, self.S2: self.S2_script}[state]
        self.write(obj, 'I', self.vtable)
        self.write(obj + 0xc, 'I', frame)
        self.write(obj + 0x24, 'I', self.klass)
        self.write(self.klass + 0x6c, '2I', 0x00000001, 0x00000000)       # class ProbeMask
        self.write(frame + 4, 'I', state)                                  # Node
        self.write(frame + 8, 'I', obj)                                    # Object
        self.write(frame + 0xc, 'I', script + code_offset)                 # Code
        self.write(frame + 0x18, 'I', state)                               # StateNode
        self.write(frame + 0x1c, '2I', *mask)                              # ProbeMask
        self.write(frame + 0x24, 'I', latent)                              # LatentAction
        return obj, frame

    def snapshot(self, obj, frame, result, entries):
        names = {self.S1: 'S1', self.S2: 'S2', 0: None, self.klass: 'class'}
        scripts = {self.S1: self.S1_script, self.S2: self.S2_script}
        node, code, state = self.read(frame + 4, 'I')[0], self.read(frame + 0xc, 'I')[0], self.read(frame + 0x18, 'I')[0]
        return {'result': result & 0xffffffff, 'node': names.get(node, hex(node)), 'stateNode': names.get(state, hex(state)),
                'code': None if code == 0 else code - scripts[node if node in scripts else state],
                'probeMask': list(self.read(frame + 0x1c, '2I')), 'latent': self.read(frame + 0x24, 'I')[0],
                'flags': self.read(obj + 0x1c, 'I')[0], 'entered': entries}

    def run_native(self, new_state, **kw):
        obj, frame = self.fixture(**kw)
        self.entries = []
        result = self.call(GOTO_STATE, obj, struct.pack('<I', new_state))
        return self.snapshot(obj, frame, result, self.entries)

    def run_exec(self, params, **kw):
        """The script native: params is a list of None (EX_Nothing) or FName indices; ends with EX_EndFunctionParms."""
        obj, frame = self.fixture(**kw)
        code = bytearray()
        for p in params:
            code += bytes([EX_NOTHING]) if p is None else bytes([EX_NAME_CONST]) + struct.pack('<I', p)
        code += bytes([EX_END_PARMS])
        stream, caller = self.alloc(len(code) + 16), self.alloc(0x40)
        self.cpu.mem_write(stream, bytes(code))
        self.write(caller + 8, 'I', obj)
        self.write(caller + 0xc, 'I', stream)
        self.entries = []
        self.call(EXEC_GOTO_STATE, obj, struct.pack('<II', caller, self.alloc(16)))
        return self.snapshot(obj, frame, 0, self.entries)

    def capture(self):
        mask = (0xa5a5a5a5, 0x5a5a5a5a)          # no recomputation can produce this
        same = {'mask': mask}
        cases = {
            'nativeSameState': lambda: self.run_native(1001, **same),
            'nativeDifferentState': lambda: self.run_native(1002, **same),
            'execNoParameters': lambda: self.run_exec([None, None], **same),
            'execSameStateNoLabel': lambda: self.run_exec([1001, None], **same),
            'execSameStateLabel': lambda: self.run_exec([1001, 1101], **same),
            'execSameStateBeginDefault': lambda: self.run_exec([1001, NAME_BEGIN], **same),
            'execDifferentStateNoLabel': lambda: self.run_exec([1002, None], **same),
            'execDifferentStateLabel': lambda: self.run_exec([1002, 1201], **same),
        }
        out = {}
        for name, run in cases.items():
            try:
                out[name] = run()
            except Exception as error:   # a boundary the fixture does not model is reported, not guessed
                out[name] = {'error': str(error)[:300]}
        return out


if __name__ == '__main__':
    print(json.dumps({'hashes': native.HASHES, 'cases': Probe(Path(sys.argv[1])).capture()}))
