import React from "react";
import "./wiki-pane.css";

export default function SourcePane({ state = {}, actions = {} }) {
  const files = Array.isArray(state.files) ? state.files : [];
  const selected = state.selected || null;
  const busy = Boolean(state.busy);
  const dirty = Boolean(state.dirty);
  const uncertain = Boolean(state.uncertain);
  const conflict = Boolean(state.conflict);
  const locked = busy || uncertain || conflict;
  const switchingLocked = dirty || busy || uncertain || conflict;
  const error = typeof state.error === "string" ? state.error : state.error?.message;
  const diff = state.diff;
  const currentDiff = Boolean(selected && !dirty && diff && diff.id === selected.id && diff.toSha256 === selected.sha256);

  return <section className="wiki-pane" aria-label="Source workbench" aria-busy={busy}>
    <header className="wiki-pane-heading">
      <div><p className="wiki-pane-eyebrow">AYLACHI · SOURCE</p><h1>Source workbench</h1></div>
      <button type="button" className="wiki-pane-button" disabled={switchingLocked || !actions.refresh}
        onClick={() => actions.refresh?.()}>Refresh files</button>
    </header>

    {error && <p className="wiki-pane-message" role="alert">{error}</p>}
    {uncertain && <div className="wiki-pane-message wiki-pane-uncertain" role="status">
      <p>Save outcome unknown. The draft is retained; no automatic retry will occur. Reconcile authoritative state explicitly.</p>
      <button type="button" className="wiki-pane-button" disabled={busy || !actions.reconcile}
        onClick={() => actions.reconcile?.()}>Reconcile outcome</button>
    </div>}
    {conflict && <div className="wiki-pane-message wiki-pane-conflict" role="alert">
      <p>Conflict detected. The draft is retained and writes are locked. Reconcile explicitly; no automatic retry will occur.</p>
      <button type="button" className="wiki-pane-button" disabled={busy || !actions.reconcile}
        onClick={() => actions.reconcile?.()}>Reconcile conflict</button>
    </div>}

    <div className="wiki-pane-layout">
      <nav className="wiki-pane-notes" aria-label="Source files">
        <h2>Files</h2>
        {files.length ? <ul>{files.map(file => <li key={file.id}>
          <button type="button" className="wiki-pane-note" aria-current={selected?.id === file.id ? "true" : undefined}
            aria-label={`Open source file ${file.path}`} disabled={switchingLocked || !actions.selectFile}
            onClick={() => actions.selectFile?.(file.id)}>
            <span>{file.path}</span><small>BASELINE {file.baselineSha256 || "—"}</small>
          </button>
        </li>)}</ul> : <p className="wiki-pane-muted">No source files.</p>}
      </nav>

      <div className="wiki-pane-document">
        <header className="wiki-pane-selected">
          <div><p className="wiki-pane-eyebrow">{selected ? "SELECTED SOURCE" : "NO SOURCE SELECTED"}</p>
            <h2>{selected ? selected.path : "Select a file"}</h2></div>
          {selected && <div className="wiki-pane-revision">
            <p>Current <code>{selected.sha256 || "—"}</code></p>
            <p>Baseline <code>{selected.baselineSha256 || "—"}</code></p>
          </div>}
        </header>
        <label htmlFor="source-pane-editor">Source content</label>
        <textarea id="source-pane-editor" aria-label="Source editor" value={state.draft ?? selected?.content ?? ""}
          disabled={!selected || busy || uncertain || conflict || !actions.edit}
          onChange={event => actions.edit?.(event.target.value)} />
        <div className="wiki-pane-actions">
          <span>{dirty ? "Unsaved draft retained" : "No unsaved changes"}</span>
          <button type="button" className="wiki-pane-button" disabled={busy || uncertain || !dirty || !selected || !actions.discardDraft}
            onClick={() => actions.discardDraft?.()}>Discard draft</button>
          <button type="button" className="wiki-pane-button wiki-pane-primary" disabled={locked || !dirty || !selected || !actions.save}
            onClick={() => actions.save?.()}>Save</button>
        </div>

        <section className="wiki-pane-diff" aria-label="Saved baseline diff">
          <div className="wiki-pane-section-heading"><h2>Saved baseline diff</h2>
            <button type="button" className="wiki-pane-button" disabled={!selected || dirty || switchingLocked || !actions.loadDiff}
              onClick={() => actions.loadDiff?.()}>Load saved diff</button></div>
          {currentDiff ? <>
            <p>Baseline <code>{diff.fromSha256}</code> → saved <code>{diff.toSha256}</code></p>
            {diff.changes?.length ? <ol>{diff.changes.map((change, index) => <li key={`${change.start}-${index}`}>
              <p>Starting at line {change.start + 1}</p>
              <ul>{(change.remove || []).map((line, lineIndex) => <li className="wiki-pane-removed" key={`r-${lineIndex}`}><del>{line}</del></li>)}
                {(change.insert || []).map((line, lineIndex) => <li className="wiki-pane-added" key={`i-${lineIndex}`}><ins>{line}</ins></li>)}</ul>
            </li>)}</ol> : <p className="wiki-pane-muted">No saved changes from baseline.</p>}
          </> : <p className="wiki-pane-muted">{diff ? "Saved diff is stale or belongs to another file; load the current saved baseline diff." : "Saved baseline diff not loaded."}</p>}
        </section>
      </div>
    </div>
  </section>;
}
