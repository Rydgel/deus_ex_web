"""Shared ordered worker pool for the native oracles.

The oracles emit byte-identical output whether cases run serially or across
workers, so the pool returns results in input order and callers concatenate
in that order.  Workers construct their own probe in the initializer — the
Unicorn engine is never shared across processes — and every worker function
stays a top-level name in its oracle module so spawn can pickle it.

    NATIVE_ORACLE_JOBS=1 forces the serial path (used for the byte-identical
    A/B diff); any other positive value caps the worker count.  Forked
    workers skip the module re-import spawn would pay per worker.
"""
import os
from multiprocessing import get_context


def oracle_jobs(default=None):
    """Worker count: NATIVE_ORACLE_JOBS wins, else one per CPU."""
    try:
        jobs = int(os.environ.get('NATIVE_ORACLE_JOBS', '0'))
    except ValueError:
        jobs = 0
    return jobs if jobs > 0 else (default or min(16, os.cpu_count() or 1))


def pooled_map(work, init, initargs, items, jobs=None):
    """map work over items preserving input order.

    `init(*initargs)` runs once per worker and once in the serial fallback,
    so the serial path exercises the same code the workers do.  Falls back
    to a serial loop when jobs <= 1, there is a single item, or the pool
    cannot be created.
    """
    jobs = oracle_jobs() if jobs is None else jobs
    if jobs <= 1 or len(items) <= 1:
        init(*initargs)
        return [work(item) for item in items]
    try:
        context = get_context('fork')
    except ValueError:
        context = get_context()
    with context.Pool(jobs, initializer=init, initargs=initargs) as pool:
        return pool.map(work, items, chunksize=max(1, len(items) // (jobs * 8)))
