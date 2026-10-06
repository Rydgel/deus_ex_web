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
orig = lambda address: address - G + 0x10600000
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


# ---------------------------------------------------------------------------
# Music mode (--music): Update's music section, SetVolumes, SetInstantMusicVolume
# and UnregisterMusic (docs/galaxy-music/update-transition.md §2-§4, §9).
#
#   native-galaxy-audio-oracle.py GAME_ROOT CASES_JSON --music OUT_JSON [--modules DIR]
#
# The machine is the phase-1 loader oracle's (scripts/native-galaxy-music-oracle.py):
# Galaxy.dll rebased with Engine and Core, glxInit's state section and
# glxSetSampleVoices(16) executed, the .data snapshot restored before each case.
# Its code hook covers only the import thunks; the probes below are
# single-address hooks, so the original code runs at emulator speed.
#
# Executed from the DLLs: Galaxy Update 0x10609510 (whole: prologue, idle
# channel loop, music section, reverb tail: UseReverb +0x44 and the listener's
# zone from the case, glxSetSampleReverb a leaf recording its block), SetVolumes
# 0x106061b0, SetInstantMusicVolume 0x10606610, UnregisterMusic 0x10606e60,
# Engine's lazy-array Load 0x1030cbb0 / Unload 0x1030cd90 / byte-array
# serializer 0x1030cca0, Core FArray::Realloc 0x10145440. Tier 2 also runs
# the real library (glxLoadMusic with the IT loader, glxUnloadMusic,
# glxStop/StartMusic, glxControlMusic, glxSetMusicVolume, glxSetSampleVolume).
#
# Leaves: KERNEL32 critical sections and MSVCRT (phase 1), appSecondsSlow
# (the case clock, GTimestamp 0), GMalloc->Realloc (a bump heap: new blocks
# filled with 0xcd, contents kept up to the smaller size, size 0 frees),
# UObject::GetFullName (a fixed "Music <Pkg>.<Name>"), FOutputDevice::Logf
# (recorded, formatted), appFailAssert (aborts the op), the compact-index
# operator<< and the archive's Serialize/CountBytes/Tell/Seek over a
# fabricated package stream (the lazy array's SavedAr). Tier 1 also makes
# every glx* function a recording leaf returning the case's scripted code.
# ---------------------------------------------------------------------------
_lo_spec = importlib.util.spec_from_file_location('galaxy_music_loader_oracle', Path(__file__).with_name('native-galaxy-music-oracle.py'))
lo = importlib.util.module_from_spec(_lo_spec); _lo_spec.loader.exec_module(lo)
from unicorn import UC_HOOK_CODE, UC_HOOK_BLOCK
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG

GLX = {0x1060ec00: ('setSampleVolume', 2), 0x1060eb60: ('setMusicVolume', 2), 0x10618be0: ('loadMusic', 2),
       0x10619450: ('unloadMusic', 0), 0x106183a0: ('stopMusic', 0), 0x106122a0: ('startMusic', 0),
       0x1060d0e0: ('controlMusic', 2), 0x10618290: ('stopCDAudio', 0), 0x10611c70: ('startCDAudio', 2),
       0x1060e9a0: ('cdVolume', 2), 0x106113d0: ('setSampleReverb', 1)}
# Subsystem bodies whose glx call sites the return probes cover.
CALLERS = [(0x10609510, 0x1060abf0), (0x106061b0, 0x10606330), (0x10606610, 0x10606700), (0x10606e60, 0x10606fe8)]
UPDATE, SET_VOLUMES, SET_INSTANT_MUSIC, UNREGISTER_THUNK, UNREGISTER = 0x10609510, 0x106061b0, 0x10606610, 0x1060101e, 0x10606e60
STOP_SOUND = 0x10607e50
LAZY_LOAD, LAZY_UNLOAD, LAZY_VTABLE = 0x1030cbb0, 0x1030cd90, 0x104267fc
FARRAY_REALLOC = 0x10145440
CORE_GETFULLNAME, CORE_LOGF, CORE_FAILASSERT, CORE_COMPACT, CORE_GMALLOC = 0x1010240f, 0x10102a95, 0x10102c70, 0x10102950, 0x101a7c44
CLEAR_VOICE, BREAK_FLAG, ORDER_READ = 0x1060a83d, 0x1060a88d, 0x1060aa09
# The bodies the translation covers, for instruction coverage.
COVERAGE = [(0x1060a50b, 0x1060aa15, 'Update music section'), (0x1060aa15, 0x1060abbc, 'Update reverb tail'), (0x106061b0, 0x10606325, 'SetVolumes'),
            (0x10606610, 0x106066f1, 'SetInstantMusicVolume'), (0x10606e60, 0x10606fe8, 'UnregisterMusic'),
            (0x1030cbb0, 0x1030cc31, 'Engine lazy Load'), (0x1030cd90, 0x1030cde9, 'Engine lazy Unload')]
