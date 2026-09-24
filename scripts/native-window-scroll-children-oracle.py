"""Original child constructors/Init and Scale geometry; inherited Init/event leaves explicit."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EAX
s=importlib.util.spec_from_file_location('textprobe',Path(__file__).with_name('native-textwindow-probe.py'))
p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
EXT=p.EXT
FAMILIES={'manager':(0x182d0,0x419f0),'clip':(0xce90,0xb320),'scale':(0x16f20,0x3d200)}
class Probe(p.TextWindowProbe):
    def __init__(self,root):
        super().__init__(Path(root));self.calls=[]
    def stopcall(self,words,result=0):
        sp=self.cpu.reg_read(UC_X86_REG_ESP)
        self.cpu.reg_write(UC_X86_REG_EAX,result)
        self.cpu.reg_write(UC_X86_REG_ESP,sp+4+words*4)
        self.cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0])
    def on_dispatch(self,cpu,address,size,data):
        hooks={0x1014f340:('uobjectConstructor',0),EXT+0x4bb30:('initWindow',1),EXT+0x44d90:('initTabGroup',1),
               EXT+0x3f5a0:('changeScalePosition',1),EXT+0x4e060:('askParentForReconfigure',0)}
        if address in hooks:
            name,count=hooks[address];sp=cpu.reg_read(UC_X86_REG_ESP);obj=cpu.reg_read(UC_X86_REG_ECX)
            self.calls.append({'op':name,'object':obj,'args':list(self.read(sp+4,str(count)+'I')) if count else []})
            self.stopcall(count,obj if name=='uobjectConstructor' else 0);return
        return super().on_dispatch(cpu,address,size,data)
    def run(self,family,mode,seed,fields=None,method=None,args=None):
        self.begin_case({}) # initialize shared allocator/string services
        self.calls=[]
        obj=self.alloc(0x300);parent=self.alloc(0x300)
        self.cpu.mem_write(obj,bytes((seed+i*37)&255 for i in range(0x300)))
        self.cpu.mem_write(parent,bytes(0x300))
        if mode=='init' or mode=='geometry':
            self.write(obj+0x1dc,'3I',0,0,0)
        if mode=='geometry':
            self.call(EXT+0x3d200,obj,struct.pack('<I',parent));self.calls=[]
            self.write(obj+0x30,'I',0) # invisible => original attribute broadcast gate
            self.write(obj+0x138,'I',0)
            for off,value in (fields or {}).items():self.write(obj+int(off),'I',value)
        before=bytes(self.cpu.mem_read(obj,0x300))
        ctor,init=FAMILIES[family]
        entry=method if mode=='geometry' else ctor if mode=='ctor' else init
        self.call(EXT+entry,obj,struct.pack('<'+'I'*len(args or []),*(args or [])) if mode=='geometry' else b'' if mode=='ctor' else struct.pack('<I',parent))
        after=bytearray(self.cpu.mem_read(obj,0x300))
        if mode=='ctor':struct.pack_into('<I',after,0,struct.unpack_from('<I',after)[0]-0x2000000)
        fmt=self.wstring(self.read(obj+0x1dc,'I')[0]) if family=='scale' and mode!='ctor' else None
        return {'family':family,'mode':mode,'seed':seed,'object':obj,'parent':parent,'method':entry,'args':args or [],
                'before':before.hex(),'after':after.hex(),'calls':self.calls,'format':fmt}
    def wiring(self,family,method,args,old=0):
        self.begin_case({});self.calls=[]
        obj=self.alloc(0x300);child=self.alloc(0x300);other=self.alloc(0x300)
        for address in [obj,child,other]:self.cpu.mem_write(address,bytes(0x300))
        self.write(child+0x138,'I',obj)
        self.write(obj+0x158,'I',child if old else 0)
        self.write(obj+0x184,'I',0xabcdef0c)
        named={'self':obj,'child':child,'other':other}
        args=[named.get(arg,arg) for arg in args]
        before=bytes(self.cpu.mem_read(obj,0x300))
        self.call(EXT+method,obj,struct.pack('<'+'I'*len(args),*args))
        return {'family':family,'mode':'wiring','method':method,'args':args,'object':obj,'parent':0,
                'before':before.hex(),'after':bytes(self.cpu.mem_read(obj,0x300)).hex(),'calls':self.calls,
                'extra':{str(a):bytes(self.cpu.mem_read(a,0x300)).hex() for a in [child,other]}}
probe=Probe(sys.argv[1]);result=[]
for family in FAMILIES:
 for mode in ['ctor','init']:
  for seed in [0,165]:result.append(probe.run(family,mode,seed))
f=lambda x:struct.unpack('<I',struct.pack('<f',x))[0]
for vertical,span,pos in [(0,0,0),(1,0,4),(0,1,3),(1,1,3),(0,1,0),(1,1,0)]:
 fields={0x14c:vertical,0x164:16 if span else 0,0x1cc:3,0x1c8:pos,0x80:f(101.5),0x84:f(89.25),
         0x194:f(8),0x198:f(9),0x170:f(1),0x1a4:f(3),0x1a8:f(4),0x1ac:f(5),0x1b0:f(6),0x250:f(2.25),0x254:f(67.75)}
 result.append(probe.run('scale','geometry',0,fields,0x3ed60))
for method,args in [(0x3df40,[1,10]),(0x3df40,[0,3]),(0x3df40,[4,2]),(0x3dda0,[1]),(0x3dda0,[0xffffffff]),(0x3de40,[1]),(0x3de40,[0]),(0x3f170,[99,1,0]),(0x3f170,[0xffffffff,1,0])]:
 result.append(probe.run('scale','geometry',0,{},method,args))
for args in [[1,0],[0,0],[2,3]]:result.append(probe.wiring('clip',0xb9f0,args))
for args in [['child','self'],['other','child'],[0,'other']]:result.append(probe.wiring('manager',0x41b30,args))
for args,old in [(['child'],0),(['child'],1),(['other'],1),([0],0)]:result.append(probe.wiring('manager',0x41bd0,args,old))
print(json.dumps(result))
