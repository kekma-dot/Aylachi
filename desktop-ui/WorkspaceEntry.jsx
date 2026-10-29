import React from 'react';
import App from './App.jsx';
import { Icon } from './Icon.jsx';

import { MAX_CARDS, mappingFailure, validateCatalog, createCatalogReads, validateCreateReceipt, createIntent, matchesIntentIdentity } from './workspace-catalog.mjs';
export { validateCatalog, createCatalogReads, validateCreateReceipt, createIntent, matchesIntentIdentity } from './workspace-catalog.mjs';

const BUSY_PHASES = ['creating', 'refreshing-created', 'reconciling', 'retrying'];
const IDLE_MUTATION = generation => ({ generation, phase: 'idle', intent: null, error: '', notice: '' });

function safeFailure(failure, operation = 'request') {
  const status = Number.isSafeInteger(failure?.status) && failure.status >= 400 && failure.status <= 599
    ? ` (HTTP ${failure.status})` : '';
  if (status) return `The Hub ${operation} failed${status}.`;
  switch (failure?.code) {
    case 'INVALID_SESSION_MAPPING': return 'The card catalog has duplicate or invalid session mappings.';
    case 'NON_ADDITIVE_CATALOG': return 'Card refresh was rejected because existing cards were removed or remapped.';
    case 'INVALID_CATALOG':
    case 'INVALID_RESPONSE': return 'The Hub returned invalid card data.';
    case 'RESPONSE_TOO_LARGE': return 'The card catalog exceeds the permitted response size.';
    case 'CONNECTION_FAILED': return 'Could not reach the local Hub. Check the connection and retry.';
    case 'ABORTED': return 'Card discovery was interrupted. Try again.';
    default: return `The Hub ${operation} failed.`;
  }
}