MSTUB = 0x700f8000  # appSecondsSlow, GMalloc Realloc, archive methods
GMEM, GMEM_SIZE = 0x50000000, 0x08000000
FILL = 0xcd
SAVED_POSITION = 0x40  # the stream offset of Data's compact count
LIBRARY = [(0x10698348, 1, 'channels'), (0x10698349, 1, 'playing'), (0x1069834a, 1, 'songLength'),
           (0x10698201, 1, 'order'), (0x10698200, 1, 'loopFlag'), (0x10698140, 1, 'skipRows'),
           (0x10697ca8, 1, 'breakFlag'), (0x10697cdc, 4, 'ahead'), (0x10697cf0, 1, 'musicMaster'),
           (0x106886a4, 1, 'musicStep'), (0x106886a5, 1, 'musicTarget'), (0x1069817c, 1, 'sampleMaster'),
           (0x10697ca0, 1, 'sampleStep'), (0x10697ce4, 1, 'sampleTarget'), (0x1068828d, 1, 'firstMusicVoice')]


class MusicAssert(Exception):
    pass


def compact_encode(value):
    a = abs(value)
    first = (0x80 if value < 0 else 0) | (0x40 if a >= 0x40 else 0) | (a & 0x3f)
    out = [first]
    if first & 0x40:
        a >>= 6
        while True:
            b = (0x80 if a >= 0x80 else 0) | (a & 0x7f)
            out.append(b); a >>= 7
            if not b & 0x80: break
    return bytes(out)


def compact_decode(data, pos):
    first = data[pos]; pos += 1
    value, shift = first & 0x3f, 6
    if first & 0x40:
        while True:
            b = data[pos]; pos += 1
            value |= (b & 0x7f) << shift; shift += 7
            if not b & 0x80: break
    return (-value if first & 0x80 else value), pos


def call_sites(image, ranges, targets):
    """Return addresses of every `call <target>` in the given ranges."""
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    out = {}
    for start, end in ranges:
        code = image.data[image.offset(start - image.base):image.offset(end - image.base)]
        for insn in md.disasm(code, start):
            if insn.mnemonic == 'call' and insn.op_str.startswith('0x') and int(insn.op_str, 16) in targets:
                out[insn.address + insn.size] = int(insn.op_str, 16)
    return out


