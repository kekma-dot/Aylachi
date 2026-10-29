import React from "react";
import "./wiki-pane.css";

function title(note) {
  if (note?.title) return note.title;
  const firstLine = note?.content?.split("\n").find(line => line.trim());
  return firstLine?.replace(/^#+\s*/, "").slice(0, 80) || "Untitled note";
}

export default function WikiPane({ state = {}, actions = {} }) {
  const [query, setQuery] = React.useState("");
  const notes = Array.isArray(state.notes) ? state.notes : [];
  const history = Array.isArray(state.history) ? state.history : [];
  const changes = Array.isArray(state.changes) ? state.changes : [];
  const links = Array.isArray(state.links) ? state.links : [];
  const selected = state.selected || null;
  const writesDisabled = Boolean(state.busy || state.uncertain || state.conflict);
  const error = typeof state.error === "string" ? state.error : state.error?.message;

  function search(event) {
    event.preventDefault();
    actions.search?.(query);
  }

  return <section className="wiki-pane" aria-label="Wiki pane" aria-busy={Boolean(state.busy)}>
    <aside className="wiki-sidebar">
      <header className="wiki-sidebar-heading">
        <h1>Wiki</h1>
        {state.dirty && <button type="button" className="wiki-discard-note" aria-label="Discard draft / New note"
          disabled={Boolean(state.busy || state.uncertain) || !actions.newNote} onClick={() => actions.newNote?.({ discard: true })}>Discard</button>}
        <button type="button" className="wiki-new-note" aria-label="New note" title={state.dirty ? "Save or discard the draft first" : "New note"}
          disabled={Boolean(state.busy || state.uncertain || state.dirty) || !actions.newNote} onClick={() => actions.newNote?.({ discard: false })}>+</button>
      </header>
      <form className="wiki-pane-search" onSubmit={search} role="search">
        <label className="sr-only" htmlFor="wiki-pane-query">Search notes</label>
        <input id="wiki-pane-query" value={query} placeholder="Search notes" disabled={Boolean(state.busy) || !actions.search} onChange={event => setQuery(event.target.value)} />
      </form>
      <nav className="wiki-pane-notes" aria-label="Wiki notes">
        {notes.length ? <ul>{notes.map(note => <li key={note.id}>
          <button type="button" className="wiki-pane-note" aria-current={selected?.id === note.id ? 'true' : undefined} aria-label={`Open note ${title(note)}`} disabled={Boolean(state.busy) || !actions.openNote}
            onClick={() => actions.openNote?.(note.id, { discard: false })}>{title(note)}</button>
        </li>)}</ul> : <p className="wiki-pane-muted">No notes found.</p>}
      </nav>
    </aside>

    <div className="wiki-pane-document">
      {error && <p className="wiki-pane-message" role="alert">{error}</p>}
      {state.conflict && <div className="wiki-pane-message wiki-pane-conflict" role="alert">
        <p>Conflict detected. The draft is preserved; Save and Restore are locked.</p>
        <button type="button" disabled={Boolean(state.busy) || !selected || !actions.reconcile} onClick={() => actions.reconcile?.()}>Refresh server revision</button>
      </div>}
      {state.uncertain && <div className="wiki-pane-message wiki-pane-uncertain" role="status">
        <p>Outcome unknown; writes stay locked; reconciliation only refreshes authoritative state.</p>
        <button type="button" disabled={Boolean(state.busy) || !selected || !actions.reconcile} onClick={() => actions.reconcile?.()}>Reconcile outcome</button>
      </div>}

      <header className="wiki-pane-selected">
        <div><p className="wiki-pane-eyebrow">{selected ? "NOTE" : "NEW NOTE"}</p><h2>{selected ? title(selected) : "New note"}</h2></div>
        {selected && <small title={selected.revision}>v{selected.revision.slice(0, 8)}</small>}
      </header>
      <label className="sr-only" htmlFor="wiki-pane-editor">Note content</label>
      <textarea id="wiki-pane-editor" value={state.draft ?? selected?.content ?? ""} placeholder="Start writing…"
        disabled={Boolean(state.busy || state.uncertain) || !actions.edit} onChange={event => actions.edit?.(event.target.value)} />
      <div className="wiki-pane-actions">
        <span>{state.dirty ? "Unsaved changes" : "Saved"}</span>
        <button type="button" className="wiki-pane-primary" aria-label="Save note" disabled={writesDisabled || !state.dirty || !actions.save}
          onClick={() => actions.save?.()}>Save</button>
      </div>

      <details className="wiki-details">
        <summary>History and links</summary>
        <section className="wiki-pane-history" aria-labelledby="wiki-pane-history-title">
          <div className="wiki-pane-section-heading"><h3 id="wiki-pane-history-title">Revision history</h3>
            <button type="button" disabled={!selected || Boolean(state.busy) || !actions.loadHistory}
              onClick={() => actions.loadHistory?.()}>Load history</button></div>
          {history.length ? <ul>{history.map((revision, index) => <li key={`${revision}-${index}`}>
            <code title={revision}>v{revision.slice(0, 8)}</code>
            <button type="button" disabled={!selected || Boolean(state.busy) || !actions.compare}
              aria-label={`Compare selected revision with ${revision}`} onClick={() => actions.compare?.(selected.revision, revision)}>Compare</button>
            <button type="button" aria-label={`Restore revision ${revision}`} disabled={writesDisabled || Boolean(state.dirty) || !actions.restore}
              onClick={() => actions.restore?.(revision)}>Restore</button>
          </li>)}</ul> : <p className="wiki-pane-muted">History not loaded.</p>}
        </section>

        <section className="wiki-pane-diff" aria-label="Revision diff">
          <h3>Diff</h3>
          {changes.length ? <ol>{changes.map((change, index) => <li key={index}>
            <p>Starting at line {change.start + 1}</p>
            <ul>{(change.remove || []).map((line, lineIndex) => <li className="wiki-pane-removed" key={`r-${lineIndex}`}><del>{line}</del></li>)}
              {(change.insert || []).map((line, lineIndex) => <li className="wiki-pane-added" key={`i-${lineIndex}`}><ins>{line}</ins></li>)}</ul>
          </li>)}</ol> : <p className="wiki-pane-muted">No comparison loaded.</p>}
        </section>

        <section className="wiki-pane-links" aria-label="Wiki links">
          <h3>Links</h3>
          {links.length ? <ul>{links.map((link, index) => <li key={`${link}-${index}`}>
            <button type="button" className="wiki-pane-link" disabled={Boolean(state.busy) || !actions.openNote}
              onClick={() => actions.openNote?.(link, { discard: false })}>{link}</button>
          </li>)}</ul> : <p className="wiki-pane-muted">No links.</p>}
        </section>
      </details>
    </div>
  </section>;
}
