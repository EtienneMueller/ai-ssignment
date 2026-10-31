"""nbgrader-style code conventions: solution regions, hidden tests, and code in model replies."""

import ast
import re

SOLUTION_REGION = re.compile(r"^([ \t]*)### BEGIN SOLUTION\b.*?^[ \t]*### END SOLUTION[^\n]*", re.S | re.M)
HIDDEN_TESTS = re.compile(r"^[ \t]*### BEGIN HIDDEN TESTS\b.*?^[ \t]*### END HIDDEN TESTS[^\n]*\n?", re.S | re.M)
STUDENT_STUB = "# YOUR CODE HERE\nraise NotImplementedError()"
_FENCE = re.compile(r"```[ \t]*([\w+-]*)[^\n]*\n(.*?)```", re.S)


def starter_code(solution: str) -> str:
    """What students get in place of a solution cell (nbgrader: solution regions replaced)."""
    if SOLUTION_REGION.search(solution):
        return SOLUTION_REGION.sub(r"\1# YOUR CODE HERE\n\1raise NotImplementedError()", solution)
    return STUDENT_STUB


def solution_body(solution: str) -> str:
    """The instructor's code without the solution markers (empty if there is none)."""
    return re.sub(r"^[ \t]*### (BEGIN|END) SOLUTION[^\n]*\n?", "", solution, flags=re.M).strip()


def visible_tests(tests: str) -> str:
    return HIDDEN_TESTS.sub("", tests).strip()


def extract_code(reply: str) -> str | None:
    """The code a student would copy from a chat reply: the longest Python code block,
    or the whole reply if it is plain Python. None if there is no code."""
    blocks = [code for lang, code in _FENCE.findall(reply) if lang.lower() in ("", "python", "py", "python3", "ipython")]
    if blocks:
        return max(blocks, key=len).strip()
    text = reply.strip()
    if not text:
        return None
    try:
        ast.parse(text)
        return text
    except SyntaxError:
        return None


def split_tests(tests: str) -> list[tuple[str, bool]] | None:
    """Split a tests cell into top-level statements: [(source, is_test)].
    Test = an assert, or a call to something named assert* (np.testing.assert_allclose, ...).
    None if the cell does not parse."""
    try:
        tree = ast.parse(tests)
    except SyntaxError:
        return None
    lines = tests.splitlines()
    parts = []
    for node in tree.body:
        source = "\n".join(lines[node.lineno - 1 : node.end_lineno])
        is_test = isinstance(node, ast.Assert) or (
            isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and "assert" in ast.unparse(node.value.func).lower()
        )
        parts.append((source, is_test))
    if parts and not any(is_test for _, is_test in parts):
        # No recognisable test statements: the whole cell counts as one test (passes if it runs).
        return [(tests, True)]
    return parts
