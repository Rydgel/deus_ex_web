"""Unicorn oracle for Extension XListWindow::GetNumRows (native 1740).

Executes the real inline exec body 0x10034910 (rebased 0x12034910) against
constructed window images; the body is a single dword read of this+0x174.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('native-listwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

if __name__ == '__main__':
    _PROBE.oracle_main('GetNumRows', 'execInt', 'getNumRows')
