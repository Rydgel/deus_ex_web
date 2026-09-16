"""Unicorn oracle for Extension XListWindow::AddRow (native 1730).

Executes the real method body 0x1002ed80 (rebased 0x1202ed80) and its helper
chain (createNode/parseRow/setFieldText/measureField/insert) with the probe's
FMalloc, leaf, and kernel32 models; allocator and boundary events are recorded
verbatim.
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
    _PROBE.oracle_main('AddRow', 'ptr', 'addRow')
