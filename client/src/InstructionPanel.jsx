import { useState, useRef } from 'react';
import './InstructionPanel.css';

const PRESETS = [
  { label: 'Warmer', value: 'feels warmer and more emotionally open' },
  { label: 'Colder', value: 'feels colder, more distant, and restrained' },
  { label: 'More concise', value: 'is more concise without losing meaning' },
  { label: 'Surprise me', value: 'takes an unexpected creative direction while staying coherent' },
];

/**
 * InstructionPanel — shown when the user has a valid selection and clicks
 * "Show alternative". Lets the user optionally type an instruction or pick
 * a preset, then submits to POST /document/:id/generate-alternative.
 *
 * Props:
 *   docId          string
 *   selection      { segment_fork_id, anchor_start, anchor_end, selected_text }
 *   onSubmit(fork) called with the returned fork row on success
 *   onCancel()     called when user dismisses without generating
 */
export default function InstructionPanel({ docId, selection, onSubmit, onCancel }) {
  const [instruction, setInstruction] = useState('');
  const [activePreset, setActivePreset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  function pickPreset(preset) {
    setActivePreset(preset.label);
    setInstruction(preset.value);
    if (inputRef.current) inputRef.current.focus();
  }

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const body = {
        segment_fork_id: selection.segment_fork_id,
        anchor_start: selection.anchor_start,
        anchor_end: selection.anchor_end,
        selected_text: selection.selected_text,
      };
      const trimmed = instruction.trim();
      if (trimmed) body.instruction = trimmed;

      const res = await fetch(`/document/${docId}/generate-alternative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // send session cookie
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      onSubmit(data.fork);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="instruction-panel">
      <div className="instruction-panel__selected">
        <span className="instruction-panel__label">Selected text</span>
        <blockquote className="instruction-panel__quote">
          {selection.selected_text}
        </blockquote>
      </div>

      <div className="instruction-panel__presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`preset-chip${activePreset === p.label ? ' preset-chip--active' : ''}`}
            onClick={() => pickPreset(p)}
            disabled={loading}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="instruction-panel__input-row">
        <input
          ref={inputRef}
          className="instruction-panel__input"
          type="text"
          placeholder="Or type your own instruction (optional)"
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value);
            setActivePreset(null);
          }}
          disabled={loading}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading) handleGenerate(); }}
        />
      </div>

      {error && <p className="instruction-panel__error">{error}</p>}

      <div className="instruction-panel__actions">
        <button className="btn btn--ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={handleGenerate} disabled={loading}>
          {loading ? 'Generating…' : 'Generate alternative'}
        </button>
      </div>
    </div>
  );
}
