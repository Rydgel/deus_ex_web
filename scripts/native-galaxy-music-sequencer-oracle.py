"""Run Galaxy's real module player (the mixer entry 0x10614920 with its voice
update, sequencer tick 0x10615710, IT track handler 0x10616eb0 and ramps
0x10617f50) on Deus Ex music, and record what the sequencer hands the mixer
(docs/galaxy-music.md, docs/galaxy-music/sequencer.md).

Optional research tool, never imported by the browser. Galaxy.dll is the
hash-pinned GOTY image, rebased (0x13000000) through native-collision-oracle.py,
loaded by scripts/native-galaxy-music-oracle.py (phase 1, glxLoadMusic).

Library state before a case, executed from the DLL in the original order
except where noted:
  1. glxInit's state section 0x1060dfff..0x1060e1b4 and the subsystem's
     0x1060ebc0(EffectsChannels=16) (phase 1);
  2. the CPUID results of the reference machine (MMX 1, SSE 1, 3DNow 0; Core's
     GIsMMX/GIsKatmai/GIs3DNow keep them), then glxInit's tail
     0x1060e1b4..0x1060e2a1: the GlobalAlloc'd bus, kernel and staging blocks
     and the x87 sqrt pan table (FPCW 0x037f, the reset value); 0x1060ebc0
     ran before it here, which commutes (disjoint state);
  3. glxSetCallback(0x10601064) as the subsystem Init does (0x10605673);
  4. the output open's tail 0x10613948..0x10613aca with WAVEFORMATEX
     {PCM, 2 ch, 44100 Hz, 16 bit} and flags 7 (installed config): output
     format 0x10698179, kernel setup 0x10614080(7) (SSE row), the voice step
     rescale, the rate store and the tick periods in the then-current mode.
The only leaves: Enter/LeaveCriticalSection (no effect), GlobalAlloc (zeroed
blocks), PostThreadMessageA (recorded 'P'), MSVCRT as in phase 1, and the
inner mixing kernel: the code-buffer pointer [0x10698354] is replaced by a
'ret' stub whose hook records the 14 arguments ('K'); phase 3 runs the real
kernel. _ftol is native-collision-oracle.py's fisttp bridge.

A case is a program (JSON, written by scripts/validate-galaxy-music-sequencer.mjs):
  {"op":"load","module":"Intro_Music"}  SetVolumes' library calls
      glxSetSampleVolume(127,0) / glxSetMusicVolume(76,0) (installed volumes),
      glxLoadMusic exactly as phase 1, the two setters again (Update order)
  {"op":"unload"}                       UnregisterMusic: glxStopMusic, glxUnloadMusic
  {"op":"start","section":N}            Update 0x1060a822..0x1060a88d: glxStopMusic,
      clear +0x0f of voices 16..47, glxStartMusic, glxControlMusic(2,N), break=1
  {"op":"pin","voiceCounter":a,"tickCounter":b}  the two free-running 16.16 counters
  {"op":"ahead","value":v}              the ring fill 0x10697cdc set before each callback
  {"op":"run","callbacks":n} | {"op":"run","until":"loop","margin":m,"cap":c}
      20 ms timer callbacks of 882 frames: mixer calls of n = remaining
      frames (the mixer clamps to 512) until the callback is rendered.
      'until loop' stops m ticks after the first order transition to a lower
      order (a wrap or a backward jump), or after c ticks.

Trace records: tag(1) u32 length payload. M n / R frames around each mixer
call; U after a voice-update pass (0x1061519b, entered via 0x10614a42); T
after a sequencer tick and the ramps (0x10615229, entered via 0x106151ab);
K voice u32 + 14 u32 arguments (bus pointers as offsets from the bus group's
base); P refill post; L load status; S start results; E end state. U/T carry
GLOBALS (below), then T the current pattern's 0x28-byte header (u8 flag), then
the music voice records [first, first + channels). E: all 256 voices, the 32
'CHAN' records (voice pointers at the preferred base), every pattern header.
Heap pointers are the bump heap's (base 0x40000000) addresses; the Rust kernel
replays the same address model.

Outputs per case in OUT_DIR: <case>.dig (8-byte SHA-256 prefix per group; a
group ends with each T record, the last group with E), <case>.full (records of
the first FULL groups, or of --window A:B), and summary.json.

Usage: native-galaxy-music-sequencer-oracle.py GAME_ROOT MODULE_DIRS CASES_JSON OUT_DIR
       [--cases a,b] [--window A:B] [--no-coverage]
MODULE_DIRS: comma-separated directories of <Song>.it files.
"""
import hashlib, importlib.util, json, struct, sys, time
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_ESP,
                               UC_X86_REG_EBP, UC_X86_REG_EIP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

