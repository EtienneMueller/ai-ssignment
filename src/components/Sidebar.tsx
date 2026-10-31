import { INotebookTracker } from '@jupyterlab/notebook';
import { ReactWidget } from '@jupyterlab/ui-components';
import React, { useEffect, useReducer } from 'react';

import type { NotebookController } from '../controller';
import {
  estimateCost,
  formatUsd,
  overallGrade,
  scoreTone,
  shortLabel
} from '../lib';
import { Store } from '../store';
import { AdvancedSettings } from './Advanced';
import { ProviderList } from './Providers';
import { StudentMode } from '../types';

interface IProps {
  tracker: INotebookTracker;
  store: Store;
  controllerFor: (panel: any) => NotebookController | undefined;
  insert: (type: 'text' | 'mcq' | 'code' | 'convert') => void;
}

export class Sidebar extends ReactWidget {
  constructor(private props: IProps) {
    super();
    this.addClass('aiss-sidebar');
    this.id = 'aissignment-sidebar';
    this.title.caption = 'AI-ssignment';
  }

  render() {
    return <SidebarView {...this.props} />;
  }
}

function SidebarView({ tracker, store, controllerFor, insert }: IProps) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const controller = tracker.currentWidget
    ? controllerFor(tracker.currentWidget)
    : undefined;

  useEffect(() => {
    store.changed.connect(tick);
    tracker.currentChanged.connect(tick);
    // After a reload the notebook becomes current before its controller exists; redraw once it does.
    tracker.widgetAdded.connect(tick);
    return () => {
      store.changed.disconnect(tick);
      tracker.currentChanged.disconnect(tick);
      tracker.widgetAdded.disconnect(tick);
    };
  }, [store, tracker]);
  useEffect(() => {
    controller?.changed.connect(tick);
    return () => {
      controller?.changed.disconnect(tick);
    };
  }, [controller]);

  const { config, settings } = store;
  const questions = controller?.questions() ?? [];
  const estimate = controller
    ? estimateCost(controller.assignment(), settings, config)
    : 0;
  const anyRunning = !!controller && controller.running.size > 0;
  const runningAll = !!controller?.runningAll;

  return (
    <div className="aiss-sidebar-content">
      <h2>AI-ssignment</h2>

      {store.configError && (
        <div className="aiss-flag aiss-error">
          Server extension not reachable: {store.configError}
        </div>
      )}

      {controller && (
        <section>
          <h3>AI-only grade</h3>
          <Overall controller={controller} />
        </section>
      )}

      <section>
        <h3>Questions</h3>
        {!controller ? (
          <p className="aiss-muted">Open a notebook to start.</p>
        ) : (
          <>
            <div className="aiss-buttons">
              <button
                className="aiss-btn"
                onClick={() => insert('text')}
                title="Insert a text question below the active cell"
              >
                + Text
              </button>
              <button
                className="aiss-btn"
                onClick={() => insert('mcq')}
                title="Insert a multiple-choice question below the active cell"
              >
                + Multiple choice
              </button>
              <button
                className="aiss-btn"
                onClick={() => insert('code')}
                title="Insert a code question (question, reference solution, tests) below the active cell"
              >
                + Code
              </button>
              <button
                className="aiss-btn"
                onClick={() => insert('convert')}
                title="Turn the active markdown cell into a question"
              >
                Make active cell a question
              </button>
            </div>
            <p className="aiss-muted aiss-small">
              {questions.length} question{questions.length === 1 ? '' : 's'},{' '}
              {questions.reduce((n, q) => n + q.points, 0)} points. All other
              cells are context.
            </p>
          </>
        )}
      </section>

      <section>
        <h3>AI students</h3>
        <div className="aiss-segmented" role="group" aria-label="Student type">
          {(
            [
              [
                'copy',
                'Copy-paste',
                'Pastes each question separately, without the rest of the notebook'
              ],
              [
                'whole',
                'Whole notebook',
                'Pastes the complete notebook in one go'
              ],
              [
                'agent',
                'Agent mode',
                'Gets the notebook and a Python kernel: runs code, reads outputs and errors, fixes its answers, then hands in'
              ]
            ] as [StudentMode, string, string][]
          ).map(([mode, label, title]) => (
            <button
              key={mode}
              title={title}
              className={settings.mode === mode ? 'aiss-on' : ''}
              onClick={() => store.update({ mode })}
            >
              {label}
            </button>
          ))}
        </div>

        <ProviderList store={store} />

        <label className="aiss-field">
          <span>Grader</span>
          <select
            value={settings.grader}
            onChange={e => store.update({ grader: e.target.value })}
          >
            {config?.providers.map(p => (
              <optgroup key={p.id} label={p.name}>
                {p.models.map(m => (
                  <option key={m.key} value={m.key} disabled={!p.available}>
                    {m.label.replace(/^[^:]+:\s*/, '')}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="aiss-field">
          <span>Runs per model</span>
          <div className="aiss-segmented">
            {[1, 3].map(n => (
              <button
                key={n}
                className={settings.runs === n ? 'aiss-on' : ''}
                onClick={() => store.update({ runs: n })}
              >
                {n}×
              </button>
            ))}
          </div>
        </div>

        <button
          className="aiss-btn aiss-primary aiss-wide"
          disabled={!controller || anyRunning || !settings.students.length}
          title={
            anyRunning && !runningAll
              ? 'Wait until the running question is finished'
              : undefined
          }
          onClick={() => controller?.runAll()}
        >
          {runningAll ? <span className="aiss-spinner" /> : '▶'} Run all
          questions{' '}
          <span className="aiss-small">
            {settings.mode === 'agent' ? 'up to ' : '≈'}
            {formatUsd(estimate)}
          </span>
        </button>
        {controller && anyRunning && <RunProgress controller={controller} />}
        <p className="aiss-muted aiss-small">
          Spent this session: {formatUsd(store.spent)}
        </p>
      </section>

      {controller && (
        <section>
          <h3>Export</h3>
          <p className="aiss-muted aiss-small">
            Student version: answer cells replaced by empty answer fields, no AI
            results. Instructor version: with reference answers. Both as .ipynb
            and PDF, in <code>{controller.title}_export/</code>.
          </p>
          <button
            className="aiss-btn aiss-wide"
            onClick={() => controller.exportVersions()}
          >
            Export student &amp; instructor versions
          </button>
        </section>
      )}

      <section>
        <AdvancedSettings store={store} controller={controller} />
      </section>
    </div>
  );
}

function Overall({ controller }: { controller: NotebookController }) {
  const { config, settings } = controller.store;
  const overall = overallGrade(controller.questions(), settings.students);
  if (overall.kind === 'empty') {
    return <p className="aiss-muted aiss-small">No questions yet.</p>;
  }
  if (overall.kind === 'missingReferences') {
    return (
      <p className="aiss-muted aiss-small">
        Add reference answers / correct options to question
        {overall.missing.length === 1 ? '' : 's'} {overall.missing.join(', ')}{' '}
        to see the overall grade.
      </p>
    );
  }
  return (
    <div className="aiss-overall">
      {overall.perModel.map(({ model, score, max, missing }) => (
        <div key={model} className="aiss-overall-row">
          <span>{shortLabel(model, config)}</span>
          {score === null ? (
            <span
              className="aiss-muted aiss-small"
              title="Questions without a current, graded answer"
            >
              {missing} question{missing === 1 ? '' : 's'} pending
            </span>
          ) : (
            <span
              className={`aiss-score aiss-${scoreTone(max ? score / max : 0)}`}
              title={`${score.toFixed(1)} of ${max} points`}
            >
              {Math.round((max ? score / max : 0) * 100)}%
            </span>
          )}
        </div>
      ))}
      <p className="aiss-muted aiss-small">
        Red = the AI alone does well on this assignment.
      </p>
    </div>
  );
}

const PHASES = {
  answering: 'Answering…',
  'running code': 'Running the handed-in code…',
  grading: 'Grading…'
};

/** What the current run is doing, what it has cost so far, and a Stop button. */
function RunProgress({ controller }: { controller: NotebookController }) {
  const progress = controller.progress();
  const config = controller.store.config;
  const run = controller.notebookRun;
  const queued = controller.queued;
  const answering = controller.running.size - queued;
  const agents = Object.values(progress?.agents ?? {});
  const runsPerModel = controller.store.settings.runs;
  return (
    <div className="aiss-progress">
      <div className="aiss-row">
        <span className="aiss-spinner" />
        <strong>
          {run?.mode === 'agent'
            ? 'Agent students'
            : run
              ? 'Whole notebook'
              : `${answering} question${answering === 1 ? '' : 's'} being answered` +
                (queued ? `, ${queued} queued` : '')}
        </strong>
        <span className="aiss-spacer" />
        <button
          className="aiss-btn"
          disabled={controller.stopping}
          title="Stop now: no further AI calls are made"
          onClick={() => controller.stop()}
        >
          {controller.stopping ? 'Stopping…' : '■ Stop'}
        </button>
      </div>
      {progress && (
        <div className="aiss-muted aiss-small">{PHASES[progress.phase]}</div>
      )}
      {progress?.phase === 'answering' &&
        agents.map(a => (
          <div key={`${a.model}#${a.run}`} className="aiss-small">
            {shortLabel(a.model, config)}
            {runsPerModel > 1 && ` (run ${a.run})`}: code run {a.step} of max{' '}
            {a.max}
            {a.field
              ? ` · on Q${a.field}`
              : a.step
                ? ' · setting up'
                : ' · reading the notebook'}
          </div>
        ))}
      <div className="aiss-muted aiss-small">
        Spent so far: {formatUsd(progress?.cost ?? 0)}
      </div>
    </div>
  );
}
