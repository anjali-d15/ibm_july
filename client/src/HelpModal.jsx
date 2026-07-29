import { useEffect } from 'react';
import './HelpModal.css';

const FEATURES = [
  {
    icon: '✦',
    title: 'Dynamic AI Rewrites',
    body: 'Highlight any passage and Throughline\'s Narrative Architect (IBM Granite) analyses character motivations, dramatic stakes, and plot causality — then proposes a meaningful alternative. Use context-aware chips or write your own direction.',
  },
  {
    icon: '🌳',
    title: 'Dual Decision Tree',
    body: 'Every approved alternative becomes a branch in your story\'s decision tree. Switch between the Visual Tree (interactive SVG diagram) and Detailed List (side-by-side diff cards with rationale) at any time.',
  },
  {
    icon: '📚',
    title: 'Multi-Document Workspace',
    body: 'Your workspace starts with three genre starter manuscripts. Use the title dropdown in the header to switch, rename, create, or delete manuscripts. Each account\'s data is fully private.',
  },
  {
    icon: '⊞',
    title: 'Author Focus Mode',
    body: 'Click the Focus button in the header (or press Esc to exit) to enter a distraction-free full-screen writing mode. The sidebar and view tabs hide, leaving only your manuscript.',
  },
  {
    icon: '↓',
    title: 'Multi-Format Export',
    body: 'Export your resolved manuscript as Markdown (.md), plain text (.txt), or a Word-compatible document (.docx / .doc). Drafting markup and branch annotations are stripped automatically.',
  },
  {
    icon: '⚡',
    title: 'Live Telemetry',
    body: 'The header badge shows the active Granite model, real backend latency for the last AI call, and the HTTP status. A 429 badge means you\'ve hit the rate limit — it resets after 60 seconds.',
  },
];

/**
 * HelpModal — onboarding / feature guide modal.
 *
 * Props:
 *   onClose()
 */
export default function HelpModal({ onClose }) {
  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="help-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="How to use Throughline"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="help-modal">
        <div className="help-modal__header">
          <h2 className="help-modal__title">How to use Throughline</h2>
          <button className="help-modal__close" onClick={onClose} aria-label="Close help">✕</button>
        </div>

        <div className="help-modal__grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="help-feature">
              <span className="help-feature__icon" aria-hidden="true">{f.icon}</span>
              <div>
                <h3 className="help-feature__title">{f.title}</h3>
                <p className="help-feature__body">{f.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="help-modal__footer">
          <button className="btn btn--primary" onClick={onClose}>Got it — start writing</button>
        </div>
      </div>
    </div>
  );
}
