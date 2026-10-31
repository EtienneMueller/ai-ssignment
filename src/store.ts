import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ISignal, Signal } from '@lumino/signaling';

import { modelIndex } from './lib';
import { api } from './request';
import { IConfig, ISettings } from './types';

const DEFAULTS: ISettings = {
  students: [],
  grader: '',
  runs: 1,
  mode: 'copy',
  confirmAboveUsd: 0.25,
  allowCodeExecution: false,
  agentStepsPerQuestion: 4,
  agentMaxSteps: 24
};

/** App-wide state: provider config, user settings, session cost. */
export class Store {
  private _changed = new Signal<this, void>(this);
  private _settings: ISettings = { ...DEFAULTS };
  private _registry: ISettingRegistry.ISettings | null = null;

  config: IConfig | null = null;
  configError: string | null = null;
  spent = 0;

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  emit(): void {
    this._changed.emit();
  }

  /** Settings with defaults from the provider config filled in. */
  get settings(): ISettings {
    const s = this._settings;
    const index = modelIndex(this.config);
    // Only models of usable providers (key set, reachable); the saved selection is kept.
    const usable = (k: string) => !!index[k]?.available;
    let students = s.students.filter(usable);
    if (!students.length) {
      students = (this.config?.defaults.students ?? []).filter(usable);
    }
    let grader = usable(s.grader)
      ? s.grader
      : (this.config?.defaults.grader ?? '');
    if (!usable(grader)) {
      grader = Object.keys(index).find(k => index[k].available) ?? '';
    }
    return { ...s, students, grader };
  }

  async connectSettings(
    registry: ISettingRegistry,
    pluginId: string
  ): Promise<void> {
    try {
      this._registry = await registry.load(pluginId);
      const read = () => {
        this._settings = {
          ...DEFAULTS,
          ...(this._registry!.composite as Partial<ISettings>)
        };
        this.emit();
      };
      read();
      this._registry.changed.connect(read);
    } catch (e) {
      console.error('aissignment: could not load settings', e);
    }
  }

  async update(patch: Partial<ISettings>): Promise<void> {
    this._settings = { ...this._settings, ...patch };
    this.emit();
    if (this._registry) {
      for (const [key, value] of Object.entries(patch)) {
        await this._registry.set(key, value as any);
      }
    }
  }

  async loadConfig(reload = false): Promise<void> {
    try {
      this.config = reload ? await api.reloadConfig() : await api.config();
      this.configError = null;
    } catch (e) {
      this.configError = (e as Error).message;
    }
    this.emit();
  }

  /** Run a config-changing request and use the reloaded config it returns. */
  async changeConfig(request: Promise<IConfig>): Promise<void> {
    this.config = await request;
    this.emit();
  }

  addCost(usd: number): void {
    this.spent += usd;
    this.emit();
  }
}
