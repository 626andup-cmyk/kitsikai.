/**
 * The processing writer (stage 7): the words for her notes, pins and plan
 * cards.
 *
 * Jev decides, but it can't write: it only ever picks one of the options it
 * was given. So when something needs words ("they seemed stressed about the
 * new manager, check in later", a pin's reason, the plan card for "dentist
 * thursday at 3"), a normal chat model writes them. That's the **processing
 * writer**, its own job in Settings, best given a cheap, steady model.
 *
 * It only wakes up when Jev has found something worth writing, and it's
 * asked for JSON, read forgivingly with `extractJson` (the same as the
 * screenshot reader in stage 4). All the notes one check needs are written
 * in one request.
 */

import { dayName } from "./binder.ts";
import { shortTime, type LocalDate } from "./dates.ts";
import { extractJson } from "./json.ts";
import { profileRequest } from "./kitsikai.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { PLAN_KINDS, validatePlan } from "./planner.ts";
import { normalizeDate, normalizeShiftType, normalizeTime } from "./screenshot.ts";
import type { PlanDraft, PlanKind, Profile } from "./types.ts";

/** The longest note or pin text kept, in characters. */
const MAX_TEXT = 300;

/** Something for the writer to write. */
export interface WriteRequest {
  /** A short id, like "w1", to match the answer to the request. */
  id: string;
  /**
   * - `"plan"`: a plan they mentioned, with its plan card.
   * - `"remember"`: something worth remembering.
   * - `"pin"` / `"unpin"`: what they asked her to pin, or let go of.
   * - `"value"`: the value for a note tracker ("$1,240").
   */
  kind: "plan" | "remember" | "pin" | "unpin" | "value";
  /** For `"value"`: the tracker's name. */
  tracker?: string;
  /** A rewrite: the note as it was, before they changed it. */
  was?: string;
}

/** What the writer wrote for one request. */
export interface Written {
  text: string;
  /** For plans: the plan card, or `null` if the date or time couldn't be worked out. */
  plan?: PlanDraft | null;
  /** For `"value"`. */
  value?: string;
}

/** What the writer wrote for a pin. */
export interface WrittenPin {
  text: string;
  reason: string;
  unpinWhen: string;
  unpinDate: string | null;
}

/** Text from a model, tidied and cut to a sensible length, or "" if it isn't text. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT) : "";
}

/** Ask the writer, and read its JSON reply. */
async function askJson(api: ApiOptions, profile: Profile, system: string, user: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    signal,
  });
  const json = extractJson(response.content);
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

const NOTE_SYSTEM = `You write short notes for Kitsikai, who is texting a friend ("them"). She keeps a scratchpad of sticky notes about things worth remembering from their chat. Write each note the way she'd jot it for herself: short, specific, plain words, about them. Never make things up: only what their messages say. Reply with JSON only.`;

/** What each kind of request asks for. */
function describeRequest(r: WriteRequest): string {
  const rewrite = r.was ? ` They've changed it since you wrote "${r.was}": rewrite it to match what they say now.` : "";
  switch (r.kind) {
    case "plan":
      return `a plan they mentioned. Also fill in "plan": {"kind": one of ${PLAN_KINDS.join(", ")}, "title": short, like "Dentist" or "Mia's birthday", "date": "YYYY-MM-DD" (work it out from today), "time": "HH:MM" in 24-hour time or null for all day, "end_time": "HH:MM" or null, "notes": anything else worth keeping, or ""}.${rewrite}`;
    case "remember":
      return `something worth remembering, like "they seemed stressed about the new manager, check in later".${rewrite}`;
    case "pin":
      return `what they asked you to pin (keep in mind).${rewrite}`;
    case "unpin":
      return `what they asked you to let go of (take off your pins).${rewrite}`;
    case "value":
      return `what to log for their "${r.tracker}" tracker: a few words, like "$1,240" or "30 minutes of yoga". Put it in "value", and a short note in "text".`;
  }
}

/**
 * Write notes (and plan cards, and note tracker values) from the chat.
 *
 * @param context  The chat, as the scratchpad check saw it (src/scratchpad.ts),
 *                 starting with today's date.
 * @param today    For working out dates in plan cards.
 * @returns What was written, by request id. A request the writer skipped,
 *          or answered with no text, is left out.
 * @throws ApiError, JsonReplyError if the writer can't be asked or read.
 */
export async function writeNotes(
  api: ApiOptions,
  profile: Profile,
  context: string,
  today: LocalDate,
  requests: WriteRequest[],
  signal?: AbortSignal,
): Promise<Map<string, Written>> {
  if (requests.length === 0) return new Map();
  const user = `${context}

Write these notes, from their NEW messages:
${requests.map((r) => `- "${r.id}": ${describeRequest(r)}`).join("\n")}

Reply like: {${requests.map((r) => `"${r.id}": {"text": "..."${r.kind === "plan" ? ', "plan": {...}' : r.kind === "value" ? ', "value": "..."' : ""}}`).join(", ")}}`;
  const json = await askJson(api, profile, NOTE_SYSTEM, user, signal);

  const written = new Map<string, Written>();
  for (const request of requests) {
    const item = json[request.id];
    const entry = (item && typeof item === "object" ? item : { text: item }) as Record<string, unknown>;
    const note = text(entry.text ?? entry.note);
    if (!note) continue;
    const result: Written = { text: note };
    if (request.kind === "plan") result.plan = toPlanDraft(entry.plan, today);
    if (request.kind === "value") result.value = text(entry.value) || note;
    written.set(request.id, result);
  }
  return written;
}

