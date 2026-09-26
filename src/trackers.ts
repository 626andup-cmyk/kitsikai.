/**
 * Trackers and log entries (stage 5): data you define yourself.
 *
 * The binder (DESIGN.md) holds three kinds of record: **plans** are what you
 * plan (stage 3), **trackers** are what to watch for, and **log entries**
 * are what actually happened.
 *
 * A tracker is something you've asked her to keep an eye out for: a
 * headache, taking your meds, payday. You decide its name, what kind of
 * value it records (yes/no, a 1 to 10 scale, or a note), a few hint words,
 * and whether she may bring it up.
 *
 * A log entry is a sticker on a day: this tracker, this date, this value.
 * In this stage you add them yourself, in the trackers channel or on a
 * calendar day. From stage 7, she notices things in chat and adds them too
 * (after checking), and each entry remembers the message it came from.
 *
 * The new concept is **user-defined data**: the app doesn't know in advance
 * what you'll track, so the values have to be checked against the rules of
 * the tracker they belong to (`checkValue`).
 */

import type { Database } from "bun:sqlite";
import { isDate } from "./dates.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { LogEntry, LogSource, Tracker, TrackerKind } from "./types.ts";

export const TRACKER_KINDS: TrackerKind[] = ["yesno", "scale", "note"];
export const LOG_SOURCES: LogSource[] = ["user", "processing", "confirmed"];

const MAX_HINT_WORDS = 20;
const MAX_NOTE = 1000;

// ------------------------------------------------------------ validation

function trackerName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError("A tracker needs a name.");
  if (value.trim().length > 60) throw new ValidationError("A tracker's name can be 60 characters at most.");
  return value.trim();
}

/** Hint words: a list of short words or phrases, with no blanks or repeats. */
function hintWords(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValidationError("hintWords must be a list of words");
  const words = [...new Set(value.map((w) => (typeof w === "string" ? w.trim().toLowerCase() : "")).filter(Boolean))];
  if (words.length > MAX_HINT_WORDS) throw new ValidationError(`A tracker can have ${MAX_HINT_WORDS} hint words at most.`);
  if (words.some((w) => w.length > 50)) throw new ValidationError("Hint words can be 50 characters at most.");
  return words;
}

/**
 * Check a value against its tracker's kind, and tidy it: "Yes" becomes
 * "yes", " 7 " becomes "7".
 */
export function checkValue(kind: TrackerKind, value: unknown): string {
  if (kind === "yesno") {
    const text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "").trim().toLowerCase();
    if (text !== "yes" && text !== "no") throw new ValidationError('A yes/no tracker\'s value must be "yes" or "no".');
    return text;
  }
  if (kind === "scale") {
    const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isInteger(number) || number < 1 || number > 10) {
      throw new ValidationError("A scale tracker's value must be a whole number from 1 to 10.");
    }
    return String(number);
  }
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError("A note can't be empty.");
  if (value.trim().length > MAX_NOTE) throw new ValidationError(`A note can be ${MAX_NOTE} characters at most.`);
  return value.trim();
}

// --------------------------------------------------------------- mapping

interface TrackerRow {
  id: string;
  name: string;
  kind: TrackerKind;
  hint_words: string;
  can_bring_up: number;
  position: number;
  created_at: string;
}

interface EntryRow {
  id: string;
  tracker_id: string;
  date: string;
  value: string;
  source: LogSource;
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

function toTracker(row: TrackerRow): Tracker {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hintWords: JSON.parse(row.hint_words) as string[],
    canBringUp: row.can_bring_up === 1,
    position: row.position,
    createdAt: row.created_at,
  };
}

