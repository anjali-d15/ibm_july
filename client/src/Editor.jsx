import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import History from '@tiptap/extension-history';
import './Editor.css';

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Autosave status indicator values: 'idle' | 'saving' | 'saved' | 'error'
 */
export default function Editor({ docId, initialContent }) {
  const [saveStatus, setSaveStatus] = useState('idle');
  const saveTimerRef = useRef(null);

  const persistContent = useCallback(
    async (text) => {
      setSaveStatus('saving');
      try {
        const res = await fetch(`/document/${docId}/content`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    },
    [docId]
  );

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, History],
    // Convert plain-text newlines to Tiptap paragraph structure for initial load
    content: initialContent
      ? initialContent
          .split('\n\n')
          .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
          .join('')
      : '',
    onUpdate({ editor: ed }) {
      // Use doc.textBetween for character offsets — per spec (not raw ProseMirror positions)
      const text = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n\n', '');

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => persistContent(text), AUTOSAVE_DEBOUNCE_MS);
    },
  });

  // Flush timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const statusLabel = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed' }[saveStatus];
  const statusColor = { idle: 'transparent', saving: '#57606a', saved: '#2da44e', error: '#c0392b' }[saveStatus];

  return (
    <div className="editor-shell">
      <header className="editor-header">
        <span className="editor-title">Ledger</span>
        <span className="save-status" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </header>
      <main className="editor-main">
        <EditorContent editor={editor} className="editor-content" />
      </main>
    </div>
  );
}
