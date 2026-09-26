/**
 * Her memory (stage 7): the scratchpad, pins, and the processing log.
 *
 * **Pencil before pen.** Anything she'd save goes on her **scratchpad**
 * first, as a sticky note: "headache 7/10 today", "they mentioned the
 * dentist on Thursday", "they seemed stressed about the new manager". Every
 * few hours she **processes** the pile (src/processing.ts): what's clearly
 * still true is committed to the binder, what's wrong or taken back is
 * tossed, and what she's unsure of she asks you about. That gives
 * misunderstandings a few hours to be corrected, just by talking, before
 * anything becomes "fact".
 *
 * **Pins** are what matters right now ("exam on Friday, they're nervous").
 * They're always in her view, each with a reason and a "when to unpin".
 * Unpinning isn't forgetting: a pin goes back "into the drawer", where her
 * `look_in_drawer` tool can still find it.
 *
 * This file only stores and reads these; the deciding happens in
 * src/scratchpad.ts (during chat) and src/processing.ts (every few hours).
 * Every change is written to the **memory log** with the reason, which is
 * what the advanced page shows. Nothing here is edited by hand: everything
 * changes through her, by talking (DESIGN.md: "look, don't touch").
 *
 * Times come from the caller (`now`), not the system clock, so tests can
 * run a whole day of processing in a moment.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError } from "./errors.ts";
import type {
  MemoryAction,
  MemoryLogEntry,
  Note,
  NoteKind,
  NoteStatus,
  Pin,
  PlanDraft,
  ProcessingRun,
  ProcessingTrigger,
  Settings,
} from "./types.ts";

// --------------------------------------------------------------- mapping

interface NoteRow {
  id: string;
  kind: NoteKind;
  text: string;
  status: NoteStatus;
  origin: Note["origin"];
  yours: number;
  time_sensitive: number;
  confirmed: number;
  tracker_id: string | null;
  value: string | null;
  date: string | null;
  plan_draft: string | null;
  request: Note["request"];
  ask: string | null;
  channel_id: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface PinRow {
  id: string;
  text: string;
  reason: string;
  unpin_when: string;
  unpin_date: string | null;
  status: Pin["status"];
  yours: number;
  note_id: string | null;
  pinned_at: string;
  unpinned_at: string | null;
  unpin_reason: string | null;
}

interface RunRow {
  id: string;
  trigger: ProcessingTrigger;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

interface LogRow {
  id: string;
  run_id: string | null;
  action: MemoryAction;
  text: string;
  reason: string;
  note_id: string | null;
  pin_id: string | null;
  message_id: string | null;
  created_at: string;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    status: row.status,
    origin: row.origin,
    yours: row.yours === 1,
    timeSensitive: row.time_sensitive === 1,
    confirmed: row.confirmed === 1,
    trackerId: row.tracker_id,
    value: row.value,
    date: row.date,
    planDraft: row.plan_draft ? (JSON.parse(row.plan_draft) as PlanDraft) : null,
    request: row.request,
    ask: row.ask,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function toPin(row: PinRow): Pin {
  return {
    id: row.id,
    text: row.text,
    reason: row.reason,
    unpinWhen: row.unpin_when,
    unpinDate: row.unpin_date,
    status: row.status,
    yours: row.yours === 1,
    noteId: row.note_id,
    pinnedAt: row.pinned_at,
    unpinnedAt: row.unpinned_at,
    unpinReason: row.unpin_reason,
  };
}

function toRun(row: RunRow): ProcessingRun {
  return { id: row.id, trigger: row.trigger, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error };
}

function toLog(row: LogRow): MemoryLogEntry {
  return {
    id: row.id,
    runId: row.run_id,
    action: row.action,
    text: row.text,
    reason: row.reason,
    noteId: row.note_id,
    pinId: row.pin_id,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

// -------------------------------------------------------------- database

/** What you give when adding a note. */
export interface NewNote {
  kind: NoteKind;
  text: string;
  origin: Note["origin"];
  yours?: boolean;
  timeSensitive?: boolean;
  trackerId?: string | null;
  value?: string | null;
  date?: string | null;
  planDraft?: PlanDraft | null;
  request?: Note["request"];
  channelId?: string | null;
  messageId?: string | null;
}

