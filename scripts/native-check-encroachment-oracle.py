"""Original player CheckEncroachment and Touch internals, controlled hash/events."""
import hashlib,importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ESP,UC_X86_REG_ECX,UC_X86_REG_EAX
s=importlib.util.spec_from_file_location('base',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class NativeCheck(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.active=False
  self.level,self.vtable,self.hash,self.htable,self.info=[self.alloc(0x200) for _ in range(5)]
  self.event,self.find,self.query=0x700fb100,0x700fb120,0x700fb140
  for address,code in [(self.event,'c2 0c 00'),(self.find,'c2 08 00'),(self.query,'c2 24 00')]:self.cpu.mem_write(address,bytes.fromhex(code))
  self.write(self.level,'I',self.vtable);self.write(self.level+0xf8,'I',self.hash);self.write(self.hash,'I',self.htable);self.write(self.htable+0x1c,'I',self.query)
  table=self.alloc(4);self.write(table,'I',self.info);self.write(self.level+0x2c,'III',table,1,1);self.write(self.info+0x24,'I',0x1057bf00)
  for child,parent in [(0x1058c160,0x1058c660),(0x1058c660,0x1057cdf0),(0x10582a28,0x1057cdf0),(0x10578850,0x1057cdf0)]:self.write(child+0x28,'I',parent)
  self.write(0x10599a88,'I',self.find)
  self.names={1:'EncroachingOn',2:'EncroachedBy',3:'Touch',4:'UnTouch'}
  for address,token in [(0x105836d4,1),(0x105836d0,2),(0x10583704,3),(0x10583700,4)]:self.write(address,'I',token)
  self.actor_table=self.alloc(0x100);self.write(self.actor_table+0x10,'I',self.event)
  self.memory=self.read(0x10599bd8,'I')[0];arena=self.alloc(0x20000);self.write(self.memory,'4I',arena,arena+0x20000,0,0)
 def on_instruction(self,cpu,address,size,data):
  if self.active:
   sp=cpu.reg_read(UC_X86_REG_ESP)
   if address==self.find:cpu.reg_write(UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
   if address==self.query:
    self.events.append({'query':{'actor':self.ids[self.read(sp+8,'I')[0]],'position':self.read(sp+12,'3f'),'rotation':self.read(sp+24,'3i'),'extra':self.read(sp+36,'I')[0]}});cpu.reg_write(UC_X86_REG_EAX,self.head);return
   if address==self.event:
    token,params,_=self.read(sp+4,'3I');actor=cpu.reg_read(UC_X86_REG_ECX);other=self.read(params,'I')[0];name=self.names[token]
    self.events.append({'event':name,'actor':self.ids[actor],'other':self.ids[other],'touching':self.touching(actor)})
    if name=='EncroachingOn':
     self.write(params+4,'I',int(self.ids[other] in self.case.get('reject',[])))
     for key,flags in self.case.get('changeFlags',{}).items():self.write(self.ptrs[key]+0x1dc,'I',flags)
    if name=='Touch' and self.case.get('cancelTouch')==self.ids[actor]:
     for i,p in enumerate(self.read(actor+0xe8,'4I')):
      if p==other:self.write(actor+0xe8+i*4,'I',0)
    return
  return super().on_instruction(cpu,address,size,data)
 def touching(self,actor):return [self.ids.get(p) for p in self.read(actor+0xe8,'4I')]
 def capture(self,c):
  self.case=c;self.ptrs={a['id']:self.alloc(0x800) for a in c['actors']};self.ids={p:k for k,p in self.ptrs.items()}|{self.info:'$world'};self.events=[]
  registry=self.alloc(4*len(c['actors']));self.write(0x1029e628,'III',registry,len(c['actors']),len(c['actors']))
  for index,a in enumerate(c['actors']):
   p=self.ptrs[a['id']];self.write(registry+4*index,'I',p);self.write(p+4,'I',index);kind=a.get('kind','Actor');cls={'Player':0x1058c160,'Pawn':0x1058c660,'Brush':0x10582a28,'Projectile':0x10578850}.get(kind,0x1057cdf0)
   self.write(p,'I',self.actor_table);self.write(p+0x24,'I',cls);self.write(p+0xa8,'I',self.info);self.write(p+0xac,'I',self.level);self.write(p+0x1dc,'I',a.get('flags',15));self.write(p+0x28,'I',a.get('actorFlags',0));self.write(p+0x30,'B',a.get('physics',1));self.write(p+0x114,'3f',*a.get('position',[0,0,0]));self.write(p+0x1d4,'2f',a.get('radius',20),a.get('height',43));
   if kind=='Player':self.write(p+0x5d4,'I',p);self.write(p+0x318,'I',2)
   if kind=='Brush':self.write(p+0x178,'I',1)
   touch=a.get('touching',[]);self.write(p+0xe8,'4I',*[self.ptrs.get(x,0) for x in touch+[None]*(4-len(touch))])
  self.head=0
  for name in reversed(c.get('hits',[])):
   hit=self.alloc(44);self.write(hit,'II',self.head,self.ptrs.get(name,self.info));self.head=hit
  actor=self.ptrs[c.get('source','s')];self.active=True
  if c.get('op')=='begin':result=self.call(0x10369570,actor,struct.pack('<I',self.ptrs[c['other']]))
  elif c.get('op')=='end':result=self.call(0x10369970,actor,struct.pack('<II',self.ptrs[c['other']],c.get('noNotifySelf',0)))
  elif c.get('op')=='overlap':result=self.call(0x10369430,actor,struct.pack('<I',self.ptrs[c['other']]))
  else:result=self.call(0x1039a350,self.level,struct.pack('<I3f3iI',actor,*c.get('position',[100,0,0]),0,0,0,c.get('notify',1)))
  self.active=False
  return {'result':bool(result) if c.get('op') not in ['begin','end'] else None,'events':self.events,'touching':{k:self.touching(p) for k,p in self.ptrs.items()}}
if __name__=='__main__':
 n=NativeCheck(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'casesSha256':hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest(),'results':[n.capture(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
