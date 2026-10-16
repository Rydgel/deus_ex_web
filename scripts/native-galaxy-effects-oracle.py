"""Run Galaxy's sample (effect voice) entries from the hash-pinned GOTY
Galaxy.dll under Unicorn, with the real SSE mixer, conversion and renderer
(docs/galaxy-music/effects.md):

  glxLoadSample 0x10618e60(&glxMemory{'MEMO', 0xc, Data, Num, 0}, 2), as
      RegisterSound 0x10606af0 calls it (0x10606b85..0x10606bac), on RIFF
      WAVE bytes (the dispatch, the WAV loader 0x10619940, the memory stream);
  glxStartSample 0x10612310, glxControlSample 0x1060d280, glxControlVoice
      0x1060cf00, glxStopSample 0x10618410, glxSetSampleVolume 0x1060ec00,
      glxUnloadSample 0x10619500 (UnregisterSound's: the voices playing the
      sample stopped, its blocks freed);
  the timer callback's renderer 0x106146a0, which mixes the effect voices
      [0, EffectsChannels) onto bus B and converts it with the saturating
      add (and bus A, the music, with the store).

Optional research tool, never imported by the browser. It extends
scripts/native-galaxy-music-sequencer-oracle.py's MixerOracle (--real-kernel
state: glxInit, glxSetCallback, the output open, the SSE kernel in the code
buffer, MXCSR 0x1f80), so its ops (load, start, run, pin, ahead, poke, ...)
are available too. Added leaves: KERNEL32 CreateMutexA (handles 0x1000 + 4n,
n counted from the case start), ReleaseMutex, CloseHandle (no effect) and
WaitForMultipleObjects (WAIT_FAILED for 0 handles, as Windows: nCount must
not be zero; otherwise WAIT_OBJECT_0: no other thread holds a voice mutex).
glxLoadSample's mallocs go to a second bump heap at EFFECT_HEAP (the Rust
kernel's address model for samples, native/galaxy-kernel/src/effects.rs).

Ops (each W/V record closes a digest group):
  {"op":"loadSample","sample":name}     the WAV bytes of SAMPLES_DIR/<name>.wav;
      record W = u32 result, then (result != 0) the 0x48-byte glxSample and its
      Data block (u32 size, bytes); a load still running after LOAD_TIMEOUT
      records W = SPIN_MARK and ends the case (an original hang)
  {"op":"startSample","voice":v,"sample":name|null,"freq":f,"vol":v,"pan":p,"flags":fl}
      glxStartSample(v, address of the named sample's record, ...); record V
  {"op":"controlSample","slot":s|null,"freq","vol","pan"}   record V
  {"op":"stopSample","slot":s|null}                          record V
  {"op":"controlVoice","slot":s|null,"cmd","p1","p2"}        record V
  {"op":"unloadSample","sample":name|null}   glxUnloadSample(the named sample's record or 0);
      record U = V, then u32 1 when the record and its Data block were freed
  {"op":"sampleVolume","volume":v,"mode":m}                  glxSetSampleVolume; record V
  {"op":"sampleReverb","block":H,"cos":[[xSig,xSE,cSig,cSE],...]}  glxSetSampleReverb(&block)
      (the 0x6c-byte glxReverb H); FCOS's result for each listed input (hex
      significand, sign/exponent) replaces Unicorn's; record Y = u32 result,
      u32 flags (1 hook = the SSE kernel, 2 a context), the context's first 0xc8 bytes
  {"op":"heads","same":bool}   following callbacks render with posB = posA (the
      renderer's resync placement, which the browser uses: bus A stored, then
      bus B added onto the same frames); per-callback PCM is that segment
V = u32 result (voice pointers at the preferred base) and voices [0, 32)
with Link (+0x9c) at the preferred base.

Usage: native-galaxy-effects-oracle.py GAME_ROOT MODULE_DIRS SAMPLES_DIR CASES_JSON OUT_DIR [--cases a,b]
Outputs as the sequencer oracle's --real-kernel mode (<case>.dig, .full,
.pcm.dig, .pcm, .json, coverage.json, oracle.json).
"""
import hashlib, importlib.util, json, struct, sys, time
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn import x86_const
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EIP, UC_X86_REG_ESP, UC_X86_REG_FPSW

