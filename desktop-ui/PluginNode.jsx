import React from 'react';

export default function PluginNode({ data }) {
  const { node, onTrigger, activities = [] } = data;
  const [text, setText] = React.useState(() => JSON.stringify(node.settings.input ?? {}, null, 2));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const activity = activities.filter(item => item.nodeId === node.id).at(-1);
  async function trigger() {
    let input;
    try { input = JSON.parse(text); }
    catch { setError('Input must be valid JSON.'); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { setError('Input must be a JSON object.'); return; }
    setPending(true); setError('');
    try {
      await onTrigger({ nodeId: node.id, requestId: globalThis.crypto.randomUUID(), input });
    } catch (failure) { setError(failure.code ?? 'Trigger failed.'); }
    finally { setPending(false); }
  }
  return <section className="plugin-node" aria-label={`Plugin ${node.settings.toolName}`}>
    <header className="card-heading"><strong>{node.title}</strong><span>{node.settings.toolName}</span></header>
    <label>Input JSON<textarea value={text} onChange={event => setText(event.target.value)} rows={7} /></label>
    <button type="button" disabled={pending || !onTrigger} onClick={trigger}>{pending ? 'Triggering…' : 'Trigger'}</button>
    {activity && <p role="status">Activity: {activity.state}{activity.reasonCode ? ` / ${activity.reasonCode}` : ''}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
