/**
 * The store: reading and writing Kitsikai's data.
 *
 * Everything lives in an SQLite database (`data/kitsikai.db`); the table
 * layout is described in `src/db.ts`. The rest of the server only talks to
 * the store through the methods of the `Store` class below (and the helpers
 * it holds, like `store.profiles`), and never writes SQL itself. That keeps
 * every query in one place.
 *
 * All methods are synchronous. Bun's SQLite driver answers immediately
 * (there is no network in between), so there is nothing to wait for.
 *
 * Adapted from Aettica's store.ts: the channel and message parts are the
 * same idea, without scenes, modes or characters.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ToolLog } from "./activity.ts";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { IntimacyHold } from "./hold.ts";
import { JevLog } from "./jevlog.ts";
import { Memory } from "./memory.ts";
import { ProactiveLog, Reminders } from "./reminders.ts";
import { Plans } from "./planner.ts";
import { Profiles } from "./profiles.ts";
import { Trackers } from "./trackers.ts";
import type { Author, Channel, ChannelKind, Message, MessageImage, Settings } from "./types.ts";

export { NotFoundError, ValidationError };

/** Where the starting persona is kept. */
const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");

/** The model a brand-new server's first connection profile uses. */
export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.1-Terminus";

/** Jev, pinned to a version (not jev-latest): upgrade on purpose. */
export const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";

// ------------------------------------------------------------- defaults

/**
 * Settings used until you change them. Her persona comes from
 * `defaults/persona.md`, so it's easy to read and edit as plain text.
 *
 * Settings are merged over these every time they're read, so a setting added
 * in a newer version of Kitsikai quietly gets its default.
 */
export function defaultSettings(): Settings {
  return {
    name: "Kitsikai",
    userName: "",
    persona: readDefault("persona.md"),
    chatAssignment: "",
    screenshotAssignment: "",
    imageAssignment: "",
    historyLimit: 40,
    appTheme: "classic",
    themeOptions: {},
    homeChannelId: "",
    replyDebounceSeconds: 4,
    typingBaseMs: 600,
    typingPerCharMs: 40,
    writerAssignment: "",
    decisionModel: DEFAULT_DECISION_MODEL,
    decisionFallback: "",
    decisionConfidence: 0.8,
    processingHours: 3,
    pinCap: 10,
    showAdvanced: false,
    textFirst: true,
    snapshotMinutes: 10,
    doubleTextCap: "judge",
    notifications: true,
    notificationPreview: true,
    intimacyEnabled: true,
  };
}

