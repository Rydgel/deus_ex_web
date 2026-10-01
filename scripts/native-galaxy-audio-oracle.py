"""Run Galaxy's UGalaxyAudioSubsystem::PlaySound (0x10608100) and Update
(0x10609510) from the hash-checked DLL, rebased (docs/galaxy-audio.md).

The subsystem is a zeroed buffer with the config fields a case sets
(UseSurround +0x34, ReverseStereo +0x4c, AmbientFactor +0x58, DopplerSpeed
+0x5c, EffectsChannels +0x64, Sound/SpeechVolume +0x6a/+0x6b; UseReverb +0x44,
the 3D flag +0x74 and +0x78 stay 0), its real vtable, a viewport (+0x7c) whose
Actor is the case's listener, and channel records reset by Init's StopSound loop. Actors carry the fields
Update reads (Location, Velocity, the ambient bytes, LightType/Brightness,
EyeHeight, ShowFlags, ViewTarget, class pointer for IsA APawn, UObject index)
and share one LevelInfo (empty Pauser) and XLevel (actor array, Model).

Leaves: the Galaxy library tick (0x1060e840), voice status (0x1060cf00),
2D start (0x10612310), control (0x1060d280) and stops (0x10618410,
0x10618590) record their arguments; UModel::FastLineCheck and
URender::GlobalLighting return the case's answers; UObject::IsValid returns
1; appSecondsSlow returns the case's clock. Core's appSqrt, appAtan2,
appStricmp and FVector::SafeNormal execute. Floats are reported as bits.
"""
import importlib.util, json, struct, sys
from pathlib import Path
s = importlib.util.spec_from_file_location('n', Path(__file__).with_name('native-collision-oracle.py'))
n = importlib.util.module_from_spec(s); s.loader.exec_module(n)
GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353'
G = 0x13000000
at = lambda address: G + (address - 0x10600000)
APAWN = 0x1058c660
LIB = {'tick': 0x1060e840, 'status': 0x1060cf00, 'start': 0x10612310, 'control': 0x1060d280,
       'stop2d': 0x10618410, 'stop3d': 0x10618590}
STUB = 0x700f0000
ACTOR_FIELDS = {'location': (0x114, '3f'), 'velocity': (0x144, '3f'), 'soundRadius': (0x1c4, 'B'), 'soundVolume': (0x1c5, 'B'),
                'soundPitch': (0x1c6, 'B'), 'lightType': (0x1e0, 'B'), 'lightBrightness': (0x1e2, 'B'),
                'eyeHeight': (0x3f8, 'f'), 'showFlags': (0x5fc, 'I')}
CHANNEL = '<IIIII3fffffffff'


