"""Student and instructor versions of an assignment notebook (.ipynb and PDF).

Notebook conventions (nbgrader-compatible):
  question prompt cell: markdown, metadata.aissignment.role = "question", nbgrader read-only cell
  answer cell:          markdown, metadata.aissignment.role = "answer", nbgrader manually graded answer
                        (solution + grade + points); its content is the reference answer / rubric
  code questions:       the answer cell is a code cell with the reference solution (nbgrader autograded
                        answer); an optional tests cell (role = "tests") follows, with hidden tests between
                        ### BEGIN HIDDEN TESTS / ### END HIDDEN TESTS
Code cells may contain nbgrader solution regions (### BEGIN SOLUTION / ### END SOLUTION).
"""

import copy
from pathlib import Path

import nbformat

from .nbcode import SOLUTION_REGION, starter_code, visible_tests

META_KEY = "aissignment"
STUDENT_ANSWER = "YOUR ANSWER HERE"


def is_answer_cell(cell) -> bool:
    meta = cell.get("metadata", {})
    if meta.get(META_KEY, {}).get("role") == "answer":
        return True
    nbg = meta.get("nbgrader", {})
    return cell.get("cell_type") == "markdown" and nbg.get("solution", False)


def _role(cell) -> str | None:
    return cell.get("metadata", {}).get(META_KEY, {}).get("role")


def _clear_outputs(cell) -> None:
    cell.outputs = []
    cell.execution_count = None


def _strip_ai_results(nb) -> None:
    for cell in nb.cells:
        meta = cell.get("metadata", {}).get(META_KEY)
        if isinstance(meta, dict):
            meta.pop("results", None)
            meta.pop("hardening", None)
    nb.metadata.pop(META_KEY, None)


def student_version(nb, for_pdf: bool = False):
    nb = copy.deepcopy(nb)
    _strip_ai_results(nb)
    for cell in nb.cells:
        if cell.cell_type == "code" and is_answer_cell(cell):
            cell.source = starter_code(cell.source)
            _clear_outputs(cell)
        elif _role(cell) == "tests":
            cell.source = visible_tests(cell.source)
            _clear_outputs(cell)
        elif is_answer_cell(cell):
            cell.source = (
                '<div style="min-height: 8em; break-inside: avoid; border: 1px solid #bbb; border-radius: 4px; padding: 6px; color: #999">'
                "Your answer</div>"
                if for_pdf
                else STUDENT_ANSWER
            )
        elif cell.cell_type == "code" and SOLUTION_REGION.search(cell.source):
            cell.source = starter_code(cell.source)
            _clear_outputs(cell)
    return nb


def instructor_version(nb, for_pdf: bool = False):
    nb = copy.deepcopy(nb)
    _strip_ai_results(nb)
    if for_pdf:
        for cell in nb.cells:
            if is_answer_cell(cell) and cell.cell_type == "markdown":
                body = cell.source.strip() or "*(no reference answer)*"
                quoted = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
                cell.source = f"> **Reference answer**\n>\n{quoted}"
    return nb


def _pdf(nb, title: str) -> bytes:
    from nbconvert import WebPDFExporter

    exporter = WebPDFExporter(allow_chromium_download=True, exclude_input_prompt=True, exclude_output_prompt=True)
    body, _ = exporter.from_notebook_node(nb, resources={"metadata": {"name": title}})
    return body


def export_targets(path: Path, pdf: bool = True) -> list[Path]:
    """The files export() writes for this notebook, in <name>_export/ next to it."""
    out_dir = path.parent / f"{path.stem}_export"
    names = [f"{path.stem}_student.ipynb", f"{path.stem}_instructor.ipynb"]
    if pdf:
        names += [f"{path.stem}_student.pdf", f"{path.stem}_instructor.pdf"]
    return [out_dir / name for name in names]


def export(path: Path, pdf: bool = True) -> list[str]:
    """Writes the exports to <name>_export/ next to the notebook. Returns the written file paths."""
    nb = nbformat.read(path, as_version=4)
    student_nb, instructor_nb, *pdfs = export_targets(path, pdf)
    student_nb.parent.mkdir(exist_ok=True)

    nbformat.write(student_version(nb), student_nb)
    nbformat.write(instructor_version(nb), instructor_nb)
    if pdf:
        student_pdf, instructor_pdf = pdfs
        student_pdf.write_bytes(_pdf(student_version(nb, for_pdf=True), path.stem))
        instructor_pdf.write_bytes(_pdf(instructor_version(nb, for_pdf=True), f"{path.stem} (instructor)"))
    return [str(p) for p in export_targets(path, pdf)]
