import { useState } from 'react';
import './ReviewPanel.css';

/**
 * ReviewPanel — shown while a fork is pending (status=proposed).
 *
 * Displays original_snippet vs branch_content as a visual diff:
 *   - Original: rose-tinted background with strikethrough treatment
 *   - Alternative: emerald-tinted background, bold treatment
 *
 * Approve/Reject disable during the in-flight request and surface errors inline.
 */
/**
 * isSubmitting — passed from parent App to enforce global double-click guard.
 * All AI alternative content is rendered as plain text (React JSX escapes by default)
 * to prevent any DOM injection via Granite-generated strings.
 */
export default function ReviewPanel({ fork, onApprove, onReject, isSubmitting }) {
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

  const busy = loading !== null || isSubmitting;

  return (
    <div className="review-panel">
      <p className="review-panel__heading">Review alternative</p>

      <div className="review-panel__diff">
        {/* Original — rose/red diff block */}
        <div className="review-panel__diff-block review-panel__diff-block--original">
          <span className="review-panel__diff-label">Original</span>
          {/* Rendered as plain text string — React JSX escapes all HTML to prevent injection */}
          <p className="review-panel__diff-text">{String(fork.original_snippet)}</p>
        </div>

        {/* Alternative — emerald diff block. Content is AI-generated; rendered as sanitized plain text. */}
        <div className="review-panel__diff-block review-panel__diff-block--alternative">
          <span className="review-panel__diff-label">Alternative</span>
          <p className="review-panel__diff-text">{String(fork.branch_content)}</p>
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
