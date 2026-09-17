"""Unicorn oracle for Extension AppendText (the text-display family).

Executes the real recovered exec body (rebased to 0x12000000) against
constructed window images via the shared native-textwindow probe.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('native-textwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

if __name__ == '__main__':
    _PROBE.oracle_main('AppendText', 'appendText')
