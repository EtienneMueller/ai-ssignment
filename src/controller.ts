import { Dialog, Notification, showDialog } from '@jupyterlab/apputils';
import { Cell, ICellModel } from '@jupyterlab/cells';
import { NotebookPanel } from '@jupyterlab/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';
import { PanelLayout, Widget } from '@lumino/widgets';

import { AnswerFooter } from './components/Footer';
import { estimateCost, formatUsd } from './lib';
import {
  answersStale,
  assignmentSnapshot,
  buildAssignment,
  findQuestions,
  getMeta,
  hasQuestionText,
  gradingSnapshot,
  IQuestion,
  questionSnapshot,
  questionToApi,
  resultsOf,
  setMeta
} from './notebook';
import { api, IWorkspace } from './request';
import { Store } from './store';
import {
  IAnswer,
  IApiAssignment,
  IProgress,
  QuestionStatus,
  StudentMode
} from './types';

const QUESTION_CLASS = 'aiss-question';
const ANSWER_CLASS = 'aiss-answer';
const TESTS_CLASS = 'aiss-tests';
/** copy-paste mode: questions answered at the same time; the rest wait in a queue */
const PARALLEL_QUESTIONS = 3;

/** Dialog body: a sentence and a bullet list. */
function listBody(text: string, items: string[]): Widget {
  const body = new Widget();
  const p = document.createElement('p');
  p.textContent = text;
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  body.node.append(p, ul);
  return body;
}

/** Everything AI-ssignment does for one open notebook. */
export class NotebookController implements IDisposable {
  readonly running = new Set<string>();
  readonly hardening = new Set<string>();
  /** true while "Run all questions" is in progress (as opposed to single questions) */
  runningAll = false;
  private _changed = new Signal<this, void>(this);
  private _footers = new Map<string, AnswerFooter>();
  private _connected = new WeakSet<ICellModel>();
  /** whole-notebook / agent run in progress: its mode and question ids in order */
  notebookRun: { mode: 'whole' | 'agent'; ids: string[] } | null = null;
  private _queue: string[] = [];
  private _active = 0;
  private _jobs = new Map<string, IProgress | null>();
  private _poll = 0;
  private _stopping = false;
  private _frame = 0;
  private _disposed = false;

  constructor(
    readonly panel: NotebookPanel,
    readonly store: Store,
    readonly rendermime: IRenderMimeRegistry
  ) {
    panel.context.ready.then(() => this._init());
    panel.disposed.connect(() => this.dispose());
    window.addEventListener('pagehide', this._onPageHide);
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    cancelAnimationFrame(this._frame);
    window.clearInterval(this._poll);
    window.removeEventListener('pagehide', this._onPageHide);
    this._onPageHide();
    this._footers.forEach(f => f.dispose());
    Signal.clearData(this);
  }

  get title(): string {
    return this.panel.context.path
      .split('/')
      .pop()!
      .replace(/\.ipynb$/, '');
  }

  questions(): IQuestion[] {
    return this.panel.model ? findQuestions(this.panel.model) : [];
  }

  question(id: string): IQuestion | undefined {
    return this.questions().find(q => q.id === id);
  }

  assignment(): IApiAssignment {
    return buildAssignment(this.panel.model!, this.title);
  }

  /** Code answers run in the notebook's folder with the notebook's kernel. */
  workspace(): IWorkspace {
    const spec = this.panel.model?.getMetadata('kernelspec') as
      { name?: string } | undefined;
    return {
      notebook_path: this.panel.context.path,
      kernel: spec?.name ?? null
    };
  }

  // --- Notebook wiring --------------------------------------------------------------------------

  private _init(): void {
    const model = this.panel.model!;
    model.cells.changed.connect(this._schedule, this);
    this._schedule();
  }

