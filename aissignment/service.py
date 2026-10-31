"""Simulated AI-only students, grading and hardening suggestions."""

import asyncio
import json
from pathlib import Path

from . import executor, jobs, prompts
from .models import Answer, Assignment, Cell, Grade, GradeRequest, HardenRequest, RunRequest, Workspace
from .nbcode import extract_code, solution_body
from .providers import chat, complete


def error_text(e: Exception) -> str:
    message = getattr(e, "message", None) or str(e)
    return f"{type(e).__name__}: {message}"[:500]


async def _ask(model: str, messages: list[dict]) -> tuple[str, float, str | None]:
    try:
        result = await complete(model, messages)
        return result.text, result.cost, None
    except Exception as e:
        return "", 0.0, error_text(e)


def _with_code(cell: Cell, answer: Answer) -> Answer:
    """Code questions: the code the student copies from the reply into the cell."""
    if cell.type == "code_question" and answer.text and not answer.error:
        answer.code = extract_code(answer.text)
        if answer.code is None:
            answer.error = "No code found in the answer."
    return answer


async def _copy_paste(cell: Cell, model: str, run: int) -> Answer:
    text, cost, error = await _ask(model, prompts.copy_paste_messages(cell))
    return _with_code(cell, Answer(model=model, run=run, mode="copy", text=text, cost=cost, error=error))


def _split(
    assignment: Assignment, model: str, run: int, mode: str, text: str, cost: float, error: str | None
) -> dict[str, Answer]:
    """One reply for the whole notebook -> {cell_id: Answer}."""
    questions = assignment.question_cells()
    parts = prompts.split_whole_answer(text, len(questions)) if text else None
    answers = {}
    for number, cell in enumerate(questions, start=1):
        if error:
            answers[cell.id] = Answer(model=model, run=run, mode=mode, text=text, error=error)
        elif parts is None:
            answers[cell.id] = Answer(
                model=model,
                run=run,
                mode=mode,
                text=text,
                error="Could not split the answer into questions; showing the full response."
                if text
                else "The model did not hand in any answers.",
            )
        else:
            answers[cell.id] = _with_code(
                cell,
                Answer(
                    model=model,
                    run=run,
                    mode=mode,
                    text=parts.get(number, ""),
                    error=None if number in parts else "The model skipped this question.",
                ),
            )
    # Spread the cost of the notebook-level calls over the questions so per-cell sums stay meaningful.
    for a in answers.values():
        a.cost = cost / max(len(answers), 1)
    return answers


async def _whole(assignment: Assignment, model: str, run: int) -> dict[str, Answer]:
    text, cost, error = await _ask(model, prompts.whole_assignment_messages(assignment))
    return _split(assignment, model, run, "whole", text, cost, error)


async def _agent(
    assignment: Assignment, model: str, run: int, workdir: Path | None, kernel: str | None, budget: int
) -> dict[str, Answer]:
    """Agent student: gets the notebook and a kernel, runs code until it is satisfied, then hands in."""
    questions = assignment.question_cells()
    messages = prompts.agent_messages(assignment, budget)
    steps: list[dict] = []
    status = {"model": model, "run": run, "step": 0, "max": budget, "field": None}
    if (progress := jobs.current.get()) is not None:
        progress.agents[f"{model}#{run}"] = status
    text, cost, error = "", 0.0, None
    try:
        async with executor.Session(workdir, kernel) as session:
            while True:
                done = len(steps) >= budget
                if done:
                    messages.append({"role": "user", "content": prompts.AGENT_LIMIT_REACHED})
                reply = await chat(
                    model, messages, tools=[prompts.RUN_PYTHON_TOOL], tool_choice="none" if done else "auto"
                )
                cost += reply.cost
                calls = reply.message.get("tool_calls") or []
                if not calls or done:
                    text = (reply.message.get("content") or "").strip()
                    break
                messages.append(reply.message)
                for call in calls:
                    result = await _tool(session, call, steps, budget, status)
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    except Exception as e:
        error = error_text(e)
    answers = _split(assignment, model, run, "agent", text, cost, error)
    for number, cell in enumerate(questions, start=1):
        # Steps for general setup (or without a valid answer field) are shown with the first question.
        own = [s for s in steps if s["field"] == number or (number == 1 and not 1 <= s["field"] <= len(questions))]
        answers[cell.id].steps = [{"code": s["code"], "outputs": s["outputs"]} for s in own]
        answers[cell.id].steps_total = len(steps)
    return answers


