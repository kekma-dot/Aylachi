import React from "react";
import "./handoff-pane.css";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sourcePrefill(selection, cards) {
  const source = selection?.source ?? selection;
  if (!source || !["command", "wiki"].includes(source.kind) || typeof source.id !== "string") return null;
  const hasCardId = Object.hasOwn(source, "cardId");
  const validCardId = typeof source.cardId === "string" && cards.some(card => card.id === source.cardId);
  if (hasCardId && !validCardId) return null;
  if (source.kind === "wiki") {
    if (!/^[a-f0-9-]{36}$/i.test(source.id) || typeof source.revision !== "string" || !UUID.test(source.revision)) return null;
  } else if (!validCardId || source.revision !== undefined || !SAFE_ID.test(source.id)) return null;
  return {
    sourceCardId: source.kind === "wiki" ? "" : source.cardId,
    kind: source.kind,
    sourceId: source.id,
    revision: source.kind === "wiki" ? source.revision : "",
  };
}

function payloadText(pending) {
  try {
    const value = JSON.stringify(pending?.payload ?? pending, null, 2);
    return value === undefined ? "Original payload unavailable" : value;
  } catch { return "Original payload unavailable"; }
}

function cardName(card) {
  const value = card.title ?? card.name ?? card.id;
  return typeof value === "string" ? value : card.id;
}

