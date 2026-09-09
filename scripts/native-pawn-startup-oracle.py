"""Original LoadMap PreBeginPlay loop, explicit event body = native AddPawn.
This captures loop/list ordering, not whole startup script side effects.
"""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_EIP
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'));n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
class Native(n.NativeCollision):
 def on_instruction(self,cpu,address,size,data):
  if address==0x1038d9ce:cpu.reg_write(UC_X86_REG_EIP,self.done);return
  return super().on_instruction(cpu,address,size,data)
 def capture(self,case):
  engine=self.alloc(256);level=self.alloc(256);info=self.alloc(2048);size=max(p['actorSlot']for p in case['pawns'])+1;array=self.alloc(size*4);self.write(engine+0x68,'I',level);self.write(level+0x2c,'2I',array,size);self.write(array,'I',info);self.write(info+0x24,'I',0x1057bf00);frame=self.alloc(32);code=self.alloc(8);self.write(frame+12,'I',code)
  find=self.alloc(16);self.cpu.mem_write(find,bytes.fromhex('33 c0 c2 08 00'));self.write(0x10599a88,'I',find)
  empty=self.alloc(16);self.cpu.mem_write(empty,bytes.fromhex('c2 0c 00'));iv=self.alloc(64);self.write(iv+0x10,'I',empty);self.write(info,'I',iv)
  body=self.alloc(32);self.cpu.mem_write(body,b'\x6a\x00\x68'+struct.pack('<I',frame)+b'\xb8'+struct.pack('<I',0x103bb430)+b'\xff\xd0\xc2\x0c\x00');vt=self.alloc(64);self.write(vt+0x10,'I',body);pawns={}
  for p in case['pawns']:
   actor=self.alloc(2048);pawns[actor]=p['name'];self.write(actor,'I',vt);self.write(actor+0xac,'I',level);self.write(array+p['actorSlot']*4,'I',actor)
  start=self.alloc(16);self.cpu.mem_write(start,b'\xbb'+struct.pack('<I',engine)+b'\xb8'+struct.pack('<I',0x1038d99a)+b'\xff\xe0');self.call(start,0,b'');out=[];p=self.read(info+0x54c,'I')[0]
  while p:out.append(pawns[p]);p=self.read(p+0x498,'I')[0]
  return out
if __name__=='__main__':
 a=Native(Path(sys.argv[1]));cases=json.loads(Path(sys.argv[2]).read_text());print(json.dumps({'hashes':n.HASHES,'results':[a.capture(c)for c in cases]}))
