'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getDb } = require('./src/db');
const { v4: uuidv4 } = require('uuid');

const BASE = 'http://localhost:3001';
const DOC  = 'doc_hardcoded_001';

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function run() {
  let pass = 0; let fail = 0;

  function check(label, cond, detail) {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else       { console.log(`  ✗ ${label} — ${detail}`); fail++; }
  }

  const db = getDb();

  function insertFork(anchorStart, anchorEnd, originalSnippet, branchContent) {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO forks
         (id, document_id, parent_fork_id, anchor_start, anchor_end,
          original_snippet, branch_content, status, is_active)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'proposed', 0)`
    ).run(id, DOC, anchorStart, anchorEnd, originalSnippet, branchContent);
    return id;
  }

  function getStatus(id) {
    return db.prepare('SELECT status, is_active FROM forks WHERE id = ?').get(id);
  }

  // ------------------------------------------------------------------
  // 1. force-unlock — no proposed forks (should unlock 0)
  // ------------------------------------------------------------------
  console.log('\n1. force-unlock (no pending forks)');
  {
    const { status, body } = await post(`/document/${DOC}/force-unlock`);
    check('HTTP 200', status === 200, status);
    check('forksUnlocked = 0', body.forksUnlocked === 0, body.forksUnlocked);
  }

  // ------------------------------------------------------------------
  // 2. cancel — marks proposed fork as failed
  // ------------------------------------------------------------------
  console.log('\n2. cancel');
  {
    const id = insertFork(4, 11, 'morning', '');
    const { status, body } = await post(`/fork/${id}/cancel`);
    const row = getStatus(id);
    check('HTTP 200', status === 200, status);
    check('ok: true', body.ok === true, JSON.stringify(body));
    check('status = failed', row.status === 'failed', row.status);
    check('is_active = 0', row.is_active === 0, row.is_active);
  }

  // ------------------------------------------------------------------
  // 3. cancel on non-proposed fork → 409
  // ------------------------------------------------------------------
  console.log('\n3. cancel already-failed fork → 409');
  {
    const id = insertFork(4, 11, 'morning', '');
    db.prepare(`UPDATE forks SET status = 'failed' WHERE id = ?`).run(id);
    const { status, body } = await post(`/fork/${id}/cancel`);
    check('HTTP 409', status === 409, status);
    check('error present', typeof body.error === 'string', JSON.stringify(body));
  }

  // ------------------------------------------------------------------
  // 4. approve — status=resolved, is_active=1
  // ------------------------------------------------------------------
  console.log('\n4. approve');
  {
    const id = insertFork(4, 11, 'morning', 'dawn');
    const { status, body } = await post(`/fork/${id}/approve`);
    const row = getStatus(id);
    check('HTTP 200', status === 200, status);
    check('ok: true', body.ok === true, JSON.stringify(body));
    check('status = resolved', row.status === 'resolved', row.status);
    check('is_active = 1', row.is_active === 1, row.is_active);
  }

  // ------------------------------------------------------------------
  // 5. reject — status=resolved, is_active stays 0
  // ------------------------------------------------------------------
  console.log('\n5. reject');
  {
    const id = insertFork(12, 20, 'morning light', 'cold light');
    const { status, body } = await post(`/fork/${id}/reject`);
    const row = getStatus(id);
    check('HTTP 200', status === 200, status);
    check('ok: true', body.ok === true, JSON.stringify(body));
    check('status = resolved', row.status === 'resolved', row.status);
    check('is_active = 0', row.is_active === 0, row.is_active);
  }

  // ------------------------------------------------------------------
  // 6. force-unlock — with one proposed fork present
  // ------------------------------------------------------------------
  console.log('\n6. force-unlock (one pending fork)');
  {
    const id = insertFork(0, 4, 'The ', 'A ');
    const { status, body } = await post(`/document/${DOC}/force-unlock`);
    const row = getStatus(id);
    check('HTTP 200', status === 200, status);
    check('forksUnlocked = 1', body.forksUnlocked === 1, body.forksUnlocked);
    check('fork now failed', row.status === 'failed', row.status);
  }

  // ------------------------------------------------------------------
  // 7. no proposed forks remain
  // ------------------------------------------------------------------
  console.log('\n7. no proposed forks remain');
  {
    const remaining = db.prepare(
      `SELECT COUNT(*) as n FROM forks WHERE document_id = ? AND status = 'proposed'`
    ).get(DOC);
    check('0 proposed forks', remaining.n === 0, remaining.n);
  }

  console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
