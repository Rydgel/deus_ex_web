"""Original world UModel.PointCheck boolean; no recovery substitute."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
spec=importlib.util.spec_from_file_location('collision',Path(__file__).with_name('native-collision-oracle.py'))
collision=importlib.util.module_from_spec(spec);spec.loader.exec_module(collision)

class NativePoint(collision.NativeCollision):
    def point_bool(self,model,case):
        hit=self.alloc(48)
        clear=self.call(0x103f1570,model,struct.pack('<II6fI',hit,0,*case['position'],*case['extent'],case.get('extraNodeFlags',0)))
        return bool(clear)

if __name__=='__main__':
    if len(sys.argv)!=4:sys.exit('Usage: native-point-oracle.py GAME_ROOT MODEL_JSON CASES_JSON')
    n=NativePoint(Path(sys.argv[1]));model=n.model(json.loads(Path(sys.argv[2]).read_text()))
    cases=json.loads(Path(sys.argv[3]).read_text())
    print(json.dumps({'hashes':collision.HASHES,'outside':[n.point_bool(model,c) for c in cases]}))
