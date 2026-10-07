"""Original ScaleWindow value bodies and ScaleManagerWindow child setters.

Runs the unchanged Extension.dll bodies through the movement probe (complete
ChangeScalePosition / ChangeThumbPosition chains, script events recorded),
with XWindow::AskParentForReconfigure (0x1004e060) recorded as a service.
Cases are JSON on stdout; scripts/validate-window-scale-settings.mjs replays
them through src/runtime/script-window-scale-settings.mjs.
See docs/script-window-scale-settings.md.
"""
import importlib.util, json, struct, sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX

spec = importlib.util.spec_from_file_location('movement', Path(__file__).with_name('native-window-scroll-movement-oracle.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
EXT = m.EXT
import math


def finite(value):
    """JSON has no NaN/Infinity: non-finite floats travel as strings."""
    if isinstance(value, float) and not math.isfinite(value):
        return 'NaN' if math.isnan(value) else ('Infinity' if value > 0 else '-Infinity')
    if isinstance(value, list):
        return [finite(v) for v in value]
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    return value

m.ENTRY.update({
    'valueRange': (0x3e070, 'ff'),     # XScaleWindow::SetValueRange
    'value': (0x3e120, 'f'),           # XScaleWindow::SetValue (ValueToTick 0x3ec20)
    'getValues': (0x3e230, 'II'),      # XScaleWindow::GetValues
    'valueField': (0x41c70, 'I'),      # XScaleManagerWindow::SetValueField
    'managerScale': (0x41bd0, 'I'),    # XScaleManagerWindow::SetScale
    'managerButtons': (0x41b30, 'II'), # XScaleManagerWindow::SetScaleButtons
})


class Probe(m.Probe):
    def on_instruction(self, cpu, address, size, data):
        if address == EXT + 0x4e060:
            self.events.append({'op': 'reconfigure', 'object': cpu.reg_read(UC_X86_REG_ECX), 'args': []})
            self.ret(0)
            return
        super().on_instruction(cpu, address, size, data)


def scale(flags=0, count=10, position=3, lo=-2.5, hi=8.25):
    node = m.scale()
    node['i'].update({0x164: flags, 0x1c4: count, 0x1c8: position})
    node['f'].update({0x1d4: lo, 0x1d8: hi})
    return node


def chain(node, handled=False):
    """scale -> manager -> slider window -> screen (the security pan slider shape)."""
    node = dict(node, p={0x138: 'manager'})
    return {'root': node, 'manager': {'kind': 'manager', 'p': {0x138: 'slider', 0x158: 'root'}},
            'slider': {'p': {0x138: 'screen'}}, 'screen': {'handled': handled}}


cases = []
nan, inf = float('nan'), float('inf')
for flags in [0, 16]:
    for lo, hi in [(-2.5, 8.25), (0.5, 3), (-2.5, 9), (nan, 8.25), (-2.5, nan), (-0.0, 8.25), (3, 3)]:
        cases.append({'name': f'value-range-{flags}-{lo}-{hi}', 'mode': 'valueRange', 'args': [lo, hi],
                      'nodes': chain(scale(flags), handled=True)})
for flags, count, lo, hi in [(0, 10, -2.5, 8.25), (16, 10, -2.5, 8.25), (0, 1, 0, 1), (0, 21, 0.5, 3), (0, 10, 4, 4), (0, 10, nan, 1), (0, 10, 8, -2)]:
    for value in [-2.5, 8.25, 0, 1.0625, 3.0625, 5, 6.5, -100, 100, nan, inf, -inf, 0.75]:
        node = scale(flags, count, 3, lo, hi)
        node['i'][0x1cc] = 2   # a span that leaves room in range mode
        cases.append({'name': f'value-{flags}-{count}-{lo}-{hi}-{value}', 'mode': 'value', 'args': [value],
                      'nodes': chain(node, handled=True)})
for flags, span in [(0, 20), (16, 20), (16, 0)]:
    for pointers in [('outA', 'outB'), ('outA', 0), (0, 'outB'), (0, 0)]:
        node = scale(flags)
        node['i'][0x1cc] = span
        cases.append({'name': f'values-{flags}-{span}-{pointers}', 'mode': 'getValues', 'args': list(pointers),
                      'nodes': {'root': node, 'outA': {}, 'outB': {}}})


def manager(pointers=None):
    return {'kind': 'manager', 'p': {0x138: 'parent', **(pointers or {})}}


# Descendant (a child, a grandchild), the receiver itself, an unrelated
# window, none, and an unchanged pointer. ChangeValueField acts only with
# both a field and a scale, which these cases avoid (its formatting is the
# recorded GetValueString boundary).
tree = lambda root: {'root': root, 'parent': {}, 'child': {'p': {0x138: 'root'}},
                     'grandchild': {'p': {0x138: 'child'}}, 'other': {'p': {0x138: 'parent'}}}
for target in ['child', 'grandchild', 'root', 'other', 0]:
    cases.append({'name': f'value-field-{target}', 'mode': 'valueField', 'args': [target], 'nodes': tree(manager())})
    cases.append({'name': f'manager-scale-{target}', 'mode': 'managerScale', 'args': [target], 'nodes': tree(manager())})
cases.append({'name': 'value-field-unchanged', 'mode': 'valueField', 'args': ['child'], 'nodes': tree(manager({0x154: 'child'}))})
cases.append({'name': 'manager-scale-unchanged', 'mode': 'managerScale', 'args': ['child'], 'nodes': tree(manager({0x158: 'child'}))})
cases.append({'name': 'manager-scale-cleared', 'mode': 'managerScale', 'args': ['other'], 'nodes': tree(manager({0x158: 'child'}))})
for first, last in [('child', 'grandchild'), ('other', 'child'), (0, 'root'), ('grandchild', 0)]:
    cases.append({'name': f'manager-buttons-{first}-{last}', 'mode': 'managerButtons', 'args': [first, last],
                  'nodes': tree(manager({0x14c: 'parent', 0x150: 'parent'}))})

if __name__ == '__main__':
    probe = Probe(sys.argv[1])
    print(json.dumps(finite([probe.run(case) for case in cases])))
