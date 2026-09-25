"""Execute the original Core text parsers the console-command path uses.

Optional research tool, never imported by the browser. The hash-pinned Core
bodies run unchanged:
  * UStructProperty::ImportText (0x101698b0), with the UStrProperty and
    UNameProperty ImportText virtuals reached through their real vtables,
    UProperty::Port and ReadToken. The fixture is the struct
    UInput::StaticInitInput builds: Children Command (UStrProperty, +4) then
    Alias (UNameProperty, +0), CPF_Config, no category. Four leaf services
    are host-side: the FName constructor (a case-insensitive name table),
    FArray::Realloc, appStrlen and FOutputDevice::Logf (recorded).
  * ParseLine (0x10147e60) and ParseToken (0x10147ba0), which call nothing.

Usage: python scripts/native-console-text-oracle.py GAME_DIR < cases.json > results.json
cases: {"struct": [text], "parseLine": [[text, maxLen, exact]],
        "parseToken": [[text, maxLen, useEscape]]}
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_EIP

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_collision', HERE / 'native-collision-oracle.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

STRUCT_IMPORT = 0x101698b0
PARSE_LINE = 0x10147e60
PARSE_TOKEN = 0x10147ba0
FNAME_CTOR = 0x10102e96        # FName(const TCHAR*, EFindName), thiscall, ret 8
FARRAY_REALLOC = 0x10101753    # FArray::Realloc(INT ElementSize), thiscall, ret 4
APP_STRLEN = 0x10101b04        # cdecl
LOGF = 0x10102a95              # FOutputDevice::Logf(EName, const TCHAR*, ...), cdecl
UPROPERTY_CLASS = 0x102a7af0
NAME_CLASS = 0x29b


class StructImportProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        exports = self.core_exports = native.Image(root / 'System' / 'Core.dll').exports()
        self.names = ['None']
        self.services = {FNAME_CTOR: self.fname, FARRAY_REALLOC: self.realloc, APP_STRLEN: self.strlen, LOGF: self.logf}
        for address in self.services:
            self.cpu.mem_write(address, b'\xcc')
        self.cpu.hook_add(UC_HOOK_CODE, self.on_service, begin=min(self.services), end=max(self.services))
        # GetInheritanceSuper (vtable +0x68) of the struct: no super.
        stub = self.alloc(16)
        self.cpu.mem_write(stub, b'\x31\xc0\xc3')
        struct_vtable = self.alloc(0x100)
        for slot in range(0, 0x100, 4):
            self.write(struct_vtable + slot, 'I', stub)
        self.struct = self.alloc(0x100)
        self.write(self.struct, 'I', struct_vtable)
        members = [('Command', '??_7UStrProperty@@6B@', 12, 4), ('Alias', '??_7UNameProperty@@6B@', 4, 0)]
        previous = 0
        for name, vtable, size, offset in reversed(members):
            prop = self.alloc(0x80)
            cls = self.alloc(0x80)
            self.write(cls + 0x28, 'I', UPROPERTY_CLASS)
            self.write(prop, 'I', exports[vtable])
            self.write(prop + 0x20, 'I', self.index(name, True))
            self.write(prop + 0x24, 'I', cls)
            self.write(prop + 0x2c, 'I', previous)
            self.write(prop + 0x34, '4I', 1, size, 0x4000, 0)
            self.write(prop + 0x48, 'I', offset)
            previous = prop
        self.write(self.struct + 0x38, 'I', previous)
        self.property = self.alloc(0x80)
        self.write(self.property + 0x5c, 'I', self.struct)

    def index(self, text, add):
        for i, name in enumerate(self.names):
            if name.lower() == text.lower():
                return i
        if not add:
            return 0
        if len(self.names) == NAME_CLASS:
            self.names.append('$reserved Class')
        self.names.append(text)
        return len(self.names) - 1

    def utf16(self, address):
        units = []
        while True:
            unit = self.read(address + 2 * len(units), 'H')[0]
            if not unit:
                return ''.join(map(chr, units))
            units.append(unit)

    def ret(self, cpu, value, pop):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        back = self.read(esp, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, back)

    def on_service(self, cpu, address, size, data):
        if address in self.services:
            self.services[address](cpu)

    def arg(self, cpu, n):
        return self.read(cpu.reg_read(UC_X86_REG_ESP) + 4 + 4 * n, 'I')[0]

    def fname(self, cpu):
        this = cpu.reg_read(UC_X86_REG_ECX)
        text, mode = self.utf16(self.arg(cpu, 0)), self.arg(cpu, 1)
        self.write(this, 'I', self.index(text, mode == 1))
        self.ret(cpu, this, 8)

    def realloc(self, cpu):
        this = cpu.reg_read(UC_X86_REG_ECX)
        element = self.arg(cpu, 0)
        data, num, capacity = self.read(this, '3I')
        fresh = self.alloc(max(capacity * element, 4)) if capacity else 0
        if data and fresh:
            cpu.mem_write(fresh, bytes(cpu.mem_read(data, min(capacity * element, 0x2000))))
        self.write(this, 'I', fresh)
        self.ret(cpu, 0, 4)

    def strlen(self, cpu):
        self.ret(cpu, len(self.utf16(self.arg(cpu, 0))), 0)

    def logf(self, cpu):
        self.warnings.append(self.utf16(self.arg(cpu, 2)))
        self.ret(cpu, 0, 0)

    def run(self, text):
        self.warnings = []
        data = self.alloc(16)
        self.write(data, '4I', 0, 0, 0, 0)
        raw = text.encode('utf-16-le') + b'\0\0'
        buffer = self.alloc(len(raw))
        self.cpu.mem_write(buffer, raw)
        result = self.call(STRUCT_IMPORT, self.property, struct.pack('<3I', buffer, data, 0))
        alias, command, count = self.read(data, '3I')
        return {'text': text, 'rest': None if result == 0 else (result - buffer) // 2,
                'Alias': self.names[alias], 'Command': self.utf16(command) if command else '',
                'warnings': self.warnings}


    def text(self, text):
        raw = text.encode('utf-16-le') + b'\0\0'
        buffer = self.alloc(len(raw))
        self.cpu.mem_write(buffer, raw)
        return buffer

    def parse(self, body, text, max_length, flag):
        # (const TCHAR*& Stream, TCHAR* Result, INT MaxLen, UBOOL flag), cdecl.
        buffer = self.text(text)
        stream = self.alloc(4)
        self.write(stream, 'I', buffer)
        result = self.alloc(2 * max_length + 2)
        self.write(result, 'H', 0x5a5a)
        value = self.call(body, 0, struct.pack('<4I', stream, result, max_length, flag))
        return {'text': text, 'max': max_length, 'flag': flag, 'ok': value,
                'consumed': (self.read(stream, 'I')[0] - buffer) // 2, 'result': self.utf16(result)}


def main():
    probe = StructImportProbe(Path(sys.argv[1]))
    cases = json.load(sys.stdin)
    json.dump({'struct': [probe.run(text) for text in cases.get('struct', [])],
               'parseLine': [probe.parse(PARSE_LINE, *case) for case in cases.get('parseLine', [])],
               'parseToken': [probe.parse(PARSE_TOKEN, *case) for case in cases.get('parseToken', [])]},
              sys.stdout, indent=1)


if __name__ == '__main__':
    main()
