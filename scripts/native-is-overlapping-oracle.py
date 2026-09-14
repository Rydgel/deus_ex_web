"""Execute original execIsOverlapping (native 718, Engine.dll 0x1036ddb0)
through the real AActor::IsOverlapping body (0x10369430 via thunk
0x103029be). The checkActor argument is a controlled callback; the Brush
primitive/class exclusions, the world-actor exclusion and the strict x87
cylinder comparisons are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CLASSES={'Actor':0x1057cdf0,'Pawn':0x1058c660,'Mover':0x1058bb58,'Brush':0x10582a28}
class NativeIsOverlapping(m.NativeCollision):
 def __init__(self,root):
  self.argument=None
  super().__init__(root)
  self.source=self.alloc(0x400);self.other=self.alloc(0x400);self.info=self.alloc(0x200)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  self.argument=0x700fc000
  self.cpu.mem_write(self.argument,bytes.fromhex('c2 08 00'))
  natives=self.read(0x10599a38,'I')[0]
  self.write(natives+254*4,'I',self.argument)
  self.write(self.source+0xa8,'I',self.info)
  # Original Brush ancestry: Mover->Brush->Actor->0, Pawn->Actor.
  self.write(CLASSES['Mover']+0x28,'I',CLASSES['Brush']);self.write(CLASSES['Brush']+0x28,'I',CLASSES['Actor'])
  self.write(CLASSES['Actor']+0x28,'I',0);self.write(CLASSES['Pawn']+0x28,'I',CLASSES['Actor'])
  self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0]
   other=0 if self.case.get('null') else self.info if self.case.get('otherIsWorld') else self.other
   self.write(result,'I',other)
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.case=case;self.argindex=0
  for actor,spec in ((self.source,case.get('source',{})),(self.other,case.get('other',{}))):
   self.write(actor+0x114,'3f',*spec.get('position',[0,0,0]))
   self.write(actor+0x1d4,'2f',spec.get('radius',22.0),spec.get('height',44.0))
   self.write(actor+0x178,'I',self.alloc(16) if spec.get('primitive') else 0)
   self.write(actor+0x24,'I',CLASSES[spec.get('kind','Actor')])
  self.cpu.mem_write(self.code,bytes([254,22]));self.write(self.frame+12,'I',self.code)
  self.call(0x1036ddb0,self.source,struct.pack('<II',self.frame,self.result))
  return {'result':self.read(self.result,'I')[0]}
if __name__=='__main__':
 n=NativeIsOverlapping(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
