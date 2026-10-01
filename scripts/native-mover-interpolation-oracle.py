"""Original AMover.physMovingBrush (Engine 0x103de690) with explicit MoveActor
responses. Each case writes the mover fields the body reads (SDK AMover layout,
docs/doors.md): KeyNum, MoverGlideType, bInterpolating, PhysAlpha, PhysRate,
Location, KeyPos[8], KeyRot[8], BasePos, BaseRot, OldPos and OldRot. MoveActor
(level vtable +0x88) is a controlled leaf recording delta, NewRotation and its
flags; a success adds the delta to Location and stores NewRotation. Floats
are reported as float32 bit patterns (NaN payloads and signed zeros). The
InterpolateEnd ProcessEvent is a recorded leaf; `endAlpha` optionally writes
PhysAlpha there (the two-key script's PhysAlpha=0). No collision or VM claim.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ZERO=[0,0,0]
class NativeMover(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.actor=self.alloc(0x600);self.level=self.alloc(0x100);self.vtable=self.alloc(0x100);self.move=0x700fe000
  self.cpu.mem_write(self.move,bytes.fromhex('c2 30 00'));self.write(self.actor+0x24,'I',0x1058bb58);self.write(self.actor+0xac,'I',self.level);self.write(self.level,'I',self.vtable);self.write(self.vtable+0x88,'I',self.move);self.events=[]
 def on_instruction(self,c,a,z,d):
  if a==self.move:
   sp=c.reg_read(m.UC_X86_REG_ESP);actor,*delta=self.read(sp+4,'I3f');rotation=self.read(sp+20,'3i');flags=self.read(sp+36,'4I')
   if actor!=self.actor or any(flags):raise RuntimeError('Unexpected MoveActor contract')
   if len(self.events)>=200:raise RuntimeError('Unexpected move count')
   response=self.responses.pop(0) if self.responses else True
   self.events.append({'move':list(self.read(sp+8,'3I')),'rotation':rotation,'success':response})
   if response:
    self.write(actor+0x114,'3f',*[x+y for x,y in zip(self.read(actor+0x114,'3f'),delta)])
    self.write(actor+0x120,'3i',*rotation)
   c.reg_write(m.UC_X86_REG_EAX,int(response));return
  if a==0x103de9d7:
   self.events.append({'interpolateEnd':True})
   if self.endAlpha is not None:self.write(self.actor+0x214,'f',self.endAlpha)
   c.reg_write(m.UC_X86_REG_EIP,0x103de9f9);return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  a=self.actor;self.events=[];self.responses=case.get('responses',[]).copy();self.endAlpha=case.get('endAlpha',0)
  for offset,value in [(0x214,case['alpha']),(0x218,case['rate'])]:self.write(a+offset,'f',value)
  self.write(a+0x1ec,'I',128 if case.get('interpolating',True) else 0);self.write(a+0x375,'B',case.get('glideType',1));self.write(a+0x377,'B',case.get('keyNum',1))
  positions=case.get('keyPositions') or [ZERO,case['keyPosition']]+[ZERO]*6
  rotations=case.get('keyRotations') or [ZERO]*8
  for i in range(8):
   self.write(a+0x3c8+12*i,'3f',*positions[i]);self.write(a+0x428+12*i,'3i',*rotations[i])
  for offset,value in [(0x114,case['position']),(0x488,case['basePosition']),(0x494,case['oldPosition'])]:self.write(a+offset,'3f',*value)
  rotation=case.get('rotation',ZERO)
  self.write(a+0x120,'3i',*rotation)
  self.write(a+0x4b8,'3i',*case.get('baseRotation',rotation));self.write(a+0x4c4,'3i',*case.get('oldRotation',rotation))
  self.call(0x103de690,a,struct.pack('<f',case['dt']))
  return {'events':self.events,'position':self.read(a+0x114,'3I'),'rotation':self.read(a+0x120,'3i'),'alpha':self.read(a+0x214,'I')[0],'interpolating':bool(self.read(a+0x1ec,'I')[0]&128)}
if __name__=='__main__':
 n=NativeMover(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
