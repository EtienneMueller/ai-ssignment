/**
 * Assignment structure on top of a notebook (nbgrader-compatible):
 *
 *   question cell  markdown, metadata.aissignment.role = "question" (type, points, AI results),
 *                  nbgrader read-only cell. MCQ options are written in the markdown ("- A) ...").
 *   answer cell    markdown right after it, metadata.aissignment.role = "answer",
 *                  nbgrader manually graded answer. Holds the reference answer / rubric
 *                  (MCQ: "Correct: B"). Replaced by "YOUR ANSWER HERE" in the student version.
 *   code questions the answer cell is a code cell with the reference solution between
 *                  ### BEGIN SOLUTION / ### END SOLUTION (nbgrader autograded answer), optionally
 *                  followed by a tests cell (role = "tests", nbgrader autograder tests) with asserts.
 *
 * All other cells are context: markdown and code that only whole-assignment students see.
 */
import { ICellModel } from '@jupyterlab/cells';
import { INotebookModel } from '@jupyterlab/notebook';

import {
  IApiAssignment,
  IApiCell,
  ICellMeta,
  IResults,
  QuestionType
} from './types';

export const META = 'aissignment';
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface IQuestion {
  /** id of the question cell model; also the id sent to the server */
  id: string;
  number: number;
  type: QuestionType;
  points: number;
  prompt: ICellModel;
  answer: ICellModel | null;
  /** code questions: the tests cell after the answer cell */
  tests: ICellModel | null;
}

export const getMeta = (cell: ICellModel): ICellMeta =>
  (cell.getMetadata(META) as ICellMeta) ?? {};

export function setMeta(cell: ICellModel, patch: Partial<ICellMeta>): void {
  const next: ICellMeta = { ...getMeta(cell), ...patch };
  for (const key of Object.keys(next) as (keyof ICellMeta)[]) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  cell.setMetadata(META, next);
}

const source = (cell: ICellModel | null) => cell?.sharedModel.getSource() ?? '';

function cellsOf(model: INotebookModel): ICellModel[] {
  const cells: ICellModel[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    cells.push(model.cells.get(i));
  }
  return cells;
}

export function findQuestions(model: INotebookModel): IQuestion[] {
  const cells = cellsOf(model);
  const questions: IQuestion[] = [];
  cells.forEach((cell, i) => {
    const meta = getMeta(cell);
    if (meta.role !== 'question') {
      return;
    }
    const next = cells[i + 1];
    const answer = next && getMeta(next).role === 'answer' ? next : null;
    const after = answer ? cells[i + 2] : undefined;
    const tests = after && getMeta(after).role === 'tests' ? after : null;
    questions.push({
      id: cell.id,
      number: questions.length + 1,
      type: meta.type ?? 'text',
      points: meta.points ?? 1,
      prompt: cell,
      answer,
      tests
    });
  });
  return questions;
}

/** Which question (if any) a cell belongs to. */
export function questionOf(
  model: INotebookModel,
  cell: ICellModel
): IQuestion | undefined {
  return findQuestions(model).find(
    q => q.prompt === cell || q.answer === cell || q.tests === cell
  );
}

/** Prompt has more than the inserted template ("**Question:**", empty options). */
export function hasQuestionText(q: IQuestion): boolean {
  const text = q.prompt.sharedModel
    .getSource()
    .replace(/\*\*Question:\*\*/g, '')
    .replace(/^\s*[-*+]?\s*\(?[A-Z][).:]\s*$/gm, '');
  return text.trim().length > 0;
}

// --- MCQ parsing -------------------------------------------------------------------------------

const OPTION_LINE = /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s*)?\(?([A-Z])[).:]\s+(.*)$/;

/** Options written as "- A) text", "A. text", "(A) text", ... in consecutive letter order. */
export function parseOptions(markdown: string): string[] {
  const options: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = OPTION_LINE.exec(line);
    if (m && m[1] === LETTERS[options.length]) {
      options.push(m[2].trim());
    }
  }
  return options;
}

