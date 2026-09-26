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
 *   their screen instead of a chat.
 */
export type ChannelKind = "text";

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
export type ApiMessage = ChatMessage | { role: "assistant"; content: string | null; tool_calls: ApiToolCall[] };

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
