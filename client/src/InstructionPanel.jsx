import { useState, useRef, useEffect } from 'react';
import './InstructionPanel.css';

// ---------------------------------------------------------------------------
// Chip definitions — split by tab and dialogue vs. narrative context
// ---------------------------------------------------------------------------

const CHIPS = {
  'Plot & Action': {
    dialogue: [
      { label: 'Subtext in Dialogue',   value: 'rewrites the dialogue so characters speak around the real issue, never saying it directly' },
      { label: 'More Confrontational',  value: 'makes the dialogue more confrontational, raising the emotional stakes between characters' },
      { label: 'Internal Monologue',    value: 'replaces spoken dialogue with the character\'s unspoken internal thoughts and feelings' },
    ],
    narrative: [
      { label: 'Heighten Suspense',     value: 'heightens the suspense and tension, making the reader dread what comes next' },
      { label: 'Add Plot Twist',        value: 'introduces an unexpected plot twist that changes the direction of events' },
      { label: 'Raise the Stakes',      value: 'raises the stakes significantly so the consequences feel more urgent and irreversible' },
    ],
  },
  'Tone & Style': {
    dialogue: [
      { label: 'Warmer',                value: 'feels warmer and more emotionally open between the characters' },
      { label: 'Colder / Darker',       value: 'feels colder, more distant, and emotionally withholding' },
      { label: 'Sharper Wit',           value: 'adds sharp, dry wit to the exchange while keeping it in character' },
    ],
    narrative: [
      { label: 'More Sensory Detail',   value: 'adds rich sensory detail — sight, sound, smell, touch — to ground the reader in the scene' },
      { label: 'Faster Pacing',         value: 'tightens the pacing with shorter sentences and less description, creating urgency' },
      { label: 'Lyrical / Poetic',      value: 'rewrites with a lyrical, poetic voice — more imagery and rhythm' },
    ],
  },
};

const TABS = ['Plot & Action', 'Tone & Style'];

/** True if the passage contains any opening quotation mark (straight or curly). */
function hasDialogue(text) {
  return /["""'''‛‟]/.test(text);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * InstructionPanel — shown when the user has a valid selection and clicks
 * "Show alternative". Lets the user type a custom instruction or pick a
 * context-aware chip, then submits to POST /document/:id/generate-alternative.
 *
 * Props:
 *   docId               string
 *   selection           { segment_fork_id, anchor_start, anchor_end, selected_text }
 *   initialInstruction  string | null — pre-fills the input and auto-fires on mount
 *   onSubmit(fork)      called with the returned fork row on success
 *   onCancel()          called when user dismisses without generating
 */
export default function InstructionPanel({ docId, selection, initialInstruction, onSubmit, onCancel }) {
  const isDialogue = hasDialogue(selection.selected_text);

  const [activeTab, setActiveTab]       = useState('Plot & Action');
  const [instruction, setInstruction]   = useState(initialInstruction ?? '');
  const [activeChip, setActiveChip]     = useState(null);  // chip label string | null
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState(null);
  const inputRef = useRef(null);

  // Auto-fire when a quick instruction arrives from the SelectionToolbar.
  // useRef guards against React 18 StrictMode double-invoke in dev.
  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (initialInstruction && !autoFiredRef.current) {
      autoFiredRef.current = true;
      handleGenerate(initialInstruction);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // intentionally empty — once on mount only

  // Chips visible for the current tab + text type
  const visibleChips = CHIPS[activeTab][isDialogue ? 'dialogue' : 'narrative'];

  /**
   * pickChip — fills the instruction input with this chip's value AND
   * immediately triggers generation (Quick-Submit behaviour).
   */
  function pickChip(chip) {
    setActiveChip(chip.label);
    setInstruction(chip.value);
    handleGenerate(chip.value);
  }

  // Accept an optional override so callers can bypass stale useState reads.
  async function handleGenerate(instructionOverride) {
    if (loading) return; // double-click guard
    setLoading(true);
    setError(null);
    try {
      const body = {
        segment_fork_id: selection.segment_fork_id,
        anchor_start:    selection.anchor_start,
        anchor_end:      selection.anchor_end,
        selected_text:   selection.selected_text,
      };
      const trimmed = (instructionOverride ?? instruction).trim();
      if (trimmed) body.instruction = trimmed;

      const res = await fetch(`/document/${docId}/generate-alternative`, {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:        JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        // Surface 429 / 500 errors clearly
        const msg = data.error || `Error ${res.status}`;
        setError(msg);
        setLoading(false);
        return;
      }
      // Pass latency + status back to App for the telemetry badge
      onSubmit(data.fork, data.latencyMs, res.status);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="instruction-panel">
      {/* Selected text preview — always visible */}
      <div className="instruction-panel__selected">
        <span className="instruction-panel__label">
          Selected text
          {isDialogue && (
            <span className="instruction-panel__context-tag">dialogue</span>
          )}
        </span>
        <blockquote className="instruction-panel__quote">
          {selection.selected_text}
        </blockquote>
      </div>

      {/* ── Shimmer skeleton shown while Granite call is in-flight ── */}
      {loading ? (
        <div className="ip-shimmer" aria-busy="true" aria-label="Generating alternative…">
          <div className="ip-shimmer__bar ip-shimmer__bar--75" />
          <div className="ip-shimmer__bar ip-shimmer__bar--83" />
          <div className="ip-shimmer__bar ip-shimmer__bar--67" />
        </div>
      ) : (
        <>
          {/* Tab toggle: Plot & Action | Tone & Style */}
          <div className="instruction-panel__tabs" role="tablist" aria-label="Filter chips by category">
            {TABS.map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={`ip-tab${activeTab === tab ? ' ip-tab--active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Dynamic chips */}
          <div className="instruction-panel__presets" role="group" aria-label={`${activeTab} chips`}>
            {visibleChips.map((chip) => (
              <button
                key={chip.label}
                className={`preset-chip${activeChip === chip.label ? ' preset-chip--active' : ''}`}
                onClick={() => pickChip(chip)}
                title={chip.value}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Free-form input + Generate button — hidden while shimmer is showing */}
      {!loading && (
        <div className="instruction-panel__input-row">
          <input
            ref={inputRef}
            className="instruction-panel__input"
            type="text"
            placeholder="Or type your own instruction (optional)"
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              setActiveChip(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
                e.preventDefault();
                handleGenerate(undefined);
              }
            }}
          />
        </div>
      )}

      {error && <p className="instruction-panel__error">{error}</p>}

      <div className="instruction-panel__actions">
        <button className="btn btn--ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        {!loading && (
          <button
            className="btn btn--primary"
            onClick={() => handleGenerate(undefined)}
            disabled={loading}
            title="Cmd+Enter"
          >
            Generate alternative
          </button>
        )}
      </div>
    </div>
  );
}
