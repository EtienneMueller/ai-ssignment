"""Runs in progress: live progress for the sidebar, and stopping them."""

import asyncio
import time
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field


@dataclass
class Progress:
    cost: float = 0  # USD spent so far
    phase: str = "answering"  # answering | running code | grading
    # agent students: "model#run" -> {"model", "run", "step", "max", "field"}
    agents: dict[str, dict] = field(default_factory=dict)


# The progress of the run the current code belongs to (model calls add their cost to it).
current: ContextVar[Progress | None] = ContextVar("aissignment_progress", default=None)

_jobs: dict[str, tuple[asyncio.Task, Progress]] = {}
_seen: dict[str, float] = {}  # job id -> last time its page asked for progress
_watchdog: asyncio.Task | None = None

# The page asks for progress every second while a run is going (background tabs: about once a minute).
# A job nobody has asked about for this long belongs to a closed or reloaded page: stop it.
ABANDONED_AFTER = 90  # seconds


async def run(job_id: str | None, coro, progress: Progress):
    """Run `coro` as a job that can be watched and stopped. Raises CancelledError when stopped."""

    async def job():
        current.set(progress)
        return await coro

    global _watchdog
    task = asyncio.ensure_future(job())
    if job_id:
        _jobs[job_id] = (task, progress)
        _seen[job_id] = time.monotonic()
        if _watchdog is None or _watchdog.done():
            _watchdog = asyncio.ensure_future(_watch())
    try:
        return await task
    finally:
        if job_id:
            _jobs.pop(job_id, None)
            _seen.pop(job_id, None)


async def _watch() -> None:
    while _jobs:
        await asyncio.sleep(5)
        now = time.monotonic()
        for job_id in [i for i, seen in _seen.items() if now - seen > ABANDONED_AFTER]:
            cancel(job_id)


def progress(job_id: str) -> Progress | None:
    job = _jobs.get(job_id)
    return job[1] if job else None


def snapshot(job_ids: list[str]) -> dict[str, dict | None]:
    now = time.monotonic()
    for i in job_ids:
        if i in _seen:
            _seen[i] = now
    return {i: asdict(p) if (p := progress(i)) else None for i in job_ids}


def cancel(job_id: str) -> bool:
    job = _jobs.get(job_id)
    if job and not job[0].done():
        job[0].cancel()
        return True
    return False


def add_cost(cost: float) -> None:
    if (p := current.get()) is not None:
        p.cost += cost
