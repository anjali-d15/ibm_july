'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const { getDb, repairActiveFlags, createUser, findUserByCredentials, findUserById,
        seedStarterManuscripts, ensureLegacyData } = require('./db');
const { resolveDocument } = require('./resolve');
const { generateAlternative, draftWhySummary, checkConsistency, suggestChips } = require('./granite');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// Return JSON (not HTML) when express.json() fails to parse the body.
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: corsOrigin, credentials: true }));

// ---------------------------------------------------------------------------
// Prompt injection sanitiser
// ---------------------------------------------------------------------------
const CONTROL_TOKEN_RE = /<\|(?:system|user|assistant|endoftext)\|>/g;
function sanitizeUserInput(str) {
  if (typeof str !== 'string') return str;
  return str.replace(CONTROL_TOKEN_RE, '').trim();
}

// ---------------------------------------------------------------------------
// Session cookie — stable browser ID for both rate-limiting and auth identity
// ---------------------------------------------------------------------------
const SESSION_COOKIE  = 'ledger_sid';
const AUTH_COOKIE     = 'throughline_uid';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, seconds

app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  const parseCookie = (name) => {
    const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : null;
  };
  req.sessionId = parseCookie(SESSION_COOKIE);
  req.userId    = parseCookie(AUTH_COOKIE);
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

/**
 * Verify the auth cookie resolves to a real user.
 * Attaches req.user if valid; returns 401 otherwise.
 */
function ensureAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = findUserById(getDb(), req.userId);
  if (!user) return res.status(401).json({ error: 'Session expired — please log in again' });
  req.user = user;
  next();
}

// ---------------------------------------------------------------------------
// Rate limiter — in-memory sliding window token bucket, per session
// ---------------------------------------------------------------------------
const RATE_LIMIT_CAPACITY = 15;
const RATE_LIMIT_REFILL_MS = 60_000;
const rateBuckets = new Map();

function consumeRateToken(sessionId) {
  const now = Date.now();
  let bucket = rateBuckets.get(sessionId);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    rateBuckets.set(sessionId, bucket);
  }
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
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

/**
 * POST /auth/register
 * Body: { username, password }
 * Creates account + seeds 3 starter manuscripts.
 */
app.post('/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const db = getDb();
    const user = createUser(db, { username: username.trim(), password });
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${user.id}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`);
    return res.json({ ok: true, user: { id: user.id, username: user.username, is_guest: user.is_guest } });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error('[register]', err.message);
    return res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

/**
 * POST /auth/login
 * Body: { username, password }
 */
app.post('/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const db = getDb();
    const user = findUserByCredentials(db, username.trim(), password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${user.id}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`);
    return res.json({ ok: true, user: { id: user.id, username: user.username, is_guest: user.is_guest } });
  } catch (err) {
    console.error('[login]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/guest
 * Creates an anonymous guest account and immediately logs them in.
 */
app.post('/auth/guest', (req, res) => {
  try {
    const db = getDb();
    // Each guest session gets a fully unique name — never reuse a static ID
    const guestName = `guest_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const user = createUser(db, { username: guestName, isGuest: true });
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${user.id}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`);
    return res.json({ ok: true, user: { id: user.id, username: user.username, is_guest: 1 } });
  } catch (err) {
    console.error('[guest]', err.message);
    return res.status(500).json({ error: 'Failed to create guest session' });
  }
});

/**
 * POST /auth/logout
 */
app.post('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`);
  res.json({ ok: true });
});

/**
 * GET /auth/me
 * Returns current user info or 401.
 */
app.get('/auth/me', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = findUserById(getDb(), req.userId);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  res.json({ user: { id: user.id, username: user.username, is_guest: user.is_guest } });
});

// ---------------------------------------------------------------------------
// Document management routes (user-scoped)
// ---------------------------------------------------------------------------

/**
 * GET /documents
 * List all documents for the authenticated user.
 */
