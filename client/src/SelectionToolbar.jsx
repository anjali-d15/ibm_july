import { useEffect, useRef, useState } from 'react';
import './SelectionToolbar.css';

/**
 * SelectionToolbar — floating mini-toolbar that appears above highlighted text.
 *
 * Positioned using the viewport-relative bounding rect of the native selection.
 * Context-aware: parses the selected text for character names, actions, and conflicts
 * to generate dynamic suggestion chips (e.g., "What if [Character] refuses?").
 *
 * Props:
 *   rect        DOMRect-like  { top, left, right, bottom, width }  — viewport coords
 *   selectedText string       — the highlighted passage
 *   onAction(instruction: string)  — called when a quick-action is clicked
 */

/**
 * Detect a likely character name — a capitalized word that is NOT a sentence start.
 * Returns the first match, or null.
 */
function detectCharacterName(text) {
  if (!text) return null;
  // Look for a capitalized word that follows a space or comma (not sentence start)
  const matches = text.match(/(?:[\s,;]\b)([A-Z][a-z]{2,})\b/g);
  if (matches && matches.length > 0) {
    return matches[0].trim().replace(/^[,;]\s*/, '');
  }
  // Fallback: any capitalized word not at sentence start
  const fallback = text.match(/\b([A-Z][a-z]{2,})\b/);
  return fallback ? fallback[1] : null;
}

/** Returns true if the text contains conflict indicators */
function hasConflict(text) {
  return /\b(refused?|argued?|confronted?|denied?|anger|fear|tension|threat|demanded?|insisted?|struggle|fight|conflict)\b/i.test(text);
}

/** Returns true if text has dialogue */
function hasDialogue(text) {
  return /["""'''‛‟]/.test(text);
}

/** Build context-sensitive quick actions from the selected text */
function buildContextActions(selectedText) {
  const charName = detectCharacterName(selectedText);
  const conflict = hasConflict(selectedText);
  const dialogue = hasDialogue(selectedText);

  const actions = [];

  // Character-specific action if name detected
  if (charName) {
    actions.push({
      id: 'char-refuses',
      icon: '↩',
      label: `What if ${charName} refuses?`,
      instruction: `Rewrite so ${charName} refuses or makes the opposite decision, exploring what changes as a result`,
    });
    actions.push({
      id: 'char-fate',
      icon: '⚖',
      label: `Alternate fate for ${charName}`,
      instruction: `Write an alternate fate or outcome for ${charName} that changes the trajectory of the narrative`,
    });
  }

  // Conflict escalation
  if (conflict) {
    actions.push({
      id: 'escalate-conflict',
      icon: '↑',
      label: 'Escalate internal conflict',
      instruction: 'escalates the internal conflict and emotional stakes dramatically, making the tension feel unresolvable',
    });
  }

  // Unexpected consequence
  actions.push({
    id: 'consequence',
    icon: '⚡',
    label: 'Introduce unexpected consequence',
    instruction: 'introduces an unexpected, irreversible consequence that shifts the plot in a new direction',
  });

  // Darker outcome
  actions.push({
    id: 'darker',
    icon: '◆',
    label: 'Darker dramatic outcome',
    instruction: 'rewrites toward a darker, more dramatic outcome with higher emotional cost',
  });

  // Dialogue-specific twist
  if (dialogue) {
    actions.push({
      id: 'subtext',
      icon: '≈',
      label: 'Subtext & hidden meaning',
      instruction: 'rewrites the dialogue with dense subtext so characters say one thing but mean another',
    });
  }

  // Plot twist
  actions.push({
    id: 'twist',
    icon: '◎',
    label: 'Add plot twist',
    instruction: 'introduces an unexpected plot twist that subverts expectations and changes the direction of events',
  });

  // Return at most 4 actions to keep toolbar compact
  return actions.slice(0, 4);
}

export default function SelectionToolbar({ rect, selectedText, onAction }) {
  const toolbarRef = useRef(null);
  const [visible, setVisible] = useState(false);

  // Animate in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!rect) return null;

  const contextActions = buildContextActions(selectedText || '');

  // Compute toolbar width dynamically — 4 buttons ≈ 380px
  const TOOLBAR_WIDTH = Math.min(420, 80 + contextActions.length * 100);
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
      className={`sel-toolbar${visible ? ' sel-toolbar--visible' : ''}`}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="Quick AI actions"
    >
      {contextActions.map((action) => (
        <button
          key={action.id}
          className="sel-toolbar__btn"
          onClick={() => onAction(action.instruction)}
          title={action.label}
        >
          <span className="sel-toolbar__icon" aria-hidden="true">{action.icon}</span>
          <span className="sel-toolbar__label">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
