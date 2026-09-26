/**
 * Shared data shapes for Kitsikai.
 *
 * Everything the server saves or sends to the browser is described here, so
 * this file doubles as a map of the data model. Each build stage grows it.
 *
 * How these shapes are stored in the database is in `src/db.ts`.
 */

/**
 * Who wrote a message.
 *
 * - `"user"`: you.
 * - `"kitsikai"`: her.
 */
export type Author = "user" | "kitsikai";

/**
 * What a channel is, like Discord's channel types.
 *
 * - `"text"`: a conversation with her.
 * - `"planner"` (stage 3) and `"trackers"` (stage 5): opening these shows
 *   their screen instead of a chat. There's one of each at most.
 */
export type ChannelKind = "text" | "planner" | "trackers";

/** A channel: one conversation with her. */
export interface Channel {
  /** Unique id, generated when the channel is created. */
  id: string;
  /** Display name, shown with a `#` in front. */
  name: string;
  kind: ChannelKind;
  /**
   * A short description, like Discord's ("work stuff, venting about
   * shifts"). She sees it, and later uses it to pick where to text you.
   */
  topic: string;
  /**
   * The channel's own theme (a theme id), or `null` to use the app theme.
   * It only restyles the channel itself; see `src/themes.ts`.
   */
  theme: string | null;
  /**
   * The profile or roulette that writes here, overriding the server-wide
   * chat assignment (see `Settings.chatAssignment`), or `null`.
   */
  assignment: string | null;
  /** Where the channel sits in the sidebar: 0 is the top. */
  position: number;
  /** When the channel was created, as an ISO 8601 timestamp. */
  createdAt: string;
}

/** One message in a channel. */
export interface Message {
  id: string;
  channelId: string;
  author: Author;
  /** The text, exactly as written or returned by the model. */
  content: string;
  /**
   * Messages written together share a turn id: all the bubbles of one of her
   * replies, or several bubbles you sent before she answered. Regenerating
   * replaces her whole turn.
   */
  turnId: string | null;
  /** When the message was created, as an ISO 8601 timestamp. */
  createdAt: string;
  /** When the message was last edited, if ever. */
  editedAt?: string;
  /** For her messages: which model wrote it. */
  model?: string;
  /** For her messages: the name of the connection profile that wrote it. */
  profile?: string;
}

/**
 * Settings that apply to the whole app, changed from the settings panel.
 * Per-channel settings live on `Channel` instead.
 */
export interface Settings {
  /** Her name, shown on her messages. The app is named after her. */
  name: string;
  /** Your name, if you want her to use it. Empty: she just says "you". */
  userName: string;
  /** Her persona: who she is. Starts from `defaults/persona.md`. */
  persona: string;
  /**
   * Which connection profile or roulette writes her messages, server-wide:
   * `"profile:<id>"`, `"roulette:<id>"`, or `""` for the first profile.
   * A channel can override it (`Channel.assignment`).
   */
  chatAssignment: string;
  /**
   * Which connection profile reads schedule screenshots (stage 4). It needs
   * a vision model, one that can read images. `""` for the first profile.
   */
  screenshotAssignment: string;
  /** How many of a channel's most recent messages she sees. */
  historyLimit: number;
  /**
   * The home channel: where she texts you when nothing fits better (from
   * stage 8). A channel id, or "" for the first text channel.
   */
  homeChannelId: string;
  /**
   * How long she waits after your last bubble before replying, in seconds,
   * so she doesn't answer halfway through your thought.
   */
  replyDebounceSeconds: number;
  /**
   * How long each of her bubbles takes to "type" in the app, in
   * milliseconds: `typingBaseMs + characters × typingPerCharMs`.
   */
  typingBaseMs: number;
  typingPerCharMs: number;
  /** The app theme's id (see `src/themes.ts`). "classic" is the default look. */
  appTheme: string;
  /**
   * Where you've moved a theme's sliders, by theme id, then option id.
   * Options you haven't moved use the theme's defaults.
   */
  themeOptions: Record<string, Record<string, number>>;
}

