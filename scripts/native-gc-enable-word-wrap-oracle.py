"""Unicorn oracle for Extension UGC::EnableWordWrap (native 1258).

Executes the real exec trampoline 0x1002bd90 (rebased 0x1202bd90) and the method body 0x10027720 (rebased 0x12027720), with the probe's fake GNatives param-eval stub
where the body marshals a param.  Output is {result, events, state} per
case.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'gc_probe', Path(__file__).with_name('native-gc-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

if __name__ == '__main__':
    _PROBE.oracle_main('enableWordWrap')
