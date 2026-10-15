"""Execute UClassProperty::ImportText (Core 0x10167110) from the unchanged retail Core.dll.

Optional research tool, never imported by the browser. The entry is the real
UClassProperty vtable slot +0x84 (a thunk to 0x10167110); it runs the real
UObjectProperty::ImportText (0x10166e20) and ReadToken (0x10164cb0). Two leaf
services are host-side, each at its Core thunk: appStricmp (0x1010239c, cdecl)
and StaticFindObject (0x1010326a, cdecl: Class, Outer, Name, ExactClass), which
searches a fixture table and records its arguments. FOutputDevice::Logf
(0x10102a95) is recorded.

The fixture is a table of named objects {name: {class: bool, super: name|null}}
(a class object carries `[+0x24] == 0x101f1c18`, the static UClass, and its
SuperField at +0x28; any other object carries another Class pointer) and the
property's MetaClass name; the property's PropertyClass (+0x5c) is a distinct
fake object so the Class argument of StaticFindObject can be checked.

Usage: python scripts/native-class-import-oracle.py GAME_DIR < input.json > results.json
input: {"objects": {...}, "bare": {"female4": "DeusEx.Female4"}, "meta": "Engine.Actor", "texts": [...]}
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ESP, UC_X86_REG_EIP

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_collision', HERE / 'native-collision-oracle.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

CLASS_IMPORT_THUNK = 0x10101190   # UClassProperty vtable (0x10175ec4) +0x84
STATIC_FIND_OBJECT = 0x1010326a
APP_STRICMP = 0x1010239c
LOGF = 0x10102a95
UCLASS_STATIC = 0x101f1c18        # the value `[object+0x24]` is compared with
VTABLE = '??_7UClassProperty@@6B@'


class ClassImportProbe(native.NativeCollision):
    def __init__(self, root, fixture):
        super().__init__(root)
        exports = native.Image(root / 'System' / 'Core.dll').exports()
        self.services = {STATIC_FIND_OBJECT: self.find, APP_STRICMP: self.stricmp, LOGF: self.logf}
        for address in self.services:
            self.cpu.mem_write(address, b'\xcc')
        self.cpu.hook_add(UC_HOOK_CODE, self.on_service, begin=min(self.services), end=max(self.services))
        self.table = {}
        self.pointer = {}
        for name, entry in fixture['objects'].items():
            obj = self.alloc(0x80)
            self.write(obj + 0x24, 'I', UCLASS_STATIC if entry['class'] else 0x101f2000)
            self.table[name.lower()] = obj
            self.pointer[obj] = name
        for name, entry in fixture['objects'].items():
            if entry.get('super'):
                self.write(self.table[name.lower()] + 0x28, 'I', self.table[entry['super'].lower()])
        for bare, full in fixture.get('bare', {}).items():
            self.table[bare.lower()] = self.table[full.lower()]
        self.property_class = self.alloc(0x80)
        self.property = self.alloc(0x80)
        self.write(self.property, 'I', exports[VTABLE])
        self.write(self.property + 0x5c, 'I', self.property_class)
        self.write(self.property + 0x64, 'I', self.table[fixture['meta'].lower()])
        self.calls = []
        self.warnings = []

    def utf16(self, address):
        units = []
        while True:
            unit = self.read(address + 2 * len(units), 'H')[0]
            if not unit:
                return ''.join(map(chr, units))
            units.append(unit)

    def arg(self, cpu, n):
        return self.read(cpu.reg_read(UC_X86_REG_ESP) + 4 + 4 * n, 'I')[0]

    def ret(self, cpu, value, pop):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        back = self.read(esp, 'I')[0]
        cpu.reg_write(UC_X86_REG_EAX, value)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + pop)
        cpu.reg_write(UC_X86_REG_EIP, back)

    def on_service(self, cpu, address, size, data):
        if address in self.services:
            self.services[address](cpu)

    def stricmp(self, cpu):
        a, b = self.utf16(self.arg(cpu, 0)).lower(), self.utf16(self.arg(cpu, 1)).lower()
        self.ret(cpu, (a > b) - (a < b) & 0xffffffff, 0)

    def logf(self, cpu):
        self.warnings.append(self.utf16(self.arg(cpu, 2)))
        self.ret(cpu, 0, 0)

    def find(self, cpu):
        cls, outer, name, exact = self.arg(cpu, 0), self.arg(cpu, 1), self.utf16(self.arg(cpu, 2)), self.arg(cpu, 3)
        self.calls.append({'class': 'PropertyClass' if cls == self.property_class else 'UClass' if cls == UCLASS_STATIC else hex(cls),
                           'outer': outer, 'name': name, 'exact': exact})
        self.ret(cpu, self.table.get(name.lower(), 0), 0)

    def run(self, text):
        self.calls, self.warnings = [], []
        data = self.alloc(16)
        self.write(data, 'I', 0xdeadbeef)
        raw = text.encode('utf-16-le') + b'\0\0\0\0'
        buffer = self.alloc(len(raw))
        self.cpu.mem_write(buffer, raw)
        # UProperty::ImportText vtable slot +0x84, thiscall: (const TCHAR*, BYTE* Data, INT PortFlags)
        result = self.call(CLASS_IMPORT_THUNK, self.property, struct.pack('<3I', buffer, data, 1))
        value = self.read(data, 'I')[0]
        return {'text': text, 'consumed': None if result == 0 else (result - buffer) // 2,
                'value': None if value == 0 else self.pointer.get(value, hex(value)),
                'raw': hex(value) if value in (0xdeadbeef,) else None,
                'find': self.calls, 'warnings': self.warnings}


def main():
    job = json.load(sys.stdin)
    probe = ClassImportProbe(Path(sys.argv[1]), job)
    json.dump({'results': [probe.run(text) for text in job['texts']]}, sys.stdout, indent=1)


if __name__ == '__main__':
    main()
