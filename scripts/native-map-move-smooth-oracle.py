"""Observe moveSmooth calls inside original mover encroachment with real map geometry."""
import importlib.util,json,sys,struct
from pathlib import Path
s=importlib.util.spec_from_file_location('mover',Path(__file__).with_name('native-mover-move-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Native(m.Native):
 def __init__(self,root,scene):
  self.smooth_stack=[];self.move_returns=[];self.smooth_cases=[]
  super().__init__(root,scene)
 def on_instruction(self,cpu,address,size,data):
  sp=cpu.reg_read(m.UC_X86_REG_ESP)
  if self.mover_trace is not None:
   if self.move_returns and address==self.move_returns[-1]['return']:
    pending=self.move_returns.pop();case=self.smooth_cases[pending['case']];hit=pending['hit'];case['responses'].append({'result':bool(cpu.reg_read(m.UC_X86_REG_EAX)),'time':self.read(hit+36,'f')[0],'normal':self.read(hit+20,'3f')})
   if self.smooth_stack and address==self.smooth_stack[-1]['return']:
    pending=self.smooth_stack.pop();self.smooth_cases[pending['case']]['result']=bool(cpu.reg_read(m.UC_X86_REG_EAX))
   if address==0x103c9020:
    actor=cpu.reg_read(m.UC_X86_REG_ECX);case={'delta':self.read(sp+4,'3f'),'rotation':self.read(actor+0x120,'3i'),'responses':[],'events':[]}
    self.smooth_stack.append({'return':self.read(sp,'I')[0],'case':len(self.smooth_cases)});self.smooth_cases.append(case)
   if self.smooth_stack and address==0x103990e0:
    index=self.smooth_stack[-1]['case'];case=self.smooth_cases[index];case['events'].append({'move':self.read(sp+8,'3f'),'rotation':self.read(sp+20,'3i')});self.move_returns.append({'return':self.read(sp,'I')[0],'case':index,'hit':self.read(sp+32,'I')[0]})
   if self.smooth_stack and address==self.event:
    token,params,_=self.read(sp+4,'III')
    if self.names.get(token)=='HitWall':self.smooth_cases[self.smooth_stack[-1]['case']]['events'].append({'hitWall':self.read(params,'3f')})
  return super().on_instruction(cpu,address,size,data)
if __name__=='__main__':
 scene=json.loads(Path(sys.argv[2]).read_text());results=[]
 for c in json.loads(Path(sys.argv[3]).read_text()):
  native=Native(Path(sys.argv[1]),scene)
  if 'pawnPosition' in c:
   p=native.actor_ptrs['$pawn'];native.call(0x103583a0,native.hash,struct.pack('<I',p));native.write(p+0x114,'3f',*c['pawnPosition']);native.call(0x103580b0,native.hash,struct.pack('<I',p))
  native.capture(c);results.extend(native.smooth_cases)
 print(json.dumps({'hashes':m.m.base.HASHES,'cases':results}))
