"""Unicorn oracle for Extension UGC::SetStyle (native 1212).

Executes the real exec trampoline / method body with the probe's fake
GNatives param-eval stub; see scripts/native-gc-probe.py.
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
    _PROBE.oracle_main('setStyle')
