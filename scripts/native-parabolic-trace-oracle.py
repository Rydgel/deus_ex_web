"""Execute original AActor::execParabolicTrace (native 722) and its callees in Unicorn.

The registered exec body (Engine.dll 0x1036e190), the trace worker it tail-calls
(0x1036c0a0), the per-step slide/trace helper (0x1036ca90), TwoWallAdjust
(0x10323770) and every Core vector routine they call (FVector constructor,
operator*=, operator+=, SizeSquared, SafeNormal, appSqrt) run from the
hash-checked DLLs. Only the two level services the worker reaches are test
doubles, recorded per call so a translation can replay them:

  * UModel::PointRegion (0x103f5db0): a fixture zone table answers by position.
  * ULevel::MultiLineCheck (vtable +0xc8): a fixture of half-spaces and vertical
    cylinders answers with an FCheckResult list sorted by time. The list is
    handed to the original filter loop (IsOwnedBy 0x1034c8d0, the bBlockActors
    bit at actor +0x1dc, the LevelInfo exemption), which runs from the DLL.

Because those services are doubles, this harness establishes the ParabolicTrace
arithmetic, argument defaults, branch order and call sequence, not world
collision (docs/parabolic-trace.md "Scope").

A scene may carry `replay` instead of fixture geometry: the PointRegion and MultiLineCheck answers a live
Play session gave (scripts/validate-parabolic-trace-play.mjs), served in order and checked against the
arguments the original passes, so the original code can be run on the real level's answers.

Three modes read JSON on stdin and print one JSON result per case. All numeric
inputs are float32/int32 words (JSON has no NaN); scene geometry for the
doubles is plain JSON numbers.

  exec     the whole native: fake FFrame whose GNatives entries write the case's
           next parameter (or nothing for a skipped optional, like EX_Nothing)
  slide    the helper 0x1036ca90 on its own (start, delta, extent, flag, hit0)
  twowall  TwoWallAdjust 0x10323770 on its own

`coverage: true` on a request records which instructions of the worker, the slide
helper and TwoWallAdjust executed (slow: a Python hook per instruction).
Optional research tool, never imported by the browser.
"""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UcError
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
                               UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

