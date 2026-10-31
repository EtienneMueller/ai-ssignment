"""Prompts for the simulated students, the grader and the hardening advisor."""

import json
import re

from .models import Assignment, Cell
from .nbcode import starter_code, visible_tests

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def format_points(points: float) -> str:
    return f"{points:g} point" + ("" if points == 1 else "s")


def render_cell(cell: Cell) -> str:
    """The question as a student would see (and copy) it. MCQ options are part of the prompt markdown;
    for code questions the student also copies the starter code cell."""
    if cell.type == "code_question":
        return f"{cell.question.strip()}\n\n```python\n{starter_code(cell.reference)}\n```"
    return cell.question.strip()


def render_assignment(assignment: Assignment) -> str:
    """The whole notebook as a student would paste it; answer cells become numbered answer fields."""
    parts = []
    number = 0
    for cell in assignment.cells:
        if cell.type == "context":
            parts.append(cell.question.strip())
        elif cell.type == "code":
            parts.append(f"```python\n{cell.question.strip()}\n```" if cell.question.strip() else "")
        elif cell.type == "code_question":
            number += 1
            tests = visible_tests(cell.tests)
            parts.append(
                f"{cell.question.strip()}\n\n**Answer field {number}** ({format_points(cell.points)}), a code cell:\n"
                f"```python\n{starter_code(cell.reference)}\n```"
                + (f"\n\nTests in the notebook (run after your code):\n```python\n{tests}\n```" if tests else "")
            )
        else:
            number += 1
            parts.append(
                f"{render_cell(cell)}\n\n**Answer field {number}** ({format_points(cell.points)}): YOUR ANSWER HERE"
            )
    return "\n\n".join(p for p in parts if p)


# --- Students -----------------------------------------------------------------------------------
# No system prompt: we want the raw behaviour a student gets when pasting into a chat window.


def copy_paste_messages(cell: Cell) -> list[dict]:
    return [{"role": "user", "content": render_cell(cell)}]


# The heading instruction is the only thing a real student wouldn't necessarily type;
# we need it to split the answer back into cells.
ANSWER_FORMAT = (
    "Start each answer with a heading of the form '## Answer N' (N = number of the answer field). "
    "For code answer fields, give the complete code for that cell in a Python code block."
)


def whole_assignment_messages(assignment: Assignment) -> list[dict]:
    content = (
        f"Here is my assignment. Please solve it completely.\n{ANSWER_FORMAT}\n\n---\n\n"
        + render_assignment(assignment)
    )
    return [{"role": "user", "content": content}]


# What a student asking an agent (coding assistant in Jupyter) would get: the notebook plus a kernel.
def agent_messages(assignment: Assignment, max_steps: int) -> list[dict]:
    content = (
        "Here is my assignment, a Jupyter notebook. Please solve it completely.\n"
        "You can run Python code with the run_python tool. It runs in a Jupyter kernel started in the notebook's "
        "folder, so the data files are there, and variables are kept between runs. Nothing has been run yet. "
        f"Use the tool to run the notebook's code, check your answers and fix errors (at most {max_steps} runs).\n"
        f"When you are done, reply with your final answers. {ANSWER_FORMAT}\n\n---\n\n"
        + render_assignment(assignment)
    )
    return [{"role": "user", "content": content}]


AGENT_LIMIT_REACHED = "You have used all your code runs. Reply with your final answers now, in the format asked for."

RUN_PYTHON_TOOL = {
    "type": "function",
    "function": {
        "name": "run_python",
        "description": "Run Python code in the notebook's Jupyter kernel. Returns printed output, results and errors.",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "The Python code to run."},
                "answer_field": {
                    "type": "integer",
                    "description": "Number of the answer field you are working on (0 for general setup).",
                },
            },
            "required": ["code", "answer_field"],
        },
    },
}


_ANSWER_HEADING = re.compile(
    r"^\s{0,3}#{1,6}\s*\**\s*(?:answer|question|q)\s*(?:field\s*)?(?:to\s+question\s+)?(\d+)\b.*$", re.I | re.M
)


def split_whole_answer(text: str, n_questions: int) -> dict[int, str] | None:
    """Split a whole-assignment answer into {question_number: answer}. None if it can't be split."""
    matches = [m for m in _ANSWER_HEADING.finditer(text) if 1 <= int(m.group(1)) <= n_questions]
    if not matches:
        return None
    result: dict[int, str] = {}
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        number = int(m.group(1))
        chunk = text[m.end() : end].strip()
        result[number] = (result[number] + "\n\n" + chunk).strip() if number in result else chunk
    return result


# --- Grader -------------------------------------------------------------------------------------

GRADER_SYSTEM = (
    "You are an experienced, strict but fair university grader. "
    "You compare a student's answer to the instructor's reference answer or rubric and award points. "
    "Award partial credit where the rubric allows it. Do not reward length or confident tone, only correctness "
    "and completeness relative to the reference. Respond with JSON only."
)


def _context(assignment: Assignment, limit: int = 6000) -> str:
    """Non-question cells (markdown and code), shortened, as background for grader and advisor."""
    text = "\n\n".join(
        f"```python\n{c.question}\n```" if c.type == "code" else c.question
        for c in assignment.cells
        if c.type in ("context", "code") and c.question.strip()
    )
    return text if len(text) <= limit else text[:limit] + "\n[...]"


