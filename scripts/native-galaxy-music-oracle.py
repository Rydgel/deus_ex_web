"""Run Galaxy's real glxLoadMusic (0x10618be0) on Deus Ex music modules and
dump everything the player reads (docs/galaxy-music.md, docs/galaxy-music/it-loader.md).

Optional research tool, never imported by the browser. The hash-pinned GOTY
Galaxy.dll is mapped rebased (0x13000000) through native-collision-oracle.py.

State before a load: the library state section of glxInit executes for real
(0x1060dfff..0x1060e1b4: voices, instrument/pattern tables, orders, initial
pan, song scalars), then the subsystem Init's 0x1060ebc0(EffectsChannels=16).
glxLoadMusic is called exactly as Update calls it (0x1060a73b..0x1060a77e):
glxMemory{'MEMO', 0xc, Data, Length = module size + 1024, 0} and Flags 2
(GLX_LOADFROMMEMORY). The 1024 bytes after the module are the caller's
FArray::Add(0x400) slack, uninitialised in the original; here they are a fill
pattern, every read of them is counted, and pass 2 changes the fill.

Only true leaves are stubbed: KERNEL32 Enter/LeaveCriticalSection (no
effect, single thread) and MSVCRT malloc/realloc/free/memcpy/memset/memcmp.
The allocator is a bump heap with a size table; realloc copies min(old, new)
bytes; new blocks are filled with the pass's fill byte. Every call is logged.
Any other import raises.

Passes (each song loaded from the same post-init snapshot unless chained):
  1. fresh, fill 0x00, slack zeros, block coverage of the loader functions;
  2. fresh, fill 0xa5, slack pseudo-random: the dump must equal pass 1's,
     which shows the result does not depend on uninitialised heap or slack;
  3. chain: songs in order, each after the real glxUnloadMusic (0x10619450)
     of the previous one, so stale state (orders tail, loader statics) carries.

Usage: native-galaxy-music-oracle.py GAME_ROOT MODULE_DIR OUT_DIR [--songs A,B] [--no-chain] [--no-fill-check]
MODULE_DIR holds <Song>.it files (the Music export's Data bytes). OUT_DIR
receives <Song>.glxd (pass 1), chain/<Song>.glxd, summary.json, coverage.json.
The .glxd format is documented in src/runtime/galaxy-music-loader.mjs.
"""
import hashlib, importlib.util, json, struct, sys
from pathlib import Path
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from unicorn import UC_HOOK_CODE, UC_HOOK_BLOCK, UC_HOOK_MEM_READ
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

s = importlib.util.spec_from_file_location('n', Path(__file__).with_name('native-collision-oracle.py'))
n = importlib.util.module_from_spec(s); s.loader.exec_module(n)

GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353'
G = 0x13000000
at = lambda address: G + (address - 0x10600000)
orig = lambda address: address - G + 0x10600000

LOAD, UNLOAD, SET_SAMPLE_CHANNELS = 0x10618be0, 0x10619450, 0x1060ebc0
INIT_START, INIT_END = 0x1060dfff, 0x1060e1b4
SEEK, READ, TELL = 0x10618aa0, 0x10618b10, 0x10618bd0
DATA_SECTION, DATA_SIZE = 0x10648000, 0x50400
EFFECTS_CHANNELS = 16
HEAP, HEAP_SIZE = 0x40000000, 0x08000000
STREAM, STREAM_SIZE = 0x30000000, 0x00400000
SLACK = 0x400
NULL_MARK = 0xffffffff  # canonical value of a non-null pointer field in the dump

