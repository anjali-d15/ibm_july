import { useEffect, useState, useCallback } from 'react';
import NodeDetail from './NodeDetail.jsx';
import './TreeView.css';

/**
 * TreeView — fetches GET /document/:id/tree, computes depth + layout
 * client-side from parent_fork_id + is_active, renders all fork nodes.
 *
 * Active-path forks are bold/saturated; inactive/rejected/failed are
 * lighter and grayed but still visible and clickable.
 *
 * Props:
 *   docId        string
 *   onSwitch(forkId) — called after a successful switch so parent can
 *                      re-fetch /resolved and update the editor
 */
export default function TreeView({ docId, onSwitch }) {
  const [forks, setForks]           = useState(null);
  const [loadError, setLoadError]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [switching, setSwitching]   = useState(null); // forkId being switched

  const fetchTree = useCallback(() => {
    fetch(`/document/${docId}/tree`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(({ forks }) => setForks(forks))
      .catch((err) => setLoadError(err.message));
  }, [docId]);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  // -------------------------------------------------------------------------
  // Build tree structure from flat list
  // -------------------------------------------------------------------------
  function buildTree(forks) {
    // Map id → node (add children + depth)
    const byId = {};
    for (const f of forks) byId[f.id] = { ...f, children: [] };

    const roots = [];
    for (const f of forks) {
      if (f.parent_fork_id && byId[f.parent_fork_id]) {
        byId[f.parent_fork_id].children.push(byId[f.id]);
      } else {
        roots.push(byId[f.id]);
      }
    }

    // Assign depth via BFS
    const queue = roots.map((r) => ({ node: r, depth: 0 }));
    while (queue.length) {
      const { node, depth } = queue.shift();
      node.depth = depth;
      for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
    }

    return roots;
  }

  // -------------------------------------------------------------------------
  // Switch branch
  // -------------------------------------------------------------------------
  async function handleSwitch(forkId) {
    setSwitching(forkId);
    try {
      const res = await fetch(`/fork/${forkId}/switch`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      // Re-fetch tree to reflect new is_active values
      fetchTree();
      // Let parent update the editor
      if (onSwitch) onSwitch(forkId);
    } catch (err) {
      alert(`Switch failed: ${err.message}`);
    } finally {
      setSwitching(null);
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  function statusLabel(fork) {
    if (fork.status === 'proposed')                       return 'pending';
    if (fork.status === 'failed')                         return 'failed';
    if (fork.status === 'resolved' && fork.is_active)     return 'active';
    if (fork.status === 'resolved' && !fork.is_active)    return 'inactive';
    return fork.status;
  }

  function renderNode(node) {
    const label   = statusLabel(node);
    const active  = label === 'active';
    const pending = label === 'pending';
    const failed  = label === 'failed';
    const isSelected = selectedId === node.id;

    const snippet = node.original_snippet
      ? (node.original_snippet.length > 60
          ? node.original_snippet.slice(0, 60) + '…'
          : node.original_snippet)
      : '(empty)';

    return (
      <div key={node.id} className="tree-node-group">
        <div
          className={[
            'tree-node',
            active  ? 'tree-node--active'  : '',
            pending ? 'tree-node--pending' : '',
            failed  ? 'tree-node--failed'  : '',
            !active && !pending && !failed ? 'tree-node--inactive' : '',
            isSelected ? 'tree-node--selected' : '',
          ].join(' ').trim()}
          style={{ '--depth': node.depth }}
          onClick={() => setSelectedId(isSelected ? null : node.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setSelectedId(isSelected ? null : node.id)}
          aria-pressed={isSelected}
        >
          <span className="tree-node__connector" aria-hidden="true" />
          <span className="tree-node__badge tree-node__badge--status">{label}</span>
          <span className="tree-node__snippet">{snippet}</span>
        </div>

        {/* Detail panel — inline below the selected node */}
        {isSelected && (
          <div className="tree-node__detail-wrapper">
            <NodeDetail
              fork={node}
              onSwitch={handleSwitch}
              switching={switching === node.id}
              onWhyUpdated={(why) => {
                setForks((prev) =>
                  prev.map((f) => (f.id === node.id ? { ...f, why } : f))
                );
              }}
            />
          </div>
        )}

        {/* Children */}
        {node.children.length > 0 && (
          <div className="tree-children">
            {node.children.map(renderNode)}
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="tree-view tree-view--error">
        Failed to load tree: {loadError}
        <button className="btn btn--ghost" style={{ marginLeft: '1rem' }} onClick={fetchTree}>
          Retry
        </button>
      </div>
    );
  }

  if (!forks) {
    return <div className="tree-view tree-view--loading">Loading tree…</div>;
  }

  if (forks.length === 0) {
    return (
      <div className="tree-view tree-view--empty">
        No decision forks yet. Select text in the editor and click "Show alternative" to create one.
      </div>
    );
  }

  const roots = buildTree(forks);

  return (
    <div className="tree-view">
      <div className="tree-view__legend">
        <span className="legend-item legend-item--active">active path</span>
        <span className="legend-item legend-item--inactive">inactive</span>
        <span className="legend-item legend-item--failed">failed</span>
        <span className="legend-item legend-item--pending">pending</span>
      </div>
      <div className="tree-view__nodes">
        {roots.map(renderNode)}
      </div>
    </div>
  );
}
