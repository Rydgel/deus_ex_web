"""Run Galaxy's DirectSound timer callback 0x106142a0 from the hash-pinned GOTY
Galaxy.dll under Unicorn, with the real renderer, mixer and SSE kernel behind
it and a fabricated IDirectSoundBuffer (docs/audio-output-scope.md §2.2, §6
check 1; docs/galaxy-music/mixer.md §1.3).

Optional research tool, never imported by the browser. It extends
scripts/native-galaxy-effects-oracle.py's EffectsOracle (the --real-kernel
library state, the sample entries), so every op of that oracle and of the
sequencer oracle is available. State added per case, as the output open
leaves it on the reference machine:
  [0x10697cc8] = the fabricated secondary buffer (CreateSoundBuffer at 0x10613841);
  the staging ring [0x10697ccc] (glxInit's GlobalAlloc block) silenced for
      nAvgBytesPerSec bytes, as 0x1061384f..0x10613884 does for 16-bit;
  [0x1064a65c] = the case's latency (default 40, the .data value and the
      installed DeusEx.ini Latency) as the open's clamp stores it;
  [0x10698394] = 1, the open's last store (0x10613aca), which the sequencer
      oracle's open tail stops short of.
The heads [0x10697cd4], [0x10697cd8] and the fill [0x10697cdc] are the open
tail's zeros; the callback owns them (no op here pins `ahead`).

The fabricated buffer: an object whose vtable entries +0x10
GetCurrentPosition, +0x2c Lock, +0x30 Play, +0x4c Unlock and +0x50 Restore
are stubs answered here (stdcall, `this` first); every other entry is a stub
that fails the case. Its memory is a 176,400-byte block. GetCurrentPosition
answers the op's (play, write) and its HRESULT; Lock answers the op's next
scripted HRESULT (DS_OK once the script is used up) and, for DS_OK, the split
DirectSound gives a looping buffer (ENTIREBUFFER: the whole buffer; a range
past the end: a second region at the start; offset >= size or bytes > size:
DSERR_INVALIDPARAM): the same host model as native/galaxy-kernel/src/output.rs
`Secondary`, labelled there. Each call is logged as the Rust model logs it.

Ops added:
  {"op":"dsCallback","play":p,"write":w,"positionHr"?:hr,"lock"?:[hr,...],"latency"?:ms}
      the callback 0x106142a0(0, 0, 0, 0, 0); record O = u32 word count, the
      call log words, then A, B, ahead after the callback, R (ebx at
      0x10614657, NULL_REGION when the normal render did not run), then the
      first 16 bytes of SHA-256 of the secondary buffer and of the staging
      ring's first `size` bytes; O closes a digest group. The secondary
      buffer's bytes after each of the first FULL_BUFFERS such callbacks go
      to <case>.secondary.
  {"op":"openFlag","value":0|1}   [0x10698394] (the callback's first gate)

Usage: native-galaxy-output-oracle.py GAME_ROOT MODULE_DIRS SAMPLES_DIR CASES_JSON OUT_DIR [--cases a,b]
Outputs as the effects oracle's, plus <case>.secondary.
"""
import hashlib, importlib.util, json, struct, sys, time
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_EIP, UC_X86_REG_ESP

s = importlib.util.spec_from_file_location('effects', Path(__file__).with_name('native-galaxy-effects-oracle.py'))
fx = importlib.util.module_from_spec(s); s.loader.exec_module(fx)
seq, lo, at, orig = fx.seq, fx.lo, fx.at, fx.orig

