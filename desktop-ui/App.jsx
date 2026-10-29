import React from 'react';
import Canvas from './Canvas.jsx';
import WikiPane from './WikiPane.jsx';
import SourcePane from './SourcePane.jsx';
import { createSourceController } from './source-controller.mjs';
import { createSessionController } from './session-controller.mjs';
import { createGraphClient } from './graph-client.mjs';
import { createWikiClient } from './wiki-client.mjs';
import { createWikiController } from './wiki-controller.mjs';
import { createThemeClient } from './theme-client.mjs';
import { defaultThemeTokens, themeCssVariables } from '../themes/schema.mjs';
import { ThemeNode } from './ThemeNode.jsx';
import { Icon } from './Icon.jsx';

function ConnectedCanvas({ client, cards, theme, themeVariables, modelSettingsEnabled, wikiEnabled, browserEnabled, themesEnabled, onThemeWorkspace, onThemePreview, onDeleteCard }) {
  const [catalogError, setCatalogError] = React.useState('');
  const [modelCatalog, setModelCatalog] = React.useState(null);
  const graphClient = React.useMemo(() => createGraphClient({ hubClient: client }), [client]);
  const [graph, setGraph] = React.useState(null);
  const [graphError, setGraphError] = React.useState('');
  // Catalog additions preserve this connection's histories and uncertain requests.
  const controller = React.useMemo(() => createSessionController({ client, cards }), [client]);
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => {
    void controller.refresh();
    const timer = setInterval(() => { void controller.refresh(); }, 1000);
    return () => { clearInterval(timer); controller.dispose(); };
  }, [controller]);
  React.useEffect(() => {
    try {
      controller.removeCards(cards.map(card => card.id));
      const { added } = controller.addCards(cards);
      setCatalogError('');
      if (added) void controller.refresh();
    } catch {
      setCatalogError('Could not attach refreshed cards. Existing chats were preserved.');
    }
  }, [controller, cards]);
  React.useEffect(() => {
    if (!modelSettingsEnabled || typeof client.modelCatalog !== 'function') { setModelCatalog(null); return; }
    let active = true;
    const abort = new AbortController();
    client.modelCatalog(abort.signal).then(catalog => { if (active) setModelCatalog(catalog); }).catch(() => {
      if (active) { setModelCatalog(null); setCatalogError('Model settings are unavailable. Existing chats were preserved.'); }
    });
    return () => { active = false; abort.abort(); };
  }, [client, modelSettingsEnabled]);
  const refreshGraph = React.useCallback(async () => {
    const snapshot = await graphClient.snapshot();
    setGraph(snapshot); setGraphError('');
    return snapshot;
  }, [graphClient]);
  React.useEffect(() => {
    let active = true, reading = false;
    const tick = async () => {
      if (reading) return;
      reading = true;
      try { const snapshot = await graphClient.snapshot(); if (active) { setGraph(snapshot); setGraphError(''); } }
      catch { if (active) setGraphError('Workspace graph is unavailable. Existing nodes were preserved.'); }
      finally { reading = false; }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [graphClient]);
  async function graphMutation(operation) {
    setGraphError('');
    let result;
    try { result = await operation(); }
    catch (failure) { setGraphError(failure.code ?? 'Graph mutation failed.'); throw failure; }
    try { await refreshGraph(); }
    catch { setGraphError('Mutation accepted; graph refresh failed. Reconnect before retrying.'); }
    return result;
  }
  const createGraphNode = kind => graphMutation(() => {
    if (kind === 'wiki' && !wikiEnabled || kind === 'browser' && !browserEnabled || kind === 'theme') throw Object.assign(new Error('NODE_UNAVAILABLE'), { code: 'NODE_UNAVAILABLE' });
    const count = graph?.nodes.length ?? cards.length;
    const titles = { wiki: 'New Wiki', artifact: 'New Artifact', browser: 'Remote Browser' };
    return graphClient.createNode({ kind, title: titles[kind], ...(kind === 'browser' ? { mode: 'remote-read-only', allowedHosts: ['example.com'] } : {}),
      x: 80 + count % 3 * 560, y: 80 + Math.floor(count / 3) * 560 });
  });
  const messagesBySession = Object.fromEntries(Object.entries(state.messagesBySession).map(([sessionId, messages]) => {
    const running = state.statusBySession[sessionId] === 'running';
    const lastIndex = messages.length - 1;
    return [sessionId, messages.map((message, index) => index === lastIndex && running && message.role === 'user' && !message.pending
      ? { ...message, receiptPending: true }
      : message)];
  }));
  return <Canvas {...state} theme={theme} themeVariables={themeVariables} graph={graph} hubClient={client} graphClient={graphClient} graphWikiEnabled={wikiEnabled}
    graphBrowserEnabled={browserEnabled} graphThemesEnabled={themesEnabled} onThemeWorkspace={onThemeWorkspace} onThemePreview={onThemePreview} onGraphRefresh={refreshGraph}
    messagesBySession={messagesBySession} onSend={controller.send} onCancel={controller.cancel} onApproveEffect={controller.approveEffect} onMove={controller.move} onResize={controller.resize} onRename={controller.rename} onUpdateModel={controller.updateModel} onDelete={onDeleteCard} modelCatalog={modelCatalog}
    onCreateGraphNode={createGraphNode} onRun={input => graphMutation(() => graphClient.run(input))} onTrigger={input => graphMutation(() => graphClient.trigger(input))}
    onGraphConnect={input => graphMutation(() => graphClient.createEdge(input))}
    onGraphMove={(nodeId, input) => graphMutation(() => graphClient.updateLayout(nodeId, input))}
    onUpdateArtifact={(nodeId, input) => graphMutation(() => graphClient.updateArtifact(nodeId, input))}
    onReconnect={() => { void controller.refresh(); void refreshGraph().catch(() => {}); }} connectionLabel="Hub" connectionError={catalogError || graphError || undefined} />;
}

function ConnectedWiki({ client, active }) {
  const controller = React.useMemo(() => createWikiController({ client: createWikiClient({ hubClient: client }) }), [client]);
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => () => controller.dispose(), [controller]);
  React.useEffect(() => { if (active) void controller.search(''); }, [active, controller]);
  return <WikiPane state={state} actions={controller} />;
}

