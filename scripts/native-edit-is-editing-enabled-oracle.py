"""Unicorn oracle for Extension XEditWindow::IsEditingEnabled (native 1886).

Executes the real recovered body (rebased to 0x12000000) against
constructed window images via the shared native-editwindow probe.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('native-editwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

if __name__ == '__main__':
    _PROBE.oracle_main('IsEditingEnabled', 'execInt', 'isEditingEnabled')
