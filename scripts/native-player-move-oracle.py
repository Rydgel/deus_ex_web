"""Full original controlled-player MoveActor with real scene/query/hash.

Script dispatch, BeginTouch/EndTouch and SetActorZone are explicit controlled
boundaries. Original IsOverlapping and all MoveActor branches execute.
"""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('mover',Path(__file__).with_name('native-mover-move-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Native(m.Native):
 def alloc(self,size):return super().alloc(0x2000 if size==0x200 else 0x1000 if size==0x400 else size)
 def __init__(self,root,scene):
  self.player_active=False;self.query_return=None;self.player_events=[];self.policy_returns=[]
  super().__init__(root,scene)
  self.player=self.actor_ptrs['$player'];self.write(self.player+0x24,'I',0x1058c160);self.write(0x1058c160+0x28,'I',0x1058c660);self.write(self.player+0x5d4,'I',self.alloc(4))
 def on_instruction(self,cpu,address,size,data):
  if self.player_active:
   sp=cpu.reg_read(m.UC_X86_REG_ESP)
   if self.policy_returns and address==self.policy_returns[-1]['return']:
    pending=self.policy_returns.pop();self.player_events[pending['index']]['result']=bool(cpu.reg_read(m.UC_X86_REG_EAX))
   if address in [0x103029be,0x10301785] and not self.policy_returns:
    self.policy_returns.append({'return':self.read(sp,'I')[0],'index':len(self.player_events)});self.player_events.append({'overlap' if address==0x103029be else 'blocked':self.actor_ids.get(self.read(sp+4,'I')[0]),'position':self.read(self.player+0x114,'3f')})
   if address==self.find:cpu.reg_write(m.UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
   if self.query_return==address:
    p=cpu.reg_read(m.UC_X86_REG_EAX);self.hits=[]
    while p:self.hits.append({'actor':self.actor_ids.get(self.read(p+4,'I')[0]),'location':self.read(p+8,'3f'),'normal':self.read(p+20,'3f'),'time':self.read(p+36,'f')[0]});p=self.read(p,'I')[0]
    self.query_return=None
   if address==0x1039b220:self.query_return=self.read(sp,'I')[0]
   if address in [0x103583a0,0x103580b0]:self.player_events.append({'hash':'remove' if address==0x103583a0 else 'add','actor':self.actor_ids.get(self.read(sp+4,'I')[0]),'position':self.read(self.player+0x114,'3f')})
   if address==self.event:
    token,params,_=self.read(sp+4,'III');name=self.names.get(token,str(token));event={'event':name,'actor':self.actor_ids.get(cpu.reg_read(m.UC_X86_REG_ECX)),'position':self.read(self.player+0x114,'3f')}
    event['args']=[self.read(params,'3f'),self.read(params+12,'3f')] if name=='BumpWall' else [self.actor_ids.get(self.read(params,'I')[0])];self.player_events.append(event);return
   if address in [0x1030177b,0x10302365]:
    self.player_events.append({'touch':'begin' if address==0x1030177b else 'end','actor':self.actor_ids.get(self.read(sp+4,'I')[0]),'position':self.read(self.player+0x114,'3f')})
    if address==0x10302365 and self.read(sp+8,'I')[0]!=0:raise Exception('Unexpected EndTouch flag')
    cpu.reg_write(m.UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(m.UC_X86_REG_ESP,sp+(8 if address==0x1030177b else 12));return
   if address==self.zone:
    actor,test,force=self.read(sp+4,'III');self.player_events.append({'zone':self.actor_ids.get(actor),'test':test,'force':force,'position':self.read(self.player+0x114,'3f')});return
  return super().on_instruction(cpu,address,size,data)
 def capture_player(self,c):
  p=self.player;self.call(0x103583a0,self.hash,struct.pack('<I',p));self.write(p+0x114,'3f',*c['start']);self.write(p+0x28,'I',1 if c.get('static') else 0 if c.get('movable') is False else 0x80000);self.write(p+0xc4,'I',self.actor_ptrs.get(c.get('base'),0));self.write(p+0x1dc,'I',c.get('flags',15));self.write(p+0xe8,'4I',*[self.actor_ptrs.get(x,0)for x in c.get('touching',[None]*4)]);self.call(0x103580b0,self.hash,struct.pack('<I',p))
  self.player_events=[];self.hits=[];self.player_active=True;self.mover_trace=None;hit=self.alloc(44);self.write(hit+36,'fi',1,-1)
  result=self.call(0x103990e0,self.level,struct.pack('<I3f3iI4I',p,*c['delta'],*self.read(p+0x120,'3i'),hit,0,0,0,0));self.player_active=False
  return {'success':bool(result),'position':self.read(p+0x114,'3f'),'time':self.read(hit+36,'f')[0],'hitActor':self.actor_ids.get(self.read(hit+4,'I')[0]),'hits':self.hits,'events':self.player_events}
if __name__=='__main__':
 scene=json.loads(Path(sys.argv[2]).read_text());native=Native(Path(sys.argv[1]),scene);print(json.dumps({'hashes':m.m.base.HASHES,'results':[native.capture_player(c)for c in json.loads(Path(sys.argv[3]).read_text())]}))
