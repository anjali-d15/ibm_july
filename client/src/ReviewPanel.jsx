import './ReviewPanel.css';

/**
 * ReviewPanel — shown while a fork is pending (status=proposed).
 * Displays original_snippet vs branch_content side by side.
 * Approve/Reject wired in P3.
 *
 * Props:
 *   fork     — the fork row returned by generate-alternative
 *   onApprove(forkId) — P3 will implement; stub for now
 *   onReject(forkId)  — P3 will implement; stub for now
 */
export default function ReviewPanel({ fork, onApprove, onReject }) {
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
      <div className="review-panel__actions">
        <button
          className="btn btn--ghost"
          onClick={() => onReject && onReject(fork.id)}
          title="Reject this alternative (P3)"
        >
          Reject
        </button>
        <button
          className="btn btn--primary"
          onClick={() => onApprove && onApprove(fork.id)}
          title="Approve this alternative (P3)"
        >
          Approve
        </button>
      </div>
    </div>
  );
}
