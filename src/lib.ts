import {
  answersStale,
  gradeStale,
  IQuestion,
  isGradable,
  questionToApi,
  resultsOf
} from './notebook';
import { IApiAssignment, IConfig, IModelInfo, ISettings } from './types';

export function modelIndex(
  config: IConfig | null
): Record<string, IModelInfo & { provider: string; available: boolean }> {
  const index: Record<
    string,
    IModelInfo & { provider: string; available: boolean }
  > = {};
  for (const p of config?.providers ?? []) {
    for (const m of p.models) {
      index[m.key] = { ...m, provider: p.name, available: p.available };
    }
  }
  return index;
}

export function shortLabel(key: string, config: IConfig | null): string {
  const m = modelIndex(config)[key];
  const label = m?.label ?? key.split(':').slice(1).join(':');
  return label.replace(/^[^:]+:\s*/, ''); // "Anthropic: Claude Sonnet" -> "Claude Sonnet"
}

export function formatUsd(x: number): string {
  if (x === 0) {
    return '$0';
  }
  if (x < 0.001) {
    return '<$0.001';
  }
  return x < 1 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`;
}

const TOKENS_PER_CHAR = 1 / 3.5;
const ANSWER_TOKENS = 1500; // many current models reason before answering
const GRADE_TOKENS = 300;
// Agents: each call re-sends the conversation so far, which grows with every code run.
const AGENT_STEP_TOKENS = 800; // code written + output read back (at most 2000 characters), per run
const AGENT_STEP_OUTPUT_TOKENS = 400; // code + reasoning written per run

/** Rough USD estimate. Unknown pricing (e.g. university models) counts as 0. */
export function estimateCost(
  assignment: IApiAssignment,
  s: ISettings,
  config: IConfig | null,
  cellIds?: string[]
): number {
  const index = modelIndex(config);
  const price = (key: string, inTok: number, outTok: number) => {
    const p = index[key]?.pricing;
    return p ? inTok * p.prompt + outTok * p.completion : 0;
  };
  const questions = assignment.cells.filter(c =>
    ['text', 'mcq', 'code_question'].includes(c.type)
  );
  const cells =
    s.mode !== 'copy' || !cellIds
      ? questions
      : questions.filter(c => cellIds.includes(c.id));
  let total = 0;
  for (const model of s.students) {
    const notebook =
      assignment.cells.reduce((n, c) => n + c.question.length + 40, 0) *
      TOKENS_PER_CHAR;
    if (s.mode === 'whole') {
      total += price(model, notebook, ANSWER_TOKENS * cells.length);
    } else if (s.mode === 'agent') {
      // The maximum: every agent uses all its code runs. Call k sends the notebook plus k earlier runs.
      const steps = Math.min(
        s.agentStepsPerQuestion * cells.length,
        s.agentMaxSteps
      );
      const input =
        (steps + 1) * notebook +
        AGENT_STEP_TOKENS * ((steps * (steps + 1)) / 2);
      total += price(
        model,
        input,
        AGENT_STEP_OUTPUT_TOKENS * steps + ANSWER_TOKENS * cells.length
      );
    } else {
      for (const c of cells) {
        total += price(
          model,
          c.question.length * TOKENS_PER_CHAR,
          ANSWER_TOKENS
        );
      }
    }
  }
  // Code questions with tests are graded by running them, not by the grader model.
  const graded = cells.filter(c =>
    c.type === 'code_question'
      ? !c.tests.trim() && c.reference.trim()
      : c.reference.trim() || c.correct.length
  );
  for (const c of graded) {
    const inTok =
      (c.question.length + c.reference.length) * TOKENS_PER_CHAR + 600;
    total += s.students.length * price(s.grader, inTok, GRADE_TOKENS);
  }
  return total * s.runs;
}

export type Overall =
  | { kind: 'empty' }
  | { kind: 'missingReferences'; missing: number[]; total: number }
  | {
      kind: 'ready';
      perModel: {
        model: string;
        score: number | null;
        max: number;
        missing: number;
      }[];
    };

export function overallGrade(
  questions: IQuestion[],
  models: string[]
): Overall {
  if (!questions.length) {
    return { kind: 'empty' };
  }
  const missing = questions.filter(q => !isGradable(q)).map(q => q.number);
  if (missing.length) {
    return { kind: 'missingReferences', missing, total: questions.length };
  }
  const max = questions.reduce((n, q) => n + q.points, 0);
  const allModels = [
    ...new Set([
      ...models,
      ...questions.flatMap(q => resultsOf(q)?.answers.map(a => a.model) ?? [])
    ])
  ];
  const perModel = allModels.map(model => {
    let score = 0;
    let missingCells = 0;
    for (const q of questions) {
      const answers = answersStale(q)
        ? []
        : (resultsOf(q)?.answers ?? []).filter(a => a.model === model);
      const graded = answers.filter(
        a => a.grade && a.grade.score !== null && !gradeStale(q, a.grade)
      );
      if (!answers.length || graded.length < answers.length) {
        missingCells++;
      } else {
        score +=
          graded.reduce((n, a) => n + (a.grade!.score ?? 0), 0) / graded.length;
      }
    }
    return {
      model,
      score: missingCells ? null : score,
      max,
      missing: missingCells
    };
  });
  return { kind: 'ready', perModel };
}

export function scoreTone(ratio: number): 'high' | 'mid' | 'low' {
  return ratio >= 0.85 ? 'high' : ratio >= 0.5 ? 'mid' : 'low';
}

/** MCQ correct options of a question, for display. */
export const correctOf = (q: IQuestion) => questionToApi(q).correct;