export default function WorkspaceEntry({ client, canvasId = 'fixture' }) {
  const contextRef = React.useRef({ client, canvasId, generation: 0 });
  if (contextRef.current.client !== client || contextRef.current.canvasId !== canvasId) {
    contextRef.current = { client, canvasId, generation: contextRef.current.generation + 1 };
  }
  const readsRef = React.useRef(null);
  if (!readsRef.current) readsRef.current = createCatalogReads();
  const reads = readsRef.current;
  const context = contextRef.current;
  const usedIdsRef = React.useRef(new Set());
  const operationRef = React.useRef(null);
  // Reactive mirror of operationRef for render-time disabled checks: a cleared
  // ref causes no re-render, so terminal setMutation alone left controls disabled
  // (parent browser RED: Retry never enabled). Cleared in the same batch as the
  // terminal mutation, so controls re-enable atomically with the final state.
  const [inFlight, setInFlight] = React.useState(false);
  const mountedRef = React.useRef(true);
  const [attempt, setAttempt] = React.useState(0);
  const [refreshVersion, setRefreshVersion] = React.useState(0);
  const [state, setState] = React.useState(() => ({ client, canvasId, status: 'loading', cards: null, error: '' }));
  const [mutation, setMutationState] = React.useState(() => IDLE_MUTATION(context.generation));
  const mutationRef = React.useRef(mutation);
  const setMutation = next => {
    mutationRef.current = next;
    setMutationState(next);
  };

  const contextIsCurrent = expected => mountedRef.current
    && contextRef.current.generation === expected.generation
    && contextRef.current.client === expected.client
    && contextRef.current.canvasId === expected.canvasId;
  const operationIsCurrent = operation => operationRef.current === operation && contextIsCurrent(operation.context);
  const beginOperation = expected => {
    if (operationRef.current) return null;
    const operation = { context: expected, controller: new AbortController() };
    operationRef.current = operation;
    setInFlight(true);
    return operation;
  };
  const finishOperation = operation => {
    if (operationRef.current === operation) {
      operationRef.current = null;
      setInFlight(false);
    }
  };

  const sameContext = state.client === client && state.canvasId === canvasId;
  const visible = sameContext ? state : { status: 'loading', cards: null, error: '' };
  const currentMutation = mutation.generation === context.generation ? mutation : IDLE_MUTATION(context.generation);
  const createAvailable = typeof client?.createCard === 'function' && typeof client?.listCards === 'function';
  const cards = Array.isArray(visible.cards) ? visible.cards : [];
  const busy = BUSY_PHASES.includes(currentMutation.phase);
  const hasIntent = Boolean(currentMutation.intent);
  const canCreate = createAvailable && ['ready', 'empty'].includes(visible.status)
    && !busy && !hasIntent && !inFlight && cards.length < MAX_CARDS;

  React.useEffect(() => {
    mountedRef.current = true;
    const expected = context;
    let active = true;
    const controller = new AbortController();
    const existing = state.client === client && state.canvasId === canvasId ? state : null;
    const previousCards = existing?.cards?.length ? existing.cards : [];
    if (!existing) setState({ client, canvasId, status: 'loading', cards: null, error: '' });
    const load = async () => {
      const ticket = reads.begin();
      try {
        if (typeof client?.listCards !== 'function') throw mappingFailure('INVALID_CLIENT');
        const result = await client.listCards(canvasId, controller.signal);
        if (!active || !contextIsCurrent(expected) || !reads.fresh(ticket)) return;
        const nextCards = validateCatalog(result, canvasId, previousCards);
        setState({
          client, canvasId,
          status: nextCards.length ? 'ready' : 'empty',
          cards: nextCards.length ? nextCards : null,
          error: '',
        });
      } catch (failure) {
        if (!active || !contextIsCurrent(expected) || !reads.fresh(ticket)) return;
        setState({
          client, canvasId,
          status: previousCards.length ? 'refresh-error' : 'error',
          cards: previousCards.length ? previousCards : null,
          error: safeFailure(failure, 'card discovery'),
        });
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
      const operation = operationRef.current;
      if (operation?.context.generation === expected.generation) {
        operation.controller.abort();
        operationRef.current = null;
        setInFlight(false);
      }
      // Do NOT reset mutationRef here: this cleanup also runs on same-context
      // catalog refreshes (attempt/refreshVersion), and resetting only the ref
      // desyncs it from mutation state (enabled-but-inert recovery controls).
      // Real context change is reset by the generation effect below; stale
      // operations are stopped by operationIsCurrent/mountedRef guards.
      mountedRef.current = false;
    };
    // state is sampled only when a catalog request starts; request triggers are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, canvasId, attempt, refreshVersion]);

  React.useEffect(() => {
    if (mutation.generation !== context.generation) setMutation(IDLE_MUTATION(context.generation));
  }, [context.generation, mutation.generation]);

  const retryDiscovery = () => {
    if (operationRef.current) return;
    setState({ client, canvasId, status: 'loading', cards: null, error: '' });
    setAttempt(value => value + 1);
  };
  const refresh = () => {
    if (!sameContext || operationRef.current || !cards.length
        || !['ready', 'refresh-error'].includes(visible.status)) return;
    setState({ ...state, status: 'refreshing', error: '' });
    setRefreshVersion(value => value + 1);
  };

  const publishCatalog = (expected, nextCards) => {
    setState({
      client: expected.client,
      canvasId: expected.canvasId,
      status: nextCards.length ? 'ready' : 'empty',
      cards: nextCards.length ? nextCards : null,
      error: '',
    });
  };

  // Shared read-only settle for both accepted receipts and unknown outcomes:
  // one additive catalog read, immutable-identity match, never a re-POST.
  const settleViaCatalog = async (intent, operation, previousCards, accepted) => {
    const ticket = reads.begin();
    try {
      const result = await intent.client.listCards(intent.canvasId, operation.controller.signal);
      if (!operationIsCurrent(operation) || !reads.fresh(ticket)) return;
      const nextCards = validateCatalog(result, intent.canvasId, previousCards);
      const match = nextCards.find(card => matchesIntentIdentity(card, intent.payload));
      publishCatalog(intent, nextCards);
      if (match) {
        setMutation({
          generation: intent.generation, phase: 'idle', intent: null, error: '',
          notice: '',
        });
        return;
      }
      setMutation({
        generation: intent.generation, intent, notice: '',
        phase: accepted ? 'accepted-unreconciled' : 'retryable',
        error: accepted
          ? 'The Hub acknowledged creation, but no matching card is visible. Only read-only reconciliation is available.'
          : 'No matching card is visible; the outcome remains unknown. You may retry the exact same request.',
      });
    } catch (failure) {
      if (!operationIsCurrent(operation) || !reads.fresh(ticket)) return;
      setMutation({
        generation: intent.generation, intent, notice: '',
        phase: accepted ? 'accepted-unreconciled' : 'unknown',
        error: accepted
          ? `The Hub acknowledged creation, but catalog refresh failed: ${safeFailure(failure, 'catalog refresh')} No second create request will be sent.`
          : `Could not reconcile; the original outcome remains unresolved. ${safeFailure(failure, 'reconciliation')}`,
      });
    }
  };

  const submitIntent = async (intent, operation, retrying) => {
    try {
      const result = await intent.client.createCard(intent.payload, intent.requestId, operation.controller.signal);
      if (!operationIsCurrent(operation)) return;
      validateCreateReceipt(result, intent); // mismatched ack => unknownOutcome, retained
      setMutation({ generation: intent.generation, phase: 'refreshing-created', intent, error: '', notice: '' });
      await settleViaCatalog(intent, operation, cards, true);
    } catch (failure) {
      if (!operationIsCurrent(operation)) return;
      if (retrying || failure?.unknownOutcome === true) {
        setMutation({
          generation: intent.generation, phase: 'unknown', intent, notice: '',
          error: retrying
            ? `The same-request retry did not resolve the original outcome: ${safeFailure(failure, 'create')}`
            : 'New chat outcome is unknown. Reconcile the catalog; no automatic retry was sent.',
        });
      } else {
        setMutation({ generation: intent.generation, phase: 'idle', intent: null, error: safeFailure(failure, 'create'), notice: '' });
      }
    } finally {
      finishOperation(operation);
    }
  };

  const createChat = () => {
    if (!canCreate) return;
    let intent;
    try {
      intent = createIntent(context, cards, usedIdsRef.current);
    } catch {
      setMutation({
        generation: context.generation, phase: 'idle', intent: null,
        error: 'A safe unique request ID could not be generated.', notice: '',
      });
      return;
    }
    const operation = beginOperation(context);
    if (!operation) return;
    setMutation({ generation: context.generation, phase: 'creating', intent, error: '', notice: '' });
    void submitIntent(intent, operation, false);
  };

  const reconcile = () => {
    const pending = mutationRef.current;
    if (!pending?.intent || pending.generation !== context.generation || operationRef.current
        || !['unknown', 'retryable', 'accepted-unreconciled'].includes(pending.phase)) return;
    const operation = beginOperation(context);
    if (!operation) return;
    setMutation({ ...pending, phase: 'reconciling', error: '', notice: '' });
    void settleViaCatalog(pending.intent, operation, cards, pending.phase === 'accepted-unreconciled')
      .finally(() => finishOperation(operation));
  };

  const retrySameRequest = () => {
    const pending = mutationRef.current;
    if (!pending?.intent || pending.generation !== context.generation
        || pending.phase !== 'retryable' || operationRef.current) return;
    const operation = beginOperation(context);
    if (!operation) return;
    setMutation({ ...pending, phase: 'retrying', error: '', notice: '' });
    void submitIntent(pending.intent, operation, true);
  };

  const mutationStatus = <>
    {busy && <p role="status" aria-live="polite">{{
      creating: 'Creating new chat…',
      'refreshing-created': 'Refreshing the card catalog…',
      reconciling: 'Rechecking the card catalog…',
      retrying: 'Retrying the same create request…',
    }[currentMutation.phase]}</p>}
    {currentMutation.error && <p role="alert">{currentMutation.error}</p>}
    {currentMutation.notice && <p role="status">{currentMutation.notice}</p>}
    {hasIntent && ['unknown', 'retryable', 'accepted-unreconciled'].includes(currentMutation.phase) && (
      <div role="group" aria-label="New chat recovery">
        <button type="button" onClick={reconcile} disabled={busy || inFlight}>
          Reconcile new chat
        </button>
        {currentMutation.phase === 'retryable' && (
          <button type="button" onClick={retrySameRequest} disabled={busy || inFlight}>
            Retry same request
          </button>
        )}
      </div>
    )}
  </>;

  const deleteChat = async input => {
    if (operationRef.current || !sameContext) return { accepted: false, message: 'Another card operation is in progress.' };
    const known = cards.find(card => card.id === input?.id && card.canvasId === input.canvasId && card.sessionId === input.sessionId);
    if (!known || typeof client.deleteCard !== 'function' || !Number.isSafeInteger(input.revision) || input.revision < 1) {
      return { accepted: false, message: 'Delete is unavailable for this card.' };
    }
    const operation = beginOperation(context);
    if (!operation) return { accepted: false, message: 'Another card operation is in progress.' };
    try {
      await client.deleteCard(known.id, input.revision, operation.controller.signal);
      if (!operationIsCurrent(operation)) return { accepted: false, message: 'Workspace changed during deletion.' };
      publishCatalog(context, cards.filter(card => card.id !== known.id));
      return { accepted: true };
    } catch (failure) {
      return { accepted: false, message: failure?.unknownOutcome
        ? 'Delete outcome is unknown. Refresh cards before retrying.'
        : safeFailure(failure, 'delete') };
    } finally { finishOperation(operation); }
  };

  const createLabel = busy ? 'Creating new chat…' : cards.length >= MAX_CARDS ? 'New chat (limit reached)' : 'New chat';
  const newChatButton = createAvailable && ['ready', 'empty'].includes(visible.status) && !hasIntent ? (
    <button type="button" className="rail-button add-node" aria-label={createLabel} title={createLabel} onClick={createChat} disabled={!canCreate || busy || inFlight}>
      <span className="plus-icon" aria-hidden="true">+</span><span className="sr-only">{createLabel}</span>
    </button>
  ) : null;

  if (Array.isArray(visible.cards) && visible.cards.length > 0) return <App client={client} cards={visible.cards} onDeleteCard={deleteChat}
    workspaceActions={{
      create: newChatButton,
      refresh: <button type="button" className="rail-button workspace-refresh" aria-label="Refresh cards" title="Refresh cards" disabled={visible.status === 'refreshing' || busy || inFlight} onClick={refresh}><Icon name="refresh" /><span className="sr-only">Refresh cards</span></button>,
    }}
    workspaceNotices={<section className="catalog-notices" aria-label="Workspace status" aria-busy={visible.status === 'refreshing' || busy}>
      {visible.status === 'refreshing' && <p role="status" aria-live="polite">Refreshing cards…</p>}
      {visible.status === 'refresh-error' && <p role="alert">{visible.error}</p>}
      {cards.length >= MAX_CARDS && <p role="status">This canvas has reached the 100-card limit.</p>}
      {mutationStatus}
    </section>} />;

  return <main className="aylachi empty-workspace" data-theme="light">
    <div className="brand-mark" aria-hidden="true">A<span>·</span></div>
    <section className="empty-entry-card" aria-labelledby="workspace-entry-title" aria-busy={visible.status === 'loading' || busy}>
      <span className="workspace-kicker">WORKSPACE</span>
      <h1 id="workspace-entry-title">Welcome to Aylachi</h1>
      {visible.status === 'loading' && <p role="status" aria-live="polite">Loading cards…</p>}
      {visible.status === 'error' && <>
        <p role="alert">{visible.error}</p>
        <button type="button" onClick={retryDiscovery}>Retry card discovery</button>
      </>}
      {visible.status === 'empty' && <>
        <p role="status" aria-live="polite">No cards are available in this canvas.</p>
        {newChatButton}
        <button type="button" onClick={retryDiscovery} disabled={busy || inFlight}>
          Retry card discovery
        </button>
        {mutationStatus}
      </>}
    </section>
  </main>;
}
