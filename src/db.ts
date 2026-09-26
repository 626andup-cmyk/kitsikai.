/**
 * The database: where everything is stored, and how its layout is kept up
 * to date.
 *
 * Kitsikai uses SQLite, a database that lives in a single file
 * (`data/kitsikai.db`) and is built into Bun, so there is nothing to install
 * or run alongside the server. (Same as Aettica.)
 *
 * A database stores data in *tables*. Each table has fixed *columns*, and
 * each item is a *row*. Tables point at each other through ids:
 *
 *   channels ──< messages
 *
 * reads as "a channel has many messages". Each message row stores its
 * channel's id (`channel_id`).
 *
 * This file only knows about the *layout* of the tables. Reading and
 * writing actual data happens in `src/store.ts` and the files it uses.
 */

import { Database } from "bun:sqlite";

/**
 * Every change ever made to the database layout, oldest first.
 *
 * A *migration* is a step that moves the layout from one version to the
 * next. SQLite keeps a version number in the file itself (`user_version`).
 * On startup, any migrations newer than that number run, in order, and the
 * number is updated. So an old database is upgraded automatically, and a new
 * one is built by running every step from the start.
 *
 * Never edit a migration once it has been released: databases that already
 * ran it won't run it again. Add a new one to the end instead. Each build
 * stage adds its own.
 */
export type Migration = string | ((db: Database) => void);

export const MIGRATIONS: Migration[] = [
  // ---------------------------------------------------------------- 1
  // Stage 1: settings, channels, messages, and connection profiles.
  `
  -- App-wide settings as key/value pairs. Each value is stored as JSON,
  -- so numbers stay numbers and text stays text.
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    -- What kind of channel. CHECK makes the database itself refuse any
    -- other value. Stage 1 only uses 'text'; the planner and trackers
    -- screens come in stages 3 and 5.
    kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'planner', 'trackers')),
    position   INTEGER NOT NULL,
    -- The channel's own theme, or NULL for the app theme.
    theme      TEXT,
    -- The channel's own profile or roulette ("profile:<id>" or
    -- "roulette:<id>"), or NULL for the app-wide chat assignment.
    assignment TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    -- seq counts up by one for every message ever saved, so ordering by it
    -- gives the order messages were written in.
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    -- REFERENCES ties each message to a real channel. ON DELETE CASCADE
    -- means deleting a channel deletes its messages too.
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author     TEXT NOT NULL CHECK (author IN ('user', 'kitsikai')),
    content    TEXT NOT NULL,
    -- Messages written together (the bubbles of one reply) share a turn id.
    turn_id    TEXT,
    created_at TEXT NOT NULL,
    edited_at  TEXT,
    -- Her messages: the model and the connection profile that wrote them.
    model      TEXT,
    profile    TEXT
  );

  -- An index is like the index at the back of a book: it lets SQLite jump
  -- straight to one channel's messages instead of reading every message.
  CREATE INDEX messages_by_channel ON messages (channel_id, seq);

  -- A connection profile: one model and its settings (see src/profiles.ts).
  CREATE TABLE profiles (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    model            TEXT NOT NULL,
    temperature      REAL NOT NULL,
    max_tokens       INTEGER NOT NULL,
    top_p            REAL,
    reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high')),
    -- SQLite has no true/false type: 1 is true, 0 is false.
    supports_tools   INTEGER NOT NULL DEFAULT 1,
    quirk_prompt     TEXT NOT NULL DEFAULT '',
    extra_params     TEXT NOT NULL DEFAULT '',
    position         INTEGER NOT NULL,
    created_at       TEXT NOT NULL
  );

  -- A roulette: a weighted set of profiles.
  CREATE TABLE roulettes (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE roulette_profiles (
    roulette_id TEXT NOT NULL REFERENCES roulettes (id) ON DELETE CASCADE,
    profile_id  TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    weight      REAL NOT NULL CHECK (weight > 0),
    PRIMARY KEY (roulette_id, profile_id)
  );
  `,

  // ---------------------------------------------------------------- 2
  // Stage 2: channel topics. (Bubbles need no new columns: the bubbles of
  // one reply are messages sharing a turn id, which stage 1 already has.)
  //
  // ALTER TABLE ... ADD COLUMN adds a column to an existing table. Every
  // existing row gets the DEFAULT value, so old data stays valid.
  `
  ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT '';
  `,

  // ---------------------------------------------------------------- 3
  // Stage 3: the planner. A plan is anything planned, on a day, maybe at a
  // time; shifts and events are the same record with different kinds.
  // Dates and times are the phone's local time, stored as text
  // ("2026-09-28", "22:00"); see src/dates.ts.
  (db) => {
    db.exec(`
    CREATE TABLE plans (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('shift', 'appointment', 'birthday', 'hangout', 'other')),
      title       TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      -- NULL: all day.
      start_time  TEXT,
      -- The end has its own date, so overnight shifts (10pm to 6am) work.
      end_date    TEXT,
      end_time    TEXT,
      repeats     TEXT NOT NULL DEFAULT 'never' CHECK (repeats IN ('never', 'weekly', 'yearly')),
      -- This plan's own reminders as a JSON list, or NULL for its kind's defaults.
      reminders   TEXT,
      -- Whether you've confirmed it.
      checked     INTEGER NOT NULL DEFAULT 0,
      -- Shifts only.
      shift_type  TEXT CHECK (shift_type IN ('regular', 'meeting', 'oncall')),
      -- Regular shifts only. Draw TIME is never stored: it's always
      -- calculated from these, so it can't disagree with them.
      draw_start  TEXT,
      draw_end    TEXT,
      notes       TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'screenshot', 'chat')),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX plans_by_date ON plans (start_date);
    `);

    // The planner is a channel type. An existing server gets a planner
    // channel at the bottom of its list. (A brand-new one gets it when it's
    // first filled in; see Store.seed.)
    const { count } = db.query("SELECT COUNT(*) AS count FROM channels").get() as { count: number };
    if (count > 0) {
      db.query(
        `INSERT INTO channels (id, name, kind, position, created_at)
         VALUES (?, 'planner', 'planner', (SELECT MAX(position) + 1 FROM channels), ?)`,
      ).run(crypto.randomUUID(), new Date().toISOString());
    }
  },
];

