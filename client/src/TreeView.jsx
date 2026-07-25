import { useEffect, useState, useCallback, useRef } from 'react';
import './TreeView.css';

const CARD_W        = 200;   // card width px
const CARD_H        = 120;   // card height px
const H_GAP         = 28;    // horizontal gap between sibling cards within a cluster
const V_GAP         = 110;   // vertical gap between rows (card bottom → child card top)
const ROW_H         = CARD_H + V_GAP;
const CLUSTER_GAP   = 96;    // extra horizontal gap between independent decision clusters
const CANVAS_PAD    = 60;    // horizontal padding on each side of the canvas
const SEQ_Y_OFFSET  = CARD_H / 2;  // sequence line pierces cluster roots at their vertical midpoint

/**
 * TreeView — version-history view.
 *
 * Layout model (updated):
 *  Each distinct decision point (unique anchor_start/anchor_end with
 *  parent_fork_id=null) is an independent CLUSTER:
 *
 *    [ Original ]          [ Original ]          [ Original ]
 *         |                     |                     |
 *    ┌────┴────┐           ┌────┘           ┌────┬────┐
 *  [Alt A] [Alt B]       [Alt C]          [Alt] [Alt] ...
 *     |
 *  [Alt A.1] ...   ← true child forks nest vertically within their cluster
 *
 *  Clusters are ordered left-to-right by anchor_start.
 *  Each cluster gets its own "Original" card showing original_snippet.
 *  Intra-cluster gaps use H_GAP; inter-cluster gaps use CLUSTER_GAP.
 *
 * Props:
 *   docId              string
 *   onBackToEditor()   "Back to editor" click
 *   onSwitch()         after branch switch — re-fetches /resolved
 *   onCheckConsistency()
 */