function readDefault(fileName: string): string {
  const path = join(DEFAULTS_DIR, fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

// ------------------------------------------------------------ validation

/** Longest persona, in characters. */
const LONG_TEXT = 100_000;
/** Longest name (channel, hers, yours), in characters. */
const NAME = 100;

/**
 * Check a partial settings update coming from the browser.
 *
 * Anything arriving over the network is untrusted, even from your own app, so
 * each field is checked for the right type and range. Unknown fields are
 * dropped. Returns the cleaned update, or throws an error describing the first
 * problem found.
 */
export function validateSettings(input: unknown): Partial<Settings> {
  const raw = requireObject(input, "Settings");
  const clean: Partial<Settings> = {};

  if (raw.name !== undefined) clean.name = name(raw.name, "name");
  if (raw.userName !== undefined) clean.userName = optionalName(raw.userName, "userName");
  if (raw.persona !== undefined) clean.persona = longText(raw.persona, "persona");
  // Only the form is checked here; the server checks the profile or
  // roulette exists.
  if (raw.chatAssignment !== undefined) clean.chatAssignment = assignment(raw.chatAssignment, "chatAssignment") ?? "";
  if (raw.screenshotAssignment !== undefined) {
    clean.screenshotAssignment = assignment(raw.screenshotAssignment, "screenshotAssignment") ?? "";
  }
  if (raw.imageAssignment !== undefined) clean.imageAssignment = assignment(raw.imageAssignment, "imageAssignment") ?? "";
  if (raw.historyLimit !== undefined) clean.historyLimit = numberInRange(raw.historyLimit, "historyLimit", 1, 1000, true);
  // Only the id's form is checked here; the server checks the theme exists.
  if (raw.appTheme !== undefined) clean.appTheme = themeId(raw.appTheme, "appTheme");
  if (raw.themeOptions !== undefined) clean.themeOptions = themeOptions(raw.themeOptions);
  // Only the form is checked here; the server checks the channel exists.
  if (raw.homeChannelId !== undefined) {
    if (typeof raw.homeChannelId !== "string" || raw.homeChannelId.length > 100) {
      throw new ValidationError("homeChannelId must be a channel id");
    }
    clean.homeChannelId = raw.homeChannelId;
  }
  if (raw.replyDebounceSeconds !== undefined) {
    clean.replyDebounceSeconds = numberInRange(raw.replyDebounceSeconds, "replyDebounceSeconds", 0, 120, false);
  }
  if (raw.typingBaseMs !== undefined) clean.typingBaseMs = numberInRange(raw.typingBaseMs, "typingBaseMs", 0, 10_000, true);
  if (raw.typingPerCharMs !== undefined) {
    clean.typingPerCharMs = numberInRange(raw.typingPerCharMs, "typingPerCharMs", 0, 1000, true);
  }
  // Stage 7: her memory.
  if (raw.writerAssignment !== undefined) clean.writerAssignment = assignment(raw.writerAssignment, "writerAssignment") ?? "";
  if (raw.decisionModel !== undefined) {
    if (typeof raw.decisionModel !== "string" || raw.decisionModel.trim().length > 200) {
      throw new ValidationError("decisionModel must be a model id");
    }
    clean.decisionModel = raw.decisionModel.trim();
  }
  if (raw.decisionFallback !== undefined) {
    const value = assignment(raw.decisionFallback, "decisionFallback") ?? "";
    if (value.startsWith("roulette:")) throw new ValidationError("decisionFallback must be a profile, not a roulette");
    clean.decisionFallback = value;
  }
  if (raw.decisionConfidence !== undefined) {
    clean.decisionConfidence = numberInRange(raw.decisionConfidence, "decisionConfidence", 0.5, 0.99, false);
  }
  if (raw.processingHours !== undefined) {
    clean.processingHours = numberInRange(raw.processingHours, "processingHours", 0.25, 48, false);
  }
  if (raw.pinCap !== undefined) clean.pinCap = numberInRange(raw.pinCap, "pinCap", 1, 50, true);
  if (raw.showAdvanced !== undefined) clean.showAdvanced = bool(raw.showAdvanced, "showAdvanced");
  // Stage 8: texting first.
  if (raw.textFirst !== undefined) clean.textFirst = bool(raw.textFirst, "textFirst");
  if (raw.snapshotMinutes !== undefined) clean.snapshotMinutes = numberInRange(raw.snapshotMinutes, "snapshotMinutes", 1, 240, true);
  if (raw.doubleTextCap !== undefined) {
    if (raw.doubleTextCap !== "judge" && raw.doubleTextCap !== 1 && raw.doubleTextCap !== 2 && raw.doubleTextCap !== 3) {
      throw new ValidationError('doubleTextCap must be "judge", 1, 2 or 3');
    }
    clean.doubleTextCap = raw.doubleTextCap;
  }
  if (raw.notifications !== undefined) clean.notifications = bool(raw.notifications, "notifications");
  if (raw.notificationPreview !== undefined) clean.notificationPreview = bool(raw.notificationPreview, "notificationPreview");
  if (raw.intimacyEnabled !== undefined) clean.intimacyEnabled = bool(raw.intimacyEnabled, "intimacyEnabled");

  return clean;
}

/**
 * A profile or roulette assignment: `"profile:<id>"` or `"roulette:<id>"`.
 * `null` or `""` means none (returned as `null`).
 */
export function assignment(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^(profile|roulette):[\w-]{1,100}$/.test(value)) {
    throw new ValidationError(`${field} must be "profile:<id>" or "roulette:<id>"`);
  }
  return value;
}

/**
 * Slider values for themes: `{ "rainy-window": { "bubble-transparency": 0.6 } }`.
 * Only the shape is checked; each theme's own ranges are applied by the app.
 */
function themeOptions(value: unknown): Settings["themeOptions"] {
  const themes = requireObject(value, "themeOptions");
  const entries = Object.entries(themes);
  if (entries.length > 100) throw new ValidationError("themeOptions has too many themes");
  return Object.fromEntries(
    entries.map(([id, options]) => {
      themeId(id, "themeOptions");
      const values = Object.entries(requireObject(options, "themeOptions"));
      if (values.length > 20) throw new ValidationError("themeOptions has too many options for one theme");
      for (const [key, number] of values) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || typeof number !== "number" || !Number.isFinite(number)) {
          throw new ValidationError("themeOptions values must be numbers, by option id");
        }
      }
      return [id, Object.fromEntries(values) as Record<string, number>];
    }),
  );
}

