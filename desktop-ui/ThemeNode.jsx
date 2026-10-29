import React from 'react';
import { Icon } from './Icon.jsx';
import { createThemeClient } from './theme-client.mjs';
import { defaultThemeTokens } from '../themes/schema.mjs';
import { THEME_PRESETS } from '../themes/presets.mjs';

const COLORS = ['background', 'surface', 'text', 'muted', 'accent', 'border', 'accentSoft', 'accentStrong'];
export function ThemeNode({ data }) {
  const { hubClient, onThemeWorkspace, onThemePreview } = data;
  const settings = Boolean(data.settings);
  const client = React.useMemo(() => createThemeClient({ hubClient }), [hubClient]);
  const [workspace, setWorkspace] = React.useState(null);
  const [draft, setDraft] = React.useState(() => defaultThemeTokens());
  const [name, setName] = React.useState('Custom theme');
  const [selected, setSelected] = React.useState('new');
  const [targetVersion, setTargetVersion] = React.useState(1);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const applyWorkspace = React.useCallback(value => {
    setWorkspace(value); onThemeWorkspace?.(value);
    const active = value.active;
    setSelected(active?.theme.id ?? 'new'); setDraft(active?.version.tokens ?? defaultThemeTokens());
    setName(active?.theme.name ?? 'Custom theme'); setTargetVersion(active ? Math.max(1, active.theme.currentVersion - 1) : 1);
  }, [onThemeWorkspace]);
  const load = React.useCallback(async signal => {
    const value = await client.workspace(signal); applyWorkspace(value); return value;
  }, [client, applyWorkspace]);
  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(failure => { if (failure.code !== 'ABORTED') setError('Could not load themes.'); });
    return () => controller.abort();
  }, [load]);
  function preview(next) { setDraft(next); onThemePreview?.(next); }
  function edit(patch) { preview({ ...draft, ...patch }); }
  function editGroup(group, key, value) { preview({ ...draft, [group]: { ...draft[group], [key]: value } }); }
  async function mutate(operation) {
    if (pending) return;
    setPending(true); setError('');
    try { const result = await operation(); if (result.workspace) applyWorkspace(result.workspace); else await load(); }
    catch (failure) { setError(failure.code ?? 'Theme operation failed.'); }
    finally { setPending(false); }
  }
  const active = workspace?.active;
  const request = () => ({ expectedWorkspaceRevision: workspace.revision, idempotencyKey: crypto.randomUUID() });
  const save = () => mutate(() => selected !== 'new' && active?.theme.id === selected
    ? client.append(selected, { ...request(), base: draft.base, tokens: draft, expectedVersion: active.theme.currentVersion })
    : client.create({ ...request(), name, base: draft.base, tokens: draft }));
  const applyPreset = preset => mutate(() => {
    const presetId = `preset-${preset.id}`;
    const existing = workspace?.themes.find(item => item.id === presetId);
    return existing
      ? client.activate(presetId, { ...request(), expectedVersion: existing.currentVersion })
      : client.create({ ...request(), id: presetId, name: preset.name, base: preset.tokens.base, tokens: preset.tokens });
  });
  return <section className={settings ? 'theme-settings' : 'graph-card theme-card'} aria-label={settings ? 'Appearance settings' : 'theme: Theme Editor'}>
    {!settings && <header className="card-heading graph-heading">
      <span className="node-type-icon"><Icon name="sun" size={16} /></span>
      <div className="node-heading"><h2>Theme Editor</h2><small>DECLARATIVE TOKENS · REV {workspace?.revision ?? '…'}</small></div>
    </header>}
    {error && <p className="error graph-error" role="alert">{error}</p>}
    <div className="theme-editor nodrag nowheel">
      {settings && <>
        <div className="theme-settings-heading"><h2>Appearance</h2><p>Choose a preset or fine-tune your own theme.</p></div>
        <div className="theme-presets" aria-label="Theme presets">{THEME_PRESETS.map(preset => <button type="button" key={preset.id} className="theme-preset" aria-label={`Apply ${preset.name} theme`} aria-pressed={active?.theme.id === `preset-${preset.id}`} disabled={pending || !workspace} onClick={() => applyPreset(preset)}>
          <span className="theme-preset-swatches" aria-hidden="true">{['background', 'accentSoft', 'accent'].map(key => <span key={key} style={{ backgroundColor: preset.tokens.colors[key] }} />)}</span>
          <span>{preset.name}</span>
        </button>)}</div>
      </>}
      <details className="theme-custom" open={!settings}>
        <summary>Custom theme</summary>
      <div className="theme-row theme-name-row">
        <label>Name<input aria-label="Theme name" value={name} disabled={pending || selected !== 'new'} onChange={event => setName(event.target.value)} /></label>
        <label>Base<select aria-label="Theme base" value={draft.base} disabled={pending} onChange={event => edit({ base: event.target.value })}>
          <option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
      </div>
      <fieldset className="theme-colors" disabled={pending}><legend>Colors</legend>{COLORS.map(key => <label key={key}>{key}<input type="color" aria-label={`Theme ${key}`} value={draft.colors[key]} onChange={event => editGroup('colors', key, event.target.value)} /></label>)}</fieldset>
      <div className="theme-row">
        <label>Font<select aria-label="Theme font" value={draft.typography.family} disabled={pending} onChange={event => editGroup('typography', 'family', event.target.value)}>
          <option value="system">System</option><option value="serif">Serif</option><option value="mono">Mono</option>
        </select></label>
        <label>Size<input aria-label="Theme font size" type="number" min="12" max="18" value={draft.typography.size} disabled={pending} onChange={event => editGroup('typography', 'size', Number(event.target.value))} /></label>
        <label>Density<select aria-label="Theme density" value={draft.density} disabled={pending} onChange={event => edit({ density: event.target.value })}>
          <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
        </select></label>
      </div>
      <div className="theme-row">
        <label>Shadow X<input aria-label="Theme shadow x" type="number" min="0" max="24" value={draft.shadow.x} disabled={pending} onChange={event => editGroup('shadow', 'x', Number(event.target.value))} /></label>
        <label>Shadow Y<input aria-label="Theme shadow y" type="number" min="0" max="24" value={draft.shadow.y} disabled={pending} onChange={event => editGroup('shadow', 'y', Number(event.target.value))} /></label>
        <label>Blur<input aria-label="Theme shadow blur" type="number" min="0" max="48" value={draft.shadow.blur} disabled={pending} onChange={event => editGroup('shadow', 'blur', Number(event.target.value))} /></label>
        <label>Opacity<input aria-label="Theme shadow opacity" type="number" min="0" max="0.5" step="0.01" value={draft.shadow.opacity} disabled={pending} onChange={event => editGroup('shadow', 'opacity', Number(event.target.value))} /></label>
      </div>
      </details>
      {workspace?.proposals.length > 0 && <div className="theme-proposals"><strong>Agent proposals · review required</strong>{workspace.proposals.map(proposal => <div key={proposal.theme.id}>
        <span>{proposal.theme.name} · v{proposal.theme.currentVersion}</span>
        <button type="button" disabled={pending} onClick={() => preview(proposal.version.tokens)}>Preview</button>
        <button type="button" disabled={pending} onClick={() => mutate(() => client.activate(proposal.theme.id, { ...request(), expectedVersion: proposal.theme.currentVersion }))}>Accept</button>
        <button type="button" disabled={pending} onClick={() => mutate(() => client.reject(proposal.theme.id, { expectedVersion: proposal.theme.currentVersion, idempotencyKey: crypto.randomUUID() }))}>Reject</button>
      </div>)}</div>}
    </div>
    <footer className={settings ? 'theme-settings-actions' : 'graph-actions nodrag'}>
      <button type="button" disabled={pending || !workspace} onClick={save}>{selected === 'new' ? 'Save theme' : 'Save version'}</button>
      <button type="button" disabled={pending || !workspace} onClick={() => applyWorkspace(workspace)}>Reset</button>
      <button type="button" disabled={pending || !active} onClick={() => mutate(() => client.disable(request()))}>Disable</button>
      {active && <button type="button" disabled={pending || selected !== active.theme.id} onClick={() => { setSelected('new'); setName(`${active.theme.name} copy`); }}>New copy</button>}
      {active && active.theme.currentVersion > 1 && <>
        <select aria-label="Theme rollback version" value={targetVersion} onChange={event => setTargetVersion(Number(event.target.value))}>{Array.from({ length: active.theme.currentVersion - 1 }, (_, index) => active.theme.currentVersion - index - 1).map(version => <option key={version} value={version}>v{version}</option>)}</select>
        <button type="button" disabled={pending || selected !== active.theme.id} onClick={() => mutate(() => client.rollback(active.theme.id, { ...request(), expectedVersion: active.theme.currentVersion, targetVersion }))}>Rollback</button>
      </>}
    </footer>
  </section>;
}
