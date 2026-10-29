import React from 'react';
import { ReactFlow, Background, Controls, Handle, NodeResizer, Position, ReactFlowProvider, useReactFlow, useStore } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChatCard } from './ChatCard.jsx';
import { GraphNode } from './GraphNode.jsx';
import { BrowserNode } from './BrowserNode.jsx';
import { Icon } from './Icon.jsx';
import PluginNode from './PluginNode.jsx';
import ActivityCenter from './ActivityCenter.jsx';
import { orderedFocusIds, projectLocalCanvas } from './local-view.mjs';
import './g5.css';

function ChatNode({ data }) {
  return <>{data.onResize && !data.collapsed && !data.focused && <NodeResizer minWidth={320} minHeight={360} maxWidth={1200} maxHeight={1200} onResizeEnd={(_, size) => data.onResize({
    id: data.card.id, canvasId: data.card.canvasId, sessionId: data.card.sessionId, revision: data.card.revision, ...size,
  })} />}<Handle type="target" position={Position.Left} />{data.collapsed ? <div className="node-collapsed">{data.card.title}</div> : <ChatCard {...data} />}<Handle type="source" position={Position.Right} /></>;
}
function DefinitionNode({ data }) {
  const View = data.node.kind === 'plugin' ? PluginNode : data.node.kind === 'browser' ? BrowserNode : GraphNode;
  return <>{data.onGraphMove && !data.collapsed && !data.focused && <NodeResizer minWidth={320} minHeight={360} maxWidth={1200} maxHeight={1200} onResizeEnd={(_, layout) => { void Promise.resolve(data.onGraphMove(data.node.id, {
    expectedRevision: data.node.revision, x: layout.x, y: layout.y, width: layout.width, height: layout.height,
  })).catch(() => {}); }} />}<Handle type="target" position={Position.Left} />{data.collapsed ? <div className="node-collapsed">{data.node.title}</div> : <View data={data} />}<Handle type="source" position={Position.Right} /></>;
}

// Node Views register here; command/runtime ownership stays outside the canvas.
const nodeTypes = { chat: ChatNode, wiki: DefinitionNode, artifact: DefinitionNode, browser: DefinitionNode, plugin: DefinitionNode };

export function isEditableTarget(target) {
  return Boolean(target?.closest?.('textarea,input,select,[contenteditable="true"]'));
}

export function wheelGestureDirection(event, previousDirection = null, elapsedMs = Infinity) {
  if (previousDirection && elapsedMs < 160) return previousDirection;
  if (!event.deltaX && !event.deltaY) return previousDirection ?? 'scroll';
  return Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 'pan' : 'scroll';
}

