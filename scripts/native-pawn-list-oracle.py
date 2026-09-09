"""Original AddPawn/RemovePawn linked-list instructions on controlled actor graphs."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'));n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
a=n.NativeCollision(Path(sys.argv[1]));level=a.alloc(256);info=a.alloc(2048);array=a.alloc(32);frame=a.alloc(32);code=a.alloc(8);pawns=[a.alloc(2048)for _ in range(4)];a.write(level+0x2c,'I',array);a.write(array,'I',info);a.write(info+0x24,'I',0x1057bf00)
for p in pawns:a.write(p+0xac,'I',level)
results=[]
for case in json.loads(Path(sys.argv[2]).read_text()):
 a.write(info+0x54c,'I',pawns[case['head']]if case['head']is not None else 0)
 for i,x in enumerate(case['next']):a.write(pawns[i]+0x498,'I',pawns[x]if x is not None else 0)
 a.write(frame+12,'I',code);a.call(0x103bb430 if case['op']=='add'else 0x103bb570,pawns[case['pawn']],struct.pack('<II',frame,0))
 def index(p):return pawns.index(p)if p else None
 results.append({'head':index(a.read(info+0x54c,'I')[0]),'next':[index(a.read(p+0x498,'I')[0])for p in pawns]})
print(json.dumps({'hashes':n.HASHES,'results':results}))
