"""Run original Extension FlagBase bool allocation, hash links and teardown.
Only UObject ctor/destroy/allocation and enum FName construction are leaves.
The Core CRC initialization loop and all Flag/FlagBase bodies execute original bytes.
"""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
HASH='93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';B=0x12000000
class Probe(n.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'Extension.dll':{'hash':HASH,'base':B}})
  self.leaves={self.read(B+off,'I')[0]:kind for off,kind in [(0x5907c,'ctor'),(0x59080,'destroy'),(0x5906c,'allocate'),(0x59124,'fname')]}
  self.cpu.emu_start(0x1014986b,0x101498aa)
  self.names=['None','Alpha','Beta']+[f'Flag{i}' for i in range(20)]
  self.name_data=self.alloc(4*len(self.names))
  for i,name in enumerate(self.names):
   entry=self.alloc(12+2*(len(name)+1));self.cpu.mem_write(entry+12,(name+'\0').encode('utf-16le'));self.write(self.name_data+i*4,'I',entry)
  self.write(self.read(B+0x59120,'I')[0],'3I',self.name_data,len(self.names),len(self.names))
  error=self.alloc(4);self.write(error,'I',0x12345678);self.write(B+0x59070,'I',error)
  self.nodes=[];self.events=[];self.base=self.alloc(0x12c)
 def on_instruction(self,cpu,address,size,data):
  if address not in getattr(self,'leaves',{}):return super().on_instruction(cpu,address,size,data)
  kind=self.leaves[address];sp=cpu.reg_read(n.UC_X86_REG_ESP);obj=cpu.reg_read(n.UC_X86_REG_ECX);pop=0;value=obj
  if kind=='allocate':
   args=self.read(sp+4,'7I');assert args==(B+0x9ccd8,self.base,0,0,0,0x12345678,0),args
   value=self.alloc(0x44);self.nodes.append(value);self.events.append(['allocate','FlagBool','base','None',0,None])
  elif kind=='fname':self.write(obj,'I',self.read(sp+4,'I')[0]);pop=4
  else:self.events.append([kind,'base' if obj==self.base else self.nodes.index(obj)])
  cpu.reg_write(n.UC_X86_REG_EAX,value);cpu.reg_write(n.UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(n.UC_X86_REG_ESP,sp+4+pop)
 def ref(self,p):return None if not p else self.nodes.index(p)
 def snapshot(self):
  return {'buckets':[self.ref(x) for x in self.read(self.base+0x28,'64I')],
   'nodes':[{'name':self.names[self.read(o+0x28,'I')[0]],'hash':self.read(o+0x2c,'I')[0],
    'base':self.read(o+0x30,'I')[0]==self.base,'next':self.ref(self.read(o+0x34,'I')[0]),
    'type':self.read(o+0x38,'B')[0],'expiration':self.read(o+0x3c,'i')[0],'value':self.read(o+0x40,'I')[0]} for o in self.nodes]}
 def run(self):
  self.write(self.base+0x128,'I',999);self.call(B+0x239a0,self.base,b'');assert self.read(self.base+0x128,'I')[0]==0
  self.write(self.base+0x128,'I',7)
  results=[]
  for index in range(1,len(self.names)):
   result=self.call(B+0x23c60,self.base,struct.pack('<Iiii',index,index&1,1,-1));results.append(result)
  before=self.snapshot()
  self.call(B+0x23c60,self.base,struct.pack('<Iiii',1,2,1,9))
  updated=self.snapshot()
  self.call(B+0x23a80,self.base,struct.pack('<I',self.nodes[1]));removed=self.snapshot()
  self.call(B+0x23b20,self.base,struct.pack('<I',self.nodes[1]));added=self.snapshot()
  self.call(B+0x239f0,self.base,b'');destroyed=self.snapshot()
  return {'events':self.events,'results':results,'before':before,'updated':updated,'removed':removed,'added':added,'destroyed':destroyed}
p=Probe(sys.argv[1]);print(json.dumps({'hash':HASH,**p.run()}))
