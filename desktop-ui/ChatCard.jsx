import React from 'react';
import { Icon, NodeIcon, nodeIconOptions } from './Icon.jsx';
import { Markdown } from './Markdown.jsx';

export function repairWrappedCaret(target, previous, inputType) {
  if (inputType === 'insertText' && previous &&
      previous.start === previous.end && previous.start === previous.value.length &&
      target.value.startsWith(previous.value) && target.value.length > previous.value.length &&
      target.selectionStart === previous.start && target.selectionEnd === previous.start) {
    target.setSelectionRange(target.value.length, target.value.length);
  }
}

const ComposerTextarea = React.memo(React.forwardRef(function ComposerTextarea({ id, disabled, placeholder, draft }, ref) {
  return <textarea ref={ref} className="nodrag nowheel" id={id} defaultValue={draft} placeholder={placeholder} rows="3" disabled={disabled} autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false} />;
}));

function statusLabel(status, acceptedRunning) {
  if (status === 'running') return acceptedRunning ? 'Thinking…' : 'Sending…';
  return {
    disconnected: 'Offline',
    error: 'Needs attention',
    reconciliation: 'Needs review',
  }[status] || '';
}

function readNodeIcon(cardId) {
  try {
    const saved = globalThis.localStorage?.getItem(`aylachi:node-icon:${cardId}`);
    return nodeIconOptions.some(option => option.id === saved) ? saved : 'chat';
  } catch { return 'chat'; }
}

export function formatTokens(value) {
  if (!Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value);
}

export function focusScaleShortcut(event, currentScale) {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  if (['=', '+'].includes(event.key) || event.code === 'NumpadAdd') return Math.min(2, Math.round((currentScale + 0.1) * 10) / 10);
  if (['-', '_'].includes(event.key) || event.code === 'NumpadSubtract') return Math.max(0.7, Math.round((currentScale - 0.1) * 10) / 10);
  if (event.key === '0' || event.code === 'Numpad0') return 1;
  return null;
}

export function focusContentStyle(focused, focusScale) {
  const scale = focused ? focusScale : 1;
  return { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: 'top left' };
}