function toEntry(row: EntryRow): LogEntry {
  return {
    id: row.id,
    trackerId: row.tracker_id,
    date: row.date,
    value: row.value,
    source: row.source,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -------------------------------------------------------------- database

/** What you give when adding a log entry. */
export interface NewEntry {
  trackerId: string;
  date: string;
  value: unknown;
  source?: LogSource;
  messageId?: string | null;
}

export class Trackers {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------ trackers

  /** Every tracker, in order. */
  list(): Tracker[] {
    return (this.db.query("SELECT * FROM trackers ORDER BY position").all() as TrackerRow[]).map(toTracker);
  }

  get(id: string): Tracker {
    const row = this.db.query("SELECT * FROM trackers WHERE id = $id").get({ id }) as TrackerRow | null;
    if (!row) throw new NotFoundError("tracker");
    return toTracker(row);
  }

  /** Make a tracker. Only its name and kind are needed. */
  create(input: Record<string, unknown>): Tracker {
    const name = trackerName(input.name);
    if (!TRACKER_KINDS.includes(input.kind as TrackerKind)) {
      throw new ValidationError(`kind must be one of: ${TRACKER_KINDS.join(", ")}`);
    }
    if (input.canBringUp !== undefined && typeof input.canBringUp !== "boolean") {
      throw new ValidationError("canBringUp must be true or false");
    }
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM trackers").get() as { next: number };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO trackers (id, name, kind, hint_words, can_bring_up, position, created_at)
         VALUES ($id, $name, $kind, $hintWords, $canBringUp, $position, $now)`,
      )
      .run({
        id,
        name,
        kind: input.kind as TrackerKind,
        hintWords: JSON.stringify(input.hintWords === undefined ? [] : hintWords(input.hintWords)),
        canBringUp: input.canBringUp === false ? 0 : 1,
        position: next,
        now: new Date().toISOString(),
      });
    return this.get(id);
  }

  /**
   * Change a tracker's name, hint words or whether she can bring it up. Its
   * kind can only change while it has no entries, since they'd no longer fit.
   */
  update(id: string, input: Record<string, unknown>): Tracker {
    const current = this.get(id);
    const next = { ...current };
    if (input.name !== undefined) next.name = trackerName(input.name);
    if (input.hintWords !== undefined) next.hintWords = hintWords(input.hintWords);
    if (input.canBringUp !== undefined) {
      if (typeof input.canBringUp !== "boolean") throw new ValidationError("canBringUp must be true or false");
      next.canBringUp = input.canBringUp;
    }
    if (input.kind !== undefined && input.kind !== current.kind) {
      if (!TRACKER_KINDS.includes(input.kind as TrackerKind)) throw new ValidationError(`kind must be one of: ${TRACKER_KINDS.join(", ")}`);
      if (this.entries({ trackerId: id }).length > 0) {
        throw new ValidationError("A tracker's kind can't change once it has entries: they'd no longer fit.");
      }
      next.kind = input.kind as TrackerKind;
    }
    this.db
      .query("UPDATE trackers SET name = $name, kind = $kind, hint_words = $hintWords, can_bring_up = $canBringUp WHERE id = $id")
      .run({ id, name: next.name, kind: next.kind, hintWords: JSON.stringify(next.hintWords), canBringUp: next.canBringUp ? 1 : 0 });
    return this.get(id);
  }

  /** Delete a tracker and, through `ON DELETE CASCADE`, all its entries. */
  delete(id: string): void {
    const result = this.db.query("DELETE FROM trackers WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("tracker");
  }

  // ------------------------------------------------------------- entries

  /** Log entries, newest day first, optionally for one tracker and between two dates. */
  entries(filter: { trackerId?: string; from?: string; to?: string; limit?: number } = {}): LogEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM log_entries
          WHERE ($trackerId IS NULL OR tracker_id = $trackerId)
            AND ($from IS NULL OR date >= $from)
            AND ($to IS NULL OR date <= $to)
          ORDER BY date DESC, created_at DESC
          LIMIT $limit`,
      )
      .all({
        trackerId: filter.trackerId ?? null,
        from: filter.from ?? null,
        to: filter.to ?? null,
        limit: filter.limit ?? 10_000,
      }) as EntryRow[];
    return rows.map(toEntry);
  }

  getEntry(id: string): LogEntry {
    const row = this.db.query("SELECT * FROM log_entries WHERE id = $id").get({ id }) as EntryRow | null;
    if (!row) throw new NotFoundError("log entry");
    return toEntry(row);
  }

  /** Put a sticker on a day. */
  addEntry(input: NewEntry): LogEntry {
    const tracker = this.get(input.trackerId);
    if (!isDate(input.date)) throw new ValidationError("date must be a date like 2026-09-28");
    const source = input.source ?? "user";
    if (!LOG_SOURCES.includes(source)) throw new ValidationError("source must be user, processing or confirmed");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO log_entries (id, tracker_id, date, value, source, message_id, created_at, updated_at)
         VALUES ($id, $trackerId, $date, $value, $source, $messageId, $now, $now)`,
      )
      .run({
        id,
        trackerId: tracker.id,
        date: input.date,
        value: checkValue(tracker.kind, input.value),
        source,
        messageId: input.messageId ?? null,
        now,
      });
    return this.getEntry(id);
  }

  /** Change an entry's day or value. */
  updateEntry(id: string, input: Record<string, unknown>): LogEntry {
    const entry = this.getEntry(id);
    const tracker = this.get(entry.trackerId);
    const date = input.date === undefined ? entry.date : input.date;
    if (!isDate(date)) throw new ValidationError("date must be a date like 2026-09-28");
    const value = input.value === undefined ? entry.value : checkValue(tracker.kind, input.value);
    this.db
      .query("UPDATE log_entries SET date = $date, value = $value, updated_at = $now WHERE id = $id")
      .run({ id, date, value, now: new Date().toISOString() });
    return this.getEntry(id);
  }

  deleteEntry(id: string): void {
    const result = this.db.query("DELETE FROM log_entries WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("log entry");
  }
}
