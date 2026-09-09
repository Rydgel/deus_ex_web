"""Original execGetBoundingBox with controlled argument opcode boundaries."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('b',Path(__file__).with_name('native-brush-oracle.py'));b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
class Native(b.NativeBrush):
 def __init__(self,root):
  super().__init__(root);self.frame=self.alloc(64);self.code=self.alloc(32);self.output=self.alloc(32);self.model=self.alloc(512);vt=self.alloc(128);self.write(self.model,'I',vt);self.write(vt+0x5c,'I',0x103f1190);self.write(self.actor+0x178,'I',self.model);self.write(self.frame+8,'I',self.actor);self.stub=self.alloc(16);self.cpu.mem_write(self.stub,bytes.fromhex('c2 08 00'));table=self.read(0x10599a38,'I')[0];self.write(table+0x50*4,'I',self.stub)
 def on_instruction(self,cpu,address,size,data):
  if address==getattr(self,'stub',None):
   from unicorn.x86_const import UC_X86_REG_ESP
   sp=cpu.reg_read(UC_X86_REG_ESP);out=self.read(sp+8,'I')[0];i=self.index;self.index+=1
   if getattr(self,'vector',None) is not None:self.write(out,'3f',*self.vector);return
   if i<2:self.write(self.read(0x10599aa0,'I')[0],'I',self.output+i*12)
   elif i==2:self.write(out,'I',0)
   elif i==3:self.write(out,'3f',*self.case['testLocation'])
   else:self.write(out,'3i',*self.case['testRotation'])
   return
  return super().on_instruction(cpu,address,size,data)
 def vsize(self,vector):
  self.vector=vector;self.cpu.mem_write(self.code,bytes([0x50,0x16]));self.write(self.frame+12,'I',self.code);self.call(0x10138d10,self.actor,struct.pack('<II',self.frame,self.output));self.vector=None;return self.read(self.output,'f')[0]
 def capture(self,case):
  self.case=case;self.index=0;self.owner(case['owner']);self.write(self.model+0x28,'6fB',*case['bounds']['min'],*case['bounds']['max'],1);self.cpu.mem_write(self.code,bytes([0x50]*5+[0x16]));self.write(self.frame+12,'I',self.code);self.call(0x1036dea0,self.actor,struct.pack('<II',self.frame,self.output+24));return{'min':list(self.read(self.output,'3f')),'max':list(self.read(self.output+12,'3f')),'valid':bool(self.read(self.output+24,'I')[0]),'location':list(self.read(self.actor+0x114,'3f')),'rotation':list(self.read(self.actor+0x120,'3i'))}
if __name__=='__main__':
 a=Native(Path(sys.argv[1]));print(json.dumps({'hashes':b.collision.HASHES,'results':[a.capture(c)for c in json.loads(Path(sys.argv[2]).read_text())],'sizes':[a.vsize(v)for v in [[0,0,0],[2,2,0],[10,20,30],[160,22,48],[0.125,0.25,0.5]]] }))
