/**
 * Her tools (stage 6): looking things up in the binder.
 *
 * Today's and tomorrow's plans are always in her prompt. Anything further
 * (next week's shifts, the headache log from last month, what was said in
 * another channel) she looks up with a tool when it comes up.
 *
 * Stage 7 adds two for her memory (src/memory.ts): `jot_note` puts a note on
 * her scratchpad (in pencil, like everything Jev notices), and
 * `look_in_drawer` finds pins she's taken down. Neither changes the binder:
 * only processing does, and plans only after you say yes.
 *
 * `search_history` searches everything you've said to each other, which
 * matters most for a chat imported from elsewhere (src/importer.ts): only
 * a channel's newest messages are in view.
 *
 * Trackers, like you can: `make_tracker` makes one, and `log_sticker` and
 * `remove_sticker` put stickers on days and take them off. Unlike her
 * notes, these go straight in, the way yours do from the trackers channel,
 * marked as hers ("She logged this herself"), and you can change or delete
 * them like any sticker. Her pencil notes about the same tracker and day
 * are settled at the same time, so processing doesn't log it twice.
 *
 * Each tool is a name, a description the model reads, a JSON schema for its
 * arguments, and a `run` function. `runTool` checks the arguments, runs it,
 * and returns:
 *
 *   - `result`: what the model is told, as JSON. Mistakes are results too
 *     ("There's no tracker called ..."), so the model can correct itself.
 *   - `summary`: a short line for people, shown under her messages and in
 *     the tool log ("looked up plans for Oct 1–7").
 *
 * The structure is Aettica's (src/tools.ts there); the tools are new.
 * "Do nothing" is always there too: choosing not to reply is fine.
 */

import { SOURCE_WORDS, dayName, describeEntry, describeOccurrence, stickerWords } from "./binder.ts";
import { addDays, dateOf, daysBetween, isDate, type LocalDate } from "./dates.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { checkValue } from "./trackers.ts";
import type { ToolSpec } from "./nanogpt.ts";
import { PLAN_KINDS } from "./planner.ts";
import { formatClock } from "./prompt.ts";
import type { Events } from "./events.ts";
import type { Store } from "./store.ts";
import type { Channel, LogEntry, PlanKind, Tracker, TrackerKind } from "./types.ts";

/** Where a tool runs: the channel of the turn, and the time. */
export interface ToolContext {
  store: Store;
  channel: Channel;
  now: Date;
  /** To tell the app her notes changed (stage 7). */
  events?: Events;
}

/** What running a tool produced. */
export interface ToolOutcome {
  ok: boolean;
  /** Sent back to the model. */
  result: unknown;
  /** For people. For errors, the error. */
  summary: string;
  /** `do_nothing`: end the turn without writing. */
  stop?: boolean;
}

/** A mistake in how the model used a tool, explained to it. */
class ToolError extends Error {}

interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Omit<ToolOutcome, "ok"> & { ok?: boolean };
}

// ------------------------------------------------------------------ helpers

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });

/** An optional text argument. */
function maybe(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be text.`);
  return value.trim();
}

const norm = (s: string) => s.trim().toLowerCase();

/** A date argument: YYYY-MM-DD, or "today", "tomorrow", "yesterday". */
function dateArg(value: string | undefined, now: Date, key: string): LocalDate | undefined {
  if (value === undefined) return undefined;
  const today = dateOf(now);
  const words: Record<string, LocalDate> = { today, tomorrow: addDays(today, 1), yesterday: addDays(today, -1) };
  const date = words[norm(value)] ?? value;
  if (!isDate(date)) throw new ToolError(`"${key}" must be a date like ${today}, or "today", "tomorrow" or "yesterday".`);
  return date;
}

/** "Oct 1–7", "Oct 1", "Sep 28–Oct 4", for summaries. */
function range(from: LocalDate, to: LocalDate): string {
  const short = (d: LocalDate) => dayName(d).replace(/^\w+,? /, "");
  if (from === to) return short(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${short(from)}–${Number(to.slice(8))}` : `${short(from)}–${short(to)}`;
}

