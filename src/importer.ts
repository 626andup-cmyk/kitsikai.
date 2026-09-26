/**
 * Importing a chat from Lumiverse or SillyTavern.
 *
 * If you've been talking to her somewhere else, that history is worth
 * keeping. SillyTavern (and frontends that use its format, like Lumiverse)
 * export a chat as a `.jsonl` file: one JSON object per line. The first line
 * is about the chat; every line after it is a message:
 *
 *   {"user_name": "Sam", "character_name": "Kitsikai", "create_date": "..."}
 *   {"name": "Sam", "is_user": true, "send_date": "June 26, 2026 9:14pm", "mes": "hey"}
 *   {"name": "Kitsikai", "is_user": false, "send_date": "...", "mes": "hiii<cht>how was work"}
 *
 * `parseChat` reads that, and the usual variations (a JSON list, `role` and
 * `content` instead of `is_user` and `mes`, dates as text or numbers).
 * Everything happens on your phone. The **preview** (`previewOf`) and every
 * error describe the file without quoting it: counts, names, dates, and at
 * most the file's *layout* (field names and types), so they're safe to share
 * when asking for help.
 *
 * `importChat` puts the messages into a new or empty channel, with their
 * original dates, split into bubbles on `<cht>` like her new replies.
 * Nothing about importing is "new" to her: Jev's scratchpad check skips the
 * imported messages, no notifications go out, and she doesn't reply to them.
 * What she can do is read them: the newest ones are in the channel's recent
 * history, and her `search_history` tool finds older ones. An optional
 * catch-up (src/catchup.ts) turns the whole chat into notes.
 */

import { splitBubbles } from "./bubbles.ts";
import { ValidationError } from "./errors.ts";
import { stripReasoning } from "./nanogpt.ts";
import { channelName, type Store } from "./store.ts";
import type { Author, Channel } from "./types.ts";

/** The biggest file accepted, in characters (about 30 MB). */
export const MAX_IMPORT_CHARS = 30_000_000;

/** A file that couldn't be read. `layout` describes its shape, never its text. */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly layout: string | null = null,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** One message as read from the file. */
export interface ImportedMessage {
  author: Author;
  /** Its bubbles (a message split on `<cht>`). */
  bubbles: string[];
  /** When it was sent, as ISO 8601. Worked out for undated messages. */
  createdAt: string;
}

/** A chat, read from a file. */
export interface ParsedChat {
  format: "sillytavern" | "json";
  messages: ImportedMessage[];
  /** The names used, for the preview. */
  names: { you: string[]; her: string[] };
  /** Messages without a date (given their neighbour's). */
  undated: number;
  /** What was left out: hidden system messages, empty ones, and ones that couldn't be read. */
  skipped: { system: number; empty: number; unreadable: number };
}

/** What the preview shows: no message text, ever. */
export interface ChatPreview {
  format: ParsedChat["format"];
  total: number;
  you: { messages: number; names: string[] };
  her: { messages: number; names: string[] };
  from: string | null;
  to: string | null;
  undated: number;
  skipped: ParsedChat["skipped"];
}

// ----------------------------------------------------------------- dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date in any of the shapes chat exports use, or `null`:
 *
 *   - a number: milliseconds (or seconds) since 1970
 *   - ISO 8601: "2026-06-26T21:14:05.123Z"
 *   - SillyTavern's: "June 26, 2026 9:14pm", or the older "2026-6-26 @21h 14m 05s 123ms"
 */
export function parseDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return parseDate(Number(text));

  const old = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m(?: ?(\d{1,2})s)?(?: ?(\d{1,3})ms)?/);
  if (old) {
    const [, y, mo, d, h, mi, s, ms] = old;
    return valid(new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), Number(ms ?? 0)));
  }

  const human = text.match(/^([A-Za-z]+)\.? (\d{1,2}),? (\d{4}),?(?: at)? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([ap]\.?m\.?)?$/i);
  if (human) {
    const [, monthName, d, y, h, mi, s, half] = human;
    const month = MONTHS.indexOf(monthName!.slice(0, 3).toLowerCase());
    if (month >= 0) {
      let hours = Number(h);
      if (half) {
        const pm = half.toLowerCase().startsWith("p");
        if (hours === 12) hours = pm ? 12 : 0;
        else if (pm) hours += 12;
      }
      return valid(new Date(Number(y), month, Number(d), hours, Number(mi), Number(s ?? 0)));
    }
  }

  return valid(new Date(text));
}

