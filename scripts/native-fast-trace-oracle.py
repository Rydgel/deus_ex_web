"""Execute original execFastTrace (native 548, Engine.dll 0x103e35e0).
Argument expressions and the Level->Model->FastLineCheck call are explicit
controlled callbacks; argument evaluation order, the pre-stored Location
default and the byte-masked result publish are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeFastTrace(m.NativeCollision):
 def __init__(self,root):
  self.argument=self.line=None
  super().__init__(root)
  self.source=self.alloc(0x400);self.level=self.alloc(0x100);self.model=self.alloc(0x100)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  self.argument=0x700fc000;self.line=0x10301a37
  self.cpu.mem_write(self.argument,bytes.fromhex('c2 08 00'))
  natives=self.read(0x10599a38,'I')[0]
  self.write(natives+254*4,'I',self.argument)
  self.write(self.source+0xac,'I',self.level);self.write(self.level+0x98,'I',self.model)
  self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i==0:self.write(result,'3f',*self.case['end'])
   elif i==1 and 'start' in self.case:self.write(result,'3f',*self.case['start'])
   return
  if a==self.line:
   # Entry of the FastLineCheck thunk: [esp]=ret, [esp+4]=End, [esp+0x10]=Start,
   # ecx=Model. The real callee ends ret 0x18; emulate that return here.
   if c.reg_read(m.UC_X86_REG_ECX)!=self.model:raise RuntimeError('FastLineCheck called on the wrong model object')
   self.query={'end':self.read(sp+4,'3f'),'start':self.read(sp+16,'3f')}
   c.reg_write(m.UC_X86_REG_EIP,self.read(sp,'I')[0]);c.reg_write(m.UC_X86_REG_ESP,sp+28)
   c.reg_write(m.UC_X86_REG_EAX,self.case['clear'])
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.case=case;self.argindex=0;self.query=None
  self.write(self.source+0x114,'3f',*case.get('position',[10,20,30]))
  self.cpu.mem_write(self.code,bytes([254]*2+[22]));self.write(self.frame+12,'I',self.code)
  self.call(0x103e35e0,self.source,struct.pack('<II',self.frame,self.result))
  return {'query':self.query,'result':self.read(self.result,'I')[0]}
if __name__=='__main__':
 n=NativeFastTrace(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
