"""Execute complete original Core UClass.Bind bodies for explicit class records."""
import importlib.util
import json
from pathlib import Path
import sys
from unicorn import UC_HOOK_MEM_WRITE

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

class BindProbe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.labels = {}
        self.visits = []
        self.writes = []
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    def on_instruction(self, cpu, address, size, data):
        if address == 0x10127a20:
            self.visits.append(self.labels[cpu.reg_read(native.UC_X86_REG_ECX)])
        return super().on_instruction(cpu, address, size, data)

    def on_write(self, cpu, access, address, size, value, data):
        label = self.labels.get(address - 0x4e0)
        if label is not None:
            self.writes.append([label, value])

    def cls(self, label, base, flags, constructor):
        pointer = self.alloc(0x500)
        table = self.alloc(0x60)
        self.write(table + 0x5c, 'I', 0x10127a20)
        self.write(pointer, 'I', table)
        self.write(pointer + 0x1c, 'I', flags)
        self.write(pointer + 0x28, 'I', base)
        self.write(pointer + 0x4e0, 'I', constructor)
        self.labels[pointer] = label
        return pointer

    def run(self):
        self.write(0x101e5544, 'I', 0)
        actor = self.cls('Actor', 0x1029e0d0, 0x040f0004, 0x10302dab)
        base = self.cls('ConPlayBase', actor, 0x000f0004, 0)
        child = self.cls('DataLinkPlay', base, 0x000f0004, 0)
        self.call(0x10127a20, child, b'')
        first = {'visits': self.visits, 'writes': self.writes,
                 'constructors': [self.read(p + 0x4e0, 'I')[0] for p in [actor, base, child]]}
        self.visits = []
        self.writes = []
        self.call(0x10127a20, child, b'')
        repeat = {'visits': self.visits, 'writes': self.writes}
        self.visits = []
        self.writes = []
        editor = self.cls('EditorClass', 0, 0, 0)
        self.write(0x101e5544, 'I', 1)
        self.call(0x10127a20, editor, b'')
        return {'first': first, 'repeat': repeat,
                'editor': {'visits': self.visits, 'writes': self.writes,
                           'constructor': self.read(editor + 0x4e0, 'I')[0]}}

if __name__ == '__main__':
    print(json.dumps(BindProbe(Path(sys.argv[1])).run()))