app.get('/documents', ensureAuth, (req, res) => {
  const db = getDb();
  const docs = db
    .prepare('SELECT id, title, created_at FROM documents WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ documents: docs });
});

/**
 * POST /documents
 * Create a new blank document for the authenticated user.
 * Body: { title }
 */
app.post('/documents', ensureAuth, (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare('INSERT INTO documents (id, user_id, title, root_content) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, title.trim().slice(0, 200), '');
    const doc = db.prepare('SELECT id, title, created_at FROM documents WHERE id = ?').get(id);
    res.status(201).json({ document: doc });
  } catch (err) {
    console.error('[create-doc]', err.message);
    return res.status(500).json({ error: 'Failed to create document' });
  }
});

/**
 * PATCH /documents/:id/title
 * Rename a document. User must own it.
 * Body: { title }
 */
app.patch('/documents/:id/title', ensureAuth, (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: 'title is required' });
  }
  const db = getDb();
  const doc = db.prepare('SELECT id, user_id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(title.trim().slice(0, 200), req.params.id);
  res.json({ ok: true });
});

/**
 * DELETE /documents/:id
 * Delete a document and all its forks. User must own it.
 */
app.delete('/documents/:id', ensureAuth, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, user_id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM forks WHERE document_id = ?').run(req.params.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[delete-doc]', err.message);
    return res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ---------------------------------------------------------------------------
// Document content routes
// ---------------------------------------------------------------------------

/**
 * GET /document/:id/resolved
 * Row-level auth: document must belong to authenticated user (or be legacy).
 */