class MusicProbe(lo.Oracle):
    def __init__(self, root, modules=None):
        # Stub addresses first: the base constructor already executes code.
        self.realloc_stub = MSTUB + 0x10
        self.archive_stubs = {MSTUB + 0x20: 'serialize', MSTUB + 0x30: 'countBytes', MSTUB + 0x40: 'tell', MSTUB + 0x50: 'seek'}
        super().__init__(root)
        cpu = self.cpu
        self.modules = Path(modules) if modules else None
        cpu.mem_map(GMEM, GMEM_SIZE)
        self.this = self.alloc(0x910); self.viewport = self.alloc(0x40); self.actor = self.alloc(0x700)
        self.zone = self.alloc(0x400)
        self.frame = self.alloc(0x30); self.clock = self.alloc(8); self.text = self.alloc(0x200)
        self.write(self.viewport + 0x30, 'I', self.actor)
        self.write(self.frame, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        # appSecondsSlow: fld qword [clock]; ret. GTimestamp 0 selects it.
        self.seconds = MSTUB
        cpu.mem_write(self.seconds, b'\xdd\x05' + struct.pack('<I', self.clock) + b'\xc3')
        self.write(at(0x10699750), 'I', self.seconds)
        self.write(self.read(at(0x10699758), 'I')[0], 'I', 0)
        # GMalloc: an FMalloc whose vtable +4 (Realloc) is a leaf.
        malloc_vt, self.gmalloc = self.alloc(0x20), self.alloc(0x10)
        self.write(malloc_vt + 4, 'I', self.realloc_stub); self.write(self.gmalloc, 'I', malloc_vt)
        self.write(CORE_GMALLOC, 'I', self.gmalloc)
        # The archive vtable: Serialize +0x04, CountBytes +0x14, Tell +0x28, Seek +0x34.
        self.archive_vt = self.alloc(0x40)
        for address, slot in zip(self.archive_stubs, (0x04, 0x14, 0x28, 0x34)):
            self.write(self.archive_vt + slot, 'I', address)
        image = n.Image(Path(root) / 'System' / 'Galaxy.dll', GALAXY)
        self.returns = {at(r): at(t) for r, t in call_sites(image, CALLERS, set(GLX)).items()}
        probes = {**{at(a): self.on_glx for a in GLX}, **{a: self.on_return for a in self.returns},
                  at(UNREGISTER): self.on_unregister, at(SET_VOLUMES): self.on_set_volumes,
                  LAZY_LOAD: self.on_lazy, LAZY_UNLOAD: self.on_lazy, FARRAY_REALLOC: self.on_realloc,
                  CORE_GETFULLNAME: self.on_full_name, CORE_LOGF: self.on_logf, CORE_FAILASSERT: self.on_fail_assert,
                  CORE_COMPACT: self.on_compact, at(CLEAR_VOICE): self.on_clear_voice, at(BREAK_FLAG): self.on_break_flag,
                  at(ORDER_READ): self.on_order_read}
        self.probes = probes
        for address in probes:
            cpu.hook_add(UC_HOOK_CODE, self.on_probe, None, address, address)
        self.events, self.pending, self.tier, self.scripted = [], [], 1, {}
        # Instruction coverage of the translated bodies (block hooks).
        self.blocks = set()
        for start, end, _ in COVERAGE:
            mapped = (lambda a: a) if start < 0x10600000 else at  # Engine at its base, Galaxy rebased
            cpu.hook_add(UC_HOOK_BLOCK, self.on_block_music, None, mapped(start), mapped(end) - 1)

    def on_block_music(self, cpu, address, size, data):
        self.blocks.add((orig(address) if address >= G else address, size))

    # -- probes ---------------------------------------------------------------
    def on_probe(self, cpu, address, size, data):
        self.probes[address](cpu, address)

    def esp(self):
        return self.cpu.reg_read(UC_X86_REG_ESP)

    def leave(self, result, pop):
        sp = self.esp()
        self.cpu.reg_write(UC_X86_REG_EAX, result & 0xffffffff)
        self.cpu.reg_write(UC_X86_REG_EIP, self.read(sp, 'I')[0])
        self.cpu.reg_write(UC_X86_REG_ESP, sp + 4 + pop)

    def on_glx(self, cpu, address):
        name, count = GLX[orig(address)]
        sp = self.esp()
        args = list(self.read(sp + 4, f'{count}i')) if count else []
        event = {'glx': name, 'args': args}
        if name == 'setSampleReverb':
            # The glxReverb Update built (its stack block), not its address.
            event = {'glx': name, 'block': bytes(cpu.mem_read(args[0], 0x6c)).hex()}
        if name == 'loadMusic':
            tag, size_, data_, length, pos = self.read(args[0], '5I')
            music = next((m for m in self.musics.values() if self.read(m['object'] + 0x34, 'I')[0] == data_), None)
            event['mem'] = {'tag': tag, 'size': size_, 'length': length, 'position': pos,
                            'data': music['name'] if music else (data_ and -1)}
            if music:
                module = music['module']
                got = bytes(cpu.mem_read(data_, length)) if length else b''
                event['mem']['moduleEqual'] = got[:len(module)] == module
                slack = got[len(module):]
                event['mem']['slack'] = len(slack) if slack == bytes([FILL]) * len(slack) else slack.hex()
        self.events.append(event)
        if self.tier == 1:
            queue = self.scripted.get(name)
            result = queue.pop(0) if queue else 0
            event['result'] = result
            self.leave(result, 0)
        else:
            self.pending.append((sp + 4, event))

    def on_return(self, cpu, address):
        sp = self.esp()
        if self.pending and self.pending[-1][0] == sp:
            self.pending.pop()[1]['result'] = cpu.reg_read(UC_X86_REG_EAX)

    def name_of(self, pointer):
        if not pointer: return None
        for music in self.musics.values():
            if music['object'] == pointer: return music['name']
        return f'{pointer:#x}'

    def on_unregister(self, cpu, address):
        self.events.append({'call': 'unregister', 'music': self.name_of(self.read(self.esp() + 4, 'I')[0])})

    def on_set_volumes(self, cpu, address):
        self.events.append({'call': 'setVolumes'})

    def on_lazy(self, cpu, address):
        lazy = cpu.reg_read(UC_X86_REG_ECX)
        self.events.append({'call': 'lazyLoad' if address == LAZY_LOAD else 'lazyUnload', 'music': self.name_of(lazy - 0x28),
                            'savedPosition': self.read(lazy + 8, 'i')[0]})

    def on_realloc(self, cpu, address):
        array = cpu.reg_read(UC_X86_REG_ECX)
        num, max_ = self.read(array + 4, '2i')
        self.events.append({'realloc': [num, max_], 'elementSize': self.read(self.esp() + 4, 'i')[0]})

    def on_clear_voice(self, cpu, address):
        self.events.append({'clearVoice': cpu.reg_read(UC_X86_REG_EAX) // 0xa0})

    def on_break_flag(self, cpu, address):
        self.events.append({'breakFlag': 1})

    def on_order_read(self, cpu, address):
        self.events.append({'orderRead': self.read(at(0x10698201), 'B')[0]})

    def wide(self, pointer):
        out = []
        while True:
            code = self.read(pointer + 2 * len(out), 'H')[0]
            if not code: return ''.join(out)
            out.append(chr(code))

    def on_full_name(self, cpu, address):  # thiscall GetFullName(TCHAR*), ret 4
        name = self.name_of(cpu.reg_read(UC_X86_REG_ECX))
        music = self.musics.get(name)
        text = f"Music {music['package']}.{music['package']}" if music else 'None'
        self.cpu.mem_write(self.text, text.encode('utf-16le') + b'\0\0')
        self.leave(self.text, 4)

    def on_logf(self, cpu, address):  # cdecl Logf(this, EName, fmt, ...)
        sp = self.esp()
        _, ename, fmt = self.read(sp + 4, '3I')
        text, arg, i = self.wide(fmt), sp + 16, 0
        out = ''
        while i < len(text):
            if text[i] == '%' and i + 1 < len(text):
                spec = text[i + 1]; i += 2
                if spec == 's': out += self.wide(self.read(arg, 'I')[0])
                elif spec == 'i': out += str(self.read(arg, 'i')[0])
                else: raise RuntimeError(f'Logf format %{spec}')
                arg += 4
            else:
                out += text[i]; i += 1
        self.events.append({'log': ename, 'text': out})
        self.leave(0, 0)

    def on_fail_assert(self, cpu, address):
        expr, _, line = self.read(self.esp() + 4, '3I')
        text = bytes(cpu.mem_read(expr, 0x100)).split(b'\0')[0].decode('latin1')
        raise MusicAssert(json.dumps({'assert': text, 'line': line}))

    def on_compact(self, cpu, address):  # cdecl operator<<(FArchive&, FCompactIndex&)
        sp = self.esp()
        archive, target = self.read(sp + 4, '2I')
        stream = self.streams[archive]
        value, stream['pos'] = compact_decode(stream['data'], stream['pos'])
        self.events.append({'archive': 'compact', 'value': value})
        self.write(target, 'i', value)
        self.leave(archive, 0)

    def on_instruction(self, cpu, address, size, data):
        if address == self.realloc_stub:  # thiscall FMalloc::Realloc(ptr, size, tag), ret 0xc
            ptr, new_size, _ = self.read(self.esp() + 4, '3I')
            result = 0
            if new_size:
                result = self.gmalloc_block(new_size)
                if ptr:
                    keep = min(self.gblocks[ptr], new_size)
                    if keep: cpu.mem_write(result, bytes(cpu.mem_read(ptr, keep)))
            if ptr: self.gblocks.pop(ptr)
            self.events.append({'gmalloc': [new_size, bool(ptr)]})
            return self.leave(result, 0xc)
        kind = self.archive_stubs.get(address)
        if kind:
            archive = cpu.reg_read(UC_X86_REG_ECX)
            stream, sp = self.streams[archive], self.esp()
            if kind == 'serialize':
                pointer, length = self.read(sp + 4, '2i')
                chunk = stream['data'][stream['pos']:stream['pos'] + length]
                if len(chunk) != length: raise RuntimeError('archive read past the stream')
                if length: cpu.mem_write(pointer, chunk)
                stream['pos'] += length
                self.events.append({'archive': 'serialize', 'length': length}); return self.leave(0, 8)
            if kind == 'countBytes':
                self.events.append({'archive': 'countBytes', 'args': list(self.read(sp + 4, '2i'))}); return self.leave(0, 8)
            if kind == 'tell':
                self.events.append({'archive': 'tell', 'value': stream['pos']}); return self.leave(stream['pos'], 0)
            stream['pos'] = self.read(sp + 4, 'i')[0]
            self.events.append({'archive': 'seek', 'value': stream['pos']}); return self.leave(0, 4)
        return super().on_instruction(cpu, address, size, data)

    def gmalloc_block(self, size):
        pointer = self.gfree
        self.gfree += (size + 15) & ~15
        if self.gfree > GMEM + GMEM_SIZE: raise MemoryError('GMalloc region exhausted')
        self.cpu.mem_write(pointer, bytes([FILL]) * size)
        self.gblocks[pointer] = size
        return pointer

    # -- execution --------------------------------------------------------------
    def run_call(self, address, this, args, cw):
        cpu = self.cpu
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this), (UC_X86_REG_FPCW, cw),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        cpu.mem_write(self.stack + 4, args)
        cpu.emu_start(address, self.done + 1, count=0)
        if cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError(f'{address:#x} did not return')
        return cpu.reg_read(UC_X86_REG_EAX)

    def module_bytes(self, spec):
        if spec.get('module'):
            return (self.modules / f"{spec['module']}.it").read_bytes()
        size = spec.get('size', 300)
        return bytes((i * 37 + 11) & 0xff for i in range(size))

    def build_music(self, name, spec):
        module = self.module_bytes(spec)
        obj, archive = self.alloc(0x50), self.alloc(0x20)
        self.cpu.mem_write(obj, bytes(0x50))
        self.write(archive, '4I', self.archive_vt, 68, 0, 1)
        stream = bytes(SAVED_POSITION) + compact_encode(len(module)) + module
        self.streams[archive] = {'data': stream, 'pos': 0}
        self.write(obj + 0x28, '2I', LAZY_VTABLE, archive)
        self.write(obj + 0x44, 'I', len(module)); self.write(obj + 0x48, 'i', spec.get('handle', 0))
        if spec.get('loaded', True):
            data = self.gmalloc_block(len(module)); self.cpu.mem_write(data, module)
            self.write(obj + 0x30, 'iIii', -SAVED_POSITION, data, len(module), len(module))
        else:
            self.write(obj + 0x30, 'iIii', SAVED_POSITION, 0, 0, 0)
        return {'name': name, 'object': obj, 'module': module, 'package': spec.get('package', spec.get('module') or name)}

    def pointer(self, name):
        return self.musics[name]['object'] if name else 0

    def set_zone(self, zone):
        """The listener's Region.Zone (AActor +0xc8): null, or a ZoneInfo with
        bReverbZone (+0x3bc bit 0), MasterGain +0x3c4, CutoffHz +0x3c8,
        Delay[6] +0x3cc, Gain[6] +0x3d2."""
        if zone is None:
            self.write(self.actor + 0xc8, 'I', 0); return
        self.cpu.mem_write(self.zone, bytes(0x400))
        self.write(self.zone + 0x3bc, 'I', zone.get('bits', 1 if zone.get('reverb') else 0))
        self.write(self.zone + 0x3c4, 'B', zone.get('masterGain', 0) & 0xff)
        self.write(self.zone + 0x3c8, 'i', zone.get('cutoffHz', 0))
        self.write(self.zone + 0x3cc, '6B', *[v & 0xff for v in zone.get('delay', [0] * 6)])
        self.write(self.zone + 0x3d2, '6B', *[v & 0xff for v in zone.get('gain', [0] * 6)])
        self.write(self.actor + 0xc8, 'I', self.zone)

    def set_actor(self, fields):
        if 'zone' in fields: self.set_zone(fields['zone'])
        if 'song' in fields: self.write(self.actor + 0x670, 'I', self.pointer(fields['song']))
        for key, offset in (('section', 0x674), ('cdTrack', 0x675), ('transition', 0x676)):
            if key in fields: self.write(self.actor + offset, 'B', fields[key] & 0xff)

    def snapshot_state(self):
        t, a = self.this, self.actor
        out = {'fade': self.read(t + 0x900, 'I')[0], 'current': self.name_of(self.read(t + 0x888, 'I')[0]),
               'cdTrack': self.read(t + 0x88c, 'B')[0], 'section': self.read(t + 0x88d, 'B')[0],
               'actor': dict(zip(('section', 'cdTrack', 'transition'), self.read(a + 0x674, '3B'))),
               'volumes': list(self.read(t + 0x69, '3B')),
               'musics': {name: dict(zip(('savedPosition', 'data', 'num', 'max'), self.read(m['object'] + 0x30, 'iIii')),
                                     handle=self.read(m['object'] + 0x48, 'i')[0]) for name, m in self.musics.items()}}
        for music in out['musics'].values(): music['data'] = bool(music['data'])
        if self.tier == 2:
            out['library'] = {name: int.from_bytes(bytes(self.cpu.mem_read(at(va), w)), 'little') for va, w, name in LIBRARY}
            first = out['library']['firstMusicVoice']
            out['voices'] = [list(self.read(at(0x1068dca0) + (first + i) * 0xa0 + 0x0d, '4B')) for i in range(32)]
            out['slots'] = {'instruments': sum(1 for i in range(256) if self.read(at(lo.INSTRUMENTS) + 4 * i, 'I')[0]),
                            'patterns': sum(1 for i in range(256) if self.read(at(lo.PATTERNS) + 4 * i, 'I')[0])}
        return out

    def run_case(self, case):
        cpu = self.cpu
        cpu.mem_write(at(lo.DATA_SECTION), self.snapshot)
        self.heap.reset(0)
        self.run_info = {'shortReads': 0, 'streamEnd': 0, 'slackReads': 0, 'patterns': 0, 'patternOverreads': []}
        self.slack, self.pattern, self.pattern_state, self.stream_log = 0, None, None, []
        self.gfree, self.gblocks, self.streams = GMEM, {}, {}
        self.tier = case.get('tier', 1)
        self.scripted = {k: list(v) for k, v in case.get('returns', {}).items()}
        cw = case.get('cw', 0x037f)
        config = case['config']
        t = self.this
        cpu.mem_write(t, bytes(0x910))
        self.write(t, 'I', at(0x1063d0e4))
        self.write(t + 0x3c, '3I', config.get('useCDMusic', 0), config.get('useDigitalMusic', 1), config.get('useReverb', 0))
        self.write(t + 0x60, '2i', config.get('latency', 40), config.get('effectsChannels', 16))
        self.write(t + 0x69, '3B', config.get('musicVolume', 153), config.get('soundVolume', 204), config.get('speechVolume', 255))
        self.write(t + 0x7c, 'I', self.viewport)
        self.musics = {}
        for name, spec in case.get('musics', {}).items():
            self.musics[name] = self.build_music(name, spec)
        sub = case.get('subsystem', {})
        self.write(t + 0x888, 'I', self.pointer(sub.get('current')))
        self.write(t + 0x88c, 'B', sub.get('cdTrack', 0xff)); self.write(t + 0x88d, 'B', sub.get('section', 0))
        self.write(t + 0x900, 'I', sub.get('fadeBits', 0x3f800000))
        for i in range(config.get('effectsChannels', 16)):
            self.run_call(at(STOP_SOUND), t, struct.pack('<I', i), cw)
        cpu.mem_write(self.actor, bytes(0x700))
        self.set_actor(case.get('actor', {}))
        if self.tier == 1:
            self.write(at(0x10698201), 'B', case.get('order', 0xff))
        results = []
        for op in case['ops']:
            self.events, self.pending = [], []
            kind = op['op']
            if 'set' in op: self.set_actor(op['set'])
            if 'order' in op: self.write(at(0x10698201), 'B', op['order'])
            if 'returns' in op:
                for k, v in op['returns'].items(): self.scripted[k] = list(v)
            record = {'op': kind}
            try:
                if kind == 'update':
                    self.write(t + 0x880, 'd', 0.0)
                    self.write(self.clock, 'd', float(op['dt']) if op['dt'] is not None else float('nan'))
                    self.run_call(at(UPDATE), t, struct.pack('<IIII', 0, 0, 0, self.frame), cw)
                elif kind == 'setVolumes':
                    if 'fadeBits' in op: self.write(t + 0x900, 'I', op['fadeBits'])
                    if 'volumes' in op: self.write(t + 0x69, '3B', *op['volumes'])
                    self.run_call(at(SET_VOLUMES), t, b'', cw)
                elif kind == 'setInstantMusicVolume':
                    self.run_call(at(SET_INSTANT_MUSIC), t, struct.pack('<I', op['value'] & 0xffffffff), cw)
                elif kind == 'destroy':
                    # UMusic::Destroy (Engine 0x10370d4c): Audio->vtbl[+0x70](this).
                    self.run_call(at(UNREGISTER_THUNK), t, struct.pack('<I', self.pointer(op['music'])), cw)
                elif kind != 'set':
                    raise ValueError(kind)
            except MusicAssert as error:
                record['fault'] = json.loads(str(error))
            except Exception as error:
                text = str(error)
                if text.startswith('{"assert"'): record['fault'] = json.loads(text)
                else: raise
            record['events'] = self.events
            record['state'] = self.snapshot_state()
            results.append(record)
        return results


def music_main(argv):
    args = [a for a in argv[1:]]
    root, cases_path = args[0], args[1]
    out_path = args[args.index('--music') + 1]
    modules = args[args.index('--modules') + 1] if '--modules' in args else None
    probe = MusicProbe(root, modules)
    cases = json.loads(Path(cases_path).read_text())
    out = []
    for case in cases:
        try:
            out.append({'name': case['name'], 'results': probe.run_case(case)})
        except Exception as error:
            out.append({'name': case['name'], 'error': str(error).split(';')[0]})
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    images = {'galaxy': n.Image(Path(root) / 'System' / 'Galaxy.dll', GALAXY), 'engine': n.Image(Path(root) / 'System' / 'Engine.dll')}
    coverage = []
    for start, end, name in COVERAGE:
        image = images['engine' if start < 0x10600000 else 'galaxy']
        code = image.data[image.offset(start - image.base):image.offset(end - image.base)]
        insns = [(i.address, f'{i.mnemonic} {i.op_str}'.strip()) for i in md.disasm(code, start)]
        covered = set()
        for address, size in probe.blocks:
            covered.update(a for a, _ in insns if address <= a < address + size)
        coverage.append({'function': name, 'start': start, 'end': end, 'instructions': insns, 'covered': sorted(covered)})
    Path(out_path).write_text(json.dumps({'hash': GALAXY, 'cases': out, 'coverage': coverage}, separators=(',', ':')))



def main():
    if '--music' in sys.argv:
        return music_main(sys.argv)
    p = Probe(sys.argv[1])
    cases = json.loads(Path(sys.argv[2]).read_text())
    out = []
    for c in cases:
        try: out.append({'results': p.run(c)})
        except Exception as e: out.append({'fault': str(e).split(';')[0]})
    print(json.dumps({'hash': GALAXY, 'results': out}))


if __name__ == '__main__':
    main()