export default function HandoffPane({ cards = [], state = {}, actions = {}, selection, selectionVersion = 0 }) {
  const cardList = Array.isArray(cards) ? cards.filter(card => card && typeof card.id === "string" && SAFE_ID.test(card.id)) : [];
  const [form, setForm] = React.useState(() => ({
    ...(sourcePrefill(selection, cardList) ?? { sourceCardId: "", kind: "command", sourceId: "", revision: "" }),
    targetCardId: typeof state.targetCardId === "string" ? state.targetCardId : "",
  }));
  const prefill = sourcePrefill(selection, cardList);
  const prefillKey = prefill ? JSON.stringify(prefill) : "";
  React.useEffect(() => {
    if (prefillKey) setForm(current => ({ ...current, ...JSON.parse(prefillKey), targetCardId: current.targetCardId }));
  }, [prefillKey, selectionVersion]);

  const uid = React.useId().replace(/:/g, "");
  const busy = Boolean(state.busy);
  const uncertain = Boolean(state.uncertain);
  const items = Array.isArray(state.items) ? state.items : [];
  const selected = state.selected && typeof state.selected === "object" ? state.selected : null;
  const pending = state.pending && typeof state.pending === "object" ? state.pending : null;
  const error = typeof state.error === "string" ? state.error : state.error?.message;
  const validSourceCard = cardList.some(card => card.id === form.sourceCardId);
  const validTarget = cardList.some(card => card.id === form.targetCardId);
  const validId = typeof form.sourceId === "string" && (form.kind === "wiki" ? /^[a-f0-9-]{36}$/i.test(form.sourceId) : SAFE_ID.test(form.sourceId));
  const validRevision = form.kind !== "wiki" || (typeof form.revision === "string" && UUID.test(form.revision));
  const canPropose = !busy && !uncertain && validSourceCard && validTarget &&
    form.sourceCardId !== form.targetCardId && validId && validRevision && typeof actions.propose === "function";
  const source = form.kind === "wiki"
    ? { cardId: form.sourceCardId, kind: "wiki", id: form.sourceId, revision: form.revision.toLowerCase() }
    : { cardId: form.sourceCardId, kind: "command", id: form.sourceId };
  const inputDisabled = busy;
  const buttonDisabled = busy;
  const idFor = name => `handoff-${uid}-${name}`;

  function submit(event) {
    event.preventDefault();
    if (canPropose) void actions.propose({ source, targetCardId: form.targetCardId });
  }

  return <section className="handoff-pane" aria-label="Manual handoff" aria-busy={busy}>
    <header className="handoff-pane-heading">
      <div><p className="handoff-pane-eyebrow">AYLACHI · MANUAL TRANSFER</p><h1>Handoff</h1></div>
      <span className="handoff-pane-manual">Manual review required</span>
    </header>

    {error && <p className="handoff-pane-message" role="alert">{error}</p>}

    {uncertain && <section className="handoff-pane-uncertain" role="alert" aria-label="Unknown handoff outcome">
      <h2>Outcome unknown</h2>
      <p>No new proposal will be created. Reconcile reads status only; retry uses the original request unchanged.</p>
      <p>Original request ID: <code>{typeof pending?.requestId === "string" ? pending.requestId : "Unavailable"}</code></p>
      <label className="handoff-pane-label">Original request payload</label>
      <pre>{payloadText(pending)}</pre>
      <div className="handoff-pane-actions">
        <button type="button" disabled={buttonDisabled || typeof actions.reconcile !== "function"} onClick={() => actions.reconcile?.()}>Reconcile (read only)</button>
        <button type="button" className="handoff-pane-primary" disabled={buttonDisabled || !pending || typeof actions.retrySameRequest !== "function"}
          onClick={() => actions.retrySameRequest?.()}>Retry same request</button>
      </div>
    </section>}

    <form className="handoff-pane-form" onSubmit={submit}>
      <fieldset disabled={inputDisabled}>
        <legend>Choose source and destination</legend>
        <label htmlFor={idFor("source-card")}>Source card</label>
        <select id={idFor("source-card")} required value={form.sourceCardId} onChange={event => setForm(current => ({ ...current, sourceCardId: event.target.value }))}>
          <option value="">Choose source card</option>
          {cardList.map(card => <option key={card.id} value={card.id}>{cardName(card)}</option>)}
        </select>

        <label htmlFor={idFor("source-kind")}>Source kind</label>
        <select id={idFor("source-kind")} value={form.kind} onChange={event => setForm(current => ({ ...current, kind: event.target.value, revision: "" }))}>
          <option value="command">Command result</option><option value="wiki">Wiki revision</option>
        </select>

        <label htmlFor={idFor("source-id")}>{form.kind === "wiki" ? "Wiki note ID" : "Command ID"}</label>
        <input id={idFor("source-id")} value={form.sourceId} onChange={event => setForm(current => ({ ...current, sourceId: event.target.value }))}
          autoComplete="off" spellCheck="false" required pattern={form.kind === "wiki" ? "[a-fA-F0-9-]{36}" : "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"} />

        {form.kind === "wiki" && <><label htmlFor={idFor("revision")}>Wiki revision (UUID)</label>
          <input id={idFor("revision")} value={form.revision} onChange={event => setForm(current => ({ ...current, revision: event.target.value }))}
            autoComplete="off" spellCheck="false" required pattern="[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}" />
        </>}

        <label htmlFor={idFor("target-card")}>Target card</label>
        <select id={idFor("target-card")} required value={form.targetCardId} onChange={event => setForm(current => ({ ...current, targetCardId: event.target.value }))}>
          <option value="">Choose target card</option>
          {cardList.map(card => <option key={card.id} value={card.id}>{cardName(card)}</option>)}
        </select>
      </fieldset>
      <button type="submit" className="handoff-pane-primary" disabled={!canPropose}>Send transfer</button>
      {uncertain && <p className="handoff-pane-muted">New transfers are locked until the unknown outcome is resolved.</p>}
    </form>

    <section className="handoff-pane-inbox" aria-labelledby={idFor("inbox-title")}>
      <div className="handoff-pane-section-heading"><h2 id={idFor("inbox-title")}>Incoming handoffs</h2>
        <button type="button" disabled={buttonDisabled || !validTarget || typeof actions.refresh !== "function"}
          onClick={() => actions.refresh?.(form.targetCardId, { limit: 20, offset: 0 })}>Refresh inbox</button>
      </div>
      {items.length ? <ul className="handoff-pane-items">{items.map(item => <li key={item.id}>
        <button type="button" className="handoff-pane-item" disabled={buttonDisabled || typeof actions.open !== "function"}
          onClick={() => actions.open?.(item.id)}>
          <span>{item.source?.kind === "wiki" ? "Wiki" : "Command"} · {item.source?.id || "Unknown source"}</span>
          <small>{item.state} · target {item.targetCardId}</small>
          {item.snapshot?.sha256 && <code>SHA-256 {item.snapshot.sha256}</code>}
        </button>
      </li>)}</ul> : <p className="handoff-pane-muted">No inbox items loaded.</p>}
    </section>

    <section className="handoff-pane-preview" aria-label="Handoff preview">
      <h2>Preview</h2>
      {selected ? <>
        <dl>
          <dt>Source card</dt><dd>{selected.source?.cardId || "Unknown"}</dd>
          <dt>Kind</dt><dd>{selected.source?.kind || "Unknown"}</dd>
          <dt>Source ID</dt><dd>{selected.source?.id || "Unknown"}</dd>
          {selected.source?.kind === "wiki" && <><dt>Wiki revision</dt><dd>{selected.source.revision || "Unknown"}</dd></>}
          <dt>Snapshot SHA-256</dt><dd><code>{selected.snapshot?.sha256 || "Unavailable"}</code></dd>
        </dl>
        <label className="handoff-pane-label">Immutable snapshot text</label>
        <pre className="handoff-pane-snapshot">{typeof selected.snapshot?.text === "string" ? selected.snapshot.text : "Snapshot unavailable"}</pre>
        {selected.state === "accepted" ? <p className="handoff-pane-accepted" role="status">Accepted; not automatically sent as a prompt.</p> :
          <button type="button" className="handoff-pane-primary" disabled={buttonDisabled || uncertain || selected.state !== "pending" || typeof actions.accept !== "function"}
            onClick={() => actions.accept?.(selected.id)}>Accept handoff</button>}
      </> : <p className="handoff-pane-muted">Open an inbox item to review its immutable snapshot.</p>}
    </section>
  </section>;
}
