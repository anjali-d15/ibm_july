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
 *   onSwitch(forkId, segments) — called after a successful branch switch;
 *                                segments is the authoritative resolved array
 *   activeBranchId     — externally-set highlighted branch (from sidebar click)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a string key that uniquely identifies a sibling group.
 * Two forks are siblings when they share the same parent segment and span
 * the same anchor range inside the same document.
 *
 * Key: "documentId|parentForkId|anchorStart|anchorEnd"
 * The document_id is now included in the tree response so all four parts
 * are available. Falls back gracefully when document_id is absent (legacy).
 */
function siblingKey(fork) {
  const docPart    = fork.document_id ?? '_';
  const parentPart = fork.parent_fork_id ?? '__root__';
  return `${docPart}|${parentPart}|${fork.anchor_start}|${fork.anchor_end}`;
}

/**
 * Build a Map<siblingKey → fork[]> for all resolved forks.
 * Groups with only one member are still included (simplifies rendering).
 */
function buildSiblingGroups(forks) {
  const groups = new Map();
  for (const fork of forks) {
    if (fork.status === 'proposed' || fork.status === 'failed') continue;
    const key = siblingKey(fork);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fork);
  }
  return groups;
}

/**
 * Within a sibling group, enforce that exactly ONE fork is considered active.
 * If the DB is stale (zero or two active), we pick the most recently updated one.
 * Returns a new array of forks with is_active normalised.
 */
function normaliseSiblingActivity(forks, siblingGroups) {
  // Build a set of forks whose is_active must be overridden
  const overrides = new Map(); // forkId → 0|1

  for (const [, group] of siblingGroups) {
    const activeInGroup = group.filter((f) => f.is_active);

    if (activeInGroup.length === 1) continue; // already correct — nothing to do

    if (activeInGroup.length === 0) {
      // No active fork — pick the most recently updated resolved fork
      const best = [...group]
        .filter((f) => f.status === 'resolved')
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
      if (best) overrides.set(best.id, 1);
      for (const f of group) {
        if (f.status === 'resolved' && f.id !== best?.id) overrides.set(f.id, 0);
      }
    } else {
      // Multiple active forks — keep most recently updated, deactivate the rest
      const best = [...activeInGroup].sort(
        (a, b) => new Date(b.updated_at) - new Date(a.updated_at)
      )[0];
      for (const f of activeInGroup) {
        if (f.id !== best.id) overrides.set(f.id, 0);
      }
    }
  }

  if (overrides.size === 0) return forks; // fast path — no changes needed
  return forks.map((f) =>
    overrides.has(f.id) ? { ...f, is_active: overrides.get(f.id) } : f
  );
}

