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

/**
 * Ensure a space exists at the boundary between `left` and `right` strings.
 *
 * Rules applied in order:
 *   1. If `right` is empty, return as-is.
 *   2. If `right` already starts with whitespace or a newline, return as-is.
 *   3. If `left` ends with sentence-ending punctuation (. ! ? , " ' » —)
 *      followed by a non-space char in `right`, prepend a space to `right`.
 *   4. If `left` ends with a word character (\w) and `right` starts with a
 *      word character (\w), prepend a space to `right` (word-adjacency fix).
 *
 * The fix is applied to the `right` string (returned), leaving `left` intact.
 * @param {string} leftText
 * @param {string} rightText
 * @returns {string} rightText, possibly with a leading space inserted
 */
function ensureBoundarySpace(leftText, rightText) {
  if (!rightText) return rightText;
  const firstRight = rightText[0];
  if (firstRight === ' ' || firstRight === '\n' || firstRight === '\r' || firstRight === '\t') {
    return rightText; // already has leading space
  }
  const lastLeft = leftText.trimEnd().slice(-1);
  if (!lastLeft) return rightText; // left is empty / whitespace only
  // Rule 3: punctuation boundary
  if (/[.!?,;:"'»—]/.test(lastLeft)) {
    return ' ' + rightText;
  }
  // Rule 4: word–word adjacency (e.g. "destinyHe" → "destiny He")
  if (/\w/.test(lastLeft) && /\w/.test(firstRight)) {
    return ' ' + rightText;
  }
  return rightText;
}

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
        let before = text.slice(cursor, fork.anchor_start);
        // Fix word-adjacency at the before→branch_content boundary:
        // branch_content will be appended right after `before`, so trim any
        // trailing space from `before` that the original anchor may have had,
        // then let ensureBoundarySpace handle spacing from the other direction.
        segments.push({ text: before, fork_id: forkId, start: outputOffset, end: outputOffset + before.length });
        outputOffset += before.length;
      }

      // Recurse into fork's branch_content (fork owns this segment)
      const rawChildSegments = descend(fork.branch_content, fork.id, outputOffset);

      // Fix spacing at the before→branch_content boundary.
      // The last pushed segment is the `before` text (or a prior child).
      if (rawChildSegments.length > 0 && segments.length > 0) {
        const prevText = segments[segments.length - 1].text;
        const firstChildText = rawChildSegments[0].text;
        const fixedFirst = ensureBoundarySpace(prevText, firstChildText);
        if (fixedFirst !== firstChildText) {
          const diff = fixedFirst.length - firstChildText.length; // +1 for the inserted space
          rawChildSegments[0] = {
            ...rawChildSegments[0],
            text: fixedFirst,
            end: rawChildSegments[0].end + diff,
          };
          // Shift all subsequent child segment offsets
          for (let i = 1; i < rawChildSegments.length; i++) {
            rawChildSegments[i] = {
              ...rawChildSegments[i],
              start: rawChildSegments[i].start + diff,
              end:   rawChildSegments[i].end   + diff,
            };
          }
        }
      }

      segments.push(...rawChildSegments);
      outputOffset += rawChildSegments.reduce((sum, s) => sum + s.text.length, 0);

      cursor = fork.anchor_end;
    }

    // Trailing text after all forks — fix spacing at the branch→trailing boundary.
    if (cursor < text.length) {
      let after = text.slice(cursor);
      if (segments.length > 0) {
        const prevText = segments[segments.length - 1].text;
        after = ensureBoundarySpace(prevText, after);
      }
      segments.push({ text: after, fork_id: forkId, start: outputOffset, end: outputOffset + after.length });
    }

    return segments;
  }

  return descend(doc.root_content, null, 0);
}

module.exports = { resolveDocument };
