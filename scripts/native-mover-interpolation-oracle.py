"""Original translating AMover.physMovingBrush with explicit MoveActor responses.
InterpolateEnd is a source-derived two-key callback; no collision or VM claim.
"""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_EBP
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeMover(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.actor=self.alloc(0x600);self.level=self.alloc(0x100);self.vtable=self.alloc(0x100);self.move=0x700fe000
  self.cpu.mem_write(self.move,bytes.fromhex('c2 30 00'));self.write(self.actor+0x24,'I',0x1058bb58);self.write(self.actor+0xac,'I',self.level);self.write(self.level,'I',self.vtable);self.write(self.vtable+0x88,'I',self.move);self.events=[]
 def on_instruction(self,c,a,z,d):
  if a==self.move:
   sp=c.reg_read(m.UC_X86_REG_ESP);actor,*delta=self.read(sp+4,'I3f');rotation=self.read(sp+20,'3i');flags=self.read(sp+36,'4I')
   if actor!=self.actor or any(flags):raise RuntimeError('Unexpected MoveActor contract')
   if len(self.events)>=20:raise RuntimeError('Unexpected move count')
   response=self.responses.pop(0) if self.responses else True
   self.events.append({'move':delta,'rotation':rotation,'success':response})
   if response:self.write(actor+0x114,'3f',*[x+y for x,y in zip(self.read(actor+0x114,'3f'),delta)])
   c.reg_write(m.UC_X86_REG_EAX,int(response));return
  if a==0x103de9d7:
   self.events.append({'interpolateEnd':True});self.write(self.actor+0x214,'f',0)
   c.reg_write(m.UC_X86_REG_EIP,0x103de9f9);return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  a=self.actor;self.events=[];self.responses=case.get('responses',[]).copy()
  for offset,value in [(0x214,case['alpha']),(0x218,case['rate'])]:self.write(a+offset,'f',value)
  self.write(a+0x1ec,'I',128 if case.get('interpolating',True) else 0);self.write(a+0x375,'B',case.get('glideType',1));self.write(a+0x377,'B',1)
  for offset,value in [(0x114,case['position']),(0x488,case['basePosition']),(0x3d4,case['keyPosition']),(0x494,case['oldPosition'])]:self.write(a+offset,'3f',*value)
  self.write(a+0x4b8,'3i',*case.get('rotation',[0,0,0]));self.write(a+0x4c4,'3i',*case.get('rotation',[0,0,0]))
  self.call(0x103de690,a,struct.pack('<f',case['dt']))
  return {'events':self.events,'position':self.read(a+0x114,'3f'),'alpha':self.read(a+0x214,'f')[0],'interpolating':bool(self.read(a+0x1ec,'I')[0]&128)}
if __name__=='__main__':
 n=NativeMover(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
