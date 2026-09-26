/**
 * Reminders, sent (stage 8), on-call shifts you've been called in to, and
 * the texting-first log.
 *
 * Stage 3 worked out *when* each plan's reminders go off (a day before, two
 * hours before...), moved earlier when they'd land during work. This file
 * finds the ones that are **due**, the ones that have gone off and haven't
 * been dealt with, and remembers what happened to each, so every reminder
 * goes out once:
 *
 *   - `sent`:    she texted it (or mentioned it in a conversation)
 *   - `skipped`: you'd just talked about it, so she didn't need to
 *   - `queued`:  every channel was mid-conversation, so it's waiting to be
 *                mentioned in the one you're in ("oh btw, dentist in 2 hours")
 *
 * A reminder stops being due once its plan has started (or, for an all-day
 * plan, once the day is over), or a day after it went off: a reminder the
 * server missed while the phone was off isn't sent days late.
 *
 * Due reminders are always in her prompt too, so she can work one into a
 * conversation that's already going.
 */

import type { Database } from "bun:sqlite";
import { dayName } from "./binder.ts";
import { addDays, dateOf, shortTime, toMoment, type LocalDate } from "./dates.ts";
import type { Store } from "./store.ts";
import type { DueReminder, Occurrence, ProactiveLogEntry, ReminderRecord } from "./types.ts";

/** A reminder older than this (hours) isn't due any more. */
export const REMINDER_STALE_HOURS = 24;

const KIND_WORDS: Record<string, string> = { appointment: "appointment", birthday: "birthday", hangout: "hangout", other: "plan", shift: "shift" };

/** "today at 3:00p", "tomorrow (all day)", "on Sat, Oct 3 at 7:00p". */
export function whenWords(o: Occurrence, today: LocalDate): string {
  const day = o.date === today ? "today" : o.date === addDays(today, 1) ? "tomorrow" : `on ${dayName(o.date)}`;
  return o.startTime ? `${day} at ${shortTime(o.startTime)}` : `${day} (all day)`;
}

/** "Dentist (appointment), today at 3:00p". */
export function reminderText(o: Occurrence, today: LocalDate): string {
  return `${o.plan.title} (${KIND_WORDS[o.plan.kind]}), ${whenWords(o, today)}`;
}

interface RecordRow {
  key: string;
  plan_id: string;
  text: string;
  status: ReminderRecord["status"];
  channel_id: string | null;
  message_id: string | null;
  reason: string;
  due_at: string;
  updated_at: string;
}

function toRecord(row: RecordRow): ReminderRecord {
  return {
    key: row.key,
    planId: row.plan_id,
    text: row.text,
    status: row.status,
    channelId: row.channel_id,
    messageId: row.message_id,
    reason: row.reason,
    dueAt: row.due_at,
    updatedAt: row.updated_at,
  };
}

/** What happened to each reminder, and on-call shifts you were called in to. */
export class Reminders {
  constructor(private readonly db: Database) {}

  get(key: string): ReminderRecord | null {
    const row = this.db.query("SELECT * FROM reminders_sent WHERE key = $key").get({ key }) as RecordRow | null;
    return row ? toRecord(row) : null;
  }

