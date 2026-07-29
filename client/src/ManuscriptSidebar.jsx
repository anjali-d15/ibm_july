import { useState } from 'react';
import './ManuscriptSidebar.css';

const EXPORT_FORMATS = [
  { id: 'md',   label: '.md  (Markdown)',    ext: 'md',   mime: 'text/markdown' },
  { id: 'txt',  label: '.txt (Plain text)',  ext: 'txt',  mime: 'text/plain' },
  { id: 'docx', label: '.docx (Word)',       ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { id: 'doc',  label: '.doc (Word legacy)', ext: 'doc',  mime: 'application/msword' },
];

/**
 * Build a minimal RTF string for .doc / .docx fallback.
 * A real .docx requires a ZIP structure; for this zero-dep implementation
 * we export an RTF file (which Word, LibreOffice, and Google Docs open natively)
 * named with the .docx or .doc extension.
 */
function buildRtf(text) {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .split('\n\n')
    .map((para) => `\\par\\pard ${para.replace(/\n/g, '\\line ')}`)
    .join(' ');
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}{\\f0\\fs24 ${escaped}}}`;
}

/**
 * ManuscriptSidebar — collapsible left panel.
 * Shows manuscript outline/story branches, live stats, and export button.
 *
 * Props:
 *   segments       array  — resolved segments from /resolved
 *   branchCount    number — count of distinct active forks
 *   onExport       ()=>void
 *   collapsed      boolean
 *   onToggle       ()=>void
 */
export default function ManuscriptSidebar({ segments, branchCount, collapsed, onToggle, docTitle, onBranchClick }) {
  const [activeSection, setActiveSection] = useState('outline');

  function handleExport(fmt) {
    if (!segments) return;
    const rawText = segments.map((s) => s.text).join('');
    // Strip any HTML markup tags from the text
    const cleanText = rawText.replace(/<[^>]+>/g, '');
    const safeName = (docTitle || 'throughline-manuscript').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    let content, mime;
    if (fmt.id === 'docx' || fmt.id === 'doc') {
      content = buildRtf(cleanText);
      mime = 'application/rtf';
    } else {
      content = cleanText;
      mime = fmt.mime;
    }
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.${fmt.ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Compute stats from segments
  const fullText = segments ? segments.map((s) => s.text).join('') : '';
  const wordCount = fullText.trim() ? fullText.trim().split(/\s+/).length : 0;
  const readingTimeMins = Math.max(1, Math.ceil(wordCount / 200));

  // Build a simple outline: group segments by whether they're branch or root
  const outlineItems = segments
    ? segments.filter((s) => s.text.trim().length > 0).map((s, i) => ({
        key: i,
        forkId: s.fork_id || null,
        label: s.fork_id
          ? `Branch ${i + 1}: "${s.text.slice(0, 50).replace(/\n/g, ' ')}"`
          : `Root ${i + 1}: "${s.text.slice(0, 50).replace(/\n/g, ' ')}"`,
        isBranch: !!s.fork_id,
      }))
    : [];

  return (
    <aside className={`ms-sidebar${collapsed ? ' ms-sidebar--collapsed' : ''}`}>
      {/* Toggle handle */}
      <button
        className="ms-sidebar__toggle"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <span className="ms-sidebar__toggle-icon" aria-hidden="true">
          {collapsed ? '›' : '‹'}
        </span>
      </button>

      {!collapsed && (
        <div className="ms-sidebar__body">
          <div className="ms-sidebar__header">
            <span className="ms-sidebar__title">Manuscript</span>
          </div>

          {/* ── Stats strip ── */}
          <div className="ms-stats">
            <div className="ms-stats__item">
              <span className="ms-stats__value">{wordCount.toLocaleString()}</span>
              <span className="ms-stats__label">words</span>
            </div>
            <div className="ms-stats__divider" />
            <div className="ms-stats__item">
              <span className="ms-stats__value">{readingTimeMins} min</span>
              <span className="ms-stats__label">read</span>
            </div>
            <div className="ms-stats__divider" />
            <div className="ms-stats__item">
              <span className="ms-stats__value">{branchCount}</span>
              <span className="ms-stats__label">branches</span>
            </div>
          </div>

          {/* ── Section tabs ── */}
          <div className="ms-sidebar__tabs">
            <button
              className={`ms-sidebar__tab${activeSection === 'outline' ? ' ms-sidebar__tab--active' : ''}`}
              onClick={() => setActiveSection('outline')}
            >
              Outline
            </button>
            <button
              className={`ms-sidebar__tab${activeSection === 'branches' ? ' ms-sidebar__tab--active' : ''}`}
              onClick={() => setActiveSection('branches')}
            >
              Branches
            </button>
          </div>

          {/* ── Outline list ── */}
          {activeSection === 'outline' && (
            <ul className="ms-outline">
              {outlineItems.length === 0 && (
                <li className="ms-outline__empty">No content yet.</li>
              )}
              {outlineItems.map((item) => (
                <li
                  key={item.key}
                  className={`ms-outline__item${item.isBranch ? ' ms-outline__item--branch' : ''}`}
                >
                  {item.label}
                </li>
              ))}
            </ul>
          )}

          {/* ── Branches list ── */}
          {activeSection === 'branches' && (
            <ul className="ms-outline">
              {outlineItems.filter((i) => i.isBranch).length === 0 && (
                <li className="ms-outline__empty">No active branches.</li>
              )}
              {outlineItems
                .filter((i) => i.isBranch)
                .map((item) => (
                  <li
                    key={item.key}
                    className="ms-outline__item ms-outline__item--branch ms-outline__item--clickable"
                    onClick={() => onBranchClick && onBranchClick(item.forkId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && onBranchClick && onBranchClick(item.forkId)}
                    title="View in Decision Tree"
                  >
                    {item.label}
                    <span className="ms-outline__item-arrow" aria-hidden="true"> →</span>
                  </li>
                ))}
            </ul>
          )}

          {/* ── Multi-format export ── */}
          <div className="ms-sidebar__footer">
            <p className="ms-export__heading">Export manuscript</p>
            <div className="ms-export__formats">
              {EXPORT_FORMATS.map((fmt) => (
                <button
                  key={fmt.id}
                  className="ms-export-btn"
                  onClick={() => handleExport(fmt)}
                  title={`Download as ${fmt.label}`}
                >
                  {fmt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
