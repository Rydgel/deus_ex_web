"""Research harness: execute original mover MoveActor and hash encroachment."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('level',Path(__file__).with_name('native-level-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
from unicorn.x86_const import UC_X86_REG_ESP,UC_X86_REG_ECX,UC_X86_REG_EAX,UC_X86_REG_EIP,UC_X86_REG_EBX
class Native(m.NativeLevel):
 def __init__(self,root,scene):
  self.mover_trace=None
  super().__init__(root,scene)
  self.write(0x1058bb58+0x28,'I',0x10582a28);self.write(0x10582a28+0x28,'I',0x1057cdf0)
  self.encroach_address=self.read(self.read(self.hash,'I')[0]+0x1c,'I')[0];self.calls=[]
  self.write(self.level_table+0x88,'I',0x103990e0);self.write(self.level_table+0xb8,'I',0x1039a350)
  self.event=0x700fb000;self.find=0x700fb020;self.zone=0x700fb040
  self.cpu.mem_write(self.event,bytes.fromhex('c2 0c 00'));self.cpu.mem_write(self.find,bytes.fromhex('c2 08 00'));self.cpu.mem_write(self.zone,bytes.fromhex('c2 0c 00'))
  self.write(0x10599a88,'I',self.find);self.write(self.level_table+0xac,'I',self.zone)
  self.names={}
  for i,(address,name) in enumerate([(0x105836d4,'EncroachingOn'),(0x105836d0,'EncroachedBy'),(0x105836fc,'Bump'),(0x105835b0,'BumpWall'),(0x10583714,'HitWall')]):
   self.write(address,'I',i+1);self.names[i+1]=name
  for actor in self.actor_ptrs.values():
   table=self.read(actor,'I')[0]
   if not table:table=self.alloc(0x100);self.write(actor,'I',table)
   self.write(table+0x10,'I',self.event)
   self.write(actor+0xa8,'I',self.info);self.write(actor+0x28,'I',0x80000)
 def on_instruction(self,cpu,address,size,data):
  if self.mover_trace is not None:
   sp=cpu.reg_read(UC_X86_REG_ESP)
   if self.calls and address==self.calls[-1]['return']:
    call=self.calls.pop();event=self.mover_trace[call['index']]
    if call['kind']=='query':
     p=cpu.reg_read(UC_X86_REG_EAX);hits=[]
     while p:hits.append(self.actor_ids.get(self.read(p+4,'I')[0]));p=self.read(p,'I')[0]
     event['hits']=hits
    else:event['positionAfter']=self.read(call['actor']+0x114,'3f')
   if address in [self.encroach_address,0x103c9020]:
    query=address==self.encroach_address;actor=self.read(sp+8,'I')[0] if query else cpu.reg_read(UC_X86_REG_ECX)
    event={'query' if query else 'smooth':self.actor_ids.get(actor),'vector':self.read(sp+(12 if query else 4),'3f'),'moverPosition':self.read(self.moving+0x114,'3f')}
    self.calls.append({'return':self.read(sp,'I')[0],'index':len(self.mover_trace),'kind':'query' if query else 'smooth','actor':actor});self.mover_trace.append(event)
   if address in [0x103583a0,0x103580b0]:self.mover_trace.append({'hash':'remove' if address==0x103583a0 else 'add','actor':self.actor_ids.get(self.read(sp+4,'I')[0])})
   if address==0x1039a350:self.mover_trace.append({'checkEncroachment':self.actor_ids.get(self.read(sp+4,'I')[0]),'position':self.read(sp+8,'3f')})
   if address==self.find:cpu.reg_write(UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
   if address==self.zone:self.mover_trace.append({'zoneBoundary':self.actor_ids.get(self.read(sp+4,'I')[0])});return
   if address==self.event:
    token,params,_=self.read(sp+4,'III');name=self.names.get(token,str(token));self.mover_trace.append({'event':name,'actor':self.actor_ids.get(cpu.reg_read(UC_X86_REG_ECX))})
    if name=='EncroachingOn':self.write(params+4,'I',self.encroach_reject)
    return
   if address==0x10399d17 and cpu.reg_read(UC_X86_REG_EBX)==self.moving:
    self.mover_trace.append({'boundary':'after pose/hash commit; before Bump/touch/zone'});cpu.reg_write(UC_X86_REG_EAX,1);cpu.reg_write(UC_X86_REG_EIP,self.done);return
  return super().on_instruction(cpu,address,size,data)
 def capture(self,c):
  self.calls=[];self.mover_trace=[];actor=self.actor_ptrs[c['actor']];self.moving=actor;self.encroach_reject=c.get('reject',0);hit=self.alloc(44)
  result=self.call(0x103990e0,self.level,struct.pack('<I3f3iI4I',actor,*c['delta'],*self.read(actor+0x120,'3i'),hit,0,0,0,0))
  return {'result':result,'position':self.read(actor+0x114,'3f'),'trace':self.mover_trace,'actors':{k:self.read(p+0x114,'3f') for k,p in self.actor_ptrs.items()}}
if __name__=='__main__':
 scene=json.loads(Path(sys.argv[2]).read_text());results=[]
 for case in json.loads(Path(sys.argv[3]).read_text()):
  n=Native(Path(sys.argv[1]),scene)
  if 'pawnPosition' in case:
   p=n.actor_ptrs['$pawn'];n.call(0x103583a0,n.hash,struct.pack('<I',p));n.write(p+0x114,'3f',*case['pawnPosition']);n.call(0x103580b0,n.hash,struct.pack('<I',p))
  results.append(n.capture(case))
 print(json.dumps({'results':results,'hashes':m.base.HASHES}))
