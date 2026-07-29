import { useState, useEffect, useRef } from 'react';
import './DocumentSwitcher.css';

/**
 * DocumentSwitcher — dropdown allowing authors to switch between manuscripts,
 * create a new one, rename, or delete.
 *
 * Props:
 *   currentDocId  string
 *   currentTitle  string
 *   onSwitch(docId)  — called when user picks a different doc
 *   onTitleChange()  — called after a rename so parent can re-fetch
 */
export default function DocumentSwitcher({ currentDocId, currentTitle, onSwitch, onTitleChange }) {
  const [open, setOpen]           = useState(false);
  const [docs, setDocs]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [renameId, setRenameId]   = useState(null);
  const [renameVal, setRenameVal] = useState('');
  const [creating, setCreating]   = useState(false);
  const [newTitle, setNewTitle]   = useState('');
  const [error, setError]         = useState(null);
  const panelRef = useRef(null);
  const renameRef = useRef(null);

  // Load list when dropdown opens
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    fetch('/documents', { credentials: 'include' })
      .then((r) => r.json())
      .then(({ documents }) => setDocs(documents || []))
      .catch(() => setError('Failed to load manuscripts'))
      .finally(() => setLoading(false));
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus rename input
  useEffect(() => {
    if (renameId && renameRef.current) renameRef.current.focus();
  }, [renameId]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      setNewTitle('');
      setCreating(false);
      setOpen(false);
      onSwitch(data.document.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRename(docId) {
    if (!renameVal.trim()) { setRenameId(null); return; }
    try {
      const res = await fetch(`/documents/${docId}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: renameVal.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      setRenameId(null);
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, title: renameVal.trim() } : d));
      if (docId === currentDocId) onTitleChange && onTitleChange(renameVal.trim());
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(docId) {
    if (!confirm('Delete this manuscript and all its branches? This cannot be undone.')) return;
    try {
      const res = await fetch(`/documents/${docId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      const remaining = docs.filter((d) => d.id !== docId);
      setDocs(remaining);
      if (docId === currentDocId && remaining.length > 0) {
        onSwitch(remaining[0].id);
        setOpen(false);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="doc-switcher" ref={panelRef}>
      <button
        className="doc-switcher__trigger"
        onClick={() => setOpen((o) => !o)}
        title="My Manuscripts"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="doc-switcher__title">{currentTitle || 'Untitled'}</span>
        <span className="doc-switcher__caret" aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="doc-switcher__panel" role="listbox">
          <div className="doc-switcher__panel-header">My Manuscripts</div>

          {error && <p className="doc-switcher__error">{error}</p>}
          {loading && !docs && <p className="doc-switcher__loading">Loading…</p>}

          {docs && (
            <ul className="doc-switcher__list">
              {docs.map((doc) => (
                <li
                  key={doc.id}
                  className={`doc-switcher__item${doc.id === currentDocId ? ' doc-switcher__item--active' : ''}`}
                >
                  {renameId === doc.id ? (
                    <form
                      className="doc-switcher__rename-form"
                      onSubmit={(e) => { e.preventDefault(); handleRename(doc.id); }}
                    >
                      <input
                        ref={renameRef}
                        className="doc-switcher__rename-input"
                        value={renameVal}
                        onChange={(e) => setRenameVal(e.target.value)}
                        onBlur={() => handleRename(doc.id)}
                        onKeyDown={(e) => { if (e.key === 'Escape') setRenameId(null); }}
                        maxLength={200}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        className="doc-switcher__item-label"
                        onClick={() => { if (doc.id !== currentDocId) { onSwitch(doc.id); setOpen(false); } }}
                      >
                        {doc.title}
                      </button>
                      <div className="doc-switcher__item-actions">
                        <button
                          className="doc-switcher__action"
                          title="Rename"
                          onClick={() => { setRenameId(doc.id); setRenameVal(doc.title); }}
                          aria-label={`Rename "${doc.title}"`}
                        >✎</button>
                        <button
                          className="doc-switcher__action doc-switcher__action--delete"
                          title="Delete"
                          onClick={() => handleDelete(doc.id)}
                          aria-label={`Delete "${doc.title}"`}
                        >✕</button>
                      </div>
                    </>
                  )}
                </li>
              ))}
              {docs.length === 0 && (
                <li className="doc-switcher__empty">No manuscripts yet.</li>
              )}
            </ul>
          )}

          {/* New manuscript */}
          <div className="doc-switcher__footer">
            {creating ? (
              <form className="doc-switcher__new-form" onSubmit={handleCreate}>
                <input
                  className="doc-switcher__new-input"
                  autoFocus
                  placeholder="Title…"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setCreating(false); }}
                  maxLength={200}
                />
                <button className="doc-switcher__new-submit" type="submit" disabled={!newTitle.trim()}>
                  Create
                </button>
              </form>
            ) : (
              <button className="doc-switcher__new-btn" onClick={() => setCreating(true)}>
                + New Manuscript
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