/**
 * One message in the format the chat completions API expects.
 *
 * nanoGPT speaks the same API as OpenAI, where every message has a role:
 * `system` for instructions, `user` for the human, `assistant` for the model.
 * With tools, an assistant message can also ask for tool calls, and each
 * call's result comes back as a `tool` message.
 */
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "tool"; content: string; tool_call_id: string };

/**
 * A message as sent to the API, which also covers a reply that only called
 * tools: its content is `null` (some providers reject an empty string there).
 */
export type ApiMessage =
  | ChatMessage
  | { role: "assistant"; content: string | null; tool_calls: ApiToolCall[] }
  | { role: "user"; content: ContentPart[] };

/**
 * One part of a message that has a picture in it (stage 4: screenshots).
 * Pictures are sent as `data:` URLs: the image's bytes, as base64 text.
 */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** A tool call as the API writes it inside an assistant message. */
export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ------------------------------------------------ profiles and roulettes

/** How hard a reasoning model thinks before answering (`null`: the model's default). */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * A connection profile: one model and its settings (see `src/profiles.ts`).
 * It changes how her words are produced, never who she is.
 */
export interface Profile {
  id: string;
  /** Your name for it, e.g. "DeepSeek, warm". */
  name: string;
  /** nanoGPT model id, e.g. `deepseek-ai/DeepSeek-V3.1-Terminus`. */
  model: string;
  /** Sampling temperature: higher is more varied. Most models like 0.7 to 1.1. */
  temperature: number;
  /** Upper limit on one reply's length, in tokens. */
  maxTokens: number;
  /** Nucleus sampling, or `null` to leave it to the model. */
  topP: number | null;
  reasoningEffort: ReasoningEffort | null;
  /** Whether the model can call tools. Turns on it are given tools only if so. */
  supportsTools: boolean;
  /** Notes that tame this model's habits, added to the prompt. */
  quirkPrompt: string;
  /** More request fields, as a JSON object in text (e.g. `{"top_k": 40}`), or "". */
  extraParams: string;
  position: number;
  createdAt: string;
}

/** A weighted set of profiles; each turn picks one (see `src/profiles.ts`). */
export interface Roulette {
  id: string;
  name: string;
  entries: { profileId: string; weight: number }[];
  position: number;
  createdAt: string;
}

// ------------------------------------------------------------ stage 3

/** What kind of plan: shifts and events are the same record with different kinds. */
export type PlanKind = "shift" | "appointment" | "birthday" | "hangout" | "other";

/**
 * What kind of shift:
 *
 * - `"regular"`: shift hours and draw hours; counts as busy.
 * - `"meeting"`: shift hours only; counts as busy.
 * - `"oncall"`: the on-call window; free unless you get called in (stage 8).
 */
export type ShiftType = "regular" | "meeting" | "oncall";

/** How a plan repeats. */
export type Repeats = "never" | "weekly" | "yearly";

/** A reminder a plan can have, relative to when it starts. */
export type ReminderId = "week-before" | "day-before" | "morning-of" | "2h-before";

/** Where a plan came from. */
export type PlanSource = "manual" | "screenshot" | "chat";

/** A plan: anything planned, on a day, maybe at a time. */
export interface Plan {
  id: string;
  kind: PlanKind;
  /** "Dentist", "Mia's birthday", "Work". */
  title: string;
  startDate: string;
  /** `null` for an all-day plan. */
  startTime: string | null;
  /** Optional, with its own date, so overnight shifts (10pm–6am) work. */
  endDate: string | null;
  endTime: string | null;
  repeats: Repeats;
  /** This plan's own reminders, or `null` to use its kind's defaults. */
  reminders: ReminderId[] | null;
  /** Whether you've confirmed it. */
  checked: boolean;
  /** Shifts only. */
  shiftType: ShiftType | null;
  /** Regular shifts only: the draw hours. Draw time is always calculated from these, never stored. */
  drawStart: string | null;
  drawEnd: string | null;
  notes: string;
  source: PlanSource;
  createdAt: string;
  updatedAt: string;
}

/** When one of a plan's reminders goes off, for one occurrence. */
export interface ReminderTime {
  id: ReminderId;
  /** "Day before", "2 hours before"... */
  label: string;
  date: string;
  time: string;
  /** Moved earlier because it would have landed during work. */
  dodged: boolean;
}