/** Correct letters from the answer cell: "Correct: B, D" or just "B". */
export function parseCorrect(markdown: string, nOptions: number): number[] {
  const text = markdown.replace(/[*_`]/g, '');
  const labelled = /correct[^:\n]*:\s*([^\n]*)/i.exec(text);
  const candidates = labelled
    ? labelled[1]
    : text.trim().length <= 20
      ? text
      : '';
  const letters = candidates.match(/\b[A-Z]\b/g) ?? [];
  const max = nOptions || LETTERS.length;
  return [...new Set(letters.map(l => LETTERS.indexOf(l)))]
    .filter(i => i >= 0 && i < max)
    .sort();
}

// --- Payload ------------------------------------------------------------------------------------

export function questionToApi(q: IQuestion): IApiCell {
  const question = source(q.prompt);
  const options = q.type === 'mcq' ? parseOptions(question) : [];
  const reference = source(q.answer);
  return {
    id: q.id,
    type: q.type === 'code' ? 'code_question' : q.type,
    question,
    options,
    correct: q.type === 'mcq' ? parseCorrect(reference, options.length) : [],
    reference: q.type === 'mcq' ? '' : reference,
    tests: source(q.tests),
    points: q.points
  };
}

/** Code without comments, blank lines and solution markers (empty = nothing written yet). */
export function hasCode(code: string): boolean {
  return code
    .split('\n')
    .some(line => line.trim() && !line.trim().startsWith('#'));
}

export function buildAssignment(
  model: INotebookModel,
  title: string
): IApiAssignment {
  const byPrompt = new Map(findQuestions(model).map(q => [q.prompt, q]));
  const cells: IApiCell[] = [];
  for (const cell of cellsOf(model)) {
    const q = byPrompt.get(cell);
    if (q) {
      cells.push(questionToApi(q));
    } else if (
      !getMeta(cell).role &&
      cell.type !== 'raw' &&
      source(cell).trim()
    ) {
      cells.push({
        id: cell.id,
        type: cell.type === 'code' ? 'code' : 'context',
        question: source(cell),
        options: [],
        correct: [],
        reference: '',
        tests: '',
        points: 0
      });
    }
  }
  return { title, cells };
}

// --- Staleness ----------------------------------------------------------------------------------

/** What the student model sees of this question. */
export const questionSnapshot = (q: IQuestion) =>
  JSON.stringify([q.type, source(q.prompt)]);

/** What grading depends on (besides the answer). */
export const gradingSnapshot = (q: IQuestion) =>
  JSON.stringify([
    q.type,
    source(q.prompt),
    source(q.answer),
    q.points,
    ...(q.tests ? [source(q.tests)] : [])
  ]);

/** What a whole-assignment student sees. */
export const assignmentSnapshot = (a: IApiAssignment) =>
  JSON.stringify(a.cells.map(c => [c.type, c.question, c.points]));

export const resultsOf = (q: IQuestion): IResults | undefined =>
  getMeta(q.prompt).results;

export function isGradable(q: IQuestion): boolean {
  const api = questionToApi(q);
  if (q.type === 'code') {
    return hasCode(api.tests) || hasCode(api.reference);
  }
  return q.type === 'mcq'
    ? api.correct.length > 0
    : api.reference.trim().length > 0;
}

export const answersStale = (q: IQuestion) => {
  const r = resultsOf(q);
  return !!r && r.snapshot !== questionSnapshot(q);
};

export const gradeStale = (
  q: IQuestion,
  grade: { snapshot?: string } | null | undefined
) => !!grade && grade.snapshot !== gradingSnapshot(q);

/** Has current answers, but at least one gradable answer has no (current) grade. */
export function needsRegrade(q: IQuestion): boolean {
  const r = resultsOf(q);
  return (
    !!r &&
    !answersStale(q) &&
    isGradable(q) &&
    r.answers.some(
      a => a.text && (!a.grade || a.grade.error || gradeStale(q, a.grade))
    )
  );
}

// --- Editing ------------------------------------------------------------------------------------

const newId = () => Math.random().toString(36).slice(2, 10);

const TEMPLATES: Record<QuestionType, { prompt: string; answer: string }> = {
  text: { prompt: '**Question:** ', answer: '' },
  mcq: {
    prompt: '**Question:** \n\n- A) \n- B) \n- C) \n- D) ',
    answer: 'Correct: '
  },
  code: {
    prompt: '**Question:** ',
    answer:
      '# Code outside the markers is starter code that students get.\n### BEGIN SOLUTION\n\n### END SOLUTION'
  }
};

const TESTS_TEMPLATE =
  "# Tests run after the student's code; each assert counts as one test, e.g.\n" +
  '# assert result == 42\n\n' +
  '### BEGIN HIDDEN TESTS\n# Tests here are removed from the student version.\n### END HIDDEN TESTS';

function nbgraderPrompt(gradeId: string) {
  return {
    grade: false,
    solution: false,
    locked: true,
    task: false,
    grade_id: `${gradeId}-prompt`,
    schema_version: 3
  };
}

/** nbgrader "autograded answer": the solution cell of a code question. */
function nbgraderCodeAnswer(gradeId: string) {
  return {
    grade: false,
    solution: true,
    locked: false,
    task: false,
    grade_id: gradeId,
    schema_version: 3
  };
}

/** nbgrader "autograder tests" cell. */
function nbgraderTests(gradeId: string, points: number) {
  return {
    grade: true,
    solution: false,
    locked: true,
    task: false,
    points,
    grade_id: `${gradeId}-tests`,
    schema_version: 3
  };
}

function answerCell(type: QuestionType, gradeId: string, points: number) {
  return type === 'code'
    ? {
        cell_type: 'code',
        source: TEMPLATES.code.answer,
        metadata: {
          [META]: { role: 'answer' },
          nbgrader: nbgraderCodeAnswer(gradeId)
        },
        outputs: [],
        execution_count: null
      }
    : {
        cell_type: 'markdown',
        source: TEMPLATES[type].answer,
        metadata: {
          [META]: { role: 'answer' },
          nbgrader: nbgraderAnswer(gradeId, points)
        }
      };
}

function testsCell(gradeId: string, points: number) {
  return {
    cell_type: 'code',
    source: TESTS_TEMPLATE,
    metadata: {
      [META]: { role: 'tests' },
      nbgrader: nbgraderTests(gradeId, points)
    },
    outputs: [],
    execution_count: null
  };
}

function nbgraderAnswer(gradeId: string, points: number) {
  return {
    grade: true,
    solution: true,
    locked: false,
    task: false,
    points,
    grade_id: gradeId,
    schema_version: 3
  };
}

/** Insert a question + answer cell pair (code: + tests cell) at `index`. Returns the index of the question cell. */
export function insertQuestion(
  model: INotebookModel,
  index: number,
  type: QuestionType,
  prompt?: string
): number {
  const gradeId = `q-${newId()}`;
  model.sharedModel.insertCells(index, [
    {
      cell_type: 'markdown',
      source: prompt ?? TEMPLATES[type].prompt,
      metadata: {
        [META]: { role: 'question', type, points: 1 },
        nbgrader: nbgraderPrompt(gradeId)
      }
    },
    answerCell(type, gradeId, 1),
    ...(type === 'code' ? [testsCell(gradeId, 1)] : [])
  ]);
  return index;
}

/** Turn an existing markdown cell into a question (adds the answer cell below). */
export function convertToQuestion(
  model: INotebookModel,
  index: number,
  type: QuestionType
): boolean {
  const cell = model.cells.get(index);
  if (!cell || cell.type !== 'markdown' || getMeta(cell).role) {
    return false;
  }
  const text = source(cell);
  model.sharedModel.deleteCell(index);
  insertQuestion(model, index, type, text);
  return true;
}

export function setPoints(q: IQuestion, points: number): void {
  setMeta(q.prompt, { points });
  // nbgrader keeps the points on the graded cell: the tests cell for code questions.
  const graded = q.type === 'code' ? q.tests : q.answer;
  if (graded) {
    const nbg =
      (graded.getMetadata('nbgrader') as Record<string, unknown>) ?? {};
    graded.setMetadata('nbgrader', { ...nbg, points });
  }
}

export function setType(q: IQuestion, type: QuestionType): void {
  setMeta(q.prompt, { type });
  if (type === 'mcq' && q.answer && !source(q.answer).trim()) {
    q.answer.sharedModel.setSource('Correct: ');
  }
}

/** Add a missing answer cell below the question. */
export function addAnswerCell(model: INotebookModel, q: IQuestion): void {
  const index = cellsOf(model).indexOf(q.prompt);
  model.sharedModel.insertCell(
    index + 1,
    answerCell(q.type, `q-${newId()}`, q.points)
  );
}

/** Add a tests cell below a code question's answer cell. */
export function addTestsCell(model: INotebookModel, q: IQuestion): void {
  if (!q.answer) {
    return;
  }
  const index = cellsOf(model).indexOf(q.answer);
  const nbg = q.answer.getMetadata('nbgrader') as
    { grade_id?: string } | undefined;
  model.sharedModel.insertCell(
    index + 1,
    testsCell(nbg?.grade_id ?? `q-${newId()}`, q.points)
  );
}
