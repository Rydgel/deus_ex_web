"""Original scroll cleanup/destructors with original Core array/string helpers."""
import importlib.util,json,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('text',Path(__file__).with_name('native-textwindow-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class Probe(p.TextWindowProbe):
 def on_dispatch(self,cpu,address,size,data):
  if address in self.leaves:
   self.calls.append({'op':self.leaves[address],'object':cpu.reg_read(UC_X86_REG_ECX),'vtable':self.read(cpu.reg_read(UC_X86_REG_ECX),'I')[0]})
   self._cdecl_return(cpu,cpu.reg_read(UC_X86_REG_ESP));return
  super().on_dispatch(cpu,address,size,data)
 def run(self,family,mode,labels):
  self.begin_case({});self.calls=[]
  self.leaves={p.EXT+0x4bec0:'Window.CleanUp',p.EXT+0x44ea0:'TabGroup.CleanUp',self.read(p.EXT+0x59078,'I')[0]:'ConditionalDestroy',self.read(p.EXT+0x59074,'I')[0]:'ObjectDestructor'}
  obj=self.alloc(0x300);self.cpu.mem_write(obj,bytes(0x300));data=self.alloc(12*len(labels)) if labels else 0
  for i,label in enumerate(labels):self.write(data+12*i,'3I',*self.fstring(label))
  if family=='scale':
   self.write(obj+0x268,'3I',data,len(labels),len(labels));self.write(obj+0x1dc,'3I',*self.fstring('%1.2f'))
  before=bytes(self.cpu.mem_read(obj,0x300));array_before=bytes(self.cpu.mem_read(data,12*len(labels))) if data else b''
  self.events=[]
  entry={'scale':(0x3d4f0,0x16c90),'manager':(0x41ac0,0x18240),'area':(0x430f0,0x18650),'clip':(0xb400,0xccf0)}[family][mode=='destructor']
  self.call(p.EXT+entry,obj,b'')
  return {'family':family,'mode':mode,'object':obj,'data':data,'count':len(labels),'before':before.hex(),'after':bytes(self.cpu.mem_read(obj,0x300)).hex(),
   'arrayBefore':array_before.hex(),'arrayAfter':bytes(self.cpu.mem_read(data,12*len(labels))).hex() if data else '', 'calls':self.calls,'events':self.events}
probe=Probe(Path(sys.argv[1]));cases=[]
for family in ['scale','manager','area','clip']:
 for mode in ['cleanup','destructor']:
  cases.append(probe.run(family,mode,[]))
for mode in ['cleanup','destructor']:cases.append(probe.run('scale',mode,['first','','last']))
print(json.dumps(cases))