def grade_text_messages(cell: Cell, answer: str, context: str) -> list[dict]:
    content = (
        (f"Assignment context:\n{context}\n\n" if context else "")
        + f"Question ({format_points(cell.points)}):\n{render_cell(cell)}\n\n"
        f"Reference answer / rubric:\n{cell.reference.strip()}\n\n"
        f"Student answer:\n{answer.strip() or '(empty)'}\n\n"
        f'Return JSON: {{"score": <number between 0 and {cell.points:g}>, "feedback": "<1-2 sentences: what was right/missing>"}}'
    )
    return [{"role": "system", "content": GRADER_SYSTEM}, {"role": "user", "content": content}]


def _outputs_text(execution: dict | None, limit: int = 3000) -> str:
    """Outputs of executed code as text for the grader (plots are mentioned, not shown)."""
    if not execution:
        return "(not run)"
    parts = []
    for o in execution.get("outputs", []):
        kind = o.get("output_type")
        if kind == "stream":
            parts.append(o.get("text", ""))
        elif kind in ("execute_result", "display_data"):
            data = o.get("data", {})
            images = [m for m in data if m.startswith("image/")]
            parts.append("[plot/image]" if images else str(data.get("text/plain", "")))
        elif kind == "error":
            parts.append(f"{o.get('ename')}: {o.get('evalue')}")
    if execution.get("timed_out"):
        parts.append("[stopped: time limit]")
    text = "\n".join(p.strip() for p in parts if p and p.strip()) or "(no output)"
    return text if len(text) <= limit else text[:limit] + "\n[...]"


def grade_code_messages(cell: Cell, code: str, execution: dict | None, reference: str, reference_execution: dict | None) -> list[dict]:
    content = (
        f"Coding question ({format_points(cell.points)}):\n{cell.question.strip()}\n\n"
        f"Reference solution:\n```python\n{reference}\n```\n\nIts output:\n{_outputs_text(reference_execution)}\n\n"
        f"Student code:\n```python\n{code.strip() or '(empty)'}\n```\n\nIts output when run in the notebook:\n{_outputs_text(execution)}\n\n"
        "Judge whether the student's code solves the task as well as the reference does (it need not be identical). "
        "Code that does not run, or produces wrong results, gets little or no credit.\n"
        f'Return JSON: {{"score": <number between 0 and {cell.points:g}>, "feedback": "<1-2 sentences: what was right/missing>"}}'
    )
    return [{"role": "system", "content": GRADER_SYSTEM}, {"role": "user", "content": content}]


def extract_choice_messages(cell: Cell, answer: str) -> list[dict]:
    content = (
        f"Multiple-choice question:\n{render_cell(cell)}\n\n"
        f"Answer given:\n{answer.strip() or '(empty)'}\n\n"
        "Which option letter(s) does this answer pick as its final answer? "
        'Return JSON only: {"selected": ["A", ...]} (empty list if no clear choice).'
    )
    return [{"role": "user", "content": content}]


def parse_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"No JSON in grader response: {text[:200]}")
    return json.loads(match.group(0))


def letters_to_indices(letters: list, n_options: int) -> list[int]:
    n_options = n_options or 8
    indices = set()
    for letter in letters:
        letter = str(letter).strip().upper()[:1]
        if letter and letter in LETTERS[:n_options]:
            indices.add(LETTERS.index(letter))
    return sorted(indices)


# --- Hardening advisor --------------------------------------------------------------------------

HARDEN_SYSTEM = """You advise university instructors in AI and data science on assessment design in the age of generative AI.
Given one assignment question and how AI models answered it, you:
1. Briefly explain why the AI did well (or where it struggled) - 2-3 bullet points, concrete.
2. Suggest 2-3 concrete rewrites or alternative assessment ideas for THIS question that make answering it with AI alone (no understanding) less effective or that make understanding visible. Prefer: tying the question to course-specific context or data, per-student parameters, critique of provided (flawed) work, predict-then-verify, justification of decisions, short oral follow-ups. For each suggestion, give the reworded question or a sketch of it.
Never suggest hidden text, prompt-injection traps or other tricks that harm accessibility or fairness.
Be concise. Use Markdown with the headings '### Why AI does well' and '### Suggestions'."""


def harden_messages(assignment: Assignment, cell: Cell, answers_summary: str) -> list[dict]:
    context = _context(assignment)
    content = (
        f"Assignment: {assignment.title}\n\n"
        + (f"Assignment context:\n{context}\n\n" if context else "")
        + f"Question ({cell.type}, {format_points(cell.points)}):\n{render_cell(cell)}\n\n"
        + (f"Reference answer / rubric:\n{cell.reference}\n\n" if cell.reference.strip() else "")
        + (f"Correct option(s): {', '.join(LETTERS[i] for i in cell.correct)}\n\n" if cell.type == "mcq" and cell.correct else "")
        + f"AI answers:\n{answers_summary or '(none yet)'}"
    )
    return [{"role": "system", "content": HARDEN_SYSTEM}, {"role": "user", "content": content}]