s = importlib.util.spec_from_file_location('seq', Path(__file__).with_name('native-galaxy-music-sequencer-oracle.py'))
seq = importlib.util.module_from_spec(s); s.loader.exec_module(seq)
lo, at, orig = seq.lo, seq.at, seq.orig

LOAD_SAMPLE, START_SAMPLE, CONTROL_SAMPLE, CONTROL_VOICE, STOP_SAMPLE = 0x10618e60, 0x10612310, 0x1060d280, 0x1060cf00, 0x10618410
SET_SAMPLE_VOLUME, UNLOAD_SAMPLE = 0x1060ec00, 0x10619500
SET_SAMPLE_REVERB, REVERB_FCOS, REVERB_HOOK, REVERB_CTX, REVERB_KERNEL = 0x106113d0, 0x10610ac1, 0x10688288, 0x10688284, 0x10622d33
FP = [getattr(x86_const, f'UC_X86_REG_FP{i}') for i in range(8)]
EFFECT_HEAP, EFFECT_HEAP_SIZE = 0x60000000, 0x04000000
MUTEX_BASE = 0x1000
VOICES, VOICE = seq.VOICES, seq.VOICE
RECORD_VOICES = 32
LOAD_TIMEOUT = 3_000_000  # microseconds; a shipped WAV loads in milliseconds
SPIN_MARK = 0xfffffffe  # W result of a load that never returns
FUNCTIONS = [
    (0x10618e60, 0x10618fb4, 'glxLoadSample 0x10618e60'),
    (0x10619940, 0x10619d16, 'WAV loader 0x10619940'),
    (0x10612310, 0x106126e7, 'glxStartSample 0x10612310'),
    (0x106126f0, 0x106127f1, '3D voice poll 0x106126f0'),
    (0x1060d280, 0x1060d366, 'glxControlSample 0x1060d280'),
    (0x1060cf00, 0x1060d0d3, 'glxControlVoice 0x1060cf00'),
    (0x10618410, 0x1061858b, 'glxStopSample 0x10618410'),
    (0x10619500, 0x106195aa, 'glxUnloadSample 0x10619500'),
    (0x106113d0, 0x10611610, 'glxSetSampleReverb 0x106113d0'),
    (0x106109f0, 0x1061122f, 'reverb setup 0x106109f0'),
    (0x10622d33, 0x10622f1b, 'SSE reverb kernel 0x10622d33'),
]


class EffectHeap(lo.Heap):
    """The music oracle's bump heap, at EFFECT_HEAP."""
    def reset_bump(self, fill):
        if self.blocks:
            raise RuntimeError(f'{len(self.blocks)} effect heap blocks still live')
        self.top, self.blocks, self.fill = EFFECT_HEAP, {}, fill
        self.live = self.peak = 0

    def _new(self, size):
        ptr = self.top
        self.top += max(16, (size + 15) & ~15)
        if self.top > EFFECT_HEAP + EFFECT_HEAP_SIZE:
            raise MemoryError('effect heap exhausted')
        if size:
            self.cpu.mem_write(ptr, bytes([self.fill]) * size)
        self.blocks[ptr] = size
        self.live += size; self.peak = max(self.peak, self.live)
        return ptr