async def _tool(session: executor.Session, call: dict, steps: list[dict], budget: int, status: dict) -> str:
    """Run one run_python call; returns what the agent reads back."""
    function = call.get("function") or {}
    if function.get("name") != "run_python":
        return f"Unknown tool '{function.get('name')}'. The only tool is run_python."
    if len(steps) >= budget:
        return "Not run: you have used all your code runs."
    try:
        args = json.loads(function.get("arguments") or "{}")
        code = str(args["code"])
    except (ValueError, KeyError, TypeError):
        return 'Could not read the arguments. Call run_python with {"code": "...", "answer_field": N}.'
    try:
        field = int(args.get("answer_field") or 0)
    except (TypeError, ValueError):
        field = 0
    status.update(step=len(steps) + 1, field=field)
    outputs = await session.run(code)
    steps.append({"field": field, "code": code, "outputs": executor.prune_step(outputs)})
    return executor.as_text(outputs)


def is_gradable(cell: Cell) -> bool:
    if cell.type == "code_question":
        return bool(cell.tests.strip() or solution_body(cell.reference))
    return bool(cell.correct) if cell.type == "mcq" else bool(cell.reference.strip())


def _workdir(ws: Workspace, root: Path | None) -> Path | None:
    """The notebook's folder (code answers run there, so data files are found)."""
    if root is None or not ws.notebook_path:
        return root
    folder = (root / ws.notebook_path).resolve().parent
    return folder if folder == root or root in folder.parents else root


async def execute_answer(assignment: Assignment, cell: Cell, answer: Answer, workdir: Path | None, kernel: str | None):
    """Run a code answer in a fresh kernel: the notebook's code above it, the answer, then the tests."""
    if cell.type != "code_question" or answer.code is None:
        return
    try:
        result = await executor.execute(workdir, kernel, assignment.setup_code(cell.id), answer.code, cell.tests)
        answer.execution = result.as_dict()
    except Exception as e:  # kernel did not start, ...
        answer.execution = {"outputs": [], "error": None, "setup_error": f"Could not run the code: {error_text(e)}"}


async def _grade_code(
    assignment: Assignment, cell: Cell, answer: Answer, grader: str, workdir: Path | None, kernel: str | None
) -> None:
    run = answer.execution or {}
    if run.get("setup_error"):
        answer.grade = Grade(max=cell.points, grader=grader, error=f"The notebook's own code failed: {run['setup_error']}")
        return
    tests = run.get("tests")
    if tests:
        passed = sum(t["passed"] for t in tests)
        failed = next((t for t in tests if not t["passed"]), None)
        answer.grade = Grade(
            score=cell.points * passed / len(tests),
            max=cell.points,
            grader="tests",
            feedback=f"Passed {passed} of {len(tests)} test{'s' if len(tests) != 1 else ''}."
            + (f" First failure: {failed['error'] or 'failed'}" if failed else ""),
        )
        return
    has_output = any(o.get("output_type") != "error" for o in run.get("outputs", []))
    if run.get("error") and not has_output:
        answer.grade = Grade(score=0, max=cell.points, grader="tests", feedback=f"The code does not run: {run['error']}")
        return
    reference = solution_body(cell.reference)
    ref_run = await executor.execute_reference(workdir, kernel, assignment.setup_code(cell.id), reference)
    result = await complete(
        grader, prompts.grade_code_messages(cell, answer.code or "", run, reference, ref_run.as_dict())
    )
    data = prompts.parse_json(result.text)
    score = min(max(float(data.get("score", 0)), 0), cell.points)
    answer.grade = Grade(
        score=score, max=cell.points, feedback=str(data.get("feedback", "")), grader=grader, cost=result.cost
    )


