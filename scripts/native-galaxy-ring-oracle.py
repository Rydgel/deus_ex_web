"""Run Galaxy's ring voices from the hash-pinned GOTY Galaxy.dll under
Unicorn: glxStartSample's ring branch (0x106124e9..0x1061258f), the mixer's
refill posts (0x106151bb..0x1061520c), the stream decoder thread's body
0x1060e340 and glxStopSample's ring free (0x10618503), with the real timer
callback, renderer, mixer and SSE kernel (docs/audio-output-scope.md §6 check
5; native/galaxy-kernel/src/ring.rs).

Optional research tool, never imported by the browser. It extends
scripts/native-galaxy-output-oracle.py's OutputOracle, so every op of that
oracle, of the effects oracle and of the sequencer oracle is available.
Added, as ring.rs models them (labelled there):
  - the record of a host-decoded speech sound (the stand-in of the MPEG
    loader 0x10620b30's record, effects.rs `host_sample`): type 0x4024 or
    0x4044, the PCM as the source, at the effect heap's next 0x48 bytes, the
    PCM at the host pool (HOST_POOL, the Rust kernel's rule);
  - the MPEG decoder 0x1061a690 replaced by ring.rs's leaf (a code hook at
    its entry: mono, min(Chunk, Remaining) bytes to Dest1; stereo, min(Chunk
    / 2, Remaining / 4) frames, left to Dest1 and right to Dest2);
  - malloc(0x1001f) (the ring) answered with RING_POOL + slot·RING_STRIDE for
    the voice in ESI, zero-filled; free() of a ring accepted;
  - PostThreadMessageA queues the message as well as recording it (P); after
    every dsCallback each queued message is handled in post order by running
    the thread body 0x1060e340 once: its GetMessageA answers the message, then
    WM_QUIT (0), so the body returns after the one message. The handler
    keeps no state across messages outside the voice records.
Ops added:
  {"op":"hostRingSample","name":n,"rate":r,"channels":1|2,"pcm":hex}  the record
      and its PCM; record H = u32 address + the 0x48-byte record; closes a group.
      startSample's "sample" may name it.
  {"op":"deliver"}  handle the queued messages now (dsCallback does it itself).
The end state E has the voices' Link at the preferred base.
Per handled message, record D = u32 wParam, u32 lParam, voices [0, 32) (Link
at the preferred base), then for every live ring in slot order: u32 slot and
the first 16 bytes of SHA-256 of its 0x1001f bytes. D closes a group.

Usage: native-galaxy-ring-oracle.py GAME_ROOT MODULE_DIRS SAMPLES_DIR CASES_JSON OUT_DIR [--cases a,b]
"""
import hashlib, importlib.util, json, struct, sys, time
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ESI, UC_X86_REG_EIP, UC_X86_REG_ESP

s = importlib.util.spec_from_file_location('output', Path(__file__).with_name('native-galaxy-output-oracle.py'))
out_ = importlib.util.module_from_spec(s); s.loader.exec_module(out_)
fx, seq, lo, at, orig = out_.fx, out_.seq, out_.lo, out_.at, out_.orig

THREAD, THREAD_END = 0x1060e340, 0x1060e83e
MPEG_DECODER = 0x1061a690
RING_POOL, RING_STRIDE, RING_ALLOC = 0x68000000, 0x10020, 0x1001f
HOST_POOL, HOST_POOL_SIZE = 0x80000000, 0x01000000
VOICES, VOICE = seq.VOICES, seq.VOICE
SAMP = 0x504d4153
FUNCTIONS = [(0x10612310, 0x106126e7, 'glxStartSample 0x10612310'), (0x10618410, 0x1061858b, 'glxStopSample 0x10618410'),
             (0x1060d280, 0x1060d366, 'glxControlSample 0x1060d280'),
             (THREAD, THREAD_END, 'decoder thread 0x1060e340'), (0x10614920, 0x1061565c, 'mixer 0x10614920'),
             (out_.CALLBACK, out_.CALLBACK_END, 'DS timer callback 0x106142a0')]