/**
 * Open (or create) the database file and bring its layout up to date.
 *
 * @param path  File path, or `":memory:"` for a throwaway in-memory database.
 */
export function openDatabase(path: string): Database {
  // `strict: true` lets queries use `$name` placeholders filled from plain
  // objects like `{ name: "general" }`, and makes a missing value an error.
  const db = new Database(path, { create: true, strict: true });

  // SQLite doesn't enforce REFERENCES unless asked to, once per connection.
  db.exec("PRAGMA foreign_keys = ON");
  // WAL ("write-ahead log") mode makes saves faster and safer if the phone
  // dies mid-write. It adds `-wal` and `-shm` files next to the database;
  // they belong to it, so copy all three if you back up while the server runs.
  db.exec("PRAGMA journal_mode = WAL");

  migrate(db);
  return db;
}

/** Run any migrations the database hasn't had yet. */
function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number };

  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database was created by a newer version of Kitsikai (layout version ${current}, ` +
        `this version knows up to ${MIGRATIONS.length}). Update Kitsikai before opening it.`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version++) {
    // A transaction makes the whole step happen completely or not at all, so
    // a crash can't leave the database half-upgraded.
    db.transaction(() => {
      const step = MIGRATIONS[version]!;
      if (typeof step === "string") db.exec(step);
      else step(db);
      // PRAGMA doesn't accept placeholders, but `version + 1` is our own
      // number, so building the text directly is safe here.
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}

/** The latest layout version. Exported for tests. */
export const SCHEMA_VERSION = MIGRATIONS.length;