function valid(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------- layout

/** A value's type, in words, without the value. */
function typeOf(value: unknown): string {
  if (value === null) return "empty";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "true/false";
  return typeof value;
}

/**
 * A file's layout: field names and their types, never the values. Safe to
 * paste when asking for help with a file that won't import.
 */
export function describeLayout(records: unknown[]): string {
  const describe = (record: unknown) =>
    record && typeof record === "object" && !Array.isArray(record)
      ? `{ ${Object.entries(record as Record<string, unknown>)
          .map(([key, value]) => `${key.slice(0, 40)}: ${typeOf(value)}`)
          .join(", ")} }`
      : typeOf(record);
  return records
    .slice(0, 3)
    .map((record, i) => `record ${i + 1}: ${describe(record)}`)
    .join("\n");
}

// --------------------------------------------------------------- reading

/** The records in a file: JSON lines, a JSON list, or an object holding one. */
function recordsOf(text: string): { records: unknown[]; unreadableLines: number } {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed === "") throw new ImportError("The file is empty.");
  // A single JSON document: a list, or an object with the list inside.
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (Array.isArray(whole)) return { records: whole, unreadableLines: 0 };
    if (whole && typeof whole === "object") {
      const inner = ["messages", "chat", "history", "data"].map((k) => (whole as Record<string, unknown>)[k]).find(Array.isArray);
      if (inner) return { records: inner as unknown[], unreadableLines: 0 };
      return { records: [whole], unreadableLines: 0 };
    }
  } catch {
    // Not one document: JSON lines, then.
  }
  const records: unknown[] = [];
  let unreadableLines = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      unreadableLines++;
    }
  }
  if (records.length === 0) throw new ImportError("This doesn't look like a chat export: none of it is JSON. Export the chat as .jsonl (or JSON) and try again.");
  return { records, unreadableLines };
}

