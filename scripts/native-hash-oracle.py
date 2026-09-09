"""Isolated original FCollisionHash with controlled primitive callbacks.

Only OS TLS/error bridges and fixture primitive callbacks are replaced; original
constructor/rand/srand, extent conversion, hash insertion/query and FMemStack run.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('collision_oracle', Path(__file__).with_name('native-collision-oracle.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_EAX, UC_X86_REG_EIP, UC_X86_REG_EBP
CRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'


class NativeHash(base.NativeCollision):
    def __init__(self, root, seed):
        self.query_cells = None
        self.bridges = {}
        self.actors = {}
        self.visited = []
        super().__init__(root, {'MSVCRT.dll': CRT_HASH})
        self.tls = self.alloc(0x100)
        self.last_error = 0
        self.bbox_callback = 0x700e0000
        self.line_callback = 0x700e0010
        self.bridges[self.bbox_callback] = ('bbox', 8)
        self.bridges[self.line_callback] = ('line', 48)
        for address, (dll, symbol) in self.thunks.items():
            if dll == 'kernel32.dll' and symbol in ['GetLastError', 'SetLastError', 'TlsGetValue']:
                self.bridges[address] = (symbol, 0 if symbol == 'GetLastError' else 4)
        self.call(0x780097ef, 0, struct.pack('<I', seed))
        self.hash = self.alloc(0x10014)
        self.call(0x10357ab0, self.hash, b'')
        self.tables = [list(self.read(p, '16384I')) for p in [0x10555fc4, 0x10545fc4, 0x10535fc4]]
        pool_count = 100000
        pool = self.alloc(12 * pool_count)
        for i in range(pool_count):
            self.write(pool + i * 12 + 4, 'I', pool + (i + 1) * 12 if i + 1 < pool_count else 0)
        self.write(self.hash + 0x10004, 'I', pool)
        self.memstack = self.alloc(16)
        memory = self.alloc(0x100000)
        self.write(self.memstack, 'II', memory, memory + 0x100000)
        self.vtable = self.alloc(0x70)
        self.write(self.vtable + 0x64, 'I', self.bbox_callback)
        self.write(self.vtable + 0x58, 'I', self.line_callback)

    def on_instruction(self, cpu, address, size, data):
        if address == 0x1035933c and self.query_cells is None:
            bp = cpu.reg_read(UC_X86_REG_EBP)
            self.query_cells = {'min': [self.read(bp + v, 'i')[0] for v in [-0x14, -0x34, -0x3c]], 'max': [self.read(bp + v, 'i')[0] for v in [-0x28, -0x2c, -0x40]]}
            # X minimum is still ESI before the first loop-header store.
            from unicorn.x86_const import UC_X86_REG_ESI
            self.query_cells['min'][0] = cpu.reg_read(UC_X86_REG_ESI)
        if address not in self.bridges:
            return super().on_instruction(cpu, address, size, data)
        name, pop = self.bridges[address]
        sp = cpu.reg_read(UC_X86_REG_ESP)
        if name == 'TlsGetValue':
            result = self.tls
        elif name == 'GetLastError':
            result = self.last_error
        elif name == 'SetLastError':
            self.last_error = self.read(sp + 4, 'I')[0]
            result = 0
        elif name == 'bbox':
            out, actor = self.read(sp + 4, 'II')
            bounds = self.actors[actor]['bounds']
            self.write(out, '6fB', *bounds['min'], *bounds['max'], bounds.get('valid', 1))
            result = out
        elif name == 'line':
            out, actor = self.read(sp + 4, 'II')
            fixture = self.actors[actor]
            values = self.read(sp + 12, '9fI')
            self.visited.append({'id': fixture['id'], 'end': values[:3], 'start': values[3:6], 'extent': values[6:9], 'flags': values[9]})
            self.write(out + 4, 'I', actor)
            self.write(out + 36, 'f', fixture.get('time', 0.5))
            result = 0 if fixture.get('hit', True) else 1
        cpu.reg_write(UC_X86_REG_EAX, result)
        cpu.reg_write(UC_X86_REG_EIP, self.read(sp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, sp + 4 + pop)

    def add(self, fixture):
        actor = self.alloc(0x200)
        primitive = self.alloc(4)
        self.write(primitive, 'I', self.vtable)
        self.write(actor + 0x178, 'I', primitive)
        self.write(actor + 0x1dc, 'I', 1)
        self.write(actor + 0x28, 'I', fixture.get('objectFlags', 0))
        self.write(actor + 0x114, '3f', *fixture.get('location', [0, 0, 0]))
        self.actors[actor] = fixture
        cells = self.alloc(24)
        self.call(0x10357e30, self.hash, struct.pack('<7I', actor, *(cells + i * 4 for i in range(6))))
        self.call(0x103580b0, self.hash, struct.pack('<I', actor))
        return {'id': fixture['id'], 'cells': self.read(cells, '6i'), 'hashLocation': self.read(actor + 0x138, '3f')}

    def query(self, query):
        self.query_cells = None
        self.visited = []
        head = self.call(0x10359160, self.hash, struct.pack('<I9fI', self.memstack, *query['end'], *query['start'], *query.get('extent', [0, 0, 0]), query.get('extraNodeFlags', 0)))
        hits = []
        while head:
            actor = self.read(head + 4, 'I')[0]
            hits.append({'id': self.actors[actor]['id'], 'time': self.read(head + 36, 'f')[0]})
            head = self.read(head, 'I')[0]
        return {'cells': self.query_cells, 'visited': self.visited, 'hits': hits}

    def move(self, move):
        actor = next(p for p, f in self.actors.items() if f['id'] == move['id'])
        self.call(0x103583a0, self.hash, struct.pack('<I', actor))
        fixture = self.actors[actor]
        fixture.update({k: v for k, v in move.items() if k in ['bounds', 'location']})
        self.write(actor + 0x114, '3f', *fixture.get('location', [0, 0, 0]))
        self.call(0x103580b0, self.hash, struct.pack('<I', actor))
        return self.query(move['query'])


def main():
    if len(sys.argv) != 3:
        sys.exit('Usage: native-hash-oracle.py GAME_ROOT CASES_JSON')
    cases = json.loads(Path(sys.argv[2]).read_text())
    results = []
    for case in cases:
        n = NativeHash(Path(sys.argv[1]), case.get('seed', 1))
        results.append({'tables': n.tables, 'registrations': [n.add(actor) for actor in case['actors']], 'queries': [n.query(q) for q in case['queries']], 'moves': [n.move(move) for move in case.get('moves', [])]})
    print(json.dumps({'hashes': base.HASHES | {'MSVCRT.dll': CRT_HASH}, 'results': results}))


if __name__ == '__main__':
    main()
