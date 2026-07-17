import { useState } from 'react';
import './ReviewPanel.css';

/**
 * ReviewPanel — shown while a fork is pending (status=proposed).
 * Displays original_snippet vs branch_content side by side.
 * Approve and Reject call the parent handlers and handle their own
 * loading/error state so the buttons disable during the in-flight request.
 */
export default function ReviewPanel({ fork, onApprove, onReject }) {
  const [loading, setLoading] = useState(null); // 'approving' | 'rejecting' | null
  const [error, setError]     = useState(null);

  async function handleApprove() {
    setLoading('approving');
    setError(null);
    try {
      await onApprove(fork.id);
    } catch (err) {
      setError(err.message || 'Approve failed');
      setLoading(null);
    }
  }

  async function handleReject() {
    setLoading('rejecting');
    setError(null);
    try {
      await onReject(fork.id);
    } catch (err) {
      setError(err.message || 'Reject failed');
      setLoading(null);
    }
  }

  const busy = loading !== null;

  return (
    <div className="review-panel">
      <p className="review-panel__heading">Review alternative</p>
      <div className="review-panel__columns">
        <div className="review-panel__col review-panel__col--original">
          <span className="review-panel__col-label">Original</span>
          <div className="review-panel__text">{fork.original_snippet}</div>
        </div>
        <div className="review-panel__col review-panel__col--alternative">
          <span className="review-panel__col-label">Alternative</span>
          <div className="review-panel__text">{fork.branch_content}</div>
        </div>
      </div>

      {error && <p className="review-panel__error">{error}</p>}

      <div className="review-panel__actions">
        <button
          className="btn btn--ghost"
          onClick={handleReject}
          disabled={busy}
        >
          {loading === 'rejecting' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          className="btn btn--primary"
          onClick={handleApprove}
          disabled={busy}
        >
          {loading === 'approving' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
