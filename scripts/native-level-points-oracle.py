"""Original level/hash/model point lists and closest recovery, without substitutes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
spec=importlib.util.spec_from_file_location('level',Path(__file__).with_name('native-level-oracle.py'))
level=importlib.util.module_from_spec(spec);spec.loader.exec_module(level)

class NativeLevelPoints(level.NativeLevel):
    def point_result(self,clear,hit):
        result=self.result(clear,hit)
        primitive=self.read(hit+32,'I')[0]
        result['primitive']=None if not primitive else ('$world' if primitive==self.read(self.level+0x98,'I')[0] else next((name for name,actor in self.actor_ptrs.items() if primitive in self.read(actor+0x174,'2I')), '$unknown'))
        return result

    def point_case(self,case):
        position,extent=case['position'],case['extent']
        world=self.info if case.get('world',True) else 0
        flags,actors=case.get('flags',0),case.get('checkActors',1)
        mark=self.read(self.memstack,'4I')
        head=self.call(0x1039acc0,self.level,struct.pack('<I6f3I',self.memstack,*position,*extent,flags,world,actors))
        hits=[]
        while head:
            if len(hits)>2048:raise RuntimeError('Point result cycle/capacity')
            hits.append(self.point_result(0,head));head=self.read(head,'I')[0]
        self.write(self.memstack,'4I',*mark)
        hit=self.alloc(44);self.write(hit+36,'f',1);self.write(hit+40,'i',-1)
        clear=self.call(0x1039aac0,self.level,struct.pack('<I6f3I',hit,*position,*extent,flags,world,actors))
        return {'hits':hits,'single':self.point_result(clear,hit)}

    def model_point_case(self,case):
        owner=self.actor_ptrs.get(case.get('actor'),0)
        original=self.actors[owner]['values'] if owner else None
        if case.get('owner'):self.set_brush_values(owner,original|case['owner'])
        model=self.read(owner+0x178,'I')[0] if owner else self.read(self.level+0x98,'I')[0]
        hit=self.alloc(44);self.write(hit+36,'f',1);self.write(hit+40,'i',-1)
        clear=self.call(0x103f1570,model,struct.pack('<II6fI',hit,owner,*case['position'],*case['extent'],case.get('flags',0)))
        result=self.point_result(clear,hit)
        if case.get('owner'):self.set_brush_values(owner,original)
        return result

_WORKER=None

def _worker_init(root,scene_path):
    """Per-worker scene; each Unicorn instance lives in exactly one process."""
    global _WORKER
    _WORKER=NativeLevelPoints(Path(root),json.loads(Path(scene_path).read_text()))

def _worker_case(item):
    kind,case=item
    return _WORKER.model_point_case(case) if kind=='models' else _WORKER.point_case(case)

if __name__=='__main__':
    if len(sys.argv)!=4:sys.exit('Usage: native-level-points-oracle.py GAME_ROOT SCENE_JSON CASES_JSON')
    scene=Path(sys.argv[2]).read_bytes();raw=Path(sys.argv[3]).read_bytes();cases=json.loads(raw)
    # The model/point case lists are the validate critical path: shard them
    # across worker probes and join the results in input order — identical to
    # the serial run by construction.
    work=[('models',c) for c in cases.get('models',[])]+[('points',c) for c in cases.get('points',[])]
    results=level.oracle_pool.pooled_map(_worker_case,_worker_init,(sys.argv[1],sys.argv[2]),work)
    count=len(cases.get('models',[]))
    print(json.dumps({'hashes':level.base.HASHES|{'MSVCRT.dll':level.hash_module.CRT_HASH},'sceneSha256':hashlib.sha256(scene).hexdigest(),'casesSha256':hashlib.sha256(raw).hexdigest(),
      'models':results[:count],'points':results[count:]}))