app.get('/document/:id/resolved', (req, res) => {
  const db = getDb();
  // Allow unauthenticated access to legacy doc for backwards compatibility
  const doc = db.prepare('SELECT id, user_id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (req.userId && doc.user_id !== req.userId && doc.user_id !== 'legacy_user') {
    return res.status(403).json({ error: 'Access denied' });
  }
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
 *
 * Before returning forks, runs repairActiveFlags() so the client always
 * receives at most one is_active=1 fork per (document_id, anchor_start,
 * anchor_end) group, regardless of what stale data exists in the DB.
 */
app.get('/document/:id/tree', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Repair stale is_active flags for this document before returning.
  // Uses a scoped version of the global repair so only this doc is touched.
  try {
    db.prepare(
      `UPDATE forks
         SET is_active = 0, updated_at = datetime('now')
       WHERE document_id = ?
         AND is_active = 1
         AND id NOT IN (
           SELECT id FROM forks keeper
            WHERE keeper.is_active = 1
              AND keeper.document_id  = forks.document_id
              AND keeper.anchor_start = forks.anchor_start
              AND keeper.anchor_end   = forks.anchor_end
              AND keeper.updated_at   = (
                    SELECT MAX(f3.updated_at)
                      FROM forks f3
                     WHERE f3.is_active = 1
                       AND f3.document_id  = forks.document_id
                       AND f3.anchor_start = forks.anchor_start
                       AND f3.anchor_end   = forks.anchor_end
                  )
         )`
    ).run(req.params.id);
  } catch (repairErr) {
    // Non-fatal — log and continue with whatever data exists
    console.warn('[tree] active-flag repair failed:', repairErr.message);
  }

  const forks = db
    .prepare(
      `SELECT id, document_id, parent_fork_id, anchor_start, anchor_end,
              original_snippet, branch_content, why,
              status, is_active, created_at, updated_at,
              consistency_verdict, consistency_note
       FROM forks WHERE document_id = ? ORDER BY created_at ASC`
    )
    .all(req.params.id);
  res.json({ forks });
});

/**
 * PATCH /document/:id/content
 */
app.patch('/document/:id/content', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  const db = getDb();
  const pending = db
    .prepare(`SELECT id FROM forks WHERE document_id = ? AND status = 'proposed' LIMIT 1`)
    .get(req.params.id);
  if (pending) {
    return res.status(409).json({ error: 'Document is locked: a fork is pending review' });
  }
  let result;
  try {
    result = db
      .prepare('UPDATE documents SET root_content = ? WHERE id = ?')
      .run(content, req.params.id);
  } catch (err) {
    console.error('[content] DB write failed:', err.message);
    return res.status(500).json({ error: 'Failed to save content' });
  }
  if (result.changes === 0) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /document/:id/generate-alternative
// ---------------------------------------------------------------------------
app.post('/document/:id/generate-alternative', ensureSession, rateLimitMiddleware, async (req, res) => {
  const startTime = Date.now();
  const { segment_fork_id, anchor_start, anchor_end, selected_text: rawText, instruction: rawInstruction } = req.body;

  const selected_text = sanitizeUserInput(rawText);
  const instruction   = sanitizeUserInput(rawInstruction);

  if (typeof anchor_start !== 'number' || typeof anchor_end !== 'number') {
    return res.status(400).json({ error: 'anchor_start and anchor_end must be numbers' });
  }
  if (anchor_start >= anchor_end) {
    return res.status(400).json({ error: 'anchor_start must be less than anchor_end' });
  }
  if (typeof selected_text !== 'string' || selected_text.trim() === '') {
    return res.status(400).json({ error: 'selected_text must be a non-empty string' });
  }
  if (selected_text.length > 3000) {
    return res.status(400).json({ error: 'Selection too long (max 3000 characters)' });
  }
  if (instruction !== undefined && typeof instruction !== 'string') {
    return res.status(400).json({ error: 'instruction must be a string if provided' });
  }
  if (typeof instruction === 'string' && instruction.length > 500) {
    return res.status(400).json({ error: 'Instruction too long (max 500 characters)' });
  }

  const db = getDb();
  const docId = req.params.id;
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const segments = resolveDocument(docId);
  const owningSegment = segments.find(
    (s) => s.fork_id === (segment_fork_id ?? null) && anchor_start >= s.start && anchor_end <= s.end
  );
  if (!owningSegment) {
    return res.status(400).json({
      error: 'Selection does not fall within a single segment, or segment_fork_id is incorrect',
    });
  }

  const forkId = uuidv4();
  try {
    // Before inserting the new (proposed) fork, mark any existing active sibling
    // at the same anchor as inactive. This ensures that as soon as a new branch
    // is proposed, only the pending one is highlighted — older siblings are inactive.
    // Siblings share (document_id, parent_fork_id, anchor_start, anchor_end).
    db.prepare(
      `UPDATE forks
         SET is_active = 0, updated_at = datetime('now')
       WHERE document_id = ?
         AND anchor_start = ?
         AND anchor_end   = ?
         AND (parent_fork_id IS ? OR (parent_fork_id IS NULL AND ? IS NULL))`
    ).run(docId, anchor_start, anchor_end,
          segment_fork_id ?? null, segment_fork_id ?? null);

    db.prepare(
      `INSERT INTO forks
         (id, document_id, parent_fork_id, anchor_start, anchor_end,
          original_snippet, branch_content, status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, '', 'proposed', 0)`
    ).run(forkId, docId, segment_fork_id ?? null, anchor_start, anchor_end, selected_text);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A fork is already pending for this document' });
    }
    throw err;
  }

  try {
    console.log('[generate-alternative] LLM payload:', {
      selected_text,
      instruction: instruction || undefined,
      anchor_start,
      anchor_end,
      segment_fork_id: segment_fork_id ?? null,
    });
    const alternative = await generateAlternative(selected_text, instruction || undefined);
    db.prepare(
      `UPDATE forks SET branch_content = ?, status = 'proposed', updated_at = datetime('now') WHERE id = ?`
    ).run(alternative, forkId);
    const fork = db.prepare('SELECT * FROM forks WHERE id = ?').get(forkId);
    return res.json({ fork, latencyMs: Date.now() - startTime });
  } catch (err) {
    db.prepare(
      `UPDATE forks SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
    ).run(forkId);
    console.error('[generate-alternative] Granite error:', err.message);
    return res.status(502).json({ error: `Generation failed: ${err.message}`, latencyMs: Date.now() - startTime });
  }
});

const WHY_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// POST /fork/:id/approve
// ---------------------------------------------------------------------------
app.post('/fork/:id/approve', (req, res) => {
  const db = getDb();
  const { id: forkId } = req.params;
  const fork = db
    .prepare(`SELECT id, document_id, parent_fork_id, anchor_start, anchor_end, original_snippet, branch_content FROM forks WHERE id = ?`)
    .get(forkId);
  if (!fork) return res.status(404).json({ error: 'Fork not found' });
  const docId = fork.document_id;

  try {
    // Step 1: Deactivate ALL siblings at the same anchor FIRST.
    // Must run before activating the new fork to avoid tripping the
    // uq_one_active_per_anchor unique index (which allows only one is_active=1
    // per document+anchor_start+anchor_end).
    // Siblings share the same (document_id, parent_fork_id, anchor_start, anchor_end).
    db.prepare(
      `UPDATE forks
         SET is_active = 0, updated_at = datetime('now')
       WHERE document_id = ?
         AND anchor_start = ?
         AND anchor_end   = ?
         AND (parent_fork_id IS ? OR (parent_fork_id IS NULL AND ? IS NULL))
         AND id != ?`
    ).run(docId, fork.anchor_start, fork.anchor_end,
          fork.parent_fork_id, fork.parent_fork_id, forkId);

    // Step 2: Activate this fork and mark it resolved.
    db.prepare(
      `UPDATE forks
         SET status = 'resolved', is_active = 1, updated_at = datetime('now')
       WHERE id = ?`
    ).run(forkId);
  } catch (err) {
    console.error('[approve] DB update failed:', err.message);
    return res.status(500).json({ error: 'Failed to approve fork' });
  }

  res.json({ ok: true });

  draftWhySummary(fork.original_snippet, fork.branch_content)
    .then((why) => {
      const clamped = why.slice(0, WHY_MAX_LENGTH);
      try {
        db.prepare(`UPDATE forks SET why = ?, updated_at = datetime('now') WHERE id = ?`).run(clamped, forkId);
      } catch (dbErr) {
        console.error('[approve] async why DB write failed:', dbErr.message);
      }
    })
    .catch((err) => console.error('[approve] async why-summary failed:', err.message));
});

// ---------------------------------------------------------------------------
// POST /fork/:id/reject
// ---------------------------------------------------------------------------
app.post('/fork/:id/reject', (req, res) => {
  const db = getDb();
  const forkId = req.params.id;
  const fork = db.prepare(`SELECT id FROM forks WHERE id = ?`).get(forkId);
  if (!fork) return res.status(404).json({ error: 'Fork not found' });
  let result;
  try {
    result = db.prepare(
      `UPDATE forks SET status = 'resolved', is_active = 0, updated_at = datetime('now') WHERE id = ? AND status = 'proposed'`
    ).run(forkId);
  } catch (err) {
    console.error('[reject] DB write failed:', err.message);
    return res.status(500).json({ error: 'Failed to reject fork' });
  }
  if (result.changes === 0) return res.status(409).json({ error: 'Fork is not in proposed state' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /fork/:id/cancel
// ---------------------------------------------------------------------------
app.post('/fork/:id/cancel', (req, res) => {
  const db = getDb();
  const forkId = req.params.id;
  let result;
  try {
    result = db.prepare(
      `UPDATE forks SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'proposed'`
    ).run(forkId);
  } catch (err) {
    console.error('[cancel] DB write failed:', err.message);
    return res.status(500).json({ error: 'Failed to cancel fork' });
  }
  if (result.changes === 0) {
    const fork = db.prepare(`SELECT id FROM forks WHERE id = ?`).get(forkId);
    if (!fork) return res.status(404).json({ error: 'Fork not found' });
    return res.status(409).json({ error: 'Fork is not in proposed state' });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /document/:id/force-unlock
// ---------------------------------------------------------------------------
app.post('/document/:id/force-unlock', (req, res) => {
  const db = getDb();
  const docId = req.params.id;
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  let result;
  try {
    result = db.prepare(
      `UPDATE forks SET status = 'failed', updated_at = datetime('now') WHERE document_id = ? AND status = 'proposed'`
    ).run(docId);
  } catch (err) {
    console.error('[force-unlock] DB write failed:', err.message);
    return res.status(500).json({ error: 'Failed to force-unlock document' });
  }
  res.json({ ok: true, forksUnlocked: result.changes });
});

// ---------------------------------------------------------------------------
// POST /fork/:id/switch
// ---------------------------------------------------------------------------
app.post('/fork/:id/switch', (req, res) => {
  const db = getDb();
  const forkId = req.params.id;
  if (!forkId) return res.status(400).json({ error: 'forkId is required' });

  // Step 1 — verify fork exists and is eligible
  const fork = db
    .prepare(`SELECT id, document_id, parent_fork_id, anchor_start, anchor_end, status FROM forks WHERE id = ?`)
    .get(forkId);
  if (!fork) return res.status(404).json({ error: 'Fork not found' });
  if (fork.status !== 'resolved') {
    return res.status(409).json({ error: 'Only resolved forks can be switched to' });
  }
  const pending = db
    .prepare(`SELECT id FROM forks WHERE document_id = ? AND status = 'proposed' LIMIT 1`)
    .get(fork.document_id);
  if (pending) {
    return res.status(409).json({ error: 'Document is locked: a fork is pending review' });
  }

  // Step 2 — two separate prepare().run() calls.
  // node:sqlite's DatabaseSync corrupts internal iterator state when db.exec()
  // is called with multi-statement strings more than once in the same process.
  // Plain prepare().run() calls are safe, repeatable, and auto-committed.
  try {
    // 2a. Deactivate all siblings at the same anchor FIRST (avoid unique index violation).
    // Siblings share (document_id, parent_fork_id, anchor_start, anchor_end).
    db.prepare(
      `UPDATE forks
         SET is_active = 0, updated_at = datetime('now')
       WHERE document_id = ?
         AND anchor_start = ?
         AND anchor_end   = ?
         AND (parent_fork_id IS ? OR (parent_fork_id IS NULL AND ? IS NULL))
         AND id != ?`
    ).run(fork.document_id, fork.anchor_start, fork.anchor_end,
          fork.parent_fork_id, fork.parent_fork_id, forkId);

    // 2b. Activate the target fork
    db.prepare(
      `UPDATE forks SET is_active = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(forkId);
  } catch (err) {
    console.error('[switch] DB update failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to switch branch' });
  }

  // Step 3 — re-fetch segments and the updated forks list so the client can
  // immediately re-render both the editor and the decision tree without a
  // second round-trip.
  let segments;
  try {
    segments = resolveDocument(fork.document_id) ?? [];
  } catch (resolveErr) {
    console.error('[switch] resolve failed after switch:', resolveErr.message);
    segments = [];
  }

  const updatedForks = db
    .prepare(
      `SELECT id, document_id, parent_fork_id, anchor_start, anchor_end,
              original_snippet, branch_content, why,
              status, is_active, created_at, updated_at,
              consistency_verdict, consistency_note
       FROM forks WHERE document_id = ? ORDER BY created_at ASC`
    )
    .all(fork.document_id);

  res.json({ ok: true, activeForkId: forkId, segments, forks: updatedForks });
});

// ---------------------------------------------------------------------------
// POST /fork/:id/why
// ---------------------------------------------------------------------------
app.post('/fork/:id/why', ensureSession, rateLimitMiddleware, async (req, res) => {
  const startTime = Date.now();
  const db = getDb();
  const forkId = req.params.id;
  const fork = db
    .prepare(`SELECT id, original_snippet, branch_content, why FROM forks WHERE id = ?`)
    .get(forkId);
  if (!fork) return res.status(404).json({ error: 'Fork not found' });

  if (req.body && typeof req.body.why === 'string') {
    const manualWhy = req.body.why.trim();
    if (manualWhy.length > WHY_MAX_LENGTH) {
      return res.status(400).json({ error: `why must be ${WHY_MAX_LENGTH} characters or fewer` });
    }
    try {
      db.prepare(`UPDATE forks SET why = ?, updated_at = datetime('now') WHERE id = ?`).run(manualWhy || null, forkId);
      const updated = db.prepare(`SELECT id, why FROM forks WHERE id = ?`).get(forkId);
      return res.json({ fork: updated, latencyMs: Date.now() - startTime });
    } catch (err) {
      console.error('[why] manual DB write failed:', err.message);
      return res.status(500).json({ error: 'Failed to save why text' });
    }
  }

  try {
    const why = await draftWhySummary(fork.original_snippet, fork.branch_content);
    const clamped = why.slice(0, WHY_MAX_LENGTH);
    db.prepare(`UPDATE forks SET why = ?, updated_at = datetime('now') WHERE id = ?`).run(clamped, forkId);
    const updated = db.prepare(`SELECT id, why FROM forks WHERE id = ?`).get(forkId);
    return res.json({ fork: updated, latencyMs: Date.now() - startTime });
  } catch (err) {
    console.error('[why] error:', err.message);
    return res.status(502).json({ error: `Why generation failed: ${err.message}`, latencyMs: Date.now() - startTime });
  }
});

// ---------------------------------------------------------------------------
// POST /suggest-chips  — toolbar AI chip generation
// ---------------------------------------------------------------------------
app.post('/suggest-chips', ensureSession, rateLimitMiddleware, async (req, res) => {
  const startTime = Date.now();
  const rawText = req.body?.selected_text;
  const selected_text = sanitizeUserInput(rawText);

  if (typeof selected_text !== 'string' || selected_text.trim() === '') {
    return res.status(400).json({ error: 'selected_text must be a non-empty string' });
  }
  if (selected_text.length > 2000) {
    return res.status(400).json({ error: 'selected_text too long (max 2000 chars)' });
  }

  try {
    const chips = await suggestChips(selected_text.trim());
    return res.json({ chips, latencyMs: Date.now() - startTime });
  } catch (err) {
    console.error('[suggest-chips] error:', err.message);
    return res.status(502).json({ error: `Chip generation failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /document/:id/check-consistency
// ---------------------------------------------------------------------------
app.post('/document/:id/check-consistency', async (req, res) => {
  const db = getDb();
  const docId = req.params.id;
  const doc = db.prepare('SELECT id FROM documents WHERE id = ?').get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const pending = db
    .prepare(`SELECT id FROM forks WHERE document_id = ? AND status = 'proposed' LIMIT 1`)
    .get(docId);
  if (pending) return res.status(409).json({ error: 'Document is locked: a fork is pending review' });
  const segments = resolveDocument(docId);
  if (!segments) return res.status(404).json({ error: 'Document not found' });
  const resolvedText = segments.map((s) => s.text).join('');
  const decisions = db
    .prepare(
      `SELECT id, why FROM forks
       WHERE document_id = ? AND is_active = 1 AND status = 'resolved' AND why IS NOT NULL
       ORDER BY created_at ASC`
    )
    .all(docId);
  if (decisions.length === 0) return res.json({ findings: [] });

  // Collect fork ids that have already been reviewed so we can skip them
  const reviewedIds = new Set(
    db.prepare(
      `SELECT id FROM forks
       WHERE document_id = ? AND consistency_verdict IS NOT NULL`
    ).all(docId).map((r) => r.id)
  );

  try {
    const allFindings = await checkConsistency(resolvedText, decisions);
    // Filter out findings that were already resolved/dismissed in a prior check
    const findings = allFindings.filter((f) => !reviewedIds.has(f.fork_id));
    return res.json({ findings });
  } catch (err) {
    console.error('[check-consistency] Granite error:', err.message);
    return res.status(502).json({ error: `Consistency check failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// PATCH /fork/:id/consistency
// ---------------------------------------------------------------------------
app.patch('/fork/:id/consistency', (req, res) => {
  const db = getDb();
  const forkId = req.params.id;
  const { verdict, note } = req.body;
  if (verdict !== 'intentional' && verdict !== 'flagged') {
    return res.status(400).json({ error: 'verdict must be "intentional" or "flagged"' });
  }
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string if provided' });
    if (note.length > 2000) return res.status(400).json({ error: 'note must be 2000 characters or fewer' });
  }
  const fork = db
    .prepare(`SELECT id, document_id, consistency_verdict FROM forks WHERE id = ?`)
    .get(forkId);
  if (!fork) return res.status(404).json({ error: 'Fork not found' });
  const pending = db
    .prepare(`SELECT id FROM forks WHERE document_id = ? AND status = 'proposed' LIMIT 1`)
    .get(fork.document_id);
  if (pending) return res.status(409).json({ error: 'Document is locked: a fork is pending review' });
  if (fork.consistency_verdict !== null && fork.consistency_verdict !== undefined) {
    return res.json({ ok: true, skipped: true });
  }
  try {
    db.prepare(
      `UPDATE forks SET consistency_verdict = ?, consistency_note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(verdict, note ?? null, forkId);
  } catch (err) {
    console.error('[consistency] DB write failed:', err.message);
    return res.status(500).json({ error: 'Failed to save consistency verdict' });
  }
  const updated = db
    .prepare(`SELECT id, consistency_verdict, consistency_note FROM forks WHERE id = ?`)
    .get(forkId);
  res.json({ ok: true, fork: updated });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const db = getDb();
  ensureLegacyData(db);           // keep old hardcoded doc working
  // Run active-flag repair after ensureLegacyData (which may seed rows) so any
  // seeded conflicts are also cleaned up at startup.
  repairActiveFlags(db);
  console.log(`Throughline server on http://localhost:${PORT}`);
});
