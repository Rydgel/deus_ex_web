"""Original GotoLabel/ProcessState/FinishInterpolation polling with controlled bodies.
Synthetic opcode bindings isolate scheduling; they are not a full script VM.
"""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'));n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
class Native(n.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.actor=self.alloc(0x1000);self.frame=self.alloc(0x40);self.state=self.alloc(0x100);self.code=self.alloc(0x100);vt=self.alloc(0x100);self.callbacks={};self.events=[]
  self.write(self.actor,'I',vt);self.write(self.actor+0xc,'I',self.frame);self.write(self.actor+0x31,'B',4);self.write(self.frame+8,'I',self.actor);self.write(self.frame+0x18,'I',self.state);self.write(self.state+0x44,'I',self.code);self.write(self.state+0x80,'H',32)
  self.cpu.mem_write(self.code,bytes([0x50,0x51,0x16,0x52,0x53,0x54,0x51,0x16,0x55,0x53]));self.write(self.code+32,'6I',1,0,2,5,0,0)
  false=self.alloc(16);self.cpu.mem_write(false,bytes.fromhex('33 c0 c3'));self.write(vt+0x2c,'I',false)
  table=self.read(0x10599a38,'I')[0]
  for token,label in [(0x50,'DoOpen'),(0x52,'FinishedOpening'),(0x53,'Stop'),(0x54,'DoClose'),(0x55,'FinishedClosing')]:
   p=self.alloc(16);self.cpu.mem_write(p,bytes.fromhex('c2 08 00'));self.write(table+token*4,'I',p);self.callbacks[p]=label
  self.write(table+0x51*4,'I',0x103dfff0);self.write(table+302*4,'I',0x103e0100)
 def on_instruction(self,cpu,address,size,data):
  if address in self.callbacks:
   label=self.callbacks[address];self.events.append(label)
   if label in ['DoOpen','DoClose']:self.write(self.actor+0x1ec,'I',128)
   if label=='Stop':self.write(self.frame+0xc,'I',0)
   return
  return super().on_instruction(cpu,address,size,data)
 def capture(self,operations):
  self.events=[];self.write(self.frame+0xc,'I',0);self.write(self.frame+0x24,'I',0);self.write(self.actor+0x1ec,'I',0);out=[]
  for op in operations:
   if op in ['open','close']:self.call(0x1012eb10,self.actor,struct.pack('<I',1 if op=='open' else 2))
   elif op=='poisonEmpty':self.write(self.frame+0xc,'I',0);self.write(self.frame+0x24,'I',0xdeadbeef)
   elif op=='process':self.call(0x103e5b60,self.actor,struct.pack('<f',1/60))
   elif op=='physicsEnd':self.write(self.actor+0x1ec,'I',0)
   else:raise Exception(op)
   out.append({'operation':op,'events':self.events.copy(),'latent':self.read(self.frame+0x24,'I')[0],'interpolating':bool(self.read(self.actor+0x1ec,'I')[0]&128),'code':bool(self.read(self.frame+0xc,'I')[0])})
  return out
if __name__=='__main__':
 a=Native(Path(sys.argv[1]));print(json.dumps({'hashes':n.HASHES,'results':[a.capture(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
