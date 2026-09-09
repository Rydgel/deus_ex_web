"""Original hash ActorEncroachmentCheck with original bounds/point primitives."""
import importlib.util,json,struct,sys,hashlib
from pathlib import Path
s=importlib.util.spec_from_file_location('points',Path(__file__).with_name('native-level-points-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class NativeEncroachment(m.NativeLevelPoints):
 def __init__(self,root,scene):
  super().__init__(root,scene)
  self.write(0x1058bb58+0x28,'I',0x10582a28);self.write(0x10582a28+0x28,'I',0x1057cdf0)
  for fixture in scene['actors']:self.write(self.actor_ptrs[fixture['id']]+0x28,'I',fixture.get('actorFlags',int(bool(fixture['values'].get('bStatic')))))
 def capture(self,c):
  if c.get('pawnPosition'):
   p=self.actor_ptrs['$pawn'];self.call(0x103583a0,self.hash,struct.pack('<I',p));self.write(p+0x114,'3f',*c['pawnPosition']);self.call(0x103580b0,self.hash,struct.pack('<I',p))
  actor=self.actor_ptrs[c['actor']];mark=self.read(self.memstack,'4I')
  head=self.call(0x10358d50,self.hash,struct.pack('<II3f3iI',self.memstack,actor,*c['position'],*c['rotation'],c.get('extra',0)))
  hits=[]
  while head:
   if len(hits)>2048:raise RuntimeError('Encroachment result cycle/capacity')
   hits.append(self.point_result(0,head));head=self.read(head,'I')[0]
  self.write(self.memstack,'4I',*mark)
  return {'hits':hits,'positionAfter':self.read(actor+0x114,'3f'),'rotationAfter':self.read(actor+0x120,'3i')}
if __name__=='__main__':
 raw=Path(sys.argv[2]).read_bytes();cases=Path(sys.argv[3]).read_bytes();n=NativeEncroachment(Path(sys.argv[1]),json.loads(raw))
 print(json.dumps({'hashes':m.level.base.HASHES|{'MSVCRT.dll':m.level.hash_module.CRT_HASH},'sceneSha256':hashlib.sha256(raw).hexdigest(),'casesSha256':hashlib.sha256(cases).hexdigest(),'results':[n.capture(c) for c in json.loads(cases)]}))
