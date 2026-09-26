/**
 * Prompt assembly: turning a channel into what the model actually reads.
 *
 * A model has no memory between requests. Every time Kitsikai takes a turn,
 * the whole context is rebuilt from scratch and sent along: a `system`
 * message with everything she should know, then the recent conversation as
 * alternating `user`/`assistant` messages.
 *
 * The system message is made of labelled sections ("layers"), always in the
 * same order:
 *
 *   1. Who you are      fixed framing, then her persona (editable)
 *   2. How you text     how her messages should look
 *   3. Right now        the date and time on the phone
 *   4. Model notes      the connection profile's notes on this model
 *
 * Later stages add more sections in between (channels, plans, her notes and
 * pins), but the shape stays the same.
 */

import type { Channel, ChatMessage, Message, Settings } from "./types.ts";

/**
 * Fixed framing that comes before her persona. It explains the *situation*:
 * she's a friend texting you, not an assistant. It's the core idea of the
 * app, so it isn't editable.
 */
export const FRAMING = `You are Kitsikai, the user's friend. You text each other through a small app that looks like a chat server you share. You are not an assistant and you never talk like one: you're a person with your own life, voice and opinions, texting a friend.`;

/** How her messages should look. */
export const TEXTING_STYLE = `Write only your next text message: no quotation marks around it, no name in front, no narration or stage directions, no preamble. Keep it the length of a real text.`;

/**
 * Messages sent when she takes a turn without a new message from you.
 *
 * Most chat models expect the conversation to end on a `user` message and get
 * confused if it ends on their own reply. So when she's continuing after her
 * own message, or starting an empty channel, the stack ends with a short
 * note. It's never saved or shown in the chat.
 */
export const NUDGES = {
  continue: "(App note, not from them: they haven't written anything new. Text them only if you have something to add.)",
  opening: "(App note, not from them: this channel is empty. Say hi, however feels natural.)",
};

/**
 * One labelled section of the system prompt. Keeping the label next to the
 * text makes the assembled prompt readable when you inspect it, and helps the
 * model tell the sections apart.
 */
export interface Layer {
  title: string;
  content: string | null | undefined;
}

/** Everything the prompt stack is built from. */
export interface PromptInput {
  settings: Settings;
  /** The channel she's writing in. */
  channel: Channel;
  /** The channel's recent messages, oldest first (already cut to the history limit). */
  messages: Message[];
  /** The time on the phone right now. */
  now: Date;
  /** The connection profile's notes on this model's habits. */
  modelNotes?: string;
}

/**
 * Build the prompt stack for one of her turns.
 *
 * @returns The messages to send to the chat completions API.
 */
export function buildPromptStack({ settings, channel, messages, now, modelNotes }: PromptInput): ChatMessage[] {
  const layers: Layer[] = [
    { title: "Who you are", content: joinNonEmpty([FRAMING, settings.persona, whoTheyAre(settings)]) },
    { title: "How you text", content: TEXTING_STYLE },
    { title: "Right now", content: describeNow(now) },
    { title: "Model notes", content: modelNotes },
  ];

  const system: ChatMessage = { role: "system", content: renderLayers(layers) };
  const history = toChatHistory(messages);

  // If the conversation doesn't end on your message, add a note so the model
  // knows it's being asked to continue. This is what lets her take a turn
  // without you writing anything: the design's core rule.
  const last = history.at(-1);
  if (!last || last.role !== "user") {
    history.push({ role: "user", content: last ? NUDGES.continue : NUDGES.opening });
  }
  void channel; // the channel's name and topic join the prompt in stage 2
  return [system, ...history];
}

/** "Their name is Sam." if you've set your name. */
function whoTheyAre(settings: Settings): string {
  return settings.userName ? `The person you're texting is ${settings.userName}.` : "";
}

/**
 * The date and time, the way a person would say it:
 * "It's Saturday, September 26, 2026, 4:12 PM."
 */
export function describeNow(now: Date): string {
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `It's ${day}, ${formatClock(now)}.`;
}

/** "4:12 PM" */
export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Turn the layers into one system prompt, skipping empty ones.
 * Each layer becomes a Markdown heading followed by its text.
 */
export function renderLayers(layers: Layer[]): string {
  return layers
    .filter((layer) => layer.content && layer.content.trim() !== "")
    .map((layer) => `## ${layer.title}\n\n${layer.content!.trim()}`)
    .join("\n\n");
}

/**
 * Convert saved messages into API messages.
 *
 * Your messages become `user`, hers become `assistant`. Two messages in a row
 * from the same author are merged into one, because some models reject two
 * `user` messages in a row, and merging never loses anything.
 */
export function toChatHistory(messages: Message[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (content === "") continue;
    const role = message.author === "user" ? "user" : "assistant";
    const previous = history.at(-1);
    if (previous && previous.role === role) previous.content += `\n\n${content}`;
    else history.push({ role, content });
  }
  return history;
}

export function joinNonEmpty(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p !== "")
    .join("\n\n");
}
