"""Runs AI-written code in a fresh kernel - never the user's - with a time limit per cell."""

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import nbformat
from nbclient import NotebookClient

from .nbcode import split_tests

log = logging.getLogger(__name__)

TIMEOUT = 60  # seconds per cell
_kernels = asyncio.Semaphore(4)  # kernels running at the same time (checking answers)
_sessions = asyncio.Semaphore(4)  # agent students working at the same time, each with its own kernel

MAX_TEXT = 10_000  # characters per text output
MAX_IMAGE = 800_000  # bytes (base64) per image
MAX_OUTPUTS = 20


@dataclass
class TestResult:
    source: str
    passed: bool
    error: str | None = None


@dataclass
class Execution:
    outputs: list[dict] = field(default_factory=list)  # nbformat outputs of the code itself
    error: str | None = None  # first error the code raised ("NameError: name 'df' is not defined")
    setup_error: str | None = None  # the notebook's own code failed before the student's code ran
    timed_out: bool = False
    tests: list[TestResult] | None = None

    @property
    def passed(self) -> int:
        return sum(t.passed for t in self.tests or [])

    def as_dict(self) -> dict:
        return {
            "outputs": self.outputs,
            "error": self.error,
            "setup_error": self.setup_error,
            "timed_out": self.timed_out,
            "tests": None if self.tests is None else [vars(t) for t in self.tests],
        }


def _error_of(outputs: list) -> tuple[str, str] | None:
    for o in outputs:
        if o.get("output_type") == "error":
            return o.get("ename", "Error"), o.get("evalue", "")
    return None


def _prune(outputs: list, max_image: int = MAX_IMAGE) -> list[dict]:
    """Keep outputs small enough to store in the notebook metadata."""
    kept = []
    for o in outputs[:MAX_OUTPUTS]:
        o = nbformat.from_dict(o)
        if o.output_type == "stream" and len(o.text) > MAX_TEXT:
            o.text = o.text[:MAX_TEXT] + "\n[... output truncated]"
        if o.output_type in ("display_data", "execute_result"):
            data = dict(o.data)
            for mime in [m for m in data if m.startswith("image/")]:
                if len(data[mime]) > max_image:
                    del data[mime]
                    data.setdefault("text/plain", "[image too large to keep]")
            for mime in ("text/plain", "text/html"):
                if isinstance(data.get(mime), str) and len(data[mime]) > MAX_TEXT:
                    data[mime] = data[mime][:MAX_TEXT] + "\n[... truncated]"
            o.data = data
        if o.output_type == "error":
            o.traceback = o.traceback[-20:]
        kept.append(dict(o))
    return kept


def _client(nb, workdir: Path | None, kernel: str | None) -> NotebookClient:
    return NotebookClient(
        nb,
        timeout=TIMEOUT,
        startup_timeout=60,
        kernel_name=kernel or "python3",
        allow_errors=True,
        interrupt_on_timeout=True,
        resources={"metadata": {"path": str(workdir or Path.cwd())}},
    )


async def execute(
    workdir: Path | None, kernel: str | None, setup: list[str], code: str, tests: str | None = None
) -> Execution:
    """Run the notebook's own code (setup), then `code`, then each test statement, in a new kernel."""
    test_parts = split_tests(tests) if tests and tests.strip() else None
    cells = [nbformat.v4.new_code_cell(s) for s in setup] + [nbformat.v4.new_code_cell(code)]
    cells += [nbformat.v4.new_code_cell(source) for source, _ in test_parts or []]
    nb = nbformat.v4.new_notebook(cells=cells)
    client = _client(nb, workdir, kernel)
    async with _kernels:
        await client.async_execute()

    result = Execution()
    for cell in nb.cells[: len(setup)]:
        if err := _error_of(cell.outputs):
            result.setup_error = f"{err[0]}: {err[1]}"
            break
    own = nb.cells[len(setup)].outputs
    result.outputs = _prune(own)
    if err := _error_of(own):
        result.timed_out = err[0] == "KeyboardInterrupt"
        result.error = f"Stopped after the {TIMEOUT} s time limit" if result.timed_out else f"{err[0]}: {err[1]}"
    if tests and tests.strip():
        if test_parts is None:
            result.tests = [TestResult(source=tests, passed=False, error="The tests cell has a syntax error.")]
        else:
            result.tests = []
            for (source, is_test), cell in zip(test_parts, nb.cells[len(setup) + 1 :]):
                err = _error_of(cell.outputs)
                if is_test:
                    result.tests.append(
                        TestResult(source=source, passed=err is None, error=f"{err[0]}: {err[1]}" if err else None)
                    )
    return result


# The reference solution's output is needed to grade answers without tests; it rarely changes.
_reference_cache: dict[str, Execution] = {}


async def execute_reference(workdir: Path | None, kernel: str | None, setup: list[str], code: str) -> Execution:
    key = hashlib.sha256(repr((str(workdir), kernel, setup, code)).encode()).hexdigest()
    if key not in _reference_cache:
        if len(_reference_cache) > 32:
            _reference_cache.clear()
        _reference_cache[key] = await execute(workdir, kernel, setup, code)
    return _reference_cache[key]


class Session:
    """A kernel that keeps its state between runs, like a notebook a student works in (agent students).

    async with Session(workdir, kernel) as session:
        outputs = await session.run("x = 1")
    """

    def __init__(self, workdir: Path | None, kernel: str | None) -> None:
        self.nb = nbformat.v4.new_notebook()
        self.client = _client(self.nb, workdir, kernel)

    async def __aenter__(self) -> "Session":
        await _sessions.acquire()
        try:
            self._kernel = self.client.async_setup_kernel()
            await self._kernel.__aenter__()
        except BaseException:
            _sessions.release()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            await self._kernel.__aexit__(*exc)
        finally:
            _sessions.release()

    async def run(self, code: str) -> list[dict]:
        cell = nbformat.v4.new_code_cell(code)
        self.nb.cells.append(cell)
        await self.client.async_execute_cell(cell, len(self.nb.cells) - 1)
        return [dict(o) for o in cell.outputs]


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def as_text(outputs: list[dict], limit: int = 2000) -> str:
    """Outputs as the agent reads them: printed text, results, errors with traceback; plots are only mentioned."""
    parts = []
    for o in outputs:
        kind = o.get("output_type")
        if kind == "stream":
            parts.append(o.get("text", ""))
        elif kind in ("execute_result", "display_data"):
            data = o.get("data", {})
            if any(m.startswith("image/") for m in data):
                parts.append("[a plot/image was displayed]")
            else:
                parts.append(str(data.get("text/plain", "")))
        elif kind == "error":
            if o.get("ename") == "KeyboardInterrupt":
                parts.append(f"Stopped: the code ran longer than the {TIMEOUT} s time limit.")
            else:
                parts.append(_ANSI.sub("", "\n".join(o.get("traceback", [])[-8:])) or f"{o.get('ename')}: {o.get('evalue')}")
    text = "\n".join(p.rstrip() for p in parts if p and p.strip()) or "(no output)"
    return text if len(text) <= limit else text[: limit // 2] + "\n[... output shortened ...]\n" + text[-limit // 2 :]


def prune_step(outputs: list[dict]) -> list[dict]:
    """Outputs of an agent step, small enough to keep in the notebook."""
    return _prune(outputs, max_image=200_000)