function ConnectedSource({ client, active }) {
  const controller = React.useMemo(() => createSourceController({ hubClient: client }), [client]);
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => () => controller.dispose(), [controller]);
  React.useEffect(() => { if (active && !controller.getSnapshot().files.length) void controller.refresh(); }, [active, controller]);
  return <SourcePane state={state} actions={controller} />;
}

function Workspace({ client, cards, workspaceActions, workspaceNotices, onDeleteCard }) {
  const [activeTheme, setActiveTheme] = React.useState(null);
  const [previewTokens, setPreviewTokens] = React.useState(null);
  const themeClient = React.useMemo(() => createThemeClient({ hubClient: client }), [client]);
  const onThemeWorkspace = React.useCallback(value => { setActiveTheme(value.active); setPreviewTokens(null); }, []);
  const [view, setView] = React.useState('chats');
  const [capabilityRecord, setCapabilityRecord] = React.useState(null);
  const [capabilityError, setCapabilityError] = React.useState(null);
  const [retry, setRetry] = React.useState(0);
  const capabilities = capabilityRecord?.client === client && capabilityRecord.retry === retry ? capabilityRecord.modules : null;
  const hasCapabilityError = capabilityError?.client === client && capabilityError.retry === retry;
  const generation = React.useRef(0);
  React.useEffect(() => {
    let active = true;
    const current = ++generation.current;
    const controller = new AbortController();
    void Promise.resolve().then(() => client.moduleRequest({ method: 'GET', path: '/v1/modules/workspace/capabilities', signal: controller.signal })).then(result => {
      if (!active || generation.current !== current) return;
      const knownModules = ['wiki', 'handoff', 'sourceWorkbench', 'models', 'artifactEngine', 'backends', 'pluginPlane', 'channels', 'memory', 'browser', 'themes', 'connectors'];
      const valid = result && !Array.isArray(result) && Object.keys(result).length === 2 && [1, 2, 3].includes(result.version) &&
        result.modules && typeof result.modules === 'object' && !Array.isArray(result.modules) &&
        Object.entries(result.modules).every(([key, value]) => knownModules.includes(key) && typeof value === 'boolean') &&
        typeof result.modules.wiki === 'boolean' && typeof result.modules.handoff === 'boolean' &&
        (result.version === 1 || typeof result.modules.sourceWorkbench === 'boolean') &&
        (result.version < 3 || typeof result.modules.models === 'boolean');
      if (!valid) throw new Error('invalid capability response');
      setCapabilityRecord({ client, retry, modules: { ...result.modules } }); setCapabilityError(null);
    }).catch(() => { if (active && generation.current === current) setCapabilityError({ client, retry }); });
    return () => { active = false; generation.current++; controller.abort(); };
  }, [client, retry]);
  React.useEffect(() => {
    setActiveTheme(null); setPreviewTokens(null);
    if (!capabilities?.themes) return;
    const controller = new AbortController();
    themeClient.workspace(controller.signal).then(value => { setActiveTheme(value.active); }).catch(() => {});
    return () => controller.abort();
  }, [themeClient, capabilities?.themes]);
  React.useEffect(() => { if (view === 'wiki' && !capabilities?.wiki || view === 'source' && !capabilities?.sourceWorkbench || view === 'settings' && !capabilities?.themes) setView('chats'); }, [view, capabilities]);
  React.useEffect(() => { if (view !== 'settings') setPreviewTokens(null); }, [view]);
  const tokens = previewTokens ?? activeTheme?.version.tokens ?? defaultThemeTokens('light');
  const themeVariables = themeCssVariables(tokens);
  const views = [
    { id: 'chats', label: 'Chats', icon: 'chat', enabled: true },
    { id: 'wiki', label: 'Wiki', icon: 'wiki', enabled: capabilities?.wiki },
    { id: 'source', label: 'Source', icon: 'source', enabled: capabilities?.sourceWorkbench },
  ];
  return <main className="aylachi workspace-app" data-theme={tokens.base} style={themeVariables}>
    <aside className="side-rail">
      <div className="brand-mark" aria-label="Aylachi">A<span>·</span></div>
      {workspaceActions?.create}
      <div className="rail-separator" />
      <nav className="rail-nav" aria-label="Workspace views">
        {views.filter(item => item.enabled).map(item => <button type="button" className="rail-button" key={item.id} id={`${item.id}-tab`} aria-controls={`${item.id}-panel`} aria-label={item.label} title={item.label} aria-pressed={view === item.id} onClick={() => setView(item.id)}>
          <Icon name={item.icon} /><span className="sr-only">{item.label}</span>
        </button>)}
      </nav>
      <div className="rail-spacer" />
      {workspaceActions?.refresh}
      <button type="button" className="rail-button" id="settings-tab" aria-controls="settings-panel" aria-label="Settings" title="Settings" aria-pressed={view === 'settings'} disabled={!capabilities?.themes} onClick={() => setView('settings')}>
        <Icon name="settings" /><span className="sr-only">Settings</span>
      </button>
    </aside>
    <div className="workspace-body">
      <div className="workspace-notices">
        {workspaceNotices}
        {hasCapabilityError && <div role="alert"><span>Optional modules are unavailable until capabilities load.</span> <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
        {!capabilities && !hasCapabilityError && <p role="status">Checking optional modules…</p>}
      </div>
      <div className="workspace-content">
        <section id="chats-panel" aria-labelledby="chats-tab" hidden={view !== 'chats'}><ConnectedCanvas client={client} cards={cards} onDeleteCard={onDeleteCard} theme={tokens.base} themeVariables={themeVariables}
          modelSettingsEnabled={capabilities?.models === true} wikiEnabled={capabilities?.wiki === true} browserEnabled={capabilities?.browser === true} themesEnabled={capabilities?.themes === true}
          onThemeWorkspace={onThemeWorkspace} onThemePreview={setPreviewTokens} /></section>
        {capabilities?.wiki && <section id="wiki-panel" aria-labelledby="wiki-tab" hidden={view !== 'wiki'}><ConnectedWiki client={client} active={view === 'wiki'} /></section>}
        {capabilities?.sourceWorkbench && <section id="source-panel" aria-labelledby="source-tab" hidden={view !== 'source'}><ConnectedSource client={client} active={view === 'source'} /></section>}
        {capabilities?.themes && <section id="settings-panel" aria-labelledby="settings-tab" hidden={view !== 'settings'}><ThemeNode data={{ hubClient: client, settings: true, onThemeWorkspace, onThemePreview: setPreviewTokens }} /></section>}
      </div>
    </div>
  </main>;
}

export default function App({ client, cards, bootstrapError, workspaceActions, workspaceNotices, onDeleteCard }) {
  if (client) return <Workspace client={client} cards={cards} workspaceActions={workspaceActions} workspaceNotices={workspaceNotices} onDeleteCard={onDeleteCard} />;
  return <Canvas cards={cards} connectionLabel="Disconnected fixture" connectionError={bootstrapError} />;
}
