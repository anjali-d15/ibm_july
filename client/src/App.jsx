import { useEffect, useState, useRef } from 'react';
import Editor from './Editor.jsx';
import InstructionPanel from './InstructionPanel.jsx';
import ReviewPanel from './ReviewPanel.jsx';
import WhyPanel from './WhyPanel.jsx';
import TreeView from './TreeView.jsx';
import ConsistencyPanel from './ConsistencyPanel.jsx';
import SelectionToolbar from './SelectionToolbar.jsx';
import Toast from './Toast.jsx';
import ManuscriptSidebar from './ManuscriptSidebar.jsx';
import EditorErrorBoundary from './EditorErrorBoundary.jsx';
import AuthModal from './AuthModal.jsx';
import DocumentSwitcher from './DocumentSwitcher.jsx';
import HelpModal from './HelpModal.jsx';
import './App.css';

const LEGACY_DOC_ID   = 'doc_hardcoded_001';
const TOUR_KEY        = 'throughline_seen_tour';

export default function App() {
  // ── Auth state ─────────────────────────────────────────────────────────────
  // Start as checked=true if no token — skip the /auth/me round-trip entirely
  const [authChecked, setAuthChecked]           = useState(false);
  const [currentUser, setCurrentUser]           = useState(null); // { id, username, is_guest }

  // ── Document state ─────────────────────────────────────────────────────────
  const [docId, setDocId]                       = useState(LEGACY_DOC_ID);
  const [docTitle, setDocTitle]                 = useState('My First Document');

  // ── Editor / fork state ────────────────────────────────────────────────────
  const [loadError, setLoadError]               = useState(null);
  const [segments, setSegments]                 = useState(null);
  const [uiPhase, setUiPhase]                   = useState('editing');
  const [activeView, setActiveView]             = useState('editor');
  const [selection, setSelection]               = useState(null);
  const [pendingFork, setPendingFork]           = useState(null);
  const [whySuggestion, setWhySuggestion]       = useState(null);
  const [globalError, setGlobalError]           = useState(null);
  const [showConsistency, setShowConsistency]   = useState(false);
  const [quickInstruction, setQuickInstruction] = useState(null);
  const [toast, setToast]                       = useState(null);

  // ── UI extras ──────────────────────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [focusMode, setFocusMode]               = useState(false);
  const [telemetry, setTelemetry]               = useState(null);
  const [isSubmitting, setIsSubmitting]         = useState(false);
  const [showHelp, setShowHelp]                 = useState(false);
  const [activeBranchId, setActiveBranchId]     = useState(null);

  const editorRef = useRef(null);

  const initialContent = segments ? segments.map((s) => s.text).join('') : null;
  const branchCount    = segments ? segments.filter((s) => s.fork_id != null).length : 0;

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
  // Only attempt to restore session if there's a stored auth hint. If not,
  // show the Auth Modal immediately — no spinner on cold load.
  useEffect(() => {
    const hasHint = !!localStorage.getItem('throughline_authed');
    if (!hasHint) {
      setAuthChecked(true); // no token → skip network call, show auth screen now
      return;
    }
    fetch('/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(({ user }) => { if (user) setCurrentUser(user); })
      .catch(() => {
        // Cookie expired / invalid — clear the hint so next load skips the call
        localStorage.removeItem('throughline_authed');
      })
      .finally(() => setAuthChecked(true));
  }, []);

  // Auto-show help tour on first visit (after auth)
  useEffect(() => {
    if (!currentUser) return;
    if (!localStorage.getItem(TOUR_KEY)) {
      setShowHelp(true);
      localStorage.setItem(TOUR_KEY, '1');
    }
  }, [currentUser]);

  // ── Load document ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!docId) return;
    setSegments(null);
    setLoadError(null);
    fetch(`/document/${docId}/resolved`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(({ segments }) => setSegments(segments))
      .catch((err) => setLoadError(err.message));

    // Fetch title too
    fetch(`/document/${docId}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((doc) => { if (doc?.title) setDocTitle(doc.title); })
      .catch(() => {});
  }, [docId]);

  async function refreshSegments() {
    const r = await fetch(`/document/${docId}/resolved`, { credentials: 'include' });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Failed to reload document (${r.status}): ${text}`);
    }
    const { segments: newSegments } = await r.json();
    setSegments(newSegments);
    if (editorRef.current) {
      const text = newSegments.map((s) => s.text).join('');
      editorRef.current.setContent(text);
    }
  }

  // ── Document switch ────────────────────────────────────────────────────────
  function handleSwitchDoc(newDocId) {
    setDocId(newDocId);
    setUiPhase('editing');
    setSelection(null);
    setPendingFork(null);
    setActiveView('editor');
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (focusMode) { setFocusMode(false); return; }
        if (showHelp)  { setShowHelp(false);  return; }
        if (uiPhase === 'instruction') { handleCancelInstruction(); return; }
      }
      if (isCmdOrCtrl && e.key === 'Enter') {
        if (uiPhase === 'editing' && selection && !selection.crossSegment && selection.selected_text) {
          e.preventDefault();
          handleShowAlternative();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode, showHelp, uiPhase, selection]);

  // ── Fork flow ──────────────────────────────────────────────────────────────
  async function handleShowAlternative() {
    if (isSubmitting) return;
    if (editorRef.current) await editorRef.current.flushSave();
    setQuickInstruction(null);
    setUiPhase('instruction');
  }

  async function handleQuickAction(instruction) {
    if (isSubmitting) return;
    if (editorRef.current) await editorRef.current.flushSave();
    setQuickInstruction(instruction);
    setUiPhase('instruction');
  }

  function handleForkGenerated(fork, latencyMs, httpStatus) {
    if (latencyMs != null) setTelemetry({ latencyMs, status: httpStatus ?? 200 });
    setQuickInstruction(null);
    setPendingFork(fork);
    setUiPhase('reviewing');
    refreshSegments().catch((err) => setGlobalError(err.message));
  }

  async function handleApprove(forkId) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/fork/${forkId}/approve`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || res.status >= 500) {
          setToast({ message: data.error || `Error ${res.status}`, type: 'error' });
        }
        throw new Error(data.error || `Approve failed (${res.status})`);
      }
      try { await refreshSegments(); } catch (err) { setGlobalError(err.message); }
      setUiPhase('editing');
      setPendingFork(null);
      setSelection(null);
      setToast({ message: 'Branch resolved! Rationale recorded in history.' });
      fetch(`/fork/${forkId}/why`, { method: 'POST', credentials: 'include' })
        .then((r) => r.json())
        .then(({ fork, latencyMs }) => {
          if (fork?.why) setWhySuggestion({ forkId, why: fork.why });
          if (latencyMs != null) setTelemetry((prev) => ({ ...prev, latencyMs }));
        })
        .catch((err) => console.warn('[why] async generation failed:', err.message));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReject(forkId) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/fork/${forkId}/reject`, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 || res.status >= 500) {
          setToast({ message: data.error || `Error ${res.status}`, type: 'error' });
        }
        throw new Error(data.error || `Reject failed (${res.status})`);
      }
      try { await refreshSegments(); } catch (err) { setGlobalError(err.message); }
      setUiPhase('editing');
      setPendingFork(null);
      setSelection(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCancelInstruction() {
    setUiPhase('editing');
    setSelection(null);
    setQuickInstruction(null);
  }

  async function handleBranchSwitch() {
    try { await refreshSegments(); } catch (err) { setGlobalError(err.message); }
    setActiveView('editor');
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    // Full state reset — clear persisted data so new session starts clean
    localStorage.clear();
    setCurrentUser(null);
    setDocId(LEGACY_DOC_ID);
    setDocTitle('My First Document');
    setSegments(null);
    setLoadError(null);
    setUiPhase('editing');
    setActiveView('editor');
    setSelection(null);
    setPendingFork(null);
    setWhySuggestion(null);
    setGlobalError(null);
    setShowConsistency(false);
    setQuickInstruction(null);
    setToast(null);
    setTelemetry(null);
    setIsSubmitting(false);
    setFocusMode(false);
    setSidebarCollapsed(false);
    // authChecked stays true — we want to immediately show auth screen, not flash spinner
  }

  // ── Render guards ──────────────────────────────────────────────────────────

  // Still checking session cookie
  if (!authChecked) {
    return <div style={{ padding: '3rem', color: '#57606a', textAlign: 'center' }}>Loading…</div>;
  }

  // Not logged in → show auth screen
  if (!currentUser) {
    return (
      <AuthModal
        onAuth={(user) => {
          localStorage.setItem('throughline_authed', '1');
          setCurrentUser(user);
        }}
      />
    );
  }

  const isLocked = uiPhase === 'reviewing';
  const hasValidSelection = selection && !selection.crossSegment && selection.selected_text;

  // Telemetry info for header badge
  const latencyMs   = telemetry?.latencyMs;
  const httpStatus  = telemetry?.status;

  // ── Shell wrapper — always rendered once auth passes ──────────
  // Header is mounted here so it persists across loadError / loading states.
  return (
    <div className={`app${sidebarCollapsed ? ' app--sidebar-collapsed' : ' app--sidebar-open'}`}>
      {/* Global error banner */}
      {globalError && (
        <div className="app__error-banner" role="alert">
          <span className="app__error-banner-msg">{globalError}</span>
          <button className="app__error-banner-close" onClick={() => setGlobalError(null)} aria-label="Dismiss error">✕</button>
        </div>
      )}

      {/* ── ROOT-LEVEL PERSISTENT HEADER ─────────────────────────── */}
      {!focusMode && (
        <header className="app-header">
          {/* LEFT: telemetry badge + focus button */}
          <div className="app-header__left">
            <div className="app-header__brand">
              <svg className="app-header__brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6 C6 6,7 10,10 10 C13 10,14 6,17 6 C20 6,21 10,21 10"
                  stroke="#5b5bd6" strokeWidth="1.8" strokeLinecap="round"/>
                <path d="M3 12 C5 12,8 8,12 12 C16 16,19 12,21 12"
                  stroke="#7c5cd8" strokeWidth="1.8" strokeLinecap="round"/>
                <path d="M3 18 C6 18,7 14,10 14 C13 14,14 18,17 18 C20 18,21 14,21 14"
                  stroke="#3b82d4" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              <span className="app-header__brand-name">Throughline</span>
            </div>
            <div className="app-header__telemetry" title="AI call telemetry — ibm/granite-3-8b-instruct">
              <span className="app-header__model truncate max-w-[140px]">ibm/granite-3-8b-instruct</span>
              {latencyMs != null && (
                <span className="app-header__latency">⚡ {latencyMs}ms</span>
              )}
              {httpStatus != null && (
                <span className={httpStatus === 429 ? 'app-header__http app-header__http--limited' : 'app-header__http app-header__http--ok'}>
                  {httpStatus === 429 ? '429 Limited' : `${httpStatus} OK`}
                </span>
              )}
            </div>
            <button
              className="app-header__focus-btn"
              onClick={() => setFocusMode((f) => !f)}
              title="Enter Focus Mode"
              aria-pressed={false}
            >
              ⊞ Focus
            </button>
          </div>

          {/* CENTER: view tabs */}
          <nav className="app-header__center" role="tablist" aria-label="Switch view">
            <button
              role="tab"
              aria-selected={activeView === 'editor'}
              className={`app-view-tab${activeView === 'editor' ? ' app-view-tab--active' : ''}`}
              onClick={() => setActiveView('editor')}
            >
              Editor
            </button>
            <button
              role="tab"
              aria-selected={activeView === 'tree'}
              className={`app-view-tab${activeView === 'tree' ? ' app-view-tab--active' : ''}`}
              onClick={() => !isLocked && setActiveView('tree')}
              disabled={isLocked}
              title={isLocked ? 'Unavailable while fork is pending' : 'Decision tree'}
            >
              Decision tree
            </button>
            <button
              role="tab"
              aria-selected={false}
              className="app-view-tab"
              onClick={() => !isLocked && setShowConsistency(true)}
              disabled={isLocked}
              title={isLocked ? 'Unavailable while fork is pending' : 'Check consistency'}
            >
              Check consistency
            </button>
          </nav>

          {/* RIGHT: user info + logout + help */}
          <div className="app-header__right">
            <DocumentSwitcher
              currentDocId={docId}
              currentTitle={docTitle || 'Untitled'}
              onSwitch={handleSwitchDoc}
            />
            {currentUser && (
              <span className="app-header__user" title={currentUser.is_guest ? 'Guest session' : currentUser.username}>
                👤 <span className="app-header__username">{currentUser.is_guest ? 'Guest' : currentUser.username}</span>
              </span>
            )}
            <button className="app-header__logout" onClick={handleLogout}>Log out</button>
            <button
              className="app-header__help"
              onClick={() => setShowHelp(true)}
              title="How to use Throughline"
              aria-label="Open help guide"
            >
              ?
            </button>
          </div>
        </header>
      )}

      {/* ── Document load error / loading states (shown below header) ── */}
      {loadError && (
        <div className="app__doc-error">
          <strong>Failed to load document:</strong> {loadError}
        </div>
      )}

      {!loadError && !segments && (
        <div className="app__doc-loading">Loading document…</div>
      )}

      {/* ── LEFT SIDEBAR (only when document is loaded) ── */}
      {!focusMode && !!segments && (
        <ManuscriptSidebar
          segments={segments}
          branchCount={branchCount}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          docTitle={docTitle}
          onBranchClick={(forkId) => {
            setActiveBranchId(forkId);
            setActiveView('tree');
            setTimeout(() => {
              document.getElementById(`branch-node-${forkId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
          }}
        />
      )}

      {/* ── EDITOR VIEW (only when document is loaded) ── */}
      {(activeView === 'editor' || focusMode) && !!segments && (
        <>
          {uiPhase === 'instruction' && !focusMode && (
            <div className="app__overlay-panel">
              <InstructionPanel
                docId={docId}
                selection={selection}
                initialInstruction={quickInstruction}
                onSubmit={handleForkGenerated}
                onCancel={handleCancelInstruction}
              />
            </div>
          )}

          {uiPhase === 'reviewing' && pendingFork && !focusMode && (
            <div className="app__overlay-panel">
              <ReviewPanel
                fork={pendingFork}
                onApprove={handleApprove}
                onReject={handleReject}
                isSubmitting={isSubmitting}
              />
            </div>
          )}

          <EditorErrorBoundary>
            <Editor
              ref={editorRef}
              docId={docId}
              initialContent={initialContent}
              segments={segments}
              locked={isLocked}
              onSelectionChange={setSelection}
              focusMode={focusMode}
              onToggleFocus={() => setFocusMode((f) => !f)}
            />
          </EditorErrorBoundary>

          {whySuggestion && (
            <WhyPanel
              forkId={whySuggestion.forkId}
              why={whySuggestion.why}
              onDismiss={() => setWhySuggestion(null)}
            />
          )}

          {uiPhase === 'editing' && hasValidSelection && selection.selectionRect && (
            <SelectionToolbar
              rect={selection.selectionRect}
              selectedText={selection.selected_text}
              onAction={handleQuickAction}
            />
          )}

          {uiPhase === 'editing' && hasValidSelection && (
            <div className="app__fork-bar">
              <button
                className="fork-bar__btn"
                onClick={handleShowAlternative}
                disabled={isSubmitting}
                title="Cmd+Enter"
              >
                Show alternative
              </button>
            </div>
          )}

          {uiPhase === 'editing' && selection?.crossSegment && (
            <div className="app__fork-bar">
              <span className="fork-bar__warn">
                Selection spans multiple segments — please select within one section
              </span>
            </div>
          )}
        </>
      )}

      {/* ── TREE VIEW ── */}
      {activeView === 'tree' && !focusMode && !!segments && (
        <TreeView docId={docId} onSwitch={handleBranchSwitch} activeBranchId={activeBranchId} />
      )}

      {/* ── CONSISTENCY PANEL ── */}
      {showConsistency && (
        <ConsistencyPanel docId={docId} onClose={() => setShowConsistency(false)} />
      )}

      {/* ── HELP MODAL ── */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {/* ── TOAST ── */}
      {toast && <Toast message={toast.message} onDismiss={() => setToast(null)} />}
    </div>
  );
}