CALLBACK, CALLBACK_END = 0x106142a0, 0x10614696
ADVANCE = 0x10614657  # after the copies: R in ebx, the heads not yet advanced
SECONDARY, STAGING, SIZE, HEAD_A, HEAD_B, AHEAD = 0x10697cc8, 0x10697ccc, 0x10697cd0, 0x10697cd4, 0x10697cd8, 0x10697cdc
LATENCY, OPEN, WFX_AVG = 0x1064a65c, 0x10698394, 0x1067b6e0
STAGING_BLOCK = 0x2ee00  # glxInit's GlobalAlloc for [0x10697ccc]
DS_OK, DSERR_INVALIDPARAM = 0, 0x80070057
DSBLOCK_ENTIREBUFFER = 2
NULL_REGION = 0xffffffff
CALL_POSITION, CALL_LOCK, CALL_UNLOCK, CALL_PLAY, CALL_RESTORE = 1, 2, 3, 4, 5
COM_STUBS = 0x700fd000  # inside the base oracle's 0x70000000..0x700fffff hook window
METHODS = {0x10: ('GetCurrentPosition', 3), 0x2c: ('Lock', 8), 0x30: ('Play', 4), 0x4c: ('Unlock', 5), 0x50: ('Restore', 1)}
FULL_BUFFERS = 24
FUNCTIONS = [(CALLBACK, CALLBACK_END, 'DS timer callback 0x106142a0')]


