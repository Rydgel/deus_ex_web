"""Execute original execTraceTexture (native 1000, Engine.dll 0x103e450).
Argument/body evaluation and the MultiLine hit list are explicit controlled
callbacks; iterator control flow, the LevelInfo class-ancestry gate, the
hit.Item -> Model node/surface lookup and the texture/group/flags publishes
are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CLASSES={'Actor':0x1057cdf0,'Pawn':0x1058c660,'Mover':0x1058bb58,'LevelInfo':0x1057bf00}
class NativeTraceTexture(m.NativeCollision):
 def __init__(self,root):
  self.argument=self.body=self.multi=None
  super().__init__(root);self.call(0x10102978,0x101b3218,b'');self.source=self.alloc(0x200);self.level=self.alloc(0x100);self.vtable=self.alloc(0x100);self.info=self.alloc(0x200)
  self.frame=self.alloc(0x40);self.node=self.alloc(0x80);self.code=self.alloc(40);self.model=self.alloc(0x200)
  self.outactor=self.alloc(4);self.outname=self.alloc(4);self.outgroup=self.alloc(4);self.outflags=self.alloc(4);self.outloc=self.alloc(12);self.outnorm=self.alloc(12)
  self.argument=0x700fc000;self.body=0x700fc010;self.multi=0x700fc020
  for a,code in [(self.argument,'c2 08 00'),(self.body,'c2 08 00'),(self.multi,'c2 34 00')]:self.cpu.mem_write(a,bytes.fromhex(code))
  self.natives=self.read(0x10599a38,'I')[0];self.property=self.read(0x10599aa0,'I')[0];self.memory=self.read(0x10599bd8,'I')[0]
  self.write(self.natives+254*4,'I',self.argument);self.write(self.natives+253*4,'I',self.body)
  self.write(self.source+0xac,'I',self.level);self.write(self.source+0xa8,'I',self.info);self.write(self.source+0x24,'I',CLASSES['Pawn']);self.write(self.info+0x24,'I',CLASSES['LevelInfo'])
  self.write(self.level,'I',self.vtable);self.write(self.vtable+0xc8,'I',self.multi);self.write(self.level+0x98,'I',self.model)
  self.write(self.frame+4,'III',self.node,self.source,self.code);self.write(self.node+0x44,'I',self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i==0:self.write(result,'I',CLASSES.get(self.case.get('baseClass'),0))
   elif i in range(1,7):self.write(self.property,'I',[self.outactor,self.outname,self.outgroup,self.outflags,self.outloc,self.outnorm][i-1])
   elif i==7:self.write(result,'3f',*self.case['end'])
   elif i==8 and 'start'in self.case:self.write(result,'3f',*self.case['start'])
   elif i==9 and 'extent'in self.case:self.write(result,'3f',*self.case['extent'])
   return
  if a==self.multi:
   memory=self.read(sp+4,'I')[0]
   if memory!=self.memory:raise RuntimeError('Unexpected memory argument')
   self.query={'end':self.read(sp+8,'3f'),'start':self.read(sp+20,'3f'),'extent':self.read(sp+32,'3f'),'checkActors':self.read(sp+44,'I')[0],'world':self.read(sp+48,'I')[0]==self.info,'extra':self.read(sp+52,'I')[0]}
   c.reg_write(m.UC_X86_REG_EAX,self.hitptrs[0]if self.hitptrs else 0);return
  if a==self.body:
   self.yields.append({'actor':self.ids[self.read(self.outactor,'I')[0]],'texName':self.read(self.outname,'I')[0],
    'texGroup':self.read(self.outgroup,'I')[0],'flags':self.read(self.outflags,'i')[0],
    'location':self.read(self.outloc,'3f'),'normal':self.read(self.outnorm,'3f')})
   if self.case.get('breakAfter')==len(self.yields):self.write(self.frame+12,'I',self.code+15)
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.case=case;actors={'self':self.source,'world':self.info}
  for actor in case.get('actors',[]):actors[actor['id']]=self.alloc(0x200)
  # The texture walk dereferences the HIT actor's own +0xac (XLevel), not the
  # source's — every fabricated actor (and the world info) carries the level.
  self.write(self.info+0xac,'I',self.level)
  for actor in case.get('actors',[]):
   cls=self.alloc(0x40);supercls=CLASSES.get(actor.get('super'),0);self.write(cls+0x28,'I',supercls)
   self.write(actors[actor['id']]+0x24,'I',cls);self.write(actors[actor['id']]+0x3c,'I',actors.get(actor.get('owner'),0));self.write(actors[actor['id']]+0x1dc,'I',actor.get('flags',0));self.write(actors[actor['id']]+0xac,'I',self.level)
  self.ids={v:k for k,v in actors.items()};self.ids[0]=None
  # Fabricate Level->Model: +0x58 nodes TArray (64B records, +0x1c=iSurf),
  # +0x98 surfs TArray (64B records, +0=material object, +4=PolyFlags).
  surfspec=case.get('surfs',[{'flags':0x100},{'flags':0x200}])
  nodespec=case.get('nodes',[0]*len(surfspec))
  nodes=self.alloc(64*len(nodespec));surfs=self.alloc(64*len(surfspec))
  for i,surf in enumerate(nodespec):self.write(nodes+64*i+0x1c,'I',surf)
  for i,surf in enumerate(surfspec):
   material=0
   if surf.get('texture')is not None:
    material=self.alloc(0x40);outer=self.alloc(0x40)
    self.write(material+0x20,'I',surf['texture']);self.write(material+0x18,'I',outer);self.write(outer+0x20,'I',surf.get('group',0))
   self.write(surfs+64*i,'Ii',material,surf['flags'])
  self.write(self.model+0x58,'III',nodes,len(nodespec),len(nodespec));self.write(self.model+0x98,'III',surfs,len(surfspec),len(surfspec))
  self.hitptrs=[self.alloc(44)for _ in case['hits']]
  for i,hit in enumerate(case['hits']):self.write(self.hitptrs[i],'II6fIfi',self.hitptrs[i+1]if i+1<len(self.hitptrs)else 0,actors[hit['actor']],*hit.get('location',[i,2,3]),*hit.get('normal',[0,0,1]),0,hit.get('time',i/10),hit.get('item',-1))
  self.write(self.source+0x114,'3f',*case.get('sourcePosition',[10,20,30]));self.write(self.outactor,'I',0);self.write(self.outloc,'3f',9,9,9);self.write(self.outnorm,'3f',8,8,8)
  self.write(self.outname,'I',0x11);self.write(self.outgroup,'I',0x22);self.write(self.outflags,'i',-7)
  self.cpu.mem_write(self.code,bytes([254]*10+[22])+struct.pack('<H',15)+bytes([253,49,48,0]));self.write(self.frame+12,'I',self.code)
  self.argindex=0;self.yields=[];self.query=None;self.call(0x1036e450,self.source,struct.pack('<II',self.frame,0))
  return {'query':self.query,'yields':self.yields,'finalActor':self.ids[self.read(self.outactor,'I')[0]],'finalLocation':self.read(self.outloc,'3f'),'finalNormal':self.read(self.outnorm,'3f'),
   'finalTexName':self.read(self.outname,'I')[0],'finalTexGroup':self.read(self.outgroup,'I')[0],'finalFlags':self.read(self.outflags,'i')[0]}
if __name__=='__main__':
 n=NativeTraceTexture(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