class RingOracle(out_.OutputOracle):
    def __init__(self, root, samples_dir):
        self.queue, self.rings, self.message, self.leaf_calls = [], {}, None, 0
        super().__init__(root, samples_dir)
        cpu = self.cpu
        cpu.mem_map(RING_POOL, 256 * RING_STRIDE + 0x1000)
        cpu.mem_map(HOST_POOL, HOST_POOL_SIZE)
        cpu.hook_add(UC_HOOK_CODE, self.on_decoder, None, at(MPEG_DECODER), at(MPEG_DECODER))

    def case_start(self):
        super().case_start()
        for slot in list(self.rings):
            self.cpu.mem_write(RING_POOL + slot * RING_STRIDE, bytes(RING_ALLOC))
        self.queue, self.rings, self.message = [], {}, None
        self.host_top, self.leaf_calls = HOST_POOL, 0

    # -- leaves -----------------------------------------------------------------------
    def on_instruction(self, cpu, address, size, data):
        symbol = self.symbols.get(address)
        if symbol in ('malloc', 'free', 'GetMessageA', 'PostThreadMessageA'):
            sp = cpu.reg_read(UC_X86_REG_ESP)
            ret = self.read(sp, 'I')[0]
            if symbol == 'malloc' and self.read(sp + 4, 'I')[0] == RING_ALLOC:
                slot = (orig(cpu.reg_read(UC_X86_REG_ESI)) - VOICES) // VOICE
                ptr = RING_POOL + slot * RING_STRIDE
                if slot in self.rings:
                    raise RuntimeError(f'a second ring for voice slot {slot}')
                cpu.mem_write(ptr, bytes(RING_ALLOC))
                self.rings[slot] = ptr
                cpu.reg_write(UC_X86_REG_EAX, ptr); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 4)
                return
            if symbol == 'free':
                ptr = self.read(sp + 4, 'I')[0]
                if RING_POOL <= ptr < RING_POOL + 256 * RING_STRIDE:
                    slot = (ptr - RING_POOL) // RING_STRIDE
                    if self.rings.get(slot) != ptr:
                        raise RuntimeError(f'free of {ptr:#x}, not a live ring')
                    del self.rings[slot]
                    cpu.reg_write(UC_X86_REG_EAX, 0); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 4)
                    return
            if symbol == 'GetMessageA':
                msg = self.read(sp + 4, 'I')[0]
                result = 0
                if self.message is not None:
                    wparam, lparam = self.message
                    self.write(msg, '7I', 0, 0x400, wparam, lparam, 0, 0, 0)
                    self.message, result = None, 1
                cpu.reg_write(UC_X86_REG_EAX, result); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 20)
                return
            if symbol == 'PostThreadMessageA':
                _, message, wparam, lparam = self.read(sp + 4, '4I')
                if message != 0x400:
                    raise RuntimeError(f'PostThreadMessageA {message:#x}')
                self.queue.append((wparam, lparam))
        return super().on_instruction(cpu, address, size, data)

    def on_decoder(self, cpu, address, size, data):
        """ring.rs `decode_leaf` in place of 0x1061a690 (cdecl, 8 arguments)."""
        sp = cpu.reg_read(UC_X86_REG_ESP)
        ret, rec, src, remaining, dst1, dst2, chunk, p_consumed, p_produced = self.read(sp, '9I')
        remaining = max(0, struct.unpack('<i', struct.pack('<I', remaining))[0])
        chunk = max(0, struct.unpack('<i', struct.pack('<I', chunk))[0])
        stereo = self.read(rec + 0x2c, 'H')[0] & 0x40
        if stereo:
            frames = min(chunk // 2, remaining // 4)
            consumed, produced = 4 * frames, 2 * frames
        else:
            consumed = produced = min(chunk, remaining) & ~1
        if produced:
            source = bytes(cpu.mem_read(src, consumed))
            if not stereo:
                cpu.mem_write(dst1, source)
            else:
                for dst, lane in ((dst1, 0), (dst2, 2)):
                    if dst:
                        cpu.mem_write(dst, b''.join(source[4 * f + lane:4 * f + lane + 2] for f in range(frames)))
        self.write(p_consumed, 'I', consumed)
        self.write(p_produced, 'I', produced)
        self.leaf_calls += 1
        cpu.reg_write(UC_X86_REG_EAX, 0); cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 4)

    def end_state(self):
        # The voices' Link (+0x9c) at the preferred base, as voices_record gives
        # it (a stereo pair's first voice keeps its Link to the end).
        out = bytearray(super().end_state())
        for v in range(256):
            link = struct.unpack_from('<I', out, v * VOICE + 0x9c)[0]
            if at(VOICES) <= link < at(VOICES) + 256 * VOICE:
                struct.pack_into('<I', out, v * VOICE + 0x9c, orig(link))
        return bytes(out)

    # -- delivery -----------------------------------------------------------------------
    def deliver(self, info):
        while self.queue:
            wparam, lparam = self.queue.pop(0)
            self.message = (wparam, lparam)
            if self.ccall(THREAD, 0) != 0:
                raise RuntimeError('the decoder thread body returned nonzero')
            if self.message is not None:
                raise RuntimeError('the decoder thread did not take its message')
            payload = struct.pack('<II', wparam, lparam) + self.voices_record(0)[4:]
            for slot in sorted(self.rings):
                payload += struct.pack('<I', slot) + hashlib.sha256(bytes(self.cpu.mem_read(self.rings[slot], RING_ALLOC))).digest()[:16]
            self.record(b'D', payload)
            self.end_group()
            info['messages'] = info.get('messages', 0) + 1

    def other_op(self, step, info):
        op = step['op']
        if op == 'hostRingSample':
            stereo = step['channels'] == 2
            pcm = bytes.fromhex(step['pcm'])
            addr = self.effect_heap._new(0x48)
            record = bytearray(0x48)
            struct.pack_into('<II', record, 0, SAMP, 0x40)
            struct.pack_into('<HHH', record, 0x28, 0x4000, 0x7fff, 0x4044 if stereo else 0x4024)
            struct.pack_into('<III', record, 0x30, len(pcm), 0, 0)
            struct.pack_into('<I', record, 0x3c, step['rate'])
            data = self.host_top
            size = (len(pcm) // 2) * 2 + 0x1f
            self.cpu.mem_write(data, pcm + bytes(0x1f))
            self.host_top = data + ((size + 15) & ~15)
            struct.pack_into('<I', record, 0x44, data)
            self.cpu.mem_write(addr, bytes(record))
            self.sample_addr[step['name']] = addr
            self.record(b'H', struct.pack('<I', addr) + bytes(record))
            self.end_group()
        elif op == 'deliver':
            self.deliver(info)
        elif op == 'dsCallback':
            super().other_op(step, info)
            self.deliver(info)
        else:
            super().other_op(step, info)


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
    oracle = RingOracle(root, samples_dir)
    functions = seq.function_instructions(root, FUNCTIONS)
    sha = lambda b: hashlib.sha256(b).hexdigest()
    meta = {'galaxy': lo.GALAXY, 'oracle': sha(Path(__file__).read_bytes()), 'outputOracle': sha(Path(out_.__file__).read_bytes())}
    seq.write_atomic(out / 'oracle.json', json.dumps(meta, indent=1))
    covered = set()
    for case in cases:
        started = time.time()
        name = case['name']
        oracle.window = (0, 1 << 30) if '--full-all' in args else (0, seq.FULL)
        coverage = seq.Coverage(oracle.cpu, functions)
        info = oracle.run_case(case['program'], modules, False)
        oracle.write_outputs(out, name, info)
        coverage.close()
        covered |= coverage.covered
        info.update(meta)
        info['leafCalls'] = oracle.leaf_calls
        info['seconds'] = round(time.time() - started, 2)
        seq.write_atomic(out / f'{name}.dig', b''.join(oracle.digests))
        seq.write_atomic(out / f'{name}.full', b''.join(oracle.full))
        seq.write_atomic(out / f'{name}.json', json.dumps(info))
        print(f"{name}: {info['ticks']} groups, {info.get('dsCallbacks', 0)} callbacks, {info.get('messages', 0)} messages, "
              f"{oracle.leaf_calls} decoder calls{', fault ' + info['fault']['kind'] if info['fault'] else ''}, {info['seconds']}s", file=sys.stderr, flush=True)
    report = [{'function': fname, 'start': start, 'end': end, 'instructions': [[a, t] for a, t in insns],
               'covered': sorted(a for a, _ in insns if a in covered)} for start, end, fname, insns in functions]
    seq.write_atomic(out / 'coverage.json', json.dumps(report))


if __name__ == '__main__':
    main()
