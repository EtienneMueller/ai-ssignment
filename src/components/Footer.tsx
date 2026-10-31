import { ReactWidget } from '@jupyterlab/ui-components';
import React, { useEffect, useReducer, useState } from 'react';

import type { NotebookController } from '../controller';
import { IAnswer, StudentMode } from '../types';
import { formatUsd, scoreTone, shortLabel } from '../lib';
import {
  addAnswerCell,
  addTestsCell,
  answersStale,
  assignmentSnapshot,
  getMeta,
  gradeStale,
  hasQuestionText,
  IQuestion,
  isGradable,
  LETTERS,
  needsRegrade,
  questionSnapshot,
  resultsOf,
  setPoints,
  setType
} from '../notebook';
import { Markdown, Outputs } from './Markdown';

const MODE_LABELS: Record<StudentMode, string> = {
  copy: 'a copy-paste student',
  whole: 'a whole-notebook student',
  agent: 'an agent student'
};

/** Re-render whenever the notebook or the app state changes. */
export function useTick(controller: NotebookController): void {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    controller.changed.connect(tick);
    controller.store.changed.connect(tick);
    return () => {
      controller.changed.disconnect(tick);
      controller.store.changed.disconnect(tick);
    };
  }, [controller]);
}

/** The AI-only preview block under a question's answer cell. */
export class AnswerFooter extends ReactWidget {
  constructor(
    private controller: NotebookController,
    private questionId: string
  ) {
    super();
    this.addClass('aiss-footer');
    // Keep clicks/typing in the block from selecting the cell or entering edit mode.
    for (const type of ['mousedown', 'dblclick', 'keydown']) {
      this.node.addEventListener(type, e => e.stopPropagation());
    }
  }

  render() {
    return (
      <FooterBoundary>
        <FooterView controller={this.controller} id={this.questionId} />
      </FooterBoundary>
    );
  }
}

/** If the preview ever fails to render, say so instead of silently disappearing. */
class FooterBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="aiss-preview">
        <div className="aiss-flag aiss-error">
          The AI preview could not be displayed: {this.state.error.message}{' '}
          <button
            className="aiss-link"
            onClick={() => this.setState({ error: null })}
          >
            Show again
          </button>
        </div>
      </div>
    );
  }
}