s = importlib.util.spec_from_file_location('loader', Path(__file__).with_name('native-galaxy-music-oracle.py'))
lo = importlib.util.module_from_spec(s); s.loader.exec_module(lo)
at, orig, G = lo.at, lo.orig, lo.G

MIXER, STOP, START, CONTROL = 0x10614920, 0x106183a0, 0x106122a0, 0x1060d0e0
SET_MUSIC_VOLUME, SET_SAMPLE_VOLUME, SET_CALLBACK, DX_CALLBACK = 0x1060eb60, 0x1060ec00, 0x1060e980, 0x10601064
UNLOAD = 0x10619450
INIT_TAIL = (0x1060e1b4, 0x1060e2a1)
OPEN_TAIL = (0x10613948, 0x10613aca)
VU_ENTER, VU_DONE, TICK_ENTER, TICK_DONE = 0x10614a42, 0x1061519b, 0x106151ab, 0x10615229
VOICES, VOICE, CHAN, CHAN_SIZE = 0x1068dca0, 0xa0, 0x106887c0, 0x2a6
PATTERNS = 0x10697d40
BUSES = 0x10697d00  # d00 d04 d08 d0c d10 d14
STUB = 0x700fe000
CALLBACK_FRAMES = 882
FULL = 256
SAMPLE_VOLUME, MUSIC_VOLUME = 127, 76  # SetVolumes with SoundVolume 204, SpeechVolume 255, MusicVolume 153

# The scalars a U/T record carries, in order (address, width, name); the Rust
# kernel writes the same list (native/galaxy-kernel/src/sequencer.rs).
GLOBALS = [
    (0x10698348, 1, 'channels'), (0x10698349, 1, 'playing'), (0x1069834a, 1, 'songLength'),
    (0x1068828d, 1, 'firstMusicVoice'), (0x10697ce8, 1, 'playerMode'),
    (0x10698201, 1, 'order'), (0x10698141, 1, 'row'), (0x106981cc, 1, 'lastRow'), (0x10697ce6, 2, 'tickInRow'),
    (0x10698342, 2, 'speed'), (0x10698188, 2, 'tempo'), (0x10697cea, 2, 'initialSpeed'), (0x1069817e, 2, 'initialTempo'),
    (0x1068828c, 1, 'patternDelay'), (0x10697ca8, 1, 'breakFlag'), (0x10698140, 1, 'skipRows'), (0x10698200, 1, 'loopFlag'),
    (0x10698208, 4, 'pattern'), (0x1068dc81, 1, 'loopRow'), (0x10697d1c, 1, 'loopCounter'),
    (0x106886a6, 2, 'minPeriod'), (0x10698180, 2, 'maxPeriod'),
    (0x10697cf0, 1, 'musicMaster'), (0x106886a5, 1, 'musicTarget'), (0x106886a4, 1, 'musicStep'),
    (0x1069817c, 1, 'sfxMaster'), (0x10697ce4, 1, 'sfxTarget'), (0x10697ca0, 1, 'sfxStep'),
    (0x10697ce0, 4, 'tickCount'), (0x10698204, 4, 'voiceCounter'), (0x10697d20, 4, 'voicePeriod'),
    (0x1069834c, 4, 'tickCounter'), (0x1069818c, 4, 'tickPeriod'), (0x10697d18, 4, 'rate'),
    (0x10698194, 4, 'framesMixed'), (0x10697cdc, 4, 'ahead'), (0x10697cfc, 1, 'kernelMode'),
    (0x10698179, 1, 'outputFormat'),
]

