"""Generic Unicorn oracle for registered Extension.dll exec bodies.

One harness for every native with the same calling contract, instead of one
probe per native: `void UObject::execX(FFrame& Stack, RESULT_DECL)`.  The
registered exec body runs from the hash-checked Extension.dll (rebased to
0x12000000; Core/Engine at their preferred bases) with

  * ecx = a receiver image filled with the case's bytes,
  * a fake FFrame (Object at +0x8, Code at +0xc over zero tokens),
  * the Extension IAT slot for Core!GNatives pointing at a table whose every
    entry is a stub that writes the case's next parameter value (little-endian,
    at the parameter's own width) through the eval result pointer, or nothing
    for a skipped optional parameter (EX_Nothing),
  * a Result slot pre-filled with 0xcd.

The run is a *leaf* run: the first control transfer out of the exec body to
anything but the GNatives stub stops it and is reported with its callee, and
any write outside the receiver, frame, code, result and stack is reported as a
global write.  Only leaf runs are comparable; the caller decides what to do
with the rest.  Reads JSON {"cases": [...]} on stdin and prints one JSON result
per case.  Optional research tool, never imported by the browser.
"""
import importlib.util
import json
from pathlib import Path
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UcError
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
IMAGE_BASE = 0x10000000
EXT = 0x12000000
GNATIVES_IAT = EXT + 0x59064
# Extension functions recorded as events instead of executed: (name, callee-
# popped argument bytes). XWindow::AskParentForReconfigure walks the parent
# chain, which a receiver-only case does not have (see the control probe).
EVENTS = {EXT + 0x4e060: ('AskParentForReconfigure', 0),
          # XWindow::MakeAcceleratorTableDirty walks to the root's table.
          EXT + 0x4c1d0: ('MakeAcceleratorTableDirty', 0)}
FRAME_PAGE = 0x0012e000


class Stop(Exception):
    pass