class Probe(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Galaxy.dll': {'hash': GALAXY, 'base': G}})
        self.locks = {address for address, (dll, symbol) in self.thunks.items()
                      if symbol in ('EnterCriticalSection', 'LeaveCriticalSection')}
        # msvcrt _wcsicmp under Core's appStricmp (Level.Pauser against "").
        self.wcsicmp = {address for address, (dll, symbol) in self.thunks.items() if symbol == '_wcsicmp'}
        self.this = self.alloc(0x910)
        self.viewport = self.alloc(0x100); self.client = self.alloc(0x40); self.engine = self.alloc(0x60)
        self.render = self.alloc(0x40); self.renderTable = self.alloc(0x100)
        self.levelInfo = self.alloc(0x600); self.xlevel = self.alloc(0x100); self.model = self.alloc(0x40)
        self.plainClass = self.alloc(0x60)
        self.clock = self.alloc(8)
        # Stubs: thiscall FastLineCheck (ret 0x18), IsValid (ret), GlobalLighting
        # (ret 0x10), cdecl appSecondsSlow (fld qword clock; ret).
        self.fast, self.valid, self.lighting, self.seconds = STUB, STUB + 0x10, STUB + 0x20, STUB + 0x30
        self.cpu.mem_write(self.fast, bytes.fromhex('c2 18 00'))
        self.cpu.mem_write(self.valid, bytes.fromhex('b8 01 00 00 00 c3'))
        self.cpu.mem_write(self.lighting, bytes.fromhex('c2 10 00'))
        self.cpu.mem_write(self.seconds, b'\xdd\x05' + struct.pack('<I', self.clock) + b'\xc3')
        self.write(at(0x106999bc), 'I', self.fast)
        self.write(at(0x106998b0), 'I', self.valid)
        self.write(at(0x10699750), 'I', self.seconds)
        benchmarking = self.read(at(0x10699758), 'I')[0]
        self.write(benchmarking, 'I', 0)
        self.write(self.renderTable + 0x88, 'I', self.lighting)
        self.write(self.render, 'I', self.renderTable)
        self.write(self.viewport + 0x18, 'I', self.client); self.write(self.client + 0x28, 'I', self.engine)
        self.write(self.engine + 0x48, 'I', self.render)
        self.write(self.xlevel + 0x98, 'I', self.model)
        self.lib = {at(address): name for name, address in LIB.items()}
        self.events = []

    def on_instruction(self, cpu, address, size, data):
        if address in self.locks:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            cpu.reg_write(n.UC_X86_REG_EIP, self.read(sp, 'I')[0]); cpu.reg_write(n.UC_X86_REG_ESP, sp + 8)
            return
        if address in self.wcsicmp:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            def text(pointer):
                out = []
                while True:
                    code = self.read(pointer + 2 * len(out), 'H')[0]
                    if not code: return ''.join(out)
                    out.append(chr(code))
            a, b = (text(p).lower() for p in self.read(sp + 4, '2I'))
            cpu.reg_write(n.UC_X86_REG_EAX, (a > b) - (a < b) & 0xffffffff)
            cpu.reg_write(n.UC_X86_REG_EIP, self.read(sp, 'I')[0]); cpu.reg_write(n.UC_X86_REG_ESP, sp + 4)
            return
        name = self.lib.get(address)
        if name:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            ret = self.read(sp, 'I')[0]
            result = 0
            if name == 'status':
                voice = self.read(sp + 4, 'I')[0]
                result = int(self.playing.get(voice, True))
            elif name == 'start':
                index, sample, frequency, volume, pan, flag = self.read(sp + 4, '6i')
                voice = self.alloc(0x100); self.voices[voice] = len(self.voices) + 1
                self.events.append({'start': index, 'sample': self.samples.get(sample), 'frequency': frequency,
                                    'volume': volume, 'pan': pan, 'flag': flag, 'voice': self.voices[voice]})
                result = voice
            elif name == 'control':
                voice, frequency, volume, pan = self.read(sp + 4, '4i')
                self.events.append({'control': self.voices.get(voice), 'frequency': frequency, 'volume': volume, 'pan': pan})
            elif name in ('stop2d', 'stop3d'):
                self.events.append({name: self.voices.get(self.read(sp + 4, 'I')[0])})
            cpu.reg_write(n.UC_X86_REG_EAX, result & 0xffffffff)
            cpu.reg_write(n.UC_X86_REG_EIP, ret); cpu.reg_write(n.UC_X86_REG_ESP, sp + 4)
            return
        if address == self.fast:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            end, start = self.read(sp + 4, '3I'), self.read(sp + 16, '3I')
            clear = self.fastAnswers.pop(0) if self.fastAnswers else True
            self.events.append({'fastLineCheck': {'end': list(end), 'start': list(start)}, 'clear': clear})
            cpu.reg_write(n.UC_X86_REG_EAX, 1 if clear else 0)
            return super().on_instruction(cpu, address, size, data)
        if address == self.lighting:
            sp = cpu.reg_read(n.UC_X86_REG_ESP)
            realtime, actor, volumePtr = self.read(sp + 4, '3I')
            before = self.read(volumePtr, 'I')[0]
            scale = self.lightScale.pop(0) if self.lightScale else None
            if scale is not None:
                self.write(volumePtr, 'f', self.read(volumePtr, 'f')[0] * scale)
            self.events.append({'globalLighting': self.names.get(actor), 'realtime': realtime, 'volume': before,
                                'after': self.read(volumePtr, 'I')[0]})
            return super().on_instruction(cpu, address, size, data)
        return super().on_instruction(cpu, address, size, data)

    def channels(self):
        out = []
        for i in range(self.count):
            voice, actor, cid, is3d, sound, *rest = self.read(self.this + 0x80 + 0x40 * i, 'IIIII11I')
            out.append({'voice': self.voices.get(voice, voice and -1), 'actor': self.names.get(actor), 'id': cid - (1 << 32) if cid >= 1 << 31 else cid,
                        'is3D': is3d, 'sound': self.samplesOf.get(sound), 'rest': list(rest)})
        return out

    def run(self, case):
        self.cpu.mem_write(self.this, b'\0' * 0x910)
        for block, size in [(self.levelInfo, 0x600), (self.xlevel, 0x100)]:
            self.cpu.mem_write(block, b'\0' * size)
        self.write(self.xlevel + 0x98, 'I', self.model)
        self.events, self.voices, self.playing = [], {}, {}
        self.fastAnswers, self.lightScale = [], []
        config = case['config']
        self.count = config['channels']
        self.write(self.this, 'I', at(0x1063d0e4))
        self.write(self.this + 0x34, 'I', config.get('useSurround', 0)); self.write(self.this + 0x4c, 'I', config.get('reverseStereo', 0))
        self.write(self.this + 0x58, '2f', config['ambientFactor'], config['dopplerSpeed'])
        self.write(self.this + 0x64, 'I', self.count); self.write(self.this + 0x6a, '2B', config['soundVolume'], config['speechVolume'])
        self.write(self.this + 0x7c, 'I', self.viewport); self.write(self.this + 0x8fc, 'i', case.get('counter', 0))
        # Init's loop (0x10605ca6): StopSound on every channel.
        for i in range(self.count): self.call(at(0x10607e50), self.this, struct.pack('<I', i))
        # Sounds with registered samples (+0x50 handle, +0x3c rate).
        self.samples, self.samplesOf, sounds = {}, {}, {}
        for name, rate in case['sounds'].items():
            sound = self.alloc(0x60); sample = self.alloc(0x60)
            self.write(sound + 0x50, 'I', sample); self.write(sample + 0x3c, 'I', rate)
            sounds[name] = sound; self.samples[sample] = name; self.samplesOf[sound] = name
        # Actors.
        self.names, actors = {}, {}
        for spec in case['actors']:
            actor = self.alloc(0x700); actors[spec['name']] = actor; self.names[actor] = spec['name']
            self.write(actor + 4, 'I', spec.get('index', 0))
            self.write(actor + 0x24, 'I', APAWN if spec.get('pawn') else self.plainClass)
            self.write(actor + 0xa8, 'I', self.levelInfo); self.write(actor + 0xac, 'I', self.xlevel)
            for key, (offset, fmt) in ACTOR_FIELDS.items():
                if key in spec: self.write(actor + offset, fmt, *(spec[key] if isinstance(spec[key], list) else [spec[key]]))
            if 'ambient' in spec: self.write(actor + 0x1c8, 'I', sounds[spec['ambient']])
        for spec in case['actors']:
            if 'viewTarget' in spec: self.write(actors[spec['name']] + 0x60c, 'I', actors[spec['viewTarget']])
        array = self.alloc(4 * max(1, len(case['actors'])))
        self.write(array, f"{len(case['actors'])}I", *[actors[spec['name']] for spec in case['actors']])
        self.write(self.xlevel + 0x2c, '2I', array, len(case['actors']))
        self.write(self.viewport + 0x30, 'I', actors[case['listener']])
        self.write(self.clock, 'd', 0.0)
        results = []
        for op in case['ops']:
            self.events = []
            if op['op'] == 'play':
                loc = op['location']
                ret = self.call(at(0x10608100), self.this, struct.pack('<IiI3ffff', actors.get(op.get('actor'), 0), op['id'],
                                sounds[op['sound']], *loc, op['volume'], op['radius'], op['pitch']))
                results.append({'op': 'play', 'result': ret & 0xff, 'events': self.events, 'channels': self.channels(),
                                'counter': self.read(self.this + 0x8fc, 'i')[0]})
            elif op['op'] == 'noteDestroy':
                self.call(at(0x106083a0), self.this, struct.pack('<I', actors[op['actor']]))
                results.append({'op': 'noteDestroy', 'events': self.events, 'channels': self.channels()})
            elif op['op'] == 'stopSoundId':
                self.call(at(0x10607ef0), self.this, struct.pack('<i', op['id']))
                results.append({'op': 'stopSoundId', 'events': self.events, 'channels': self.channels()})
            else:
                # appSecondsSlow - (+0x880) is then exactly the case's dt.
                self.write(self.this + 0x880, 'd', 0.0)
                self.write(self.clock, 'd', op['dt'])
                for voice, playing in op.get('playing', {}).items():
                    for handle, number in self.voices.items():
                        if number == int(voice): self.playing[handle] = playing
                self.fastAnswers = list(op.get('fast', [])); self.lightScale = list(op.get('light', []))
                region = self.alloc(0x10)
                coords = op['coords']
                frame = self.alloc(0x30); self.write(frame, '12f', *coords['origin'], *coords['x'], *coords['y'], *coords['z'])
                self.call(at(0x10609510), self.this, struct.pack('<IIII', 0, 0, 0, frame))
                results.append({'op': 'update', 'events': self.events, 'channels': self.channels()})
        return results


p = Probe(sys.argv[1])
cases = json.loads(Path(sys.argv[2]).read_text())
out = []
for c in cases:
    try: out.append({'results': p.run(c)})
    except Exception as e: out.append({'fault': str(e).split(';')[0]})
print(json.dumps({'hash': GALAXY, 'results': out}))
