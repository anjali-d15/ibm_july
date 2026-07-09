const { getDb } = require('./db');

/**
 * Resolve the document into a flat segment array.
 *
 * For P1 (no forks), returns a single root segment:
 *   [{ text, fork_id: null, start: 0, end: text.length }]
 *
 * The algorithm is written for the full recursive case so P2/P3 can extend
 * it without restructuring.
 *
 * @param {string} documentId
 * @returns {{ text: string, fork_id: string|null, start: number, end: number }[]}
 */
function resolveDocument(documentId) {
  const db = getDb();

  const doc = db.prepare('SELECT root_content FROM documents WHERE id = ?').get(documentId);
  if (!doc) return null;

  // Fetch all forks for this document up front; build a lookup by parent_fork_id
  const allForks = db
    .prepare(
      `SELECT id, parent_fork_id, anchor_start, anchor_end, branch_content, is_active, status
       FROM forks
       WHERE document_id = ?
       ORDER BY created_at ASC`
    )
    .all(documentId);

  // children[parentId] = list of fork rows (null key = root's children)
  const children = {};
  for (const fork of allForks) {
    const key = fork.parent_fork_id ?? '__root__';
    if (!children[key]) children[key] = [];
    children[key].push(fork);
  }

  // Recursive descent; returns segment array with offsets relative to
  // the *start* offset passed in (position within the final resolved document).
  function descend(text, forkId, startOffset) {
    const key = forkId ?? '__root__';
    const forkChildren = children[key] || [];

    // Only the single active+resolved child at each anchor point participates.
    // We sort by anchor_start so we process substitutions left-to-right.
    const activeForks = forkChildren
      .filter((f) => f.is_active === 1 && f.status === 'resolved')
      .sort((a, b) => a.anchor_start - b.anchor_start);

    if (activeForks.length === 0) {
      // Leaf: return the text as a single segment
      return [{ text, fork_id: forkId, start: startOffset, end: startOffset + text.length }];
    }

    const segments = [];
    let cursor = 0; // position within `text`
    let outputOffset = startOffset;

    for (const fork of activeForks) {
      // Text before this fork's anchor range (belongs to current forkId node)
      if (fork.anchor_start > cursor) {
        const before = text.slice(cursor, fork.anchor_start);
        segments.push({ text: before, fork_id: forkId, start: outputOffset, end: outputOffset + before.length });
        outputOffset += before.length;
      }

      // Recurse into fork's branch_content (fork owns this segment)
      const childSegments = descend(fork.branch_content, fork.id, outputOffset);
      segments.push(...childSegments);
      outputOffset += fork.branch_content.length; // approximate — recursive descent tracks its own offsets

      cursor = fork.anchor_end;
    }

    // Trailing text after all forks
    if (cursor < text.length) {
      const after = text.slice(cursor);
      segments.push({ text: after, fork_id: forkId, start: outputOffset, end: outputOffset + after.length });
    }

    return segments;
  }

  return descend(doc.root_content, null, 0);
}

module.exports = { resolveDocument };
