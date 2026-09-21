"""Original Engine.TweenBlendAnim; reuse animation probe's explicit ABI leaves."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('animation',Path(__file__).with_name('native-animation-oracle.py'))
animation=importlib.util.module_from_spec(spec);spec.loader.exec_module(animation)
animation.BODIES['TweenBlendAnim']=(0x103e1300,3)
class Probe(animation.Probe):
 def on_instruction(self,cpu,address,size,data):
  if self.stub_names.get(address)=='Step':
   frame,dst=self.read(cpu.reg_read(UC_X86_REG_ESP)+4,'2I')
   index=self.read(frame+12,'I')[0]-self.code-1
   if index==2:
    if len(self.arguments)>2:self.write(dst,'i',self.arguments[2])
    return
  super().on_instruction(cpu,address,size,data)
 def run(self,sample):
  super().run(sample)
  return [{'sequence':self.name_text[self.read(self.actor+0x68+4*i,'I')[0]],
   **{key:self.read(self.actor+off+4*i,'f')[0] for key,off in
    {'AnimFrame':0x78,'AnimRate':0x88,'TweenRate':0x98,'AnimLast':0x23c,'AnimMinRate':0x24c,'OldAnimRate':0x25c}.items()},
   'simAnim':dict(zip(['frame','rate','tween','last'],self.read(self.actor+0x26c+16*i,'4f')))} for i in range(4)]
if __name__=='__main__':
 request=json.load(sys.stdin);p=Probe(Path(request['gameRoot']))
 print(json.dumps([p.run(s) for s in request['samples']]))