/** The note fields that can change while it's on the scratchpad. */
export type NoteChanges = Partial<Pick<Note, "text" | "status" | "value" | "date" | "planDraft" | "ask" | "confirmed" | "timeSensitive">>;

/** What you give when pinning something. */
export interface NewPin {
  text: string;
  reason: string;
  unpinWhen: string;
  unpinDate: string | null;
  yours: boolean;
  noteId: string | null;
}

/** What you give when logging something. */
export interface NewLogEntry {
  runId: string | null;
  action: MemoryAction;
  text: string;
  reason?: string;
  noteId?: string | null;
  pinId?: string | null;
  messageId?: string | null;
}

export class Memory {
  constructor(private readonly db: Database) {}

  // ---------------------------------------------------------------- notes

  /** Notes with the given statuses (all if none given), oldest first. */
  notes(statuses?: NoteStatus[]): Note[] {
    const rows = this.db.query("SELECT * FROM notes ORDER BY created_at, rowid").all() as NoteRow[];
    return rows.map(toNote).filter((n) => !statuses || statuses.includes(n.status));
  }

  getNote(id: string): Note {
    const row = this.db.query("SELECT * FROM notes WHERE id = $id").get({ id }) as NoteRow | null;
    if (!row) throw new NotFoundError("note");
    return toNote(row);
  }

  /** Put a new sticky note on the scratchpad. */
  addNote(input: NewNote, now: Date): Note {
    const id = crypto.randomUUID();
    const time = now.toISOString();
    this.db
      .query(
        `INSERT INTO notes (id, kind, text, origin, yours, time_sensitive, tracker_id, value, date, plan_draft, request,
                            channel_id, message_id, created_at, updated_at)
         VALUES ($id, $kind, $text, $origin, $yours, $timeSensitive, $trackerId, $value, $date, $planDraft, $request,
                 $channelId, $messageId, $time, $time)`,
      )
      .run({
        id,
        kind: input.kind,
        text: input.text,
        origin: input.origin,
        yours: input.yours ? 1 : 0,
        timeSensitive: input.timeSensitive ? 1 : 0,
        trackerId: input.trackerId ?? null,
        value: input.value ?? null,
        date: input.date ?? null,
        planDraft: input.planDraft ? JSON.stringify(input.planDraft) : null,
        request: input.request ?? null,
        channelId: input.channelId ?? null,
        messageId: input.messageId ?? null,
        time,
      });
    return this.getNote(id);
  }

  /** Change a note. Moving it to done or tossed also records when. */
  updateNote(id: string, changes: NoteChanges, now: Date): Note {
    const note = { ...this.getNote(id), ...changes };
    const resolved = note.status === "done" || note.status === "tossed";
    this.db
      .query(
        `UPDATE notes SET text = $text, status = $status, value = $value, date = $date, plan_draft = $planDraft,
                ask = $ask, confirmed = $confirmed, time_sensitive = $timeSensitive, updated_at = $time,
                resolved_at = $resolvedAt
          WHERE id = $id`,
      )
      .run({
        id,
        text: note.text,
        status: note.status,
        value: note.value,
        date: note.date,
        planDraft: note.planDraft ? JSON.stringify(note.planDraft) : null,
        ask: note.ask,
        confirmed: note.confirmed ? 1 : 0,
        timeSensitive: note.timeSensitive ? 1 : 0,
        time: now.toISOString(),
        resolvedAt: resolved ? (note.resolvedAt ?? now.toISOString()) : null,
      });
    return this.getNote(id);
  }

  // ----------------------------------------------------------------- pins

  /** Pins that are up (or in the drawer), oldest first. */
  pins(status: Pin["status"] = "pinned"): Pin[] {
    const order = status === "pinned" ? "pinned_at" : "unpinned_at DESC";
    const rows = this.db.query(`SELECT * FROM pins WHERE status = $status ORDER BY ${order}, rowid`).all({ status }) as PinRow[];
    return rows.map(toPin);
  }

  getPin(id: string): Pin {
    const row = this.db.query("SELECT * FROM pins WHERE id = $id").get({ id }) as PinRow | null;
    if (!row) throw new NotFoundError("pin");
    return toPin(row);
  }

