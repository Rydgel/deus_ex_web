"""Execute original execSetCollisionSize (native 283, Engine.dll 0x103e19f0)
through the real AActor::SetCollisionSize body (0x10369320 via thunk
0x10303d64). Argument expressions and the collision-hash AddActor/RemoveActor
vtable slots are explicit controlled callbacks; the bCollideActors gating,
raw field writes, call order and unconditional result are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeSetCollisionSize(m.NativeCollision):
 def __init__(self,root):
  self.argument=None
  super().__init__(root)
  self.source=self.alloc(0x400);self.level=self.alloc(0x100);self.hash=self.alloc(0x40);self.vtable=self.alloc(0x40)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  self.argument=0x700fc000;self.remove=0x700fc010;self.add=0x700fc020
  for a,code in [(self.argument,'c2 08 00'),(self.remove,'c2 04 00'),(self.add,'c2 04 00')]:self.cpu.mem_write(a,bytes.fromhex(code))
  natives=self.read(0x10599a38,'I')[0]
  self.write(natives+254*4,'I',self.argument)
  self.write(self.source+0xac,'I',self.level)
  self.write(self.hash,'I',self.vtable)
  self.write(self.vtable+8,'I',self.add);self.write(self.vtable+0xc,'I',self.remove)
  self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i==0:self.write(result,'f',self.case['radius'])
   elif i==1:self.write(result,'f',self.case['height'])
   return
  if a==self.remove or a==self.add:
   actor=self.read(sp+4,'I')[0]
   if c.reg_read(m.UC_X86_REG_ECX)!=self.hash:raise RuntimeError('Hash slot called on the wrong object')
   if actor!=self.source:raise RuntimeError('Hash slot called on the wrong actor')
   self.events.append({'slot':'remove'if a==self.remove else'add',
    'radius':self.read(self.source+0x1d4,'f')[0],'height':self.read(self.source+0x1d8,'f')[0]})
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.case=case;self.argindex=0;self.events=[]
  self.write(self.source+0x1dc,'B',1 if case.get('collide',True) else 0)
  self.write(self.source+0x1d4,'2f',case.get('oldRadius',4.0),case.get('oldHeight',8.0))
  self.write(self.level+0xf8,'I',self.hash if case.get('hash',True) else 0)
  self.cpu.mem_write(self.code,bytes([254,254,22]));self.write(self.frame+12,'I',self.code)
  self.call(0x103e19f0,self.source,struct.pack('<II',self.frame,self.result))
  return {'events':self.events,'radius':self.read(self.source+0x1d4,'f')[0],
   'height':self.read(self.source+0x1d8,'f')[0],'result':self.read(self.result,'I')[0]}
if __name__=='__main__':
 n=NativeSetCollisionSize(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
