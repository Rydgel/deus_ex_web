"""Original Core GetAxes and expression primitives; source-selected eye branches.

Only out-parameter address binding uses research stubs. All axes and numerical
expression outputs execute original hash-gated Core instructions.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys
s = importlib.util.spec_from_file_location('b', Path(__file__).with_name('native-brush-oracle.py'))
b = importlib.util.module_from_spec(s); s.loader.exec_module(b)

class NativeCamera(b.NativeBrush):
    def __init__(self, root):
        super().__init__(root)
        image = b.collision.Image(root / 'System' / 'Core.dll')
        exports = image.exports()
        names = {30:'FloatConst',34:'RotationConst',171:'Multiply_FloatFloat',172:'Divide_FloatFloat',
                 174:'Add_FloatFloat',175:'Subtract_FloatFloat',193:'Sqrt',244:'FMin',246:'FClamp'}
        self.addresses = {}
        for token, name in names.items():
            address = exports[f'?exec{name}@UObject@@QAEXAAUFFrame@@QAX@Z']
            self.addresses[token] = address
            self.write(0x101f41b8 + token * 4, 'I', address)
        self.frame, self.script, self.output = self.alloc(32), self.alloc(8192), self.alloc(48)
        for axis in range(3):
            stub = self.alloc(16)
            # mov dword ptr [GPropAddr], output+axis*12; ret 8. No math.
            self.cpu.mem_write(stub, b'\xc7\x05' + struct.pack('<II', 0x101e32f8, self.output + axis*12) + b'\xc2\x08\x00')
            self.write(0x101f41b8 + (0x30 + axis)*4, 'I', stub)

    def expression(self, node):
        if isinstance(node, (float, int)):
            return bytes([30]) + struct.pack('<f', node)
        return bytes([node[0]]) + b''.join(self.expression(a) for a in node[1:]) + bytes([22])

    def evaluate(self, node):
        code = self.expression(node)
        self.cpu.mem_write(self.script, code[1:])
        self.write(self.frame + 8, 'III', self.actor, self.script, 0)
        self.call(self.addresses[code[0]], self.actor, struct.pack('<II', self.frame, self.output+36))
        return self.read(self.output+36, 'f')[0]

    def capture(self, case):
        code = bytes([34]) + struct.pack('<3i', *case['rotation']) + bytes([0x30,0x31,0x32,22])
        self.cpu.mem_write(self.script, code)
        self.write(self.frame + 8, 'III', self.actor, self.script, 0)
        self.call(0x10102d06, self.actor, struct.pack('<II', self.frame, self.output+36))
        axes = self.read(self.output, '9f')
        x,y = case['velocity'][:2]
        speed = self.evaluate([193,[174,[171,x,x],[171,y,y]]])
        eye = case['eye']; dt=case['dt']
        smooth_expr = [172,[171,10,dt],eye['timeDilation']]
        walking = eye['physics']==1 and not eye['justLanded']
        smooth = self.evaluate([244,1,smooth_expr] if walking else [246,smooth_expr,.35,1])
        prior = [174,[175,eye['eyeHeight'],eye['locationZ']],eye['oldLocationZ']] if walking else eye['eyeHeight']
        height = self.evaluate([174,[171,prior,[175,1,smooth]],[171,[174,eye['shakeVert'],eye['baseEyeHeight']],smooth]])
        if eye['joltMagnitude'] and eye['physics']==1 and eye['bob']:
            height = self.evaluate([174,height,[171,eye['joltMagnitude'],5]])
        decay = [self.evaluate([171,v,[175,1,[244,1,[171,8,dt]]]]) for v in case['walkBob']]
        return {'axes':[list(axes[i:i+3]) for i in [0,3,6]], 'speed2D':speed,
                'eye': {'eyeHeight':height,'justLanded':eye['justLanded'] if walking else False,'joltMagnitude':0},
                'decay':decay}

if __name__=='__main__':
    native=NativeCamera(Path(sys.argv[1]));cases=json.loads(Path(sys.argv[2]).read_text())
    print(json.dumps({'hashes':b.collision.HASHES,'results':[native.capture(c) for c in cases]}))