# Original functions whose instruction coverage the validator reports.
FUNCTIONS = [
    (0x10614920, 0x1061565c, 'mixer 0x10614920 (voice update, tick, hand-off)'),
    (0x10615660, 0x1061570f, 'period to step 0x10615660'),
    (0x10615710, 0x10615a59, 'sequencer tick 0x10615710'),
    (0x10616eb0, 0x10617cc0, 'IT track handler 0x10616eb0'),
    (0x10617d40, 0x10617f50, 'note delay 0x10617d40'),
    (0x10617f50, 0x106180ff, 'ramps 0x10617f50'),
    (0x106183a0, 0x10618407, 'glxStopMusic'),
    (0x106122a0, 0x1061230c, 'glxStartMusic'),
    (0x1060d0e0, 0x1060d1ba, 'glxControlMusic'),
    (0x1060eb60, 0x1060ebbc, 'glxSetMusicVolume'),
    (0x1060ec00, 0x1060ec5c, 'glxSetSampleVolume'),
    (0x10604220, 0x10604248, 'DX callback 0x10604220'),
]


class SequencerOracle(lo.Oracle):
    def __init__(self, root):
        super().__init__(root)
        cpu = self.cpu
        self.records, self.group, self.digests, self.full = None, None, [], None
        self.window = (0, FULL)
        self.groups = 0
        self.vu_flag = self.tick_flag = False
        self.ticks_since_loop, self.last_order, self.loop_seen = 0, None, False
        cpu.mem_write(STUB, b'\xc3')
        for address, cb in ((VU_ENTER, self.on_vu_enter), (VU_DONE, self.on_vu_done),
                            (TICK_ENTER, self.on_tick_enter), (TICK_DONE, self.on_tick_done)):
            cpu.hook_add(UC_HOOK_CODE, cb, None, at(address), at(address))
        # 2. CPUID results, then glxInit's tail (allocations and the pan table).
        self.write(at(0x1068dc80), 'B', 1); self.write(at(0x10698340), 'B', 1); self.write(at(0x10698190), 'B', 0)
        frame = self.stack - 0x200
        for reg, value in ((UC_X86_REG_ESP, self.stack - 0x400), (UC_X86_REG_EBP, frame), (UC_X86_REG_EBX, 0),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)):
            cpu.reg_write(reg, value)
        cpu.emu_start(at(INIT_TAIL[0]), at(INIT_TAIL[1]))
        if cpu.reg_read(UC_X86_REG_EIP) != at(INIT_TAIL[1]):
            raise RuntimeError('glxInit tail did not reach its end')
        # 3. The subsystem's callback.
        if self.ccall(SET_CALLBACK, at(DX_CALLBACK)) != 0:
            raise RuntimeError('glxSetCallback refused')
        # 4. The output open's tail.
        self.write(at(0x1067b6d8), 'HHIIHH', 1, 2, 44100, 176400, 4, 16)
        self.write(at(0x10697cd0), 'I', 176400)
        for reg, value in ((UC_X86_REG_ESP, self.stack - 0x400), (UC_X86_REG_EBP, frame), (UC_X86_REG_EBX, 7),
                           (UC_X86_REG_EDX, 2)):
            cpu.reg_write(reg, value)
        cpu.emu_start(at(OPEN_TAIL[0]), at(OPEN_TAIL[1]))
        if cpu.reg_read(UC_X86_REG_EIP) != at(OPEN_TAIL[1]):
            raise RuntimeError('output open tail did not reach its end')
        self.write(at(0x10698354), 'I', STUB)
        self.buses = self.read(at(BUSES), '6I')
        self.pan_table = bytes(cpu.mem_read(self.read(at(0x10698390), 'I')[0], 0x10000))
        self.snapshot = bytes(cpu.mem_read(at(lo.DATA_SECTION), lo.DATA_SIZE))

    # -- leaves ------------------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        if address == STUB:
            self.on_kernel(cpu); return
        symbol = self.symbols.get(address)
        if symbol == 'GlobalAlloc':
            sp = cpu.reg_read(UC_X86_REG_ESP)
            ret, flags, size_ = self.read(sp, '3I')
            ptr = self.alloc(size_)
            cpu.mem_write(ptr, bytes(size_))
            cpu.reg_write(UC_X86_REG_EAX, ptr); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 12)
            return
        if symbol == 'PostThreadMessageA':
            sp = cpu.reg_read(UC_X86_REG_ESP)
            ret, thread, message, wparam, lparam = self.read(sp, '5I')
            self.record(b'P', struct.pack('<3I', message, wparam, lparam))
            cpu.reg_write(UC_X86_REG_EAX, 1); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 20)
            return
        return super().on_instruction(cpu, address, size, data)

    def on_kernel(self, cpu):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        args = list(self.read(sp + 4, '14I'))
        voice = (orig(cpu.reg_read(UC_X86_REG_ESI)) - 0x14 - VOICES) // VOICE
        music = self.read(at(VOICES) + voice * VOICE + 0x11, 'B')[0] & 0x80
        for k in range(3):
            args[k] = (args[k] - self.buses[2 * k + (0 if music else 1)]) & 0xffffffff
        self.record(b'K', struct.pack('<15I', voice, *args))

    def on_vu_enter(self, cpu, address, size, data):
        self.vu_flag = True

    def on_vu_done(self, cpu, address, size, data):
        if self.vu_flag:
            self.vu_flag = False
            self.record(b'U', self.state(False))

    def on_tick_enter(self, cpu, address, size, data):
        self.tick_flag = True

    def on_tick_done(self, cpu, address, size, data):
        if not self.tick_flag:
            return
        self.tick_flag = False
        payload = self.state(True)
        self.record(b'T', payload)
        self.end_group()
        order = self.read(at(0x10698201), 'B')[0]
        if self.loop_seen:
            self.ticks_since_loop += 1
        elif self.last_order is not None and self.last_order != 0xff and order != 0xff and order < self.last_order:
            self.loop_seen = True
        if order != 0xff:
            self.last_order = order

    # -- trace ---------------------------------------------------------------
    def state(self, tick):
        cpu = self.cpu
        out = bytearray(b''.join(bytes(cpu.mem_read(at(a), w)) for a, w, _ in GLOBALS))
        if tick:
            pattern = self.read(at(0x10698208), 'I')[0]
            if pattern:
                out += b'\x01' + bytes(cpu.mem_read(pattern, 0x28))
            else:
                out += b'\x00'
        first, channels = self.read(at(0x1068828d), 'B')[0], self.read(at(0x10698348), 'B')[0]
        out += bytes(cpu.mem_read(at(VOICES) + first * VOICE, channels * VOICE))
        return bytes(out)

    def record(self, tag, payload):
        rec = tag + struct.pack('<I', len(payload)) + payload
        self.group.update(rec)
        if self.window[0] <= self.groups < self.window[1]:
            self.full.append(rec)

    def end_group(self):
        self.digests.append(self.group.digest()[:8])
        self.group = hashlib.sha256()
        self.groups += 1

    def end_state(self):
        cpu = self.cpu
        out = bytearray(cpu.mem_read(at(VOICES), 256 * VOICE))
        chan = bytearray(cpu.mem_read(at(CHAN), 32 * CHAN_SIZE))
        for r in range(32):  # voice pointers in the note slots, at the preferred base
            for k in range(0xa6, CHAN_SIZE - 3, 4):
                o = r * CHAN_SIZE + k
                v = struct.unpack_from('<I', chan, o)[0]
                if at(VOICES) <= v < at(VOICES) + 256 * VOICE:
                    struct.pack_into('<I', chan, o, orig(v))
        out += chan
        for p in range(256):
            ptr = self.read(at(PATTERNS) + 4 * p, 'I')[0]
            if ptr:
                out += struct.pack('<H', p) + bytes(cpu.mem_read(ptr, 0x28))
        return bytes(out)

    # -- case program -------------------------------------------------------
    def run_case(self, program, modules):
        self.cpu.mem_write(at(lo.DATA_SECTION), self.snapshot)
        self.heap.reset(0)
        self.group, self.digests, self.full, self.groups = hashlib.sha256(), [], [], 0
        self.ticks_since_loop, self.last_order, self.loop_seen = 0, None, False
        info = {'callbacks': 0, 'mixerCalls': 0, 'ticks': 0, 'steps': []}
        ahead = 0
        for step in program:
            op = step['op']
            if op == 'load':
                self.ccall(SET_SAMPLE_VOLUME, SAMPLE_VOLUME, 0); self.ccall(SET_MUSIC_VOLUME, MUSIC_VOLUME, 0)
                module = modules[step['module']]
                self.heap.log = []
                status, _, _ = self.load(module, 0x00, bytes(lo.SLACK), coverage=False, restore=False)
                self.ccall(SET_SAMPLE_VOLUME, SAMPLE_VOLUME, 0); self.ccall(SET_MUSIC_VOLUME, MUSIC_VOLUME, 0)
                self.record(b'L', struct.pack('<I', status))
                info['steps'].append({'load': step['module'], 'status': status})
            elif op == 'unload':
                a = self.ccall(STOP)
                b = self.ccall(UNLOAD)
                self.record(b'S', struct.pack('<2I', a, b))
            elif op == 'start':
                a = self.ccall(STOP)
                for i in range(32):
                    self.write(at(VOICES) + (16 + i) * VOICE + 0xf, 'B', 0)
                b = self.ccall(START)
                c = self.ccall(CONTROL, 2, step['section'] & 0xff)
                self.write(at(0x10697ca8), 'B', 1)
                self.record(b'S', struct.pack('<3I', a, b, c))
                info['steps'].append({'start': step['section'], 'results': [a, b, c]})
            elif op == 'pin':
                self.write(at(0x10698204), 'I', step['voiceCounter'] & 0xffffffff)
                self.write(at(0x1069834c), 'I', step['tickCounter'] & 0xffffffff)
            elif op == 'ahead':
                ahead = step['value']
            elif op == 'run':
                count = step.get('callbacks')
                cap, margin = step.get('cap', 40000), step.get('margin', 64)
                done = 0
                while True:
                    if count is not None and done >= count:
                        break
                    if count is None and (self.ticks_since_loop >= margin or self.groups >= cap):
                        break
                    self.write(at(0x10697cdc), 'I', ahead)
                    remaining = CALLBACK_FRAMES
                    while remaining:
                        self.record(b'M', struct.pack('<I', remaining))
                        k = self.ccall(MIXER, *self.buses, remaining)
                        self.record(b'R', struct.pack('<I', k))
                        info['mixerCalls'] += 1
                        if k == 0:
                            raise RuntimeError('mixer rendered nothing')
                        remaining -= k
                    done += 1
                info['callbacks'] += done
                info['steps'].append({'run': done})
            else:
                raise ValueError(op)
        self.record(b'E', self.end_state())
        self.end_group()
        info['ticks'] = self.groups - 1
        return info


