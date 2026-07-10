import { useEffect, useState, useRef } from 'react';
import Editor from './Editor.jsx';
import InstructionPanel from './InstructionPanel.jsx';
import ReviewPanel from './ReviewPanel.jsx';
import './App.css';

const DOC_ID = 'doc_hardcoded_001';

/**
 * UI phases:
 *   'editing'     — normal editor, user can select and click "Show alternative"
 *   'instruction' — InstructionPanel visible, editor still readable
 *   'reviewing'   — ReviewPanel visible, editor locked (fork is proposed)
 */

export default function App() {
  const [loadError, setLoadError] = useState(null);
  const [segments, setSegments] = useState(null);        // from /resolved
  const [uiPhase, setUiPhase] = useState('editing');     // 'editing' | 'instruction' | 'reviewing'
  const [selection, setSelection] = useState(null);      // current text selection info
  const [pendingFork, setPendingFork] = useState(null);  // fork row while reviewing

  const editorRef = useRef(null); // exposes flushSave()

  // Derive initial content from segments
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

  // Re-fetch segments after any mutation
  async function refreshSegments() {
    const r = await fetch(`/document/${DOC_ID}/resolved`);
    const { segments } = await r.json();
    setSegments(segments);
  }

  // -------------------------------------------------------------------------
  // Fork flow
  // -------------------------------------------------------------------------

  /** Step 1: user clicks "Show alternative" button */
  async function handleShowAlternative() {
    // Flush any pending autosave before starting a fork op
    if (editorRef.current) await editorRef.current.flushSave();
    setUiPhase('instruction');
  }

  /** Step 2: InstructionPanel calls this after Granite responds */
  function handleForkGenerated(fork) {
    setPendingFork(fork);
    setUiPhase('reviewing');
    // Re-fetch segments so the editor reflects the lock state (no visible change
    // yet since fork is proposed/not-active, but good practice)
    refreshSegments();
  }

  /** Step 3a: Approve — P3 will implement; for now just dismiss */
  function handleApprove(forkId) {
    // TODO P3: POST /fork/:id/approve, then refreshSegments + setUiPhase('editing')
    console.log('approve', forkId, '— P3');
  }

  /** Step 3b: Reject — P3 will implement */
  function handleReject(forkId) {
    // TODO P3: POST /fork/:id/reject, then refreshSegments + setUiPhase('editing')
    console.log('reject', forkId, '— P3');
  }

  function handleCancelInstruction() {
    setUiPhase('editing');
    setSelection(null);
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

      {/* Floating "Show alternative" button — visible in editing phase when
          the user has a valid single-segment selection */}
      {uiPhase === 'editing' && hasValidSelection && (
        <div className="app__fork-bar">
          <button className="fork-bar__btn" onClick={handleShowAlternative}>
            Show alternative
          </button>
          {selection.crossSegment && (
            <span className="fork-bar__warn">
              Selection spans multiple segments — please select within one section
            </span>
          )}
        </div>
      )}

      {/* Cross-segment warning when selection is invalid */}
      {uiPhase === 'editing' && selection?.crossSegment && (
        <div className="app__fork-bar">
          <span className="fork-bar__warn">
            Selection spans multiple segments — please select within one section
          </span>
        </div>
      )}
    </div>
  );
}
