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
  /**
   * An image you sent (src/images.ts). Its `content` is then what the vision
   * model saw in it, which is what every model gets instead of the image.
   */
  image?: MessageImage;
}

/** An image in a message: the file, and how reading it went. */
export interface MessageImage {
  /** The file's name in `data/images/`. */
  file: string;
  mimeType: string;
  /** Its size in pixels, when known, so the chat can make room for it before it loads. */
  width: number | null;
  height: number | null;
  /** "reading" while the vision model looks at it, then "read", or "failed". */
  status: "reading" | "read" | "failed";
  /** Why reading it failed. */
  error: string | null;
  /** The profile that read it, and its model. */
  readBy: string | null;
  model: string | null;
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
  /**
   * Who reads the images you send in chat (a vision model): a profile or
   * roulette assignment, or "" for the same as screenshots.
   */
  imageAssignment: string;
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
  /**
   * Which connection profile writes her notes, pins and plan cards from chat
   * (stage 7: "the processing writer"). A cheap, steady one. `""` for the
   * first profile.
   */
  writerAssignment: string;
  /**
   * Jev's model id on nanoGPT (stage 7), pinned to a version so upgrades
   * happen on purpose. `""` turns Jev off: the fallback answers, if set.
   */
  decisionModel: string;
  /** A profile that answers Jev's questions when Jev can't: `"profile:<id>"`, or `""` for none. */
  decisionFallback: string;
  /** How sure Jev has to be (0.5 to 0.99) for a confident yes or no. Anything less is "unsure". */
  decisionConfidence: number;
  /** How often she processes her scratchpad, in hours. */
  processingHours: number;
  /** The most pins she keeps up at once. */
  pinCap: number;
  /** Show "Kitsikai's notes" in settings (the advanced page). Changes nothing about her. */
  showAdvanced: boolean;
  /** Whether she can text first (stage 8). Off: she only ever replies. Reminders stop too. */
  textFirst: boolean;
  /** How often she checks whether to text first, in minutes (the snapshot check). */
  snapshotMinutes: number;
  /**
   * The double-text cap: how many messages she may send first in a row
   * without a reply. `"judge"` lets Jev decide each time. A number is a hard
   * wall: once reached, Jev isn't even asked. Reminders ignore it.
   */
  doubleTextCap: DoubleTextCap;
  /** Post her messages as phone notifications (Termux) while the app isn't open. */
  notifications: boolean;
  /** Show her message's text in the notification. Off: only "new message", for a lock screen others can see. */
  notificationPreview: boolean;
  /**
   * Whether Jev routes her intimacy registers (see src/intimacy.ts). Off: she
   * stays in "warm" and the persona's [INTIMACY] section does the work alone.
   * The safeword works either way.
   */
  intimacyEnabled: boolean;
  /** The app theme's id (see `src/themes.ts`). "classic" is the default look. */
  appTheme: string;
  /**
   * Where you've moved a theme's sliders, by theme id, then option id.
   * Options you haven't moved use the theme's defaults.
   */
  themeOptions: Record<string, Record<string, number>>;
}

/** The double-text cap (see `Settings.doubleTextCap`). */
export type DoubleTextCap = "judge" | 1 | 2 | 3;

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
  /**
   * Shifts only: you stay away overnight after this shift (a hotel night),
   * linked to your next shift. Set by hand: a schedule screenshot can't tell.
   */
  overnight: boolean;
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
  /** A shift marked "overnight": the hotel night after it, until the linked shift. */
  stay: OvernightStay | null;
}

