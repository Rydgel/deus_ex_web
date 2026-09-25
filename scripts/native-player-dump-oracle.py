"""Original CreateDumpLocationObject/UDumpLocation constructor and saved flag.
Config, file enumeration, UObject allocation and FMalloc are explicit leaves.
No file parsing or saved-location restoration is supplied by this probe.
"""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
HASH='b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
B=0x12000000
class Probe(n.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'DeusEx.dll':{'hash':HASH,'base':B},'MSVCRT.dll':'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'})
  self.fname=self.read(B+0x27138,'I')[0];self.outerfn=self.read(B+0x271a8,'I')[0];self.allocate=self.read(B+0x27040,'I')[0]
  self.player=self.alloc(0x100);self.outer=self.alloc(0x40);self.obj=self.alloc(0xa8);self.frame=self.alloc(0x40);self.result=self.alloc(4)
  self.hooks={};self.blocks={}
  for iat,slots in [(0x2713c,{0x10:'config'}),(0x27128,{0x28:'files'}),(0x27038,{0:'malloc',4:'realloc',8:'free'})]:
   obj=self.alloc(4);vt=self.alloc(0x50);self.write(obj,'I',vt);self.write(self.read(B+iat,'I')[0],'I',obj)
   for offset,kind in slots.items():
    stub=self.alloc(16);self.cpu.mem_write(stub,b'\xc3');self.write(vt+offset,'I',stub);self.hooks[stub]=kind
 def wide(self,addr):
  chars=[]
  for i in range(8192):
   x=self.read(addr+i*2,'H')[0]
   if not x:return bytes().join(struct.pack('<H',c) for c in chars).decode('utf-16le')
   chars.append(x)
  raise RuntimeError('unterminated wide string')
 def string(self,text):
  data=(text+'\0').encode('utf-16le');p=self.alloc(len(data));self.cpu.mem_write(p,data);return p
 def on_instruction(self,cpu,address,size,data):
  kind=self.hooks.get(address)
  if not kind and address not in [self.fname,self.outerfn,self.allocate]:return super().on_instruction(cpu,address,size,data)
  sp=cpu.reg_read(n.UC_X86_REG_ESP);obj=cpu.reg_read(n.UC_X86_REG_ECX);pop=0;value=0
  if address==self.fname:
   assert self.read(sp+4,'I')[0]==0;self.write(obj,'I',0);pop=4
  elif address==self.outerfn:
   assert obj==self.player;value=self.outer
  elif address==self.allocate:
   args=self.read(sp+4,'7I');assert args[:5]==(B+0x3b600,self.outer,0,0,0) and args[6]==0,args
   self.events.append(['allocate','DeusEx.DumpLocation','player.Outer']);value=0 if self.null else self.obj
  elif kind=='config':
   section,key,dst,count,file=self.read(sp+4,'5I');assert [self.wide(section),self.wide(key),count,self.wide(file)]==['DeusEx.DumpLocation','CurrentUser',64,'User.ini']
   text=(self.user or '')[:count-1];self.cpu.mem_write(dst,(text+'\0').encode('utf-16le'));value=int(self.user is not None);pop=20
   self.events.append(['config',self.user])
  elif kind=='files':
   dst,pattern,files,dirs=self.read(sp+4,'4I');assert (self.wide(pattern),files,dirs)==('*.DMP',1,0)
   arr=self.alloc(max(12,12*len(self.files)))
   for i,name in enumerate(self.files):self.write(arr+12*i,'3I',self.string(name),len(name)+1,len(name)+1)
   self.write(dst,'3I',arr,len(self.files),len(self.files));value=dst;pop=16
   self.events.append(['files',self.files])
  elif kind=='malloc':
   count=self.read(sp+4,'I')[0];value=self.alloc(count);self.blocks[value]=count;pop=8
   self.events.append(['malloc',count])
  elif kind=='realloc':
   old,count=self.read(sp+4,'2I');value=self.alloc(count) if count else 0
   if old and count:self.cpu.mem_write(value,bytes(self.cpu.mem_read(old,min(count,self.blocks.get(old,0)))))
   if value:self.blocks[value]=count
   pop=12
  elif kind=='free':pop=4
  cpu.reg_write(n.UC_X86_REG_EAX,value);cpu.reg_write(n.UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(n.UC_X86_REG_ESP,sp+4+pop)
 def case(self,user,files,null=False):
  self.user=user;self.files=files;self.null=null;self.events=[]
  self.cpu.mem_write(self.obj,b'\x55'*0xa8);self.write(self.frame+12,'I',0x22110000)
  self.call(B+0x14c30,self.player,struct.pack('<II',self.frame,self.result))
  if null:return {'null':self.read(self.result,'I')[0]==0,'events':self.events}
  userptr=self.read(self.obj+0x90,'I')[0];arr,num,_=self.read(self.obj+0x7c,'3I')
  flags=[]
  for flag in [0,1,255]:
   self.write(B+0x3bb05,'B',flag);self.call(B+0x16e40,self.obj,struct.pack('<II',self.frame,self.result));flags.append(self.read(self.result,'I')[0])
  return {'vtable':self.read(self.obj,'I')[0]-(B-0x10000000),'currentUser':self.wide(userptr) if userptr else '',
   'files':[self.wide(self.read(arr+i*12,'I')[0]) for i in range(num)],'indices':self.read(self.obj+0x88,'2i'),
   'tail':self.read(self.obj+0x9c,'3I'),'savedReads':flags,'events':self.events,
   'structWords':self.read(self.obj+0x2c,'20I')}
p=Probe(sys.argv[1]);print(json.dumps({'hash':HASH,'initialSavedFlag':p.read(B+0x3bb05,'B')[0],
 'cases':[p.case(None,[]),p.case('Alice',['training.DMP','Test Dump.dmp']),p.case('x'*80,['A.DMP']),p.case(None,[],True)]}))
