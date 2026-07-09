import { useEffect, useState } from 'react';
import Editor from './Editor.jsx';

const DOC_ID = 'doc_hardcoded_001';

export default function App() {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/document/${DOC_ID}/resolved`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then(({ segments }) => {
        // For P1 there is always exactly one segment (root_content, no forks)
        const text = segments.map((s) => s.text).join('');
        setDoc({ id: DOC_ID, initialContent: text });
      })
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div style={{ padding: '2rem', color: '#c0392b' }}>
        <strong>Failed to load document:</strong> {error}
      </div>
    );
  }

  if (!doc) {
    return <div style={{ padding: '2rem', color: '#57606a' }}>Loading…</div>;
  }

  return <Editor docId={doc.id} initialContent={doc.initialContent} />;
}
