"""Unicorn oracle for Extension XListWindow::GetSelectedRow (native 1747).

Executes the real method body 0x1002f740 (rebased 0x1202f740): returns the
cached this+0x1ac node when still flagged, else scans for the first selected
row node.
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
    _PROBE.oracle_main('GetSelectedRow', 'ptr', 'getSelectedRow')