class EffectsOracle(seq.MixerOracle):
    def __init__(self, root, samples_dir):
        super().__init__(root)
        self.samples_dir = Path(samples_dir)
        self.cpu.mem_map(EFFECT_HEAP, EFFECT_HEAP_SIZE)
        self.effect_heap = EffectHeap(self.cpu)
        self.music_heap = self.heap
        self.mutexes = 0
        self.sample_addr = {}
        self.same_heads = False
        self.pattern = None
        # The reverb setup's FCOS (0x10610ac1): Unicorn computes it in double,
        # so its result is replaced by the case's value for that input.
        self.cos_table, self.cos_pending = {}, None
        self.cpu.hook_add(UC_HOOK_CODE, self.on_fcos, None, at(REVERB_FCOS), at(REVERB_FCOS + 2))
        self.reverb_block = self.alloc(0x70)

    def on_fcos(self, cpu, address, size, data):
        top = (cpu.reg_read(UC_X86_REG_FPSW) >> 11) & 7
        if address == at(REVERB_FCOS):
            x = cpu.reg_read(FP[top])
            if tuple(x) not in self.cos_table:
                raise RuntimeError(f'reverb FCOS input {x} has no case value')
            self.cos_pending = self.cos_table[tuple(x)]
        elif address == at(REVERB_FCOS + 2) and self.cos_pending is not None:
            cpu.reg_write(FP[top], self.cos_pending)
            self.cos_pending = None

    def case_start(self):
        super().case_start()
        self.cpu.mem_write(EFFECT_HEAP, bytes(max(0, self.effect_heap.top - EFFECT_HEAP)))
        self.effect_heap.blocks = {}
        self.effect_heap.reset(0)
        self.mutexes, self.sample_addr, self.same_heads = 0, {}, False

    # -- leaves ------------------------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        symbol = self.symbols.get(address)
        stdcall = {'CreateMutexA': 3, 'ReleaseMutex': 1, 'CloseHandle': 1, 'WaitForMultipleObjects': 4}
        if symbol in stdcall:
            sp = cpu.reg_read(UC_X86_REG_ESP)
            ret = self.read(sp, 'I')[0]
            argv = self.read(sp + 4, f'{stdcall[symbol]}I')
            if symbol == 'CreateMutexA':
                result = MUTEX_BASE + 4 * self.mutexes
                self.mutexes += 1
            elif symbol == 'WaitForMultipleObjects':
                result = 0xffffffff if argv[0] == 0 else 0
            else:
                result = 1
            cpu.reg_write(UC_X86_REG_EAX, result)
            cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 4 + 4 * stdcall[symbol])
            return
        return super().on_instruction(cpu, address, size, data)

    # -- records ------------------------------------------------------------------
    def voices_record(self, result):
        raw = bytearray(self.cpu.mem_read(at(VOICES), RECORD_VOICES * VOICE))
        for v in range(RECORD_VOICES):
            link = struct.unpack_from('<I', raw, v * VOICE + 0x9c)[0]
            if at(VOICES) <= link < at(VOICES) + 256 * VOICE:
                struct.pack_into('<I', raw, v * VOICE + 0x9c, orig(link))
        if at(VOICES) <= result < at(VOICES) + 256 * VOICE:
            result = orig(result)
        return struct.pack('<I', result) + bytes(raw)

    def timed_call(self, address, *args):
        cpu = self.cpu
        cpu.reg_write(UC_X86_REG_ESP, self.stack)
        self.write(self.stack, f'{1 + len(args)}I', self.done, *[a & 0xffffffff for a in args])
        cpu.emu_start(at(address), self.done + 1, timeout=LOAD_TIMEOUT)
        if cpu.reg_read(UC_X86_REG_EIP) != self.done:
            return None
        return cpu.reg_read(UC_X86_REG_EAX)

    def voice_pointer(self, slot):
        return 0 if slot is None else at(VOICES) + slot * VOICE

    # -- ops ----------------------------------------------------------------------
    def other_op(self, step, info):
        cpu, op = self.cpu, step['op']
        if op == 'loadSample':
            data = (self.samples_dir / f"{step['sample']}.wav").read_bytes()
            cpu.mem_write(lo.STREAM, data)
            self.write(self.mem, '5I', 0x4f4d454d, 0xc, lo.STREAM, len(data), 0)
            self.run_info = {'shortReads': 0, 'streamEnd': 0, 'slackReads': 0, 'patterns': 0, 'patternOverreads': []}
            self.slack = lo.STREAM + len(data)
            self.heap = self.effect_heap
            try:
                result = self.timed_call(LOAD_SAMPLE, self.mem, 2)
            finally:
                self.heap = self.music_heap
            if result is None:
                # The loader never returns (a chunk read of nothing loops back to
                # the remaining-bytes test): the case ends here.
                info['steps'].append({'loadSample': step['sample'], 'spin': True})
                self.record(b'W', struct.pack('<I', SPIN_MARK)); self.end_group()
                raise seq.Fault('spin', f"glxLoadSample on {step['sample']} still running after {LOAD_TIMEOUT // 1000000} s")
            payload = struct.pack('<I', result)
            if result:
                record = bytes(cpu.mem_read(result, 0x48))
                pointer = struct.unpack_from('<I', record, 0x44)[0]
                size = self.effect_heap.blocks.get(pointer, 0)
                payload += record + struct.pack('<I', size) + bytes(cpu.mem_read(pointer, size) if size else b'')
                self.sample_addr[step['sample']] = result
            info['steps'].append({'loadSample': step['sample'], 'result': result, 'shortReads': self.run_info['shortReads']})
            self.record(b'W', payload)
            self.end_group()
        elif op == 'startSample':
            name = step.get('sample')
            sample = step['address'] if 'address' in step else (self.sample_addr.get(name, 0) if name else 0)
            result = self.ccall(START_SAMPLE, step['voice'], sample, step['freq'], step['vol'], step['pan'], step.get('flags', 0))
            self.record(b'V', self.voices_record(result)); self.end_group()
        elif op == 'controlSample':
            result = self.ccall(CONTROL_SAMPLE, self.voice_pointer(step.get('slot')), step['freq'], step['vol'], step['pan'])
            self.record(b'V', self.voices_record(result)); self.end_group()
        elif op == 'stopSample':
            result = self.ccall(STOP_SAMPLE, self.voice_pointer(step.get('slot')))
            self.record(b'V', self.voices_record(result)); self.end_group()
        elif op == 'unloadSample':
            name = step.get('sample')
            sample = self.sample_addr.get(name, 0) if name else 0
            data = self.read(sample + 0x44, 'I')[0] if sample else 0
            self.heap = self.effect_heap
            try:
                result = self.ccall(UNLOAD_SAMPLE, sample)
            finally:
                self.heap = self.music_heap
            freed = int(bool(sample) and sample not in self.effect_heap.blocks and data not in self.effect_heap.blocks)
            if name:
                del self.sample_addr[name]
            self.record(b'U', self.voices_record(result) + struct.pack('<I', freed)); self.end_group()
        elif op == 'controlVoice':
            result = self.ccall(CONTROL_VOICE, self.voice_pointer(step.get('slot')), step['cmd'], step.get('p1', 0), step.get('p2', 0))
            self.record(b'V', self.voices_record(result)); self.end_group()
        elif op == 'sampleVolume':
            result = self.ccall(SET_SAMPLE_VOLUME, step['volume'], step['mode'])
            self.record(b'V', self.voices_record(result)); self.end_group()
        elif op == 'heads':
            self.same_heads = bool(step['same'])
        elif op == 'sampleReverb':
            # glxSetSampleReverb(&block), as Update calls it (0x1060ab8e).
            for xs, xe, cs, ce in step.get('cos', []):
                self.cos_table[(int(xs, 16), int(xe, 16))] = (int(cs, 16), int(ce, 16))
            cpu.mem_write(self.reverb_block, bytes.fromhex(step['block']))
            result = self.ccall(SET_SAMPLE_REVERB, self.reverb_block)
            hook, ctx = self.read(at(REVERB_HOOK), 'I')[0], self.read(at(REVERB_CTX), 'I')[0]
            flag = (1 if hook == at(REVERB_KERNEL) else 0 if hook == 0 else 4) | (2 if ctx else 0)
            header = bytes(cpu.mem_read(ctx, 0xc8)) if ctx else bytes(0xc8)
            self.record(b'Y', struct.pack('<II', result, flag) + header); self.end_group()
        else:
            super().other_op(step, info)

    def callback(self, info):
        if not self.same_heads:
            return super().callback(info)
        calls, self.in_run = self.mixer_calls, True
        pos = self.pos_a
        got = self.ccall(seq.RENDER, self.ring, seq.RING_SIZE, pos, pos, seq.CALLBACK_BYTES, seq.CALLBACK_BYTES)
        self.in_run = False
        info['mixerCalls'] += self.mixer_calls - calls
        if got != seq.CALLBACK_BYTES:
            raise RuntimeError(f'renderer returned {got}')
        a = self.ring_bytes(pos, seq.CALLBACK_BYTES)
        self.pcm_digests.append(hashlib.sha256(a).digest()[:8])
        if self.callbacks < seq.PCM_FULL:
            self.pcm_full.append(a)
        self.pos_a = (self.pos_a + seq.CALLBACK_BYTES) % seq.RING_SIZE
        self.pos_b = (self.pos_b + seq.CALLBACK_BYTES) % seq.RING_SIZE
        self.callbacks += 1


