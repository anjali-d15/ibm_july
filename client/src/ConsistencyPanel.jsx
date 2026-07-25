import { useState, useEffect } from 'react';
import './ConsistencyPanel.css';

/**
 * ConsistencyPanel — P5 consistency-review modal.
 *
 * Calls POST /document/:id/check-consistency to get the finding list,
 * then steps through each one. Each finding:
 *   { fork_id, question }
 *
 * For each finding it fetches the fork row from the already-loaded forks
 * (passed via `forks` prop), displays:
 *   - "Earlier, you noted:" block with the fork's why
 *   - Granite's generated question
 *   - Intentional / Flag it buttons
 *   - Optional note textarea
 *   - Progress dots + "N of M"
 *
 * On each answer: PATCH /fork/:id/consistency { verdict, note }
 *
 * Props:
 *   docId    string
 *   onClose()
 */
export default function ConsistencyPanel({ docId, onClose }) {
  const [phase, setPhase]       = useState('loading');  // 'loading' | 'no-findings' | 'review' | 'done' | 'error'
  const [findings, setFindings] = useState([]);
  const [forkMap, setForkMap]   = useState({});          // fork_id → fork row
  const [step, setStep]         = useState(0);           // current finding index
  const [verdict, setVerdict]   = useState(null);        // 'intentional' | 'flagged' | null
  const [note, setNote]         = useState('');
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // --------------------------------------------------------------------------
  // Load findings on mount
  // --------------------------------------------------------------------------
  useEffect(() => {
    async function load() {
      try {
        // Fetch forks for the why context
        const [checkRes, forksRes] = await Promise.all([
          fetch(`/document/${docId}/check-consistency`, { method: 'POST', credentials: 'include' }),
          fetch(`/document/${docId}/tree`),
        ]);

        const checkData = await checkRes.json().catch(() => ({}));
        if (!checkRes.ok) throw new Error(checkData.error || `${checkRes.status}`);

        const forksData = await forksRes.json().catch(() => ({}));
        const map = {};
        for (const f of (forksData.forks ?? [])) map[f.id] = f;
        setForkMap(map);

        const list = checkData.findings ?? [];
        setFindings(list);
        setPhase(list.length === 0 ? 'no-findings' : 'review');
      } catch (err) {
        setLoadError(err.message);
        setPhase('error');
      }
    }
    load();
  }, [docId]);

  // --------------------------------------------------------------------------
  // Answer a finding
  // --------------------------------------------------------------------------
  async function handleAnswer(chosenVerdict) {
    if (!verdict && chosenVerdict) setVerdict(chosenVerdict);
    const v = chosenVerdict ?? verdict;
    if (!v) return;

    setSaving(true);
    setSaveError(null);
    try {
      const finding = findings[step];
      const res = await fetch(`/fork/${finding.fork_id}/consistency`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ verdict: v, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);

      advance();
    } catch (err) {
      setSaveError(err.message);
      setSaving(false);
    }
  }

  function advance() {
    setSaving(false);
    setVerdict(null);
    setNote('');
    setSaveError(null);
    if (step + 1 >= findings.length) {
      setPhase('done');
    } else {
      setStep(step + 1);
    }
  }

  function handleSkipAll() {
    onClose();
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------
  const current = findings[step];
  const currentFork = current ? forkMap[current.fork_id] : null;

  return (
    <div className="cpanel-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cpanel" role="dialog" aria-modal="true" aria-label="Consistency review">
        {/* Header */}
        <div className="cpanel__header">
          <div className="cpanel__header-left">
            <span className="cpanel__checkmark" aria-hidden="true">✓</span>
            <span className="cpanel__title">Consistency review</span>
          </div>
          <div className="cpanel__header-right">
            {phase === 'review' && (
              <>
                <span className="cpanel__progress-dots" aria-label={`${step + 1} of ${findings.length}`}>
                  {findings.map((_, i) => (
                    <span
                      key={i}
                      className={`cpanel__dot${i === step ? ' cpanel__dot--active' : i < step ? ' cpanel__dot--done' : ''}`}
                    />
                  ))}
                </span>
                <span className="cpanel__progress-text">{step + 1} of {findings.length}</span>
              </>
            )}
            <button className="cpanel__close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {/* Body */}
        <div className="cpanel__body">
          {phase === 'loading' && (
            <div className="cpanel__state-msg">Checking consistency…</div>
          )}

          {phase === 'error' && (
            <div className="cpanel__state-msg cpanel__state-msg--error">
              Failed to run check: {loadError}
            </div>
          )}

          {phase === 'no-findings' && (
            <div className="cpanel__state-msg cpanel__state-msg--ok">
              No contradictions found.
            </div>
          )}

          {phase === 'done' && (
            <div className="cpanel__state-msg cpanel__state-msg--ok">
              All findings reviewed.
            </div>
          )}

          {phase === 'review' && current && (
            <>
              {/* "Earlier, you noted" block */}
              {currentFork?.why && (
                <div className="cpanel__noted-block">
                  <div className="cpanel__noted-label">Earlier, you noted</div>
                  <div className="cpanel__noted-text">{currentFork.why}</div>
                </div>
              )}

              {/* Question */}
              <p className="cpanel__question">{current.question}</p>

              {/* Action buttons */}
              <div className="cpanel__verdicts">
                <button
                  className={`cpanel__verdict-btn${verdict === 'intentional' ? ' cpanel__verdict-btn--selected' : ''}`}
                  onClick={() => setVerdict('intentional')}
                  disabled={saving}
                >
                  Intentional
                </button>
                <button
                  className={`cpanel__verdict-btn${verdict === 'flagged' ? ' cpanel__verdict-btn--selected' : ''}`}
                  onClick={() => setVerdict('flagged')}
                  disabled={saving}
                >
                  Flag it
                </button>
              </div>

              {/* Optional note */}
              <textarea
                className="cpanel__note"
                placeholder="Add an optional note…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                disabled={saving}
              />

              {saveError && <p className="cpanel__save-error">{saveError}</p>}
            </>
          )}
        </div>

        {/* Footer */}
        {(phase === 'review' || phase === 'no-findings' || phase === 'done' || phase === 'error') && (
          <div className="cpanel__footer">
            {phase === 'review' ? (
              <>
                <button className="cpanel__skip-btn" onClick={handleSkipAll} disabled={saving}>
                  Skip all
                </button>
                <button
                  className="cpanel__next-btn"
                  onClick={() => verdict ? handleAnswer(verdict) : null}
                  disabled={saving || !verdict}
                >
                  {saving ? 'Saving…' : step + 1 >= findings.length ? 'Finish →' : 'Next →'}
                </button>
              </>
            ) : (
              <button className="cpanel__next-btn" onClick={onClose}>Close</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
