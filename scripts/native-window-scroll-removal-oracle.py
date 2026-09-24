"""Original ScaleManager ChildRemoved; script execution is an explicit service."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('probe',Path(__file__).with_name('native-textwindow-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class Probe(p.TextWindowProbe):
 def on_dispatch(self,cpu,address,size,data):
  if address==p.EXT+0x4ded0:
   sp=cpu.reg_read(UC_X86_REG_ESP);obj=cpu.reg_read(UC_X86_REG_ECX)
   event,params,third=self.read(sp+4,'3I')
   self.calls.append({'object':obj,'event':event,'child':self.read(params,'I')[0],'third':third})
   for off,value in self.mutations.items():self.write(obj+off,'I',value)
   if self.rewrite:self.write(params,'I',self.other)
   cpu.reg_write(UC_X86_REG_ESP,sp+16)
   from unicorn.x86_const import UC_X86_REG_EIP
   cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0]);return
  super().on_dispatch(cpu,address,size,data)
 def run(self,name,slots,mutations=None,rewrite=False,null=False):
  self.begin_case({});self.calls=[];self.rewrite=rewrite
  obj=self.alloc(0x300);child=self.alloc(0x300);self.other=self.alloc(0x300)
  objects=[obj,child,self.other]
  for o in objects:self.cpu.mem_write(o,bytes((i*37+19)&255 for i in range(0x300)))
  named={'child':child,'other':self.other,'null':0}
  for off,value in zip([0x14c,0x150,0x158,0x154],slots):self.write(obj+off,'I',named[value])
  self.mutations={off:named[value] for off,value in (mutations or {}).items()}
  before={str(o):bytes(self.cpu.mem_read(o,0x300)).hex() for o in objects}
  arg=0 if null else child
  self.call(p.EXT+0x42480,obj,struct.pack('<I',arg))
  return {'name':name,'object':obj,'child':arg,'mutations':self.mutations,'before':before,
   'after':{str(o):bytes(self.cpu.mem_read(o,0x300)).hex() for o in objects},'calls':self.calls,
   'event':self.read(p.EXT+0x9b3b0,'I')[0]}
probe=Probe(Path(sys.argv[1]));cases=[]
for i in range(4):
 slots=['other']*4;slots[i]='child';cases.append(probe.run('slot-'+str(i),slots))
cases.append(probe.run('unrelated',['other']*4))
cases.append(probe.run('aliased',['child']*4))
cases.append(probe.run('null',['null']*4,null=True))
cases.append(probe.run('script-removes-match',['child','other','other','other'],{0x14c:'other',0x154:'child'}))
cases.append(probe.run('script-adds-earlier-match',['other','other','child','other'],{0x14c:'child'}))
cases.append(probe.run('script-rewrites-argument',['child','other','other','other'],rewrite=True))
print(json.dumps(cases))