def main():
    root, module_dirs, samples_dir = Path(sys.argv[1]), sys.argv[2].split(','), Path(sys.argv[3])
    cases_file, out = Path(sys.argv[4]), Path(sys.argv[5])
    args = sys.argv[6:]
    cases = json.loads(cases_file.read_text())
    if '--cases' in args:
        wanted = set(args[args.index('--cases') + 1].split(','))
        cases = [c for c in cases if c['name'] in wanted]
    out.mkdir(parents=True, exist_ok=True)
    modules = {}
    for d in module_dirs:
        for p in Path(d).glob('*.it'):
            modules[p.stem] = p.read_bytes()
    oracle = EffectsOracle(root, samples_dir)
    functions = seq.function_instructions(root, FUNCTIONS) + seq.function_instructions(root, seq.MIXER_FUNCTIONS)
    sha = lambda b: hashlib.sha256(b).hexdigest()
    meta = {'galaxy': lo.GALAXY, 'oracle': sha(Path(__file__).read_bytes()),
            'sequencerOracle': sha(Path(seq.__file__).read_bytes()), 'loader': sha(Path(lo.__file__).read_bytes())}
    seq.write_atomic(out / 'oracle.json', json.dumps(meta, indent=1))
    covered = set()
    for case in cases:
        started = time.time()
        name = case['name']
        oracle.window = (0, seq.FULL)
        coverage = seq.Coverage(oracle.cpu, functions)
        info = oracle.run_case(case['program'], modules, False)
        oracle.write_outputs(out, name, info)
        coverage.close()
        covered |= coverage.covered
        info.update(meta)
        info['programSha256'] = sha(json.dumps(case['program'], sort_keys=True).encode())
        info['seconds'] = round(time.time() - started, 2)
        seq.write_atomic(out / f'{name}.dig', b''.join(oracle.digests))
        seq.write_atomic(out / f'{name}.full', b''.join(oracle.full))
        seq.write_atomic(out / f'{name}.json', json.dumps(info))
        print(f"{name}: {info['ticks']} groups, {info['callbacks']} callbacks, {info['seconds']}s", file=sys.stderr, flush=True)
    report = [{'function': fname, 'start': start, 'end': end, 'instructions': [[a, t] for a, t in insns],
               'covered': sorted(a for a, _ in insns if a in covered)} for start, end, fname, insns in functions]
    seq.write_atomic(out / 'coverage.json', json.dumps(report))


if __name__ == '__main__':
    main()