/** The hotel night after an "overnight" shift. */
export interface OvernightStay {
  /** The next shift it links to (its occurrence key, day and start), or `null` if there's none within two days. */
  nextKey: string | null;
  nextDate: string | null;
  nextTime: string | null;
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
  /** A hotel night after this shift, linked to the next: ticked by hand in the review list. */
  overnight: boolean;
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
export type LogSource = "user" | "processing" | "confirmed" | "kitsikai";

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

// ------------------------------------------------------------ stage 7

/**
 * What a scratchpad note is about:
 *
 * - `"tracker"`: something a tracker watches for seemed to happen.
 * - `"plan"`: they mentioned a plan (it becomes one only after they say yes).
 * - `"remember"`: something a friend would remember ("they seemed stressed
 *   about the new manager, check in later").
 * - `"request"`: they asked her to pin something, or let a pin go.
 */
export type NoteKind = "tracker" | "plan" | "remember" | "request";

/**
 * Where a note is:
 *
 * - `"open"`: on the scratchpad, in pencil, waiting for processing.
 * - `"asking"`: processing wasn't sure (or it's a plan): she asks you.
 * - `"bringup"`: kept, as something she might bring up.
 * - `"done"`: committed to the binder, or settled.
 * - `"tossed"`: wrong, taken back, or you said no.
 */
export type NoteStatus = "open" | "asking" | "bringup" | "done" | "tossed";

/** A plan as drafted from chat by the processing writer, before you say yes. */
export interface PlanDraft {
  kind: PlanKind;
  title: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  shiftType: ShiftType | null;
  notes: string;
}

/** A sticky note on her scratchpad. */
export interface Note {
  id: string;
  kind: NoteKind;
  /** The note, in her words. */
  text: string;
  status: NoteStatus;
  /** `"noticed"`: Jev noticed it in chat. `"jotted"`: she wrote it herself, with a tool. */
  origin: "noticed" | "jotted";
  /** A request from you: honored at processing. */
  yours: boolean;
  /** About something in the next few hours: processed early. */
  timeSensitive: boolean;
  /** You already said yes to it, so processing doesn't need to check. */
  confirmed: boolean;
  /** Tracker notes: which tracker, the value and the day. */
  trackerId: string | null;
  value: string | null;
  date: string | null;
  /** Plan notes: the plan, as drafted. */
  planDraft: PlanDraft | null;
  /** Request notes: pin something, or let one go. */
  request: "pin" | "unpin" | null;
  /** Asking notes: what she's asking you. */
  ask: string | null;
  channelId: string | null;
  /** The message it came from. */
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** A pin: something that matters right now, always in her view. */
export interface Pin {
  id: string;
  /** What it is, in her words. */
  text: string;
  /** Why she pinned it. */
  reason: string;
  /** When to take it down: a condition, in words ("once they say the manager thing settled"). */
  unpinWhen: string;
  /** Or a date: after this day, it comes down. */
  unpinDate: string | null;
  /** `"drawer"`: unpinned. Not forgotten: her tools can still find it. */
  status: "pinned" | "drawer";
  /** You asked her to pin it. */
  yours: boolean;
  noteId: string | null;
  pinnedAt: string;
  unpinnedAt: string | null;
  unpinReason: string | null;
}

/** What started a processing round. */
export type ProcessingTrigger = "timer" | "early" | "manual";

/** One processing round. */
export interface ProcessingRun {
  id: string;
  trigger: ProcessingTrigger;
  startedAt: string;
  finishedAt: string | null;
  /** Why it stopped early, if it did (Jev unreachable, say). */
  error: string | null;
}

/** Something that happened to her notes or pins. */
export type MemoryAction =
  | "noted"
  | "rewritten"
  | "committed"
  | "asking"
  | "bringup"
  | "pinned"
  | "unpinned"
  | "tossed"
  | "kept"
  | "confirmed"
  | "declined"
  | "done"
  | "error";

/** One line of the processing log: what happened, and why. */
export interface MemoryLogEntry {
  id: string;
  /** The processing round, or `null` for something that happened during chat. */
  runId: string | null;
  action: MemoryAction;
  /** What it was about ("headache 6/10 on Sat Sep 26"). */
  text: string;
  /** Why ("still true, 94% sure"). */
  reason: string;
  noteId: string | null;
  pinId: string | null;
  /** The message it came from, to see exactly where. */
  messageId: string | null;
  createdAt: string;
}

// ------------------------------------------------------------ stage 8

/** Why she's texting first. */
export type ProactiveReason = "reminder" | "checkin" | "followup" | "just-because";

/**
 * What a snapshot check did:
 *
 * - `"sent"`: she texted first.
 * - `"queued"`: a reminder, routed into the conversation you're having.
 * - `"waiting"`: something to say, but every channel was mid-conversation.
 * - `"declined"`: she was asked to text, and chose not to.
 * - `"nothing"`: nothing worth texting about.
 * - `"error"`: something failed (Jev unreachable, say).
 */
export type ProactiveOutcome = "sent" | "queued" | "waiting" | "declined" | "nothing" | "error";

/** One snapshot check, as kept in the texting-first log. */
export interface ProactiveLogEntry {
  id: string;
  trigger: "timer" | "manual";
  outcome: ProactiveOutcome;
  reason: ProactiveReason | null;
  channelId: string | null;
  messageId: string | null;
  /** What happened and why, in words. */
  detail: string;
  /** For check-ins: which work block, so each gets one. */
  key: string | null;
  createdAt: string;
}

/** A reminder that has gone off, and hasn't been sent or skipped yet. */
export interface DueReminder {
  /** `planId:date:reminderId`: unique for each reminder of each occurrence. */
  key: string;
  occurrence: Occurrence;
  reminder: ReminderTime;
  /** When it went off. */
  at: string;
  /** In words: "Dentist (appointment), today at 3:00p". */
  text: string;
  /** The channel it was routed into, if every channel was mid-conversation. */
  queuedIn: string | null;
}

/** What happened to a reminder. */
export interface ReminderRecord {
  key: string;
  planId: string;
  text: string;
  status: "queued" | "sent" | "skipped";
  channelId: string | null;
  messageId: string | null;
  /** Why ("they already talked about it, 92% sure"). */
  reason: string;
  dueAt: string;
  updatedAt: string;
}
