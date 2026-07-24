// node:sqlite is built into Node ≥ 22.5.0 — no native addon required.
// Suppress the "experimental feature" warning; it's stable enough for this build.
process.removeAllListeners('warning');

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'ledger.db');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    root_content TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS forks (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id),
    parent_fork_id   TEXT REFERENCES forks(id),
    anchor_start     INTEGER NOT NULL,
    anchor_end       INTEGER NOT NULL,
    original_snippet TEXT NOT NULL,
    -- Hard cap: 8 000 chars prevents unbounded AI output from corrupting resolution
    branch_content   TEXT NOT NULL CHECK(length(branch_content) <= 8000),
    why              TEXT CHECK(why IS NULL OR length(why) <= 2000),
    status           TEXT NOT NULL DEFAULT 'proposed'
                       CHECK(status IN ('proposed','resolved','failed')),
    is_active        INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- At most one proposed fork per document (concurrency lock)
  CREATE UNIQUE INDEX IF NOT EXISTS uq_one_proposed_per_doc
    ON forks(document_id)
    WHERE status = 'proposed';

  -- At most one active fork per (document, anchor point)
  CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_per_anchor
    ON forks(document_id, anchor_start, anchor_end)
    WHERE is_active = 1;
`;

// ---------------------------------------------------------------------------
// P5 migration: add consistency columns if they don't already exist.
// ALTER TABLE IF NOT EXISTS … COLUMN is available in SQLite >= 3.37 (2021).
// These are additive-only — no data loss on existing rows.
// ---------------------------------------------------------------------------
const P5_MIGRATION = `
  ALTER TABLE forks ADD COLUMN consistency_verdict TEXT
    CHECK(consistency_verdict IS NULL OR consistency_verdict IN ('intentional','flagged'));
  ALTER TABLE forks ADD COLUMN consistency_note TEXT
    CHECK(consistency_note IS NULL OR length(consistency_note) <= 2000);
`;

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------
const SEED_DOCUMENT_ID = 'doc_hardcoded_001';
const SEED_TITLE = 'My First Document';
const SEED_CONTENT = `The morning light filtered through the half-drawn blinds, casting long amber stripes across the wooden floor. She sat at her desk with a cup of tea that had long gone cold, staring at the blank page in front of her.

There was a story she needed to tell — one she had been carrying for years, turning it over in her mind like a smooth stone worn by river water. But every time she reached for the right first word, it slipped away like a fish darting into deep water.

She picked up her pen anyway. The first sentence didn't have to be perfect. It just had to exist.`;

// ---------------------------------------------------------------------------
// Open / initialise DB (singleton)
// ---------------------------------------------------------------------------
let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    // Keep temp rollback journals in RAM — avoids /tmp disk-space exhaustion.
    // Must be set before any other statement; it's a session pragma, not stored.
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec(SCHEMA);
    runMigrations(db);
    seedDocument(db);
  }
  return db;
}

/**
 * Idempotent schema migrations — each ALTER is wrapped in a try/catch so
 * re-running against a DB that already has the column is a no-op.
 */
function runMigrations(database) {
  const statements = P5_MIGRATION
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    try {
      database.exec(sql);
    } catch (err) {
      // "duplicate column name" means the migration already ran — safe to ignore
      if (!err.message || !err.message.includes('duplicate column name')) {
        throw err;
      }
    }
  }
}

function seedDocument(database) {
  // INSERT ... ON CONFLICT: always upsert title, but only overwrite root_content
  // when it is empty — so real user edits survive restarts while a stale empty
  // seed (written before the content was finalised) gets corrected automatically.
  database
    .prepare(`
      INSERT INTO documents (id, title, root_content) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        root_content = CASE WHEN root_content = '' THEN excluded.root_content ELSE root_content END
    `)
    .run(SEED_DOCUMENT_ID, SEED_TITLE, SEED_CONTENT);
}

module.exports = { getDb, SEED_DOCUMENT_ID };
