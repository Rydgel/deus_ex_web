"""Run Galaxy's UGalaxyAudioSubsystem::SetInstantSoundVolume/SpeechVolume/MusicVolume.

The three bodies (0x106063d0, 0x106064f0, 0x10606610), Galaxy's own _ftol and
its volume setters 0x1060ec00 / 0x1060eb60 execute from the hash-checked DLL,
rebased; EnterCriticalSection/LeaveCriticalSection are the only leaves. `this`
is a zeroed buffer with the three volume bytes (+0x69 music, +0x6a sound,
+0x6b speech) and the two music handles (+0x3c, +0x40) a case sets. Each case
reports the bytes and Galaxy's globals afterwards: the digital volume
(0x1069817c), its fade step and target (0x10697ca0, 0x10697ce4) and the music
volume (0x10697cf0) and its fade step/target (0x106886a4, 0x106886a5).
"""
import importlib.util, json, struct, sys
from pathlib import Path
s = importlib.util.spec_from_file_location('n', Path(__file__).with_name('native-collision-oracle.py'))
n = importlib.util.module_from_spec(s); s.loader.exec_module(n)
GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353'
G = 0x13000000
at = lambda address: G + (address - 0x10600000)
BODIES = {268: 0x106063d0, 269: 0x106064f0, 270: 0x10606610}
GLOBALS = {'glxDigital': 0x1069817c, 'glxDigitalFade': 0x10697ca0, 'glxDigitalTarget': 0x10697ce4,
           'glxMusic': 0x10697cf0, 'glxMusicFade': 0x106886a4, 'glxMusicTarget': 0x106886a5}


class Probe(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Galaxy.dll': {'hash': GALAXY, 'base': G}})
        self.locks = {address for address, (dll, symbol) in self.thunks.items()
                      if symbol in ('EnterCriticalSection', 'LeaveCriticalSection')}
        self.this = self.alloc(0x900)

    def on_instruction(self, cpu, address, size, data):
        if address in self.locks:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            cpu.reg_write(n.UC_X86_REG_EIP, self.read(sp, 'I')[0]); cpu.reg_write(n.UC_X86_REG_ESP, sp + 8)
            return
        return super().on_instruction(cpu, address, size, data)

    def case(self, native, value, music, sound, speech, handles=(0, 0)):
        self.cpu.mem_write(self.this, b'\0' * 0x900)
        self.write(self.this + 0x69, '3B', music, sound, speech)
        self.write(self.this + 0x3c, '2I', *handles)
        for address in GLOBALS.values():
            self.write(at(address), 'B', 0xee)
        self.call(at(BODIES[native]), self.this, struct.pack('<I', value))
        music, sound, speech = self.read(self.this + 0x69, '3B')
        return {'native': native, 'value': value, 'music': music, 'sound': sound, 'speech': speech,
                **{name: self.read(at(address), 'B')[0] for name, address in GLOBALS.items()}}


p = Probe(sys.argv[1])
cases = json.loads(Path(sys.argv[2]).read_text())
print(json.dumps({'hash': GALAXY, 'results': [p.case(**c) for c in cases]}))
