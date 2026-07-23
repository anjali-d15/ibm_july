import { useEffect, useState, useRef } from 'react';
import Editor from './Editor.jsx';
import InstructionPanel from './InstructionPanel.jsx';
import ReviewPanel from './ReviewPanel.jsx';
import WhyPanel from './WhyPanel.jsx';
import TreeView from './TreeView.jsx';
import './App.css';

const DOC_ID = 'doc_hardcoded_001';

/**
 * UI phases:
 *   'editing'     — normal editor, user can select and click "Show alternative"
 *   'instruction' — InstructionPanel visible, editor still readable
 *   'reviewing'   — ReviewPanel visible, editor locked (fork is proposed)
 *
 * Views:
 *   'editor' — the Tiptap editor (default)
 *   'tree'   — the decision-tree view
 */

export default function App() {
  const [loadError, setLoadError]     = useState(null);
  const [segments, setSegments]       = useState(null);       // from /resolved
  const [uiPhase, setUiPhase]         = useState('editing');  // 'editing' | 'instruction' | 'reviewing'
  const [activeView, setActiveView]   = useState('editor');   // 'editor' | 'tree'
  const [selection, setSelection]     = useState(null);       // current text selection info
  const [pendingFork, setPendingFork] = useState(null);       // fork row while reviewing
  const [whySuggestion, setWhySuggestion] = useState(null);  // { forkId, why } after approve

  const editorRef = useRef(null); // exposes flushSave(), setContent()

  // Derive initial content from segments (used only for first mount)
  const initialContent = segments ? segments.map((s) => s.text).join('') : null;

  // -------------------------------------------------------------------------
  // Load document
  // -------------------------------------------------------------------------
  useEffect(() => {
    fetch(`/document/${DOC_ID}/resolved`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(({ segments }) => setSegments(segments))
      .catch((err) => setLoadError(err.message));
  }, []);

  // Re-fetch segments and push new content into the live editor
  async function refreshSegments() {
    const r = await fetch(`/document/${DOC_ID}/resolved`);
    if (!r.ok) return;
    const { segments: newSegments } = await r.json();
    setSegments(newSegments);
    // Push the resolved text into the editor so it reflects the new active path
    if (editorRef.current) {
      const text = newSegments.map((s) => s.text).join('');
      editorRef.current.setContent(text);
    }
  }

  // -------------------------------------------------------------------------
  // Fork flow
  // -------------------------------------------------------------------------

  /** Step 1: user clicks "Show alternative" button */
  async function handleShowAlternative() {
    if (editorRef.current) await editorRef.current.flushSave();
    setUiPhase('instruction');
  }

  /** Step 2: InstructionPanel calls this after Granite responds */
  function handleForkGenerated(fork) {
    setPendingFork(fork);
    setUiPhase('reviewing');
    refreshSegments();
  }

  /** Step 3a: Approve */
  async function handleApprove(forkId) {
    const res = await fetch(`/fork/${forkId}/approve`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      console.error('[approve] failed:', error);
      return;
    }

    // Unlock the editor immediately — don't wait on why generation
    await refreshSegments();
    setUiPhase('editing');
    setPendingFork(null);
    setSelection(null);

    // Fire why generation in the background — non-blocking
    fetch(`/fork/${forkId}/why`, { method: 'POST', credentials: 'include' })
      .then((r) => r.json())
      .then(({ fork }) => {
        if (fork?.why) setWhySuggestion({ forkId, why: fork.why });
      })
      .catch((err) => console.warn('[why] async generation failed:', err.message));
  }

  /** Step 3b: Reject */
  async function handleReject(forkId) {
    const res = await fetch(`/fork/${forkId}/reject`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      console.error('[reject] failed:', error);
      return;
    }

    await refreshSegments();
    setUiPhase('editing');
    setPendingFork(null);
    setSelection(null);
  }

  function handleCancelInstruction() {
    setUiPhase('editing');
    setSelection(null);
  }

  /**
   * handleBranchSwitch — called by TreeView after a successful /fork/:id/switch.
   * Re-fetches /resolved so the editor content updates to the new active path.
   */
  async function handleBranchSwitch() {
    await refreshSegments();
    // Switch back to editor so the writer sees the effect immediately
    setActiveView('editor');
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (loadError) {
    return (
      <div style={{ padding: '2rem', color: '#c0392b' }}>
        <strong>Failed to load document:</strong> {loadError}
      </div>
    );
  }

  if (!segments) {
    return <div style={{ padding: '2rem', color: '#57606a' }}>Loading…</div>;
  }

  const isLocked = uiPhase === 'reviewing';
  const hasValidSelection = selection && !selection.crossSegment && selection.selected_text;

  return (
    <div className="app">
      {/* ------------------------------------------------------------------ */}
      {/* View toggle — top-right corner tab pair                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="app__view-toggle" role="tablist" aria-label="Switch view">
        <button
          role="tab"
          aria-selected={activeView === 'editor'}
          className={`view-tab${activeView === 'editor' ? ' view-tab--active' : ''}`}
          onClick={() => setActiveView('editor')}
        >
          Editor
        </button>
        <button
          role="tab"
          aria-selected={activeView === 'tree'}
          className={`view-tab${activeView === 'tree' ? ' view-tab--active' : ''}`}
          onClick={() => setActiveView('tree')}
          disabled={isLocked}
          title={isLocked ? 'Tree unavailable while a fork is pending' : undefined}
        >
          Decision tree
        </button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* EDITOR VIEW                                                         */}
      {/* ------------------------------------------------------------------ */}
      {activeView === 'editor' && (
        <>
          {/* Instruction panel — shown above editor before generation */}
          {uiPhase === 'instruction' && (
            <div className="app__overlay-panel">
              <InstructionPanel
                docId={DOC_ID}
                selection={selection}
                onSubmit={handleForkGenerated}
                onCancel={handleCancelInstruction}
              />
            </div>
          )}

          {/* Review panel — shown while fork is proposed */}
          {uiPhase === 'reviewing' && pendingFork && (
            <div className="app__overlay-panel">
              <ReviewPanel
                fork={pendingFork}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            </div>
          )}

          <Editor
            ref={editorRef}
            docId={DOC_ID}
            initialContent={initialContent}
            segments={segments}
            locked={isLocked}
            onSelectionChange={setSelection}
          />

          {/* Why suggestion panel — non-blocking, appears after approve */}
          {whySuggestion && (
            <WhyPanel
              forkId={whySuggestion.forkId}
              why={whySuggestion.why}
              onDismiss={() => setWhySuggestion(null)}
            />
          )}

          {/* Floating "Show alternative" button */}
          {uiPhase === 'editing' && hasValidSelection && (
            <div className="app__fork-bar">
              <button className="fork-bar__btn" onClick={handleShowAlternative}>
                Show alternative
              </button>
            </div>
          )}

          {/* Cross-segment warning */}
          {uiPhase === 'editing' && selection?.crossSegment && (
            <div className="app__fork-bar">
              <span className="fork-bar__warn">
                Selection spans multiple segments — please select within one section
              </span>
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* TREE VIEW                                                           */}
      {/* ------------------------------------------------------------------ */}
      {activeView === 'tree' && (
        <TreeView
          docId={DOC_ID}
          onSwitch={handleBranchSwitch}
        />
      )}
    </div>
  );
}