/**
 * One occurrence of a plan on the calendar: a plan that repeats weekly has
 * one per week. Everything calculated (shift hours, draw time, reminder
 * times) is worked out here, every time, so it can never disagree with the
 * plan itself.
 */
export interface Occurrence {
  /** `planId:date`: unique for each occurrence. */
  key: string;
  plan: Plan;
  /** This occurrence's start date (for a repeating plan, not the plan's first one). */
  date: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  /** Shifts: the shift hours, in minutes. */
  shiftMinutes: number | null;
  /** Regular shifts: the draw time, in minutes, calculated from the draw hours. `null` without draw hours. */
  drawMinutes: number | null;
  /** Whether it counts as busy: regular shifts and meetings (and on-call, when called in). */
  busy: boolean;
  reminders: ReminderTime[];
}

/** A stretch of work: shifts that run into each other count as one. */
export interface WorkBlock {
  start: Date;
  end: Date;
  /** The occurrences it's made of. */
  keys: string[];
}

// ------------------------------------------------------------ stage 4

/** One shift as read from a schedule screenshot, before it's saved. */
export interface ScreenshotRow {
  /** `null` if it couldn't be read. */
  date: string | null;
  shiftType: ShiftType;
  startTime: string | null;
  endTime: string | null;
  drawStart: string | null;
  drawEnd: string | null;
  /** The weekday as written on the screenshot ("Mon"), to spot misread dates. */
  weekdayRead: string | null;
}

/** A row of the review list: what was read, what's calculated from it, and what looks wrong. */
export interface CheckedRow extends ScreenshotRow {
  /** Worked out: the next day for an overnight shift. */
  endDate: string | null;
  shiftMinutes: number | null;
  /** Calculated from the draw hours, never read. */
  drawMinutes: number | null;
  /** ⚠️ things worth a second look. They never stop you saving. */
  warnings: string[];
  /** Something that does: a missing date or time. */
  error: string | null;
}

// ------------------------------------------------------------ stage 5

/**
 * What a tracker records:
 *
 * - `"yesno"`: whether it happened ("took meds").
 * - `"scale"`: how much, from 1 to 10 ("headache").
 * - `"note"`: a few words ("payday: $1,240").
 */
export type TrackerKind = "yesno" | "scale" | "note";

/** A tracker: "please keep an eye out for this". */
export interface Tracker {
  id: string;
  /** "headache", "took meds", "payday". */
  name: string;
  kind: TrackerKind;
  /**
   * Your keywords. Clues for Jev (stage 7), not rules: Jev still decides
   * whether it actually happened, so "I *don't* have a headache" doesn't
   * log one.
   */
  hintWords: string[];
  /** If false, it's logged quietly and she never raises it unprompted. */
  canBringUp: boolean;
  position: number;
  createdAt: string;
}

/**
 * How a log entry got there: you added it, processing committed it
 * (stage 7), or she asked and you confirmed.
 */
export type LogSource = "user" | "processing" | "confirmed";

/** A log entry: a sticker on a day. */
export interface LogEntry {
  id: string;
  trackerId: string;
  date: string;
  /** "yes" or "no", a number from 1 to 10 as text, or a note. */
  value: string;
  source: LogSource;
  /** The message it came from, if any, so you can see exactly where. */
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------ stage 6

/**
 * One tool call she made during a turn, as kept in the tool log (see
 * `src/activity.ts`). The same shape as Aettica's.
 */
export interface ToolCallRecord {
  id: string;
  channelId: string;
  /** The turn it belongs to: the same id as the messages that turn wrote. */
  turnId: string;
  /** Which round of the turn (a model can call tools, see results, and call more). */
  round: number;
  name: string;
  /** The arguments exactly as the model wrote them. */
  arguments: string;
  /** What was sent back to the model, as JSON text. */
  result: string;
  status: "ok" | "error";
  /** For people: "looked up plans for Oct 1–7". For errors, what went wrong. */
  summary: string;
  /** `native` if the API returned it as a tool call; `text` if it was written out in the reply. */
  source: "native" | "text";
  profile: string | null;
  createdAt: string;
}
