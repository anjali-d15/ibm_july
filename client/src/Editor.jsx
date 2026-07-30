import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import './Editor.css';

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Editor — Tiptap-based live editor with:
 *  - 500ms autosave debounce to PATCH /document/:id/content
 *  - flushSave() exposed via ref for fork ops to call before generating
 *  - onSelectionChange(selectionInfo | null) callback for parent to wire into fork UI
 *  - locked prop: disables editing while a fork is pending
 *  - focusMode: distraction-free fullscreen write mode
 */
const Editor = forwardRef(function Editor(
  { docId, initialContent, segments, locked, onSelectionChange, focusMode, onToggleFocus,
    highlightForkId, onHighlightDone },
  ref
) {
  const [saveStatus, setSaveStatus] = useState('idle');
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);

  // ---------------------------------------------------------------------------
  // Autosave
  // ---------------------------------------------------------------------------
  const persistContent = useCallback(
    (text) => {
      setSaveStatus('saving');
      const promise = fetch(`/document/${docId}/content`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`${res.status}`);
          setSaveStatus('saved');
        })
        .catch(() => setSaveStatus('error'))
        .finally(() => {
          if (pendingSaveRef.current === promise) pendingSaveRef.current = null;
        });
      pendingSaveRef.current = promise;
      return promise;
    },
    [docId]
  );

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (editorRef.current) {
        const text = editorRef.current.state.doc.textBetween(
          0,
          editorRef.current.state.doc.content.size,
          '\n\n',
          ''
        );
        await persistContent(text);
        return;
      }
    }
    if (pendingSaveRef.current) await pendingSaveRef.current;
  }, [persistContent]);

  const setContent = useCallback((text) => {
    if (!editorRef.current) return;
    const html = text
      ? text.split('\n\n').map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('')
      : '';
    editorRef.current.commands.setContent(html, /* emitUpdate= */ false);
  }, []);

  useImperativeHandle(ref, () => ({ flushSave, setContent }), [flushSave, setContent]);

  // ---------------------------------------------------------------------------
  // Tiptap editor setup
  // ---------------------------------------------------------------------------
  const editorRef = useRef(null);
  const shellRef = useRef(null);

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History],
    editable: !locked,
    content: initialContent
      ? initialContent
          .split('\n\n')
          .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
          .join('')
      : '',
    onUpdate({ editor: ed, transaction }) {
      if (!ed.isEditable) return;
      if (!transaction.docChanged) return;
      const text = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n\n', '');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => persistContent(text), AUTOSAVE_DEBOUNCE_MS);
    },
    onSelectionUpdate({ editor: ed }) {
      if (!onSelectionChange) return;
      const { from, to } = ed.state.selection;
      if (from === to) {
        onSelectionChange(null);
        return;
      }
      const textBefore = ed.state.doc.textBetween(0, Math.max(0, from - 1), '\n\n', '');
      const textSelected = ed.state.doc.textBetween(from, to, '\n\n', '');

      const plainStart = textBefore.length;
      const plainEnd = plainStart + textSelected.length;

      if (!segments || segments.length === 0) {
        onSelectionChange(null);
        return;
      }

      const owning = segments.find((s) => plainStart >= s.start && plainEnd <= s.end);
      if (!owning) {
        onSelectionChange({ crossSegment: true, plainStart, plainEnd });
        return;
      }

      let selectionRect = null;
      try {
        const nativeSel = window.getSelection();
        if (nativeSel && nativeSel.rangeCount > 0) {
          selectionRect = nativeSel.getRangeAt(0).getBoundingClientRect();
        }
      } catch (_) { /* ignore */ }

      onSelectionChange({
        crossSegment: false,
        segment_fork_id: owning.fork_id,
        anchor_start: plainStart,
        anchor_end: plainEnd,
        selected_text: textSelected,
        selectionRect,
      });
    },
  });

  // Sync editor editable state with locked prop
  useEffect(() => {
    if (editor) editor.setEditable(!locked);
  }, [editor, locked]);

  // Store editor instance ref
  useEffect(() => {
    if (editor) editorRef.current = editor;
  }, [editor]);

  // Cleanup autosave timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Branch-switch pulse highlight (Double-frame delay + Fallback targeting)
  // ---------------------------------------------------------------------------
  const highlightTimerRef = useRef(null);

  useEffect(() => {
    if (!highlightForkId || !shellRef.current) return;

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);

    console.log('👉 [Highlight] Triggered for fork ID:', highlightForkId);

    // Double requestAnimationFrame ensures Tiptap's DOM rendering cycle finishes
    let frameId1 = requestAnimationFrame(() => {
      let frameId2 = requestAnimationFrame(() => {
        const proseMirrorEl = shellRef.current?.querySelector('.ProseMirror');
        if (!proseMirrorEl) {
          console.warn('❌ [Highlight] ProseMirror DOM element not found');
          return;
        }

        const seg = segments?.find((s) => s.fork_id === highlightForkId);
        const paragraphs = Array.from(proseMirrorEl.querySelectorAll('p'));

        let targetPara = null;

        if (seg && seg.text) {
          const cleanSegText = seg.text.replace(/\s+/g, ' ').trim();
          for (const p of paragraphs) {
            const cleanParaText = p.textContent.replace(/\s+/g, ' ').trim();
            if (
              cleanParaText.length > 0 &&
              (cleanParaText.includes(cleanSegText) || cleanSegText.includes(cleanParaText))
            ) {
              targetPara = p;
              break;
            }
          }
        }

        // Fallback target: first paragraph or ProseMirror wrapper
        const highlightTarget = targetPara || paragraphs[0] || proseMirrorEl;
        console.log('✅ [Highlight] Applying animation to target:', highlightTarget);

        // Reset and trigger CSS pulse animation
        highlightTarget.classList.remove('branch-switched-highlight');
        void highlightTarget.offsetWidth; // Force reflow
        highlightTarget.classList.add('branch-switched-highlight');

        highlightTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });

        highlightTimerRef.current = setTimeout(() => {
          highlightTarget.classList.remove('branch-switched-highlight');
          if (onHighlightDone) onHighlightDone();
        }, 3000);
      });

      return () => cancelAnimationFrame(frameId2);
    });

    return () => {
      cancelAnimationFrame(frameId1);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [highlightForkId, segments, onHighlightDone]);

  // Escape key exits focus mode
  useEffect(() => {
    if (!focusMode) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape' && onToggleFocus) onToggleFocus();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusMode, onToggleFocus]);

  const statusLabel = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed' }[saveStatus];
  const statusColor = { idle: 'transparent', saving: '#8b93a1', saved: '#2da44e', error: '#c0392b' }[saveStatus];

  return (
    <div ref={shellRef} className={`editor-shell${locked ? ' editor-shell--locked' : ''}${focusMode ? ' editor-shell--focus' : ''}`}>
      {focusMode && (
        <header className="editor-header editor-header--focus-only">
          <div className="editor-header__left">
            <div className="editor-brand">
              <svg className="editor-brand__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6 C6 6, 7 10, 10 10 C13 10, 14 6, 17 6 C20 6, 21 10, 21 10"
                  stroke="#5b5bd6" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                <path d="M3 12 C5 12, 8 8, 12 12 C16 16, 19 12, 21 12"
                  stroke="#7c5cd8" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                <path d="M3 18 C6 18, 7 14, 10 14 C13 14, 14 18, 17 18 C20 18, 21 14, 21 14"
                  stroke="#3b82d4" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              </svg>
              <span className="editor-title">Throughline</span>
            </div>
          </div>
          <div className="editor-header__right">
            <span className="save-status" style={{ color: statusColor }}>{statusLabel}</span>
            {onToggleFocus && (
              <button
                className="focus-mode-btn"
                onClick={onToggleFocus}
                title="Exit Focus Mode (Esc)"
                aria-pressed={true}
              >
                ⊡ Exit Focus
              </button>
            )}
          </div>
        </header>
      )}
      {!focusMode && (
        <div className="editor-save-indicator" aria-live="polite">
          <span className="save-status" style={{ color: statusColor }}>{statusLabel}</span>
        </div>
      )}
      <main className="editor-main">
        <div className="editor-paper">
          <EditorContent editor={editor} className="editor-content" />
        </div>
      </main>
    </div>
  );
});

export default Editor;