class ExecDiff(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXT}})
        self.stub = self.alloc(16)
        self.cpu.mem_write(self.stub, b'\xc3')
        table = self.alloc(0x400)
        for i in range(0x100):
            self.write(table + 4 * i, 'I', self.stub)
        self.write(GNATIVES_IAT, 'I', table)
        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)
        self.cpu.mem_map(FRAME_PAGE, 0x1000)
        self.regions = []

    @staticmethod
    def original(address):
        return address - EXT + IMAGE_BASE if EXT <= address < EXT + 0x1000000 else address

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise Stop(f'import {self.thunks[address][1]}')
        if self.pending is not None:
            kind, self.pending = self.pending, None
            if address == self.stub:
                self.on_gnative(cpu)
                return
            if address in EVENTS:
                self.on_event(cpu, address)
                return
            if kind == 'indirect':
                raise Stop(f'virtual 0x{self.original(address):08x}')
        # Direct calls and jumps inside Extension.dll are the native's own
        # body (exec marshallers call their C++ method); leaving the image is
        # a Core/Engine service the leaf comparison does not model.
        if not EXT <= address < EXT + 0x100000:
            raise Stop(f'leaves Extension at 0x{address:08x}')
        code = bytes(cpu.mem_read(address, min(size, 2)))
        if code[0] == 0xe8:
            self.pending = 'direct'
        elif code[0] == 0xff and len(code) > 1 and (code[1] >> 3) & 7 in (2, 3):
            self.pending = 'indirect'

    def on_event(self, cpu, address):
        name, arg_bytes = EVENTS[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)
        receiver = cpu.reg_read(UC_X86_REG_ECX)
        self.events.append({'op': name, 'object': 'this' if receiver == self.this else f'0x{receiver:08x}'})
        ret = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def on_gnative(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result = self.read(stack + 4, '2I')
        if not self.params:
            raise Stop('extra parameter evaluation')
        param = self.params.pop(0)
        if not param.get('skip'):
            self.cpu.mem_write(result, bytes.fromhex(param['bytes']))
        ret = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_ESP, stack + 12)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def on_write(self, cpu, access, address, size, value, data):
        if not any(base <= address < base + length for base, length in self.regions):
            self.global_writes.append(f'0x{self.original(address):08x}')

    def run(self, case):
        self.entry = case['exec'] - IMAGE_BASE + EXT
        self.pending = None
        self.params = list(case['params'])
        self.global_writes = []
        self.events = []
        this_bytes = bytes.fromhex(case['this'])
        this = self.this = self.alloc(len(this_bytes))
        self.cpu.mem_write(this, this_bytes)
        # Optional pointer-linked images let exec bodies follow real receiver
        # fields. Each block is mapped and compared in full by the caller;
        # native callees execute normally, without pointer-service stubs.
        blocks = []
        for block in case.get('pointees', []):
            data = bytes.fromhex(block['bytes'])
            address = self.alloc(len(data))
            self.cpu.mem_write(address, data)
            self.write(this + block['offset'], 'I', address)
            blocks.append((block['offset'], address, len(data)))
        # FString receiver fields: {Data, ArrayNum, ArrayMax} over a UTF-16
        # buffer with its terminator (ArrayNum counts it; empty is all zero).
        for field in case.get('strings', []):
            text = field['text'].encode('utf-16-le')
            data = 0
            if text:
                data = self.alloc(len(text) + 2)
                self.cpu.mem_write(data, text + b'\0\0')
            count = len(text) // 2 + 1 if text else 0
            self.write(this + field['offset'], '3I', data, count, count)
        code = self.alloc(0x40)
        self.cpu.mem_write(code, bytes(0x40))
        # The calling script's FFrame is a native-stack local in the game
        # (Win32 main-thread stack, below 16 MB). Some exec bodies reuse the
        # FFrame& argument slot for a partially initialized local, so the
        # frame's address is observable; keep it in a low stack-like page.
        frame = FRAME_PAGE + 0x100
        self.cpu.mem_write(frame, bytes(0x40))
        self.write(frame + 8, 'I', this)
        self.write(frame + 0xc, 'I', code)
        result = self.alloc(0x20)
        self.cpu.mem_write(result, b'\xcd' * 0x20)
        # fs:[0] (the page at 0) is the SEH registration chain that C++ method
        # prologues/epilogues write; it is frame-local, not a global effect.
        self.regions = [(this, len(this_bytes)), (code, 0x40), (frame, 0x40), (result, 0x20),
                        (self.stack - 0x10000, 0x10010), (0, 0x10000)]
        self.regions += [(address, length) for _, address, length in blocks]
        out = {'id': case['id']}
        try:
            self.call(self.entry, this, self.frame_args(frame, result))
            out['status'] = 'leaf' if not self.global_writes else 'global-write'
        except Stop as stop:
            out['status'] = 'stopped'
            out['reason'] = str(stop)
        except (RuntimeError, UcError) as error:
            # Typically a dereference of a receiver field: the case's pattern
            # bytes are not a mapped pointer, so the body follows pointers.
            out['status'] = 'error'
            out['reason'] = str(error)[:200]
        out['this'] = bytes(self.cpu.mem_read(this, len(this_bytes))).hex()
        if blocks:
            out['pointees'] = [{'offset': offset, 'bytes': bytes(self.cpu.mem_read(address, length)).hex()}
                               for offset, address, length in blocks]
        out['result'] = bytes(self.cpu.mem_read(result, 0x20)).hex()
        out['codeAdvance'] = self.read(frame + 0xc, 'I')[0] - code
        out['paramsLeft'] = len(self.params)
        out['events'] = self.events
        if self.global_writes:
            out['globalWrites'] = sorted(set(self.global_writes))[:8]
        return out

    @staticmethod
    def frame_args(frame, result):
        return frame.to_bytes(4, 'little') + result.to_bytes(4, 'little')


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'Deus Ex GOTY Edition'
    request = json.load(sys.stdin)
    probe = ExecDiff(root)
    for case in request['cases']:
        print(json.dumps(probe.run(case)))
        probe.free = 0x20000000 + 0x100000   # reuse scratch; the first MB holds the GNatives stub/table


if __name__ == '__main__':
    main()