  /** Coalesce bursts of model changes into one refresh per frame. */
  private _schedule(): void {
    if (this._disposed || this._frame) {
      return;
    }
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      if (!this._disposed) {
        this._refresh();
        this._changed.emit();
      }
    });
  }

  private _refresh(): void {
    const notebook = this.panel.content;
    const questions = this.questions();
    const byCell = new Map<
      ICellModel,
      { q: IQuestion; role: 'question' | 'answer' | 'tests' }
    >();
    for (const q of questions) {
      byCell.set(q.prompt, { q, role: 'question' });
      if (q.answer) {
        byCell.set(q.answer, { q, role: 'answer' });
      }
      if (q.tests) {
        byCell.set(q.tests, { q, role: 'tests' });
      }
    }

    for (const cell of notebook.widgets) {
      const model = cell.model;
      if (!this._connected.has(model)) {
        this._connected.add(model);
        model.contentChanged.connect(this._schedule, this);
        model.metadataChanged.connect(this._schedule, this);
      }
      const entry = byCell.get(model);
      cell.toggleClass(QUESTION_CLASS, entry?.role === 'question');
      const role = entry?.role ?? getMeta(model).role;
      cell.toggleClass(ANSWER_CLASS, role === 'answer');
      cell.toggleClass(TESTS_CLASS, role === 'tests');
      if (entry?.role === 'question') {
        const pts = `${entry.q.points} point${entry.q.points === 1 ? '' : 's'}`;
        const kind = {
          text: 'text',
          mcq: 'multiple choice',
          code: 'code'
        }[entry.q.type];
        cell.node.dataset.aissLabel = `Question ${entry.q.number} · ${kind} · ${pts}`;
      } else if (role === 'answer') {
        cell.node.dataset.aissLabel = !entry
          ? 'Answer cell without a question above'
          : entry.q.type === 'code'
            ? `Reference solution (Q${entry.q.number}) · students get the starter code`
            : `Reference answer (Q${entry.q.number}) · removed in student version`;
      } else if (role === 'tests') {
        cell.node.dataset.aissLabel = entry
          ? `Tests (Q${entry.q.number}) · hidden tests removed in student version`
          : 'Tests cell without a code question above';
      } else {
        delete cell.node.dataset.aissLabel;
      }
    }

    // One AI preview block per question, below its answer cell (or the question if it has none).
    const seen = new Set<string>();
    for (const q of questions) {
      seen.add(q.id);
      const hostModel = q.tests ?? q.answer ?? q.prompt;
      const host = notebook.widgets.find(w => w.model === hostModel);
      if (!host) {
        continue;
      }
      let footer = this._footers.get(q.id);
      if (!footer || footer.isDisposed) {
        footer = new AnswerFooter(this, q.id);
        this._footers.set(q.id, footer);
      }
      if (footer.parent !== host) {
        this._attach(footer, host);
      }
    }
    for (const [id, footer] of this._footers) {
      if (!seen.has(id)) {
        footer.dispose();
        this._footers.delete(id);
      }
    }
  }

  private _attach(footer: AnswerFooter, host: Cell): void {
    footer.parent = null;
    // Cells build their DOM lazily; adding earlier would put the footer above the input.
    void host.ready.then(() => {
      if (!footer.isDisposed && !host.isDisposed && footer.parent !== host) {
        (host.layout as PanelLayout).addWidget(footer);
      }
    });
  }

  // --- Running ----------------------------------------------------------------------------------
  // AI calls only start from Run / Run all questions, never by themselves.

  private _busy(ids: string[], busy: boolean): void {
    ids.forEach(id => (busy ? this.running.add(id) : this.running.delete(id)));
    this._changed.emit();
  }

  /** What a question is doing; null = idle. */
  status(id: string): QuestionStatus | null {
    if (!this.running.has(id)) {
      return null;
    }
    if (this._queue.includes(id)) {
      return 'queued';
    }
    const run = this.notebookRun;
    if (!run) {
      return 'running';
    }
    const progress = this.progress();
    if (run.mode === 'agent' && progress?.phase === 'answering') {
      const number = run.ids.indexOf(id) + 1;
      return Object.values(progress.agents).some(a => a.field === number)
        ? 'running'
        : 'waiting';
    }
    // Whole notebook: one call answers everything; afterwards all answers are checked together.
    return progress && progress.phase !== 'answering' ? 'running' : 'waiting';
  }

  /** Combined progress of the runs in progress (null before the first update). */
  progress(): IProgress | null {
    const all = [...this._jobs.values()].filter(Boolean) as IProgress[];
    if (!all.length) {
      return null;
    }
    const phases: IProgress['phase'][] = [
      'answering',
      'running code',
      'grading'
    ];
    return {
      cost: all.reduce((n, p) => n + p.cost, 0),
      phase: phases.find(ph => all.some(p => p.phase === ph)) ?? 'answering',
      agents: Object.assign({}, ...all.map(p => p.agents))
    };
  }

  /** Questions waiting for a free slot (copy-paste mode). */
  get queued(): number {
    return this._queue.length;
  }

  private _startJob(): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this._jobs.set(id, null);
    if (!this._poll) {
      this._poll = window.setInterval(() => void this._pollProgress(), 1000);
    }
    return id;
  }

  private _endJob(id: string): void {
    this._jobs.delete(id);
    if (!this._jobs.size && this._poll) {
      window.clearInterval(this._poll);
      window.removeEventListener('pagehide', this._onPageHide);
      this._onPageHide();
      this._poll = 0;
    }
    this._changed.emit();
  }

  /** Page reloaded or closed (or notebook closed): stop its runs, nobody would see the results. */
  private _onPageHide = (): void => {
    if (this._jobs.size) {
      void api.cancel([...this._jobs.keys()], true).catch(() => undefined);
    }
  };

  private async _pollProgress(): Promise<void> {
    const ids = [...this._jobs.keys()];
    if (!ids.length) {
      return;
    }
    try {
      const progress = await api.progress(ids);
      for (const [id, p] of Object.entries(progress)) {
        if (this._jobs.has(id) && p) {
          this._jobs.set(id, p);
        }
      }
      this._changed.emit();
    } catch {
      // progress is only for display
    }
  }

  /** Stop everything: queued questions are dropped, running ones are cancelled on the server. */
  async stop(): Promise<void> {
    const dropped = this._queue.splice(0);
    this._busy(dropped, false);
    this._stopping = true;
    this._changed.emit();
    const ids = [...this._jobs.keys()];
    if (ids.length) {
      await api.cancel(ids).catch(() => undefined);
    }
  }

  get stopping(): boolean {
    return this._stopping;
  }

  private _store(
    results: Record<string, IAnswer[]>,
    snaps: Map<string, [string, string]>,
    mode: StudentMode,
    whole?: string
  ) {
    const ranAt = new Date().toISOString();
    let cost = 0;
    for (const [id, answers] of Object.entries(results)) {
      const q = this.question(id);
      const snap = snaps.get(id);
      if (!q || !snap) {
        continue;
      }
      const stamped = answers.map(a => {
        cost += a.cost + (a.grade?.cost ?? 0);
        return a.grade ? { ...a, grade: { ...a.grade, snapshot: snap[1] } } : a;
      });
      setMeta(q.prompt, {
        results: {
          answers: stamped,
          mode,
          snapshot: snap[0],
          assignmentSnapshot: whole,
          ranAt
        }
      });
    }
    this.store.addCost(cost);
  }

  private _snapshots(): Map<string, [string, string]> {
    return new Map(
      this.questions().map(q => [
        q.id,
        [questionSnapshot(q), gradingSnapshot(q)]
      ])
    );
  }

  private async _confirmCost(cellIds?: string[]): Promise<boolean> {
    const s = this.store.settings;
    const est = estimateCost(this.assignment(), s, this.store.config, cellIds);
    if (est <= s.confirmAboveUsd) {
      return true;
    }
    const result = await showDialog({
      title: 'Run AI students?',
      body:
        s.mode === 'agent'
          ? `This run will cost up to ${formatUsd(est)} (if the agents use all their code runs).`
          : `This run will cost roughly ${formatUsd(est)}.`,
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Run' })]
    });
    return result.button.accept;
  }

  private _checkModels(): boolean {
    const s = this.store.settings;
    if (!s.students.length) {
      Notification.warning(
        'Select at least one student model in the AI-ssignment sidebar.',
        { autoClose: 5000 }
      );
      return false;
    }
    return true;
  }

  /** Code answers and agents run AI-written code on this computer: ask once before the first time. */
  private async _allowCode(ids: string[]): Promise<boolean> {
    const hasCode =
      this.store.settings.mode === 'agent' ||
      this.questions().some(q => q.type === 'code' && ids.includes(q.id));
    if (!hasCode || this.store.settings.allowCodeExecution) {
      return true;
    }
    const result = await showDialog({
      title: 'Run AI-written code on this computer?',
      body: listBody(
        'Agent students and code answers run code the AI writes, here:',
        [
          'in a separate kernel, not in your notebook (your variables are not touched)',
          "in this notebook's folder, so it can read your data files",
          'with a time limit of 60 seconds per cell'
        ]
      ),
      buttons: [
        Dialog.cancelButton({ label: 'Not now' }),
        Dialog.okButton({ label: 'Allow' })
      ]
    });
    if (result.button.accept) {
      await this.store.update({ allowCodeExecution: true });
    }
    return result.button.accept;
  }

  private _failed(e: unknown): void {
    Notification.error(`AI run failed: ${(e as Error).message}`, {
      autoClose: 8000
    });
  }

  /** Resolves once none of `ids` is running or queued any more. */
  private _settled(ids: string[]): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (!ids.some(id => this.running.has(id))) {
          this._changed.disconnect(check);
          resolve();
        }
      };
      this._changed.connect(check);
      check();
    });
  }

  /** Copy-paste students: questions are queued; at most PARALLEL_QUESTIONS are answered at a time. */
  async runCopy(ids: string[]): Promise<void> {
    const todo = ids.filter(id => !this.running.has(id));
    if (
      !todo.length ||
      !this._checkModels() ||
      !(await this._allowCode(todo))
    ) {
      return;
    }
    this._stopping = false;
    this._queue.push(...todo);
    this._busy(todo, true);
    this._pump();
    await this._settled(todo);
  }

  private _pump(): void {
    while (this._active < PARALLEL_QUESTIONS && this._queue.length) {
      const id = this._queue.shift()!;
      this._active++;
      void this._runOne(id).finally(() => {
        this._active--;
        this._busy([id], false);
        this._pump();
      });
    }
    this._changed.emit();
  }

  private async _runOne(id: string): Promise<void> {
    const s = this.store.settings;
    const snaps = this._snapshots();
    const jobId = this._startJob();
    try {
      const res = await api.run(
        this.assignment(),
        {
          cellIds: [id],
          mode: 'copy',
          models: s.students,
          runs: s.runs,
          grader: s.grader || null,
          jobId
        },
        this.workspace()
      );
      if (res.results) {
        this._store(res.results, snaps, 'copy');
      } else {
        this.store.addCost(res.cost ?? 0);
      }
    } catch (e) {
      this._failed(e);
    } finally {
      this._endJob(jobId);
    }
  }

  /** The notebook as a whole-assignment student pastes it (questions without text left out). */
  private _wholeAssignment(): IApiAssignment {
    const empty = new Set(
      this.questions()
        .filter(q => !hasQuestionText(q))
        .map(q => q.id)
    );
    const a = this.assignment();
    return { ...a, cells: a.cells.filter(c => !empty.has(c.id)) };
  }

  /** Whole-notebook and agent students: one run for all questions. */
  async runWhole(): Promise<void> {
    const s = this.store.settings;
    const mode = s.mode === 'agent' ? 'agent' : 'whole';
    const assignment = this._wholeAssignment();
    const ids = assignment.cells
      .filter(c => ['text', 'mcq', 'code_question'].includes(c.type))
      .map(c => c.id);
    if (
      !ids.length ||
      ids.some(id => this.running.has(id)) ||
      !this._checkModels() ||
      !(await this._allowCode(ids))
    ) {
      return;
    }
    const snaps = this._snapshots();
    this._stopping = false;
    this.notebookRun = { mode, ids };
    this._busy(ids, true);
    const jobId = this._startJob();
    try {
      const res = await api.run(
        assignment,
        {
          mode,
          models: s.students,
          runs: s.runs,
          grader: s.grader || null,
          jobId,
          agentStepsPerQuestion: s.agentStepsPerQuestion,
          agentMaxSteps: s.agentMaxSteps
        },
        this.workspace()
      );
      if (res.results) {
        this._store(res.results, snaps, mode, assignmentSnapshot(assignment));
      } else {
        this.store.addCost(res.cost ?? 0);
      }
    } catch (e) {
      this._failed(e);
    } finally {
      this.notebookRun = null;
      this._endJob(jobId);
      this._busy(ids, false);
    }
  }

  async runQuestion(id: string): Promise<void> {
    if (!(await this._confirmCost([id]))) {
      return;
    }
    if (this.store.settings.mode !== 'copy') {
      await this.runWhole();
    } else {
      await this.runCopy([id]);
    }
  }

  async runAll(): Promise<void> {
    if (this.runningAll || !(await this._confirmCost())) {
      return;
    }
    this.runningAll = true;
    this._changed.emit();
    try {
      if (this.store.settings.mode !== 'copy') {
        await this.runWhole();
      } else {
        await this.runCopy(
          this.questions()
            .filter(hasQuestionText)
            .map(q => q.id)
        );
      }
    } finally {
      this.runningAll = false;
      this._changed.emit();
    }
  }

  async regrade(id: string): Promise<void> {
    const q = this.question(id);
    const grader = this.store.settings.grader;
    const results = q && resultsOf(q);
    if (!q || !results || !grader || this.running.has(id)) {
      return;
    }
    const snap = gradingSnapshot(q);
    this._busy([id], true);
    try {
      const { answers } = await api.grade(
        this.assignment(),
        id,
        results.answers,
        grader,
        this.workspace()
      );
      const current = this.question(id);
      if (current && resultsOf(current)) {
        setMeta(current.prompt, {
          results: {
            ...resultsOf(current)!,
            answers: answers.map(a => ({
              ...a,
              grade: a.grade && { ...a.grade, snapshot: snap }
            }))
          }
        });
      }
      this.store.addCost(answers.reduce((n, a) => n + (a.grade?.cost ?? 0), 0));
    } catch (e) {
      Notification.error(`Grading failed: ${(e as Error).message}`, {
        autoClose: 8000
      });
    } finally {
      this._busy([id], false);
    }
  }

  async harden(id: string): Promise<void> {
    const q = this.question(id);
    const model = this.store.settings.grader;
    if (!q || !model || this.hardening.has(id)) {
      return;
    }
    this.hardening.add(id);
    this._changed.emit();
    try {
      const answers = answersStale(q) ? [] : (resultsOf(q)?.answers ?? []);
      const res = await api.harden(this.assignment(), id, answers, model);
      setMeta(q.prompt, {
        hardening: {
          markdown: res.markdown,
          snapshot: questionSnapshot(q),
          model
        }
      });
      this.store.addCost(res.cost);
    } catch (e) {
      Notification.error(`Suggestions failed: ${(e as Error).message}`, {
        autoClose: 8000
      });
    } finally {
      this.hardening.delete(id);
      this._changed.emit();
    }
  }

  dismissHardening(id: string): void {
    const q = this.question(id);
    if (q) {
      setMeta(q.prompt, { hardening: undefined });
    }
  }

  clearAnswers(id: string): void {
    const q = this.question(id);
    if (q && !this.running.has(id)) {
      setMeta(q.prompt, { results: undefined });
    }
  }

  /** How many questions have AI answers / 💡 suggestions stored in the notebook. */
  stored(): { answers: number; suggestions: number } {
    const qs = this.questions();
    return {
      answers: qs.filter(q => getMeta(q.prompt).results).length,
      suggestions: qs.filter(q => getMeta(q.prompt).hardening).length
    };
  }

  /** Remove AI answers and/or suggestions from every question, after confirming. */
  async clearAll(what: 'answers' | 'suggestions'): Promise<void> {
    const n = this.stored()[what];
    if (!n || (what === 'answers' && this.running.size)) {
      return;
    }
    const label =
      what === 'answers' ? 'AI answers and grades' : '💡 suggestions';
    const result = await showDialog({
      title: `Remove all ${label}?`,
      body: `This removes the ${label} of ${n} question${n === 1 ? '' : 's'} from the notebook. Your questions and reference answers stay.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
    });
    if (!result.button.accept) {
      return;
    }
    for (const q of this.questions()) {
      setMeta(
        q.prompt,
        what === 'answers' ? { results: undefined } : { hardening: undefined }
      );
    }
  }

  async exportVersions(): Promise<void> {
    await this.panel.context.save();
    const path = this.panel.context.path;
    const { existing } = await api.existingExports(path);
    if (existing.length) {
      const result = await showDialog({
        title: 'Overwrite earlier export?',
        body: listBody(
          'These files from an earlier export will be replaced:',
          existing
        ),
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({ label: 'Overwrite' })
        ]
      });
      if (!result.button.accept) {
        return;
      }
    }
    const promise = api.export(path);
    Notification.promise(promise, {
      pending: {
        message:
          'Exporting student and instructor versions (first PDF export downloads a browser, ~1 min)…'
      },
      success: {
        message: result => {
          const files = (result as { files: string[] }).files;
          return `Exported ${files.length} files to ${files[0]?.split('/').slice(0, -1).join('/') || '.'}/`;
        },
        options: { autoClose: 10000 }
      },
      error: {
        message: (e: unknown) => `Export failed: ${(e as Error).message}`
      }
    });
    await promise.catch(() => undefined);
  }

  /** For display: the payload view of a question. */
  apiQuestion(id: string) {
    const q = this.question(id);
    return q ? questionToApi(q) : undefined;
  }
}
