import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dbDir = process.env.AFK_DB_DIR ?? join(homedir(), '.claude', 'afk')
mkdirSync(dbDir, { recursive: true })
const dbPath = join(dbDir, 'afk.db')

let _db = null

/**
 * Returns the singleton SQLite database connection.
 * Creates and migrates schema on first call.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (_db) return _db
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(db) {
  const SQL = `
    CREATE TABLE IF NOT EXISTS decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      session_id  TEXT NOT NULL,
      tool        TEXT NOT NULL,
      input       TEXT NOT NULL,
      command     TEXT,
      path        TEXT,
      decision    TEXT NOT NULL,
      source      TEXT NOT NULL,
      confidence  REAL,
      rule_id     TEXT,
      reason      TEXT,
      project_cwd TEXT
    );

    CREATE TABLE IF NOT EXISTS deferred (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      session_id   TEXT NOT NULL,
      tool         TEXT NOT NULL,
      input        TEXT NOT NULL,
      command      TEXT,
      path         TEXT,
      decisions_id INTEGER NOT NULL,      -- FK to decisions.id of originating defer row (per design spec §2)
      reviewed     INTEGER DEFAULT 0,
      final        TEXT,
      review_ts    INTEGER
    );

    CREATE TABLE IF NOT EXISTS rules (
      id          TEXT PRIMARY KEY,
      created_ts  INTEGER NOT NULL,
      tool        TEXT NOT NULL,
      pattern     TEXT NOT NULL,
      action      TEXT NOT NULL,
      label       TEXT,
      project     TEXT,
      priority    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      started_ts  INTEGER NOT NULL,
      ended_ts    INTEGER,
      project_cwd TEXT,
      total_req   INTEGER DEFAULT 0,
      auto_allow  INTEGER DEFAULT 0,
      auto_deny   INTEGER DEFAULT 0,
      user_allow  INTEGER DEFAULT 0,
      user_deny   INTEGER DEFAULT 0,
      deferred    INTEGER DEFAULT 0,
      tokens_est  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS baselines (
      project_cwd TEXT NOT NULL,
      tool        TEXT NOT NULL,
      pattern     TEXT NOT NULL,
      count       INTEGER DEFAULT 1,
      last_seen   INTEGER,
      PRIMARY KEY (project_cwd, tool, pattern)
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_tool    ON decisions(tool);
    CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_ts      ON decisions(ts);
    CREATE INDEX IF NOT EXISTS idx_deferred_reviewed ON deferred(reviewed);
    CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_cwd, tool);
  `
  db.transaction(() => db.exec(SQL))()
}
