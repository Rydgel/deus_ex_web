"""Unchanged Engine native293 and original mesh lookup; Step/Warning leaves."""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('animation',Path(__file__).with_name('native-animation-oracle.py'))
animation=importlib.util.module_from_spec(spec);spec.loader.exec_module(animation)

class Probe(animation.Probe):
 def run(self,s):
  self.names,self.name_text={'none':0},['None'];self.events=[]
  self.cpu.mem_write(self.actor,b'\0'*0x400)
  sequences=s.get('sequences',[]);data=self.alloc(max(32,len(sequences)*32))
  for i,row in enumerate(sequences):self.write(data+i*32,'2I',self.name(row['name']),self.name(row['group']))
  self.write(self.mesh+0x84,'3I',data,len(sequences),len(sequences));self.write(self.mesh+0x20,'I',self.name('FixtureMesh'))
  self.write(self.actor+0x174,'I',0 if s.get('noMesh') else self.mesh)
  self.arguments=[s['sequence']];self.name(s['sequence'])
  names=self.alloc(len(self.names)*4)
  for i,text in enumerate(self.name_text):
   entry=self.alloc(12+(len(text)+1)*2);self.cpu.mem_write(entry+12,text.encode('utf-16le')+b'\0\0');self.write(names+i*4,'I',entry)
  table=self.alloc(4);self.write(table,'I',names);self.write(0x10599a70,'I',table)
  self.cpu.mem_write(self.code,b'\x10\x16');self.write(self.frame+8,'2I',self.actor,self.code)
  result=self.alloc(4);self.write(result,'I',0xdeadbeef);before=bytes(self.cpu.mem_read(self.actor,0x400))
  self.call(0x10302ea0,self.actor,struct.pack('<2I',self.frame,result))
  return {'group':self.name_text[self.read(result,'I')[0]],'events':self.events,
   'codeAdvance':self.read(self.frame+12,'I')[0]-self.code,
   'actorUnchanged':before==bytes(self.cpu.mem_read(self.actor,0x400))}
if __name__=='__main__':
 req=json.load(sys.stdin);p=Probe(Path(req['gameRoot']));print(json.dumps({'hashes':animation.native.HASHES,'cases':[p.run(s) for s in req['samples']]}))
