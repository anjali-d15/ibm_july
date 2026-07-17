import { useState } from 'react';
import './WhyPanel.css';

/**
 * WhyPanel — appears after an approve completes, showing the AI-drafted
 * rationale for the decision. Non-blocking: the editor is already unlocked
 * and fully usable while this panel is visible.
 *
 * States:
 *   viewing — shows the AI-drafted why with Confirm / Edit buttons
 *   editing — free-form textarea; Save persists via POST /fork/:id/why
 *   saving  — in-flight save
 *   done    — saved; panel stays visible until explicit dismiss
 *
 * Props:
 *   forkId    string
 *   why       string  — the AI-drafted text
 *   onDismiss()
 */
export default function WhyPanel({ forkId, why, onDismiss }) {
  const [mode, setMode]     = useState('viewing'); // 'viewing' | 'editing' | 'saving' | 'done'
  const [draft, setDraft]   = useState(why);
  const [saveErr, setSaveErr] = useState(null);

  async function handleSave() {
    setMode('saving');
    setSaveErr(null);
    try {
      const res = await fetch(`/fork/${forkId}/why`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ why: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      setMode('done');
    } catch (err) {
      setSaveErr(err.message);
      setMode('editing');
    }
  }

  return (
    <div className="why-panel">
      <div className="why-panel__header">
        <span className="why-panel__label">Why this change?</span>
        <button className="why-panel__close" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>

      {mode === 'viewing' && (
        <>
          <p className="why-panel__text">{why}</p>
          <div className="why-panel__actions">
            <button className="btn btn--ghost" onClick={() => { setDraft(why); setMode('editing'); }}>
              Edit
            </button>
            <button className="btn btn--primary" onClick={onDismiss}>
              Confirm
            </button>
          </div>
        </>
      )}

      {(mode === 'editing' || mode === 'saving') && (
        <>
          <textarea
            className="why-panel__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            rows={4}
            disabled={mode === 'saving'}
          />
          {saveErr && <p className="why-panel__error">{saveErr}</p>}
          <div className="why-panel__actions">
            <button className="btn btn--ghost" onClick={() => setMode('viewing')} disabled={mode === 'saving'}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={handleSave} disabled={mode === 'saving'}>
              {mode === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {mode === 'done' && (
        <>
          <p className="why-panel__text">{draft}</p>
          <p className="why-panel__saved">Saved ✓</p>
          <div className="why-panel__actions">
            <button className="btn btn--primary" onClick={onDismiss}>Done</button>
          </div>
        </>
      )}
    </div>
  );
}