/** Find a tracker by name: exact (ignoring case) first, then a unique partial match. */
function findTracker(store: Store, name: string) {
  const trackers = store.trackers.list();
  const wanted = norm(name);
  const exact = trackers.find((t) => norm(t.name) === wanted);
  if (exact) return exact;
  const partial = trackers.filter((t) => norm(t.name).includes(wanted) || wanted.includes(norm(t.name)));
  if (partial.length === 1) return partial[0]!;
  throw new ToolError(`There's no tracker called "${name}". Trackers: ${trackers.map((t) => t.name).join(", ") || "(none)"}.`);
}

/** What each kind of tracker records, in words (for her, both ways). */
const RECORDS: Record<TrackerKind, string> = { yesno: "yes or no", scale: "1 to 10", note: "a note" };
/** Other ways a model might write what a tracker records. */
const RECORDS_ALIASES: Record<string, TrackerKind> = { "yes/no": "yesno", yesno: "yesno", "1-10": "scale", scale: "scale", note: "note" };

/** The id of your message this turn answers, if it's yours: where a sticker came from. */
function yourLastMessageId(ctx: ToolContext): string | null {
  const last = ctx.store.lastMessage(ctx.channel.id);
  return last?.author === "user" ? last.id : null;
}

/**
 * Her pencil notes about this tracker and day (from Jev's check of your
 * messages) are settled: logged (`done`), or taken back with the sticker
 * (`tossed`), so processing doesn't log them again.
 */
function settleNotes(ctx: ToolContext, trackerId: string, date: LocalDate, status: "done" | "tossed", reason: string): void {
  const { store, now, events } = ctx;
  const notes = store.memory.notes(["open", "asking"]).filter((n) => n.kind === "tracker" && n.trackerId === trackerId && n.date === date);
  for (const note of notes) {
    store.memory.updateNote(note.id, { status }, now);
    store.memory.log({ runId: null, action: status === "done" ? "committed" : "tossed", text: note.text, reason, noteId: note.id, messageId: note.messageId }, now);
  }
  if (notes.length) events?.publish({ type: "memory" });
}

/** A day for a sticker: today unless she says, and never after today (stickers are what happened). */
function stickerDay(args: Record<string, unknown>, now: Date): LocalDate {
  const date = dateArg(maybe(args, "date"), now, "date") ?? dateOf(now);
  if (date > dateOf(now)) throw new ToolError("Stickers are for what happened: pick today or a day before.");
  return date;
}

/** The sticker for a tracker on a day, if there is one (the newest, if there are several). */
function stickerOn(ctx: ToolContext, tracker: Tracker, date: LocalDate): LogEntry | undefined {
  return ctx.store.trackers.entries({ trackerId: tracker.id, from: date, to: date })[0];
}