  addPin(input: NewPin, now: Date): Pin {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO pins (id, text, reason, unpin_when, unpin_date, yours, note_id, pinned_at)
         VALUES ($id, $text, $reason, $unpinWhen, $unpinDate, $yours, $noteId, $time)`,
      )
      .run({
        id,
        text: input.text,
        reason: input.reason,
        unpinWhen: input.unpinWhen,
        unpinDate: input.unpinDate,
        yours: input.yours ? 1 : 0,
        noteId: input.noteId,
        time: now.toISOString(),
      });
    return this.getPin(id);
  }

  /** Take a pin down, into the drawer. */
  unpin(id: string, reason: string, now: Date): Pin {
    this.getPin(id);
    this.db
      .query("UPDATE pins SET status = 'drawer', unpinned_at = $time, unpin_reason = $reason WHERE id = $id")
      .run({ id, reason, time: now.toISOString() });
    return this.getPin(id);
  }

  /** Search the drawer (unpinned pins), newest first. */
  searchDrawer(query: string | undefined, limit = 20): Pin[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return this.pins("drawer")
      .filter((p) => words.every((w) => `${p.text} ${p.reason} ${p.unpinWhen}`.toLowerCase().includes(w)))
      .slice(0, limit);
  }

  // ----------------------------------------------------------------- runs

  startRun(trigger: ProcessingTrigger, now: Date): ProcessingRun {
    const id = crypto.randomUUID();
    this.db
      .query("INSERT INTO processing_runs (id, trigger, started_at) VALUES ($id, $trigger, $time)")
      .run({ id, trigger, time: now.toISOString() });
    return this.getRun(id);
  }

  finishRun(id: string, now: Date, error: string | null = null): ProcessingRun {
    this.db
      .query("UPDATE processing_runs SET finished_at = $time, error = $error WHERE id = $id")
      .run({ id, error, time: now.toISOString() });
    return this.getRun(id);
  }

  getRun(id: string): ProcessingRun {
    const row = this.db.query("SELECT * FROM processing_runs WHERE id = $id").get({ id }) as RunRow | null;
    if (!row) throw new NotFoundError("processing run");
    return toRun(row);
  }

  /** The most recent runs, newest first; optionally only some triggers. */
  runs(limit = 20, triggers?: ProcessingTrigger[]): ProcessingRun[] {
    const rows = this.db.query("SELECT * FROM processing_runs ORDER BY started_at DESC, rowid DESC").all() as RunRow[];
    return rows
      .map(toRun)
      .filter((r) => !triggers || triggers.includes(r.trigger))
      .slice(0, limit);
  }

  // ------------------------------------------------------------------ log

  log(entry: NewLogEntry, now: Date): MemoryLogEntry {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO memory_log (id, run_id, action, text, reason, note_id, pin_id, message_id, created_at)
         VALUES ($id, $runId, $action, $text, $reason, $noteId, $pinId, $messageId, $time)`,
      )
      .run({
        id,
        runId: entry.runId,
        action: entry.action,
        text: entry.text,
        reason: entry.reason ?? "",
        noteId: entry.noteId ?? null,
        pinId: entry.pinId ?? null,
        messageId: entry.messageId ?? null,
        time: now.toISOString(),
      });
    return toLog(this.db.query("SELECT * FROM memory_log WHERE id = $id").get({ id }) as LogRow);
  }

  /** The newest log lines, newest first. */
  recentLog(limit = 200): MemoryLogEntry[] {
    const rows = this.db
      .query("SELECT * FROM memory_log ORDER BY created_at DESC, rowid DESC LIMIT $limit")
      .all({ limit }) as LogRow[];
    return rows.map(toLog);
  }

  /** One processing round's log, in order. */
  logForRun(runId: string): MemoryLogEntry[] {
    const rows = this.db.query("SELECT * FROM memory_log WHERE run_id = $runId ORDER BY created_at, rowid").all({ runId }) as LogRow[];
    return rows.map(toLog);
  }

  // ---------------------------------------------------------------- marks

  /** How far the scratchpad check has read in a channel: a message `seq` (0: nothing yet). */
  mark(channelId: string): number {
    const row = this.db.query("SELECT seq FROM scratchpad_marks WHERE channel_id = $channelId").get({ channelId }) as
      | { seq: number }
      | null;
    return row?.seq ?? 0;
  }

  setMark(channelId: string, seq: number): void {
    this.db
      .query(
        "INSERT INTO scratchpad_marks (channel_id, seq) VALUES ($channelId, $seq) ON CONFLICT (channel_id) DO UPDATE SET seq = excluded.seq",
      )
      .run({ channelId, seq });
  }
}