export default function TreeView({ docId, onBackToEditor, onSwitch, onCheckConsistency }) {
  const [forks, setForks]           = useState(null);
  const [loadError, setLoadError]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [switching, setSwitching]   = useState(null);
  const [whyState, setWhyState]     = useState('idle');
  const [whyError, setWhyError]     = useState(null);
  const canvasRef = useRef(null);

  const fetchTree = useCallback(() => {
    setLoadError(null);
    fetch(`/document/${docId}/tree`)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(({ forks }) => setForks(forks))
      .catch((err) => setLoadError(err.message));
  }, [docId]);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  // ---------------------------------------------------------------------------
  // buildGroups — group siblings by (anchor_start, anchor_end) at a given level
  //
  // Returns array of SiblingGroup, each SiblingGroup = ForkNode[]
  // ForkNode = fork row + { childGroups: SiblingGroup[] }
  //
  // Called recursively: buildGroups(allForks, someForkId) finds true children
  // of that fork and groups their siblings the same way.
  // ---------------------------------------------------------------------------
  function buildGroups(allForks, parentForkId) {
    const children = allForks.filter(
      (f) => (f.parent_fork_id ?? null) === (parentForkId ?? null)
    );
    if (children.length === 0) return [];

    const anchorMap = new Map();
    for (const f of children) {
      const key = `${f.anchor_start}-${f.anchor_end}`;
      if (!anchorMap.has(key)) anchorMap.set(key, []);
      anchorMap.get(key).push(f);
    }

    const groups = [];
    for (const [, siblings] of anchorMap) {
      // Active sibling first, then by creation time
      siblings.sort((a, b) => {
        if (a.is_active !== b.is_active) return b.is_active - a.is_active;
        return new Date(a.created_at) - new Date(b.created_at);
      });
      groups.push(
        siblings.map((f) => ({ ...f, childGroups: buildGroups(allForks, f.id) }))
      );
    }
    // Document order: left-to-right by anchor_start
    groups.sort((a, b) => (a[0]?.anchor_start ?? 0) - (b[0]?.anchor_start ?? 0));
    return groups;
  }

  // ---------------------------------------------------------------------------
  // computeLayout — produce the node/edge lists for the SVG canvas.
  //
  // Top-level design: each SiblingGroup from buildGroups(allForks, null) is an
  // independent CLUSTER.  Each cluster has:
  //   • One synthetic "cluster root" node (isClusterRoot=true) at depth 0
  //     showing the original_snippet that was forked.
  //   • Its alternatives (and their descendants) at depth ≥ 1 below it.
  //
  // Clusters are placed side-by-side, separated by CLUSTER_GAP.
  // Within a cluster, siblings share H_GAP.
  //
  // Returns { nodes, edges, totalW, totalH }
  // ---------------------------------------------------------------------------
  function computeLayout(allForks) {
    if (!allForks || allForks.length === 0) {
      return { nodes: [], edges: [], seqLine: [], totalW: 0, totalH: 0 };
    }

    // ── Pass 1: subtree pixel width for a single ForkNode ──────────────────
    // (how wide the subtree rooted at this fork needs to be)
    function subtreeWidth(forkNode) {
      if (forkNode.childGroups.length === 0) return CARD_W;
      // Each childGroup is laid out side-by-side; groups are separated by H_GAP
      const groupWidths = forkNode.childGroups.map((group) => {
        const sibWidths = group.map(subtreeWidth);
        return sibWidths.reduce((s, w) => s + w, 0) + (group.length - 1) * H_GAP;
      });
      const total = groupWidths.reduce((s, w) => s + w + H_GAP, -H_GAP);
      return Math.max(CARD_W, total);
    }

    // ── Cluster width: the original card + the span of its children ────────
    // A cluster = one top-level SiblingGroup (array of sibling ForkNodes all
    // sharing the same anchor_start/anchor_end).
    // The cluster root card sits above them; the cluster width = max(CARD_W,
    // width of all siblings side-by-side).
    function clusterWidth(siblingGroup) {
      const sibWidths = siblingGroup.map(subtreeWidth);
      const siblingsTotal = sibWidths.reduce((s, w) => s + w, 0) + (siblingGroup.length - 1) * H_GAP;
      return Math.max(CARD_W, siblingsTotal);
    }

    const rootGroups = buildGroups(allForks, null); // array of SiblingGroup

    // Sort clusters by anchor_start (already done inside buildGroups, but be explicit)
    rootGroups.sort((a, b) => (a[0]?.anchor_start ?? 0) - (b[0]?.anchor_start ?? 0));

    const clusterWidths = rootGroups.map(clusterWidth);
    const totalClustersW = clusterWidths.reduce((s, w) => s + w, 0)
      + (clusterWidths.length - 1) * CLUSTER_GAP;
    const totalW = totalClustersW + CANVAS_PAD * 2;

    const nodes = [];
    const edges = [];

    // ── Pass 2: place nodes ──────────────────────────────────────────────────
    //
    // placeSubtree recursively places one ForkNode and its descendants.
    //   clusterLeft  — left edge of the column allocated to this subtree
    //   subtreeW     — total pixel width allocated (= subtreeWidth(forkNode))
    //   depth        — row index (0 = cluster root row, 1 = first child row, …)
    //   parentCX/CY  — connector origin (centre-bottom of parent card)
    //   parentIsActive — whether the parent is on the active path
    function placeSubtree(forkNode, clusterLeft, sw, depth, parentCX, parentCY, parentIsActive) {
      const nodeX = clusterLeft + (sw - CARD_W) / 2;
      const nodeY = depth * ROW_H + 40;
      const nodeCX = nodeX + CARD_W / 2;
      const nodeCY = nodeY + CARD_H;
      const isActive = !!forkNode.is_active;

      nodes.push({ id: forkNode.id, x: nodeX, y: nodeY, fork: forkNode });
      edges.push({
        x1: parentCX, y1: parentCY,
        x2: nodeCX,   y2: nodeY,
        active: parentIsActive && isActive,
      });

      // Recurse into childGroups (anchor-groups within this fork's output)
      if (forkNode.childGroups.length > 0) {
        const groupWidths = forkNode.childGroups.map((group) => {
          const sibWidths = group.map(subtreeWidth);
          return sibWidths.reduce((s, w) => s + w, 0) + (group.length - 1) * H_GAP;
        });
        const childrenTotalW = groupWidths.reduce((s, w) => s + w + H_GAP, -H_GAP);
        let childCursor = nodeCX - childrenTotalW / 2;

        for (let gi = 0; gi < forkNode.childGroups.length; gi++) {
          const group = forkNode.childGroups[gi];
          const sibWidths = group.map(subtreeWidth);
          let sibCursor = childCursor;
          for (let si = 0; si < group.length; si++) {
            const fw = sibWidths[si];
            placeSubtree(group[si], sibCursor, fw, depth + 1, nodeCX, nodeCY, isActive);
            sibCursor += fw + H_GAP;
          }
          childCursor += groupWidths[gi] + H_GAP;
        }
      }
    }

    // Place each cluster; also collect sequence-line anchor points
    const seqLine = [];   // [{cx, y}] — one point per cluster, left to right
    let clusterCursor = CANVAS_PAD;
    for (let ci = 0; ci < rootGroups.length; ci++) {
      const group     = rootGroups[ci];      // sibling ForkNodes at this anchor
      const cw        = clusterWidths[ci];   // total pixel width of this cluster
      const clusterCX = clusterCursor + cw / 2;  // centre of cluster

      // ── Cluster root card (the "Original" node) ──
      const rootX = clusterCursor + (cw - CARD_W) / 2;
      const rootY = 40;
      const rootCX = rootX + CARD_W / 2;
      const rootCY = rootY + CARD_H;
      nodes.push({
        id:              `__cluster_${ci}__`,
        x:               rootX,
        y:               rootY,
        fork:            null,
        isClusterRoot:   true,
        originalSnippet: group[0]?.original_snippet ?? '',
        originalIsActive: group.every((fn) => !fn.is_active),
      });

      // Sequence line pierces the cluster root at its vertical midpoint
      seqLine.push({ cx: rootCX, y: rootY + SEQ_Y_OFFSET });

      // ── Place siblings below the cluster root ──
      const sibWidths = group.map(subtreeWidth);
      const siblingsW = sibWidths.reduce((s, w) => s + w, 0) + (group.length - 1) * H_GAP;
      let sibCursor   = clusterCX - siblingsW / 2;

      for (let si = 0; si < group.length; si++) {
        const fw = sibWidths[si];
        placeSubtree(group[si], sibCursor, fw, 1, rootCX, rootCY, true);
        sibCursor += fw + H_GAP;
      }

      clusterCursor += cw + CLUSTER_GAP;
    }

    const maxY = nodes.reduce((m, n) => Math.max(m, n.y + CARD_H), 0);
    return { nodes, edges, seqLine, totalW, totalH: maxY + 60 };
  }

  // ---------------------------------------------------------------------------
  // Switch branch
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Generate why
  // ---------------------------------------------------------------------------
  async function handleGenerateWhy(forkId) {
    setWhyState('generating');
    setWhyError(null);
    try {
      const res = await fetch(`/fork/${forkId}/why`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      const newWhy = data.fork?.why ?? null;
      setForks((prev) => prev.map((f) => (f.id === forkId ? { ...f, why: newWhy } : f)));
      setWhyState('idle');
    } catch (err) {
      setWhyError(err.message);
      setWhyState('generating_error');
    }
  }

  // ---------------------------------------------------------------------------
  // Stats + active leaf
  // ---------------------------------------------------------------------------
  const totalVersions = forks ? forks.filter((f) => f.status === 'resolved').length : 0;
  const withoutReason = forks ? forks.filter((f) => f.status === 'resolved' && f.is_active && !f.why).length : 0;

  // The "Current" badge goes on the deepest active-path leaf —
  // the one is_active fork that has no is_active child.
  const activeLeafId = forks
    ? (() => {
        const activeIds = new Set(forks.filter((f) => f.is_active).map((f) => f.id));
        const activeWithActiveChild = new Set(
          forks
            .filter((f) => f.is_active && f.parent_fork_id && activeIds.has(f.parent_fork_id))
            .map((f) => f.parent_fork_id)
        );
        const leaves = forks.filter((f) => f.is_active && !activeWithActiveChild.has(f.id));
        leaves.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return leaves[0]?.id ?? null;
      })()
    : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const selectedFork = forks && selectedId
    ? forks.find((f) => f.id === selectedId) ?? null
    : null;

  if (loadError) {
    return (
      <div className="vhist-shell">
        <VHistHeader onBack={onBackToEditor} onCheckConsistency={onCheckConsistency}
          totalVersions={0} withoutReason={0} isLocked={false} />
        <div className="vhist-error">
          Failed to load tree: {loadError}
          <button className="vhist-retry-btn" onClick={fetchTree}>Retry</button>
        </div>
      </div>
    );
  }

  if (!forks) {
    return (
      <div className="vhist-shell">
        <VHistHeader onBack={onBackToEditor} onCheckConsistency={onCheckConsistency}
          totalVersions={0} withoutReason={0} isLocked={false} />
        <div className="vhist-loading">Loading…</div>
      </div>
    );
  }

  if (forks.length === 0) {
    return (
      <div className="vhist-shell">
        <VHistHeader onBack={onBackToEditor} onCheckConsistency={onCheckConsistency}
          totalVersions={0} withoutReason={0} isLocked={false} />
        <div className="vhist-empty">
          No decision forks yet. Select text in the editor and click "Show alternative."
        </div>
      </div>
    );
  }

  const { nodes, edges, seqLine, totalW, totalH } = computeLayout(forks);
  const hasDetailPanel = !!selectedFork;

  return (
    <div className={`vhist-shell${hasDetailPanel ? ' vhist-shell--panel-open' : ''}`}>
      <VHistHeader
        onBack={onBackToEditor}
        onCheckConsistency={onCheckConsistency}
        totalVersions={totalVersions}
        withoutReason={withoutReason}
        isLocked={false}
      />

      <div className="vhist-body">
        <div className="vhist-canvas-wrap" ref={canvasRef}>
          <div className="vhist-canvas" style={{ width: totalW, minHeight: totalH }}>

            {/* SVG layer: branch connectors + document-order sequence line */}
            <svg className="vhist-svg" width={totalW} height={totalH} aria-hidden="false">
              {/* ── Document-order sequence line ── */}
              {seqLine.length >= 2 && (() => {
                const pts = seqLine.map(p => `${p.cx},${p.y}`).join(' ');
                const last = seqLine[seqLine.length - 1];
                // Arrowhead marker definition
                return (
                  <>
                    <defs>
                      <marker id="seq-arrow" markerWidth="7" markerHeight="7"
                        refX="6" refY="3.5" orient="auto">
                        <path d="M0,0 L0,7 L7,3.5 z" className="vhist-seq-arrow" />
                      </marker>
                    </defs>
                    <polyline
                      points={pts}
                      className="vhist-seq-line"
                      markerEnd="url(#seq-arrow)"
                    />
                    {/* "document order" label — above the first cluster root, left-aligned */}
                    <text
                      x={seqLine[0].cx - CARD_W / 2}
                      y={seqLine[0].y - 14}
                      className="vhist-seq-label"
                    >
                      document order
                    </text>
                  </>
                );
              })()}

              {/* ── Branch connectors ── */}
              {edges.map((e, i) => {
                const my1 = e.y1 + (e.y2 - e.y1) * 0.45;
                const my2 = e.y2 - (e.y2 - e.y1) * 0.45;
                const d = `M ${e.x1} ${e.y1} C ${e.x1} ${my1}, ${e.x2} ${my2}, ${e.x2} ${e.y2}`;
                return (
                  <path key={i} d={d}
                    className={e.active ? 'vhist-edge vhist-edge--active' : 'vhist-edge vhist-edge--inactive'} />
                );
              })}
            </svg>

            {/* Cards */}
            {nodes.map((n) => {
              // ── Cluster root ("Original" card) ──────────────────────────
              if (n.isClusterRoot) {
                return (
                  <div
                    key={n.id}
                    className={`vhist-card vhist-card--root${n.originalIsActive ? ' vhist-card--root-active' : ''}`}
                    style={{ left: n.x, top: n.y, width: CARD_W }}
                    title="Original passage"
                  >
                    <div className="vhist-card__label">
                      Original{n.originalIsActive ? ' — kept' : ''}
                    </div>
                    <div className="vhist-card__snippet vhist-card__snippet--root">
                      {n.originalSnippet
                        ? n.originalSnippet.slice(0, 90) + (n.originalSnippet.length > 90 ? '…' : '')
                        : '—'}
                    </div>
                  </div>
                );
              }

              // ── Fork card ────────────────────────────────────────────────
              const fork     = n.fork;
              const isCurrent  = fork.id === activeLeafId;
              const isOnPath   = !!fork.is_active && !isCurrent;
              const isFailed   = fork.status === 'failed';
              const isPending  = fork.status === 'proposed';
              const isInactive = !fork.is_active && !isFailed && !isPending;
              const isSelected = selectedId === fork.id;

              return (
                <div
                  key={fork.id}
                  className={[
                    'vhist-card',
                    isCurrent  ? 'vhist-card--current'  : '',
                    isOnPath   ? 'vhist-card--on-path'  : '',
                    isFailed   ? 'vhist-card--failed'   : '',
                    isPending  ? 'vhist-card--pending'  : '',
                    isInactive ? 'vhist-card--inactive' : '',
                    isSelected ? 'vhist-card--selected' : '',
                  ].filter(Boolean).join(' ')}
                  style={{ left: n.x, top: n.y, width: CARD_W }}
                  onClick={() => setSelectedId(isSelected ? null : fork.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedId(isSelected ? null : fork.id)}
                  aria-pressed={isSelected}
                >
                  <div className="vhist-card__header">
                    <span className="vhist-card__label">
                      {isCurrent ? 'Current version' :
                       isOnPath  ? 'Active branch'   :
                       isFailed  ? 'Failed'           :
                       isPending ? 'Pending'          : 'Alternative'}
                    </span>
                    {isCurrent && <span className="vhist-card__badge">Current</span>}
                  </div>
                  <div className="vhist-card__snippet">
                    {fork.branch_content
                      ? fork.branch_content.slice(0, 90) + (fork.branch_content.length > 90 ? '…' : '')
                      : fork.original_snippet?.slice(0, 90) ?? ''}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right-side detail panel */}
        {selectedFork && (
          <DetailPanel
            fork={selectedFork}
            activeLeafId={activeLeafId}
            onClose={() => setSelectedId(null)}
            onSwitch={handleSwitch}
            switching={switching === selectedFork.id}
            onGenerateWhy={handleGenerateWhy}
            whyState={whyState}
            whyError={whyError}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VHistHeader
// ---------------------------------------------------------------------------
function VHistHeader({ onBack, onCheckConsistency, totalVersions, withoutReason, isLocked }) {
  return (
    <header className="vhist-header">
      <div className="vhist-header__left">
        <button className="vhist-header__back" onClick={onBack}>
          <span className="vhist-header__back-arrow">←</span>
          Back to editor
        </button>
        <span className="vhist-header__divider" aria-hidden="true" />
        <span className="vhist-header__title">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"
            style={{ marginRight: '0.35rem', verticalAlign: '-0.1em' }}>
            <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.5 5A1.5 1.5 0 1 0 3.5 8a1.5 1.5 0 0 0 0-3Zm0 0V5m0 0V3.5m9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 0v6.5a2 2 0 0 1-2 2H6.5"
              stroke="#1f2328" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Version history
        </span>
      </div>
      <div className="vhist-header__right">
        {totalVersions > 0 && (
          <span className="vhist-header__stats">
            {totalVersions} version{totalVersions !== 1 ? 's' : ''}
            {withoutReason > 0 && <> · {withoutReason} without reason</>}
          </span>
        )}
        <button
          className="vhist-header__consistency-btn"
          onClick={onCheckConsistency}
          disabled={isLocked}
        >
          ✓ Check consistency
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// DetailPanel
// ---------------------------------------------------------------------------
function DetailPanel({ fork, activeLeafId, onClose, onSwitch, switching, onGenerateWhy, whyState, whyError }) {
  const isCurrent = fork.id === activeLeafId;
  const canSwitch = fork.status === 'resolved' && !fork.is_active;

  const label = isCurrent                  ? 'Current'       :
                fork.is_active             ? 'Active branch' :
                fork.status === 'failed'   ? 'Failed'        :
                fork.status === 'proposed' ? 'Pending'       : 'Inactive';

  return (
    <aside className="vhist-detail">
      <div className="vhist-detail__header">
        <div className="vhist-detail__header-left">
          <span className="vhist-detail__title">
            {isCurrent      ? 'Current version' :
             fork.is_active ? 'Active branch'   : 'Alternative'}
          </span>
          <span className={`vhist-detail__badge vhist-detail__badge--${
            isCurrent          ? 'current'  :
            fork.is_active     ? 'on-path'  :
            fork.status === 'failed'   ? 'failed'   :
            fork.status === 'proposed' ? 'pending'  : 'inactive'
          }`}>
            {label}
          </span>
        </div>
        <button className="vhist-detail__close" onClick={onClose} aria-label="Close detail">✕</button>
      </div>

      <div className="vhist-detail__body">
        <div className="vhist-detail__section">
          <div className="vhist-detail__section-label">Original</div>
          <div className="vhist-detail__section-text vhist-detail__section-text--muted">
            {fork.original_snippet || <em>empty</em>}
          </div>
        </div>

        <div className="vhist-detail__section">
          <div className="vhist-detail__section-label">This version</div>
          <div className="vhist-detail__section-text">
            {fork.branch_content || <em className="vhist-detail__empty">No content — generation failed</em>}
          </div>
        </div>

        <div className="vhist-detail__section">
          <div className="vhist-detail__section-label">Why this change</div>
          {fork.why ? (
            <div className="vhist-detail__section-text">{fork.why}</div>
          ) : (
            <div className="vhist-detail__why-empty">
              <span className="vhist-detail__why-none">No reason recorded.</span>
              {fork.status === 'resolved' && (
                <button
                  className="vhist-detail__why-btn"
                  onClick={() => onGenerateWhy(fork.id)}
                  disabled={whyState === 'generating'}
                >
                  {whyState === 'generating' ? 'Generating…' : 'Generate why'}
                </button>
              )}
              {whyState === 'generating_error' && whyError && (
                <span className="vhist-detail__why-error">{whyError}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {canSwitch && (
        <div className="vhist-detail__footer">
          <button
            className="vhist-detail__switch-btn"
            onClick={() => onSwitch(fork.id)}
            disabled={switching}
          >
            {switching ? 'Switching…' : 'Switch to this branch'}
          </button>
        </div>
      )}
    </aside>
  );
}