def function_instructions(root):
    """Every non-nop instruction of FUNCTIONS: [(start, end, name, [(address, text)])]."""
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    image = lo.n.Image(Path(root) / 'System' / 'Galaxy.dll', lo.GALAXY)
    out = []
    for start, end, name in FUNCTIONS:
        code = image.data[image.offset(start - image.base):image.offset(end - image.base)]
        insns = [(i.address, f'{i.mnemonic} {i.op_str}'.strip()) for i in md.disasm(code, start)]
        out.append((start, end, name, [(a, t) for a, t in insns if t != 'nop']))
    return out


class Coverage:
    """One code hook per original instruction, removed at its first execution,
    so coverage costs nothing once an instruction has been seen."""
    def __init__(self, cpu, functions):
        self.cpu, self.functions, self.covered, self.hooks = cpu, functions, set(), {}
        for _, _, _, insns in functions:
            for a, _ in insns:
                self.hooks[a] = cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, at(a), at(a))

    def on_instruction(self, cpu, address, size, data):
        a = orig(address)
        self.covered.add(a)
        h = self.hooks.pop(a, None)
        if h is not None:
            cpu.hook_del(h)

    def close(self):
        for h in self.hooks.values():
            self.cpu.hook_del(h)
        self.hooks = {}

    def report(self):
        return [{'function': name, 'start': start, 'end': end, 'instructions': [[a, t] for a, t in insns],
                 'covered': sorted(a for a, _ in insns if a in self.covered)} for start, end, name, insns in self.functions]


