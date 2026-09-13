"""Execute Engine's generic lazy byte-array and enclosing Sound boundaries."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
from unicorn import UC_HOOK_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

class Probe(n.NativeCollision):
    def __init__(self,root):
        super().__init__(root)
        self.archive=self.alloc(0x60);vt=self.alloc(0x60)
        self.data=self.alloc(0x20);self.owner=self.alloc(0x54)
        self.write(self.archive,'I',vt)
        self.write(self.archive+4,'I',68);self.write(self.archive+0xc,'I',1)
        self.write(self.data+4,'I',self.archive);self.write(self.data+0x18,'I',self.owner)
        self.write(self.owner+0x48,'2I',77,0xbf800000)
        self.services={}
        for index,(slot,name,cleanup) in enumerate([(4,'raw',8),(0x28,'tell',0),(0x34,'seek',4),(0x38,'attach',4),(0x14,'count-bytes',8)]):
            address=0x700e0000+index*16;self.write(vt+slot,'I',address)
            self.services[address]=(name,cleanup)
        self.services[0x103038b9]=('array',0)
        data_vt=self.alloc(8);self.write(data_vt,'I',0x700e0080);self.write(self.data,'I',data_vt)
        self.services[0x700e0080]=('load-virtual',0)
        self.ops=[];self.change=False;self.position=200
        self.generic_serialize=False
        self.cpu.hook_add(UC_HOOK_MEM_WRITE,self.on_write)

    def on_write(self,cpu,access,address,size,value,user):
        if address==self.data+8:self.ops.append(['position',value if value<0x80000000 else value-0x100000000])
        if address in [self.owner+0x48,self.owner+0x4c]:self.ops.append(['owner-write',address-self.owner,value])

    def on_instruction(self,cpu,address,size,user):
        if address==0x10303bc5 and getattr(self,'period_service',False):
            self.ops.append(['period'])
        if address not in getattr(self,'services',{}):return super().on_instruction(cpu,address,size,user)
        name,cleanup=self.services[address];sp=cpu.reg_read(UC_X86_REG_ESP)
        this=cpu.reg_read(UC_X86_REG_ECX);result=0
        if name=='tell':
            assert this==self.archive;self.ops.append(['tell',self.position]);result=self.position
        elif name=='seek':
            assert this==self.archive;self.position=self.read(sp+4,'i')[0];self.ops.append(['seek',self.position])
        elif name=='array':
            assert self.read(sp+4,'2I')==(self.archive,self.data+0xc)
            self.ops.append(['array']);self.write(self.data+0x10,'I',13)
            if self.change:self.write(self.data+8,'i',160)
        elif name=='raw':
            ptr,width=self.read(sp+4,'2I')
            if self.generic_serialize:
                assert ptr==self.read(self.data+0xc,'I')[0]
                self.ops.append(['raw-array',width]);self.cpu.mem_write(ptr,b'X'*width)
            else:
                assert width==4
                self.ops.append(['raw',4]);self.write(ptr,'I',0x800)
        elif name=='count-bytes':
            self.ops.append(['count-bytes',*self.read(sp+4,'2I')])
            self.write(self.data+0x10,'I',3)
        elif name=='compact':
            assert self.read(sp+4,'2I')==(self.archive,self.data+0x10)
            self.ops.append(['compact',self.read(self.data+0x10,'I')[0]])
            self.write(self.data+0x10,'I',5)
        elif name=='realloc':
            assert this==self.data+0xc and self.read(sp+4,'I')[0]==1
            self.ops.append(['realloc',*self.read(self.data+0x10,'2I')])
            self.write(self.data+0xc,'I',self.alloc(16))
            self.write(self.data+0x10,'I',7)
        elif name=='attach':
            assert self.read(sp+4,'I')[0]==self.data;self.ops.append(['attach'])
        elif name=='load-virtual':
            assert this==self.data;self.ops.append(['load']);self.write(self.data+0x10,'I',13)
        cpu.reg_write(UC_X86_REG_EAX,result)
        cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(UC_X86_REG_ESP,sp+4+cleanup)

    def run_case(self,position,change=False,kind='generic'):
        self.write(self.data+8,'i',position);self.change=change;self.ops=[]
        if kind=='sound-positive':
            self.period_service=True
            # Explicit GetPeriod boundary: return float32 0.5 through x87 ST0.
            self.cpu.mem_write(0x10303bc5,b'\x68'+struct.pack('<f',0.5)+b'\xd9\x04\x24\x83\xc4\x04\xc3')
            self.write(0x10580d5c,'I',0)
        if kind=='helper':
            self.write(self.read(0x10599cc0,'I')[0],'I',0)
            self.call(0x10371140,0,struct.pack('<2I',self.archive,self.data))
        else:self.call(0x1036f040 if kind.startswith('sound') else 0x1030cbb0,self.data,b'')
        return {'kind':kind,'initial':position,'change':change,'ops':self.ops,
                'position':self.read(self.data+8,'i')[0],'count':self.read(self.data+0x10,'I')[0],
                'ownerCount':self.read(self.owner+0x48,'I')[0],
                'ownerDuration':self.read(self.owner+0x4c,'f')[0]}

    def serialize_case(self):
        self.generic_serialize=True
        self.write(self.data+0x10,'2I',2,9)
        for address,name,cleanup in [(0x10599b18,'compact',0),(0x10599a20,'realloc',4)]:
            self.services[self.read(address,'I')[0]]=(name,cleanup)
        self.ops=[]
        result=self.call(0x1030cca0,0,struct.pack('<2I',self.archive,self.data+0xc))
        assert result==self.archive
        return {'kind':'serialize-array','ops':self.ops,'count':self.read(self.data+0x10,'I')[0],
                'max':self.read(self.data+0x14,'I')[0]}

if __name__=='__main__':
    root=Path(sys.argv[1])
    cases=[(128,False,'generic'),(128,True,'generic'),(0,False,'generic'),(-128,False,'sound'),(128,False,'sound-positive'),(0,False,'helper')]
    print(json.dumps([Probe(root).run_case(*case) for case in cases]+[Probe(root).serialize_case()]))