function FooterView({
  controller,
  id
}: {
  controller: NotebookController;
  id: string;
}) {
  useTick(controller);
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const q = controller.question(id);
  if (!q) {
    return null;
  }
  const { config, settings } = controller.store;
  const results = resultsOf(q);
  const answers = results?.answers ?? [];
  const i = Math.min(index, Math.max(answers.length - 1, 0));
  const answer = answers[i];
  const stale = answersStale(q);
  const status = controller.status(id);
  const running = status !== null;
  const hardening = controller.hardening.has(id);
  const canRun = hasQuestionText(q) && !running;
  const ctxStale =
    !stale &&
    !!results?.assignmentSnapshot &&
    results.assignmentSnapshot !== assignmentSnapshot(controller.assignment());
  const runsOf = (model: string) =>
    answers.filter(a => a.model === model).length;
  const hint = getMeta(q.prompt).hardening;
  const hintStale = hint && hint.snapshot !== questionSnapshot(q);

  return (
    <div className={`aiss-preview ${stale ? 'aiss-stale' : ''}`}>
      <div className="aiss-row">
        <span className="aiss-title">AI-only preview</span>
        <QuestionSettings q={q} />
        <span className="aiss-spacer" />
        {answer?.grade && <ScoreBadge q={q} grade={answer.grade} />}
        <button
          className="aiss-btn"
          disabled={!canRun}
          title={
            settings.mode === 'copy'
              ? 'Run this question'
              : 'Re-run the whole notebook'
          }
          onClick={() => controller.runQuestion(id)}
        >
          {status === 'running' ? (
            <span className="aiss-spinner" />
          ) : running ? (
            '⏳'
          ) : (
            '▶'
          )}{' '}
          Run
        </button>
        <button
          className="aiss-btn"
          disabled={hardening || !hasQuestionText(q)}
          title="Suggest how to make this question more AI-resistant"
          onClick={() => controller.harden(id)}
        >
          {hardening ? <span className="aiss-spinner" /> : '💡'}
        </button>
        {results && (
          <button
            className="aiss-btn"
            disabled={running}
            title="Remove the AI answers of this question from the notebook"
            onClick={() => controller.clearAnswers(id)}
          >
            🗑
          </button>
        )}
      </div>

      {!q.answer && (
        <div className="aiss-flag aiss-warn">
          This question has no answer cell.{' '}
          <button
            className="aiss-link"
            onClick={() => addAnswerCell(controller.panel.model!, q)}
          >
            Add one
          </button>
        </div>
      )}
      {q.type === 'code' && q.answer && !q.tests && (
        <div className="aiss-flag aiss-info">
          No tests: code answers are graded by comparing them with your
          solution.{' '}
          <button
            className="aiss-link"
            onClick={() => addTestsCell(controller.panel.model!, q)}
          >
            Add tests
          </button>
        </div>
      )}

      {answers.length > 0 && (
        <div className="aiss-row aiss-carousel">
          {answers.length > 1 && (
            <button
              className="aiss-icon"
              title="Previous answer"
              onClick={() =>
                setIndex((i - 1 + answers.length) % answers.length)
              }
            >
              ‹
            </button>
          )}
          <span>
            <strong>{shortLabel(answer.model, config)}</strong>
            {runsOf(answer.model) > 1 && (
              <span className="aiss-muted">
                {' '}
                · run {answer.run}/{runsOf(answer.model)}
              </span>
            )}
            {answers.length > 1 && (
              <span className="aiss-muted">
                {' '}
                ({i + 1}/{answers.length})
              </span>
            )}
          </span>
          {answers.length > 1 && (
            <button
              className="aiss-icon"
              title="Next answer"
              onClick={() => setIndex((i + 1) % answers.length)}
            >
              ›
            </button>
          )}
          <span className="aiss-spacer" />
          {answer.cost > 0 && (
            <span className="aiss-muted aiss-small">
              {formatUsd(answer.cost + (answer.grade?.cost ?? 0))}
            </span>
          )}
        </div>
      )}

      {status && status !== 'running' && (
        <div className="aiss-flag aiss-info">
          ⏳{' '}
          {status === 'queued'
            ? 'Queued: starts as soon as one of the running questions is done.'
            : controller.notebookRun?.mode === 'agent'
              ? 'Waiting: the agent is working on another question (progress in the sidebar).'
              : 'Waiting: the whole notebook is answered in one go (progress in the sidebar).'}
        </div>
      )}
      {stale && (
        <div className="aiss-flag aiss-warn">
          Question changed – this answer is outdated. Run again to update.
        </div>
      )}
      {ctxStale && (
        <div className="aiss-flag aiss-info">
          Other parts of the notebook changed since this run.
        </div>
      )}
      {results && results.mode !== settings.mode && (
        <div className="aiss-flag aiss-info">
          Answered as {MODE_LABELS[results.mode]}.
        </div>
      )}
      {answer?.error && (
        <div className="aiss-flag aiss-error">{answer.error}</div>
      )}

      {!answer && (
        <p className="aiss-muted aiss-small">
          {status === 'running'
            ? controller.notebookRun?.mode === 'agent'
              ? 'The agent is working on this question…'
              : 'AI is answering…'
            : running
              ? ''
              : canRun
                ? 'Press Run to see what an AI-only student would hand in.'
                : 'Write the question first.'}
        </p>
      )}

      {q.type === 'code' && answer && (
        <CodeAnswer
          answer={answer}
          controller={controller}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}

      {q.type !== 'code' && answer?.text && (
        <>
          <div
            className={`aiss-answer-body ${expanded ? 'aiss-expanded' : ''}`}
          >
            {q.type === 'mcq' && answer.selected && (
              <p>
                Chose:{' '}
                <strong>
                  {answer.selected.length
                    ? answer.selected.map(s => LETTERS[s]).join(', ')
                    : '–'}
                </strong>
              </p>
            )}
            <Markdown text={answer.text} rendermime={controller.rendermime} />
          </div>
          <button
            className="aiss-link aiss-small"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </>
      )}

      {answer?.mode === 'agent' && (
        <AgentSteps answer={answer} controller={controller} />
      )}

      {answer?.grade && (
        <div
          className={`aiss-grade ${gradeStale(q, answer.grade) ? 'aiss-stale-grade' : ''}`}
        >
          {answer.grade.error ? (
            <span className="aiss-error-text">
              Grading failed: {answer.grade.error}
            </span>
          ) : (
            <span>
              <span className="aiss-muted">
                {answer.grade.grader === 'tests'
                  ? 'Graded by running the code:'
                  : `Grader (${shortLabel(answer.grade.grader, config)}):`}
              </span>{' '}
              {answer.grade.feedback}
            </span>
          )}
        </div>
      )}
      {needsRegrade(q) && (
        <div className="aiss-flag aiss-info">
          {q.type === 'code'
            ? answers.some(a => a.grade)
              ? 'Solution or tests changed.'
              : 'Solution or tests added.'
            : answers.some(a => a.grade)
              ? 'Reference answer changed.'
              : 'Reference answer added.'}{' '}
          <button className="aiss-link" onClick={() => controller.regrade(id)}>
            Grade now
          </button>
        </div>
      )}
      {answer && !isGradable(q) && (
        <p className="aiss-muted aiss-small">
          {q.type === 'mcq'
            ? 'Write the correct option(s) in the answer cell (e.g. "Correct: B") to score this.'
            : q.type === 'code'
              ? 'Write a reference solution or tests to score this.'
              : 'Write a reference answer in the answer cell to score this.'}
        </p>
      )}

      {hint && (
        <div className={`aiss-hint ${hintStale ? 'aiss-hint-stale' : ''}`}>
          <div className="aiss-row">
            <strong>💡 Suggestions</strong>
            {hintStale && (
              <span className="aiss-muted aiss-small">
                (for an earlier version of the question)
              </span>
            )}
            <span className="aiss-spacer" />
            <button
              className="aiss-icon"
              title="Dismiss"
              onClick={() => controller.dismissHardening(id)}
            >
              ✕
            </button>
          </div>
          <Markdown text={hint.markdown} rendermime={controller.rendermime} />
        </div>
      )}
    </div>
  );
}

function QuestionSettings({ q }: { q: IQuestion }) {
  return (
    <span className="aiss-qsettings">
      {q.type === 'code' ? (
        <span className="aiss-muted" title="Question type">
          Code
        </span>
      ) : (
        <select
          value={q.type}
          title="Question type"
          onChange={e => setType(q, e.target.value as IQuestion['type'])}
        >
          <option value="text">Text</option>
          <option value="mcq">Multiple choice</option>
        </select>
      )}
      <label title="Points">
        <input
          type="number"
          min={0}
          step={0.5}
          value={q.points}
          onChange={e => setPoints(q, Math.max(0, Number(e.target.value) || 0))}
        />{' '}
        pts
      </label>
    </span>
  );
}

function ScoreBadge({
  q,
  grade
}: {
  q: IQuestion;
  grade: NonNullable<ReturnType<typeof resultsOf>>['answers'][0]['grade'];
}) {
  if (!grade || grade.score === null) {
    return null;
  }
  const stale = gradeStale(q, grade);
  return (
    <span
      className={`aiss-score aiss-${scoreTone(grade.max ? grade.score / grade.max : 0)} ${stale ? 'aiss-stale-grade' : ''}`}
      title={
        stale
          ? 'Score is outdated'
          : 'AI score for this answer (red = AI does well)'
      }
    >
      {grade.score.toLocaleString(undefined, { maximumFractionDigits: 1 })}/
      {grade.max}
    </span>
  );
}

/** A code answer: the code handed in, what it printed or plotted, and the test results. */
function CodeAnswer({
  answer,
  controller,
  expanded,
  setExpanded
}: {
  answer: IAnswer;
  controller: NotebookController;
  expanded: boolean;
  setExpanded: (x: boolean) => void;
}) {
  const [showReply, setShowReply] = useState(false);
  const run = answer.execution;
  const tests = run?.tests ?? [];
  return (
    <>
      {run?.setup_error && (
        <div className="aiss-flag aiss-error">
          The notebook&apos;s own code failed before the answer could run:{' '}
          {run.setup_error}
        </div>
      )}
      <div className={`aiss-answer-body ${expanded ? 'aiss-expanded' : ''}`}>
        {answer.code && (
          <Markdown
            text={'```python\n' + answer.code + '\n```'}
            rendermime={controller.rendermime}
          />
        )}
        {run && !run.setup_error && (
          <div className="aiss-run">
            <div className="aiss-muted aiss-small">
              {run.outputs.length ? 'Output:' : 'No output.'}
              {run.timed_out && ' (stopped: time limit)'}
            </div>
            {run.outputs.length > 0 && (
              <Outputs
                outputs={run.outputs}
                rendermime={controller.rendermime}
              />
            )}
          </div>
        )}
        {tests.length > 0 && (
          <ul className="aiss-tests-list">
            {tests.map((t, i) => (
              <li key={i} className={t.passed ? 'aiss-pass' : 'aiss-fail'}>
                <span>{t.passed ? '✓' : '✗'}</span> <code>{t.source}</code>
                {t.error && <div className="aiss-small">{t.error}</div>}
              </li>
            ))}
          </ul>
        )}
        {showReply && (
          <div className="aiss-reply">
            <div className="aiss-muted aiss-small">
              Full reply of the model:
            </div>
            <Markdown text={answer.text} rendermime={controller.rendermime} />
          </div>
        )}
      </div>
      <div className="aiss-row">
        <button
          className="aiss-link aiss-small"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        {answer.text && (
          <button
            className="aiss-link aiss-small"
            onClick={() => setShowReply(!showReply)}
          >
            {showReply ? 'Hide full reply' : 'Show full reply'}
          </button>
        )}
      </div>
    </>
  );
}

/** What an agent student ran while working on this question. */
function AgentSteps({
  answer,
  controller
}: {
  answer: IAnswer;
  controller: NotebookController;
}) {
  const [open, setOpen] = useState(false);
  const steps = answer.steps ?? [];
  const total = answer.steps_total ?? steps.length;
  if (!total) {
    return (
      <p className="aiss-muted aiss-small">The agent did not run any code.</p>
    );
  }
  if (!steps.length) {
    return (
      <p className="aiss-muted aiss-small">
        The agent ran no code for this question ({total}× for the notebook).
      </p>
    );
  }
  return (
    <div className="aiss-steps">
      <button className="aiss-link aiss-small" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Ran code {steps.length}× for this question
        {total !== steps.length && ` (${total}× for the notebook)`}
      </button>
      {open &&
        steps.map((step, i) => (
          <div key={i} className="aiss-step">
            <div className="aiss-muted aiss-small">Run {i + 1}</div>
            <Markdown
              text={'```python\n' + step.code + '\n```'}
              rendermime={controller.rendermime}
            />
            {step.outputs.length > 0 && (
              <Outputs
                outputs={step.outputs}
                rendermime={controller.rendermime}
              />
            )}
          </div>
        ))}
    </div>
  );
}
