import { useEffect, useState, useCallback, useRef } from 'react';
import NodeDetail from './NodeDetail.jsx';
import './TreeView.css';

/**
 * TreeView — decision-tree with two display modes:
 *
 *   🌳 Visual Tree — bipartite SVG diagram: root(s) LEFT, branches RIGHT,
 *                    bezier curves connecting them, click to switch/inspect
 *   📋 Detailed List — vertical comparison cards (original vs alt + why)
 *
 * Props:
 *   docId              string
 *   onSwitch(forkId)   — called after a successful branch switch
 *   activeBranchId     — externally-set highlighted branch (from sidebar click)
 */
export default function TreeView({ docId, onSwitch, activeBranchId: externalActiveBranchId }) {
  const [forks, setForks]                       = useState(null);
  const [loadError, setLoadError]               = useState(null);
  const [selectedId, setSelectedId]             = useState(null);
  const [switching, setSwitching]               = useState(null);
  const [viewMode, setViewMode]                 = useState('visual'); // 'visual' | 'list'
  const [activeBranchId, setActiveBranchId]     = useState(externalActiveBranchId ?? null);
  const [svgSize, setSvgSize]                   = useState({ w: 0, h: 0 });
  const wrapperRef                              = useRef(null);

  // Sync external prop into local state when it changes
  useEffect(() => {
    if (externalActiveBranchId != null) setActiveBranchId(externalActiveBranchId);
  }, [externalActiveBranchId]);

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
  // Branch switch
  // -------------------------------------------------------------------------
  async function handleSwitch(forkId) {
    setSwitching(forkId);
    try {
      const res = await fetch(`/fork/${forkId}/switch`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      fetchTree();
      if (onSwitch) onSwitch(forkId);
    } catch (err) {
      alert(`Switch failed: ${err.message}`);
    } finally {
      setSwitching(null);
    }
  }

  // -------------------------------------------------------------------------
  // Status helpers
  // -------------------------------------------------------------------------
  function statusLabel(fork) {
    if (fork.status === 'proposed') return 'pending';
    if (fork.status === 'failed')   return 'failed';
    if (fork.status === 'resolved' && fork.is_active)  return 'active';
    if (fork.status === 'resolved' && !fork.is_active) return 'inactive';
    return fork.status;
  }

  const STATUS_COLOR = {
    active:   '#059669',
    inactive: '#8b93a1',
    failed:   '#dc2626',
    pending:  '#d97706',
  };

  const STATUS_BG = {
    active:   '#ecfdf5',
    inactive: '#f4f5f7',
    failed:   '#fef2f2',
    pending:  '#fffbeb',
  };

  const STATUS_BORDER = {
    active:   '#a7f3d0',
    inactive: '#dde0e8',
    failed:   '#fca5a5',
    pending:  '#fcd34d',
  };

  // -------------------------------------------------------------------------
  // Visual Tree — bipartite 2-column SVG layout
  //
  // Layout:  [Root/Trunk node]  ──bezier──>  [Branch nodes stacked vertically]
  //
  // For documents with only top-level forks (no parent_fork_id) we treat them
  // all as branch nodes hanging off a synthetic "Original Manuscript" root.
  // For documents that have a proper parent/child tree we use the real tree.
  // -------------------------------------------------------------------------
  function renderVisualTree(forks) {
    if (!forks || forks.length === 0) return null;

    // --- Geometry constants ---
    const ROOT_W   = 188;   // root card width
    const ROOT_H   = 64;    // root card height
    const NODE_W   = 210;   // branch card width
    const NODE_H   = 60;    // branch card height
    const V_GAP    = 18;    // vertical gap between branch cards
    const H_SPAN   = 140;   // horizontal gap between columns
    const PAD_TOP  = 24;
    const PAD_LEFT = 24;
    const PAD_RIGHT= 32;

    // Separate top-level forks (no parent) from child forks
    const topLevel = forks.filter(f => !f.parent_fork_id);
    const children  = forks.filter(f => !!f.parent_fork_id);

    // Build groups: each top-level fork is a "root anchor" with its children
    // If all forks are top-level we produce one synthetic root + all branches
    const allTopLevel = children.length === 0;

    // We always render a synthetic "Original" root node on the left
    // and all top-level forks as branches on the right.
    // Child forks are rendered as sub-branches indented further right.

    // For simplicity: flatten into a 2-column view.
    // Column 0 (x=PAD_LEFT): synthetic trunk
    // Column 1 (x=PAD_LEFT + ROOT_W + H_SPAN): all forks stacked
    const branchNodes = forks; // show every fork as a branch

    const totalBranchH = branchNodes.length * (NODE_H + V_GAP) - V_GAP;
    const rootY        = PAD_TOP + Math.max(0, (totalBranchH - ROOT_H) / 2);

    // SVG canvas dimensions
    const svgW = PAD_LEFT + ROOT_W + H_SPAN + NODE_W + PAD_RIGHT;
    const svgH = PAD_TOP + totalBranchH + PAD_TOP;

    // Root anchor point (right edge mid)
    const rootX    = PAD_LEFT;
    const rootMidX = rootX + ROOT_W;
    const rootMidY = rootY + ROOT_H / 2;

    // Branch column X
    const branchX  = PAD_LEFT + ROOT_W + H_SPAN;

    // Build branch positions
    const branchPositions = branchNodes.map((fork, i) => ({
      fork,
      x: branchX,
      y: PAD_TOP + i * (NODE_H + V_GAP),
    }));

    // ---- Render edges ----
    const edges = branchPositions.map(({ fork, x, y }) => {
      const isActive = fork.is_active;
      const isHighlit = activeBranchId === fork.id;
      const midY = y + NODE_H / 2;
      // Bezier: start at root right-edge, curve to branch left-edge
      const x1 = rootMidX;
      const y1 = rootMidY;
      const x2 = x;
      const y2 = midY;
      const cx1 = x1 + (x2 - x1) * 0.5;
      const cy1 = y1;
      const cx2 = x1 + (x2 - x1) * 0.5;
      const cy2 = y2;

      return (
        <path
          key={`edge-${fork.id}`}
          d={`M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`}
          fill="none"
          stroke={isHighlit ? '#6366F1' : isActive ? '#6366F1' : '#dde0e8'}
          strokeWidth={isHighlit ? 2.5 : isActive ? 2 : 1.5}
          strokeOpacity={isHighlit ? 1 : isActive ? 0.8 : 0.5}
          strokeDasharray={isActive ? 'none' : '5 3'}
        />
      );
    });

    // ---- Render branch nodes ----
    const nodeCards = branchPositions.map(({ fork, x, y }) => {
      const label       = statusLabel(fork);
      const isHighlit   = activeBranchId === fork.id;
      const isSelected  = selectedId === fork.id;
      const isSwitchable= fork.status === 'resolved' && !fork.is_active;
      const color       = STATUS_COLOR[label] || '#57606a';
      const bg          = STATUS_BG[label]    || '#f4f5f7';
      const border      = STATUS_BORDER[label]|| '#dde0e8';
      const snippet     = fork.original_snippet
        ? fork.original_snippet.slice(0, 32) + (fork.original_snippet.length > 32 ? '…' : '')
        : '(empty)';
      const emphasized  = isHighlit || isSelected;

      function handleClick() {
        setSelectedId(emphasized && !isSwitchable ? null : fork.id);
        setActiveBranchId(fork.id);
        if (isSwitchable) handleSwitch(fork.id);
      }

      return (
        <g
          key={fork.id}
          id={`branch-node-${fork.id}`}
          transform={`translate(${x}, ${y})`}
          onClick={handleClick}
          onKeyDown={(e) => e.key === 'Enter' && handleClick()}
          style={{ cursor: isSwitchable ? 'pointer' : 'default' }}
          role="button"
          tabIndex={0}
          aria-label={isSwitchable ? `Switch to: ${snippet}` : `${label}: ${snippet}`}
          aria-pressed={isSelected}
        >
          {/* Highlight ring */}
          {emphasized && (
            <rect
              x={-3} y={-3}
              width={NODE_W + 6} height={NODE_H + 6}
              rx={12}
              fill="none"
              stroke="#6366F1"
              strokeWidth="2.5"
              opacity="0.75"
            />
          )}

          {/* Card background */}
          <rect
            width={NODE_W}
            height={NODE_H}
            rx={10}
            fill={switching === fork.id ? '#e0e7ff' : emphasized ? '#eef0fc' : bg}
            stroke={switching === fork.id ? '#5b5bd6' : emphasized ? '#6366F1' : border}
            strokeWidth={emphasized ? 1.5 : 1}
          />

          {/* Status bar on left edge */}
          <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={color} />

          {/* Status pill */}
          <rect x={12} y={8} width={52} height={15} rx={4}
            fill={bg} stroke={border} strokeWidth="1" />
          <text x={38} y={17}
            fontSize={8.5} fontFamily="'Plus Jakarta Sans', sans-serif"
            fontWeight="700" fill={color}
            textAnchor="middle" dominantBaseline="middle"
            style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            {label}
          </text>

          {/* Snippet text */}
          <text x={12} y={40}
            fontSize={10.5} fontFamily="'Plus Jakarta Sans', sans-serif"
            fill="#1f2328"
            textAnchor="start" dominantBaseline="middle"
          >
            {switching === fork.id ? 'Switching…' : snippet}
          </text>

          {/* Switch hint arrow */}
          {isSwitchable && (
            <text x={NODE_W - 10} y={NODE_H / 2}
              fontSize={13} fontFamily="sans-serif"
              fill="#6366F1" textAnchor="middle" dominantBaseline="middle"
              opacity={0.8}
            >
              ↺
            </text>
          )}
        </g>
      );
    });

    // ---- Root/trunk node ----
    const rootNode = (
      <g key="root-trunk" transform={`translate(${rootX}, ${rootY})`}>
        {/* Card */}
        <rect
          width={ROOT_W} height={ROOT_H} rx={12}
          fill="#f0f0fb" stroke="#5b5bd6" strokeWidth="1.5"
        />
        {/* Left accent */}
        <rect x={0} y={0} width={5} height={ROOT_H} rx={3} fill="#5b5bd6" />
        {/* Label */}
        <text x={ROOT_W / 2 + 3} y={ROOT_H / 2 - 8}
          fontSize={9} fontFamily="'Plus Jakarta Sans', sans-serif"
          fontWeight="700" fill="#5b5bd6"
          textAnchor="middle" dominantBaseline="middle"
          style={{ textTransform: 'uppercase', letterSpacing: '0.07em' }}
        >
          ORIGINAL DRAFT
        </text>
        <text x={ROOT_W / 2 + 3} y={ROOT_H / 2 + 8}
          fontSize={10} fontFamily="'Plus Jakarta Sans', sans-serif"
          fill="#3d3da8" textAnchor="middle" dominantBaseline="middle"
        >
          Main story trunk
        </text>
      </g>
    );

    return (
      <div className="tree-svg-wrapper" ref={wrapperRef}>
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="tree-svg"
          aria-label="Story decision tree diagram"
          style={{ minWidth: svgW }}
        >
          {/* Edges behind nodes */}
          <g className="tree-svg__edges">{edges}</g>
          {/* Root node */}
          {rootNode}
          {/* Branch nodes */}
          <g className="tree-svg__branches">{nodeCards}</g>
        </svg>

        {/* Detail card for selected branch */}
        {selectedId && (() => {
          const sel = forks.find((f) => f.id === selectedId);
          if (!sel) return null;
          return (
            <div className="tree-svg__detail">
              <NodeDetail
                fork={sel}
                onSwitch={handleSwitch}
                switching={switching === sel.id}
                onWhyUpdated={(why) => {
                  setForks((prev) => prev.map((f) => f.id === sel.id ? { ...f, why } : f));
                }}
              />
            </div>
          );
        })()}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Detailed List view
  // -------------------------------------------------------------------------
  function renderListView(forks) {
    const sorted = [...forks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return (
      <div className="tree-list">
        {sorted.map((fork) => {
          const label = statusLabel(fork);
          const color = STATUS_COLOR[label];
          const isHighlighted = activeBranchId === fork.id;
          return (
            <div
              key={fork.id}
              id={`branch-node-${fork.id}`}
              className={`tree-list__card tree-list__card--${label}${isHighlighted ? ' tree-list__card--highlighted' : ''}`}
              onClick={() => setActiveBranchId(fork.id)}
            >
              <div className="tree-list__card-header">
                <span className="tree-list__status-dot" style={{ background: color }} aria-hidden="true" />
                <span className="tree-list__status-label" style={{ color }}>{label}</span>
                <span className="tree-list__date">
                  {new Date(fork.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>

              <div className="tree-list__diff">
                <div className="tree-list__diff-col tree-list__diff-col--original">
                  <span className="tree-list__diff-label">Original</span>
                  <p className="tree-list__diff-text">{String(fork.original_snippet || '')}</p>
                </div>
                <div className="tree-list__diff-col tree-list__diff-col--alternative">
                  <span className="tree-list__diff-label">Alternative</span>
                  <p className="tree-list__diff-text">
                    {fork.branch_content
                      ? String(fork.branch_content)
                      : <em className="tree-list__empty">Generation failed</em>}
                  </p>
                </div>
              </div>

              {fork.why && (
                <div className="tree-list__why">
                  <span className="tree-list__why-label">WHY THIS CHANGE</span>
                  <p className="tree-list__why-text">{String(fork.why)}</p>
                </div>
              )}

              {fork.status === 'resolved' && !fork.is_active && (
                <div className="tree-list__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={(e) => { e.stopPropagation(); handleSwitch(fork.id); }}
                    disabled={switching === fork.id}
                  >
                    {switching === fork.id ? 'Switching…' : 'Switch to this branch'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
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
        <button className="btn btn--ghost" style={{ marginLeft: '1rem' }} onClick={fetchTree}>Retry</button>
      </div>
    );
  }
  if (!forks) return <div className="tree-view tree-view--loading">Loading tree…</div>;
  if (forks.length === 0) {
    return (
      <div className="tree-view tree-view--empty">
        No decision forks yet. Select text in the editor and click "Show alternative" to create one.
      </div>
    );
  }

  return (
    <div className="tree-view">
      {/* ── Toolbar: mode toggle + legend ── */}
      <div className="tree-view__toolbar">
        <div className="tree-view__mode-toggle">
          <button
            className={`tree-mode-btn${viewMode === 'visual' ? ' tree-mode-btn--active' : ''}`}
            onClick={() => setViewMode('visual')}
          >
            🌳 Visual Tree
          </button>
          <button
            className={`tree-mode-btn${viewMode === 'list' ? ' tree-mode-btn--active' : ''}`}
            onClick={() => setViewMode('list')}
          >
            📋 Detailed List
          </button>
        </div>

        {/* Status legend — in toolbar header, z-10, never overlaps nodes */}
        <div className="tree-view__legend" style={{ zIndex: 10, position: 'relative' }}>
          <span className="legend-item legend-item--active">active</span>
          <span className="legend-item legend-item--inactive">inactive</span>
          <span className="legend-item legend-item--failed">failed</span>
          <span className="legend-item legend-item--pending">pending</span>
        </div>
      </div>

      {/* ── Content ── */}
      {viewMode === 'visual' ? renderVisualTree(forks) : renderListView(forks)}
    </div>
  );
}