# (VA, size, name): song scalars written by the reset 0x1060e850 or the IT loader.
SCALARS = [
    (0x10698348, 1, 'channels'), (0x10698349, 1, 'playing'), (0x1069834a, 1, 'songLength'),
    (0x10697cf0, 1, 'musicMaster'), (0x10697cea, 2, 'initialSpeed'), (0x1069817e, 2, 'initialTempo'),
    (0x10697ce8, 1, 'playerMode'), (0x106886a6, 2, 'minPeriod'), (0x10698180, 2, 'maxPeriod'),
    (0x10698208, 4, 'reset10698208'), (0x10697ce6, 2, 'reset10697ce6'), (0x10698141, 1, 'reset10698141'),
    (0x10697ca8, 1, 'reset10697ca8'), (0x10698188, 2, 'tempo'), (0x10698342, 2, 'speed'),
    (0x10698201, 1, 'orderPosition'), (0x10698140, 1, 'reset10698140'), (0x10698200, 1, 'reset10698200'),
    (0x1068828d, 1, 'firstMusicVoice'),
]
REGIONS = [(b'NAME', 0x106981e0, 0x20), (b'ORDR', 0x10698220, 0x100), (b'PANS', 0x106886c0, 0x100),
           (b'SCRT', 0x106841a8, 0xc80), (b'VOIC', 0x1068dca0, 0x100 * 0xa0)]
INSTRUMENTS, PATTERNS = 0x106882a0, 0x10697d40

# Loader functions for instruction coverage: (start, end exclusive, name).
FUNCTIONS = [
    (0x10618be0, 0x10618e5a, 'glxLoadMusic dispatcher'),
    (0x1060e850, 0x1060e977, 'reset 0x1060e850'),
    (0x10628990, 0x1062a385, 'IT loader'),
    (0x1062fb10, 0x1062fe1f, 'sample loader'),
    (0x10618aa0, 0x10618b06, 'memory seek'),
    (0x10618b10, 0x10618b62, 'memory read'),
    (0x10618bd0, 0x10618bd8, 'memory tell'),
    (0x10618930, 0x1061893e, 'malloc wrapper'),
    (0x10618940, 0x10618953, 'realloc wrapper'),
    (0x10618960, 0x1061896c, 'free wrapper'),
    (0x10619450, 0x106194f4, 'glxUnloadMusic'),
    (0x106195b0, 0x10619676, 'unload instrument'),
]


class Heap:
    def __init__(self, cpu):
        self.cpu = cpu
        self.reset(0)

    def reset(self, fill):
        """Fresh library (the .data snapshot is restored with it): discard every block."""
        self.log, self.blocks = [], {}
        self.reset_bump(fill)

    def reset_bump(self, fill):
        if self.blocks:
            raise RuntimeError(f'{len(self.blocks)} heap blocks still live')
        self.top, self.blocks, self.fill = HEAP, {}, fill
        self.live = self.peak = 0

    def _new(self, size):
        ptr = self.top
        self.top += max(16, (size + 15) & ~15)
        if self.top > HEAP + HEAP_SIZE:
            raise MemoryError('oracle heap exhausted')
        if size:
            self.cpu.mem_write(ptr, bytes([self.fill]) * size)
        self.blocks[ptr] = size
        self.live += size; self.peak = max(self.peak, self.live)
        return ptr

    def malloc(self, size):
        self.log.append((1, size))
        return self._new(size)

    def realloc(self, ptr, size):
        self.log.append((2, size))
        if not ptr:
            return self._new(size)
        old = self.blocks.pop(ptr)
        self.live -= old
        new = self._new(size)
        keep = min(old, size)
        if keep:
            self.cpu.mem_write(new, bytes(self.cpu.mem_read(ptr, keep)))
        return new

    def free(self, ptr):
        if not ptr:
            self.log.append((3, 0)); return
        size = self.blocks.pop(ptr)
        self.live -= size
        self.log.append((3, size))


