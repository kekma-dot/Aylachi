import React from 'react';
import { Icon } from './Icon.jsx';
import { createBrowserClient } from './browser-client.mjs';

export function BrowserNode({ data }) {
  const { node, hubClient } = data;
  const client = React.useMemo(() => createBrowserClient({ hubClient }), [hubClient]);
  const [session, setSession] = React.useState(null);
  const [tabs, setTabs] = React.useState([]);
  const [snapshot, setSnapshot] = React.useState(null);
  const [address, setAddress] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState('');
  const apply = React.useCallback(result => {
    setSession(result.session); setTabs(result.tabs);
    const active = result.snapshot ?? result.snapshots?.find(item => item.tabId === result.session.activeTabId);
    setSnapshot(active ?? null);
    setAddress(result.tab?.url ?? result.tabs.find(item => item.id === result.session.activeTabId)?.url ?? '');
  }, []);
  const load = React.useCallback(async signal => {
    const result = await client.read(node.refId, signal); apply(result); return result;
  }, [client, node.refId, apply]);
  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(failure => { if (failure.code !== 'ABORTED') setError('Could not load browser session.'); });
    return () => controller.abort();
  }, [load]);
  async function mutate(operation) {
    if (pending || !session) return;
    setPending(true); setError('');
    try { const result = await operation(); apply(result); await data.onGraphRefresh?.(); }
    catch (failure) { setError(failure.code ?? 'Browser operation failed.'); await load().catch(() => {}); }
    finally { setPending(false); }
  }
  const remote = session?.mode === 'remote-read-only';
  const request = () => ({ expectedRevision: session.revision, idempotencyKey: crypto.randomUUID() });
  return <section className="graph-card browser-card" aria-label={`browser: ${node.title}`}>
    <header className="card-heading graph-heading">
      <span className="node-type-icon"><Icon name="source" size={16} /></span>
      <div className="node-heading"><h2>{node.title}</h2><small>{!session ? 'BROWSER · LOADING' : remote ? 'BROWSER · READ ONLY' : 'BROWSER · LOCAL SNAPSHOTS'}</small></div>
    </header>
    {(tabs.length > 1 || remote) && <div className="browser-tabs nodrag" role="tablist" aria-label={`${node.title} tabs`}>
      {tabs.map(tab => <button type="button" role="tab" aria-selected={session?.activeTabId === tab.id} key={tab.id} disabled={pending}
        onClick={() => mutate(async () => { await client.activate(session.id, { ...request(), tabId: tab.id }); return load(); })}>{tab.title || 'New tab'}</button>)}
      {remote && <button type="button" aria-label="Open address in new tab" title="Open address in new tab" disabled={pending || !address} onClick={() => mutate(() => client.openTab(session.id, { ...request(), url: address }))}>+</button>}
    </div>}
    <form className="browser-address nodrag" onSubmit={event => { event.preventDefault(); void mutate(() => client.navigate(session.id, { ...request(), url: address })); }}>
      <input aria-label={`${node.title} address`} value={address} disabled={!remote || pending} placeholder="https://example.com/" onChange={event => setAddress(event.target.value)} />
      {remote && <button type="submit" disabled={pending || !address}>Go</button>}
      <button type="button" className="browser-refresh" aria-label="Refresh snapshot" title="Refresh snapshot" disabled={pending || !session} onClick={() => mutate(() => client.refresh(session.id, request()))}><Icon name="refresh" size={13} /></button>
    </form>
    {error && <p className="error graph-error" role="alert">{error}</p>}
    <div className="browser-snapshot nodrag nowheel" aria-live="polite">
      {pending && <p role="status">Loading snapshot…</p>}
      {!pending && snapshot ? <><h3>{snapshot.title}</h3><p>{snapshot.text || 'The page has no readable text.'}</p>
        {snapshot.links.length > 0 && <details className="browser-links"><summary>Links ({snapshot.links.length})</summary><ul>{snapshot.links.map(link => <li key={link.href}><span>{link.text}</span><small>{link.href}</small></li>)}</ul></details>}</> :
        !pending && <div className="browser-empty"><p>{!session ? 'Loading browser…' : remote ? 'Enter an address to take a snapshot.' : 'Use the refresh button to import the current page.'}</p></div>}
    </div>
  </section>;
}
