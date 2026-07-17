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
 */
const Editor = forwardRef(function Editor(
  { docId, initialContent, segments, locked, onSelectionChange },
  ref
) {
  const [saveStatus, setSaveStatus] = useState('idle');
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null); // holds the in-flight save promise

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

  /**
   * flushSave — synchronously cancel the debounce timer and await any
   * in-flight save. Fork operations must call this before proceeding.
   */
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      // If there's pending text that hasn't been saved yet, save it now
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
    // Wait for any already-in-flight save to complete
    if (pendingSaveRef.current) await pendingSaveRef.current;
  }, [persistContent]);

  /**
   * setContent — replaces the editor's content programmatically.
   * Called by App after approve/reject to reflect the new resolved document.
   * Uses doc.textBetween-compatible paragraph structure, same as initial load.
   */
  const setContent = useCallback((text) => {
    if (!editorRef.current) return;
    const html = text
      ? text.split('\n\n').map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('')
      : '';
    editorRef.current.commands.setContent(html, /* emitUpdate= */ false);
  }, []);

  useImperativeHandle(ref, () => ({ flushSave, setContent }), [flushSave, setContent]);

  // ---------------------------------------------------------------------------
  // Tiptap editor
  // ---------------------------------------------------------------------------
  const editorRef = useRef(null);

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
      // DEV TRACE — remove before P4
      console.log('[onUpdate] isEditable=%s docChanged=%s steps=%d',
        ed.isEditable, transaction.docChanged, transaction.steps.length);
      if (!ed.isEditable) { console.log('[onUpdate] skipped — not editable'); return; }
      if (!transaction.docChanged) { console.log('[onUpdate] skipped — no docChange'); return; }
      console.log('[onUpdate] → scheduling save');
      // Use doc.textBetween for plain-text character offsets — per spec
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
      // Extract plain-text offsets using doc.textBetween
      const docSize = ed.state.doc.content.size;
      // textBetween(0, pos) gives us the plain-text offset at `pos`
      const textBefore = ed.state.doc.textBetween(0, Math.max(0, from - 1), '\n\n', '');
      const textSelected = ed.state.doc.textBetween(from, to, '\n\n', '');

      // Approximate plain-text start/end offsets
      // We walk the resolved segments to find which segment owns this selection
      const plainStart = textBefore.length;
      const plainEnd = plainStart + textSelected.length;

      if (!segments || segments.length === 0) {
        onSelectionChange(null);
        return;
      }

      // Find the owning segment (must be fully within one segment)
      const owning = segments.find((s) => plainStart >= s.start && plainEnd <= s.end);
      if (!owning) {
        // Cross-segment selection
        onSelectionChange({ crossSegment: true, plainStart, plainEnd });
        return;
      }

      // Offsets relative to the segment's coordinate space
      const anchorStart = plainStart - owning.start + owning.start;
      const anchorEnd = plainEnd - owning.start + owning.start;

      onSelectionChange({
        crossSegment: false,
        segment_fork_id: owning.fork_id,
        anchor_start: plainStart,
        anchor_end: plainEnd,
        selected_text: textSelected,
      });
    },
  });

  // Keep editor editable state in sync with locked prop
  useEffect(() => {
    if (editor) editor.setEditable(!locked);
  }, [editor, locked]);

  // Store ref for flushSave to access
  useEffect(() => {
    if (editor) editorRef.current = editor;
  }, [editor]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const statusLabel = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed' }[saveStatus];
  const statusColor = { idle: 'transparent', saving: '#57606a', saved: '#2da44e', error: '#c0392b' }[saveStatus];

  return (
    <div className={`editor-shell${locked ? ' editor-shell--locked' : ''}`}>
      <header className="editor-header">
        <span className="editor-title">Ledger</span>
        <span className="save-status" style={{ color: statusColor }}>{statusLabel}</span>
      </header>
      <main className="editor-main">
        <EditorContent editor={editor} className="editor-content" />
      </main>
    </div>
  );
});

export default Editor;
