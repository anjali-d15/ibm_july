'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');
const { resolveDocument } = require('./resolve');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({ origin: corsOrigin, credentials: true }));
}
// If CORS_ORIGIN is unset, assume frontend is served from the same origin
// (e.g. production static serve) — no CORS header needed.

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /document/:id/resolved
 * Returns the segment array for the resolved document.
 */
app.get('/document/:id/resolved', (req, res) => {
  const segments = resolveDocument(req.params.id);
  if (!segments) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.json({ segments });
});

/**
 * GET /document/:id
 * Returns the raw document row (title, root_content, created_at).
 */
app.get('/document/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, title, root_content, created_at FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

/**
 * PATCH /document/:id/content
 * Autosave: update root_content.
 * Body: { content: string }
 *
 * P1 only — in P3 this route is replaced by PATCH /document/:id/edit
 * which handles in-segment edits and appends with offset tracking.
 */
app.patch('/document/:id/content', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  const db = getDb();
  const result = db
    .prepare('UPDATE documents SET root_content = ? WHERE id = ?')
    .run(content, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  // Eagerly initialise the DB + seed on startup
  getDb();
  console.log(`Ledger server running on http://localhost:${PORT}`);
});
