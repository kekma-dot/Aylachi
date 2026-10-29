export function orderedFocusIds(nodes) {
  return [...nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id)).map(node => node.id);
}

export function projectLocalCanvas(nodes, edges, { focusedNodeId = null, collapsedIds = new Set(), focusSize = null } = {}) {
  const order = focusedNodeId ? orderedFocusIds(nodes) : [];
  const columnWidth = (focusSize?.width ?? 0) + 32;
  return {
    nodes: nodes.map(node => {
      const collapsed = collapsedIds.has(node.id);
      const focused = focusedNodeId === node.id;
      const focusColumn = focusedNodeId ? order.indexOf(node.id) : -1;
      return { ...node,
        ...(focusColumn >= 0 ? { position: { x: focusColumn * columnWidth, y: 0 } } : {}),
        hidden: false,
        style: focusedNodeId && focusSize ? { ...node.style, ...focusSize } : collapsed ? { ...node.style, height: 72 } : node.style,
        data: { ...node.data, collapsed, focused } };
    }),
    // Focus columns are a local projection; original graph and coordinates stay untouched.
    edges: focusedNodeId ? [] : edges,
  };
}
