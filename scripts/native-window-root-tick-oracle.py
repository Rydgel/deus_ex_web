"""Unchanged Extension Root.Tick/MoveTabGroup, explicit focus/layout leaves."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('child', Path(__file__).with_name('native-window-child-oracle.py'))
child = importlib.util.module_from_spec(spec)
spec.loader.exec_module(child)
N = child._NATIVE
B = child.EXTENSION_BASE

class Probe(N.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), child.EXTENSION)
        self.events = []
        self.names = {}
        self.changed = False

    def on_instruction(self, cpu, address, size, data):
        leaves = {B+0x45000: ('compute', 0), B+0x36ed0: ('resort', 0),
                  B+0x4f0e0: ('focus', 4), B+0x37210: ('accelerators', 0)}
        if address not in leaves:
            return super().on_instruction(cpu, address, size, data)
        op, args = leaves[address]
        stack = cpu.reg_read(N.UC_X86_REG_ESP)
        obj = cpu.reg_read(N.UC_X86_REG_ECX)
        event = [op, self.names[obj]]
        result = 0
        if op == 'compute': result = int(self.changed)
        if op == 'focus':
            target = self.read(stack+4, 'I')[0]
            self.write(obj+0x5c8, 'I', target)
            event.append(self.names[target])
        self.events.append(event)
        cpu.reg_write(N.UC_X86_REG_EAX, result)
        cpu.reg_write(N.UC_X86_REG_ESP, stack+4+args)
        cpu.reg_write(N.UC_X86_REG_EIP, self.read(stack,'I')[0])

    def run_case(self, case):
        self.events = []
        self.names = {}
        self.changed = case.get('changed', False)
        objs = {}
        for name in ['root','modal','a','b','x','y']:
            obj = self.alloc(0x800)
            objs[name] = obj
            self.names[obj] = name
            self.write(obj+0x30, 'I', 3)
        root, modal, a, b, x, y = [objs[n] for n in ['root','modal','a','b','x','y']]
        self.write(root+0x28,'B',3)
        active = modal if case.get('modal') else root
        if active == modal:
            self.write(modal+0x28,'B',2)
            self.write(modal+0x138,'I',root)
            self.write(root+0x140,'I',modal)
        self.write(active+0x174,'B',case.get('modalMode',0))
        for i, (group, row) in enumerate([(a,x),(b,y)]):
            self.write(group+0x28,'B',1)
            self.write(group+0x138,'I',active)
            self.write(group+0x168,'i',i)
            self.write(row+0x138,'I',group)
            self.write(row+0x30,'I',7 if case.get('selectable') else 3)
            rows=self.alloc(4); self.write(rows,'I',row)
            self.write(group+0x14c,'3I',rows,1,1)
        if case.get('groups'):
            groups=self.alloc(8);self.write(groups,'2I',a,b)
            self.write(active+0x17c,'3I',groups,2,2)
        if case.get('preferred'):self.write(active+0x178,'I',x)
        if case.get('focus'):self.write(root+0x5c8,'I',objs[case['focus']])
        self.write(root+0x620,'I',case.get('timerBits',0x3f800000))
        if 'direction' in case:self.call(B+0x4f440,root,struct.pack('<i',case['direction']))
        else:self.call(B+0x3a540,root,struct.pack('<I',case.get('dtBits',0x3e800000)))
        return {'focus':self.names.get(self.read(root+0x5c8,'I')[0]),
                'timerBits':self.read(root+0x620,'I')[0],'events':self.events}

cases=json.load(sys.stdin)
p=Probe(sys.argv[1])
print(json.dumps({'hash':child.EXTENSION_HASH,'cases':[p.run_case(c) for c in cases]}))