/** A theme id: lowercase letters, digits and dashes. */
export function themeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new ValidationError(`${field} must be a theme id`);
  }
  return value;
}

/** The kinds of channel you can make (see `ChannelKind`). */
export const CHANNEL_KINDS: ChannelKind[] = ["text", "planner", "trackers"];

/** Kinds of channel that show a screen instead of a chat. You can only have one of each. */
export const SCREEN_KINDS: ChannelKind[] = ["planner", "trackers"];

/** The fields you give when creating a channel. */
export interface NewChannel {
  name: string;
  kind: ChannelKind;
  topic?: string;
}

/** Check the body of a "create channel" request. */
export function validateNewChannel(input: unknown): NewChannel {
  const raw = requireObject(input, "Channel");
  const kind = raw.kind ?? "text";
  if (!CHANNEL_KINDS.includes(kind as ChannelKind)) {
    throw new ValidationError(`kind must be one of: ${CHANNEL_KINDS.join(", ")}`);
  }
  return {
    name: channelName(raw.name),
    kind: kind as ChannelKind,
    ...(raw.topic !== undefined ? { topic: topic(raw.topic) } : {}),
  };
}

/** A channel topic: short text, maybe empty. */
function topic(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("topic must be text");
  if (value.trim().length > 300) throw new ValidationError("topic is too long (300 characters at most)");
  return value.trim();
}

/**
 * The channel fields that can be changed after creation.
 */
export type ChannelUpdate = Partial<Pick<Channel, "name" | "topic" | "theme" | "assignment">>;

/** Check a partial channel update. The kind can't be changed, so it's ignored. */
export function validateChannelUpdate(input: unknown): ChannelUpdate {
  const raw = requireObject(input, "Channel");
  const clean: ChannelUpdate = {};
  if (raw.name !== undefined) clean.name = channelName(raw.name);
  if (raw.topic !== undefined) clean.topic = topic(raw.topic);
  // `null` (or "") means "use the app theme".
  if (raw.theme !== undefined) clean.theme = raw.theme === null || raw.theme === "" ? null : themeId(raw.theme, "theme");
  // `null` (or "") means "use the app-wide chat assignment".
  if (raw.assignment !== undefined) clean.assignment = assignment(raw.assignment, "assignment");
  return clean;
}

/**
 * A channel name, Discord-style: lowercase, with dashes for spaces
 * ("Work Stuff" becomes "work-stuff"), so it reads well after a `#`.
 */
export function channelName(value: unknown): string {
  const cleaned = name(value, "name")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^#+/, "");
  if (cleaned === "") throw new ValidationError("name must be non-empty text");
  return cleaned;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be true or false`);
  return value;
}

export function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

/** A required, non-empty, reasonably short piece of text, trimmed. */
export function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be non-empty text`);
  if (value.trim().length > NAME) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

/** Like `name`, but may be empty. */
function optionalName(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.trim().length > NAME) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

export function longText(value: unknown, field: string, max = LONG_TEXT): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length > max) throw new ValidationError(`${field} is too long`);
  return value;
}

