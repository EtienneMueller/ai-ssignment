# AI-ssignment

A JupyterLab extension for writing assignments while seeing, under every question, what a student who **only uses AI** would hand in and what grade that would get.

The goal is not to make assignments "AI-proof". It is to show educators how much AI can already do, so they can choose evaluation strategies that still measure understanding.

## Install

```bash
uv tool install aissignment    # or: pip install aissignment
aissignment                    # starts JupyterLab with the extension
```

Until there's a PyPI release, install the wheel from a [GitHub release](../../releases) instead:

```bash
uv tool install https://github.com/EtienneMueller/ai-ssignment/releases/download/v0.1.0/aissignment-0.1.0-py3-none-any.whl
```

This installs JupyterLab and all dependencies. No Node.js is needed. If you already use JupyterLab ≥ 4.3, run `pip install` into that environment and use `jupyter lab` as usual.

**API key:** open the AI-ssignment sidebar (graduation-cap icon on the right) and paste your [OpenRouter](https://openrouter.ai/keys) key. Keys are stored in `~/.aissignment/.env`.

## Writing an assignment

Open any notebook and use the sidebar, or the cell context menu / command palette (_AI-ssignment_):

- **Questions → + Text / + Multiple choice / + Code** inserts the cells of a question:
  - a **question cell**, with the question in Markdown. For multiple choice, write the options as `- A) …`, `- B) …`.
  - a **reference answer cell** below it, with your solution or rubric. For multiple choice, write `Correct: B`. This cell is removed from the student version.
  - for **code questions**: a **reference solution** code cell (your solution between `### BEGIN SOLUTION` / `### END SOLUTION`; code outside the markers is starter code students get) and an optional **tests** cell with `assert`s. Tests between `### BEGIN HIDDEN TESTS` / `### END HIDDEN TESTS` are removed from the student version.
- **Make active cell a question** turns an existing Markdown cell into a question.
- All other cells (Markdown, code) are context.

Under each question, the **AI-only preview** shows:

- the answers of the selected student models. Use ‹ › to step through models and runs.
- a score from the grader model, once a reference answer exists.
- **Run** and **💡** (why AI does well, and how to rework the question).
- the question type and points.

### Code questions

The AI students' code is run to see what it really does:

- in a **separate kernel** (never yours), in the notebook's folder so data files are found, with a 60-second limit per cell. You are asked once before AI-written code runs on your computer.
- first the notebook's own code cells above the question (and the reference solutions of earlier code questions), then the AI's code, then your tests.
- The preview shows the AI's code, its output (text, tables, plots, errors) and which tests passed.
- **Grading:** with tests, score = points × share of tests passed. Without tests, the grader model compares the code and its output with your solution and its output.

The package includes numpy, pandas, matplotlib and scikit-learn, so typical data-science code runs out of the box. The code runs with the notebook's kernel.

`examples/demo_code_assignment.ipynb` is a small example (with a synthetic `customer_churn.csv`).

When you change a question, its answers are marked outdated. The AI is only called when you press **Run** (one question) or **Run all questions**, never by itself.

## Sidebar

- **Student type:**
  - _Copy-paste_ students paste each question on its own and never see context cells.
  - _Whole notebook_ students paste everything; answer cells become numbered "YOUR ANSWER HERE" fields.
  - _Agent_ students get the whole notebook plus a Python kernel (separate from yours, in the notebook's folder). They run code, read the outputs and errors, fix their answers and then hand in, with at most 4 code runs per question and 24 per notebook (change this under Advanced settings → Agent students). The preview shows the code each one ran per question. Their code answers are then checked like all others. The model needs tool calling.
- **Providers and student models** (several allowed): see [Models and providers](#models-and-providers).
- **Grader model**, **runs per model** (1× / 3×).
- **Run all questions** with a cost estimate (for agents: the maximum), and the session's spend.
- While a run is going: what it is doing (for agents: which question, code run x of max y), what it has cost so far, and **Stop**. Copy-paste mode answers 3 questions at a time; the others show ⏳ _Queued_. Reloading or closing the page also stops a run.
- **Advanced settings → Clear AI from notebook:** remove all AI answers, or all 💡 suggestions. For a single question, use 🗑 (answers) or ✕ (suggestions) in its preview.
- **AI-only grade** per model, shown once every question has a reference answer. Red = the AI alone does well.
- **Export** writes `<notebook>_export/`:
  - `*_student.ipynb` / `.pdf`: answer cells replaced by empty answer fields, no AI results.
  - `*_instructor.ipynb` / `.pdf`: with reference answers, no AI results.

  The first PDF export downloads a headless Chromium (~100 MB, once).

## Notebook format (nbgrader-compatible)

| Cell             | `metadata.aissignment`                           | `metadata.nbgrader`                                    |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Question         | `role: "question"`, `type`, `points`, AI results | read-only cell (`locked: true`)                        |
| Reference answer | `role: "answer"`                                 | manually graded answer (`solution`, `grade`, `points`) |

AI results are stored in the notebook, so they survive saving and reopening.

Since the cells follow nbgrader conventions, nbgrader's `generate_assignment` and manual grading also work on these notebooks. Code cells can use nbgrader's `### BEGIN SOLUTION` / `### END SOLUTION` markers; the student export replaces those regions.

## Models and providers

Any OpenAI-compatible endpoint works. Out of the box there is **OpenRouter** with a few current models. Everything is managed in the sidebar's _AI students_ section:

- **API key:** paste it into the field under the provider. ✎ changes it later.
- **Models:** tick the ones that act as students. _+ Add model_ suggests the endpoint's models as you type; ✕ (on hover) removes one from the list.
- **+ Add provider:** name, base URL (usually ending in `/v1`) and API key, e.g. for a model server hosted by your university. The connection is tested before saving. ✎ edits or removes it.

Prices come from the endpoint's model list (OpenRouter publishes them); models without pricing count as $0.

Settings are stored per computer, never in notebooks:

- `~/.aissignment/providers.json`: providers and models. It replaces the built-in `aissignment/default_providers.json`.
- `~/.aissignment/.env`: API keys (only readable by you).

_Advanced settings_ at the bottom of the sidebar also has the cost threshold for the confirmation dialog, a checked editor for `providers.json`, and _Reset to defaults_.

## Development

Requires [uv](https://docs.astral.sh/uv/) and Node.js.

```bash
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
jupyter labextension develop . --overwrite
jupyter server extension enable aissignment
jlpm build            # or: jlpm watch   (rebuild on change; reload the browser)
jupyter lab examples/demo_assignment.ipynb
```

Python changes need a JupyterLab restart. Releases: bump `version` in `package.json`, then push a tag `vX.Y.Z`. The _Release_ workflow attaches a wheel to the GitHub release.

The earlier standalone web app (FastAPI + React) is preserved as git tag `v1-standalone` / branch `standalone-v1`.
