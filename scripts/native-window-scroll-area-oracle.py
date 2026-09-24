"""Original ScrollArea constructor/Init/EnableScrolling with explicit service leaves."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_EAX, UC_X86_REG_EIP
s = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
n = importlib.util.module_from_spec(s)
s.loader.exec_module(n)
EXT = 0x12000000
HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
# Service name, argument words; every unlisted instruction executes unchanged.
LEAVES = {0x4bb30: ('initWindow', 1), 0x4e060: ('askParentForReconfigure', 0),
          0x41b30: ('setScaleButtons', 2), 0x41bd0: ('setScale', 1),
          0x3d680: ('setOrientation', 1), 0x4c390: ('setSelectability', 1),
          0x3dda0: ('setNumTicks', 1), 0x3de40: ('setThumbSpan', 1),
          0x3da70: ('enableStretchedScale', 1), 0x7aa0: ('enableAutoRepeat', 3),
          0x4c7d0: ('setVisibility', 1), 0xb9f0: ('forceChildSize', 2)}
CLASSES = {EXT+0xab030:'ScaleManagerWindow', EXT+0x9a3d0:'ClipWindow',
           EXT+0x999b0:'ButtonWindow', EXT+0xaab28:'ScaleWindow'}

class Probe(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Extension.dll': {'hash': HASH, 'base': EXT}})
        self.events = []
        self.images = []

    def image(self, name, seed):
        address = self.alloc(0x240)
        data = bytes(((i*37+seed) & 255) for i in range(0x240))
        self.cpu.mem_write(address, data)
        self.images.append({'name':name, 'address':address, 'before':data.hex()})
        return address

    def ret(self, words, value=0):
        sp = self.cpu.reg_read(UC_X86_REG_ESP)
        self.cpu.reg_write(UC_X86_REG_EAX, value)
        self.cpu.reg_write(UC_X86_REG_ESP, sp+4+words*4)
        self.cpu.reg_write(UC_X86_REG_EIP, self.read(sp,'I')[0])

    def on_instruction(self, cpu, address, size, data):
        sp, obj = cpu.reg_read(UC_X86_REG_ESP), cpu.reg_read(UC_X86_REG_ECX)
        if address == 0x1014f340:
            self.events.append({'op':'uobjectConstructor','object':obj,'args':[]})
            self.ret(0,obj)
            return
        if address == EXT+0x4df70:
            cls,parent,flag = self.read(sp+4,'3I')
            child = self.image('child'+str(len(self.images)), 91+len(self.images))
            self.events.append({'op':'createNewWindow','className':CLASSES[cls],
                                'parent':parent,'flag':flag,'result':child})
            self.ret(0,child) # cdecl caller pops all three arguments
            return
        if address-EXT in LEAVES:
            op,words = LEAVES[address-EXT]
            args = list(self.read(sp+4,str(words)+'I')) if words else []
            self.events.append({'op':op,'object':obj,'args':args})
            if op == 'setVisibility' and self.mutate:
                # First callback clears the later live child references.
                self.write(self.this+0x150,'I',0)
                self.write(self.this+0x16c,'I',0)
            self.ret(words)
            return
        return super().on_instruction(cpu,address,size,data)

    def run(self, mode, seed, pointers=7, mutate=False):
        self.events, self.images, self.mutate = [], [], mutate
        self.this = self.image('this',seed)
        parent = self.image('parent',seed+1)
        args = b''
        if mode == 'ctor':
            body = EXT+0x186e0
        elif mode == 'init':
            body,args = EXT+0x42d80,struct.pack('<I',parent)
        else:
            body,args = EXT+0x43160,struct.pack('<II',seed&1,(seed>>1)&1)
            for i,off in enumerate([0x14c,0x150,0x16c]):
                self.write(self.this+off,'I',self.image('link'+str(i),seed+i+2) if pointers&(1<<i) else 0)
            self.images[0]['before'] = bytes(self.cpu.mem_read(self.this,0x240)).hex()
        self.call(body,self.this,args)
        for image in self.images:
            after = bytearray(self.cpu.mem_read(image['address'],0x240))
            if mode == 'ctor' and image['address'] == self.this:
                struct.pack_into('<I',after,0,struct.unpack_from('<I',after)[0]-0x2000000)
            image['after'] = after.hex()
        return {'mode':mode,'seed':seed,'mutate':mutate,'this':self.this,'parent':parent,
                'events':self.events,'images':self.images}

p = Probe(sys.argv[1])
cases = [p.run(mode,seed) for mode in ['ctor','init'] for seed in [0,165]]
cases += [p.run('enable',seed,pointers,mutate) for seed,pointers,mutate in
          [(0,0,False),(1,7,False),(2,7,False),(3,7,False),(1,7,True),(2,4,False)]]
print(json.dumps(cases))
