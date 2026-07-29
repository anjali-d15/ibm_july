// node:sqlite is built into Node ≥ 22.5.0 — no native addon required.
process.removeAllListeners('warning');

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'ledger.db');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE,
    password_hash TEXT,        -- NULL for guest accounts
    is_guest     INTEGER NOT NULL DEFAULT 0 CHECK(is_guest IN (0,1)),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    title        TEXT NOT NULL,
    root_content TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS forks (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id),
    parent_fork_id   TEXT REFERENCES forks(id),
    anchor_start     INTEGER NOT NULL,
    anchor_end       INTEGER NOT NULL,
    original_snippet TEXT NOT NULL,
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
// Migrations — additive only, each wrapped in try/catch
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  // P5: consistency verdict columns
  `ALTER TABLE forks ADD COLUMN consistency_verdict TEXT
     CHECK(consistency_verdict IS NULL OR consistency_verdict IN ('intentional','flagged'))`,
  `ALTER TABLE forks ADD COLUMN consistency_note TEXT
     CHECK(consistency_note IS NULL OR length(consistency_note) <= 2000)`,
  // Auth migration: add user_id to documents (for existing single-doc installs)
  `ALTER TABLE documents ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy_user'`,
];

// ---------------------------------------------------------------------------
// Starter manuscript content
// ---------------------------------------------------------------------------
const STARTER_MANUSCRIPTS = [
  {
    title: 'The Neon Horizon',
    content: `Rain hammered the cracked polycarbon windows of Sable's apartment on Level 9, forty floors below the corporate towers that scraped the orange clouds. She pressed her palm to the cold glass and watched the neon reflections bleed together in the puddles below — violet, amber, the sick green of the Axiom Corp logo that never slept.

Her neural port itched. It always itched before a job.

"Sable." The voice in her earpiece was Kael's — smooth, corporate-soft in a way that made her teeth ache. "The package goes live in six hours. You either extract it before dawn or we lose it to the purge."

She pulled her hand from the glass and reached for her coat. The city never asked if you were ready. It just kept burning.`,
  },
  {
    title: 'Whispers in the Glass Pavilion',
    content: `The pavilion had stood at the edge of the Aldermere estate for longer than anyone living could remember. Its walls were glass — old glass, the kind that held green shadows and warped the light into slow rivers — and in summer the whole structure seemed to breathe, fogging gently in the morning damp.

Maren found the letters on a Tuesday in late October, tucked behind a loose panel near the east door. Thirty-two of them, bound with a length of faded blue ribbon that left a ghost of color on her fingertips.

She didn't open them right away. She sat for a long time in the pale autumn light, holding the stack in her lap, feeling the weight of someone else's patience.

Some silences, she had learned, deserved to be listened to before they were broken.`,
  },
  {
    title: 'The Ember Citadel',
    content: `The citadel had not burned in three hundred years. That was the first lie Torvyn was taught as a child, sitting on cold stone in the Hall of Remembrance while the fire-scribes chanted the histories with their ember-marked fingers.

The second lie was that the Ashen Queen was dead.

He knew neither truth until the morning the eastern wall cracked open like a wound and something old and vast and smelling of char pulled itself from the rubble — not with violence, but with the terrible patience of something that had simply been waiting for the world to exhaust itself around her.

Torvyn did the only thing a third-year scholar with no sword and very poor judgment could do. He held out his lantern toward the darkness and said, "Can I help you?"`,
  },
];

// ---------------------------------------------------------------------------
// Password hashing (SHA-256, no external dep)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'throughline_salt').digest('hex');
}

// ---------------------------------------------------------------------------
// Open / initialise DB (singleton)
// ---------------------------------------------------------------------------
let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
    runMigrations(db);
  }
  return db;
}

function runMigrations(database) {
  for (const sql of MIGRATIONS) {
    try {
      database.exec(sql);
    } catch (err) {
      // "duplicate column name" or "already exists" means migration already ran
      const msg = err.message || '';
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
        console.warn('[migration] skipped:', msg.slice(0, 80));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

/**
 * Create a new user (registered or guest). Returns the user row.
 * For guests, username is auto-generated, password_hash is null.
 */
function createUser(database, { username, password, isGuest = false }) {
  const id = crypto.randomUUID();
  const password_hash = isGuest ? null : hashPassword(password);
  database
    .prepare(
      `INSERT INTO users (id, username, password_hash, is_guest) VALUES (?, ?, ?, ?)`
    )
    .run(id, username, password_hash, isGuest ? 1 : 0);

  // Seed 3 starter manuscripts into this user's workspace
  seedStarterManuscripts(database, id);

  return database.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Find user by username + password. Returns row or null.
 */
function findUserByCredentials(database, username, password) {
  const hash = hashPassword(password);
  return database
    .prepare('SELECT * FROM users WHERE username = ? AND password_hash = ? AND is_guest = 0')
    .get(username, hash) || null;
}

/**
 * Find user by id.
 */
function findUserById(database, id) {
  return database.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/**
 * Clone 3 starter manuscripts into a user's workspace (idempotent by title+user_id).
 */
function seedStarterManuscripts(database, userId) {
  for (const ms of STARTER_MANUSCRIPTS) {
    const existing = database
      .prepare('SELECT id FROM documents WHERE user_id = ? AND title = ?')
      .get(userId, ms.title);
    if (!existing) {
      database
        .prepare(
          `INSERT INTO documents (id, user_id, title, root_content) VALUES (?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), userId, ms.title, ms.content);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy single-document shim — keeps existing hardcoded doc_id working
// ---------------------------------------------------------------------------
const LEGACY_USER_ID = 'legacy_user';
const SEED_DOCUMENT_ID = 'doc_hardcoded_001';

function ensureLegacyData(database) {
  // Ensure a legacy user row exists
  const legacyUser = database.prepare('SELECT id FROM users WHERE id = ?').get(LEGACY_USER_ID);
  if (!legacyUser) {
    database
      .prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, is_guest) VALUES (?, ?, ?, 0)`)
      .run(LEGACY_USER_ID, 'legacy', null);
  }

  // Patch any documents with empty user_id
  database.exec(`UPDATE documents SET user_id = '${LEGACY_USER_ID}' WHERE user_id = '' OR user_id IS NULL`);

  // Ensure the legacy hardcoded document still exists
  database
    .prepare(`
      INSERT INTO documents (id, user_id, title, root_content) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        root_content = CASE WHEN root_content = '' THEN excluded.root_content ELSE root_content END
    `)
    .run(
      SEED_DOCUMENT_ID,
      LEGACY_USER_ID,
      'My First Document',
      `The morning light filtered through the half-drawn blinds, casting long amber stripes across the wooden floor. She sat at her desk with a cup of tea that had long gone cold, staring at the blank page in front of her.\n\nThere was a story she needed to tell — one she had been carrying for years, turning it over in her mind like a smooth stone worn by river water. But every time she reached for the right first word, it slipped away like a fish darting into deep water.\n\nShe picked up her pen anyway. The first sentence didn't have to be perfect. It just had to exist.`
    );
}

module.exports = {
  getDb,
  createUser,
  findUserByCredentials,
  findUserById,
  seedStarterManuscripts,
  ensureLegacyData,
  hashPassword,
  SEED_DOCUMENT_ID,
  STARTER_MANUSCRIPTS,
};
