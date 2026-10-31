import { Dialog, showDialog } from '@jupyterlab/apputils';
import React, { useState } from 'react';

import { api } from '../request';
import { Store } from '../store';
import { IProviderInfo } from '../types';

/** Provider blocks with their models (as student checkboxes), plus "Add provider". */
export function ProviderList({ store }: { store: Store }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="aiss-models">
      {store.config?.providers.map(p => (
        <ProviderBlock key={p.id} provider={p} store={store} />
      ))}
      {adding ? (
        <ProviderForm store={store} onDone={() => setAdding(false)} />
      ) : (
        <button
          className="aiss-link aiss-small aiss-add-provider"
          onClick={() => setAdding(true)}
          title="Any OpenAI-compatible endpoint, e.g. one hosted by your university"
        >
          + Add provider
        </button>
      )}
    </div>
  );
}

function ProviderBlock({
  provider: p,
  store
}: {
  provider: IProviderInfo;
  store: Store;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const { settings } = store;

  const toggleStudent = (key: string) =>
    store.update({
      students: settings.students.includes(key)
        ? settings.students.filter(k => k !== key)
        : [...settings.students, key]
    });

  const change = async (request: Promise<unknown>) => {
    try {
      await request;
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addModel = async (id: string) => {
    await change(store.changeConfig(api.editModels(p.id, { add: id })));
    // A model you just added is one you want to try.
    const key = `${p.id}:${id}`;
    if (p.available && !store.settings.students.includes(key)) {
      void store.update({ students: [...store.settings.students, key] });
    }
  };

  const listed = p.models.map(m => m.id);
  const noKey = !p.key_set;
  const keyRejected = p.key_set && !!p.error?.includes('rejected');

  return (
    <div className="aiss-provider">
      <div className="aiss-provider-name">
        <span>{p.name}</span>
        {noKey && <span className="aiss-muted aiss-small">no API key yet</span>}
        {!noKey && p.error && (
          <span className="aiss-error-text aiss-small">{p.error}</span>
        )}
        <span className="aiss-spacer" />
        <button
          className="aiss-icon aiss-small"
          title={p.builtin ? 'Change the API key' : 'Edit or remove provider'}
          onClick={() => setEditing(!editing)}
        >
          ✎
        </button>
      </div>

      {editing ? (
        <ProviderForm
          store={store}
          provider={p}
          onDone={() => setEditing(false)}
        />
      ) : (
        (noKey || keyRejected) && <KeyInput provider={p} store={store} />
      )}

      {p.models.map(m => (
        <div key={m.key} className="aiss-model-row">
          <label
            className={`aiss-model ${p.available ? '' : 'aiss-disabled'}`}
            title={m.id}
          >
            <input
              type="checkbox"
              disabled={!p.available}
              checked={settings.students.includes(m.key)}
              onChange={() => toggleStudent(m.key)}
            />
            <span>{m.label.replace(/^[^:]+:\s*/, '')}</span>
            {m.pricing && (
              <span
                className="aiss-muted aiss-small"
                title="USD per million tokens (input / output)"
              >
                ${(m.pricing.prompt * 1e6).toFixed(2)}/$
                {(m.pricing.completion * 1e6).toFixed(2)}
              </span>
            )}
            {!!p.catalog.length && !p.catalog.includes(m.id) && (
              <span
                className="aiss-error-text aiss-small"
                title="The endpoint does not list this model id"
              >
                unknown id
              </span>
            )}
          </label>
          <button
            className="aiss-icon aiss-small aiss-remove"
            title="Remove this model from the list"
            onClick={() =>
              change(store.changeConfig(api.editModels(p.id, { remove: m.id })))
            }
          >
            ✕
          </button>
        </div>
      ))}
      {!p.models.length && (
        <p className="aiss-muted aiss-small">No models yet. Add one below.</p>
      )}
      <AddModel
        catalog={p.catalog.filter(id => !listed.includes(id))}
        listId={`aiss-catalog-${p.id}`}
        onAdd={id => void addModel(id)}
      />
      {error && <div className="aiss-error-text aiss-small">{error}</div>}
    </div>
  );
}

function AddModel({
  catalog,
  listId,
  onAdd
}: {
  catalog: string[];
  listId: string;
  onAdd: (id: string) => void;
}) {
  const [value, setValue] = useState('');
  const add = () => {
    if (value.trim()) {
      onAdd(value.trim());
      setValue('');
    }
  };
  return (
    <div className="aiss-key">
      <input
        list={listId}
        placeholder={
          catalog.length ? '+ Add model (type to search)' : '+ Add model id'
        }
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && add()}
      />
      <datalist id={listId}>
        {catalog.map(id => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {value.trim() && (
        <button className="aiss-btn" onClick={add}>
          Add
        </button>
      )}
    </div>
  );
}

function KeyInput({
  provider,
  store
}: {
  provider: IProviderInfo;
  store: Store;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await store.changeConfig(api.setKey(provider.id, value));
      setValue('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="aiss-key">
      <input
        type="password"
        placeholder={`${provider.name} API key`}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && value && save()}
      />
      <button className="aiss-btn" disabled={!value || busy} onClick={save}>
        {busy ? <span className="aiss-spinner" /> : 'Save'}
      </button>
      {error && <div className="aiss-error-text aiss-small">{error}</div>}
    </div>
  );
}

/** Add a provider (no `provider`) or edit one. The server tests the connection before saving. */
function ProviderForm({
  store,
  provider,
  onDone
}: {
  store: Store;
  provider?: IProviderInfo;
  onDone: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const builtin = !!provider?.builtin;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await store.changeConfig(
        api.saveProvider({
          id: provider?.id,
          name,
          base_url: baseUrl,
          api_key: key
        })
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const result = await showDialog({
      title: `Remove ${provider!.name}?`,
      body: 'Its models and stored API key are removed from this computer. You can add it again later.',
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Remove' })]
    });
    if (!result.button.accept) {
      return;
    }
    try {
      await store.changeConfig(api.removeProvider(provider!.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="aiss-provider-form">
      {!builtin && (
        <>
          <label>
            Name
            <input
              value={name}
              placeholder="e.g. University"
              onChange={e => setName(e.target.value)}
            />
          </label>
          <label>
            Base URL
            <input
              value={baseUrl}
              placeholder="https://…/v1"
              onChange={e => setBaseUrl(e.target.value)}
            />
          </label>
        </>
      )}
      <label>
        API key
        <input
          type="password"
          value={key}
          placeholder={
            provider?.key_set ? 'saved – leave empty to keep' : 'API key'
          }
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
        />
      </label>
      <p className="aiss-muted aiss-small">
        The key is stored only on this computer, in ~/.aissignment/.env.
      </p>
      {error && <div className="aiss-flag aiss-error">{error}</div>}
      <div className="aiss-buttons">
        <button
          className="aiss-btn aiss-primary"
          disabled={busy || (builtin && !key)}
          onClick={save}
        >
          {busy ? (
            <>
              <span className="aiss-spinner" /> Testing connection…
            </>
          ) : provider ? (
            'Save'
          ) : (
            'Add provider'
          )}
        </button>
        <button className="aiss-btn" disabled={busy} onClick={onDone}>
          Cancel
        </button>
        {provider && !builtin && (
          <>
            <span className="aiss-spacer" />
            <button className="aiss-btn" disabled={busy} onClick={remove}>
              Remove…
            </button>
          </>
        )}
      </div>
    </div>
  );
}
