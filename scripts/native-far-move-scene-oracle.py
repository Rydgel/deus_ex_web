"""Original FarMoveActor composed with real level/hash/geometry; script/zone boundaries explicit."""
import hashlib,importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('encroach',Path(__file__).with_name('native-encroachment-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b=m.m.level.base
class NativeFarScene(m.NativeEncroachment):
 def alloc(self,size):return super().alloc(max(size,0x800) if size==0x400 else size)
 def __init__(self,root,scene):
  self.active=False
  super().__init__(root,scene)
  self.write(self.level_table+0xb0,'I',0x10398480);self.write(self.level_table+0xb8,'I',0x1039a350)
  self.event,self.find,self.zone=0x700fb100,0x700fb120,0x700fb140
  for address,code in [(self.event,'c2 0c 00'),(self.find,'c2 08 00'),(self.zone,'c2 0c 00')]:self.cpu.mem_write(address,bytes.fromhex(code))
  self.write(self.level_table+0xac,'I',self.zone);self.write(0x10599a88,'I',self.find)
  self.names={1:'EncroachingOn',2:'EncroachedBy',3:'Touch',4:'UnTouch'}
  for address,token in [(0x105836d4,1),(0x105836d0,2),(0x10583704,3),(0x10583700,4)]:self.write(address,'I',token)
  self.write(self.brush_table+0x10,'I',self.event);table=self.alloc(0x100);self.write(table+0x10,'I',self.event)
  self.write(0x1058c160+0x28,'I',0x1058c660)
  registry=self.alloc(len(self.actor_ptrs)*4);self.write(0x1029e628,'III',registry,len(self.actor_ptrs),len(self.actor_ptrs))
  for i,p in enumerate(self.actor_ptrs.values()):
   self.write(p+4,'I',i);self.write(registry+4*i,'I',p);self.write(p+0xa8,'I',self.info);self.write(p+0x30,'B',1)
   if not self.read(p,'I')[0]:self.write(p,'I',table)
  self.pawn=self.actor_ptrs['$pawn'];self.write(self.pawn+0x24,'I',0x1058c160);self.write(self.pawn+0x5d4,'I',self.pawn);self.write(self.pawn+0x318,'I',2)
 def on_instruction(self,cpu,address,size,data):
  if self.active:
   sp=cpu.reg_read(b.UC_X86_REG_ESP)
   if address==self.find:cpu.reg_write(b.UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
   if address==self.event:
    token,params,_=self.read(sp+4,'3I');who=cpu.reg_read(b.UC_X86_REG_ECX);other=self.read(params,'I')[0];name=self.names[token]
    self.log.append({'event':name,'actor':self.actor_ids[who],'other':self.actor_ids[other]})
    if name=='EncroachingOn':self.write(params+4,'I',int(self.actor_ids[other] in self.case.get('reject',[])))
    return
   if address==self.zone:self.log.append({'event':'zone','options':self.read(sp+8,'2I')});return
   if address in [0x103580b0,0x103583a0] and self.read(sp+4,'I')[0]==self.pawn:self.log.append({'event':'add' if address==0x103580b0 else 'remove','position':self.read(self.pawn+0x114,'3f')})
   if address==0x10398480:self.log.append({'event':'findSpot','position':self.read(self.read(sp+16,'I')[0],'3f'),'extent':self.read(sp+4,'3f')})
   if address==0x1039a350:self.log.append({'event':'checkEncroachment','position':self.read(sp+8,'3f'),'notify':self.read(sp+32,'I')[0]})
  return super().on_instruction(cpu,address,size,data)
 def capture(self,c):
  self.case=c;self.call(0x103583a0,self.hash,struct.pack('<I',self.pawn))
  for p in self.actor_ptrs.values():self.write(p+0xe8,'4I',0,0,0,0)
  self.write(self.pawn+0x114,'3f',*c['position']);self.write(self.pawn+0x12c,'3f',*c['position']);self.write(self.pawn+0x1ec,'I',0);self.write(self.pawn+0x1d4,'2f',20,c.get('height',43))
  self.call(0x103580b0,self.hash,struct.pack('<I',self.pawn));mark=self.read(self.memstack,'4I');self.log=[];self.active=True
  success=self.call(0x10398ba0,self.level,struct.pack('<I3fII',self.pawn,*c['destination'],c.get('test',0),c.get('noCheck',0)))
  self.active=False;self.write(self.memstack,'4I',*mark)
  touching={name:[self.actor_ids.get(p) for p in self.read(actor+0xe8,'4I')] for name,actor in self.actor_ptrs.items() if any(self.read(actor+0xe8,'4I'))}
  return {'success':bool(success),'position':self.read(self.pawn+0x114,'3f'),'oldLocation':self.read(self.pawn+0x12c,'3f'),'motionFlags':self.read(self.pawn+0x1ec,'I')[0],'events':self.log,'touching':touching}
if __name__=='__main__':
 raw=Path(sys.argv[2]).read_bytes();cases=Path(sys.argv[3]).read_bytes();n=NativeFarScene(Path(sys.argv[1]),json.loads(raw))
 print(json.dumps({'hashes':b.HASHES|{'MSVCRT.dll':m.m.level.hash_module.CRT_HASH},'sceneSha256':hashlib.sha256(raw).hexdigest(),'casesSha256':hashlib.sha256(cases).hexdigest(),'results':[n.capture(c) for c in json.loads(cases)]}))
