#!/usr/bin/env python3
"""Per-native oracle entry: GC.GetTextExtent (1280) over gc-textmetrics-cases.json."""
import importlib.util
import sys
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    'tm_oracle', Path(__file__).with_name('native-gc-textmetrics-oracle.py'))
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

if __name__ == '__main__':
    _MOD.oracle_main('getTextExtent', sys.argv[1])
