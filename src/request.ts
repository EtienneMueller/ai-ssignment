import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  IAnswer,
  IApiAssignment,
  IConfig,
  IProgress,
  StudentMode
} from './types';

/**
 * Call the server extension (JSON in, JSON out).
 */
async function requestAPI<T>(
  endPoint: string,
  body?: unknown,
  keepalive = false
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const url = URLExt.join(settings.baseUrl, 'aissignment', endPoint);
  const init: RequestInit =
    body === undefined
      ? { method: 'GET' }
      : { method: 'POST', body: JSON.stringify(body), keepalive };

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(url, init, settings);
  } catch (error) {
    throw new ServerConnection.NetworkError(error as TypeError);
  }

  let data: any = await response.text();
  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch {
      // not JSON
    }
  }
  if (!response.ok) {
    throw new Error(data?.message || response.statusText || String(data));
  }
  return data;
}

/** Where code answers run: the notebook's folder and kernel. */
export interface IWorkspace {
  notebook_path: string;
  kernel: string | null;
}

export const api = {
  config: () => requestAPI<IConfig>('config'),
  reloadConfig: () => requestAPI<IConfig>('config/reload', {}),
  setKey: (provider: string, value: string) =>
    requestAPI<IConfig>('config/key', { provider, value }),
  saveProvider: (p: {
    id?: string;
    name: string;
    base_url: string;
    api_key: string;
  }) => requestAPI<IConfig>('config/provider', p),
  removeProvider: (id: string) =>
    requestAPI<IConfig>('config/provider/remove', { id }),
  editModels: (provider: string, change: { add?: string; remove?: string }) =>
    requestAPI<IConfig>('config/models', { provider, ...change }),
  providersFile: () =>
    requestAPI<{ text: string; custom: boolean }>('config/providers'),
  saveProviders: (text: string) =>
    requestAPI<IConfig>('config/providers', { text }),
  resetProviders: () =>
    requestAPI<IConfig>('config/providers', { reset: true }),

  run: (
    assignment: IApiAssignment,
    opts: {
      cellIds?: string[];
      mode: StudentMode;
      models: string[];
      runs: number;
      grader: string | null;
      jobId: string;
      agentStepsPerQuestion?: number;
      agentMaxSteps?: number;
    },
    workspace: IWorkspace
  ) =>
    requestAPI<{
      results?: Record<string, IAnswer[]>;
      /** stopped before it finished; cost = what it spent until then */
      cancelled?: boolean;
      cost?: number;
    }>('run', {
      assignment,
      cell_ids: opts.cellIds,
      mode: opts.mode,
      models: opts.models,
      runs: opts.runs,
      grader: opts.grader,
      job_id: opts.jobId,
      agent_steps_per_question: opts.agentStepsPerQuestion,
      agent_max_steps: opts.agentMaxSteps,
      ...workspace
    }),
  progress: (jobIds: string[]) =>
    requestAPI<Record<string, IProgress | null>>(
      `run/progress?ids=${encodeURIComponent(jobIds.join(','))}`
    ),
  /** keepalive: still sent while the page is closing */
  cancel: (jobIds: string[], keepalive = false) =>
    requestAPI<{ cancelled: string[] }>(
      'run/cancel',
      { ids: jobIds },
      keepalive
    ),

  grade: (
    assignment: IApiAssignment,
    cellId: string,
    answers: IAnswer[],
    grader: string,
    workspace: IWorkspace
  ) =>
    requestAPI<{ answers: IAnswer[] }>('grade', {
      assignment,
      cell_id: cellId,
      answers,
      grader,
      ...workspace
    }),

  harden: (
    assignment: IApiAssignment,
    cellId: string,
    answers: IAnswer[],
    model: string
  ) =>
    requestAPI<{ markdown: string; cost: number }>('harden', {
      assignment,
      cell_id: cellId,
      answers,
      model
    }),

  export: (path: string) => requestAPI<{ files: string[] }>('export', { path }),
  existingExports: (path: string) =>
    requestAPI<{ existing: string[] }>('export', { path, check: true })
};
