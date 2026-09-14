"""Execute original execMove (native 266, Engine.dll 0x103e3030) through a
controlled ULevel::MoveActor installed at the XLevel vtable +0x88. The Delta
expression evaluation is an explicit controlled callback; the receiver
Rotation read (+0x120), the 44-byte FCheckResult init (nine zeroed dwords,
Time=1.0f at +0x24, Item=-1 at +0x28), the trailing four zero arguments, the
MoveActor call shape and the dword result write are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeMoveExec(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root)
  self.source=self.alloc(0x400);self.level=self.alloc(0x100)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  # Eval thunk returns through its two pushed args (out vector, frame);
  # MoveActor is a thiscall with twelve stack dwords.
  self.argument=0x700fc000;self.moveactor=0x700fc010
  self.cpu.mem_write(self.argument,bytes.fromhex('c2 08 00'))
  self.cpu.mem_write(self.moveactor,bytes.fromhex('c2 30 00'))
  natives=self.read(0x10599a38,'I')[0];self.write(natives+254*4,'I',self.argument)
  vtable=self.alloc(0x100);self.write(vtable+0x88,'I',self.moveactor)
  self.write(self.level,'I',vtable)
  self.write(self.source+0xac,'I',self.level)
  self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   self.write(self.read(sp+8,'I')[0],'3f',*self.delta);return
  if a==self.moveactor:
   actor,=self.read(sp+4,'I')
   self.moveArgs={
    'actorIsReceiver':actor==self.source,
    'levelIsXLevel':c.reg_read(m.UC_X86_REG_ECX)==self.level,
    'delta':list(self.read(sp+8,'3f')),
    'rotation':list(self.read(sp+20,'3i')),
    'hit':list(self.read(self.read(sp+32,'I')[0],'9I f i')),
    'zeros':list(self.read(sp+36,'4I')),
   }
   c.reg_write(m.UC_X86_REG_EAX,self.moveret);return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.delta=list(case['delta']);self.moveret=case.get('return',1);self.moveArgs=None
  self.write(self.source+0x120,'3i',*case['rotation'])
  self.cpu.mem_write(self.code,bytes([254,22]));self.write(self.frame+12,'I',self.code)
  self.write(self.result,'I',0xdeadbeef)
  self.call(0x103e3030,self.source,struct.pack('<II',self.frame,self.result))
  return {'move':self.moveArgs,'result':self.read(self.result,'I')[0]}
if __name__=='__main__':
 n=NativeMoveExec(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
