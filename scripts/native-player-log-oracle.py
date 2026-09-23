"""CreateLogObject original exec/new/constructor, allocation/FName/Outer leaves."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn import UC_HOOK_MEM_WRITE
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
HASH='b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
B=0x12000000
class Probe(n.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'DeusEx.dll':{'hash':HASH,'base':B}})
  self.fname=self.read(B+0x27138,'I')[0];self.outerfn=self.read(B+0x271a8,'I')[0];self.allocate=self.read(B+0x27040,'I')[0]
  self.player=self.alloc(0x100);self.outer=self.alloc(0x40);self.obj=self.alloc(0x38);self.frame=self.alloc(0x40);self.result=self.alloc(4)
  errorSlot=self.alloc(4);self.write(errorSlot,'I',0x12345678);self.write(B+0x27044,'I',errorSlot)
  self.cpu.hook_add(UC_HOOK_MEM_WRITE,self.on_write)
 def on_write(self,cpu,access,addr,size,value,data):
  if addr==self.obj:self.stores.append(value)
 def on_instruction(self,cpu,address,size,data):
  if address not in [self.fname,self.outerfn,self.allocate]:return super().on_instruction(cpu,address,size,data)
  sp=cpu.reg_read(n.UC_X86_REG_ESP);obj=cpu.reg_read(n.UC_X86_REG_ECX);pop=0;value=0
  if address==self.fname:
   self.events.append(['fname',self.read(sp+4,'I')[0]]);self.write(obj,'I',0);pop=4
  elif address==self.outerfn:
   assert obj==self.player;self.events.append(['outer']);value=self.outer
  else:
   args=self.read(sp+4,'7I');assert args==(B+0x3a5d8,self.outer,0,0,0,0x12345678,0),args
   self.events.append(['allocate',0,0,None]);value=0 if self.null else self.obj
  cpu.reg_write(n.UC_X86_REG_EAX,value);cpu.reg_write(n.UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(n.UC_X86_REG_ESP,sp+4+pop)
 def case(self,null):
  self.null=null;self.events=[];self.stores=[];self.cpu.mem_write(self.obj,b'\x55'*0x38);self.stores=[]
  self.write(self.frame+12,'I',0x22110000)
  self.call(B+0x14760,self.player,struct.pack('<II',self.frame,self.result))
  return {'null':self.read(self.result,'I')[0]==0,'code':self.read(self.frame+12,'I')[0],
    'stores':[v-(B-0x10000000) if v==B+0x27ad0 else v for v in self.stores],
    'members':self.read(self.obj+0x28,'4I'),'events':self.events}
p=Probe(sys.argv[1]);print(json.dumps({'hash':HASH,'cases':[p.case(False),p.case(True)]}))
