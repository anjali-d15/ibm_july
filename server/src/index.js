'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const { getDb } = require('./db');
const { resolveDocument } = require('./resolve');
const { generateAlternative } = require('./granite');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({ origin: corsOrigin, credentials: true }));
}

// ---------------------------------------------------------------------------
// Session cookie (P2: identity for rate limiter)
// httpOnly, SameSite=Strict — no auth, just a stable per-browser ID.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'ledger_sid';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, seconds

app.use((req, _res, next) => {
  // Parse cookies manually (no cookie-parser dep needed for one cookie)
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  req.sessionId = match ? match.slice(SESSION_COOKIE.length + 1) : null;
  next();
});

function ensureSession(req, res, next) {
  if (!req.sessionId) {
    req.sessionId = crypto.randomUUID();
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${req.sessionId}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`
    );
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiter — in-memory token bucket, per session, on generate-alternative only
// 5 requests per 60 seconds per session. Wiped on server restart.
// ---------------------------------------------------------------------------
const RATE_LIMIT_CAPACITY = 5;
const RATE_LIMIT_REFILL_MS = 60_000; // full refill every 60s

const rateBuckets = new Map(); // sessionId → { tokens, lastRefill }

function consumeRateToken(sessionId) {
  const now = Date.now();
  let bucket = rateBuckets.get(sessionId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    rateBuckets.set(sessionId, bucket);
  }
  // Proportional refill
  const elapsed = now - bucket.lastRefill;
  const refilled = (elapsed / RATE_LIMIT_REFILL_MS) * RATE_LIMIT_CAPACITY;
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + refilled);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function rateLimitMiddleware(req, res, next) {
  if (!consumeRateToken(req.sessionId)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait before generating another alternative.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /document/:id/resolved
 */
app.get('/document/:id/resolved', (req, res) => {
  const segments = resolveDocument(req.params.id);
  if (!segments) return res.status(404).json({ error: 'Document not found' });
  res.json({ segments });
});

/**
 * GET /document/:id
 */
app.get('/document/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, title, root_content, created_at FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

/**
 * GET /document/:id/tree
 * Flat list of all fork rows for this document.
 */
app.get('/document/:id/tree', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const forks = db
    .prepare(
      `SELECT id, parent_fork_id, anchor_start, anchor_end,
              original_snippet, branch_content, why,
              status, is_active, created_at, updated_at
       FROM forks WHERE document_id = ? ORDER BY created_at ASC`
    )
    .all(req.params.id);
  res.json({ forks });
});

/**
 * PATCH /document/:id/content
 * P1 autosave: update root_content directly.
 * Blocked if a fork is pending (document locked).
 */
app.patch('/document/:id/content', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  const db = getDb();

  // Lock check
  const pending = db
    .prepare(`SELECT id FROM forks WHERE document_id = ? AND status = 'proposed' LIMIT 1`)
    .get(req.params.id);
  if (pending) {
    return res.status(409).json({ error: 'Document is locked: a fork is pending review' });
  }

  const result = db
    .prepare('UPDATE documents SET root_content = ? WHERE id = ?')
    .run(content, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true });
});

/**
 * POST /document/:id/generate-alternative
 *
 * Body: {
 *   segment_fork_id: string | null,
 *   anchor_start: number,
 *   anchor_end: number,
 *   selected_text: string,
 *   instruction?: string   — optional free-form or preset
 * }
 *
 * 1. Validate input (types, length cap, selection within segment)
 * 2. Insert proposed Fork row (DB partial unique index is the lock)
 * 3. Call Granite (20s timeout, structured output)
 * 4. On success: update fork with branch_content
 * 5. On any failure: set fork status=failed
 */
app.post('/document/:id/generate-alternative', ensureSession, rateLimitMiddleware, async (req, res) => {
  const { segment_fork_id, anchor_start, anchor_end, selected_text, instruction } = req.body;

  // --- Validation ---
  if (typeof anchor_start !== 'number' || typeof anchor_end !== 'number') {
    return res.status(400).json({ error: 'anchor_start and anchor_end must be numbers' });
  }
  if (anchor_start >= anchor_end) {
    return res.status(400).json({ error: 'anchor_start must be less than anchor_end' });
  }
  if (typeof selected_text !== 'string' || selected_text.trim() === '') {
    return res.status(400).json({ error: 'selected_text must be a non-empty string' });
  }
  // Input cap: ~2000 chars
  if (selected_text.length > 2000) {
    return res.status(400).json({ error: 'Selection too long (max 2000 characters)' });
  }
  if (instruction !== undefined && typeof instruction !== 'string') {
    return res.status(400).json({ error: 'instruction must be a string if provided' });
  }
  if (typeof instruction === 'string' && instruction.length > 200) {
    return res.status(400).json({ error: 'Instruction too long (max 200 characters)' });
  }

  const db = getDb();
  const docId = req.params.id;

  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // --- Validate selection falls within a single segment ---
  const segments = resolveDocument(docId);
  const owningSegment = segments.find(
    (s) => s.fork_id === (segment_fork_id ?? null) && anchor_start >= s.start && anchor_end <= s.end
  );
  if (!owningSegment) {
    return res.status(400).json({
      error: 'Selection does not fall within a single segment, or segment_fork_id is incorrect',
    });
  }

  // --- Insert proposed fork (DB unique index is the concurrency lock) ---
  const forkId = uuidv4();
  try {
    db.prepare(
      `INSERT INTO forks
         (id, document_id, parent_fork_id, anchor_start, anchor_end,
          original_snippet, branch_content, status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, '', 'proposed', 0)`
    ).run(forkId, docId, segment_fork_id ?? null, anchor_start, anchor_end, selected_text);
  } catch (err) {
    // SQLITE_CONSTRAINT = unique index violation → another fork is pending
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A fork is already pending for this document' });
    }
    throw err;
  }

  // --- Call Granite ---
  try {
    const alternative = await generateAlternative(selected_text, instruction || undefined);

    db.prepare(
      `UPDATE forks SET branch_content = ?, status = 'proposed', updated_at = datetime('now') WHERE id = ?`
    ).run(alternative, forkId);

    const fork = db.prepare('SELECT * FROM forks WHERE id = ?').get(forkId);
    return res.json({ fork });
  } catch (err) {
    // Granite failed or timed out → mark failed, unlock document
    db.prepare(
      `UPDATE forks SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    ).run(forkId);
    console.error('[generate-alternative] Granite error:', err.message);
    return res.status(502).json({ error: `Generation failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  getDb(); // eager init + seed
  console.log(`Ledger server running on http://localhost:${PORT}`);
});
