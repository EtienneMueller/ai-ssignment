export type QuestionType = 'text' | 'mcq' | 'code';
export type StudentMode = 'copy' | 'whole' | 'agent';

export interface IGrade {
  score: number | null;
  max: number;
  feedback: string;
  grader: string;
  cost: number;
  error?: string | null;
  /** gradingSnapshot() at grading time; differs => score is outdated */
  snapshot?: string;
}

export interface IAnswer {
  model: string;
  run: number;
  mode: StudentMode;
  text: string;
  error?: string | null;
  cost: number;
  selected?: number[] | null;
  /** code questions: the code handed in, and what happened when it ran */
  code?: string | null;
  execution?: IExecution | null;
  /** agent students: the code it ran while working on this question */
  steps?: IStep[] | null;
  /** agent students: code runs for the whole notebook */
  steps_total?: number | null;
  grade?: IGrade | null;
}

/** nbformat output (stream, display_data, execute_result, error) */
export type IOutput = Record<string, any> & { output_type: string };

export interface IExecution {
  outputs: IOutput[];
  error?: string | null;
  /** the notebook's own code failed before the answer ran */
  setup_error?: string | null;
  timed_out?: boolean;
  tests?: { source: string; passed: boolean; error?: string | null }[] | null;
}

export interface IStep {
  code: string;
  outputs: IOutput[];
}

export interface IResults {
  answers: IAnswer[];
  mode: StudentMode;
  /** questionSnapshot() at run time; differs => answers are outdated */
  snapshot: string;
  /** whole and agent mode: assignmentSnapshot() at run time */
  assignmentSnapshot?: string;
  ranAt: string;
}

export interface IHardening {
  markdown: string;
  snapshot: string;
  model: string;
}

/** metadata.aissignment on notebook cells */
export interface ICellMeta {
  role?: 'question' | 'answer' | 'tests';
  type?: QuestionType;
  points?: number;
  results?: IResults;
  hardening?: IHardening;
}

/** Payload format of the server extension */
export interface IApiCell {
  id: string;
  type: 'context' | 'code' | 'text' | 'mcq' | 'code_question';
  question: string;
  options: string[];
  correct: number[];
  reference: string;
  tests: string;
  points: number;
}

export interface IApiAssignment {
  title: string;
  cells: IApiCell[];
}

export interface IModelInfo {
  key: string;
  id: string;
  label: string;
  pricing: { prompt: number; completion: number } | null;
}

export interface IProviderInfo {
  id: string;
  name: string;
  available: boolean;
  error: string | null;
  api_key_env: string;
  base_url: string;
  /** shipped with the extension: cannot be removed, name and URL fixed */
  builtin: boolean;
  key_set: boolean;
  models: IModelInfo[];
  /** every model id the endpoint offers (for suggestions) */
  catalog: string[];
}

export interface IConfig {
  env_path: string;
  providers_path: string;
  custom_providers: boolean;
  providers: IProviderInfo[];
  defaults: { students?: string[]; grader?: string };
}

export interface ISettings {
  students: string[];
  grader: string;
  runs: number;
  mode: StudentMode;
  confirmAboveUsd: number;
  /** the user agreed that AI-written code may run on this computer */
  allowCodeExecution: boolean;
  /** agent students: code runs allowed per question, and for the whole notebook */
  agentStepsPerQuestion: number;
  agentMaxSteps: number;
}

/** What an agent student is doing right now. */
export interface IAgentStatus {
  model: string;
  run: number;
  step: number;
  max: number;
  /** answer field it is working on (0 = setup) */
  field: number | null;
}

/** Live progress of a run on the server. */
export interface IProgress {
  cost: number;
  phase: 'answering' | 'running code' | 'grading';
  agents: Record<string, IAgentStatus>;
}

/** running = being answered now; queued = waits for a free slot; waiting = part of a notebook run */
export type QuestionStatus = 'running' | 'queued' | 'waiting';