export function numberInRange(value: unknown, field: string, min: number, max: number, wholeNumber: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${field} must be a number`);
  if (wholeNumber && !Number.isInteger(value)) throw new ValidationError(`${field} must be a whole number`);
  if (value < min || value > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return value;
}

// ----------------------------------------------------------- row mapping

/*
 * The database uses snake_case column names (`channel_id`), while the rest
 * of the code uses camelCase (`channelId`). These types describe rows exactly
 * as SQLite returns them, and the functions below convert them.
 */

interface ChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  topic: string;
  theme: string | null;
  assignment: string | null;
  position: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author: Author;
  content: string;
  turn_id: string | null;
  created_at: string;
  edited_at: string | null;
  model: string | null;
  profile: string | null;
  image: string | null;
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    topic: row.topic,
    theme: row.theme,
    assignment: row.assignment,
    position: row.position,
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    author: row.author,
    content: row.content,
    turnId: row.turn_id,
    createdAt: row.created_at,
    // Only include optional fields when they have a value.
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.image ? { image: JSON.parse(row.image) as MessageImage } : {}),
  };
}

const MESSAGE_COLUMNS = "id, channel_id, author, content, turn_id, created_at, edited_at, model, profile, image";
const SELECT_MESSAGES = `SELECT ${MESSAGE_COLUMNS} FROM messages`;

// ----------------------------------------------------------------- store

/** The fields you give when adding a message. */
export interface NewMessage {
  channelId: string;
  author: Author;
  content: string;
  model?: string;
  /** The name of the profile that wrote it (her messages). */
  profile?: string;
  /** Shared by messages written together. Defaults to `null`. */
  turnId?: string | null;
  /** An image you sent (src/images.ts). */
  image?: MessageImage;
}

export class Store {
  readonly db: Database;
  /** Connection profiles and roulettes (see `src/profiles.ts`). */
  readonly profiles: Profiles;
  /** Plans: shifts and events (see `src/planner.ts`). */
  readonly plans: Plans;
  /** Trackers and their log entries (see `src/trackers.ts`). */
  readonly trackers: Trackers;
  /** Every tool call she makes (see `src/activity.ts`). */
  readonly toolLog: ToolLog;
  /** Her scratchpad, pins and processing log (see `src/memory.ts`). */
  readonly memory: Memory;
  /** Reminders sent, and on-call shifts you're called in to (see `src/reminders.ts`). */
  readonly reminders: Reminders;
  /** What her snapshot checks decided (see `src/proactive.ts`). */
  readonly proactiveLog: ProactiveLog;
  /** The safeword hold (see `src/hold.ts`, `src/intimacy.ts`). */
  readonly intimacy: IntimacyHold;
  /** Every Jev call from the last 36 hours (see `src/jevlog.ts`). */
  readonly jevLog: JevLog;

  /**
   * Open (or create) the database inside `dataDir`.
   *
   * The very first time, it's filled with starting content: a `#general`
   * channel, the 📅 planner, the trackers, and one connection profile.
   *
   * @param dataDir  Folder for the database. Created if it doesn't exist.
   *                 Pass `":memory:"` for a throwaway database (for tests).
   * @param clock    What time it is, for new messages' timestamps. Tests
   *                 pass a fake clock, so messages and her timers agree.
   */
  constructor(
    dataDir: string,
    readonly clock: () => Date = () => new Date(),
  ) {
    const inMemory = dataDir === ":memory:";
    if (!inMemory) mkdirSync(dataDir, { recursive: true });
    const path = inMemory ? ":memory:" : join(dataDir, "kitsikai.db");

    const isNew = inMemory || !existsSync(path);
    this.db = openDatabase(path);
    this.profiles = new Profiles(this.db);
    this.plans = new Plans(this.db);
    this.trackers = new Trackers(this.db);
    this.toolLog = new ToolLog(this.db);
    this.memory = new Memory(this.db);
    this.reminders = new Reminders(this.db);
    this.proactiveLog = new ProactiveLog(this.db);
    this.intimacy = new IntimacyHold(this.db);
    this.jevLog = new JevLog(this.db);

    if (isNew) this.seed();
  }

  /** Starting content for a brand-new server. */
  private seed(): void {
    this.db.transaction(() => {
      this.insertChannel("general", "text");
      this.insertChannel("planner", "planner");
      this.insertChannel("trackers", "trackers");
      this.profiles.create({ name: DEFAULT_MODEL.split("/").at(-1), model: DEFAULT_MODEL });
    })();
  }

  /**
   * Close the database. Only needed in tests, which open many. Fails loudly
   * if anything was left open (see `KitsikaiDatabase` in src/db.ts).
   */
  close(): void {
    this.db.close(true);
  }

  // -------------------------------------------------------------- settings

  /** The current settings, with defaults for anything never changed. */
  getSettings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...defaultSettings(), ...saved };
  }

  /** Save an already-validated settings update. Returns the new settings. */
  updateSettings(update: Partial<Settings>): Settings {
    // "Upsert": insert the key, or if it already exists, update its value.
    const upsert = this.db.query(
      "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(update)) {
        if (value !== undefined) upsert.run({ key, value: JSON.stringify(value) });
      }
    })();
    return this.getSettings();
  }

  // -------------------------------------------------------------- channels

  /** Every channel, in sidebar order. */
  listChannels(): Channel[] {
    const rows = this.db.query("SELECT * FROM channels ORDER BY position").all() as ChannelRow[];
    return rows.map(toChannel);
  }

  /** One channel. Throws `NotFoundError` if there's no such channel. */
  getChannel(id: string): Channel {
    const row = this.db.query("SELECT * FROM channels WHERE id = $id").get({ id }) as ChannelRow | null;
    if (!row) throw new NotFoundError("channel");
    return toChannel(row);
  }

  /**
   * Create a channel at the bottom of the sidebar. There can be only one
   * planner: it shows the same plans however many there are.
   */
  createChannel(input: NewChannel): Channel {
    if (SCREEN_KINDS.includes(input.kind) && this.listChannels().some((c) => c.kind === input.kind)) {
      throw new ValidationError(`There's already a ${input.kind} channel.`);
    }
    const channel = this.insertChannel(input.name, input.kind);
    return input.topic ? this.updateChannel(channel.id, { topic: input.topic }) : channel;
  }

  /** Add a channel at the bottom of the sidebar. */
  protected insertChannel(channelNameValue: string, kind: ChannelKind): Channel {
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM channels").get() as {
      next: number;
    };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO channels (id, name, kind, position, created_at)
         VALUES ($id, $name, $kind, $position, $createdAt)`,
      )
      .run({ id, name: channelNameValue, kind, position: next, createdAt: new Date().toISOString() });
    return this.getChannel(id);
  }

  /** Change a channel's name, topic, theme or profile. Returns the updated channel. */
  updateChannel(id: string, update: ChannelUpdate): Channel {
    const merged = { ...this.getChannel(id), ...update };
    this.db
      .query("UPDATE channels SET name = $name, topic = $topic, theme = $theme, assignment = $assignment WHERE id = $id")
      .run({ id, name: merged.name, topic: merged.topic, theme: merged.theme, assignment: merged.assignment });
    return this.getChannel(id);
  }

  /**
   * Put the channels in a new order.
   *
   * @param ids  Every channel id, in the new order. Leaving one out or adding
   *             an unknown one is an error, so the order can never end up
   *             with gaps or duplicates.
   */
  reorderChannels(ids: string[]): Channel[] {
    const existing = new Set(this.listChannels().map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every channel exactly once.");
    }
    const setPosition = this.db.query("UPDATE channels SET position = $position WHERE id = $id");
    this.db.transaction(() => {
      ids.forEach((id, position) => setPosition.run({ id, position }));
    })();
    return this.listChannels();
  }

  /**
   * Delete a channel and, through `ON DELETE CASCADE`, all its messages.
   * The last text channel can't be deleted: she needs somewhere to talk.
   */
  deleteChannel(id: string): void {
    const channel = this.getChannel(id);
    if (channel.kind === "text" && this.listChannels().filter((c) => c.kind === "text").length === 1) {
      throw new ValidationError("You need at least one text channel, so the last one can't be deleted.");
    }
    this.db.query("DELETE FROM channels WHERE id = $id").run({ id });
  }

  /**
   * The home channel: the one you chose in settings, or the first text
   * channel if you haven't (or if yours was deleted).
   */
  homeChannel(): Channel {
    const chosen = this.getSettings().homeChannelId;
    const text = this.listChannels().filter((c) => c.kind === "text");
    return text.find((c) => c.id === chosen) ?? text[0]!;
  }

  /**
   * Stop using a theme that's been deleted: the app theme goes back to
   * Classic, and channels using it go back to the app theme.
   */
  forgetTheme(themeIdValue: string): void {
    this.db.transaction(() => {
      const settings = this.getSettings();
      if (settings.appTheme === themeIdValue) this.updateSettings({ appTheme: "classic" });
      if (settings.themeOptions[themeIdValue]) {
        const { [themeIdValue]: _gone, ...rest } = settings.themeOptions;
        this.updateSettings({ themeOptions: rest });
      }
      this.db.query("UPDATE channels SET theme = NULL WHERE theme = $themeId").run({ themeId: themeIdValue });
    })();
  }

  // -------------------------------------------------------------- messages

  /** Every message in a channel, oldest first. */
  getMessages(channelId: string): Message[] {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const rows = this.db.query(`${SELECT_MESSAGES} WHERE channel_id = $channelId ORDER BY seq`).all({
      channelId,
    }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** The newest `limit` messages in a channel, oldest first. */
  recentMessages(channelId: string, limit: number): Message[] {
    const rows = this.db
      .query(
        `SELECT ${MESSAGE_COLUMNS} FROM (SELECT seq, ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = $channelId
           ORDER BY seq DESC LIMIT $limit) ORDER BY seq`,
      )
      .all({ channelId, limit }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Messages in a channel saved after a given `seq` (the counter every
   * message gets), oldest first, each with its seq. The scratchpad check
   * uses it to read each of your messages once (src/scratchpad.ts).
   */
  messagesSince(channelId: string, seq: number, limit = 200): { message: Message; seq: number }[] {
    // The newest `limit` of them, so a long history is never loaded whole.
    const rows = this.db
      .query(
        `SELECT seq, ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = $channelId AND seq > $seq
          ORDER BY seq DESC LIMIT $limit`,
      )
      .all({ channelId, seq, limit }) as (MessageRow & { seq: number })[];
    return rows.reverse().map((row) => ({ message: toMessage(row), seq: row.seq }));
  }

  /**
   * Search messages for words (all of them, in any order, ignoring case),
   * newest first: her `search_history` tool, for an imported chat or
   * anything older than what's in view.
   *
   * @param exclude  Message ids to leave out (the ones already in view).
   */
  searchMessages(words: string[], options: { channelIds: string[]; exclude?: Set<string>; limit?: number }): Message[] {
    if (words.length === 0 || options.channelIds.length === 0) return [];
    // LIKE treats % and _ as wildcards; escape them so they match themselves.
    const params: Record<string, string> = {};
    const likes = words.map((word, i) => {
      params[`w${i}`] = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return `content LIKE $w${i} ESCAPE '\\'`;
    });
    const channels = options.channelIds.map((id, i) => {
      params[`c${i}`] = id;
      return `$c${i}`;
    });
    const rows = this.db
      .query(`${SELECT_MESSAGES} WHERE channel_id IN (${channels.join(", ")}) AND ${likes.join(" AND ")} ORDER BY seq DESC LIMIT 500`)
      .all(params) as MessageRow[];
    return rows
      .map(toMessage)
      .filter((m) => !options.exclude?.has(m.id))
      .slice(0, options.limit ?? 20);
  }

  /** One message. Throws `NotFoundError` if there's no such message. */
  getMessage(id: string): Message {
    const row = this.db.query(`${SELECT_MESSAGES} WHERE id = $id`).get({ id }) as MessageRow | null;
    if (!row) throw new NotFoundError("message");
    return toMessage(row);
  }

  /** The newest message in a channel, or `undefined` if it's empty. */
  lastMessage(channelId: string): Message | undefined {
    const row = this.db
      .query(`${SELECT_MESSAGES} WHERE channel_id = $channelId ORDER BY seq DESC LIMIT 1`)
      .get({ channelId }) as MessageRow | null;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Add a message to the end of a channel.
   *
   * @param createdAt  For tests and imports; new messages get "now".
   */
  addMessage(input: NewMessage & { id?: string; createdAt?: string }): Message {
    const id = input.id ?? crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO messages (id, channel_id, author, content, turn_id, created_at, model, profile, image)
         VALUES ($id, $channelId, $author, $content, $turnId, $createdAt, $model, $profile, $image)`,
      )
      .run({
        id,
        channelId: input.channelId,
        author: input.author,
        content: input.content,
        turnId: input.turnId ?? null,
        createdAt: input.createdAt ?? this.clock().toISOString(),
        model: input.model ?? null,
        profile: input.profile ?? null,
        image: input.image ? JSON.stringify(input.image) : null,
      });
    return this.getMessage(id);
  }

  /**
   * Update an image message: how reading it went, and (when the vision model
   * has read it) what it saw, as the message's text. Text from reading isn't
   * an edit, so it clears "(edited)".
   */
  updateImage(id: string, changes: Partial<MessageImage>, content?: string): Message {
    const message = this.getMessage(id);
    if (!message.image) throw new ValidationError("That message has no image.");
    this.db
      .query(
        `UPDATE messages SET image = $image, content = COALESCE($content, content),
           edited_at = CASE WHEN $content IS NULL THEN edited_at ELSE NULL END WHERE id = $id`,
      )
      .run({ id, image: JSON.stringify({ ...message.image, ...changes }), content: content ?? null });
    return this.getMessage(id);
  }

  /** The file names of every image still in a message (the rest can go: `ImageFiles.sweep`). */
  imageFiles(): Set<string> {
    const rows = this.db.query("SELECT image FROM messages WHERE image IS NOT NULL").all() as { image: string }[];
    return new Set(rows.map((row) => (JSON.parse(row.image) as MessageImage).file));
  }

  /**
   * Add several messages at once, all or nothing, sharing a turn id.
   * Used for the bubbles of one of her replies.
   */
  addTurn(messages: Omit<NewMessage, "turnId">[], turnId: string = crypto.randomUUID()): Message[] {
    return this.db.transaction(() => messages.map((m) => this.addMessage({ ...m, turnId })))();
  }

  /**
   * Her most recent turn in a channel: every bubble of it, oldest first.
   * Empty if the channel doesn't end on one of her messages.
   */
  lastKitsikaiTurn(channelId: string): Message[] {
    const last = this.lastMessage(channelId);
    if (!last || last.author !== "kitsikai") return [];
    if (!last.turnId) return [last];
    const rows = this.db
      .query(`${SELECT_MESSAGES} WHERE channel_id = $channelId AND turn_id = $turnId ORDER BY seq`)
      .all({ channelId, turnId: last.turnId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Replace a message's text. Throws `NotFoundError` if it doesn't exist. */
  editMessage(id: string, content: string): Message {
    const result = this.db
      .query("UPDATE messages SET content = $content, edited_at = $editedAt WHERE id = $id")
      .run({ id, content, editedAt: this.clock().toISOString() });
    if (result.changes === 0) throw new NotFoundError("message");
    return this.getMessage(id);
  }

  /** Delete one message. Throws `NotFoundError` if it doesn't exist. */
  deleteMessage(id: string): void {
    const result = this.db.query("DELETE FROM messages WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("message");
  }

  /** Delete every message in a channel, keeping the channel itself. */
  clearMessages(channelId: string): void {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    this.db.query("DELETE FROM messages WHERE channel_id = $channelId").run({ channelId });
  }
}