class Oracle(n.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Galaxy.dll': {'hash': GALAXY, 'base': G}})
        cpu = self.cpu
        cpu.hook_del(self.code_hook)
        cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, 0x70000000, 0x700fffff)
        for address, op in ((SEEK, 1), (READ, 2), (TELL, 3)):
            cpu.hook_add(UC_HOOK_CODE, self.on_stream, op, at(address), at(address))
        cpu.mem_map(HEAP, HEAP_SIZE)
        cpu.mem_map(STREAM, STREAM_SIZE)
        self.heap = Heap(cpu)
        self.mem = self.alloc(0x20)
        self.symbols = {address: symbol for address, (dll, symbol) in self.thunks.items()}
        self.coverage, self.block_hook = set(), None
        self.stream_log, self.pattern = [], None
        # glxInit's state section, then the subsystem's EffectsChannels call.
        cpu.reg_write(UC_X86_REG_EBX, 0); cpu.reg_write(UC_X86_REG_ESP, self.stack)
        cpu.emu_start(at(INIT_START), at(INIT_END))
        if cpu.reg_read(UC_X86_REG_EIP) != at(INIT_END):
            raise RuntimeError('glxInit state section did not reach its end')
        if self.ccall(SET_SAMPLE_CHANNELS, EFFECTS_CHANNELS) != 1:
            raise RuntimeError('0x1060ebc0 refused the effects channel count')
        self.snapshot = bytes(cpu.mem_read(at(DATA_SECTION), DATA_SIZE))

    # -- execution ---------------------------------------------------------
    def ccall(self, address, *args):
        cpu = self.cpu
        cpu.reg_write(UC_X86_REG_ESP, self.stack)
        self.write(self.stack, f'{1 + len(args)}I', self.done, *[a & 0xffffffff for a in args])
        cpu.emu_start(at(address), self.done + 1, count=0)
        if cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError(f'{address:#x} did not return; trace {list(self.trace)}')
        return cpu.reg_read(UC_X86_REG_EAX)

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop(); return
        symbol = self.symbols.get(address)
        if symbol is None:
            return
        sp = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(sp, 'I')[0]
        if symbol in ('EnterCriticalSection', 'LeaveCriticalSection'):  # stdcall, one argument
            cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 8); return
        a, b, c = self.read(sp + 4, '3I')
        if symbol == 'malloc':
            result = self.heap.malloc(a)
        elif symbol == 'realloc':
            result = self.heap.realloc(a, b)
        elif symbol == 'free':
            self.heap.free(a); result = 0
        elif symbol == 'memcpy':
            self.check_slack(b, c)
            if c: cpu.mem_write(a, bytes(cpu.mem_read(b, c)))
            result = a
        elif symbol == 'memset':
            if c: cpu.mem_write(a, bytes([b & 0xff]) * c)
            result = a
        elif symbol == 'memcmp':
            x, y = bytes(cpu.mem_read(a, c)), bytes(cpu.mem_read(b, c))
            result = 0 if x == y else (-1 if x < y else 1)
        else:
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        cpu.reg_write(UC_X86_REG_EAX, result & 0xffffffff)
        cpu.reg_write(UC_X86_REG_EIP, ret); cpu.reg_write(UC_X86_REG_ESP, sp + 4)

    def on_stream(self, cpu, address, size, op):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        if op == 2:
            dst, sz, count, handle = self.read(sp + 4, '4I')
            pos, length = self.read(handle + 0x10, 'I')[0], self.read(handle + 0xc, 'I')[0]
            self.stream_log.append((2, sz, count, pos))
            requested = (sz * count) & 0xffffffff
            if requested > length - pos:
                self.run_info['shortReads'] += 1
            got = requested if requested <= length - pos else ((length - pos) // sz) * sz
            self.run_info['streamEnd'] = max(self.run_info['streamEnd'], pos + got)
            self.track_pattern_read(dst, got)
        elif op == 1:
            handle, offset, whence = self.read(sp + 4, '3I')
            self.stream_log.append((1, offset, whence, self.read(handle + 0x10, 'I')[0]))
        else:
            handle = self.read(sp + 4, 'I')[0]
            self.stream_log.append((3, 0, 0, self.read(handle + 0x10, 'I')[0]))

    # The packed-pattern scratch buffer is the 4th malloc of the IT loader
    # (0xc0, 0x226, 0x50, 0xe008): its address is fixed by the bump heap.
    def track_pattern_read(self, dst, got):
        if self.pattern is None or not (self.pattern <= dst < self.pattern + 0xe008):
            return
        if dst == self.pattern:  # 8-byte pattern header: a new pattern starts
            self.finish_pattern()
            self.pattern_state = {'packedEnd': None, 'maxRead': -1}
        elif dst == self.pattern + 8 and self.pattern_state is not None:
            self.pattern_state['packedEnd'] = 8 + got

    def finish_pattern(self):
        state = getattr(self, 'pattern_state', None)
        if state and state['packedEnd'] is not None:
            self.run_info['patterns'] += 1
            if state['maxRead'] >= state['packedEnd']:
                self.run_info['patternOverreads'].append(state['maxRead'] - state['packedEnd'] + 1)
        self.pattern_state = None

    def on_pattern_read(self, cpu, access, address, size, value, data):
        if self.pattern_state is not None:
            self.pattern_state['maxRead'] = max(self.pattern_state['maxRead'], address + size - 1 - self.pattern)

    def check_slack(self, address, size):
        lo, hi = self.slack, self.slack + SLACK
        if address < hi and address + size > lo:
            self.run_info['slackReads'] += 1

    def on_slack_read(self, cpu, access, address, size, value, data):
        self.run_info['slackReads'] += 1

    def on_block(self, cpu, address, size, data):
        self.coverage.add((address, size))

    # -- one load ------------------------------------------------------------
    def load(self, module, fill, slack_fill, coverage, restore):
        cpu = self.cpu
        if restore:
            cpu.mem_write(at(DATA_SECTION), self.snapshot)
            self.heap.reset(fill)
        else:  # chained: the log already holds the preceding unload's frees
            self.heap.reset_bump(fill)
        length = len(module) + SLACK
        cpu.mem_write(STREAM, bytes(module) + slack_fill)
        self.slack = STREAM + len(module)
        self.write(self.mem, '5I', 0x4f4d454d, 0xc, STREAM, length, 0)
        self.stream_log = []
        self.run_info = {'shortReads': 0, 'streamEnd': 0, 'slackReads': 0, 'patterns': 0, 'patternOverreads': []}
        self.pattern = HEAP + 0xc0 + 0x230 + 0x50
        self.pattern_state = None
        hooks = [cpu.hook_add(UC_HOOK_MEM_READ, self.on_slack_read, None, self.slack, self.slack + SLACK - 1),
                 cpu.hook_add(UC_HOOK_MEM_READ, self.on_pattern_read, None, self.pattern, self.pattern + 0xe008 - 1)]
        if coverage:
            hooks.append(cpu.hook_add(UC_HOOK_BLOCK, self.on_block, None, G, G + 0xa0000))
        try:
            status = self.ccall(LOAD, self.mem, 2)
        finally:
            for hook in hooks: cpu.hook_del(hook)
        self.finish_pattern()
        return status, self.dump(status, module), dict(self.run_info, moduleLength=len(module), streamLength=length)

    def unload(self, coverage):
        hook = self.cpu.hook_add(UC_HOOK_BLOCK, self.on_block, None, G, G + 0xa0000) if coverage else None
        try:
            result = self.ccall(UNLOAD)
        finally:
            if hook is not None: self.cpu.hook_del(hook)
        return result

    # -- dump ----------------------------------------------------------------
    def dump(self, status, module):
        cpu = self.cpu
        out = [b'GLXD', struct.pack('<I', 1)]
        def section(tag, payload):
            out.append(tag + struct.pack('<I', len(payload)) + payload)
        section(b'STAT', struct.pack('<I', status))
        section(b'SCAL', b''.join(bytes(cpu.mem_read(at(va), size)) for va, size, _ in SCALARS))
        for tag, va, size in REGIONS:
            section(tag, bytes(cpu.mem_read(at(va), size)))
        for slot in range(256):
            ptr = self.read(at(INSTRUMENTS) + 4 * slot, 'I')[0]
            if not ptr:
                continue
            size = self.heap.blocks[ptr]
            raw = bytearray(cpu.mem_read(ptr, size))
            samples = struct.unpack_from('<H', raw, 0x148)[0]
            data = []
            for k in range(samples):
                field = 0x14a + 0x48 * k + 0x44
                if field + 4 > size:
                    break
                pointer = struct.unpack_from('<I', raw, field)[0]
                if pointer:
                    struct.pack_into('<I', raw, field, NULL_MARK)
                    data.append((k, pointer))
            section(b'INST', struct.pack('<HI', slot, size) + bytes(raw))
            for k, pointer in data:
                dsize = self.heap.blocks[pointer]
                section(b'SDAT', struct.pack('<HHI', slot, k, dsize) + bytes(cpu.mem_read(pointer, dsize)))
        for p in range(256):
            ptr = self.read(at(PATTERNS) + 4 * p, 'I')[0]
            if not ptr:
                continue
            header = bytearray(cpu.mem_read(ptr, 0x28))
            tracks = struct.unpack_from('<I', header, 8)[0]
            if tracks != 1:
                raise RuntimeError(f'pattern {p}: {tracks} tracks')
            events = struct.unpack_from('<I', header, 0x24)[0]
            payload = b''
            if events:
                struct.pack_into('<I', header, 0x24, NULL_MARK)
                esize = self.heap.blocks[events]
                payload = bytes(cpu.mem_read(events, esize))
            section(b'PATT', struct.pack('<H', p) + bytes(header) + struct.pack('<I', len(payload)) + payload)
        section(b'ALOG', b''.join(struct.pack('<BI', op, size) for op, size in self.heap.log))
        section(b'SLOG', b''.join(struct.pack('<B3I', *entry) for entry in self.stream_log))
        return b''.join(out)


def scalars_of(dump):
    """Named scalars from a dump's SCAL section."""
    offset = 8
    while offset < len(dump):
        tag, size = dump[offset:offset + 4], struct.unpack_from('<I', dump, offset + 4)[0]
        if tag == b'SCAL':
            values, at_ = {}, offset + 8
            for va, width, name in SCALARS:
                values[name] = int.from_bytes(dump[at_:at_ + width], 'little'); at_ += width
            return values
        offset += 8 + size


def sections(dump):
    offset, out = 8, []
    while offset < len(dump):
        tag, size = dump[offset:offset + 4], struct.unpack_from('<I', dump, offset + 4)[0]
        out.append((tag, dump[offset + 8:offset + 8 + size]))
        offset += 8 + size
    return out


def uninitialised(a, b):
    """Byte ranges that differ between two fills: bytes the original never
    writes (its heap is uninitialised there). Reported per section record as
    [tag, record header fields, [[start, end), ...]] over the record payload."""
    if len(a) != len(b):
        raise RuntimeError('fill passes produced different dump layouts')
    out = []
    for (tag, x), (_, y) in zip(sections(a), sections(b)):
        if x == y:
            continue
        ranges, start = [], None
        for i in range(len(x) + 1):
            differs = i < len(x) and x[i] != y[i]
            if differs and start is None: start = i
            if not differs and start is not None: ranges.append([start, i]); start = None
        key = list(struct.unpack_from('<HH', x)) if tag == b'SDAT' else list(struct.unpack_from('<H', x)) if tag in (b'INST', b'PATT') else []
        out.append([tag.decode(), key, ranges])
    return out


def summarize(dump, info):
    values = scalars_of(dump)
    secs = sections(dump)
    orders = next(p for t, p in secs if t == b'ORDR')
    present = {struct.unpack_from('<H', p, 0)[0] for t, p in secs if t == b'PATT'}
    nulls = [[o, orders[o]] for o in range(values['songLength'] + 1) if orders[o] < 0xfe and orders[o] not in present]
    inst = [p for t, p in secs if t == b'INST']
    sdat = [p for t, p in secs if t == b'SDAT']
    patt = [p for t, p in secs if t == b'PATT']
    alog = next(p for t, p in secs if t == b'ALOG')
    return dict(info, status=struct.unpack_from('<I', next(p for t, p in secs if t == b'STAT'))[0], **{k: values[k] for k in
                ('channels', 'songLength', 'musicMaster', 'initialSpeed', 'initialTempo', 'playerMode', 'minPeriod', 'maxPeriod')},
                songName=next(p for t, p in secs if t == b'NAME')[:26].split(b'\0')[0].decode('latin1'),
                instruments=len(inst), samplesWithData=len(sdat), sampleBytes=sum(len(p) - 8 for p in sdat),
                patterns=len(patt), eventBytes=sum(len(p) - 0x2e for p in patt), nullPatternOrders=nulls,
                allocations=len(alog) // 5, dumpBytes=len(dump), dumpSha256=hashlib.sha256(dump).hexdigest())


def coverage_report(blocks):
    """Per loader function: every non-nop instruction (address, text) and the
    addresses the executed blocks covered (the validator unions runs)."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    image = n.Image(Path(sys.argv[1]) / 'System' / 'Galaxy.dll', GALAXY)
    starts = sorted(blocks)
    report = []
    for start, end, name in FUNCTIONS:
        code = image.data[image.offset(start - image.base):image.offset(end - image.base)]
        insns = [(i.address, f'{i.mnemonic} {i.op_str}'.strip()) for i in md.disasm(code, start)]
        insns = [(a, t) for a, t in insns if t != 'nop']
        covered = set()
        for address, size in starts:
            lo, hi = orig(address), orig(address) + size
            if hi <= start or lo >= end:
                continue
            covered.update(a for a, _ in insns if lo <= a < hi)
        report.append({'function': name, 'start': start, 'end': end,
                       'instructions': [[a, t] for a, t in insns], 'covered': sorted(covered)})
    return report


def main():
    root, modules, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    args = sys.argv[4:]
    songs = sorted(p.stem for p in modules.glob('*.it'))
    if '--songs' in args:
        wanted = args[args.index('--songs') + 1].split(',')
        songs = [s for s in songs if s in wanted]
    out.mkdir(parents=True, exist_ok=True); (out / 'chain').mkdir(exist_ok=True)
    oracle = Oracle(root)
    summary = {'galaxy': GALAXY, 'oracle': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'effectsChannels': EFFECTS_CHANNELS, 'songs': {}, 'fillCheck': {}, 'chain': {}}
    for song in songs:
        module = (modules / f'{song}.it').read_bytes()
        status, dump, info = oracle.load(module, 0x00, bytes(SLACK), coverage=True, restore=True)
        (out / f'{song}.glxd').write_bytes(dump)
        summary['songs'][song] = summarize(dump, info) | {'moduleSha256': hashlib.sha256(module).hexdigest()}
        print(f'{song}: status {status}, {len(dump)} dump bytes, {info["patterns"]} patterns read, '
              f'stream end {info["streamEnd"]}/{len(module)}, slack reads {info["slackReads"]}', file=sys.stderr)
        if '--no-fill-check' not in args:
            noise = bytes((i * 167 + 13) & 0xff for i in range(SLACK))
            _, other, info2 = oracle.load(module, 0xa5, noise, coverage=False, restore=True)
            summary['fillCheck'][song] = {'identical': other == dump, 'slackReads': info2['slackReads'],
                                          'uninitialised': uninitialised(dump, other)}
    if '--no-chain' not in args:
        oracle.cpu.mem_write(at(DATA_SECTION), oracle.snapshot)
        oracle.heap.reset(0)
        for i, song in enumerate(songs):
            module = (modules / f'{song}.it').read_bytes()
            oracle.heap.log = []
            if i:
                result = oracle.unload(coverage=True)
                if result != 0 or oracle.heap.blocks:
                    raise RuntimeError(f'unload before {song}: result {result}, {len(oracle.heap.blocks)} blocks live')
            status, dump, info = oracle.load(module, 0x00, bytes(SLACK), coverage=True, restore=False)
            (out / 'chain' / f'{song}.glxd').write_bytes(dump)
            fresh = (out / f'{song}.glxd').read_bytes()
            summary['chain'][song] = {'status': status, 'dumpSha256': hashlib.sha256(dump).hexdigest(),
                                      'differsFromFresh': sorted({t.decode() for (t, a), (_, b) in
                                                                  zip(sections(dump), sections(fresh)) if a != b})}
        result = oracle.unload(coverage=True)
        summary['chainFinalUnload'] = {'result': result, 'liveBlocks': len(oracle.heap.blocks)}
    coverage = coverage_report(oracle.coverage)
    (out / 'coverage.json').write_text(json.dumps(coverage))
    (out / 'summary.json').write_text(json.dumps(summary, indent=1))
    total = sum(len(f['instructions']) for f in coverage); hit = sum(len(f['covered']) for f in coverage)
    print(json.dumps({'songs': len(songs), 'instructions': total, 'covered': hit}))


if __name__ == '__main__':
    main()