function CanvasView({ cards, graph, hubClient, graphClient, messagesBySession = {}, metricsBySession = {}, statusBySession = {}, errorBySession = {}, activitiesBySession = {},
  onSend, onCancel, onApproveEffect, onMove, onResize, onRename, onUpdateModel, onDelete, onGraphMove, onGraphConnect, onRun, onTrigger, onUpdateArtifact, onThemeWorkspace, onThemePreview, onGraphRefresh, onActivateNode, onExitFocus, modelCatalog, focusedNodeId, activeNodeId, collapsedIds }) {
  const flow = useReactFlow();
  const viewportWidth = useStore(state => state.width);
  const viewportHeight = useStore(state => state.height);
  const panRef = React.useRef(null);
  const savedViewport = React.useRef(null);
  const previousFocus = React.useRef(null);
  const focusSize = { width: Math.max(320, viewportWidth - 32), height: Math.max(360, viewportHeight - 32) };
  const requestDelete = React.useCallback(async card => {
    const status = statusBySession[card.sessionId] ?? 'disconnected';
    const hasHistory = Boolean(messagesBySession[card.sessionId]?.length);
    if (status === 'running' || hasHistory) {
      const prompt = status === 'running' ? `Stop and delete “${card.title}” with its transcript?` : `Delete “${card.title}” and its transcript?`;
      if (typeof globalThis.confirm !== 'function' || !globalThis.confirm(prompt)) return { accepted: false, cancelled: true };
    }
    if (status === 'running') {
      const stopped = onCancel ? await onCancel({ cardId: card.id, sessionId: card.sessionId }) : false;
      if (!stopped) return { accepted: false, message: 'Could not stop the chat. Delete was not sent.' };
    }
    return onDelete ? onDelete({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, revision: card.revision }) : { accepted: false, message: 'Delete is unavailable.' };
  }, [messagesBySession, onCancel, onDelete, statusBySession]);

  React.useEffect(() => {
    const keydown = event => {
      if (event.repeat || !['Delete', 'Backspace'].includes(event.key) || isEditableTarget(event.target)) return;
      const card = cards.find(item => item.id === (focusedNodeId ?? activeNodeId));
      if (!card || !onDelete) return;
      event.preventDefault();
      void requestDelete(card);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [activeNodeId, cards, focusedNodeId, onDelete, requestDelete]);

  React.useEffect(() => {
    const element = panRef.current;
    if (!element) return;
    let direction = null;
    let previousTime = 0;
    const wheel = event => {
      if (event.ctrlKey) return;
      direction = wheelGestureDirection(event, direction, event.timeStamp - previousTime);
      previousTime = event.timeStamp;
      const scrollTarget = event.target.closest?.('.transcript,textarea');
      if (focusedNodeId) {
        if (direction === 'pan' || !scrollTarget) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (!event.target.closest?.('.nowheel')) return;
      if (direction !== 'pan') {
        if (!scrollTarget) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const normalize = event.deltaMode === 1 ? 20 : 1;
      const viewport = flow.getViewport();
      flow.setViewport({ x: viewport.x - event.deltaX * normalize, y: viewport.y - event.deltaY * normalize, zoom: viewport.zoom });
    };
    element.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => element.removeEventListener('wheel', wheel, { capture: true });
  }, [flow, focusedNodeId]);

  const chatNodes = cards.map(card => ({
    id: card.id,
    type: 'chat',
    dragHandle: '.card-heading',
    position: { x: card.x, y: card.y },
    style: { width: card.width ?? 460, height: card.height ?? 520 },
    data: { card, messages: messagesBySession[card.sessionId] || [], metrics: metricsBySession[card.sessionId] || null, status: statusBySession[card.sessionId] || 'disconnected', error: errorBySession[card.sessionId], activities: activitiesBySession[card.sessionId] || [], onSend, onCancel, onApproveEffect, onRename, onUpdateModel, onDelete: () => requestDelete(card), modelCatalog, onResize, focused: focusedNodeId === card.id, onExitFocus },
  }));
  const definitionNodes = (graph?.nodes ?? []).filter(node => !['chat', 'theme'].includes(node.kind)).map(node => ({
    id: node.id, type: node.kind, dragHandle: '.card-heading',
    position: { x: node.x, y: node.y },
    style: { width: node.width, height: node.height },
    data: { node, hubClient, graphClient, artifacts: graph.artifacts, runs: graph.runs, activities: graph.activities, onRun, onTrigger, onUpdateArtifact, onThemeWorkspace, onThemePreview, onGraphRefresh, onGraphMove, focused: focusedNodeId === node.id },
  }));
  const edges = (graph?.edges ?? []).map(edge => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId,
    label: edge.kind, className: `graph-edge graph-edge-${edge.kind}` }));
  const allNodes = [...chatNodes, ...definitionNodes];
  const focusOrder = orderedFocusIds(allNodes);
  const focusOrderKey = focusOrder.join('\n');
  const view = projectLocalCanvas(allNodes, edges, { focusedNodeId, collapsedIds, focusSize });

  React.useEffect(() => {
    if (focusedNodeId) {
      if (!previousFocus.current) savedViewport.current = flow.getViewport();
      const index = focusOrder.indexOf(focusedNodeId);
      if (index >= 0) flow.setCenter(index * (focusSize.width + 32) + focusSize.width / 2, focusSize.height / 2,
        { zoom: 1, duration: previousFocus.current ? 180 : 0 });
    } else if (previousFocus.current && savedViewport.current) {
      flow.setViewport(savedViewport.current, { duration: 180 });
      savedViewport.current = null;
    }
    previousFocus.current = focusedNodeId;
  }, [flow, focusOrderKey, focusSize.width, focusSize.height, focusedNodeId]);

  return <div className="canvas-flow" ref={panRef}><ReactFlow nodes={view.nodes} edges={view.edges} nodeTypes={nodeTypes} fitView panOnDrag={!focusedNodeId} panOnScroll={!focusedNodeId} zoomOnScroll={false} zoomOnPinch={!focusedNodeId} zoomOnDoubleClick={!focusedNodeId} preventScrolling
    onConnect={connection => { if (connection.source && connection.target) void Promise.resolve(onGraphConnect?.({ sourceNodeId: connection.source, targetNodeId: connection.target, kind: 'context' })).catch(() => {}); }}
    onNodeClick={(_, node) => onActivateNode(node.id)}
    onNodeDragStop={(_, node) => {
      const card = cards.find(item => item.id === node.id);
      if (card) onMove({ id: card.id, canvasId: card.canvasId, sessionId: card.sessionId, x: node.position.x, y: node.position.y, revision: card.revision });
      else {
        const definition = graph?.nodes.find(item => item.id === node.id);
        if (definition) void Promise.resolve(onGraphMove?.(definition.id, { expectedRevision: definition.revision, x: node.position.x, y: node.position.y, width: definition.width, height: definition.height })).catch(() => {});
      }
    }} nodesDraggable={Boolean(onMove) && !focusedNodeId} nodesConnectable={Boolean(onGraphConnect) && !focusedNodeId} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
    <Background gap={28} size={1.4} />
    <Controls showZoom={!focusedNodeId} showInteractive={false} />
  </ReactFlow></div>;
}

export function isFocusShortcut(event) {
  return Boolean((event.metaKey || event.ctrlKey) && !event.altKey && event.key?.toLowerCase() === 'f');
}

export function focusNavigationDirection(event) {
  if (isEditableTarget(event.target) || (!event.metaKey && !event.ctrlKey) || event.altKey) return 0;
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
}

export default function Canvas(props) {
  const [localTheme, setTheme] = React.useState('light');
  const [focusedNodeId, setFocusedNodeId] = React.useState(null);
  const [activeNodeId, setActiveNodeId] = React.useState(null);
  const standalone = props.theme == null;
  const theme = props.theme ?? localTheme;
  const cards = props.cards || [];
  const definitions = props.graph?.nodes?.filter(node => !['chat', 'theme'].includes(node.kind)) ?? [];
  const orderedIds = orderedFocusIds([...cards.map(card => ({ id: card.id, position: { x: card.x, y: card.y } })),
    ...definitions.map(node => ({ id: node.id, position: { x: node.x, y: node.y } }))]);
  const orderedKey = orderedIds.join('\n');
  const defaultNodeId = orderedIds[0] ?? null;
  const previousOrder = React.useRef(orderedIds);

  React.useEffect(() => {
    if (focusedNodeId && !orderedIds.includes(focusedNodeId)) {
      const oldIndex = previousOrder.current.indexOf(focusedNodeId);
      const next = orderedIds[Math.min(Math.max(oldIndex, 0), orderedIds.length - 1)] ?? null;
      setFocusedNodeId(next); setActiveNodeId(next);
    } else if (activeNodeId && !orderedIds.includes(activeNodeId)) setActiveNodeId(defaultNodeId);
    previousOrder.current = orderedIds;
  }, [activeNodeId, defaultNodeId, focusedNodeId, orderedKey]);

  React.useEffect(() => {
    const keydown = event => {
      if (isFocusShortcut(event)) {
        event.preventDefault();
        const next = focusedNodeId ? null : activeNodeId ?? defaultNodeId;
        setFocusedNodeId(next);
        if (next) setActiveNodeId(next);
      } else if (focusedNodeId && focusNavigationDirection(event)) {
        event.preventDefault();
        const index = orderedIds.indexOf(focusedNodeId);
        const next = orderedIds[Math.max(0, Math.min(orderedIds.length - 1, index + focusNavigationDirection(event)))];
        if (next) { setFocusedNodeId(next); setActiveNodeId(next); }
      } else if (event.key === 'Escape' && !event.defaultPrevented) setFocusedNodeId(null);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [activeNodeId, defaultNodeId, focusedNodeId, orderedKey]);
  if (!Array.isArray(cards) || cards.some(card => !card.id || !card.canvasId || !card.sessionId || !Number.isFinite(card.x) || !Number.isFinite(card.y) || card.revision == null ||
      (Object.hasOwn(card, 'width') !== Object.hasOwn(card, 'height')) || (card.width !== undefined && (!Number.isFinite(card.width) || !Number.isFinite(card.height))))) {
    throw new Error('Canvas requires authoritative cards with id, canvasId, sessionId, x, y and revision');
  }
  const statusBySession = props.statusBySession || {};
  const Container = standalone ? 'main' : 'div';
  const nodeCount = cards.length + definitions.length;
  const focusIndex = focusedNodeId ? orderedIds.indexOf(focusedNodeId) : -1;
  return <Container className="aylachi canvas-shell" data-theme={theme} style={props.themeVariables}>
    <nav className="toolbar canvas-toolbar" aria-label="Canvas controls">
      <div className="canvas-identity"><span className="canvas-kicker">CANVAS / 01</span><span>{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>{focusIndex >= 0 && <span className="focus-position">{focusIndex + 1} / {orderedIds.length}</span>}</div>
      <div className="canvas-actions">
        {props.onCreateGraphNode && <div className="graph-create-actions">
          <select aria-label="Add node" title="Add node" value="" onChange={event => {
            const kind = event.target.value;
            if (kind) void Promise.resolve(props.onCreateGraphNode(kind)).catch(() => {});
          }}>
            <option value="" disabled>Add node</option>
            {props.graphWikiEnabled && <option value="wiki">Wiki</option>}
            <option value="artifact">Artifact</option>
            {props.graphBrowserEnabled && <option value="browser">Browser</option>}
          </select>
          <button type="button" title="Run all available Wiki and Artifact previews" disabled={!props.graph?.nodes.some(node => ['wiki', 'artifact'].includes(node.kind))} onClick={() => { void Promise.resolve(props.onRun({ scope: 'all' })).catch(() => {}); }}>Run all</button>
        </div>}
        {standalone && <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>Theme: {theme}</button>}
        <button type="button" className="reconnect-button" onClick={props.onReconnect} disabled={!props.onReconnect}><Icon name="refresh" size={14} /><span>Reconnect</span></button>
      </div>
    </nav>
    {props.connectionError && <p className="error connection-error" role="alert">{props.connectionError}</p>}
    {cards.filter(card => props.positionErrorByCard?.[card.id]).map(card => <p key={card.id} className="error position-error" role="alert">
      Update for {card.title || card.id}: {props.positionErrorByCard[card.id]}. No automatic retry.
    </p>)}
    <section className="workspace" aria-label="Workspace nodes"><ReactFlowProvider><CanvasView {...props} cards={cards} statusBySession={statusBySession} focusedNodeId={focusedNodeId} activeNodeId={activeNodeId} onActivateNode={id => { setActiveNodeId(id); if (focusedNodeId) setFocusedNodeId(id); }} onExitFocus={() => setFocusedNodeId(null)} /></ReactFlowProvider></section>
    {props.graph?.activities && <ActivityCenter activities={props.graph.activities} />}
    {!nodeCount && <div className="canvas-empty"><span>A·</span><h2>Your canvas is ready</h2><p>Create a node to start working with Ayla.</p></div>}
  </Container>;
}
