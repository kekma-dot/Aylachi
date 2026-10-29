import React from 'react';
import { Icon } from './Icon.jsx';
import { Markdown } from './Markdown.jsx';
import { createWikiClient } from './wiki-client.mjs';
import { createWikiController } from './wiki-controller.mjs';
import { htmlPreviewDocument } from '../artifact-engine/renderers.mjs';

export function HtmlArtifactPreview({ title, artifactId, content }) {
  if (content == null) return <p role="status">Loading preview…</p>;
  return <iframe key={artifactId} className="artifact-html-preview" title={`${title} preview`} sandbox="" srcDoc={htmlPreviewDocument(content)} />;
}

export function GraphNode({ data }) {
  const { node, hubClient, graphClient } = data;
  const [mode, setMode] = React.useState('preview');
  const [definition, setDefinition] = React.useState(node.settings.content ?? '');
  const [draft, setDraft] = React.useState(node.settings.content ?? '');
  const [preview, setPreview] = React.useState(node.settings.content ?? '');
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const wiki = React.useMemo(() => createWikiController({ client: createWikiClient({ hubClient }) }), [hubClient]);
  const wikiState = React.useSyncExternalStore(wiki.subscribe, wiki.getSnapshot, wiki.getSnapshot);
  const artifact = data.artifacts.find(item => item.nodeId === node.id);
  const run = data.runs.find(item => item.nodes.some(itemNode => itemNode.nodeId === node.id));
  const dirty = node.kind === 'wiki' ? wikiState.dirty : draft !== definition;

  React.useEffect(() => () => wiki.dispose(), [wiki]);
  React.useEffect(() => { if (node.kind === 'wiki') void wiki.openNote(node.refId, { discard: true }); }, [wiki, node.kind, node.refId]);
  React.useEffect(() => {
    if (node.kind !== 'artifact') return;
    const controller = new AbortController();
    graphClient.node(node.id, controller.signal).then(result => {
      const content = result.node.settings.content ?? '';
      setDefinition(content);
      setDraft(current => current === definition ? content : current);
    }).catch(failure => { if (failure.code !== 'ABORTED') setError('Could not load artifact definition.'); });
    return () => controller.abort();
  }, [graphClient, node.id, node.kind, node.revision]);
  React.useEffect(() => {
    if (mode !== 'preview') return;
    if (!artifact) { setPreview(node.kind === 'wiki' ? wikiState.draft : draft); return; }
    const controller = new AbortController();
    graphClient.artifact(artifact.id, controller.signal).then(result => setPreview(result.artifact.content ?? ''))
      .catch(failure => { if (failure.code !== 'ABORTED') setError('Could not load run artifact.'); });
    return () => controller.abort();
  }, [graphClient, mode, artifact?.id, node.kind, draft, wikiState.draft]);

  async function save() {
    if (pending || !dirty) return;
    setPending(true); setError('');
    try {
      if (node.kind === 'wiki') {
        if (!await wiki.save()) setError(wiki.getSnapshot().error ?? 'Wiki save failed.');
      } else {
        await data.onUpdateArtifact(node.id, { expectedRevision: node.revision, title: node.title, content: draft });
        setDefinition(draft);
      }
    } catch (failure) { setError(failure.code ?? 'Save failed.'); }
    finally { setPending(false); }
  }
  async function runNode(scope) {
    if (pending) return;
    setPending(true); setError('');
    try { await data.onRun({ scope, ...(scope === 'all' ? {} : { nodeId: node.id }) }); setMode('preview'); }
    catch (failure) { setError(failure.code ?? 'Run failed.'); }
    finally { setPending(false); }
  }

  const source = node.kind === 'wiki' ? wikiState.draft : draft;
  const busy = pending || node.kind === 'wiki' && wikiState.busy;
  return <section className="graph-card" aria-label={`${node.kind}: ${node.title}`}>
    <header className="card-heading graph-heading">
      <span className="node-type-icon"><Icon name={node.kind === 'wiki' ? 'wiki' : 'source'} size={16} /></span>
      <div className="node-heading"><h2>{node.title}</h2><small>{node.kind.toUpperCase()} · REV {node.revision}</small></div>
      {run && <span className={`run-state run-${run.status.toLowerCase()}`}>{run.status}</span>}
      <button type="button" className="graph-source-button nodrag" aria-label={mode === 'source' ? 'Close source' : 'View source'} title={mode === 'source' ? 'Back to preview' : 'View source'} aria-pressed={mode === 'source'} onClick={() => setMode(current => current === 'source' ? 'preview' : 'source')}>Source</button>
    </header>
    {(error || wikiState.error) && <p className="error graph-error" role="alert">{error || wikiState.error}</p>}
    {wikiState.conflict && <button type="button" className="nodrag graph-reconcile" onClick={() => wiki.reconcile()}>Refresh server revision</button>}
    {mode === 'source' ? <textarea className="graph-editor nodrag nowheel" aria-label={`${node.title} source`} value={source}
      disabled={busy || node.kind === 'wiki' && wikiState.uncertain} onChange={event => node.kind === 'wiki' ? wiki.edit(event.target.value) : setDraft(event.target.value)} /> :
      <div className="graph-preview nodrag nowheel">
        {node.kind === 'artifact' && node.settings.format === 'html'
          ? <HtmlArtifactPreview title={node.title} artifactId={artifact?.id ?? node.id} content={preview} />
          : <Markdown text={preview} mermaid />}
        {artifact && <small className="artifact-ref">run {artifact.runId.slice(0, 8)} · node {artifact.nodeId.slice(0, 8)} · attempt {artifact.attempt}</small>}
      </div>}
    <footer className="graph-actions nodrag">
      {mode === 'source' && <button type="button" disabled={busy || !dirty || node.kind === 'wiki' && (wikiState.conflict || wikiState.uncertain)} onClick={save}>Save</button>}
      <span className="graph-action-spacer" />
      <button type="button" disabled={busy || dirty} title={dirty ? 'Save the definition before running' : undefined} onClick={() => runNode('node')}>Run node</button>
      <button type="button" disabled={busy || dirty} onClick={() => runNode('branch')}>Run branch</button>
    </footer>
  </section>;
}
