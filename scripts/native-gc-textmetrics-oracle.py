"""Unicorn oracle for UGC::GetTextExtent (1280) / UGC::GetFontHeight (1281).

Builds real UFont images (decoded by scripts/dump-font-image.mjs from the
shipped Font exports) plus the FString the exec trampoline marshals, then runs
the real exec trampoline and method body — including the glyph lookup
0x10026880/0x10026950, the special-text iterator 0x100294d0, the word-wrap
line scan 0x10029ae0/0x10029d80 and the measurement loop 0x10027bb0.

The exec FString teardown calls two Core leaves that are replaced with scratch
stubs served by the code hook (same pattern as the probe's allocator model):
FArray::Realloc(thiscall, 1 arg) is a no-op and FArray::Remove(thiscall, 3
args) zeroes the FString header, which is the state the real Remove leaves and
what makes the GMalloc free check below it take the null path.  Neither leaf
records an event — the teardown is invisible to the measurement.

The string param's fake evaluator writes the three FString dwords
{Data, Num, Max} to the eval result pointer; a Num==0 spec mirrors an empty
FString so the body's empty-wstring substitution fires.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys

_SPEC = importlib.util.spec_from_file_location(
    'gc_probe', Path(__file__).with_name('native-gc-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

from unicorn.x86_const import (  # noqa: E402
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP,
)

EXT = _PROBE.EXT
IMAGE_BASE = _PROBE.IMAGE_BASE

# Core import slots the GetTextExtent exec FString teardown calls.
REALLOC_IAT = EXT + 0x5909c   # FArray::Realloc   (thiscall, ret 4)
REMOVE_IAT = EXT + 0x59094    # FArray::Remove    (thiscall, ret 0xc)

_PROBE.NATIVES['getTextExtent'] = {
    'exec': EXT + 0x2c020, 'method': EXT + 0x27bb0,
    'kind': 'outs', 'outs': ['xExtent', 'yExtent']}
_PROBE.NATIVES['getFontHeight'] = {
    'exec': EXT + 0x2c210, 'method': EXT + 0x27d60,
    'kind': 'execFloat'}

CASES_FILE = Path(__file__).with_name('gc-textmetrics-cases.json')
DUMP_FONT_IMAGE = Path(__file__).with_name('dump-font-image.mjs')


class TextMetricsProbe(_PROBE.GcProbe):
    """GC probe extended with real font images and FString params."""

    def __init__(self, root, fonts, font_defs):
        super().__init__(root)
        self.font_specs = fonts
        self.font_defs = font_defs
        self.realloc_stub = self._stub()
        self.write(REALLOC_IAT, 'I', self.realloc_stub)
        self.remove_stub = self._stub()
        self.write(REMOVE_IAT, 'I', self.remove_stub)

    def on_instruction(self, cpu, address, size, data):
        if self.thunks.get(address) == ('msvcrt.dll', '__dllonexit'):
            # CRT atexit-for-DLLs, reached once by the special-text palette
            # init in 0x100294d0 (call 0x100549da -> jmp __dllonexit, caller
            # does add esp,0xc). The registered list is only walked at DLL
            # unload, so a faithful append to the begin/end globals is enough.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            func, pbegin, pend = self.read(stack + 4, '3I')
            begin, end = self.read(pbegin, 'I')[0], self.read(pend, 'I')[0]
            if not begin or begin == 0xffffffff:
                begin = end = self.alloc(16)
            self.write(end, 'I', func)
            self.write(pbegin, 'I', begin)
            self.write(pend, 'I', end + 4)
            cpu.reg_write(UC_X86_REG_EAX, func)
            return self._cdecl_return(cpu, stack)
        if self.thunks.get(address) == ('msvcrt.dll', 'wcslen'):
            # wcslen is the only msvcrt leaf the method path calls; model it
            # exactly: count u16 code units until NUL, return in eax. cdecl —
            # the caller cleans its one arg.
            stack = cpu.reg_read(UC_X86_REG_ESP)
            ptr = self.read(stack + 4, 'I')[0]
            length = 0
            while True:
                unit = self.read(ptr + 2 * length, 'H')[0]
                if not unit:
                    break
                length += 1
            cpu.reg_write(UC_X86_REG_EAX, length)
            return self._cdecl_return(cpu, stack)
        if address == self.realloc_stub:
            return self._cdecl_return(cpu, cpu.reg_read(UC_X86_REG_ESP), 4)
        if address == self.remove_stub:
            stack = cpu.reg_read(UC_X86_REG_ESP)
            # The real teardown Remove(0, Num, 2) leaves the buffer pointer to
            # be freed via GMalloc->Free on fake-allocated memory; zeroing the
            # FString header here takes the same observable path (the check at
            # 0x1002c1bb skips the free) without running allocator internals.
            self.write(cpu.reg_read(UC_X86_REG_ECX), '3I', 0, 0, 0)
            return self._cdecl_return(cpu, stack, 0xc)
        return super().on_instruction(cpu, address, size, data)

    def on_gnative(self, cpu):
        """Extend the fake eval with an FString param: the real string
        evaluator copies the three-dword {Data,Num,Max} to the result ptr."""
        if (self.exec_params and isinstance(self.exec_params[0], dict)
                and 'fstring' in self.exec_params[0]):
            stack = cpu.reg_read(UC_X86_REG_ESP)
            _frame, result_ptr = self.read(stack + 4, '2I')
            data, num, max_ = self.exec_params.pop(0)['fstring']
            self.write(result_ptr, '3I', data, num, max_)
            return self._cdecl_return(cpu, stack, 8)
        return super().on_gnative(cpu)

    def build_font(self, fontspec):
        """Runtime UFont image: +0x28 charsPerPage, +0x2c page table,
        +0x30/+0x34 TArray Num/Max; page records {texture, chars, num, max};
        glyph runs are the decoded FFontCharacter i32 quads."""
        cpp = fontspec['charsPerPage']
        font = self.alloc(0x40)
        self.cpu.mem_write(font, b'\0' * 0x40)
        table = self.alloc(FONT_PAGE_SIZE * fontspec['pageCount'])
        for p, page in enumerate(fontspec['pages']):
            chars = page['chars']
            if len(chars) != cpp:
                raise ValueError('font %r page %d has %d chars, cpp %d'
                                 % (fontspec.get('name'), p, len(chars), cpp))
            run = self.alloc(16 * cpp)
            for i, rec in enumerate(chars):
                self.write(run + 16 * i, '4i', *rec)
            texture = self.alloc(4)  # resolved-texture stand-in (never read)
            self.write(table + FONT_PAGE_SIZE * p, '4I', texture, run, cpp, cpp)
        self.write(font + 0x28, 'i', cpp)
        self.write(font + 0x2c, 'I', table)
        self.write(font + 0x30, 'i', fontspec['pageCount'])
        self.write(font + 0x34, 'i', fontspec['pageCount'])
        return font

    def _font_for(self, ref):
        if '$font' in ref:
            return self.font_specs[ref['$font']]
        return self.font_defs[ref['$fontDef']]

    def _text_buffer(self, units):
        """Allocate a NUL-terminated UTF-16 buffer for the unit list."""
        buf = self.alloc(2 * (len(units) + 1))
        self.cpu.mem_write(buf, struct.pack('<%dH' % (len(units) + 1),
                                            *units, 0))
        return buf

    def _resolve_args(self, args):
        """Expand {'$text': str}/{'$units': [u16..]} into fstring eval specs
        (exec mode) and {'$textPtr': ...} into raw wchar pointers (method)."""
        built = []
        for a in args:
            if isinstance(a, dict) and ('$text' in a or '$units' in a):
                units = a.get('$units')
                if units is None:
                    # BMP only; '$units' exists for arbitrary code units.
                    units = [ord(c) for c in a['$text']]
                if units:
                    buf = self._text_buffer(units)
                    built.append({'fstring': (buf, len(units) + 1,
                                              len(units) + 1)})
                else:
                    built.append({'fstring': (0, 0, 0)})
            elif isinstance(a, dict) and '$unitsPtr' in a:
                built.append(self._text_buffer(a['$unitsPtr']))
            else:
                built.append(a)
        return built

    def _out_result(self, native):
        """The base slices out_refs[:n] including non-out Nones, which assumes
        out-params lead the arg list. GetTextExtent's outs are args 1-2, so
        map by out-arg order instead."""
        names = _PROBE.NATIVES[native].get('outs')
        slots = [slot for slot in self.out_refs if slot]
        if names:
            return {names[i]: (self.read(slots[i], 'I')[0]
                               if i < len(slots) else None)
                    for i in range(len(names))}
        for slot in slots:
            return self.read(slot, 'I')[0]
        return None

    def run_case(self, native, case):
        spec = dict(case['spec'])
        for key, value in list(spec.items()):
            if isinstance(value, dict) and ('$font' in value or '$fontDef' in value):
                spec[key] = self.build_font(self._font_for(value))
        case = dict(case, spec=spec, args=self._resolve_args(case.get('args', [])))
        out = super().run_case(native, case)
        # Method-mode execFloat bodies leave the result in ST0 (the exec's
        # fstp stores it normally). reg_read can't decode the 80-bit reg, so
        # run a bare fstp stub on the still-warm FPU for an exact f32 store.
        if (case.get('mode') == 'method'
                and _PROBE.NATIVES[native]['kind'] == 'execFloat'):
            slot = self.alloc(4)
            stub = self.alloc(4)
            self.cpu.mem_write(stub, b'\xd9\x18\x90\x90')  # fstp [eax]; nop; nop
            self.cpu.reg_write(UC_X86_REG_EAX, slot)
            self.cpu.emu_start(stub, stub + 2)
            out['result'] = self.read(slot, 'I')[0]
        return out


FONT_PAGE_SIZE = 16


def check_font_spec(name, spec):
    """Independent structural guard on the decoded font before it drives the
    oracle: serial size must equal the recovered byte layout exactly."""
    cpp = spec['charsPerPage']
    pages = spec['pageCount']
    expected = 2 + pages * (4 + cpp * 16) + 4
    if expected != spec['serialSize']:
        raise ValueError('%s: serial layout mismatch (%d != %d)'
                         % (name, spec['serialSize'], expected))
    for p in spec['pages']:
        if len(p['chars']) != cpp:
            raise ValueError('%s: page char count != charsPerPage' % name)


def load_fonts(root, names):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('node is required to decode the .u font exports')
    out = subprocess.check_output(
        [node, str(DUMP_FONT_IMAGE), root, *names], text=True)
    fonts = json.loads(out)['fonts']
    for name in names:
        fonts[name]['name'] = name
        check_font_spec(name, fonts[name])
    return fonts


def expand_font_def(name, spec):
    """Inline synthetic font: pages carry either an explicit chars list or a
    fill record + a set map of per-index overrides."""
    cpp = spec['charsPerPage']
    pages = []
    for page in spec['pages']:
        if 'chars' in page:
            chars = page['chars']
        else:
            chars = [list(page['fill']) for _ in range(cpp)]
            for idx, rec in page.get('set', {}).items():
                chars[int(idx)] = list(rec)
        if len(chars) != cpp:
            raise ValueError('%s: page has %d chars, cpp %d'
                             % (name, len(chars), cpp))
        pages.append({'header': page.get('header', [0, 0, 0, 0]),
                      'chars': chars})
    return {'name': name, 'charsPerPage': cpp, 'pageCount': spec['pageCount'],
            'pages': pages, 'serialSize': 0}


def oracle_main(native_name, root=None):
    root = Path(root or sys.argv[1])
    cases = json.loads(CASES_FILE.read_text())
    fonts = load_fonts(root, cases.get('fonts', []))
    font_defs = {name: expand_font_def(name, spec)
                 for name, spec in cases.get('fontDefs', {}).items()}
    probe = TextMetricsProbe(root, fonts, font_defs)
    entry = _PROBE.NATIVES[native_name]
    results = {}
    for name, case in cases[native_name].items():
        if case.get('mode', 'exec') == 'method' and entry['method'] is None:
            raise ValueError('%s has no method body' % native_name)
        results[name] = probe.run_case(native_name, case)
    print(json.dumps({
        'hashes': {'Extension.dll': _PROBE.EXTENSION_HASH,
                   'Core.dll': _PROBE._NATIVE.HASHES['Core.dll'],
                   'Engine.dll': _PROBE._NATIVE.HASHES['Engine.dll']},
        'extensionBase': EXT,
        'execBody': (entry['exec'] - EXT) + IMAGE_BASE,
        'methodBody': ((entry.get('methodBody', entry['method']) - EXT) + IMAGE_BASE
                       if entry['method'] else None),
        'cases': results,
    }))


if __name__ == '__main__':
    oracle_main(sys.argv[2] if len(sys.argv) > 2 else 'getTextExtent',
                sys.argv[1] if len(sys.argv) > 1 else None)