async def grade(
    assignment: Assignment,
    cell: Cell,
    answer: Answer,
    grader: str,
    workdir: Path | None = None,
    kernel: str | None = None,
) -> Answer:
    if not is_gradable(cell) or (answer.error and not answer.text):
        return answer
    try:
        if cell.type == "code_question":
            if answer.code is None:
                answer.grade = Grade(score=0, max=cell.points, grader="tests", feedback="No code in the answer.")
            else:
                await _grade_code(assignment, cell, answer, grader, workdir, kernel)
            return answer
        if cell.type == "mcq":
            result = await complete(grader, prompts.extract_choice_messages(cell, answer.text))
            selected = prompts.letters_to_indices(prompts.parse_json(result.text).get("selected", []), len(cell.options))
            answer.selected = selected
            correct = selected == sorted(cell.correct)
            answer.grade = Grade(
                score=cell.points if correct else 0,
                max=cell.points,
                grader=grader,
                feedback="Correct." if correct else "Incorrect choice.",
            )
        else:
            result = await complete(
                grader, prompts.grade_text_messages(cell, answer.text, prompts._context(assignment))
            )
            data = prompts.parse_json(result.text)
            score = min(max(float(data.get("score", 0)), 0), cell.points)
            answer.grade = Grade(score=score, max=cell.points, feedback=str(data.get("feedback", "")), grader=grader)
        answer.grade.cost = result.cost
    except Exception as e:
        answer.grade = Grade(max=cell.points, grader=grader, error=error_text(e))
    return answer


async def run(req: RunRequest, root: Path | None = None) -> dict[str, list[Answer]]:
    """Returns {cell_id: [Answer, ...]} for the affected question cells."""
    assignment = req.assignment
    runs = max(1, min(req.runs, 5))
    results: dict[str, list[Answer]] = {}

    workdir = _workdir(req, root)
    progress = jobs.current.get()
    if req.mode in ("whole", "agent"):
        n = len(assignment.question_cells())
        budget = min(max(req.agent_steps_per_question, 1) * n, max(req.agent_max_steps, 1), 100)
        students = [
            _whole(assignment, model, run)
            if req.mode == "whole"
            else _agent(assignment, model, run, workdir, req.kernel, budget)
            for model in req.models
            for run in range(1, runs + 1)
        ]
        for answers in await asyncio.gather(*students):
            for cell_id, answer in answers.items():
                results.setdefault(cell_id, []).append(answer)
    else:
        ids = req.cell_ids or [c.id for c in assignment.question_cells()]
        cells = [assignment.cell(i) for i in ids]
        calls = [(c, _copy_paste(c, model, run)) for c in cells for model in req.models for run in range(1, runs + 1)]
        for (cell, _), answer in zip(calls, await asyncio.gather(*(j for _, j in calls))):
            results.setdefault(cell.id, []).append(answer)

    if progress is not None:
        progress.phase = "running code"
    await asyncio.gather(
        *(
            execute_answer(assignment, assignment.cell(cid), a, workdir, req.kernel)
            for cid, answers in results.items()
            for a in answers
        )
    )
    if req.grader:
        if progress is not None:
            progress.phase = "grading"
        await asyncio.gather(
            *(
                grade(assignment, assignment.cell(cid), a, req.grader, workdir, req.kernel)
                for cid, answers in results.items()
                for a in answers
            )
        )
    return results


async def regrade(req: GradeRequest, root: Path | None = None) -> list[Answer]:
    """Grade again (reference or tests changed). Code answers are run again, since the tests may differ."""
    cell = req.assignment.cell(req.cell_id)
    workdir = _workdir(req, root)
    await asyncio.gather(*(execute_answer(req.assignment, cell, a, workdir, req.kernel) for a in req.answers))
    return list(
        await asyncio.gather(*(grade(req.assignment, cell, a, req.grader, workdir, req.kernel) for a in req.answers))
    )


async def harden(req: HardenRequest) -> dict:
    cell = req.assignment.cell(req.cell_id)
    summary = "\n\n".join(
        f"--- {a.model} (run {a.run})"
        + (f", score {a.grade.score:g}/{a.grade.max:g}" if a.grade and a.grade.score is not None else "")
        + f" ---\n{a.text[:3000]}"
        for a in req.answers
        if a.text
    )
    result = await complete(req.model, prompts.harden_messages(req.assignment, cell, summary))
    return {"markdown": result.text, "cost": result.cost}
