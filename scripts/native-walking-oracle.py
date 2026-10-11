"""Original dry APawn.physWalking, controlled world/event callbacks."""
import importlib.util,json,struct,sys
from pathlib import Path
sp=importlib.util.spec_from_file_location('fall',Path(__file__).with_name('native-falling-oracle.py'));b=importlib.util.module_from_spec(sp);sp.loader.exec_module(b)
c=b.collision
class NativeWalking(b.NativeFalling):
 def __init__(self,root):
  super().__init__(root);self.script_class=self.alloc(0x40);self.write(self.script_class+0x28,'I',0x1058c660)  # a script pawn: Pawn ancestry, never APlayerPawn (calcVelocity's class tests)
  self.far_thunk=0x700fe030;self.cpu.mem_write(self.far_thunk,bytes.fromhex('c2 18 00'));self.write(self.vtable+0x8c,'I',self.far_thunk)
 def on_instruction(self,cpu,address,size,data):
  if self.events is not None:
   st=cpu.reg_read(c.UC_X86_REG_ESP)
   def ret(bytes):
    cpu.reg_write(c.UC_X86_REG_EIP,self.read(st,'I')[0]);cpu.reg_write(c.UC_X86_REG_ESP,st+4+bytes)
   if address==self.far_thunk:
    pos=list(self.read(st+8,'3f'));self.write(self.pawn+0x114,'3f',*pos);self.events.append({'farMove':pos});cpu.reg_write(c.UC_X86_REG_EAX,1);return
   if address==0x103cecc0:
    self.events.append({'wall':list(self.read(st+4,'3f'))})
    if 'wallPhysics' in self.case:self.write(self.pawn+0x30,'B',self.case['wallPhysics'])
    ret(16);return
   if address==0x103cc450:
    self.events.append({'prelude':self.read(st+8,'f')[0],'iterations':self.read(st+12,'i')[0]});cpu.reg_write(c.UC_X86_REG_EAX,0);ret(0);return
   if address==0x103d3040:
    self.events.append({'flying':self.read(st+4,'f')[0],'iterations':self.read(st+8,'i')[0]});ret(8);return
   if address in [0x103c9390,0x103c95f0,0x103d0a50]:
    if address==0x103c9390:
     base=self.read(st+4,'I')[0];self.write(self.pawn+0xc4,'I',base);self.events.append({'base':bool(base)});ret(4)
    elif address==0x103c95f0:
     ph=self.read(st+4,'I')[0];self.write(self.pawn+0x30,'B',ph);self.events.append({'physics':ph});ret(8)
    else:self.events.append({'falling':self.read(st+4,'f')[0],'iterations':self.read(st+8,'i')[0]});ret(8)
    return
   if address==self.event_thunk:
    caller=self.read(st,'I')[0]
    names={0x103cba19:'MayFall',0x103cc820:'WalkTexture',0x103cc57c:'WalkTexture',0x103cbbca:'Falling',0x103cb30a:'Falling'}
    if caller not in names:raise RuntimeError(f'Unsupported event {caller:x}')
    self.events.append({'event':names[caller]})
    if names[caller]=='Falling' and 'fallingPhysics' in self.case:self.write(self.pawn+0x30,'B',self.case['fallingPhysics'])
    if names[caller]=='MayFall' and self.case.get('denyFall'):self.write(self.pawn+0x318,'I',self.read(self.pawn+0x318,'I')[0]&~0x1000)
    return
   if address in [self.line_thunk,self.move_thunk]:
    ismove=address==self.move_thunk
    queue=self.case['moves' if ismove else 'lines'];idx=self.mi if ismove else self.li
    if idx>=len(queue):raise RuntimeError(f'Exhausted {"moves" if ismove else "lines"} at {self.read(st,"I")[0]:x}; events={self.events}')
    r=queue[idx]
    if ismove:
     self.mi+=1;actor,*delta=self.read(st+4,'I3f');h=self.read(st+32,'I')[0]
     self.events.append({'move':delta,'velocity':list(self.read(self.pawn+0x144,'3f'))})
     loc=self.read(self.pawn+0x114,'3f');self.write(self.pawn+0x114,'3f',*[a+b.f(v*r['time']) for a,v in zip(loc,delta)])
     pos=self.read(self.pawn+0x114,'3f')
     if r.get('justTeleported'):self.write(self.pawn+0x1ec,'I',0x100)
     if 'physics' in r:self.write(self.pawn+0x30,'B',r['physics'])
    else:
     self.li+=1;h,actor,end,start,flags=self.read(st+4,'5I');pos=self.read(end,'3f')
     self.events.append({'line':{'start':list(self.read(start,'3f')),'end':list(pos),'extent':list(self.read(st+24,'3f')),'flags':flags}})
    self.write(h+8,'3f',*pos);self.write(h+4,'I',self.zone if r['time']<1 else 0);self.write(h+20,'3f',*r['normal']);self.write(h+36,'f',r['time']);cpu.reg_write(c.UC_X86_REG_EAX,1);return
  super().on_instruction(cpu,address,size,data)
 def walking(self,case):
  self.case=case;self.mi=self.li=0
  self.write(self.pawn+0x30,'B',1);self.write(self.pawn+0x1ec,'I',0)
  self.write(self.pawn+0x24,'I',self.script_class if case.get('scripted') else 0x1058c160);self.write(self.pawn+0x36c,'f',case.get('desiredSpeed',1))
  self.write(self.pawn+0x318,'I',0x1002|(0x20 if case.get('hitSlopedWall') else 0)|(0x10 if case.get('walking') else 0))
  self.write(self.pawn+0xc4,'I',self.zone if case.get('base',True) else 0)
  for off,key in [(0x114,'position'),(0x144,'velocity'),(0x150,'acceleration')]:self.write(self.pawn+off,'3f',*case[key])
  for off,key in [(0x378,'groundSpeed'),(0x384,'accelRate'),(0x38c,'maxStepHeight')]:self.write(self.pawn+off,'f',case[key])
  self.write(self.pawn+0x380,'f',case.get('airSpeed',0))
  self.write(self.zone+0x334,'f',case['friction']);self.write(self.zone+0x31c,'3f',*case['gravity']);self.write(self.zone+0x328,'3f',*case['zoneVelocity'])
  self.events=[];self.call(0x103ca540,self.pawn,struct.pack('<fi',case['dt'],case.get('iterations',0)))
  result={key:list(self.read(self.pawn+off,'3f')) for off,key in [(0x114,'position'),(0x144,'velocity'),(0x150,'acceleration')]}
  result.update(physics=self.read(self.pawn+0x30,'B')[0],hitSlopedWall=bool(self.read(self.pawn+0x318,'I')[0]&0x20),events=self.events);self.events=None;return result
if __name__=='__main__':
 n=NativeWalking(Path(sys.argv[1]));print(json.dumps({'results':[n.walking(x) for x in json.loads(Path(sys.argv[2]).read_text())]}))