/** A message's text, from the usual field names. */
function textOf(record: Record<string, unknown>): string | null {
  const value = record.mes ?? record.content ?? record.text ?? record.message;
  if (typeof value === "string") return value;
  // Chat-completions style: a list of parts.
  if (Array.isArray(value)) {
    const parts = value.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Read a chat export. Throws `ImportError` (with the file's layout, when
 * that helps) if it can't be read as a chat.
 *
 * @param now  For undated chats, and dates in the future.
 */
export function parseChat(text: string, now: Date = new Date()): ParsedChat {
  if (text.length > MAX_IMPORT_CHARS) throw new ImportError("The file is too big to import (30 MB at most).");
  const { records, unreadableLines } = recordsOf(text);

  // SillyTavern's first line is about the chat, not a message.
  const first = records[0] as Record<string, unknown> | undefined;
  const header = first && typeof first === "object" && ("user_name" in first || "character_name" in first) && textOf(first) === null ? first : null;
  const userName = typeof header?.user_name === "string" ? header.user_name : null;
  const characterName = typeof header?.character_name === "string" ? header.character_name : null;
  const body = header ? records.slice(1) : records;

  const skipped = { system: 0, empty: 0, unreadable: unreadableLines };
  const names = { you: new Set<string>(), her: new Set<string>() };
  const read: { author: Author; bubbles: string[]; date: Date | null }[] = [];

  for (const raw of body) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      skipped.unreadable++;
      continue;
    }
    const record = raw as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.toLowerCase() : null;
    if (record.is_system === true || role === "system") {
      skipped.system++;
      continue;
    }
    const name = typeof record.name === "string" ? record.name : null;
    let author: Author | null = null;
    if (typeof record.is_user === "boolean") author = record.is_user ? "user" : "kitsikai";
    else if (role) author = ["user", "human", "you"].includes(role) ? "user" : ["assistant", "char", "character", "bot", "model", "ai"].includes(role) ? "kitsikai" : null;
    else if (name && name === userName) author = "user";
    else if (name && name === characterName) author = "kitsikai";
    const content = textOf(record);
    if (!author || content === null) {
      skipped.unreadable++;
      continue;
    }
    const bubbles = splitBubbles(author === "kitsikai" ? stripReasoning(content) : content);
    if (bubbles.length === 0) {
      skipped.empty++;
      continue;
    }
    if (name) (author === "user" ? names.you : names.her).add(name.slice(0, 60));
    read.push({ author, bubbles, date: parseDate(record.send_date ?? record.date ?? record.timestamp ?? record.created_at ?? record.createdAt ?? record.time) });
  }

  if (read.length === 0) {
    const sample = body.filter((r) => r && typeof r === "object").slice(0, 3);
    throw new ImportError(
      "Couldn't find any messages in this file: none of its records have a sender and a text Kitsikai recognizes.",
      describeLayout(sample.length ? sample : records),
    );
  }

  // Undated messages take the date of the message before them (or after,
  // at the start). With no dates at all, they're a second apart, ending now.
  const undated = read.filter((m) => !m.date).length;
  const dates: (Date | null)[] = read.map((m) => (m.date && m.date > now ? now : m.date));
  if (undated === read.length) {
    read.forEach((_, i) => (dates[i] = new Date(now.getTime() - (read.length - i) * 1000)));
  } else {
    const firstDated = dates.find(Boolean)!;
    let previous: Date = firstDated;
    dates.forEach((date, i) => {
      if (date) previous = date;
      else dates[i] = previous;
    });
  }

  return {
    format: header ? "sillytavern" : "json",
    messages: read.map((m, i) => ({ author: m.author, bubbles: m.bubbles, createdAt: dates[i]!.toISOString() })),
    names: { you: [...names.you], her: [...names.her] },
    undated,
    skipped,
  };
}

/** The preview: counts, names and dates. Never any message text. */
export function previewOf(chat: ParsedChat): ChatPreview {
  const count = (author: Author) => chat.messages.filter((m) => m.author === author).length;
  return {
    format: chat.format,
    total: chat.messages.length,
    you: { messages: count("user"), names: chat.names.you },
    her: { messages: count("kitsikai"), names: chat.names.her },
    from: chat.messages[0]?.createdAt ?? null,
    to: chat.messages.at(-1)?.createdAt ?? null,
    undated: chat.undated,
    skipped: chat.skipped,
  };
}

// --------------------------------------------------------------- saving

/** Where to import: an empty text channel, or a new one. */
export type ImportTarget = { channelId: string } | { newChannel: string };

/**
 * Save a chat into a channel, all or nothing. The channel has to be empty
 * (or new), since a channel's messages are kept in the order they arrived.
 * Messages in a row from the same person share a turn, like bubbles do.
 * The scratchpad check's mark is moved past them, so Jev doesn't treat
 * three months of chat as new.
 */
export function importChat(store: Store, chat: ParsedChat, target: ImportTarget): { channel: Channel; imported: number } {
  return store.db.transaction(() => {
    let channel: Channel;
    if ("channelId" in target) {
      channel = store.getChannel(target.channelId);
      if (channel.kind !== "text") throw new ValidationError("A chat can only be imported into a text channel.");
      if (store.lastMessage(channel.id)) throw new ValidationError(`#${channel.name} already has messages. Import into a new channel, or an empty one.`);
    } else {
      channel = store.createChannel({ name: channelName(target.newChannel), kind: "text" });
    }

    let imported = 0;
    let turnId = "";
    let previous: Author | null = null;
    for (const message of chat.messages) {
      if (message.author !== previous) turnId = crypto.randomUUID();
      previous = message.author;
      for (const content of message.bubbles) {
        store.addMessage({ channelId: channel.id, author: message.author, content, turnId, createdAt: message.createdAt });
        imported++;
      }
    }
    const newest = store.messagesSince(channel.id, 0, 1)[0];
    if (newest) store.memory.setMark(channel.id, newest.seq);
    return { channel, imported };
  })();
}