/** Find a channel by name (`#gaming` or `gaming`). */
function findChannel(ctx: ToolContext, name: string): Channel {
  const wanted = norm(name.replace(/^#/, ""));
  const channels = ctx.store.listChannels().filter((c) => c.kind === "text");
  const match = channels.find((c) => norm(c.name) === wanted);
  if (match) return match;
  throw new ToolError(`There's no text channel called #${wanted}. Channels: ${channels.map((c) => `#${c.name}`).join(", ")}.`);
}

/** "how long ago" for a message, like "5 minutes ago" or "Sat Sep 26, 4:12 PM". */
function when(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (minutes < 60 * 12) return `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"} ago`;
  const date = new Date(iso);
  return `${dayName(dateOf(date))}, ${formatClock(date)}`;
}

// -------------------------------------------------------------------- tools

/** The longest stretch `look_up_plans` covers at once. */
const MAX_PLAN_DAYS = 92;

const TOOLS: ToolDefinition[] = [
  {
    name: "look_up_plans",
    description:
      "Look up their plans and shifts between two dates (today and tomorrow are already in front of you). Use it when a day further out comes up, like next week's shifts.",
    parameters: object(
      {
        from: str('First day, as YYYY-MM-DD (or "today", "tomorrow").'),
        to: str("Last day, as YYYY-MM-DD. At most 3 months after the first."),
        kind: { type: "string", enum: PLAN_KINDS, description: "Optional: only this kind of plan." },
      },
      ["from", "to"],
    ),
    run: ({ store, now }, args) => {
      const from = dateArg(maybe(args, "from"), now, "from") ?? dateOf(now);
      const to = dateArg(maybe(args, "to"), now, "to") ?? from;
      const days = daysBetween(from, to);
      if (days < 0) throw new ToolError('"to" must be on or after "from".');
      if (days > MAX_PLAN_DAYS) throw new ToolError(`That's more than ${MAX_PLAN_DAYS} days. Look up a shorter stretch.`);
      const kind = maybe(args, "kind") as PlanKind | undefined;
      if (kind && !PLAN_KINDS.includes(kind)) throw new ToolError(`"kind" must be one of: ${PLAN_KINDS.join(", ")}.`);
      const found = store.plans.occurrences(from, to).filter((o) => !kind || o.plan.kind === kind);
      return {
        result: found.length
          ? found.map((o) => ({ day: dayName(o.date), date: o.date, plan: describeOccurrence(o) }))
          : { note: `Nothing planned between ${dayName(from)} and ${dayName(to)}.` },
        summary: `looked up ${kind ? `${kind}s` : "plans"} for ${range(from, to)}`,
      };
    },
  },
  {
    name: "find_plans",
    description: "Search their plans by name or notes (like \"dentist\" or \"Mia\"), and see when each happens next.",
    parameters: object({ query: str("A word from the plan's title or notes.") }, ["query"]),
    run: ({ store, now }, args) => {
      const query = maybe(args, "query");
      if (!query) throw new ToolError('"query" is required.');
      const today = dateOf(now);
      const matches = store.plans
        .list()
        .filter((p) => norm(`${p.title} ${p.notes}`).includes(norm(query)))
        .slice(0, 20)
        .map((plan) => {
          // The next time it happens (or the last, if it's in the past).
          const coming = store.plans.occurrences(today, addDays(today, 366)).find((o) => o.plan.id === plan.id);
          const last = coming ? undefined : store.plans.occurrences(addDays(today, -366), today).filter((o) => o.plan.id === plan.id).at(-1);
          const o = coming ?? last;
          return o ? { when: coming ? "next" : "last", day: dayName(o.date), date: o.date, plan: describeOccurrence(o) } : null;
        })
        .filter(Boolean);
      return {
        result: matches.length ? matches : { note: `No plans mention "${query}".` },
        summary: `searched plans for "${query}"`,
      };
    },
  },
  {
    name: "list_trackers",
    description:
      "List the trackers: the things they asked you to keep an eye out for, what each records, and whether you may bring it up.",
    parameters: object({}),
    run: ({ store }) => ({
      result: store.trackers.list().map((t) => ({
        name: t.name,
        records: RECORDS[t.kind],
        hint_words: t.hintWords,
        you_may_bring_it_up: t.canBringUp,
      })),
      summary: "looked at the trackers",
    }),
  },
  {
    name: "look_up_log",
    description:
      "Look up the log: stickers for what actually happened, like headaches or payday. Optionally one tracker, and between two dates.",
    parameters: object({
      tracker: str("Optional: the tracker's name."),
      from: str("Optional: first day, as YYYY-MM-DD."),
      to: str("Optional: last day, as YYYY-MM-DD."),
    }),
    run: ({ store, now }, args) => {
      const trackerName = maybe(args, "tracker");
      const tracker = trackerName ? findTracker(store, trackerName) : undefined;
      const from = dateArg(maybe(args, "from"), now, "from");
      const to = dateArg(maybe(args, "to"), now, "to");
      const trackers = new Map(store.trackers.list().map((t) => [t.id, t]));
      const entries = store.trackers.entries({ trackerId: tracker?.id, from, to, limit: 100 });
      return {
        result: entries.length
          ? entries.map((e) => ({ entry: describeEntry(e, trackers.get(e.trackerId)), how: SOURCE_WORDS[e.source] }))
          : { note: "Nothing logged for that." },
        summary: `checked the ${tracker ? `${tracker.name} ` : ""}log${from || to ? ` for ${range(from ?? to!, to ?? from!)}` : ""}`,
      };
    },
  },
  {
    name: "make_tracker",
    description:
      "Make a new tracker, when they ask you to keep track of something (or say yes when you offer). Check list_trackers first: if there's one for it already, use that.",
    parameters: object(
      {
        name: str('Short, like "headache", "took meds" or "payday".'),
        records: { type: "string", enum: Object.values(RECORDS), description: "What each day's sticker says: yes or no, how bad from 1 to 10, or a short note." },
        hint_words: { type: "array", items: { type: "string" }, description: "Optional: a few words that tend to come up with it (\"migraine\", \"head hurts\")." },
        may_bring_up: { type: "boolean", description: "Optional: false if they'd rather you log it quietly and never raise it yourself. Default true." },
      },
      ["name", "records"],
    ),
    run: ({ store, events }, args) => {
      const name = maybe(args, "name");
      if (!name) throw new ToolError('"name" is required.');
      const records = norm(maybe(args, "records") ?? "");
      const kind = (Object.keys(RECORDS) as TrackerKind[]).find((k) => RECORDS[k] === records) ?? RECORDS_ALIASES[records];
      if (!kind) throw new ToolError(`"records" must be one of: ${Object.values(RECORDS).map((r) => `"${r}"`).join(", ")}.`);
      if (args.hint_words !== undefined && !Array.isArray(args.hint_words)) throw new ToolError('"hint_words" must be a list of words.');
      if (args.may_bring_up !== undefined && typeof args.may_bring_up !== "boolean") throw new ToolError('"may_bring_up" must be true or false.');
      const same = store.trackers.list().find((t) => norm(t.name) === norm(name));
      if (same) throw new ToolError(`There's already a tracker called "${same.name}" (${RECORDS[same.kind]}). Log to it with log_sticker.`);
      const tracker = store.trackers.create({ name, kind, hintWords: args.hint_words ?? [], canBringUp: args.may_bring_up !== false });
      events?.publish({ type: "log" });
      return {
        result: {
          made: { name: tracker.name, records: RECORDS[tracker.kind], hint_words: tracker.hintWords, you_may_bring_it_up: tracker.canBringUp },
          note: "It's in the trackers channel now. Put stickers on days with log_sticker.",
        },
        summary: `made a tracker: ${tracker.name} (${RECORDS[tracker.kind]})`,
      };
    },
  },
  {
    name: "log_sticker",
    description:
      "Put a sticker on a day for one of their trackers: that it happened, how bad it was, or a note. Use it when they tell you, or ask you to log something. One sticker per tracker a day: logging the same tracker and day again changes it, for corrections.",
    parameters: object(
      {
        tracker: str("The tracker's name."),
        value: str('"yes" or "no", a number from 1 to 10, or a short note: whatever the tracker records.'),
        date: str('Optional: the day, as YYYY-MM-DD, or "today" (the default) or "yesterday".'),
      },
      ["tracker", "value"],
    ),
    run: (ctx, args) => {
      const { store, events } = ctx;
      const name = maybe(args, "tracker");
      if (!name) throw new ToolError('"tracker" is required.');
      const tracker = findTracker(store, name);
      const value = typeof args.value === "string" ? args.value.trim() : args.value;
      if (value === undefined || value === null || value === "") throw new ToolError('"value" is required.');
      const date = stickerDay(args, ctx.now);

      const existing = stickerOn(ctx, tracker, date);
      const by = { source: "kitsikai" as const, messageId: yourLastMessageId(ctx) };
      let entry: LogEntry;
      let verb: string;
      let result: Record<string, unknown>;
      if (existing && checkValue(tracker.kind, value) === existing.value) {
        // Already there: nothing changes, not even whose it is.
        entry = existing;
        verb = "already had";
        result = { already: describeEntry(entry, tracker) };
      } else if (existing) {
        entry = store.trackers.updateEntry(existing.id, { value }, by);
        verb = "changed";
        result = { changed: describeEntry(entry, tracker), was: existing.value };
      } else {
        entry = store.trackers.addEntry({ trackerId: tracker.id, date, value, ...by });
        verb = "logged";
        result = { logged: describeEntry(entry, tracker) };
      }
      settleNotes(ctx, tracker.id, date, "done", "you logged it yourself");
      events?.publish({ type: "log" });
      return { result, summary: `${verb} ${stickerWords(entry, tracker)} for ${dayName(date)}` };
    },
  },
  {
    name: "remove_sticker",
    description:
      "Take a tracker's sticker off a day, when they tell you it's wrong (\"I didn't take my meds after all\") or ask you to. Only then.",
    parameters: object(
      {
        tracker: str("The tracker's name."),
        date: str('Optional: the day, as YYYY-MM-DD, or "today" (the default) or "yesterday".'),
      },
      ["tracker"],
    ),
    run: (ctx, args) => {
      const { store, events } = ctx;
      const name = maybe(args, "tracker");
      if (!name) throw new ToolError('"tracker" is required.');
      const tracker = findTracker(store, name);
      const date = stickerDay(args, ctx.now);
      const entry = stickerOn(ctx, tracker, date);
      if (!entry) throw new ToolError(`There's no ${tracker.name} sticker on ${dayName(date)}.`);
      store.trackers.deleteEntry(entry.id);
      settleNotes(ctx, tracker.id, date, "tossed", "you took the sticker off");
      events?.publish({ type: "log" });
      const left = stickerOn(ctx, tracker, date);
      return {
        result: { removed: describeEntry(entry, tracker), ...(left ? { still_there: describeEntry(left, tracker) } : {}) },
        summary: `took off ${stickerWords(entry, tracker)} for ${dayName(date)}`,
      };
    },
  },
  {
    name: "read_channel",
    description: "Read the latest messages in another channel, to catch up on what you two said there.",
    parameters: object(
      {
        channel: str("The channel, like #gaming."),
        count: { type: "integer", description: "How many messages, up to 40 (default 15)." },
      },
      ["channel"],
    ),
    run: (ctx, args) => {
      const name = maybe(args, "channel");
      if (!name) throw new ToolError('"channel" is required.');
      const channel = findChannel(ctx, name);
      if (channel.id === ctx.channel.id) throw new ToolError("That's this channel: its messages are already in front of you.");
      const count = Math.min(Math.max(Math.round(Number(args.count) || 15), 1), 40);
      const messages = ctx.store.recentMessages(channel.id, count);
      return {
        result: messages.length
          ? messages.map((m) => ({ from: m.author === "user" ? "them" : "you", text: m.content, when: when(m.createdAt, ctx.now) }))
          : { note: `#${channel.name} is empty.` },
        summary: `read #${channel.name}`,
      };
    },
  },
  {
    name: "search_history",
    description:
      "Search everything you two have said, in every channel, including chats from before this app: when something from a while back comes up, look up what was actually said instead of guessing.",
    parameters: object(
      {
        query: str("A few words to look for (all of them have to be in the message)."),
        channel: str("Optional: only this channel, like #general."),
      },
      ["query"],
    ),
    run: (ctx, args) => {
      const query = maybe(args, "query");
      if (!query) throw new ToolError('"query" is required.');
      const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const name = maybe(args, "channel");
      const channels = name ? [findChannel(ctx, name)] : ctx.store.listChannels().filter((c) => c.kind === "text");
      // What's already in front of her in this channel isn't worth finding again.
      const inView = new Set(ctx.store.recentMessages(ctx.channel.id, ctx.store.getSettings().historyLimit).map((m) => m.id));
      const found = ctx.store.searchMessages(words, { channelIds: channels.map((c) => c.id), exclude: inView, limit: 15 });
      const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "?";
      return {
        result: found.length
          ? found.map((m) => ({
              when: `${dayName(dateOf(new Date(m.createdAt)))} ${new Date(m.createdAt).getFullYear()}, ${formatClock(new Date(m.createdAt))}`,
              channel: `#${channelName(m.channelId)}`,
              from: m.author === "user" ? "them" : "you",
              text: m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content,
            }))
          : { note: `Nothing older mentions "${query}".` },
        summary: `searched the history for "${query}"`,
      };
    },
  },
  {
    name: "jot_note",
    description:
      "Jot a note on your scratchpad: something you want to remember (\"they seemed stressed about the new manager, check in later\"), or that they asked you to pin something or let a pin go. It's in pencil: you'll process it later.",
    parameters: object(
      {
        text: str("The note, short, in your words."),
        kind: {
          type: "string",
          enum: ["remember", "pin", "let go"],
          description: 'Optional: "pin" or "let go" when they asked you to pin something or take a pin down. Default "remember".',
        },
        soon: { type: "boolean", description: "Optional: true if it's about something in the next few hours." },
      },
      ["text"],
    ),
    run: ({ store, channel, now, events }, args) => {
      const text = maybe(args, "text");
      if (!text) throw new ToolError('"text" is required.');
      if (text.length > 300) throw new ToolError("Keep the note under 300 characters.");
      const kind = maybe(args, "kind") ?? "remember";
      if (!["remember", "pin", "let go"].includes(kind)) throw new ToolError('"kind" must be "remember", "pin" or "let go".');
      if (args.soon !== undefined && typeof args.soon !== "boolean") throw new ToolError('"soon" must be true or false.');
      const request = kind === "pin" ? "pin" : kind === "let go" ? "unpin" : null;
      const last = store.lastMessage(channel.id);
      const note = store.memory.addNote(
        {
          kind: request ? "request" : "remember",
          text,
          origin: "jotted",
          yours: request !== null,
          timeSensitive: args.soon === true,
          request,
          channelId: channel.id,
          messageId: last?.author === "user" ? last.id : null,
        },
        now,
      );
      store.memory.log(
        { runId: null, action: "noted", text, reason: request ? `they asked you to ${kind === "pin" ? "pin it" : "let it go"}` : "you jotted it down", noteId: note.id, messageId: note.messageId },
        now,
      );
      events?.publish({ type: "memory" });
      return { result: { noted: text, note: "On your scratchpad. You'll process it later." }, summary: `jotted down "${text}"` };
    },
  },
  {
    name: "look_in_drawer",
    description:
      "Look in your drawer: things you pinned once and have since taken down. Unpinning isn't forgetting: use this when something old comes up.",
    parameters: object({ query: str("Optional: a word to search for.") }),
    run: ({ store }, args) => {
      const query = maybe(args, "query");
      const pins = store.memory.searchDrawer(query);
      return {
        result: pins.length
          ? pins.map((p) => ({
              pin: p.text,
              why: p.reason,
              pinned: dayName(dateOf(new Date(p.pinnedAt))),
              taken_down: p.unpinnedAt ? dayName(dateOf(new Date(p.unpinnedAt))) : null,
              because: p.unpinReason,
            }))
          : { note: query ? `Nothing in the drawer about "${query}".` : "The drawer is empty." },
        summary: query ? `looked in the drawer for "${query}"` : "looked in the drawer",
      };
    },
  },
  {
    name: "do_nothing",
    description: "Don't reply this time. Choose this when there's genuinely nothing you'd text.",
    parameters: object({ reason: str("Optional: why, for your own record.") }),
    run: (_ctx, args) => ({
      result: { done: true },
      summary: maybe(args, "reason") ? `chose not to reply (${maybe(args, "reason")})` : "chose not to reply",
      stop: true,
    }),
  },
];

// -------------------------------------------------------------------- API

/** The tools she's offered, in the API's format. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Every tool name, for tests and the docs. */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * Run one tool call. Never throws for a mistake the model made: that comes
 * back as a failed outcome whose result explains the problem, so the model
 * can try again.
 */
export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return failure(`There's no tool called "${name}". Tools: ${TOOL_NAMES.join(", ")}.`);
  try {
    return { ok: true, ...tool.run(ctx, args) };
  } catch (error) {
    if (error instanceof ToolError || error instanceof ValidationError || error instanceof NotFoundError) {
      return failure(error.message);
    }
    console.error(`[tools] ${name} failed`, error);
    return failure("Something went wrong running that tool.");
  }
}

function failure(message: string): ToolOutcome {
  return { ok: false, result: { error: message }, summary: message };
}
