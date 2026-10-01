"""Run the original Extension FlagBase iterator, DeleteFlag and DeleteAllFlags bodies.

The setup is native-flagbase-oracle.py's: original SetBool/AddFlag bodies build
a real 64-bucket table, with only UObject ctor/destroy/allocation and enum FName
construction as leaves. GMalloc (Malloc/Free, the iterator's 12 bytes) and the
UObject destructor/free reached by a flag's deleting destructor are leaves too.
CreateIterator (0x10024bb0), GetNextFlag (0x10024c50), DestroyIterator
(0x10024d00), DeleteFlag (0x10024860) and DeleteAllFlags (0x10024900) run
original bytes. The cases: a full walk, a type filter, ResetFlags' walk that
deletes the previous flag unless its name holds "SKTemp_", and DeleteAllFlags.
"""
import importlib.util, json, struct, sys
from pathlib import Path
s = importlib.util.spec_from_file_location('n', Path(__file__).with_name('native-collision-oracle.py'))
n = importlib.util.module_from_spec(s); s.loader.exec_module(n)
HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'; B = 0x12000000


class Probe(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Extension.dll': {'hash': HASH, 'base': B}})
        # A flag's deleting destructor (vtable +0xc, 0x1001a6e0) runs
        # ConditionalDestroy twice (XFlagBool, then XFlag), ~UObject and
        # operator delete. ConditionalDestroy calls the virtual Destroy once
        # per object (RF_Destroyed): the leaf jumps to the original
        # XFlag::Destroy (0x10023870: UObject::Destroy, then RemoveFlag) the
        # first time and returns afterwards.
        self.leaves = {self.read(B + off, 'I')[0]: kind for off, kind in
                       [(0x5907c, 'ctor'), (0x59080, 'destroy'), (0x5906c, 'allocate'), (0x59124, 'fname'),
                        (0x59078, 'conditionalDestroy'), (0x59074, 'dtor'), (0x5908c, 'delete')]}
        self.destroyed = set()
        self.cpu.emu_start(0x1014986b, 0x101498aa)
        self.names = ['None', 'Alpha', 'Beta', 'SKTemp_Keep', 'SKTemp_Other'] + [f'Flag{i}' for i in range(20)]
        self.name_data = self.alloc(4 * len(self.names))
        for i, name in enumerate(self.names):
            entry = self.alloc(12 + 2 * (len(name) + 1)); self.cpu.mem_write(entry + 12, (name + '\0').encode('utf-16le'))
            self.write(self.name_data + i * 4, 'I', entry)
        self.write(self.read(B + 0x59120, 'I')[0], '3I', self.name_data, len(self.names), len(self.names))
        error = self.alloc(4); self.write(error, 'I', 0x12345678); self.write(B + 0x59070, 'I', error)
        # GMalloc: an object whose vtable's Malloc (+0) and Free (+8) are leaves.
        stubs = self.alloc(16); self.cpu.mem_write(stubs, b'\xc3' * 16)
        vtable = self.alloc(16); self.write(vtable, '4I', stubs, stubs + 4, stubs + 8, stubs + 12)
        gmalloc = self.alloc(8); self.write(gmalloc, 'I', vtable)
        self.write(self.read(B + 0x59060, 'I')[0], 'I', gmalloc)
        self.leaves.update({stubs: 'malloc', stubs + 8: 'free'})
        self.nodes = []; self.events = []; self.base = self.alloc(0x12c)

    def on_instruction(self, cpu, address, size, data):
        if address not in getattr(self, 'leaves', {}):
            return super().on_instruction(cpu, address, size, data)
        kind = self.leaves[address]; sp = cpu.reg_read(n.UC_X86_REG_ESP); obj = cpu.reg_read(n.UC_X86_REG_ECX); pop = 0; value = obj
        if kind == 'allocate':
            value = self.alloc(0x44); self.nodes.append(value)
        elif kind == 'fname':
            self.write(obj, 'I', self.read(sp + 4, 'I')[0]); pop = 4
        elif kind == 'malloc':
            value = self.alloc(self.read(sp + 4, 'I')[0]); pop = 8; self.events.append(['malloc', self.read(sp + 4, 'I')[0]])
        elif kind == 'free':
            pop = 4; self.events.append(['free'])
        elif kind == 'conditionalDestroy':
            if obj not in self.destroyed:
                self.destroyed.add(obj)
                self.events.append(['conditionalDestroy', self.nodes.index(obj) if obj in self.nodes else hex(obj)])
                cpu.reg_write(n.UC_X86_REG_EIP, B + 0x23870)
                return
        elif kind == 'delete':
            self.events.append(['delete', self.nodes.index(self.read(sp + 4, 'I')[0])])
            cpu.reg_write(n.UC_X86_REG_EIP, self.read(sp, 'I')[0]); cpu.reg_write(n.UC_X86_REG_ESP, sp + 4)
            return
        else:
            self.events.append([kind, 'base' if obj == self.base else self.nodes.index(obj) if obj in self.nodes else hex(obj)])
        cpu.reg_write(n.UC_X86_REG_EAX, value); cpu.reg_write(n.UC_X86_REG_EIP, self.read(sp, 'I')[0]); cpu.reg_write(n.UC_X86_REG_ESP, sp + 4 + pop)

    def chains(self):
        out = []
        for head in self.read(self.base + 0x28, '64I'):
            chain = []
            while head:
                chain.append(self.names[self.read(head + 0x28, 'I')[0]]); head = self.read(head + 0x34, 'I')[0]
            out.append(chain)
        return out

    def walk(self, flag_type, reset=False):
        """CreateIterator(type), GetNextFlag until it returns 0 (plus one more
        call), DestroyIterator; with `reset`, ResetFlags' DeleteFlag of the
        previous name unless it holds SKTemp_."""
        it = self.call(B + 0x24bb0, self.base, struct.pack('<I', flag_type))
        out_name, out_type = self.alloc(4), self.alloc(4)
        steps, last = [], None
        for _ in range(64):
            self.write(out_name, 'I', 0xdddddddd); self.write(out_type, 'I', 0xdddddddd)
            found = self.call(B + 0x24c50, self.base, struct.pack('<3I', it, out_name, out_type))
            name = self.read(out_name, 'I')[0]
            steps.append({'found': found, 'name': self.names[name] if name < len(self.names) else hex(name),
                          'type': self.read(out_type, 'B')[0]})
            if reset and last and 'SKTemp_' not in self.names[last]:
                self.call(B + 0x24860, self.base, struct.pack('<2I', last, 0))
            last = name
            if not found:
                break
        extra = self.call(B + 0x24c50, self.base, struct.pack('<3I', it, out_name, out_type))
        steps.append({'found': extra, 'name': self.names[self.read(out_name, 'I')[0]], 'type': self.read(out_type, 'B')[0]})
        self.call(B + 0x24d00, self.base, struct.pack('<I', it))
        return steps

    def run(self):
        self.call(B + 0x239a0, self.base, b'')
        for index in range(1, len(self.names)):
            self.call(B + 0x23c60, self.base, struct.pack('<Iiii', index, index & 1, 1, -1))
        before = self.chains()
        walk_all = self.walk(7)
        walk_bools = self.walk(0)
        walk_ints = self.walk(1)
        # Beta deleted and re-added: a new node at its chain position.
        self.call(B + 0x24860, self.base, struct.pack('<2I', 2, 0))
        self.call(B + 0x23c60, self.base, struct.pack('<Iiii', 2, 1, 1, -1))
        readded = self.chains()
        reset = self.walk(7, reset=True)
        after_reset = self.chains()
        self.call(B + 0x24900, self.base, b'')
        after_delete_all = self.chains()
        return {'names': self.names[1:], 'before': before, 'walkAll': walk_all, 'walkBools': walk_bools,
                'walkInts': walk_ints, 'readded': readded, 'reset': reset, 'afterReset': after_reset,
                'afterDeleteAll': after_delete_all, 'events': self.events}


p = Probe(sys.argv[1]); print(json.dumps({'hash': HASH, **p.run()}))
