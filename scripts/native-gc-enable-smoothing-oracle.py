"""Unicorn oracle for Extension UGC::EnableSmoothing (native 1210).

Executes the real exec trampoline 0x1002b030 (rebased 0x1202b030) and the
method body 0x100270e0 (rebased 0x120270e0) plus the shared
polyflags-from-flags helper 0x1002af00, with the probe's fake GNatives
param-eval stub.  The export is void; leftover EAX is recorded as rawEax
evidence only.
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
    _PROBE.oracle_main('enableSmoothing')