const PIN_SYSTEM = `You help Kitsikai, who is texting a friend ("them"), keep her pins: a short list of what matters right now, always in front of her. For each thing she's pinning, write what it is (short, in her words), why it matters right now, and when it can come down. Reply with JSON only.`;

/**
 * Write pins for notes she's pinning.
 *
 * @param items  What's being pinned: a short id and the note's text.
 * @throws ApiError, JsonReplyError if the writer can't be asked or read.
 */
export async function composePins(
  api: ApiOptions,
  profile: Profile,
  context: string,
  today: LocalDate,
  items: { id: string; text: string; yours: boolean }[],
  signal?: AbortSignal,
): Promise<Map<string, WrittenPin>> {
  if (items.length === 0) return new Map();
  const user = `${context}

Pin these:
${items.map((i) => `- "${i.id}": ${i.text}${i.yours ? " (they asked you to pin this)" : ""}`).join("\n")}

For each, write "text" (what it is, short), "reason" (why it matters right now), "unpin_when" (when it can come down, as a condition, like "once they say the manager thing settled" or "after the exam"), and "unpin_date" (the YYYY-MM-DD after which it can come down, or null if it depends on something else).

Reply like: {${items.map((i) => `"${i.id}": {"text": "...", "reason": "...", "unpin_when": "...", "unpin_date": null}`).join(", ")}}`;
  const json = await askJson(api, profile, PIN_SYSTEM, user, signal);

  const pins = new Map<string, WrittenPin>();
  for (const item of items) {
    const entry = (json[item.id] ?? {}) as Record<string, unknown>;
    const pinText = text(entry.text) || item.text.slice(0, MAX_TEXT);
    pins.set(item.id, {
      text: pinText,
      reason: text(entry.reason),
      unpinWhen: text(entry.unpin_when ?? entry.unpinWhen),
      unpinDate: normalizeDate(entry.unpin_date ?? entry.unpinDate, today),
    });
  }
  return pins;
}

// ------------------------------------------------------------ plan cards

/**
 * A plan card from the writer's JSON, checked the same way as a plan you
 * make yourself (`validatePlan`). `null` if it doesn't add up: no date, a
 * shift without an end time, and so on.
 */
export function toPlanDraft(raw: unknown, today: LocalDate): PlanDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const kind: PlanKind = PLAN_KINDS.includes(item.kind as PlanKind) ? (item.kind as PlanKind) : "other";
  const startTime = normalizeTime(item.time ?? item.start_time ?? item.startTime);
  try {
    const clean = validatePlan({
      kind,
      title: typeof item.title === "string" ? item.title.slice(0, 200) : "",
      startDate: normalizeDate(item.date ?? item.start_date ?? item.startDate, today),
      startTime,
      endTime: startTime ? normalizeTime(item.end_time ?? item.endTime) : null,
      shiftType: kind === "shift" ? normalizeShiftType(item.shift_type ?? item.shiftType) : null,
      notes: typeof item.notes === "string" ? item.notes.slice(0, 500) : "",
      source: "chat",
    });
    return {
      kind: clean.kind,
      title: clean.title,
      startDate: clean.startDate,
      startTime: clean.startTime,
      endDate: clean.endDate,
      endTime: clean.endTime,
      shiftType: clean.shiftType,
      notes: clean.notes,
    };
  } catch {
    return null;
  }
}

/** A plan card in words: "Dentist on Thu, Oct 1 at 3:00p", "Mia's birthday on Sat, Oct 10". */
export function describeDraft(draft: PlanDraft): string {
  const time = draft.startTime ? ` at ${shortTime(draft.startTime)}${draft.endTime ? `–${shortTime(draft.endTime)}` : ""}` : "";
  return `${draft.title} on ${dayName(draft.startDate)}${time}`;
}

// ------------------------------------------------------------- catch-up

const CATCH_UP_SYSTEM = `You help Kitsikai remember. She's reading back through an old chat with them (her friend), one part at a time, and keeping a short list of what's still worth knowing now: ongoing situations, things coming up, how they've been, what matters to them, things to check in about. Each note is short, specific, in plain words, about them. Never make things up: only what the chat says. Reply with JSON only.`;

/**
 * One step of a catch-up (src/catchup.ts): given the notes so far and the
 * next part of an old chat, the updated list of what's still worth knowing.
 *
 * @throws ApiError, JsonReplyError if the writer can't be asked or read.
 */
export async function updateCatchUp(
  api: ApiOptions,
  profile: Profile,
  known: string[],
  part: string,
  maxNotes: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const user = `What you've noted so far:
${known.length ? known.map((n) => `- ${n}`).join("\n") : "(nothing yet)"}

The next part of the chat (oldest first):
${part}

Update the list: add what matters from this part, drop what's settled or no longer true, and prefer what's recent. At most ${maxNotes} notes.

Reply like: {"notes": ["...", "..."]}`;
  const json = await askJson(api, profile, CATCH_UP_SYSTEM, user, signal);
  const notes = Array.isArray(json.notes) ? json.notes : [];
  return notes.map(text).filter(Boolean).slice(0, maxNotes);
}
