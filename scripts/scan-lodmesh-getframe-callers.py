"""Every reached caller of ULodMesh::GetFrame in the installed game DLLs (docs/script-lodmesh-frame.md "The first GetFrame is the
first draw's"): direct call/jmp sites (E8/E9 rel32) of Engine.dll's export thunk 0x103013bb and body 0x10355360 inside Engine.dll,
the DLLs that import GetFrame by its decorated name, and in Render.dll every instruction through its IAT slot (FF 15 / FF 25) with
the calls, jumps and stored dwords that reach an import thunk of it.

    python3 -I scripts/scan-lodmesh-getframe-callers.py ["Deus Ex GOTY Edition/System"]
"""
import glob, os, struct, sys

ENGINE_THUNK, ENGINE_BODY = 0x103013BB, 0x10355360
NAME = b'?GetFrame@ULodMesh@@'


def sections(data):
    pe = struct.unpack_from('<I', data, 0x3C)[0]
    count, optional = struct.unpack_from('<H', data, pe + 6)[0], struct.unpack_from('<H', data, pe + 20)[0]
    base = struct.unpack_from('<I', data, pe + 24 + 28)[0]
    out = []
    for i in range(count):
        o = pe + 24 + optional + 40 * i
        vsize, va, rsize, raw = struct.unpack_from('<IIII', data, o + 8)
        out.append({'va': va, 'vsize': vsize, 'raw': raw, 'rsize': rsize, 'code': struct.unpack_from('<I', data, o + 36)[0] & 0x20000000})
    return pe, base, out


def rel_targets(data, base, secs):
    """(site, opcode, destination) of every E8/E9 rel32 in executable sections."""
    for s in secs:
        if not s['code']:
            continue
        code = data[s['raw']:s['raw'] + s['rsize']]
        for i in range(len(code) - 5):
            if code[i] in (0xE8, 0xE9):
                site = base + s['va'] + i
                yield site, code[i], (site + 5 + struct.unpack_from('<i', code, i + 1)[0]) & 0xFFFFFFFF


def iat_slot(data, pe, base, secs, needle):
    def offset(rva):
        for s in secs:
            if s['va'] <= rva < s['va'] + max(s['vsize'], s['rsize']):
                return s['raw'] + rva - s['va']
        raise ValueError(hex(rva))
    d = offset(struct.unpack_from('<I', data, pe + 24 + 104)[0])
    while True:
        lookup, _, _, name, first = struct.unpack_from('<IIIII', data, d)
        if not name:
            return None
        for k in range(1 << 16):
            thunk = struct.unpack_from('<I', data, offset(lookup or first) + 4 * k)[0]
            if not thunk:
                break
            if not thunk & 0x80000000:
                at = offset(thunk) + 2
                if data[at:data.find(b'\0', at)].startswith(needle):
                    return base + first + 4 * k
        d += 20


def main(system):
    engine = open(os.path.join(system, 'Engine.dll'), 'rb').read()
    _, base, secs = sections(engine)
    for site, op, dest in rel_targets(engine, base, secs):
        if dest in (ENGINE_THUNK, ENGINE_BODY):
            print(f'Engine.dll {site:#x} {"call" if op == 0xE8 else "jmp"} -> {dest:#x}')
    for path in sorted(glob.glob(os.path.join(system, '*.dll'))):
        blob = open(path, 'rb').read()
        for needle in (NAME, b'?GetFrame@UMesh@@'):
            at = blob.find(needle)
            while at >= 0:
                end = blob.find(b'\0', at)
                print(f'{os.path.basename(path)} names {blob[at:end].decode("latin1")}')
                at = blob.find(needle, end)
    render = open(os.path.join(system, 'Render.dll'), 'rb').read()
    pe, base, secs = sections(render)
    slot = iat_slot(render, pe, base, secs, NAME)
    print(f'Render.dll IAT slot {slot:#x}')
    want, thunks = struct.pack('<I', slot), []
    for s in secs:
        if not s['code']:
            continue
        code = render[s['raw']:s['raw'] + s['rsize']]
        for i in range(len(code) - 6):
            if code[i] == 0xFF and code[i + 1] in (0x15, 0x25) and code[i + 2:i + 6] == want:
                site = base + s['va'] + i
                print(f'Render.dll {site:#x} {"call" if code[i + 1] == 0x15 else "jmp"} [slot]')
                if code[i + 1] == 0x25:
                    thunks.append(site)
    for thunk in thunks:
        callers = [f'{site:#x}' for site, _, dest in rel_targets(render, base, secs) if dest == thunk]
        word, stored, at = struct.pack('<I', thunk), [], render.find(struct.pack('<I', thunk))
        while at >= 0:
            stored.append(f'file+{at:#x}')
            at = render.find(word, at + 1)
        print(f'Render.dll thunk {thunk:#x}: rel32 callers {callers or "none"}, stored as a dword {stored or "nowhere"}')


main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'Deus Ex GOTY Edition', 'System'))