export function ChatCard({ card, messages = [], activities = [], metrics = null, status = 'disconnected', error, onSend, onCancel, onApproveEffect, onRename, onUpdateModel, onDelete, modelCatalog, focused = false, onExitFocus }) {
  const [draft, setDraft] = React.useState('');
  const draftRef = React.useRef('');
  const textareaRef = React.useRef(null);
  const [sendError, setSendError] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false);
  const [nodeIcon, setNodeIcon] = React.useState(() => readNodeIcon(card.id));
  const [focusScale, setFocusScale] = React.useState(1);
  const [renaming, setRenaming] = React.useState(false);
  const [title, setTitle] = React.useState(card.title);
  const [actionPending, setActionPending] = React.useState(false);
  const [actionError, setActionError] = React.useState('');
  const [actionNotice, setActionNotice] = React.useState('');
  const currentModel = card.modelProvider === undefined ? modelCatalog?.default : { provider: card.modelProvider, modelId: card.modelId, reasoning: card.reasoning };
  const [selectedModelId, setSelectedModelId] = React.useState(currentModel?.modelId ?? '');
  const [selectedReasoning, setSelectedReasoning] = React.useState(currentModel?.reasoning ?? 'low');
  const menuRef = React.useRef(null);
  const menuButtonRef = React.useRef(null);
  const iconPickerRef = React.useRef(null);
  const transcriptRef = React.useRef(null);
  const stickToBottom = React.useRef(true);
  const disconnected = status === 'disconnected' || status === 'error';
  const reconciling = status === 'reconciliation';
  const awaitingReceipt = messages.some(message => message.role === 'user' && message.pending);
  const acceptedRunning = status === 'running' && !awaitingReceipt;
  const activity = statusLabel(status, acceptedRunning);
  const modelBusy = actionPending || disconnected || ['running', 'reconciliation'].includes(status);
  const contextWindow = modelCatalog?.models.find(model => model.id === currentModel?.modelId)?.contextWindow;
  const contextPercent = Number.isFinite(metrics?.totalTokens) && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.min(100, Math.round(metrics.totalTokens / contextWindow * 100)) : null;
  const tokensPerSecond = Number.isFinite(metrics?.output) && metrics.output > 0 && Number.isFinite(metrics?.durationMs) && metrics.durationMs > 0
    ? Math.round(metrics.output / metrics.durationMs * 1000) : null;

  React.useEffect(() => {
    const element = transcriptRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [card.id, messages.length, messages.at(-1)?.text, activities.length, focusScale]);

  React.useEffect(() => {
    if (!focused) return;
    const keydown = event => {
      const nextScale = focusScaleShortcut(event, focusScale);
      if (nextScale === null) return;
      event.preventDefault(); event.stopPropagation(); setFocusScale(nextScale);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [focused, focusScale]);

  React.useEffect(() => {
    setSelectedModelId(currentModel?.modelId ?? '');
    setSelectedReasoning(currentModel?.reasoning ?? 'low');
  }, [currentModel?.modelId, currentModel?.reasoning]);

  React.useEffect(() => {
    if (!menuOpen) return;
    const close = event => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setMenuOpen(false); menuButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  React.useEffect(() => {
    if (!iconPickerOpen) return;
    const close = event => { if (!iconPickerRef.current?.contains(event.target)) setIconPickerOpen(false); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setIconPickerOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [iconPickerOpen]);

  async function rename(event) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || !onRename || actionPending) return;
    setActionPending(true); setActionError(''); setActionNotice('');
    const result = await onRename({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, revision: card.revision, title: nextTitle });
    setActionPending(false);
    if (!result?.accepted) { setActionError(result?.message || 'Rename failed.'); return; }
    setRenaming(false); setActionNotice('Chat renamed');
  }

  async function applyModel(next) {
    if (!onUpdateModel || !currentModel || actionPending) return;
    const selection = { provider: currentModel.provider, modelId: next.modelId ?? selectedModelId, reasoning: next.reasoning ?? selectedReasoning };
    if (selection.modelId === currentModel.modelId && selection.reasoning === currentModel.reasoning) return;
    setActionPending(true); setActionError(''); setActionNotice('');
    const result = await onUpdateModel({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, revision: card.revision, ...selection });
    setActionPending(false);
    if (!result?.accepted) { setActionError(result?.message || 'Model settings failed.'); return; }
    setActionNotice('Model settings updated');
  }

  async function deleteNode() {
    if (!onDelete || actionPending) return;
    setMenuOpen(false); setActionPending(true); setActionError(''); setActionNotice('');
    try {
      const result = await onDelete();
      if (!result?.accepted && !result?.cancelled) setActionError(result?.message || 'Delete failed.');
    } catch { setActionError('Delete failed. Refresh cards before retrying.'); }
    finally { setActionPending(false); }
  }

  async function copyTranscript() {
    setMenuOpen(false); setActionError(''); setActionNotice('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      const transcript = messages.map(message => `## ${message.role === 'assistant' ? 'Ayla' : message.role === 'user' ? 'You' : 'System'}\n\n${message.text}`).join('\n\n');
      await navigator.clipboard.writeText(`# ${card.title}\n\n${transcript}\n`);
      setActionNotice('Transcript copied');
    } catch { setActionError('Clipboard unavailable.'); }
  }

  async function approve(effect) {
    if (!onApproveEffect || actionPending) return;
    setActionPending(true); setActionError(''); setActionNotice('');
    const result = await onApproveEffect({ cardId: card.id, sessionId: card.sessionId, turnId: effect.turnId, effectId: effect.effectId,
      expectedAttempt: effect.attempt, payloadHash: effect.payloadHash });
    setActionPending(false);
    if (!result?.accepted) { setActionError(result?.message || 'Approval failed.'); return; }
    setActionNotice('Effect approved');
  }

  React.useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    let before = null;
    const handleBeforeInput = () => {
      before = { value: target.value, start: target.selectionStart, end: target.selectionEnd };
    };
    const handleInput = event => {
      const previous = before;
      before = null;
      draftRef.current = target.value;
      setDraft(target.value);
      // WKWebView can leave the caret behind when insertText wraps onto a new line.
      repairWrappedCaret(target, previous, event.inputType);
    };
    target.addEventListener('beforeinput', handleBeforeInput);
    target.addEventListener('input', handleInput);
    return () => {
      target.removeEventListener('beforeinput', handleBeforeInput);
      target.removeEventListener('input', handleInput);
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    const submitted = draftRef.current;
    const text = submitted.trim();
    if (!text || !onSend || disconnected || status === 'running' || pending) return;
    setPending(true);
    setSendError('');
    try {
      const result = await onSend({ cardId: card.id, sessionId: card.sessionId, text });
      if (!result?.accepted) {
        setSendError(result?.message || 'Message not accepted. Draft preserved.');
        return;
      }
      if (draftRef.current === submitted) {
        draftRef.current = '';
        setDraft('');
        if (textareaRef.current) textareaRef.current.value = '';
      }
    } catch {
      setSendError('Send failed. Draft preserved.');
    } finally {
      setPending(false);
    }
  }

  function chooseIcon(id) {
    setNodeIcon(id); setIconPickerOpen(false);
    try { globalThis.localStorage?.setItem(`aylachi:node-icon:${card.id}`, id); } catch { /* view preference remains in memory */ }
  }

  const view = <section className={`chat-card${focused ? ' chat-card-focused' : ''}`} aria-label={card.title}>
    <div className="chat-card-content" style={focusContentStyle(focused, focusScale)}>
    <header className="card-heading">
      <div className="node-icon-wrap" ref={iconPickerRef}>
        <button type="button" className="nodrag node-type-icon" aria-label="Choose node icon" title="Choose node icon" aria-expanded={iconPickerOpen} onClick={() => setIconPickerOpen(value => !value)}><NodeIcon name={nodeIcon} /></button>
        {iconPickerOpen && <div className="node-icon-picker nodrag" role="dialog" aria-label="Node icon">
          {nodeIconOptions.map(option => <button type="button" key={option.id} aria-label={option.label} title={option.label} aria-pressed={nodeIcon === option.id} onClick={() => chooseIcon(option.id)}><option.Component size={18} strokeWidth={1.7} /></button>)}
        </div>}
      </div>
      {renaming ? <form className="node-rename nodrag" onSubmit={rename}>
        <input aria-label="Chat title" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} autoFocus disabled={actionPending} />
        <button type="submit" disabled={actionPending || !title.trim()}>{actionPending ? 'Saving…' : 'Save'}</button>
      </form> : <div className="node-heading"><h2>{card.title}</h2></div>}
      <span className={`status status-${status}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {activity || <span className="sr-only">Connected</span>}
      </span>
      {focused && <button type="button" className="nodrag focus-exit" onClick={onExitFocus} title="Exit focus (Esc)">Exit focus <kbd>Esc</kbd></button>}
      <div className="node-menu-wrap" ref={menuRef}>
        <button ref={menuButtonRef} type="button" className="nodrag node-menu-button" aria-label="Chat actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>⋯</button>
        {menuOpen && <div className="node-menu" role="menu">
          {onRename && <button type="button" role="menuitem" onClick={() => { setTitle(card.title); setRenaming(true); setMenuOpen(false); setActionError(''); setActionNotice(''); }}>Rename chat</button>}
          <button type="button" role="menuitem" disabled={!messages.length} onClick={copyTranscript}>Copy transcript</button>
          {onDelete && <button type="button" role="menuitem" className="node-delete-action" disabled={actionPending} onClick={deleteNode}>Delete chat</button>}
        </div>}
      </div>
    </header>

    {actionError && <p className="error" role="alert">{actionError}</p>}
    {actionNotice && <p className="chat-action-notice" role="status">{actionNotice}</p>}
    <ol ref={transcriptRef} className="transcript nodrag nowheel" aria-live="polite" onScroll={event => {
      const element = event.currentTarget;
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {messages.length === 0 && <li className="chat-empty">
        <span className="empty-mark">A·</span>
        <strong>Start a conversation</strong>
        <p>Your messages and Ayla’s answers will appear here.</p>
      </li>}
      {messages.map(message => <li key={message.id} className={`message message-${message.role}`}>
        <div className="message-author">
          {message.role === 'assistant' && <span className="ayla-mark">A</span>}
          <span>{message.role === 'assistant' ? 'AYLA' : 'YOU'}</span>
        </div>
        {message.pending && <small className="receipt-state">Awaiting receipt</small>}
        {message.provisional && <small className="receipt-state">Streaming…</small>}
        {message.receiptPending && !message.pending && <small className="receipt-state">Working…</small>}
        {message.role === 'assistant' ? <Markdown text={message.text} /> : <p>{message.text}</p>}
        {message.model && <small className="message-model">Applied: {message.model.modelId} · {message.model.reasoning}</small>}
      </li>)}
      {activities.length > 0 && <li className="execution-activity" aria-label="Tool activity">
        <div className="message-author"><span>EXECUTION</span></div>
        <ul>{activities.map(activity => <li key={activity.id} className={`tool-activity tool-${activity.status}`}>
          <span className="tool-status-dot" aria-hidden="true" />
          <code>{activity.toolName}</code>
          <span className="tool-state-label">{{ running: 'Running…', failed: 'Failed', completed: 'Completed', approval: 'Waiting approval', unknown: 'Outcome unknown — reconciliation required' }[activity.status]}</span>
          {activity.status === 'approval' && onApproveEffect && <button type="button" className="nodrag effect-approve" disabled={actionPending} onClick={() => approve(activity)}>Approve</button>}
        </li>)}</ul>
      </li>}
    </ol>

    {error && <p className="error" role="alert">{error}</p>}
    {sendError && <p className="error" role="alert">{sendError}</p>}
    <form className="composer nodrag nowheel" onSubmit={submit}>
      <label className="sr-only" htmlFor={`draft-${card.id}`}>Message {card.title}</label>
      <div className="composer-field">
        <ComposerTextarea ref={textareaRef} id={`draft-${card.id}`} draft={draft} placeholder={reconciling ? 'Original draft locked for reconciliation' : 'Ask Ayla…'} disabled={disconnected || pending || reconciling || status === 'running'} />
        <button className="nodrag send-button" type="submit" aria-label={reconciling ? 'Reconcile send' : 'Send message'} disabled={disconnected || status === 'running' || pending || !draft.trim() || !onSend}>
          {reconciling ? 'Reconcile send' : pending ? 'Sending…' : <><Icon name="send" size={18} /><span className="sr-only">Send</span></>}
        </button>
      </div>
      {acceptedRunning && onCancel && <div className="composer-actions">
        <button className="nodrag cancel-button" type="button" onClick={() => onCancel({ cardId: card.id, sessionId: card.sessionId })}>Cancel</button>
      </div>}
    </form>
    <footer className="chat-footer" aria-label={modelCatalog && onUpdateModel && currentModel ? 'Model and session metrics' : 'Current model policy'}>
      {modelCatalog && onUpdateModel && currentModel ? <>
        <select className="nodrag model-select" aria-label="Model" value={selectedModelId} disabled={modelBusy} onChange={event => applyModel({ modelId: event.target.value })}>
          {modelCatalog.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
        <select className="nodrag reasoning-select" aria-label="Reasoning effort" value={selectedReasoning} disabled={modelBusy} onChange={event => applyModel({ reasoning: event.target.value })}>
          {['low', 'medium', 'high'].map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      </> : <><span className="model-label"><span className="provider-dot" />GPT-6 Luna</span><span>Reasoning: Low</span></>}
      <span className="footer-metric" title="Tokens in the latest completed turn / model context window">
        {contextPercent === null ? 'Context —' : `${formatTokens(metrics.totalTokens)} / ${formatTokens(contextWindow)} · ${contextPercent}%`}
      </span>
      <span className="footer-metric footer-speed" title="Output tokens per second, measured over the latest completed turn">{tokensPerSecond === null ? 'Speed —' : `${tokensPerSecond} tok/s`}</span>
    </footer>
    </div>
  </section>;
  return view;
}
