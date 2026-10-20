"""Original surface prelude with controlled world queries and empty WalkTexture."""
import importlib.util,json,struct,sys
from pathlib import Path
sp=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'));b=importlib.util.module_from_spec(sp);sp.loader.exec_module(b)
class NativeSurface(b.NativeCollision):
 def __init__(self,root):
  super().__init__(root,{'MSVCRT.dll':'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'})
  self.events=None;self.call(0x10102978,0x101b3218,b'')
  self.pawn=self.alloc(0x1000);self.level=self.alloc(0x1000);self.zone=self.alloc(0x1000);self.model=self.alloc(0x200);self.node=self.alloc(64);self.surface=self.alloc(64);self.texture=self.alloc(0x200)
  self.vtable=self.alloc(0x200);self.avtable=self.alloc(0x200);self.line=0x700fe010;self.event=0x700fe020
  self.cpu.mem_write(self.line,bytes.fromhex('c2 24 00'));self.cpu.mem_write(self.event,bytes.fromhex('c2 0c 00'))
  self.write(self.vtable+0xc0,'I',self.line);self.write(self.avtable+0x10,'I',self.event)
  self.write(self.pawn,'I',self.avtable);self.write(self.pawn+0x24,'I',0x1058c160);self.write(self.pawn+0xac,'I',self.level);self.write(self.level,'I',self.vtable);self.write(self.level+0x98,'I',self.model)
  self.write(self.model+0x58,'III',self.node,1,1);self.write(self.model+0x98,'III',self.surface,1,1);self.write(self.surface,'I',self.texture);self.write(self.zone+0x24,'I',0x1057bf00)
  outer=self.outer=self.alloc(0x40);names=self.alloc(16);entry=self.alloc(64);self.name_entry=entry;self.write(outer+0x20,'I',1);self.write(names+4,'I',entry);self.cpu.mem_write(entry+12,'Concrete\0'.encode('utf-16-le'))
  self.write(self.read(0x10599a70,'I')[0],'I',names);self.write(self.texture+0x18,'I',outer)
  self.write(self.texture+0x70,'f',1)
 def on_instruction(self,cpu,address,size,data):
  if self.events is not None and address==0x103cc519:
   self.events.append({'unsupported':'Ladder'});cpu.reg_write(b.UC_X86_REG_EIP,self.done);return
  if self.events is not None and address==self.line:
   st=cpu.reg_read(b.UC_X86_REG_ESP);h,actor,end,start,flags=self.read(st+4,'5I');s=list(self.read(start,'3f'));e=list(self.read(end,'3f'));self.events.append({'line':{'start':s,'end':e,'extent':list(self.read(st+24,'3f')),'flags':flags}})
   hit=self.case.get('hitAt',-1)==self.index or self.case.get('everyHit',False);self.index+=1
   self.write(h+4,'I',self.zone if hit else 0);self.write(h+8,'3f',*e);self.write(h+20,'3f',0,0,1 if hit else 0);self.write(h+36,'f',.5 if hit else 1);self.write(h+40,'i',0);cpu.reg_write(b.UC_X86_REG_EAX,1);return
  if self.events is not None and address==self.event:
   st=cpu.reg_read(b.UC_X86_REG_ESP);caller=self.read(st,'I')[0]
   if caller!=0x103cc820:raise RuntimeError(f'Unsupported event{caller:x}')
   params=self.read(st+8,'I')[0];self.events.append({'walkTexture':bool(self.read(params,'I')[0]),'location':list(self.read(params+4,'3f')),'normal':list(self.read(params+16,'3f'))});return
  super().on_instruction(cpu,address,size,data)
 def run(self,case):
  self.case=case;self.index=0;self.cpu.mem_write(self.name_entry+12,(case.get('group','Concrete')+'\0').encode('utf-16-le'));self.write(self.pawn+0x114,'3f',*case['position']);self.write(self.pawn+0x120,'3i',*case['rotation']);self.write(self.pawn+0x1d4,'2f',case['radius'],case['height']);self.write(self.pawn+0x30,'B',1)
  self.events=[];handled=self.call(0x103cc450,0,struct.pack('<Ifi',self.pawn,.016,0));r={'handled':False if self.events[-1].get('unsupported') else bool(handled&255),'events':self.events};self.events=None;return r
if __name__=='__main__':
 n=NativeSurface(Path(sys.argv[1]));print(json.dumps({'results':[n.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