  /** Record what happened to a reminder. */
  record(
    reminder: Pick<DueReminder, "key" | "occurrence" | "text" | "at">,
    status: ReminderRecord["status"],
    details: { channelId?: string | null; messageId?: string | null; reason?: string },
    now: Date,
  ): ReminderRecord {
    this.db
      .query(
        `INSERT INTO reminders_sent (key, plan_id, text, status, channel_id, message_id, reason, due_at, updated_at)
         VALUES ($key, $planId, $text, $status, $channelId, $messageId, $reason, $dueAt, $time)
         ON CONFLICT (key) DO UPDATE SET status = excluded.status, channel_id = excluded.channel_id,
           message_id = excluded.message_id, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run({
        key: reminder.key,
        planId: reminder.occurrence.plan.id,
        text: reminder.text,
        status,
        channelId: details.channelId ?? null,
        messageId: details.messageId ?? null,
        reason: details.reason ?? "",
        dueAt: reminder.at,
        time: now.toISOString(),
      });
    return this.get(reminder.key)!;
  }

  /** The newest records, newest first (for the advanced page). */
  recent(limit = 50): ReminderRecord[] {
    const rows = this.db.query("SELECT * FROM reminders_sent ORDER BY updated_at DESC LIMIT $limit").all({ limit }) as RecordRow[];
    return rows.map(toRecord);
  }

  // ------------------------------------------------------------ on call

  /** You got called in to an on-call occurrence (`planId:date`). */
  callIn(key: string, now: Date): void {
    this.db
      .query("INSERT INTO called_in (key, called_at) VALUES ($key, $time) ON CONFLICT (key) DO UPDATE SET done_at = NULL")
      .run({ key, time: now.toISOString() });
  }

  /** You said you're done with work. */
  doneWith(key: string, now: Date): void {
    this.db.query("UPDATE called_in SET done_at = $time WHERE key = $key").run({ key, time: now.toISOString() });
  }

  /** On-call occurrences you're called in to and haven't finished. */
  calledIn(): Set<string> {
    const rows = this.db.query("SELECT key FROM called_in WHERE done_at IS NULL").all() as { key: string }[];
    return new Set(rows.map((r) => r.key));
  }
}

/**
 * The reminders that are due right now: gone off, not yet sent or skipped,
 * before their plan starts, and not stale. Queued ones are still due (they
 * haven't been mentioned yet), with the channel they're queued in.
 */
export function dueReminders(store: Store, now: Date): DueReminder[] {
  const today = dateOf(now);
  const occurrences = store.plans.occurrences(addDays(today, -1), addDays(today, 8), { calledIn: store.reminders.calledIn() });
  const due: DueReminder[] = [];
  for (const o of occurrences) {
    // When the plan starts: its start time, or the end of an all-day plan's day.
    const starts = o.startTime ? toMoment(o.date, o.startTime) : toMoment(addDays(o.endDate ?? o.date, 1), "00:00");
    if (now >= starts) continue;
    // Only the latest reminder that's gone off: a missed "day before" is
    // replaced by "2 hours before", not sent alongside it.
    const latest = o.reminders
      .map((reminder) => ({ reminder, at: toMoment(reminder.date, reminder.time) }))
      .filter(({ at }) => at <= now && now.getTime() - at.getTime() <= REMINDER_STALE_HOURS * 3600_000)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (!latest) continue;
    const key = `${o.key}:${latest.reminder.id}`;
    const record = store.reminders.get(key);
    if (record && record.status !== "queued") continue;
    due.push({ key, occurrence: o, reminder: latest.reminder, at: latest.at.toISOString(), text: reminderText(o, today), queuedIn: record?.channelId ?? null });
  }
  return due.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The prompt's "Reminders due" section: always in view. Reminders queued in
 * this channel are to be mentioned now; the others, if they fit.
 */
export function remindersForPrompt(due: DueReminder[], channelId: string): string | null {
  if (due.length === 0) return null;
  const here = due.filter((r) => r.queuedIn === channelId);
  const others = due.filter((r) => r.queuedIn !== channelId);
  const parts: string[] = [];
  if (here.length) {
    parts.push(
      [
        "Mention these now, naturally, in what you write (\"oh btw, dentist in 2 hours\"), in your own words, not like a notification:",
        ...here.map((r) => `- ${r.text} (${r.reminder.label.toLowerCase()} reminder)`),
      ].join("\n"),
    );
  }
  if (others.length) {
    parts.push(
      [
        "Reminders that are due. If one fits naturally into what you're writing now, mention it, in your own words:",
        ...others.map((r) => `- ${r.text} (${r.reminder.label.toLowerCase()} reminder)`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ------------------------------------------------------ texting-first log

interface LogRow {
  id: string;
  trigger: ProactiveLogEntry["trigger"];
  outcome: ProactiveLogEntry["outcome"];
  reason: ProactiveLogEntry["reason"];
  channel_id: string | null;
  message_id: string | null;
  detail: string;
  key: string | null;
  created_at: string;
}

function toLogEntry(row: LogRow): ProactiveLogEntry {
  return {
    id: row.id,
    trigger: row.trigger,
    outcome: row.outcome,
    reason: row.reason,
    channelId: row.channel_id,
    messageId: row.message_id,
    detail: row.detail,
    key: row.key,
    createdAt: row.created_at,
  };
}

/** How long the texting-first log is kept, in days. */
const LOG_DAYS = 14;

/** What each snapshot check decided, and why (src/proactive.ts). */
export class ProactiveLog {
  constructor(private readonly db: Database) {}

  add(entry: Omit<ProactiveLogEntry, "id" | "createdAt">, now: Date): ProactiveLogEntry {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO proactive_log (id, trigger, outcome, reason, channel_id, message_id, detail, key, created_at)
         VALUES ($id, $trigger, $outcome, $reason, $channelId, $messageId, $detail, $key, $time)`,
      )
      .run({ id, ...entry, time: now.toISOString() });
    // Old checks aren't interesting: keep two weeks.
    this.db.query("DELETE FROM proactive_log WHERE created_at < $cutoff").run({ cutoff: new Date(now.getTime() - LOG_DAYS * 86_400_000).toISOString() });
    return toLogEntry(this.db.query("SELECT * FROM proactive_log WHERE id = $id").get({ id }) as LogRow);
  }

  /** The newest entries, newest first. */
  recent(limit = 50): ProactiveLogEntry[] {
    const rows = this.db.query("SELECT * FROM proactive_log ORDER BY created_at DESC, rowid DESC LIMIT $limit").all({ limit }) as LogRow[];
    return rows.map(toLogEntry);
  }

  /** Whether a check-in (or anything with a key) already happened. */
  has(key: string): boolean {
    return this.db.query("SELECT 1 FROM proactive_log WHERE key = $key AND outcome = 'sent'").get({ key }) !== null;
  }

  /** Messages she texted first since a time: her unanswered run, for the double-text cap. */
  sentSince(since: string): ProactiveLogEntry[] {
    const rows = this.db
      .query("SELECT * FROM proactive_log WHERE outcome = 'sent' AND created_at > $since ORDER BY created_at")
      .all({ since }) as LogRow[];
    return rows.map(toLogEntry);
  }
}
