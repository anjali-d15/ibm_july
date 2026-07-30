import { useEffect, useRef, useState, useCallback } from 'react';
import './SelectionToolbar.css';

/**
 * SelectionToolbar — floating mini-toolbar that appears above highlighted text.
 *
 * Behaviour:
 *   1. On mount, shows static context-aware chips immediately (zero latency).
 *   2. Simultaneously fires POST /suggest-chips to get 3 Granite-powered chips.
 *   3. On success, replaces static chips with the AI chips (labelled "AI").
 *   4. While loading, displays a subtle pulse animation on the chip area.
 *   5. On failure, silently keeps the static chips — no error shown.
 *
 * Props:
 *   rect        DOMRect-like  { top, left, right, bottom, width }  — viewport coords
 *   selectedText string       — the highlighted passage
 *   onAction(instruction: string)  — called when a quick-action chip is clicked
 */

// ---------------------------------------------------------------------------
// Static chip builders (zero-latency fallback)
// ---------------------------------------------------------------------------

const COMMON_NON_NAMES = new Set([
  'The', 'A', 'An', 'In', 'On', 'At', 'To', 'By', 'Of', 'Or', 'And', 'But',
  'He', 'She', 'It', 'We', 'You', 'They', 'His', 'Her', 'Its', 'Our', 'Their',
  'This', 'That', 'These', 'Those', 'With', 'From', 'Into', 'Over', 'Under',
  'When', 'Where', 'While', 'After', 'Before', 'Then', 'There',
]);

function detectCharacterName(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/(?:[\s,;])([A-Z][a-z]{2,})\b/g)];
  for (const m of matches) {
    if (!COMMON_NON_NAMES.has(m[1])) return m[1];
  }
  const allCaps = [...text.matchAll(/\b([A-Z][a-z]{2,})\b/g)];
  for (const m of allCaps) {
    if (!COMMON_NON_NAMES.has(m[1])) return m[1];
  }
  return null;
}

function hasConflict(text) {
  return /\b(refused?|argued?|confronted?|denied?|anger|fear|tension|threat|demanded?|insisted?|struggle|fight|conflict)\b/i.test(text);
}

function hasDialogue(text) {
  return /["""'''‛‟]/.test(text);
}

/**
 * Build static context-sensitive quick actions synchronously from the selected text.
 * These appear immediately while the async AI chips load.
 */
function buildStaticActions(selectedText) {
  const charName = detectCharacterName(selectedText);
  const conflict = hasConflict(selectedText);
  const dialogue = hasDialogue(selectedText);
  const actions = [];

  if (charName) {
    actions.push({
      id: 'char-refuses',
      label: 'Explore alternative action',
      instruction: `Rewrite so ${charName} refuses or makes the opposite decision, exploring what changes as a result`,
    });
    actions.push({
      id: 'char-fate',
      label: 'Alternate character outcome',
      instruction: `Write an alternate fate or outcome for ${charName} that changes the trajectory of the narrative`,
    });
  }

  if (conflict) {
    actions.push({
      id: 'escalate-conflict',
      label: 'Escalate the tension',
      instruction: 'escalates the internal conflict and emotional stakes dramatically, making the tension feel unresolvable',
    });
  }

  actions.push({
    id: 'consequence',
    label: 'Introduce a conflict',
    instruction: 'introduces an unexpected, irreversible consequence that shifts the plot in a new direction',
  });

  actions.push({
    id: 'darker',
    label: 'Darker outcome',
    instruction: 'rewrites toward a darker, more dramatic outcome with higher emotional cost',
  });

  if (dialogue) {
    actions.push({
      id: 'subtext',
      label: 'Add subtext',
      instruction: 'rewrites the dialogue with dense subtext so characters say one thing but mean another',
    });
  }

  actions.push({
    id: 'twist',
    label: 'Add a plot twist',
    instruction: 'introduces an unexpected plot twist that subverts expectations and changes the direction of events',
  });

  return actions.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SelectionToolbar({ rect, selectedText, onAction }) {
  const toolbarRef = useRef(null);
  const [visible, setVisible] = useState(false);

  // 'static'    — showing synchronous chips
  // 'loading'   — AI fetch in-flight (static chips shown with loading indicator)
  // 'ai'        — showing AI-generated chips
  // 'error'     — AI fetch failed; static chips remain
  const [chipState, setChipState] = useState('static');
  const [aiChips, setAiChips]     = useState(null);

  // Animate in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Fire async chip generation whenever selectedText changes
  const fetchAiChips = useCallback(async (text) => {
    if (!text || text.trim().length < 20) return; // too short to generate useful chips
    setChipState('loading');
    try {
      const res = await fetch('/suggest-chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selected_text: text.slice(0, 2000) }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const chips = (data.chips ?? []).slice(0, 3);
      if (chips.length > 0) {
        setAiChips(chips);
        setChipState('ai');
      } else {
        setChipState('error');
      }
    } catch {
      setChipState('error'); // silently fall back to static chips
    }
  }, []);

  useEffect(() => {
    fetchAiChips(selectedText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedText]);

  if (!rect) return null;

  // Decide which chips to render
  const staticActions = buildStaticActions(selectedText || '');
  const displayChips = chipState === 'ai' && aiChips
    ? aiChips.map((c, i) => ({ id: `ai-${i}`, label: c.label, instruction: c.instruction, isAi: true }))
    : staticActions;

  const isLoading = chipState === 'loading';

  // Compute toolbar width dynamically
  const TOOLBAR_WIDTH = Math.min(480, 80 + displayChips.length * 110 + (isLoading ? 32 : 0));
  const GAP = 10;

  let left = rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - TOOLBAR_WIDTH - 8));
  const top = rect.top + window.scrollY - GAP;

  const style = {
    left: `${Math.round(left)}px`,
    top:  `${Math.round(top)}px`,
    minWidth: `${TOOLBAR_WIDTH}px`,
  };

  return (
    <div
      ref={toolbarRef}
      className={`sel-toolbar${visible ? ' sel-toolbar--visible' : ''}${isLoading ? ' sel-toolbar--loading' : ''}`}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="Quick AI actions"
    >
      {displayChips.map((action) => (
        <button
          key={action.id}
          className={`sel-toolbar__btn${action.isAi ? ' sel-toolbar__btn--ai' : ''}`}
          onClick={() => onAction(action.instruction)}
          title={action.label}
        >
          {action.isAi && <span className="sel-toolbar__ai-badge" aria-hidden="true">AI</span>}
          <span className="sel-toolbar__label">{action.label}</span>
        </button>
      ))}

      {isLoading && (
        <span className="sel-toolbar__loading" aria-label="Generating suggestions…" title="Generating AI suggestions…">
          <span className="sel-toolbar__spinner" aria-hidden="true" />
        </span>
      )}
    </div>
  );
}
