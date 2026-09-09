"""Original CRT/Core random values and per-thread state for explicit seeds."""
import importlib.util,json,struct,sys,hashlib
from pathlib import Path
s=importlib.util.spec_from_file_location('base',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
CRT_HASH='e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'
class NativeRng(m.NativeCollision):
 def __init__(self,root):
  self.bridges={};super().__init__(root,{'MSVCRT.dll':CRT_HASH});self.tls=self.alloc(0x100);self.last_error=0
  for address,(dll,symbol)in self.thunks.items():
   if dll=='kernel32.dll' and symbol in ['GetLastError','SetLastError','TlsGetValue']:self.bridges[address]=symbol
  self.output=self.alloc(16);self.wrapper=0x700fc000
  # Call original appFrand, store ST0 as float without popping, then as double.
  self.cpu.mem_write(self.wrapper,b'\xe8'+struct.pack('<i',0x101232e0-(self.wrapper+5))+b'\xd9\x15'+struct.pack('<I',self.output)+b'\xdd\x1d'+struct.pack('<I',self.output+8)+b'\xc3')
 def on_instruction(self,cpu,address,size,data):
  if address not in self.bridges:return super().on_instruction(cpu,address,size,data)
  name=self.bridges[address];sp=cpu.reg_read(m.UC_X86_REG_ESP);result=self.tls if name=='TlsGetValue' else self.last_error
  if name=='SetLastError':self.last_error=self.read(sp+4,'I')[0];result=0
  cpu.reg_write(m.UC_X86_REG_EAX,result);cpu.reg_write(m.UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(m.UC_X86_REG_ESP,sp+4+(0 if name=='GetLastError' else 4))
 def capture(self,c):
  self.call(0x780097ef,0,struct.pack('<I',c['seed']));initial=self.read(self.tls+0x14,'I')[0];values=[]
  for op in c['ops']:
   if op=='frand':self.call(self.wrapper,0,b'');value={'retained':self.read(self.output+8,'d')[0],'float32':self.read(self.output,'f')[0]}
   else:value=self.call(0x101232d0 if op=='appRand' else 0x78008936,0,b'')
   values.append({'op':op,'value':value,'state':self.read(self.tls+0x14,'I')[0]})
  return {'initialState':initial,'values':values}
if __name__=='__main__':
 raw=Path(sys.argv[2]).read_bytes();n=NativeRng(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES|{'MSVCRT.dll':CRT_HASH},'casesSha256':hashlib.sha256(raw).hexdigest(),'results':[n.capture(c) for c in json.loads(raw)]}))