EXEC, WORKER, SLIDE, TWO_WALL, POINT_REGION = 0x1036e190, 0x1036c0a0, 0x1036ca90, 0x10323770, 0x103f5db0
GNATIVES_IAT, GPROPADDR_IAT = 0x10599a38, 0x10599aa0
COVERAGE = {'worker': (0x1036c0a0, 0x1036c84a), 'slide': (0x1036ca90, 0x1036cebe), 'twoWallAdjust': (0x10323770, 0x103239a3)}
LEVEL_INFO_CLASS = 0x1057bf00
INSTRUCTION_BUDGET = 40_000_000


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def word(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


def flt(w):
    return struct.unpack('<f', struct.pack('<I', w & 0xffffffff))[0]


class ParabolicTrace(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        cpu = self.cpu
        # Hook only the addresses the harness answers, not every instruction: the
        # base class's global hook would call Python for each of the millions of
        # instructions a long trace executes.
        cpu.hook_del(self.code_hook)
        self.base_hook = cpu.hook_add(UC_HOOK_CODE, self.on_thunk_range, begin=0x70000000, end=0x700fffff)
        cpu.hook_add(UC_HOOK_CODE, self.on_point_region, begin=POINT_REGION, end=POINT_REGION)
        self.coverage_hooks = []
        self.covered = set()
        self.gpropaddr = self.read(GPROPADDR_IAT, 'I')[0]  # the IAT slot of a data import holds Core's variable
        self.mlc_stub, self.gnative_stub = 0x700fe000, 0x700fe040
        cpu.mem_write(self.mlc_stub, b'\xc3')
        cpu.mem_write(self.gnative_stub, b'\xc3')
        cpu.hook_add(UC_HOOK_CODE, self.on_mlc, begin=self.mlc_stub, end=self.mlc_stub)
        cpu.hook_add(UC_HOOK_CODE, self.on_gnative, begin=self.gnative_stub, end=self.gnative_stub)
        table = self.alloc(0x400)
        for i in range(0x100):
            self.write(table + 4 * i, 'I', self.gnative_stub)
        self.write(GNATIVES_IAT, 'I', table)
        self.vtable = self.alloc(0x200)
        self.write(self.vtable + 0xc8, 'I', self.mlc_stub)
        self.level, self.level_info, self.actors_array = self.alloc(0x200), self.alloc(0x800), self.alloc(16)
        self.model = self.alloc(0x100)
        self.write(self.level, 'I', self.vtable)
        self.write(self.level + 0x2c, '3I', self.actors_array, 1, 1)
        self.write(self.level + 0x98, 'I', self.model)
        self.write(self.actors_array, 'I', self.level_info)
        self.write(self.level_info + 0x24, 'I', LEVEL_INFO_CLASS)
        self.actor = self.alloc(0x800)
        self.write(self.actor + 0x24, 'I', 0x1058c660)  # an APawn class pointer; the worker never reads it
        self.write(self.actor + 0xac, 'I', self.level)
        self.scene = None
        self.events = None
        self.trace_events = []

    # --- thunks, coverage -------------------------------------------------
    def on_thunk_range(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')

    def enable_coverage(self):
        if self.coverage_hooks:
            return
        for lo, hi in COVERAGE.values():
            self.coverage_hooks.append(self.cpu.hook_add(UC_HOOK_CODE, lambda cpu, a, s, d: self.covered.add(a), begin=lo, end=hi))

    def uncovered(self):
        from capstone import Cs, CS_ARCH_X86, CS_MODE_32
        md, result = Cs(CS_ARCH_X86, CS_MODE_32), {}
        for name, (lo, hi) in COVERAGE.items():
            instructions = [i.address for i in md.disasm(bytes(self.cpu.mem_read(lo, hi - lo)), lo)]
            missing = [a for a in instructions if a not in self.covered]
            spans = []
            for a in missing:
                if spans and a - spans[-1][1] <= 16:
                    spans[-1][1] = a
                else:
                    spans.append([a, a])
            result[name] = {'instructions': len(instructions), 'executed': len(instructions) - len(missing),
                            'uncovered': [f'{a:#x}-{b:#x}' for a, b in spans]}
        return result

    def call(self, address, this, args, control_word=None):
        cpu = self.cpu
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this),
                           (UC_X86_REG_FPCW, control_word if control_word is not None else self.control_word),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        cpu.mem_write(self.stack + 4, args)
        cpu.emu_start(address, self.done + 1, count=INSTRUCTION_BUDGET)
        if cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError('Native instruction budget exceeded')
        return cpu.reg_read(UC_X86_REG_EAX)

    # --- scene ------------------------------------------------------------
    def build_scene(self, scene):
        """Zones, test actors and the self cylinder. Actor ids: 0 LevelInfo, 1 self (the
        pawn running the native), 2.. the scene's actors."""
        self.scene = scene
        self.zone_ptrs = []
        for zone in scene.get('zones', []):
            ptr = self.alloc(0x800)
            self.write(ptr + 0x31c, '3I', *zone['gravity'])
            self.write(ptr + 0x328, '3I', *zone['velocity'])
            self.write(ptr + 0x33c, 'I', zone['terminal'])
            self.write(ptr + 0x388, 'I', 1 if zone.get('water') else 0)
            self.zone_ptrs.append(ptr)
        self.actor_ptrs = {0: self.level_info, 1: self.actor}
        for index, spec_ in enumerate(scene.get('actors', [])):
            self.actor_ptrs[2 + index] = self.alloc(0x800)
        for index, spec_ in enumerate(scene.get('actors', [])):
            ptr = self.actor_ptrs[2 + index]
            self.write(ptr + 0x24, 'I', 0x1058c660)
            owner = spec_.get('owner')
            self.write(ptr + 0xc4, 'I', 0 if owner is None else self.actor_ptrs[owner])
            self.write(ptr + 0x1dc, 'I', (1 if spec_.get('collide', True) else 0) | (4 if spec_.get('blocks', True) else 0))
        self.replay = None
        if 'replay' in scene:
            # A live session's recorded service answers (scripts/validate-parabolic-trace-play.mjs): the
            # fixture geometry above is bypassed. replayActors maps an id to its owner id and bBlockActors.
            self.replay = list(scene['replay'])
            self.replay_zones = {}
            infos = {int(k): v for k, v in scene.get('replayActors', {}).items()}
            for aid in infos:
                if aid >= 2:
                    self.actor_ptrs[aid] = self.alloc(0x800)
            for aid, info in infos.items():
                if aid < 2:
                    continue
                ptr = self.actor_ptrs[aid]
                self.write(ptr + 0x24, 'I', 0x1058c660)
                owner = info.get('owner')
                self.write(ptr + 0xc4, 'I', 0 if owner is None else self.actor_ptrs[owner])
                self.write(ptr + 0x1dc, 'I', 1 | (4 if info.get('blocks') else 0))
        self.ptr_ids = {ptr: aid for aid, ptr in self.actor_ptrs.items()}
        self.write(self.actor + 0xc4, 'I', 0)

    def replay_zone(self, zone):
        key = json.dumps(zone, sort_keys=True)
        if key not in self.replay_zones:
            ptr = self.alloc(0x800)
            self.write(ptr + 0x31c, '3I', *zone['gravity'])
            self.write(ptr + 0x328, '3I', *zone['velocity'])
            self.write(ptr + 0x33c, 'I', zone['terminal'])
            self.write(ptr + 0x388, 'I', 1 if zone.get('water') else 0)
            self.replay_zones[key] = ptr
        return self.replay_zones[key]

    def next_replay(self, kind):
        if not self.replay:
            raise RuntimeError(f'replay exhausted at a {kind} call')
        event = self.replay.pop(0)
        if event['kind'] != kind:
            raise RuntimeError(f'replay divergence: the original called {kind}, the recording {event["kind"]}')
        return event

    # --- level service doubles --------------------------------------------
    def on_point_region(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ret, hidden, zone_actor, *position = self.read(stack, '3I3I')
        scene = self.scene
        if self.replay is not None:
            event = self.next_replay('region')
            if event['position'] != position:
                raise RuntimeError(f'replay divergence: PointRegion at {position}, recorded {event["position"]}')
            self.write(hidden, 'IiI', self.replay_zone(event['zone']), event['leaf'], event['zoneNumber'] & 0xff)
            self.trace_events.append({'kind': 'region', 'position': position})
            cpu.reg_write(UC_X86_REG_EAX, hidden)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            cpu.reg_write(UC_X86_REG_ESP, stack + 4 + 0x14)
            return
        p = [flt(w) for w in position]
        chosen = scene.get('defaultRegion', {'zone': 0, 'zoneNumber': 1, 'leaf': 0})
        for region in scene.get('regions', []):
            if all(lo <= v <= hi for v, lo, hi in zip(p, region['min'], region['max'])):
                chosen = region
                break
        self.write(hidden, 'IiI', self.zone_ptrs[chosen['zone']], chosen.get('leaf', 0), chosen['zoneNumber'] & 0xff)
        self.trace_events.append({'kind': 'region', 'position': position, 'zone': chosen['zone'],
                                  'leaf': chosen.get('leaf', 0), 'zoneNumber': chosen['zoneNumber'] & 0xff})
        cpu.reg_write(UC_X86_REG_EAX, hidden)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + 0x14)

    def on_mlc(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        ret = self.read(stack, 'I')[0]
        args = self.read(stack + 4, '13I')
        end, start, extent = list(args[1:4]), list(args[4:7]), list(args[7:10])
        check, level_actor, extra = args[10], args[11], args[12]
        if self.replay is not None:
            event = self.next_replay('mlc')
            for key, value in (('end', end), ('start', start), ('extent', extent)):
                if event[key] != value:
                    raise RuntimeError(f'replay divergence: MultiLineCheck {key} {value}, recorded {event[key]}')
            if bool(event['check']) != bool(check) or event['extra'] != extra or level_actor != self.level_info:
                raise RuntimeError('replay divergence: MultiLineCheck flags')
            hits = event['hits']
        else:
            hits = self.geometry([flt(w) for w in end], [flt(w) for w in start], [flt(w) for w in extent], bool(check))
        head, previous = 0, 0
        records = []
        for hit in hits:
            ptr = self.alloc(0x2c)
            self.write(ptr, 'I', 0)
            self.write(ptr + 4, 'I', self.actor_ptrs[hit['actor']])
            self.write(ptr + 8, '3I', *hit['location'])
            self.write(ptr + 0x14, '3I', *hit['normal'])
            self.write(ptr + 0x20, 'I', hit['primitive'])
            self.write(ptr + 0x24, 'I', hit['time'])
            self.write(ptr + 0x28, 'i', hit['item'] if hit.get('item') is not None else -1)
            if previous:
                self.write(previous, 'I', ptr)
            else:
                head = ptr
            previous = ptr
            records.append(hit)
        self.trace_events.append({'kind': 'mlc', 'end': end, 'start': start, 'extent': extent, 'check': check,
                                  'levelInfo': level_actor == self.level_info, 'extra': extra, 'hits': records})
        cpu.reg_write(UC_X86_REG_EAX, head)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + 0x34)

    def geometry(self, end, start, extent, check_actors):
        """Half-spaces (the world) and vertical cylinders (actors) swept by an extent box
        along start->end, as an FCheckResult list sorted by time. A fixture, not the
        engine's collision (the harness records these answers for replay)."""
        scene, hits = self.scene, []
        d = [e - s for e, s in zip(end, start)]
        for item, plane in enumerate(scene.get('planes', [])):
            n = plane['normal']
            support = sum(abs(n[i]) * extent[i] for i in range(3))
            d0 = sum(n[i] * start[i] for i in range(3)) - plane['offset']
            d1 = sum(n[i] * end[i] for i in range(3)) - plane['offset']
            if d0 >= support and d1 < support:
                t = (d0 - support) / (d0 - d1)
            elif d0 < support and d1 < d0:
                t = 0.0
            else:
                continue
            hits.append(self.hit(0, t, start, d, n, item))
        if check_actors:
            cylinders = [(1, scene['self'])] if 'self' in scene else []
            cylinders += [(2 + i, a) for i, a in enumerate(scene.get('actors', []))]
            for actor_id, cyl in cylinders:
                r = self.cylinder_hit(cyl, start, d, extent)
                if r:
                    hits.append(self.hit(actor_id, r[0], start, d, r[1], 0))
        hits.sort(key=lambda h: flt(h['time']))
        return hits

    @staticmethod
    def hit(actor_id, t, start, d, normal, item):
        t = f32(t)
        location = [word(f32(s + t * c)) for s, c in zip(start, d)]
        return {'actor': actor_id, 'time': word(t), 'location': location, 'normal': [word(f32(c)) for c in normal],
                'item': item, 'primitive': 0}

    @staticmethod
    def cylinder_hit(cyl, start, d, extent):
        c, radius, half = cyl['center'], cyl['radius'] + extent[0], cyl['halfHeight'] + extent[2]
        lo, hi = 0.0, 1.0
        normal = None
        # Z slab
        zlo, zhi = c[2] - half, c[2] + half
        if d[2] == 0:
            if not zlo <= start[2] <= zhi:
                return None
            t_in_z, z_normal = -math.inf, None
        else:
            t0, t1 = (zlo - start[2]) / d[2], (zhi - start[2]) / d[2]
            t_in_z = min(t0, t1)
            z_normal = [0, 0, 1 if d[2] < 0 else -1]
            t_out_z = max(t0, t1)
            hi = min(hi, t_out_z)
        # XY circle
        ox, oy = start[0] - c[0], start[1] - c[1]
        a = d[0] * d[0] + d[1] * d[1]
        b = 2 * (ox * d[0] + oy * d[1])
        k = ox * ox + oy * oy - radius * radius
        if a == 0:
            if k > 0:
                return None
            t_in_xy, t_out_xy = -math.inf, math.inf
        else:
            disc = b * b - 4 * a * k
            if disc < 0:
                return None
            root = math.sqrt(disc)
            t_in_xy, t_out_xy = (-b - root) / (2 * a), (-b + root) / (2 * a)
        hi = min(hi, t_out_xy)
        entry = max(t_in_z, t_in_xy)
        if entry > hi or hi < 0:
            return None
        if entry >= 1.0:
            return None
        if entry == t_in_z and z_normal and t_in_z >= t_in_xy:
            normal = z_normal
        else:
            px, py = start[0] + max(entry, 0) * d[0] - c[0], start[1] + max(entry, 0) * d[1] - c[1]
            length = math.hypot(px, py) or 1.0
            normal = [px / length, py / length, 0.0]
        return max(entry, 0.0), normal

    # --- exec arguments ----------------------------------------------------
    def on_gnative(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result = self.read(stack + 4, '2I')
        if not self.params:
            raise RuntimeError('extra parameter evaluation')
        index = 10 - len(self.params)
        param = self.params.pop(0)
        if param.get('skip'):
            pass
        elif param.get('out'):
            if self.out_ref:
                self.write(self.gpropaddr, 'I', self.out_slot)
            else:
                self.cpu.mem_write(result, struct.pack('<3I', *param['words']))
        else:
            self.cpu.mem_write(result, struct.pack('<%dI' % len(param['words']), *param['words']))
        self.trace_events.append({'kind': 'arg', 'index': index})
        ret = self.read(stack, 'I')[0]
        cpu.reg_write(UC_X86_REG_ESP, stack + 12)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    # --- modes -------------------------------------------------------------
    def reset(self, case):
        self.build_scene(case.get('scene', {}))
        self.trace_events = []
        self.params = []
        self.out_ref = False
        if case.get('coverage'):
            self.enable_coverage()

    def run_exec(self, case):
        self.reset(case)
        a = case['actor']
        self.write(self.actor + 0x114, '3I', *a['location'])
        self.write(self.actor + 0x144, '3I', *a['velocity'])
        self.write(self.actor + 0x1d4, '2I', a['radius'], a['height'])
        self.write(self.actor + 0x1dc, 'I', (1 if a['collide'] else 0) | 4)
        self.write(self.actor + 0x1ec, 'I', 0x10 if a['bounce'] else 0)
        self.params = [dict(p) for p in case['params']]
        self.out_ref = bool(case.get('outRef'))
        self.out_slot = self.alloc(16)
        self.cpu.mem_write(self.out_slot, b'\xcd' * 16)
        code = self.alloc(0x40)
        frame = self.alloc(0x40)
        self.cpu.mem_write(frame, bytes(0x40))
        self.cpu.mem_write(code, bytes(0x40))
        self.write(frame + 8, 'I', self.actor)
        self.write(frame + 0xc, 'I', code)
        result = self.alloc(16)
        self.cpu.mem_write(result, b'\xcd' * 16)
        self.write(self.gpropaddr, 'I', 0)
        out = {'id': case['id']}
        try:
            self.call(EXEC, self.actor, struct.pack('<II', frame, result), case.get('cw'))
            out['status'] = 'ok'
        except Exception as error:
            out['status'] = 'error'
            out['reason'] = str(error)[:300]
        out['result'] = self.read(result, 'I')[0]
        out['out'] = list(self.read(self.out_slot, '3I'))
        out['codeAdvance'] = self.read(frame + 0xc, 'I')[0] - code
        out['paramsLeft'] = len(self.params)
        out['gpropaddr'] = self.read(self.gpropaddr, 'I')[0] == self.out_slot
        out['calls'] = self.trace_events
        if self.replay is not None:
            out['replayLeft'] = len(self.replay)
        return out

    def run_slide(self, case):
        self.reset(case)
        start = self.alloc(16)
        self.write(start, '3I', *case['start'])
        extent = self.alloc(16)
        self.write(extent, '3I', *case['extent'])
        region, hit = self.alloc(16), self.alloc(0x30)
        self.write(region, 'IiI', self.zone_ptrs[0] if self.zone_ptrs else 0, -7, 0x5a)
        hit0 = case.get('hit0')
        if hit0 is None:
            hit0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        self.write(hit, '11I', *hit0)
        ignore = self.actor if case.get('ignore') else 0
        # cdecl: XLevel, Actor, &Start, Delta (3), &Extent, bCheckActors, &Region, &Hit
        args = struct.pack('<III3IIIII', self.level, ignore, start, *case['delta'], extent, case['check'], region, hit)
        out = {'id': case['id']}
        try:
            out['return'] = self.call(SLIDE, 0, args, case.get('cw'))
            out['status'] = 'ok'
        except Exception as error:
            out['status'] = 'error'
            out['reason'] = str(error)[:300]
        out['start'] = list(self.read(start, '3I'))
        zone, leaf, number = self.read(region, 'IiI')
        out['region'] = {'zone': self.zone_ptrs.index(zone) if zone in self.zone_ptrs else -1, 'leaf': leaf, 'zoneNumber': number & 0xff}
        words = list(self.read(hit, '11I'))
        out['hit'] = {'next': words[0], 'actor': self.ptr_ids.get(words[1], -1 if words[1] == 0 else words[1]),
                      'location': words[2:5], 'normal': words[5:8], 'primitive': words[8], 'time': words[9],
                      'item': struct.unpack('<i', struct.pack('<I', words[10]))[0]}
        out['calls'] = self.trace_events
        return out

    def run_two_wall(self, case):
        self.reset(case)
        buffers = {}
        for name in ('desired', 'delta', 'normal', 'old'):
            buffers[name] = self.alloc(16)
            self.write(buffers[name], '3I', *case[name])
        args = struct.pack('<IIIII', buffers['desired'], buffers['delta'], buffers['normal'], buffers['old'], case['time'])
        out = {'id': case['id']}
        try:
            self.call(TWO_WALL, 0, args, case.get('cw'))
            out['status'] = 'ok'
        except Exception as error:
            out['status'] = 'error'
            out['reason'] = str(error)[:300]
        out['delta'] = list(self.read(buffers['delta'], '3I'))
        return out

    def run(self, case):
        return {'exec': self.run_exec, 'slide': self.run_slide, 'twowall': self.run_two_wall}[case['mode']](case)


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'Deus Ex GOTY Edition'
    request = json.load(sys.stdin)
    native = ParabolicTrace(root)
    results = [native.run(case) for case in request['cases']]
    output = {'hashes': collision.HASHES, 'results': results}
    if request.get('coverage'):
        output['coverage'] = native.uncovered()
    print(json.dumps(output))


if __name__ == '__main__':
    main()
