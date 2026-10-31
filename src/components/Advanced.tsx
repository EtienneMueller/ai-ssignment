import React, { useEffect, useState } from 'react';

import type { NotebookController } from '../controller';
import { api } from '../request';
import { Store } from '../store';

/** Collapsible sidebar section: clearing AI results, cost threshold, providers.json editor. */
export function AdvancedSettings({
  store,
  controller
}: {
  store: Store;
  controller?: NotebookController;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null); // providers.json as saved
  const [draft, setDraft] = useState('');
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const { config, settings } = store;

  const load = async () => {
    try {
      const file = await api.providersFile();
      setText(file.text);
      setDraft(file.text);
      setCustom(file.custom);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Providers and models are also edited in the AI students section: keep the file view current,
  // unless there are unsaved edits in the text box.
  useEffect(() => {
    if (open && draft === (text ?? '')) {
      void load();
    }
  }, [open, config]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details
      className="aiss-advanced"
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>Advanced settings</summary>

      {controller && <ClearAI controller={controller} />}

      <h4>Agent students</h4>
      <p className="aiss-muted aiss-small">
        How often an agent may run code before it has to hand in. More runs let
        it check and fix more, but cost more: every run sends the conversation
        so far again.
      </p>
      <label className="aiss-field">
        <span>Code runs per question</span>
        <input
          className="aiss-number"
          type="number"
          min={1}
          max={10}
          value={settings.agentStepsPerQuestion}
          onChange={e =>
            store.update({
              agentStepsPerQuestion: Math.min(
                10,
                Math.max(1, Math.round(Number(e.target.value)) || 1)
              )
            })
          }
        />
      </label>
      <label className="aiss-field">
        <span>Code runs per notebook (at most)</span>
        <input
          className="aiss-number"
          type="number"
          min={1}
          max={60}
          value={settings.agentMaxSteps}
          onChange={e =>
            store.update({
              agentMaxSteps: Math.min(
                60,
                Math.max(1, Math.round(Number(e.target.value)) || 1)
              )
            })
          }
        />
      </label>

      <h4>Costs</h4>
      <label className="aiss-field">
        <span>Ask before runs above</span>
        <span>
          $
          <input
            className="aiss-number"
            type="number"
            min={0}
            step={0.05}
            value={settings.confirmAboveUsd}
            onChange={e =>
              store.update({
                confirmAboveUsd: Math.max(0, Number(e.target.value) || 0)
              })
            }
          />
        </span>
      </label>

      <h4>Configuration files</h4>
      <p className="aiss-muted aiss-small">
        Providers and models are managed in the AI students section above. They
        are saved in providers.json, which you can also edit directly.
      </p>
      <button
        className="aiss-link aiss-small"
        onClick={() => setShowJson(!showJson)}
      >
        {showJson ? 'Hide' : 'Edit'} providers.json
      </button>
      {showJson && (
        <div className="aiss-json">
          <textarea
            spellCheck={false}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={16}
          />
          <div className="aiss-buttons">
            <button
              className="aiss-btn"
              disabled={busy || draft === text}
              onClick={() =>
                act(() => store.changeConfig(api.saveProviders(draft)))
              }
            >
              Save &amp; reload
            </button>
            <button
              className="aiss-btn"
              disabled={busy || draft === text}
              onClick={() => setDraft(text ?? '')}
            >
              Discard changes
            </button>
            {custom && (
              <button
                className="aiss-btn"
                disabled={busy}
                title="Delete your providers.json and use the built-in defaults (OpenRouter only)"
                onClick={() =>
                  act(() => store.changeConfig(api.resetProviders()))
                }
              >
                Reset to defaults
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="aiss-flag aiss-error">{error}</div>}
      {config && (
        <p className="aiss-muted aiss-small aiss-paths">
          Providers: {config.providers_path}
          {custom ? '' : ' (not created yet: using the built-in defaults)'}
          <br />
          API keys: {config.env_path}
        </p>
      )}
      <button
        className="aiss-link aiss-small"
        disabled={busy}
        onClick={() => act(() => store.loadConfig(true))}
      >
        Reload provider settings
      </button>
    </details>
  );
}

function ClearAI({ controller }: { controller: NotebookController }) {
  const { answers, suggestions } = controller.stored();
  return (
    <>
      <h4>Clear AI from notebook</h4>
      <p className="aiss-muted aiss-small">
        AI answers, grades and 💡 suggestions are saved in the notebook. Remove
        them, e.g. before sharing the notebook. Questions and reference answers
        stay. Exports never include them.
      </p>
      <div className="aiss-buttons">
        <button
          className="aiss-btn"
          disabled={!answers || controller.running.size > 0}
          onClick={() => controller.clearAll('answers')}
        >
          Remove AI answers ({answers})
        </button>
        <button
          className="aiss-btn"
          disabled={!suggestions}
          onClick={() => controller.clearAll('suggestions')}
        >
          Remove 💡 suggestions ({suggestions})
        </button>
      </div>
    </>
  );
}
