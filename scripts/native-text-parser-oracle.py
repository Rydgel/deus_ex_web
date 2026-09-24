"""Unicorn oracle for DeusExText.dll's DDeusExTextParser.

Runs the hash-checked DeusExText.dll parser methods with the original Core.dll
FString/FArray/app* code and the shipped MSVCRT.dll CRT underneath them.
Extension.dll is loaded rebased (DeusExText imports XExtString from it) and
Engine/Core at their preferred bases.  Only these are host services:

  * GMalloc: a bump allocator (Malloc/Realloc/Free).  The copy OpenText makes
    of the XExtString text is placed so it ends at a page boundary followed by
    an unmapped page, so a read past the original's allocation faults instead
    of returning unrelated memory.
  * FName(const TCHAR*, EFindName) and FName::Names: a case-folding name table
    (the Core constructor needs the engine's initialized name hash).
  * StaticLoadObject / ResetLoaders / XExtString's deleting destructor:
    recorded; the loaded object is a fake XExtString whose Text (+0x2c) holds
    the case text.
  * kernel32 WideCharToMultiByte for MSVCRT _wtoi: ASCII only; anything else
    stops the run.

Reads JSON {"cases": [{"id", "steps": [...]}]} on stdin and prints one JSON
line per case with a state snapshot after every step.  Optional research
tool, never imported by the browser.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)

HASHES = {
    'DeusExText.dll': '5f64ff6be5e44a276906e72325a25e1a27406314267076c2b5ad061b4a339aa1',
    'Extension.dll': '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
    'MSVCRT.dll': 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
}
EXT = 0x12000000
GMALLOC = 0x101a7c44          # Core ?GMalloc@@3PAVFMalloc@@A
NAMES = 0x102961f0            # Core ?Names@FName@@0V?$TArray@PAUFNameEntry@@@@A
IAT = {'fname': 0x100070ac, 'staticLoadObject': 0x10007090, 'resetLoaders': 0x10007084,
       'failAssert': 0x1000707c}
OPEN_TEXT_MALLOC_RETURN = 0x10001305
GUARD = 0x30000000
PERSIST = 0x2f000000          # name table and stubs survive across cases
BODY = {'constructor': 0x10001100, 'openText': 0x10001240, 'closeText': 0x10001430,
        'setPlayerName': 0x10001460, 'processText': 0x10001780, 'isEOF': 0x100018c0,
        'getText': 0x100018e0, 'getTag': 0x10001970, 'getName': 0x10001980, 'getColor': 0x100019c0,
        'destroy': 0x10001210}


class Stop(Exception):
    pass


class TextParserOracle(_NATIVE.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {
            'DeusExText.dll': {'hash': HASHES['DeusExText.dll']},
            'Extension.dll': {'hash': HASHES['Extension.dll'], 'base': EXT},
            'MSVCRT.dll': {'hash': HASHES['MSVCRT.dll']},
        })
        # Only the stub page and the import-thunk page (which also holds the
        # return sentinel) need Python; everything else runs unhooked.
        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=PERSIST, end=PERSIST + 0xfff)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, begin=0x70000000, end=0x700fffff)
        self.cpu.mem_map(PERSIST, 0x1000000)
        self.persist_next = PERSIST
        self.stubs = {}
        for name, pop in [('malloc', 8), ('realloc', 12), ('free', 4), ('fname', 8),
                          ('staticLoadObject', 0), ('resetLoaders', 0), ('failAssert', 0),
                          ('extDelete', 4)]:
            address = self.keep(16)
            self.cpu.mem_write(address, b'\xc3')
            self.stubs[address] = (name, pop)
            setattr(self, f'stub_{name}', address)
        gmalloc, vtable = self.keep(16), self.keep(32)
        self.write(vtable, '3I', self.stub_malloc, self.stub_realloc, self.stub_free)
        self.write(gmalloc, 'I', vtable)
        self.write(GMALLOC, 'I', gmalloc)
        for key, slot in IAT.items():
            self.write(slot, 'I', getattr(self, f'stub_{key}'))
        self.ext_vtable = self.keep(64)
        self.write(self.ext_vtable + 12, 'I', self.stub_extDelete)
        self.names = ['None']
        self.name_index = {'NONE': 0}
        self.names_data = self.keep(4 * 8192)
        self.write(NAMES, '3I', self.names_data, 8192, 8192)
        self.write(self.names_data, 'I', self.name_entry('None'))
        self.guard_next = GUARD
        self.guard_maps = []
        self.sizes = {}
        self.wide_to_multi = {a for a, (dll, sym) in self.thunks.items() if sym == 'WideCharToMultiByte'}

    # ---- host services -------------------------------------------------
    def keep(self, size):
        address = self.persist_next
        self.persist_next += (size + 15) & ~15
        return address

    def name_entry(self, text):
        entry = self.keep(0x10 + 2 * (len(text) + 1))
        self.cpu.mem_write(entry + 0xc, text.encode('utf-16-le') + b'\0\0')
        return entry

    def intern(self, text, add=True):
        if text == '':
            return 0
        key = text.upper()
        if key in self.name_index:
            return self.name_index[key]
        if not add:
            return 0
        index = len(self.names)
        self.names.append(text)
        self.name_index[key] = index
        self.write(self.names_data + 4 * index, 'I', self.name_entry(text))
        return index

    def heap(self, size):
        address = self.alloc(max(size, 1))
        self.cpu.mem_write(address, b'\xcd' * max(size, 1))
        self.sizes[address] = size
        return address

    def guarded(self, size):
        span = (size + 0xfff) & ~0xfff
        self.cpu.mem_map(self.guard_next, span)
        self.guard_maps.append((self.guard_next, span))
        address = self.guard_next + span - size
        self.guard_next += span + 0x1000
        self.sizes[address] = size
        return address

    def text_at(self, address, limit=1 << 20):
        units = []
        while len(units) < limit:
            unit = self.read(address + 2 * len(units), 'H')[0]
            if unit == 0:
                break
            units.append(unit)
        return ''.join(map(chr, units))

    def fstring(self, text):
        if text == '':
            return 0, 0, 0
        raw = text.encode('utf-16-le') + b'\0\0'
        data = self.heap(len(raw))
        self.cpu.mem_write(data, raw)
        return data, len(text) + 1, len(text) + 1

    def read_fstring(self, address):
        data, num, _ = self.read(address, '3i')
        if num == 0:
            return ''
        units = [self.read(data + 2 * i, 'H')[0] for i in range(num)]
        if units[-1] != 0:
            raise Stop('FString without terminator')
        return ''.join(map(chr, units[:-1]))

    # ---- instruction hook ----------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.wide_to_multi:
            self.on_wide_to_multi(cpu)
            return
        if address in self.thunks:
            raise Stop(f'import {self.thunks[address][1]}')
        stub = self.stubs.get(address)
        if stub:
            getattr(self, f'on_{stub[0]}')(cpu)

    def ret(self, cpu, value, pop):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        back = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value & 0xffffffff)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, back)

    def args(self, cpu, count):
        return self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, f'{count}I')

    def on_malloc(self, cpu):
        size, _tag = self.args(cpu, 2)
        caller = self.read(cpu.reg_read(UC_X86_REG_ESP), 'I')[0]
        address = self.guarded(size) if caller == OPEN_TEXT_MALLOC_RETURN else self.heap(size)
        self.ret(cpu, address, 8)

    def on_realloc(self, cpu):
        original, size, _tag = self.args(cpu, 3)
        if size == 0:
            self.ret(cpu, 0, 12)
            return
        address = self.heap(size)
        if original:
            old = self.sizes.get(original, 0)
            self.cpu.mem_write(address, bytes(self.cpu.mem_read(original, min(old, size))))
        self.ret(cpu, address, 12)

    def on_free(self, cpu):
        self.ret(cpu, 0, 4)

    def on_fname(self, cpu):
        text_address, find = self.args(cpu, 2)
        if text_address == 0:
            raise Stop('FName(NULL) assertion')
        this = cpu.reg_read(UC_X86_REG_ECX)
        self.write(this, 'I', self.intern(self.text_at(text_address), find == 1))
        self.ret(cpu, this, 8)

    def on_staticLoadObject(self, cpu):
        cls, outer, name, filename, flags, sandbox = self.args(cpu, 6)
        path = self.text_at(name)
        self.events.append({'op': 'StaticLoadObject', 'path': path, 'outer': outer, 'filename': filename,
                            'flags': flags, 'sandbox': sandbox,
                            'class': 'XExtString' if cls == EXT + 0xaba40 else f'0x{cls:08x}'})
        text = self.texts.get(path)
        if text is None:
            self.ret(cpu, 0, 0)
            return
        obj = self.alloc(0x40)
        self.write(obj, 'I', self.ext_vtable)
        self.write(obj + 0x2c, '3I', *self.fstring(text))
        self.ret(cpu, obj, 0)

    def on_resetLoaders(self, cpu):
        pkg, dynamic, lazy = self.args(cpu, 3)
        self.events.append({'op': 'ResetLoaders', 'dynamicOnly': dynamic, 'forceLazyLoad': lazy})
        self.ret(cpu, 0, 0)

    def on_extDelete(self, cpu):
        flags, = self.args(cpu, 1)
        self.events.append({'op': 'DeleteLoaded', 'flags': flags})
        self.ret(cpu, cpu.reg_read(UC_X86_REG_ECX), 4)

    def on_failAssert(self, cpu):
        raise Stop('appFailAssert')

    def on_wide_to_multi(self, cpu):
        code_page, flags, wide, count, out, size, default, used = self.args(cpu, 8)
        if code_page != 0 or flags != 0 or count != 0xffffffff or default or used:
            raise Stop('unexpected WideCharToMultiByte arguments')
        text = self.text_at(wide)
        if any(ord(ch) > 0x7f for ch in text):
            raise Stop('non-ASCII WideCharToMultiByte')
        raw = text.encode('ascii') + b'\0'
        if len(raw) > size:
            raise Stop('WideCharToMultiByte buffer overflow')
        self.cpu.mem_write(out, raw)
        self.ret(cpu, len(raw), 32)

    # ---- driver --------------------------------------------------------
    def snapshot(self):
        o = self.object
        text, pos, end = self.read(o + 0x28, '3I')
        units = None
        if text:
            size = self.sizes[text]
            units = list(self.read(text, f'{size // 2}H'))
        offset = lambda p: None if p == 0 else (p - text) // 2 if text else f'0x{p:08x}'
        color = lambda at: list(self.read(at, '4B'))
        return {
            'text': units, 'textAddress': text, 'textPos': offset(pos), 'tagEndPos': offset(end),
            'lastText': self.read_fstring(o + 0x34), 'lastTag': self.read(o + 0x40, 'i')[0],
            'lastName': self.names[self.read(o + 0x44, 'I')[0]],
            'lastColor': color(o + 0x48), 'defaultColor': color(o + 0x4c),
            'flags': self.read(o + 0x50, 'I')[0],
            'playerName': self.read_fstring(o + 0x54), 'playerFirstName': self.read_fstring(o + 0x60),
            'email': [self.read_fstring(o + at) for at in (0x6c, 0x78, 0x84, 0x90, 0x9c)],
            'file': [self.read_fstring(o + at) for at in (0xa8, 0xb4)],
        }

    def step(self, step):
        op = step['op']
        if op == 'construct':
            self.object = self.alloc(0xc0)
            self.cpu.mem_write(self.object, bytes(0xc0))
            self.call(BODY['constructor'], self.object, b'')
            return {'objectAddress': self.object}
        if op == 'setPlayerName':
            self.call(BODY['setPlayerName'], self.object, self.pack('3I', *self.fstring(step['name'])))
            return {}
        if op == 'openText':
            name = self.intern(step['name'])
            value = self.call(BODY['openText'], self.object,
                              self.pack('I3I', name, *self.fstring(step['package'])))
            return {'result': value & 0xff}
        if op in ('processText', 'isEOF'):
            return {'result': self.call(BODY[op], self.object, b'') & 0xff}
        if op == 'getTag':
            return {'result': self.call(BODY['getTag'], self.object, b'')}
        if op == 'closeText':
            self.call(BODY['closeText'], self.object, b'')
            return {}
        if op == 'drain':
            # InformationDevices.CreateInfoWindow: while (ProcessText())
            # ProcessTag(), which reads GetTag, GetText and GetColor.
            records = []
            for _ in range(step.get('limit', 5000)):
                more = self.call(BODY['processText'], self.object, b'') & 0xff
                tag = self.call(BODY['getTag'], self.object, b'')
                text = self.step({'op': 'getText'})['result']
                color = self.step({'op': 'getColor'})['result']
                state = self.snapshot()
                buffer = state.pop('text')
                digest = None if buffer is None else hashlib.sha1(
                    b''.join(unit.to_bytes(2, 'little') for unit in buffer)).hexdigest()
                records.append({'more': more, 'tag': tag, 'text': text, 'color': color,
                                'textPos': state['textPos'], 'tagEndPos': state['tagEndPos'],
                                'flags': state['flags'], 'lastName': state['lastName'],
                                'lastColor': state['lastColor'], 'buffer': digest})
                if not more:
                    break
            return {'records': records}
        if op in ('getText', 'getName', 'getColor'):
            out = self.alloc(16)
            self.cpu.mem_write(out, bytes(16))
            self.call(BODY[op], self.object, self.pack('I', out))
            if op == 'getText':
                return {'result': self.read_fstring(out)}
            if op == 'getName':
                return {'result': self.names[self.read(out, 'I')[0]]}
            return {'result': list(self.read(out, '4B'))}
        raise ValueError(f'unknown step {op}')

    @staticmethod
    def pack(fmt, *values):
        import struct
        return struct.pack('<' + fmt, *values)

    def run(self, case):
        self.texts = case.get('texts', {})
        self.events = []
        self.free = 0x20000000
        for start, span in self.guard_maps:
            self.cpu.mem_unmap(start, span)
        self.guard_next, self.guard_maps, self.sizes = GUARD, [], {}
        out = {'id': case['id'], 'steps': []}
        for step in case['steps']:
            record = {'op': step['op']}
            try:
                record.update(self.step(step))
                record['state'] = self.snapshot()
            except Stop as stop:
                record['stopped'] = str(stop)
                out['steps'].append(record)
                break
            except (RuntimeError, UcError) as error:
                record['fault'] = str(error)[:160]
                out['steps'].append(record)
                break
            record['events'], self.events = self.events, []
            out['steps'].append(record)
        return out


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'Deus Ex GOTY Edition'
    request = json.load(sys.stdin)
    oracle = TextParserOracle(root)
    for case in request['cases']:
        print(json.dumps(oracle.run(case)), flush=True)


if __name__ == '__main__':
    main()
