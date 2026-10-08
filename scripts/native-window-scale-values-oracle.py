"""Original ScaleWindow value-string natives, run unchanged in Unicorn:
SetValueFormat (1646), GetValueString (1647), SetEnumeration (1648),
ClearAllEnumerations (1649) and PlayScaleSound (1653).

Unlike the leaf harness (native-exec-diff-oracle.py), these bodies call Core:
FArray::Realloc / Remove / ~FArray, appStrlen / appStricmp / appStrcpy,
FString::operator= and appSprintf. Core.dll runs as loaded from the hash-checked
image; its only outside dependencies are modelled here:

  * GMalloc: a bump allocator behind a fake FMalloc vtable (Malloc, Realloc,
    Free), tracking block sizes so Realloc copies.
  * MSVCRT string primitives (wcslen, wcscpy, ...): libc definitions.
  * MSVCRT _vsnwprintf: answered from a table the validator measured with the
    game's own MSVCRT.dll under Wine (scripts/validate-msvcrt-text-hardware.mjs
    probe), keyed by format text and the double's bits. A format/argument pair
    missing from the table stops the run.
  * XWindow::AskParentForReconfigure (0x1004e060), the ChangeScalePosition body
    0x1003f5a0 and the sound call 0x10050050 are recorded as events with their
    arguments instead of executed (their effects are other validated bodies).

Reads JSON {"cases": [...]} on stdin, prints one JSON result per case. See
docs/script-window-scale-settings.md.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('exec_diff', Path(__file__).with_name('native-exec-diff-oracle.py'))
diff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diff)
EXT, IMAGE_BASE = diff.EXT, diff.IMAGE_BASE

# Extension functions recorded as events: address -> (name, argument dwords popped by the callee).
EVENTS = {
    EXT + 0x4e060: ('AskParentForReconfigure', 0),
    EXT + 0x3f5a0: ('ChangeScalePosition', 1),
    EXT + 0x50050: ('PlaySound', 5),          # (sound, volume, pitch, x, y), thiscall
}
GMALLOC_VARIABLE = '?GMalloc@@3PAVFMalloc@@A'


class ValueProbe(diff.ExecDiff):
    def __init__(self, root):
        super().__init__(root)
        native = diff._NATIVE
        core = native.Image(Path(root) / 'System' / 'Core.dll', native.HASHES['Core.dll']).exports()
        # Fake FMalloc: object -> vtable of three stubs.
        self.stubs = {}
        vtable = self.alloc(16)
        for slot, name in enumerate(['Malloc', 'Realloc', 'Free']):
            stub = self.alloc(16)
            self.cpu.mem_write(stub, b'\xc3')
            self.stubs[stub] = name
            self.write(vtable + 4 * slot, 'I', stub)
        malloc = self.alloc(16)
        self.write(malloc, 'I', vtable)
        self.write(core[GMALLOC_VARIABLE], 'I', malloc)
        self.heap = 0x21000000
        self.heap_end = 0x22800000

    # -- allocator -------------------------------------------------------
    def malloc(self, size):
        size = max(size, 4)
        address = self.heap
        self.heap += (size + 15) & ~15
        if self.heap >= self.heap_end:
            raise RuntimeError('oracle heap exhausted')
        self.blocks[address] = size
        return address

    def popped(self, cpu, dwords, eax=None):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + 4 * dwords)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        if eax is not None:
            cpu.reg_write(UC_X86_REG_EAX, eax & 0xffffffff)

    def args(self, cpu, count):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        return self.read(stack + 4, f'{count}I') if count else ()

    def wide(self, address):
        out = []
        while True:
            unit = self.read(address, 'H')[0]
            if not unit:
                return ''.join(out)
            out.append(chr(unit))
            address += 2

    def put_wide(self, address, text):
        self.cpu.mem_write(address, text.encode('utf-16-le') + b'\0\0')

    # -- instruction hook ------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.stubs:
            name = self.stubs[address]
            if name == 'Malloc':
                (count, _tag) = self.args(cpu, 2)
                self.popped(cpu, 2, self.malloc(count) if count else 0)
            elif name == 'Realloc':
                (original, count, _tag) = self.args(cpu, 3)
                new = self.malloc(count) if count else 0
                if original and new:
                    keep = min(self.blocks.get(original, 0), count)
                    self.cpu.mem_write(new, bytes(self.cpu.mem_read(original, keep)))
                self.popped(cpu, 3, new)
            else:
                self.args(cpu, 1)
                self.popped(cpu, 1, 0)
            return
        if address in self.thunks:
            self.crt(cpu, self.thunks[address][1])
            return
        if address == self.stub:
            self.on_gnative(cpu)
            return
        if address in EVENTS:
            name, dwords = EVENTS[address]
            stack = cpu.reg_read(UC_X86_REG_ESP)
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            event = {'op': name, 'object': 'this' if receiver == self.this else f'0x{receiver:08x}'}
            if name == 'ChangeScalePosition':
                event['args'] = list(self.read(stack + 4, 'I'))
            elif name == 'PlaySound':
                event['args'] = list(struct.unpack('<5I', bytes(self.cpu.mem_read(stack + 4, 20))))   # floats as raw bits
            self.events.append(event)
            self.popped(cpu, dwords)
            return

    def crt(self, cpu, symbol):
        """MSVCRT imports reached from Core's string helpers."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if symbol == 'wcslen':
            self.popped(cpu, 0, len(self.wide(self.read(stack + 4, 'I')[0])))
        elif symbol == 'wcscpy':
            dest, src = self.read(stack + 4, '2I')
            self.put_wide(dest, self.wide(src))
            self.popped(cpu, 0, dest)
        elif symbol in ('wcscmp', '_wcsicmp'):
            a, b = self.read(stack + 4, '2I')
            x, y = self.wide(a), self.wide(b)
            if symbol == '_wcsicmp':
                x, y = x.lower(), y.lower()
            self.popped(cpu, 0, (x > y) - (x < y))
        elif symbol == '_vsnwprintf':
            dest, count, fmt, va = self.read(stack + 4, '4I')
            (bits,) = struct.unpack('<Q', bytes(self.cpu.mem_read(va, 8)))
            key = f'{self.wide(fmt)}|{bits:016x}'
            if key not in self.printf:
                raise RuntimeError(f'_vsnwprintf {key} not measured')
            text = self.printf[key]
            self.put_wide(dest, text)
            self.popped(cpu, 0, len(text))
        elif symbol in ('memcpy', 'memmove'):
            dest, src, count = self.read(stack + 4, '3I')
            self.cpu.mem_write(dest, bytes(self.cpu.mem_read(src, count)))
            self.popped(cpu, 0, dest)
        elif symbol == 'memset':
            dest, value, count = self.read(stack + 4, '3I')
            self.cpu.mem_write(dest, bytes([value & 255]) * count)
            self.popped(cpu, 0, dest)
        else:
            raise RuntimeError(f'unmodelled import {symbol}')

    def on_gnative(self, cpu):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result = self.read(stack + 4, '2I')
        if not self.params:
            raise RuntimeError('extra parameter evaluation')
        param = self.params.pop(0)
        if 'string' in param:
            text = param['string']
            data = 0
            if text:
                data = self.malloc(len(text) * 2 + 2)
                self.put_wide(data, text)
            count = len(text) + 1 if text else 0
            self.write(result, '3I', data, count, count)
        elif not param.get('skip'):
            self.cpu.mem_write(result, bytes.fromhex(param['bytes']))
        self.popped(cpu, 2)

    def on_write(self, cpu, access, address, size, value, data):
        pass

    # -- case runner -----------------------------------------------------
    def string_at(self, address):
        data, num, _max = self.read(address, '3I')
        return self.wide(data) if data and num else '', num, _max

    def readable(self, thunk):
        """A read-back of state a failed run may have left half built."""
        try:
            return thunk()
        except Exception:
            return None

    def run(self, case):
        self.entry = case['exec'] - IMAGE_BASE + EXT
        self.params = list(case['params'])
        self.events = []
        self.blocks = {}
        self.heap = 0x21000000
        this_bytes = bytes.fromhex(case['this'])
        this = self.this = self.alloc(len(this_bytes))
        self.cpu.mem_write(this, this_bytes)
        for field in case.get('strings', []):
            text = field['text']
            data = 0
            if text:
                data = self.malloc(len(text) * 2 + 2)
                self.put_wide(data, text)
            count = len(text) + 1 if text else 0
            self.write(this + field['offset'], '3I', data, count, count)
        for array in case.get('arrays', []):
            elements = array['elements']
            size = max(array['max'], len(elements))
            data = self.malloc(size * 12) if size else 0
            for i, text in enumerate(elements):
                payload = 0
                if text:
                    payload = self.malloc(len(text) * 2 + 2)
                    self.put_wide(payload, text)
                count = len(text) + 1 if text else 0
                self.write(data + 12 * i, '3I', payload, count, count)
            self.write(this + array['offset'], '3I', data, len(elements), array['max'])
        code = self.alloc(0x40)
        self.cpu.mem_write(code, bytes(0x40))
        frame = diff.FRAME_PAGE + 0x100
        self.cpu.mem_write(frame, bytes(0x40))
        self.write(frame + 8, 'I', this)
        self.write(frame + 0xc, 'I', code)
        result = self.alloc(0x20)
        self.cpu.mem_write(result, b'\xcd' * 0x20)
        self.pending = None
        out = {'id': case['id']}
        try:
            self.call(self.entry, this, self.frame_args(frame, result))
            out['status'] = 'leaf'
        except Exception as error:      # unmodelled import, missing printf row, bad memory
            out['status'] = 'error'
            out['reason'] = str(error)[:200]
        image = bytes(self.cpu.mem_read(this, len(this_bytes)))
        out['this'] = image.hex()
        out['strings'] = [dict(zip(('text', 'num', 'max'), self.string_at(this + f['offset']))) | {'offset': f['offset']}
                          for f in case.get('strings', [])] if out['status'] == 'leaf' else []
        out['arrays'] = []
        for array in case.get('arrays', []) if out['status'] == 'leaf' else []:
            data, num, maximum = self.read(this + array['offset'], '3I')
            out['arrays'].append({'offset': array['offset'], 'num': num, 'max': maximum, 'data': bool(data),
                                  'elements': [self.string_at(data + 12 * i)[0] for i in range(num)] if data else []})
        out['result'] = bytes(self.cpu.mem_read(result, 0x20)).hex()
        out['resultString'] = self.readable(lambda: self.string_at(result)[0]) if case.get('resultString') and out['status'] == 'leaf' else None
        out['codeAdvance'] = self.read(frame + 0xc, 'I')[0] - code
        out['paramsLeft'] = len(self.params)
        out['events'] = self.events
        return out


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'Deus Ex GOTY Edition'
    request = json.load(sys.stdin)
    probe = ValueProbe(root)
    probe.printf = {f"{row['format']}|{row['bits']}": row['text'] for row in request.get('printf', [])}
    for case in request['cases']:
        print(json.dumps(probe.run(case)))
        probe.free = 0x20000000 + 0x100000


if __name__ == '__main__':
    main()