def main():
    root, module_dirs, cases_file, out = Path(sys.argv[1]), sys.argv[2].split(','), Path(sys.argv[3]), Path(sys.argv[4])
    args = sys.argv[5:]
    cases = json.loads(cases_file.read_text())
    if '--cases' in args:
        wanted = set(args[args.index('--cases') + 1].split(','))
        cases = [c for c in cases if c['name'] in wanted]
    window = None
    if '--window' in args:
        a, b = args[args.index('--window') + 1].split(':')
        window = (int(a), int(b))
    out.mkdir(parents=True, exist_ok=True)
    modules = {}
    for d in module_dirs:
        for p in Path(d).glob('*.it'):
            modules[p.stem] = p.read_bytes()
    oracle = SequencerOracle(root)
    coverage = None if '--no-coverage' in args else Coverage(oracle.cpu, function_instructions(root))
    summary_file = out / 'summary.json'
    summary = json.loads(summary_file.read_text()) if summary_file.exists() and '--cases' in args else {}
    summary.update({'galaxy': lo.GALAXY, 'oracle': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    'loader': hashlib.sha256(Path(lo.__file__).read_bytes()).hexdigest(),
                    'panTableSha256': hashlib.sha256(oracle.pan_table).hexdigest(), 'full': FULL})
    summary.setdefault('cases', {})
    (out / 'pan-table.bin').write_bytes(oracle.pan_table)
    for case in cases:
        started = time.time()
        oracle.window = window or (0, FULL)
        info = oracle.run_case(case['program'], modules)
        (out / f"{case['name']}.dig").write_bytes(b''.join(oracle.digests))
        (out / f"{case['name']}{'.window' if window else '.full'}").write_bytes(b''.join(oracle.full))
        info['digestSha256'] = hashlib.sha256(b''.join(oracle.digests)).hexdigest()
        info['programSha256'] = hashlib.sha256(json.dumps(case['program'], sort_keys=True).encode()).hexdigest()
        info['moduleSha256'] = {m['module']: hashlib.sha256(modules[m['module']]).hexdigest()
                                for m in case['program'] if m['op'] == 'load'}
        info['seconds'] = round(time.time() - started, 2)
        if window:
            info['window'] = list(window)
        else:
            summary['cases'][case['name']] = info
        print(f"{case['name']}: {info['ticks']} ticks, {info['callbacks']} callbacks, {info['seconds']}s", file=sys.stderr)
    if coverage is not None:
        coverage.close()
        if not window:
            (out / 'coverage.json').write_text(json.dumps(coverage.report()))
    if not window:
        summary_file.write_text(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