export default function TreeView({ docId, onSwitch, activeBranchId: externalActiveBranchId }) {
  const [forks, setForks]               = useState(null);
  const [loadError, setLoadError]       = useState(null);
  const [selectedId, setSelectedId]     = useState(null);
  const [switching, setSwitching]       = useState(null);
  const [switchError, setSwitchError]   = useState(null);
  const [viewMode, setViewMode]         = useState('visual'); // 'visual' | 'list'
  const [activeBranchId, setActiveBranchId] = useState(externalActiveBranchId ?? null);
  const wrapperRef                      = useRef(null);

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
  //
  // 1. Optimistic update — flip is_active locally so the badge changes
  //    instantly without waiting for the server.
  // 2. POST /fork/:id/switch — server deactivates siblings, activates target,
  //    and returns the authoritative { ok, segments, forks } payload.
  // 3. On success — apply the server's forks array directly; no second fetch.
  // 4. On failure — roll back the optimistic update and show an error banner.
  // -------------------------------------------------------------------------
  async function handleSwitch(forkId) {
    if (!forkId) return;
    if (switching) return; // block concurrent switches

    const targetFork = forks?.find((f) => f.id === forkId);
    if (!targetFork) return;

    // Optimistic update: activate target, deactivate all siblings instantly
    const prevForks = forks;
    const targetKey = siblingKey(targetFork);
    setForks((prev) =>
      prev.map((f) => {
        if (f.id === forkId) return { ...f, is_active: 1 };
        if (siblingKey(f) === targetKey && f.id !== forkId) return { ...f, is_active: 0 };
        return f;
      })
    );
    setActiveBranchId(forkId);

    setSwitching(forkId);
    setSwitchError(null);
    try {
      const res = await fetch(`/fork/${forkId}/switch`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      if (data.ok === false) throw new Error(data.error || 'Switch failed');

      // Apply the authoritative forks array returned by the server — no second fetch needed.
      if (Array.isArray(data.forks) && data.forks.length > 0) {
        setForks(data.forks);
      } else {
        // Fallback: server didn't return forks (shouldn't happen), re-fetch
        fetchTree();
      }

      if (onSwitch) onSwitch(data.activeForkId ?? forkId, data.segments ?? null);
    } catch (err) {
      setForks(prevForks); // roll back on failure
      setSwitchError(`Failed to switch branch: ${err.message}`);
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
  // -------------------------------------------------------------------------
  function renderVisualTree(rawForks) {
    if (!rawForks || rawForks.length === 0) return null;

    // --- Build sibling groups and normalise is_active ---
    const sibGroups   = buildSiblingGroups(rawForks);
    const normForks   = normaliseSiblingActivity(rawForks, sibGroups);

    // --- Geometry constants ---
    const ROOT_W    = 188;
    const ROOT_H    = 64;
    const NODE_W    = 230;
    const NODE_H    = 72;
    const V_GAP     = 14;   // gap between cards in the same sibling group
    const GROUP_GAP = 26;   // extra gap between different sibling groups
    const H_SPAN    = 140;
    const PAD_TOP   = 24;
    const PAD_LEFT  = 24;
    const PAD_RIGHT = 32;

    // Build stable branch number index (order by creation time)
    const chronological = [...normForks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const branchIndex   = new Map(chronological.map((f, i) => [f.id, i + 1]));

    // Build ordered layout: group siblings together, ordered by earliest
    // creation time within the group, groups ordered by earliest fork in group.
    const groupOrder = [];   // [{ key, forks[] }]
    const seen = new Set();
    for (const fork of chronological) {
      const key = siblingKey(fork);
      if (seen.has(key)) continue;
      seen.add(key);
      // Sort siblings: active first, then by creation time
      const group = (sibGroups.get(key) ?? [fork])
        .sort((a, b) => (b.is_active - a.is_active) || (new Date(a.created_at) - new Date(b.created_at)));
      groupOrder.push({ key, group });
    }
    // Include non-resolved forks (proposed/failed) as singleton groups
    for (const fork of normForks) {
      if (fork.status === 'proposed' || fork.status === 'failed') {
        if (!seen.has(`singleton-${fork.id}`)) {
          seen.add(`singleton-${fork.id}`);
          groupOrder.push({ key: `singleton-${fork.id}`, group: [fork] });
        }
      }
    }

    // Compute Y positions: each card is NODE_H tall, sibling cards have V_GAP,
    // different groups have GROUP_GAP between them.
    let yOffset = PAD_TOP;
    const branchPositions = [];
    for (let gi = 0; gi < groupOrder.length; gi++) {
      const { group } = groupOrder[gi];
      for (let fi = 0; fi < group.length; fi++) {
        branchPositions.push({ fork: normForks.find((f) => f.id === group[fi].id) ?? group[fi], y: yOffset });
        yOffset += NODE_H + (fi < group.length - 1 ? V_GAP : 0);
      }
      if (gi < groupOrder.length - 1) yOffset += GROUP_GAP;
    }

    const totalBranchH = yOffset - PAD_TOP;
    const rootY        = PAD_TOP + Math.max(0, (totalBranchH - ROOT_H) / 2);
    const svgW         = PAD_LEFT + ROOT_W + H_SPAN + NODE_W + PAD_RIGHT;
    const svgH         = yOffset + PAD_TOP;

    const rootX    = PAD_LEFT;
    const rootMidX = rootX + ROOT_W;
    const rootMidY = rootY + ROOT_H / 2;
    const branchX  = PAD_LEFT + ROOT_W + H_SPAN;

    // ---- Sibling bracket lines (vertical bar connecting sibling cards) ----
    const siblingBrackets = groupOrder
      .filter(({ group }) => group.length > 1)
      .map(({ group }) => {
        const positions = group.map((gf) => branchPositions.find((bp) => bp.fork.id === gf.id));
        if (positions.some((p) => !p)) return null;
        const topY    = positions[0].y;
        const bottomY = positions[positions.length - 1].y + NODE_H;
        const midY    = (topY + bottomY) / 2;
        const bracketX = branchX - 10;
        return (
          <g key={`bracket-${group[0].id}`}>
            {/* Vertical bracket bar */}
            <line
              x1={bracketX} y1={topY + 6}
              x2={bracketX} y2={bottomY - 6}
              stroke="#c5c5f0" strokeWidth="2" strokeLinecap="round"
            />
            {/* Horizontal tick to each card */}
            {positions.map((pos) => (
              <line
                key={`tick-${pos.fork.id}`}
                x1={bracketX} y1={pos.y + NODE_H / 2}
                x2={branchX}  y2={pos.y + NODE_H / 2}
                stroke="#c5c5f0" strokeWidth="1.5"
              />
            ))}
            {/* Label: "Anchor group" */}
            <text
              x={bracketX - 2} y={midY}
              fontSize={7.5} fontFamily="'Plus Jakarta Sans', sans-serif"
              fontWeight="600" fill="#9090d0"
              textAnchor="end" dominantBaseline="middle"
              style={{ textTransform: 'uppercase', letterSpacing: '0.07em' }}
            >
              ⇄
            </text>
          </g>
        );
      })
      .filter(Boolean);

    // ---- Bezier edges ----
    const edges = branchPositions.map(({ fork, y }) => {
      const isActive  = fork.is_active;
      const isHighlit = activeBranchId === fork.id;
      const midY      = y + NODE_H / 2;
      const x1 = rootMidX, y1 = rootMidY;
      const x2 = branchX,  y2 = midY;
      const cx = x1 + (x2 - x1) * 0.5;
      return (
        <path
          key={`edge-${fork.id}`}
          d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke={isHighlit ? '#6366F1' : isActive ? '#6366F1' : '#dde0e8'}
          strokeWidth={isHighlit ? 2.5 : isActive ? 2 : 1.5}
          strokeOpacity={isHighlit ? 1 : isActive ? 0.8 : 0.4}
          strokeDasharray={isActive ? 'none' : '5 3'}
        />
      );
    });

    // ---- Branch node cards ----
    const nodeCards = branchPositions.map(({ fork, y }) => {
      const label         = statusLabel(fork);
      const branchNum     = branchIndex.get(fork.id) ?? '?';
      const isHighlit     = activeBranchId === fork.id;
      const isSelected    = selectedId === fork.id;
      const isSwitchable  = fork.status === 'resolved' && !fork.is_active;
      const color         = STATUS_COLOR[label] || '#57606a';
      const bg            = STATUS_BG[label]    || '#f4f5f7';
      const border        = STATUS_BORDER[label] || '#dde0e8';
      const originSnippet = fork.original_snippet
        ? fork.original_snippet.slice(0, 28) + (fork.original_snippet.length > 28 ? '…' : '')
        : '(empty)';
      const emphasized    = isHighlit || isSelected;

      function handleClick() {
        if (isSwitchable) {
          handleSwitch(fork.id);
        } else {
          setSelectedId((prev) => (prev === fork.id ? null : fork.id));
          setActiveBranchId(fork.id);
        }
      }

      return (
        <g
          key={fork.id}
          id={`branch-node-${fork.id}`}
          transform={`translate(${branchX}, ${y})`}
          onClick={handleClick}
          onKeyDown={(e) => e.key === 'Enter' && handleClick()}
          style={{ cursor: isSwitchable ? 'pointer' : 'default' }}
          role="button"
          tabIndex={0}
          aria-label={
            isSwitchable
              ? `Switch to Branch ${branchNum}: ${originSnippet}`
              : `Branch ${branchNum} (${label}): ${originSnippet}`
          }
          aria-pressed={isSelected}
        >
          {/* Highlight ring */}
          {emphasized && (
            <rect x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={12}
              fill="none" stroke="#6366F1" strokeWidth="2.5" opacity="0.75" />
          )}

          {/* Card background */}
          <rect
            width={NODE_W} height={NODE_H} rx={10}
            fill={switching === fork.id ? '#e0e7ff' : emphasized ? '#eef0fc' : bg}
            stroke={switching === fork.id ? '#5b5bd6' : emphasized ? '#6366F1' : border}
            strokeWidth={emphasized ? 1.5 : 1}
          />

          {/* Status bar on left edge */}
          <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={color} />

          {/* Branch number (top-left) */}
          <text x={12} y={16} fontSize={9} fontFamily="'Plus Jakarta Sans', sans-serif"
            fontWeight="700" fill="#5b5bd6" textAnchor="start" dominantBaseline="middle">
            Branch {branchNum}
          </text>

          {/* Status pill (top-right) */}
          <rect x={NODE_W - 66} y={8} width={52} height={15} rx={4}
            fill={bg} stroke={border} strokeWidth="1" />
          <text x={NODE_W - 40} y={17}
            fontSize={8.5} fontFamily="'Plus Jakarta Sans', sans-serif"
            fontWeight="700" fill={color}
            textAnchor="middle" dominantBaseline="middle"
            style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </text>

          {/* Origin snippet */}
          <text x={12} y={36} fontSize={9.5} fontFamily="'Plus Jakarta Sans', sans-serif"
            fill="#57606a" textAnchor="start" dominantBaseline="middle">
            {`From: "${originSnippet}"`}
          </text>

          {/* Action hint row */}
          <text x={12} y={56} fontSize={10} fontFamily="'Plus Jakarta Sans', sans-serif"
            fill="#1f2328" textAnchor="start" dominantBaseline="middle">
            {switching === fork.id ? 'Switching…' : isSwitchable ? 'Click to switch ↺' : ''}
          </text>
        </g>
      );
    });

    // ---- Root/trunk node ----
    const rootNode = (
      <g key="root-trunk" transform={`translate(${rootX}, ${rootY})`}>
        <rect width={ROOT_W} height={ROOT_H} rx={12}
          fill="#f0f0fb" stroke="#5b5bd6" strokeWidth="1.5" />
        <rect x={0} y={0} width={5} height={ROOT_H} rx={3} fill="#5b5bd6" />
        <text x={ROOT_W / 2 + 3} y={ROOT_H / 2 - 8}
          fontSize={9} fontFamily="'Plus Jakarta Sans', sans-serif"
          fontWeight="700" fill="#5b5bd6"
          textAnchor="middle" dominantBaseline="middle"
          style={{ textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          ORIGINAL DRAFT
        </text>
        <text x={ROOT_W / 2 + 3} y={ROOT_H / 2 + 8}
          fontSize={10} fontFamily="'Plus Jakarta Sans', sans-serif"
          fill="#3d3da8" textAnchor="middle" dominantBaseline="middle">
          Main story trunk
        </text>
      </g>
    );

    return (
      <div className="tree-svg-wrapper" ref={wrapperRef}>
        <svg
          width={svgW} height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="tree-svg"
          aria-label="Story decision tree diagram"
          style={{ minWidth: svgW }}
        >
          <g className="tree-svg__edges">{edges}</g>
          <g className="tree-svg__brackets">{siblingBrackets}</g>
          {rootNode}
          <g className="tree-svg__branches">{nodeCards}</g>
        </svg>

        {/* Detail card for selected branch */}
        {selectedId && (() => {
          const sel = normForks.find((f) => f.id === selectedId);
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
  function renderListView(rawForks) {
    const sibGroups  = buildSiblingGroups(rawForks);
    const normForks  = normaliseSiblingActivity(rawForks, sibGroups);
    const chronological = [...normForks].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Build ordered list of sibling groups (same logic as visual tree)
    const groupOrder = [];
    const seen = new Set();
    for (const fork of chronological) {
      const key = siblingKey(fork);
      if (seen.has(key)) { continue; }
      seen.add(key);
      const group = (sibGroups.get(key) ?? [fork])
        .map((gf) => normForks.find((f) => f.id === gf.id) ?? gf)
        .sort((a, b) => (b.is_active - a.is_active) || (new Date(a.created_at) - new Date(b.created_at)));
      groupOrder.push({ key, group, isMulti: group.length > 1 });
    }
    // Singletons for proposed/failed
    for (const fork of normForks) {
      if (fork.status === 'proposed' || fork.status === 'failed') {
        const sk = `singleton-${fork.id}`;
        if (!seen.has(sk)) {
          seen.add(sk);
          groupOrder.push({ key: sk, group: [fork], isMulti: false });
        }
      }
    }

    let globalIdx = 0;

    return (
      <div className="tree-list">
        {groupOrder.map(({ key, group, isMulti }) => {
          const originText = group[0].original_snippet
            ? `"${group[0].original_snippet.slice(0, 60)}${group[0].original_snippet.length > 60 ? '…' : ''}"`
            : '(empty)';

          return (
            <div
              key={key}
              className={`tree-list__group${isMulti ? ' tree-list__group--multi' : ''}`}
            >
              {/* Sibling group header — only shown when there are 2+ siblings */}
              {isMulti && (
                <div className="tree-list__group-header">
                  <span className="tree-list__group-anchor-label">
                    ⇄ {group.length} variants at same position
                  </span>
                  <span className="tree-list__group-origin">{originText}</span>
                </div>
              )}

              {group.map((fork) => {
                globalIdx += 1;
                const myIdx  = globalIdx;
                const label  = statusLabel(fork);
                const color  = STATUS_COLOR[label];
                const isHighlighted = activeBranchId === fork.id;
                const origin = fork.original_snippet
                  ? `"${fork.original_snippet.slice(0, 60)}${fork.original_snippet.length > 60 ? '…' : ''}"`
                  : '(empty)';

                return (
                  <div
                    key={fork.id}
                    id={`branch-node-${fork.id}`}
                    className={`tree-list__card tree-list__card--${label}${isHighlighted ? ' tree-list__card--highlighted' : ''}${isMulti ? ' tree-list__card--sibling' : ''}`}
                    onClick={() => setActiveBranchId(fork.id)}
                  >
                    <div className="tree-list__card-header">
                      <span className="tree-list__branch-num">Branch {myIdx}</span>
                      <span className="tree-list__status-dot" style={{ background: color }} aria-hidden="true" />
                      <span className="tree-list__status-label" style={{ color }}>{label}</span>
                      {isMulti && fork.is_active ? (
                        <span className="tree-list__active-badge">✓ active variant</span>
                      ) : null}
                      <span className="tree-list__date">
                        {new Date(fork.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>

                    {/* Origin row — only show for non-multi (multi shows it in group header) */}
                    {!isMulti && (
                      <div className="tree-list__origin">
                        <span className="tree-list__origin-label">Origin</span>
                        <span className="tree-list__origin-text">{origin}</span>
                      </div>
                    )}

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
                          disabled={!!switching}
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
      {/* ── Switch error banner ── */}
      {switchError && (
        <div className="tree-view__switch-error" role="alert">
          <span>{switchError}</span>
          <button
            className="tree-view__switch-error-close"
            onClick={() => setSwitchError(null)}
            aria-label="Dismiss error"
          >✕</button>
        </div>
      )}

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