class OutputOracle(fx.EffectsOracle):
    def __init__(self, root, samples_dir):
        self.stubs = {}  # the base classes' setup runs on_instruction before the buffer exists
        super().__init__(root, samples_dir)
        cpu = self.cpu
        self.size = self.read(at(WFX_AVG), 'I')[0]
        self.buffer = self.alloc(self.size)
        self.object = self.alloc(16)
        vtable = self.alloc(0x60)
        for slot in range(0x60 // 4):
            stub = COM_STUBS + 16 * slot
            cpu.mem_write(stub, b'\xcc')
            self.write(vtable + 4 * slot, 'I', stub)
            self.stubs[stub] = METHODS.get(4 * slot, (f'vtable+{4 * slot:#x}', None))
        self.write(self.object, 'I', vtable)
        self.staging = self.read(at(STAGING), 'I')[0]
        cpu.hook_add(UC_HOOK_CODE, self.on_advance, None, at(ADVANCE), at(ADVANCE))

    def case_start(self):
        super().case_start()
        cpu = self.cpu
        self.write(at(SECONDARY), 'I', self.object)
        cpu.mem_write(self.staging, bytes(STAGING_BLOCK))
        cpu.mem_write(self.buffer, bytes(self.size))
        self.write(at(LATENCY), 'I', 40)
        self.write(at(OPEN), 'B', 1)
        self.log, self.render = [], NULL_REGION
        self.cursor, self.position_hr, self.lock_script = (0, 0), DS_OK, []
        self.secondary_full, self.ds_callbacks = [], 0

    # -- the fabricated secondary buffer -------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        method = self.stubs.get(address)
        if method is None:
            return super().on_instruction(cpu, address, size, data)
        name, argc = method
        if argc is None:
            raise RuntimeError(f'the callback called IDirectSoundBuffer {name}')
        sp = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(sp, 'I')[0]
        argv = self.read(sp + 4, f'{argc}I')
        if argv[0] != self.object:
            raise RuntimeError(f'{name} on {argv[0]:#x}, not the secondary buffer')
        result = DS_OK
        if name == 'GetCurrentPosition':
            result = self.position_hr
            play, write = self.cursor
            if argv[1]:
                self.write(argv[1], 'I', play)
            if argv[2]:
                self.write(argv[2], 'I', write)
            self.log += [CALL_POSITION, result, play, write]
        elif name == 'Lock':
            _, offset, nbytes, pp1, pb1, pp2, pb2, flags = argv
            result = self.lock_script.pop(0) if self.lock_script else DS_OK
            p1, b1, p2, b2 = NULL_REGION, 0, NULL_REGION, 0
            if result == DS_OK:
                n = self.size if flags & DSBLOCK_ENTIREBUFFER else nbytes
                if offset >= self.size or n > self.size:
                    result = DSERR_INVALIDPARAM
                elif offset + n <= self.size:
                    p1, b1 = offset, n
                else:
                    p1, b1, p2, b2 = offset, self.size - offset, 0, n - (self.size - offset)
                if result == DS_OK:
                    self.write(pp1, 'I', self.buffer + p1)
                    self.write(pb1, 'I', b1)
                    if pp2:
                        self.write(pp2, 'I', 0 if p2 == NULL_REGION else self.buffer + p2)
                    if pb2:
                        self.write(pb2, 'I', b2)
            self.log += [CALL_LOCK, offset, nbytes, flags, result, p1, b1, p2, b2]
        elif name == 'Unlock':
            _, q1, c1, q2, c2 = argv
            rel = lambda q: NULL_REGION if q == 0 else (q - self.buffer) & 0xffffffff
            self.log += [CALL_UNLOCK, rel(q1), c1, rel(q2), c2]
        elif name == 'Play':
            self.log += [CALL_PLAY, argv[1], argv[2], argv[3]]
        elif name == 'Restore':
            self.log += [CALL_RESTORE]
        cpu.reg_write(UC_X86_REG_EAX, result)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, sp + 4 + 4 * argc)

    def on_advance(self, cpu, address, size, data):
        self.render = cpu.reg_read(UC_X86_REG_EBX)

    # -- ops ------------------------------------------------------------------------
    def other_op(self, step, info):
        cpu, op = self.cpu, step['op']
        if op == 'dsCallback':
            self.cursor = (step['play'] & 0xffffffff, step['write'] & 0xffffffff)
            self.position_hr = step.get('positionHr', DS_OK) & 0xffffffff
            self.lock_script = [h & 0xffffffff for h in step.get('lock', [])]
            if 'latency' in step:
                self.write(at(LATENCY), 'I', step['latency'])
            self.log, self.render = [], NULL_REGION
            calls = self.mixer_calls
            self.ccall(CALLBACK, 0, 0, 0, 0, 0)
            info['mixerCalls'] += self.mixer_calls - calls
            if self.lock_script:
                raise RuntimeError(f'{len(self.lock_script)} scripted Lock results unused')
            a, b, ahead = self.read(at(HEAD_A), 'I')[0], self.read(at(HEAD_B), 'I')[0], self.read(at(AHEAD), 'I')[0]
            size = self.read(at(SIZE), 'I')[0]
            secondary = bytes(cpu.mem_read(self.buffer, self.size))
            staging = bytes(cpu.mem_read(self.staging, size))
            payload = struct.pack(f'<I{len(self.log)}I4I', len(self.log), *self.log, a, b, ahead, self.render)
            payload += hashlib.sha256(secondary).digest()[:16] + hashlib.sha256(staging).digest()[:16]
            self.record(b'O', payload)
            self.end_group()
            if self.ds_callbacks < FULL_BUFFERS:
                self.secondary_full.append(secondary)
            self.ds_callbacks += 1
            info.setdefault('dsCallbacks', 0)
            info['dsCallbacks'] += 1
        elif op == 'openFlag':
            self.write(at(OPEN), 'B', step['value'])
        else:
            super().other_op(step, info)

    def write_outputs(self, out, name, info):
        super().write_outputs(out, name, info)
        seq.write_atomic(out / f'{name}.secondary', b''.join(self.secondary_full))


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
    oracle = OutputOracle(root, samples_dir)
    functions = seq.function_instructions(root, FUNCTIONS) + seq.function_instructions(root, seq.MIXER_FUNCTIONS)
    sha = lambda b: hashlib.sha256(b).hexdigest()
    meta = {'galaxy': lo.GALAXY, 'oracle': sha(Path(__file__).read_bytes()), 'effectsOracle': sha(Path(fx.__file__).read_bytes()),
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
        print(f"{name}: {info['ticks']} groups, {info.get('dsCallbacks', 0)} callbacks, {info['seconds']}s", file=sys.stderr, flush=True)
    report = [{'function': fname, 'start': start, 'end': end, 'instructions': [[a, t] for a, t in insns],
               'covered': sorted(a for a, _ in insns if a in covered)} for start, end, fname, insns in functions]
    seq.write_atomic(out / 'coverage.json', json.dumps(report))


if __name__ == '__main__':
    main()
