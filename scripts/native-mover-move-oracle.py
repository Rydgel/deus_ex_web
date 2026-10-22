"""Research harness: execute original mover MoveActor and FarMoveActor with hash encroachment."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('level',Path(__file__).with_name('native-level-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
from unicorn.x86_const import UC_X86_REG_ESP,UC_X86_REG_ECX,UC_X86_REG_EAX,UC_X86_REG_EIP,UC_X86_REG_EBX
class Native(m.NativeLevel):
 def __init__(self,root,scene):
  self.mover_trace=None;self.run_tail=False   # run_tail: MoveActor runs on past the commit (native-rotating-brush-oracle.py)
  super().__init__(root,scene)
  self.write(0x1058bb58+0x28,'I',0x10582a28);self.write(0x10582a28+0x28,'I',0x1057cdf0)
  self.encroach_address=self.read(self.read(self.hash,'I')[0]+0x1c,'I')[0];self.calls=[]
  self.write(self.level_table+0x88,'I',0x103990e0);self.write(self.level_table+0xb8,'I',0x1039a350)
  self.event=0x700fb000;self.find=0x700fb020;self.zone=0x700fb040
  self.cpu.mem_write(self.event,bytes.fromhex('c2 0c 00'));self.cpu.mem_write(self.find,bytes.fromhex('c2 08 00'));self.cpu.mem_write(self.zone,bytes.fromhex('c2 0c 00'))
  self.write(0x10599a88,'I',self.find);self.write(self.level_table+0xac,'I',self.zone)
  self.names={}
  for i,(address,name) in enumerate([(0x105836d4,'EncroachingOn'),(0x105836d0,'EncroachedBy'),(0x105836fc,'Bump'),(0x105835b0,'BumpWall'),(0x10583714,'HitWall'),
    (0x10583704,'Touch'),(0x10583700,'UnTouch')]):
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
   if address==0x1039a350:self.mover_trace.append({'checkEncroachment':self.actor_ids.get(self.read(sp+4,'I')[0]),'position':self.read(sp+8,'3f'),
     'actors':{k:self.read(p+0x114,'3f') for k,p in self.actor_ptrs.items()}})
   if address==self.find:cpu.reg_write(UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
   if address==self.zone:self.mover_trace.append({'zoneBoundary':self.actor_ids.get(self.read(sp+4,'I')[0])});return
   if address==self.event:
    token,params,_=self.read(sp+4,'III');name=self.names.get(token,str(token));self.mover_trace.append({'event':name,'actor':self.actor_ids.get(cpu.reg_read(UC_X86_REG_ECX))})
    if name=='EncroachingOn':self.write(params+4,'I',self.encroach_reject)
    return
   if address==0x10399d17 and cpu.reg_read(UC_X86_REG_EBX)==self.moving and not self.run_tail:
    self.mover_trace.append({'boundary':'after pose/hash commit; before Bump/touch/zone'});cpu.reg_write(UC_X86_REG_EAX,1);cpu.reg_write(UC_X86_REG_EIP,self.done);return
  return super().on_instruction(cpu,address,size,data)
 def capture(self,c):
  self.calls=[];self.mover_trace=[];actor=self.actor_ptrs[c['actor']];self.moving=actor;self.encroach_reject=c.get('reject',0);hit=self.alloc(44)
  # Optional: bCollideWorld on the moving brush (+0x1dc bit 2); a based rider
  # (+0xc4 Base, mover +0xd8 StandingCount); an explicit NewRotation.
  if c.get('collideWorld'):self.write(actor+0x1dc,'I',self.read(actor+0x1dc,'I')[0]|2)
  if c.get('rider'):self.write(self.actor_ptrs[c['rider']]+0xc4,'I',actor);self.write(actor+0xd8,'B',1)
  # FarMoveActor (0x10398ba0, DeusExMover.BlowItUp's SetLocation): the same
  # scene through its CheckEncroachment with notify 1, run to the end. Optional
  # pre-existing touches fill the mover's and the other's +0xe8 slots.
  if 'destination' in c:
   for index,other in enumerate(c.get('touching',[])):
    q=self.actor_ptrs[other];self.write(actor+0xe8+4*index,'I',q);self.write(q+0xe8,'I',actor)
   result=self.call(0x10398ba0,self.level,struct.pack('<I3fII',actor,*c['destination'],c.get('test',0),c.get('noCheck',0)))
   slots=lambda p:[self.actor_ids.get(x) for x in self.read(p+0xe8,'4I')]
   return {'result':result,'position':self.read(actor+0x114,'3f'),'oldLocation':self.read(actor+0x12c,'3f'),'motion':self.read(actor+0x1ec,'I')[0],
           'trace':self.mover_trace,'touching':{k:slots(p) for k,p in self.actor_ptrs.items()},
           'actors':{k:self.read(p+0x114,'3f') for k,p in self.actor_ptrs.items()}}
  rotation=c.get('rotation') or list(self.read(actor+0x120,'3i'))
  result=self.call(0x103990e0,self.level,struct.pack('<I3f3iI4I',actor,*c['delta'],*rotation,hit,0,0,0,0))
  return {'result':result,'position':self.read(actor+0x114,'3f'),'rotation':list(self.read(actor+0x120,'3i')),'trace':self.mover_trace,
          'actors':{k:self.read(p+0x114,'3f') for k,p in self.actor_ptrs.items()},'rotations':{k:list(self.read(p+0x120,'3i')) for k,p in self.actor_ptrs.items()}}
if __name__=='__main__':
 scene=json.loads(Path(sys.argv[2]).read_text());results=[]
 for case in json.loads(Path(sys.argv[3]).read_text()):
  n=Native(Path(sys.argv[1]),scene)
  positions=dict(case.get('positions',{}))
  if 'pawnPosition' in case:positions['$pawn']=case['pawnPosition']
  for name,position in positions.items():
   p=n.actor_ptrs[name];n.call(0x103583a0,n.hash,struct.pack('<I',p));n.write(p+0x114,'3f',*position);n.call(0x103580b0,n.hash,struct.pack('<I',p))
  results.append(n.capture(case))
 print(json.dumps({'results':results,'hashes':m.base.HASHES}))