// ---------------------------------------------------------------- prompt

/**
 * How she knows about her own memory: in every prompt, before her pins and
 * notes. It also covers transparency (DESIGN.md): she can mention her notes
 * when it feels natural, and knows you can see them.
 */
export const MEMORY_NOTE = `You keep a scratchpad. Anything you'd want to remember goes on it in pencil first, and every few hours you process it: what's clearly true gets saved, what's wrong or taken back gets tossed, and what you're unsure of you ask them about. What matters right now, you pin, and your pins are always here.

You can mention your notes, pins and processing when it feels natural ("noted 📌", "took the exam off my board, so glad it went well"), not every time. They set up how this works and can look at your notes in the app, but nothing changes except through you, by talking: if they ask you to pin something or let something go, you'll take care of it.`;

/** What each action is called in "Since you last processed". */
const SINCE_WORDS: Partial<Record<MemoryAction, string>> = {
  committed: "saved",
  tossed: "tossed",
  pinned: "pinned",
  unpinned: "took down the pin",
  asking: "decided to ask them about",
  bringup: "kept to maybe bring up",
  done: "settled",
};

/** A pin in a line: "exam on Friday (why: they're nervous; unpin when: after Friday)". */
export function describePin(p: Pin): string {
  const when = [p.unpinWhen, p.unpinDate ? `after ${p.unpinDate}` : ""].filter(Boolean).join(", ");
  const extras = [p.reason ? `why: ${p.reason}` : "", when ? `unpin when: ${when}` : ""].filter(Boolean);
  return `${p.text}${extras.length ? ` (${extras.join("; ")})` : ""}`;
}

/** "2 hours ago", "just now". */
function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

/**
 * The prompt's "Your notes and pins" section: always in view (DESIGN.md).
 * Her pins, what's on the scratchpad, what she's asking you about, what she
 * might bring up, and what her last processing round did.
 */
export function memoryForPrompt(memory: Memory, settings: Pick<Settings, "pinCap">, now: Date): string {
  const sections: string[] = [MEMORY_NOTE];
  const pins = memory.pins();
  sections.push(
    pins.length
      ? [
          `Pinned (${pins.length} of ${settings.pinCap}):`,
          ...pins.map((p) => `- ${describePin(p)}`),
        ].join("\n")
      : "Pinned: nothing right now.",
  );

  const open = memory.notes(["open"]);
  if (open.length) sections.push(["On your scratchpad (pencil, not processed yet):", ...open.map((n) => `- ${n.text}`)].join("\n"));

  const asking = memory.notes(["asking"]);
  if (asking.length) {
    sections.push(
      [
        "Things to ask them about, when it fits (casually, one at a time; if you've already asked in the chat above, wait for their answer instead of asking again):",
        ...asking.map((n) => `- ${n.ask ?? n.text}`),
      ].join("\n"),
    );
  }

  const bringUp = memory.notes(["bringup"]);
  if (bringUp.length) sections.push(["Things you might bring up, if it fits:", ...bringUp.map((n) => `- ${n.text}`)].join("\n"));

  // What the last round did, so she can mention it ("took the exam off my board").
  const last = memory.runs(1)[0];
  if (last?.finishedAt && now.getTime() - new Date(last.finishedAt).getTime() < 24 * 3600_000) {
    const lines = memory
      .logForRun(last.id)
      .filter((e) => SINCE_WORDS[e.action])
      .map((e) => `- ${SINCE_WORDS[e.action]}: ${e.text}${e.reason && e.action !== "committed" ? ` (${e.reason})` : ""}`);
    if (lines.length) sections.push([`Since you last processed (${ago(last.finishedAt, now)}):`, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}
