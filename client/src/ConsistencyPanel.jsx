import { useState, useEffect } from 'react';
import './ConsistencyPanel.css';

/**
 * ConsistencyPanel — P5 plot/intent consistency checker.
 *
 * Flow:
 *   1. Mount → immediately fires POST /document/:id/check-consistency.
 *      Shows a loading spinner on the "Check consistency" button.
 *   2. If findings is empty → shows "No contradictions found" + close button.
 *   3. If findings is non-empty → steps through each finding one at a time,
 *      showing the fork context + Granite's question + Intentional / Flag it buttons.
 *   4. Each answer fires PATCH /fork/:id/consistency immediately (not batched).
 *   5. After the last finding is answered → shows a summary + close button.
 *
 * Props:
 *   docId    string
 *   onClose  () => void
 */
export default function ConsistencyPanel({ docId, onClose }) {
  const [phase, setPhase]         = useState('loading');  // 'loading' | 'empty' | 'stepping' | 'done' | 'error'
  const [loadError, setLoadError] = useState(null);
  const [findings, setFindings]   = useState([]);
  const [stepIdx, setStepIdx]     = useState(0);          // which finding we're on
  const [forkDetails, setForkDetails] = useState({});     // forkId → fork row from /tree
  const [note, setNote]           = useState('');
  const [answering, setAnswering] = useState(false);      // in-flight PATCH
  const [answerError, setAnswerError] = useState(null);
  const [answered, setAnswered]   = useState([]);         // list of { fork_id, verdict } for summary

  // -------------------------------------------------------------------------
  // Step 1: run the consistency check on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const res = await fetch(`/document/${docId}/check-consistency`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Check failed (${res.status})`);

        if (cancelled) return;

        const { findings: raw } = data;
        if (!raw || raw.length === 0) {
          setPhase('empty');
          return;
        }

        // Fetch fork details for all finding fork_ids so we can show context
        const treeRes = await fetch(`/document/${docId}/tree`);
        const treeData = await treeRes.json().catch(() => ({ forks: [] }));
        if (!cancelled) {
          const details = {};
          for (const f of treeData.forks || []) details[f.id] = f;
          setForkDetails(details);
          setFindings(raw);
          setPhase('stepping');
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setPhase('error');
        }
      }
    }

    run();
    return () => { cancelled = true; };
  }, [docId]);

  // -------------------------------------------------------------------------
  // Step 4: answer a finding
  // -------------------------------------------------------------------------
  async function handleAnswer(verdict) {
    const finding = findings[stepIdx];
    setAnswering(true);
    setAnswerError(null);

    try {
      const res = await fetch(`/fork/${finding.fork_id}/consistency`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ verdict, note: note.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);

      setAnswered((prev) => [...prev, { fork_id: finding.fork_id, verdict }]);
      setNote('');

      const next = stepIdx + 1;
      if (next >= findings.length) {
        setPhase('done');
      } else {
        setStepIdx(next);
      }
    } catch (err) {
      setAnswerError(err.message);
    } finally {
      setAnswering(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  function renderForkContext(forkId) {
    const fork = forkDetails[forkId];
    if (!fork) return null;
    return (
      <div className="cp__fork-context">
        <div className="cp__fork-context-cols">
          <div className="cp__fork-context-col">
            <span className="cp__col-label">Original</span>
            <div className="cp__col-text">{fork.original_snippet || <em>empty</em>}</div>
          </div>
          <div className="cp__fork-context-col">
            <span className="cp__col-label">Alternative (active)</span>
            <div className="cp__col-text">{fork.branch_content || <em>empty</em>}</div>
          </div>
        </div>
        {fork.why && (
          <div className="cp__fork-why">
            <span className="cp__why-label">Why this change was made:</span>
            <p className="cp__why-text">{fork.why}</p>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------
  return (
    <div className="cp__backdrop" role="dialog" aria-modal="true" aria-label="Consistency check">
      <div className="cp__modal">
        <div className="cp__header">
          <span className="cp__title">Consistency check</span>
          <button className="cp__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* LOADING */}
        {phase === 'loading' && (
          <div className="cp__body cp__body--centered">
            <span className="cp__spinner" aria-hidden="true" />
            <p className="cp__loading-text">Running consistency check…</p>
          </div>
        )}

        {/* ERROR */}
        {phase === 'error' && (
          <div className="cp__body">
            <div className="cp__error-banner" role="alert">
              {loadError}
            </div>
            <div className="cp__actions">
              <button className="btn btn--primary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}

        {/* EMPTY — no contradictions */}
        {phase === 'empty' && (
          <div className="cp__body cp__body--centered">
            <p className="cp__empty-msg">No contradictions found.</p>
            <div className="cp__actions">
              <button className="btn btn--primary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}

        {/* STEPPING — one finding at a time */}
        {phase === 'stepping' && findings.length > 0 && (
          <div className="cp__body">
            <div className="cp__progress">
              Finding {stepIdx + 1} of {findings.length}
            </div>

            {renderForkContext(findings[stepIdx].fork_id)}

            <div className="cp__question">
              <span className="cp__question-label">Granite's question</span>
              <p className="cp__question-text">{findings[stepIdx].question}</p>
            </div>

            <div className="cp__note-row">
              <label className="cp__note-label" htmlFor="cp-note">
                Optional note (max 2000 chars)
              </label>
              <textarea
                id="cp-note"
                className="cp__note-textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                disabled={answering}
                placeholder="Add context or reasoning (optional)"
              />
            </div>

            {answerError && (
              <div className="cp__error-banner" role="alert">
                {answerError}
              </div>
            )}

            <div className="cp__actions cp__actions--verdict">
              <button
                className="btn btn--ghost"
                onClick={() => handleAnswer('flagged')}
                disabled={answering}
              >
                {answering ? <><span className="cp__spinner cp__spinner--sm" aria-hidden="true" /> Saving…</> : 'Flag it'}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => handleAnswer('intentional')}
                disabled={answering}
              >
                {answering ? <><span className="cp__spinner cp__spinner--sm" aria-hidden="true" /> Saving…</> : 'Intentional'}
              </button>
            </div>
          </div>
        )}

        {/* DONE — summary */}
        {phase === 'done' && (
          <div className="cp__body">
            <p className="cp__done-msg">All findings reviewed.</p>
            <ul className="cp__summary-list">
              {answered.map((a, i) => (
                <li key={a.fork_id} className={`cp__summary-item cp__summary-item--${a.verdict}`}>
                  Finding {i + 1}:{' '}
                  <span className={`cp__verdict-badge cp__verdict-badge--${a.verdict}`}>
                    {a.verdict === 'intentional' ? 'Intentional' : 'Flagged'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="cp__actions">
              <button className="btn btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
