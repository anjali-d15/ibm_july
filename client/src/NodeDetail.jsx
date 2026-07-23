import { useState } from 'react';
import './NodeDetail.css';

/**
 * NodeDetail — displayed inline below a selected tree node.
 *
 * Shows:
 *   - original_snippet vs branch_content side-by-side
 *   - why text (or "No reason recorded" + generate-why button)
 *   - "Switch to this branch" button for non-active, resolved forks
 *
 * Props:
 *   fork         object — the full fork row from /tree
 *   onSwitch(forkId) — called to perform the switch
 *   switching    bool  — true while the switch call is in-flight
 *   onWhyUpdated(why) — called when why is generated/saved
 */
export default function NodeDetail({ fork, onSwitch, switching, onWhyUpdated }) {
  const [whyState, setWhyState] = useState('idle'); // 'idle' | 'generating' | 'error'
  const [whyError, setWhyError] = useState(null);
  const [localWhy, setLocalWhy] = useState(fork.why);

  const isActive   = fork.status === 'resolved' && fork.is_active;
  const canSwitch  = fork.status === 'resolved' && !fork.is_active;

  async function handleGenerateWhy() {
    setWhyState('generating');
    setWhyError(null);
    try {
      const res = await fetch(`/fork/${fork.id}/why`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      const newWhy = data.fork?.why ?? null;
      setLocalWhy(newWhy);
      if (onWhyUpdated) onWhyUpdated(newWhy);
      setWhyState('idle');
    } catch (err) {
      setWhyError(err.message);
      setWhyState('error');
    }
  }

  const statusLabel =
    fork.status === 'proposed'                      ? 'Pending review' :
    fork.status === 'failed'                        ? 'Failed' :
    fork.status === 'resolved' && fork.is_active    ? 'Active' :
    fork.status === 'resolved' && !fork.is_active   ? 'Inactive' :
    fork.status;

  return (
    <div className="node-detail">
      <div className={`node-detail__status-strip node-detail__status-strip--${
        fork.status === 'proposed' ? 'pending' :
        fork.status === 'failed'   ? 'failed'  :
        isActive                   ? 'active'  : 'inactive'
      }`}>
        {statusLabel}
        {isActive && <span className="node-detail__active-mark"> — currently in document</span>}
      </div>

      {/* Original vs Alternative */}
      <div className="node-detail__columns">
        <div className="node-detail__col">
          <span className="node-detail__col-label">Original</span>
          <div className="node-detail__text">{fork.original_snippet || <em>empty</em>}</div>
        </div>
        <div className="node-detail__col">
          <span className="node-detail__col-label">Alternative</span>
          <div className="node-detail__text">
            {fork.branch_content
              ? fork.branch_content
              : <em className="node-detail__empty">No content — generation failed</em>}
          </div>
        </div>
      </div>

      {/* Why section */}
      <div className="node-detail__why">
        <span className="node-detail__why-label">Why this change</span>
        {localWhy ? (
          <p className="node-detail__why-text">{localWhy}</p>
        ) : (
          <div className="node-detail__why-empty">
            <span className="node-detail__why-none">No reason recorded.</span>
            {' '}
            {fork.status === 'resolved' && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={handleGenerateWhy}
                disabled={whyState === 'generating'}
              >
                {whyState === 'generating' ? 'Generating…' : 'Generate why'}
              </button>
            )}
            {whyState === 'error' && (
              <span className="node-detail__why-error"> {whyError}</span>
            )}
          </div>
        )}
      </div>

      {/* Switch action */}
      {canSwitch && (
        <div className="node-detail__actions">
          <button
            className="btn btn--primary"
            onClick={() => onSwitch(fork.id)}
            disabled={switching}
          >
            {switching ? 'Switching…' : 'Switch to this branch'}
          </button>
        </div>
      )}
    </div>
  );
}
