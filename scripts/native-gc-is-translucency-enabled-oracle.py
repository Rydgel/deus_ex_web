"""Unicorn oracle for Extension UGC::IsTranslucencyEnabled (native 1219).

Executes the real exec body 0x1002b360 (rebased 0x1202b360) against constructed UGC images; the body is an inline flag-bit read of this+0x48, with the probe's fake GNatives param-eval stub
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
    _PROBE.oracle_main('isTranslucencyEnabled')
