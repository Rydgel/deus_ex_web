"""Original ConSys BindConversations/Purge bodies with explicit lifetime services.

Run with the ignored original game directory. GNames and FString storage are
fixtures; appStricmp/appStrstr, FName(EName), GetOuter, ConListItem allocation,
constructor and deleting virtual are explicit boundaries. The entire matching,
reference-count mutation, source iteration and actor list publication execute
from the installed DLL. Concrete item lifecycle has its own native oracle.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn import UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('events', Path(__file__).with_name('native-conversation-events-oracle.py'))
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)

class ListProbe(events.ConversationEventsProbe):
    def __init__(self, root, case):
        super().__init__(root)
        self.case = case
        self.ops = []
        self.watches = {}
        self.services = {}
        self.allocated = []
        self.conversations = []
        for i, (slot, name, cleanup) in enumerate([
            (0x100130d0, 'compare', 0), (0x10013148, 'contains', 0),
            (0x100130e0, 'name', 4), (0x10013144, 'outer', 0),
        ]):
            ptr = 0x700e0000 + i * 16
            self.write(slot, 'I', ptr)
            self.services[ptr] = (name, cleanup)
        self.services[0x10002dc0] = ('allocate', 0)
        self.services[0x1000ecc0] = ('construct', 0)
        self.services[0x700e0100] = ('delete', 4)
        self.cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_write)

    def watch(self, pointer, label, field):
        self.watches[pointer] = (label, field)

    def on_write(self, cpu, access, address, size, value, data):
        if address in self.watches:
            label, field = self.watches[address]
            self.ops.append(['write', label, field, self.label(value) if field in ('con', 'next', 'ConListItems') else value])

    def make_item(self, label, con=0, next_item=0):
        ptr = self.alloc(0x30)
        self.objects_by_pointer[ptr] = label
        self.write(ptr, 'I', self.item_vtable)
        self.write(ptr + 0x28, '2I', con, next_item)
        for offset, field in [(0x1c, 'ObjectFlags'), (0x28, 'con'), (0x2c, 'next')]:
            self.watch(ptr + offset, label, field)
        return ptr

    def setup_list(self):
        self.item_vtable = self.alloc(0x80)
        self.write(self.item_vtable + 0xc, 'I', 0x700e0100)
        self.actor = self.alloc(0x300)
        self.list = self.alloc(0x40)
        self.outer = self.alloc(0x30)
        for ptr, label in [(self.actor, 'actor'), (self.list, 'list'), (self.outer, 'outer')]:
            self.objects_by_pointer[ptr] = label
        self.write(self.list + 0x18, 'I', self.outer)
        self.write_string(self.actor + 0x2ac, 'Normal')
        self.write_string(self.actor + 0x2b8, '' if self.case == 'empty-bark' else 'Barker')
        self.watch(self.actor + 0x2dc, 'actor', 'ConListItems')
        fixtures = [('NormalLine', 'Normal'), ('Yes_Bark', 'Barker'),
                    ('Normal_Bark', 'Normal'), ('lower_bark', 'Normal')]
        self.fixtures = fixtures
        gnames = self.read(0x10013124, 'I')[0]
        names = self.alloc(len(fixtures) * 4)
        self.write(gnames, '3I', names, len(fixtures), len(fixtures))
        source = []
        for index, (name, owner) in enumerate(fixtures):
            entry = self.alloc(0x100)
            self.cpu.mem_write(entry + 0xc, name.encode('utf-16-le') + b'\0\0')
            self.write(names + index * 4, 'I', entry)
            con = self.alloc(0x80)
            self.objects_by_pointer[con] = name
            self.write(con + 0x28, 'I', index)
            self.write_string(con + 0x44, owner)
            self.write(con + 0x74, 'I', 1 if index == 0 else 0)
            self.watch(con + 0x74, name, 'ownerRefCount')
            self.conversations.append(con)
            node = self.alloc(0x30)
            self.write(node + 0x28, 'I', con)
            source.append(node)
        for index, node in enumerate(source):
            self.write(node + 0x2c, 'I', source[index + 1] if index + 1 < len(source) else 0)
        self.write(self.list + 0x28, 'I', source[0])
        old = self.make_item('old', self.conversations[0])
        self.write(self.actor + 0x2dc, 'I', old)
        self.repeat_changed = False

    def on_instruction(self, cpu, address, size, data):
        if address not in getattr(self, 'services', {}):
            return super().on_instruction(cpu, address, size, data)
        name, cleanup = self.services[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)
        this = cpu.reg_read(UC_X86_REG_ECX)
        result = 0
        if name in ('compare', 'contains'):
            leftptr, rightptr = self.read(stack + 4, '2I')
            left, right = self.read_text(leftptr), self.read_text(rightptr)
            if name == 'compare':
                result = 0 if self._fold(left) == self._fold(right) else 1
                self.ops.append(['compare', left, right, result == 0])
                if self.case == 'repeat-name-change' and right == '' and not self.repeat_changed:
                    self.repeat_changed = True
                    self.write_string(self.actor + 0x2b8, '')
            else:
                index = left.find(right)
                result = 0 if index < 0 else leftptr + index * 2
                self.ops.append(['contains', left, right, index >= 0])
        elif name == 'name':
            assert self.read(stack + 4, 'I')[0] == 0
            self.write(this, 'I', 0)
        elif name == 'outer':
            assert this == self.list
            result = self.read(this + 0x18, 'I')[0]
        elif name == 'allocate':
            size_arg, outer, name_index, flags = self.read(stack + 4, '4I')
            self.ops.append(['allocate', size_arg, self.label(outer), name_index, flags])
            result = self.make_item('bound' + str(len(self.allocated)))
            # Allocation intentionally supplies existing nonzero flags; the body
            # must preserve them while adding RF_Public after the constructor.
            self.write(result + 0x1c, 'I', 0x20)
            self.allocated.append(result)
        elif name == 'construct':
            self.ops.append(['construct', self.label(this)])
            self.write(this + 0x28, '2I', 0, 0)
            result = this
        elif name == 'delete':
            flags = self.read(stack + 4, 'I')[0]
            self.ops.append(['delete', self.label(this), flags, self.label(self.read(self.actor + 0x2dc, 'I')[0])])
            # The original must retain the source head saved before Purge.
            self.write(self.list + 0x28, 'I', 0)
        cpu.reg_write(UC_X86_REG_EAX, result)
        cpu.reg_write(UC_X86_REG_EIP, self.read(stack, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + cleanup)

    def run_list(self):
        self.setup_list()
        self.call(0x10010b70, self.list, struct.pack('<I', self.actor))
        bound = []
        ptr = self.read(self.actor + 0x2dc, 'I')[0]
        while ptr:
            con, ptr = self.read(ptr + 0x28, '2I')
            bound.append(self.label(con))
        counts = [self.read(con + 0x74, 'i')[0] for con in self.conversations]
        return {'case': self.case, 'ops': self.ops, 'bound': bound, 'counts': counts}

if __name__ == '__main__':
    root = Path(sys.argv[1])
    print(json.dumps({'hash': events.CONSYS_SHA256, 'cases': [ListProbe(root, case).run_list()
        for case in ('distinct-bark', 'empty-bark', 'repeat-name-change')]}))
