"""Original scroll exec marshalling; setters' verified workers are recorded leaves."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('text',Path(__file__).with_name('native-textwindow-probe.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
INFO={1640:(0x40f20,0x3dff0,1),1650:(0x41540,0x3e860,1),1680:(0xc6f0,0xb470,2),1681:(0xc780,0xb5e0,2)}
class Probe(p.TextWindowProbe):
 def on_param_read(self,cpu,out):
  i=self.pos;self.pos+=1;value=self.args[i]
  self.calls.append({'op':'evaluate','index':i})
  if value is not None:self.write(out,'I',value&0xffffffff)
  if self.index==1681:self.write(self.gprop_addr,'I',self.destinations[i])
  if self.mutate and i==1:self.write(self.object+0x174,'2i',31,47)
 def on_dispatch(self,cpu,address,size,data):
  if address==p.EXT+INFO[self.index][1] and self.index!=1681:
   sp=cpu.reg_read(UC_X86_REG_ESP)
   self.calls.append({'op':'worker','args':list(self.read(sp+4,str(INFO[self.index][2])+'i'))})
   self._cdecl_return(cpu,sp,4*INFO[self.index][2]);return
  super().on_dispatch(cpu,address,size,data)
 def run(self,index,args,refs=None,mutate=False):
  self.index=index;self.begin_case({});self.args=args;self.pos=0;self.calls=[];self.mutate=mutate
  self.object=self.alloc(0x300);self.cpu.mem_write(self.object,bytes(0x300));self.write(self.object+0x174,'2i',7,11)
  first=self.alloc(4);second=self.alloc(4);self.write(first,'i',101);self.write(second,'i',202)
  cells={'first':first,'second':second,'row':self.object+0x178,'none':0}
  self.destinations=[cells[k] for k in refs] if refs else []
  frame=self.alloc(0x20);self.cpu.mem_write(frame,bytes(0x20));code=self.alloc(16);self.cpu.mem_write(code,bytes(16));self.write(frame+8,'2I',self.object,code)
  result=self.alloc(4);self.write(result,'I',0xdeadbeef)
  self.call(p.EXT+INFO[index][0],self.object,struct.pack('<2I',frame,result))
  return {'index':index,'args':args,'refs':refs,'mutate':mutate,'calls':self.calls,'cursor':self.read(frame+12,'I')[0]-code,
    'result':self.read(result,'I')[0],'outputs':list(self.read(first,'i'))+list(self.read(second,'i')),'position':list(self.read(self.object+0x174,'2i'))}
probe=Probe(Path(sys.argv[1]));cases=[]
for index in [1640,1650,1680]:
 for value in [0,5,-1,2147483647,None]:cases.append(probe.run(index,[value]*INFO[index][2]))
for refs in [['first','second'],['first','first'],['row','second'],['none','second'],['first','none']]:
 cases.append(probe.run(1681,[0,0],refs,True))
print(json.dumps(cases))
