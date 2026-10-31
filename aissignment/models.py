from typing import Literal

from pydantic import BaseModel, ConfigDict

# context = markdown cell, code = code cell (both only seen by whole-assignment students);
# text / mcq / code_question = questions
CellType = Literal["context", "code", "text", "mcq", "code_question"]
QUESTION_TYPES = ("text", "mcq", "code_question")
StudentMode = Literal["copy", "whole", "agent"]


class Grade(BaseModel):
    model_config = ConfigDict(extra="allow")

    score: float | None = None
    max: float = 0
    feedback: str = ""
    grader: str = ""
    cost: float = 0
    error: str | None = None


class Answer(BaseModel):
    """One AI 'student' attempt at one cell."""

    model_config = ConfigDict(extra="allow")

    model: str  # "<provider_id>:<model_id>"
    run: int = 1
    mode: StudentMode = "copy"
    text: str = ""
    error: str | None = None
    cost: float = 0
    selected: list[int] | None = None  # MCQ: option indices the answer chose
    code: str | None = None  # code questions: the code the student hands in
    execution: dict | None = None  # code questions: executor.Execution.as_dict()
    steps: list[dict] | None = None  # agent: the code it ran for this question [{code, outputs}]
    steps_total: int | None = None  # agent: code runs for the whole notebook
    grade: Grade | None = None


class Cell(BaseModel):
    """One notebook cell. For questions: question = prompt cell source, reference = answer cell source."""

    model_config = ConfigDict(extra="allow")

    id: str
    type: CellType = "text"
    question: str = ""
    options: list[str] = []
    correct: list[int] = []
    reference: str = ""  # code questions: the solution cell (with ### BEGIN/END SOLUTION markers)
    tests: str = ""  # code questions: the tests cell
    points: float = 1


class Assignment(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str = "Untitled assignment"
    cells: list[Cell] = []

    def question_cells(self) -> list[Cell]:
        return [c for c in self.cells if c.type in QUESTION_TYPES]

    def setup_code(self, cell_id: str) -> list[str]:
        """Code that runs before a code question: the notebook's code cells above it, and the reference
        solutions of earlier code questions (so later questions can build on them)."""
        setup = []
        for c in self.cells:
            if c.id == cell_id:
                break
            if c.type == "code" and c.question.strip():
                setup.append(c.question)
            elif c.type == "code_question" and c.reference.strip():
                setup.append(c.reference)
        return setup

    def cell(self, cell_id: str) -> Cell:
        for c in self.cells:
            if c.id == cell_id:
                return c
        raise KeyError(cell_id)

    def number_of(self, cell_id: str) -> int:
        for i, c in enumerate(self.question_cells(), start=1):
            if c.id == cell_id:
                return i
        raise KeyError(cell_id)


class ExportRequest(BaseModel):
    path: str  # notebook path relative to the Jupyter root
    check: bool = False  # only report which export files already exist


class KeyRequest(BaseModel):
    provider: str
    value: str


class ProviderRequest(BaseModel):
    id: str | None = None  # None = add a new provider
    name: str = ""
    base_url: str = ""
    api_key: str = ""  # empty = keep the stored key


class ModelsRequest(BaseModel):
    provider: str
    add: str | None = None
    remove: str | None = None


class Workspace(BaseModel):
    """Where code answers run: the notebook (for its folder) and its kernel."""

    notebook_path: str | None = None  # relative to the Jupyter root
    kernel: str | None = None


class RunRequest(Workspace):
    assignment: Assignment
    cell_ids: list[str] | None = None  # copy mode only; None = all question cells
    mode: StudentMode = "copy"
    models: list[str]
    runs: int = 1
    grader: str | None = None  # None = skip grading
    job_id: str | None = None  # to watch progress and stop the run
    agent_steps_per_question: int = 4  # agent mode: code runs allowed per question ...
    agent_max_steps: int = 24  # ... and for the whole notebook


class GradeRequest(Workspace):
    assignment: Assignment
    cell_id: str
    answers: list[Answer]
    grader: str


class HardenRequest(BaseModel):
    assignment: Assignment
    cell_id: str
    answers: list[Answer] = []
    model: str
