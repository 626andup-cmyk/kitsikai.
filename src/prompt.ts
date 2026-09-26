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
 *   1. Who you are             fixed framing, then her persona (editable)
 *   2. How you text            bubbles, split with <cht>
 *   3. Where you're texting    this channel, its topic, and the others
 *   4. Right now               the date and time on the phone
 *   5. Model notes             the connection profile's notes on this model
 *
 * Later stages add more sections in between (channels, plans, her notes and
 * pins), but the shape stays the same.
 */

import { BUBBLE_MARKER, joinBubbles } from "./bubbles.ts";
import type { Channel, ChatMessage, Message, Settings } from "./types.ts";

/**
 * Fixed framing that comes before her persona. It explains the *situation*:
 * she's a friend texting you, not an assistant. It's the core idea of the
 * app, so it isn't editable.
 */
export const FRAMING = `You are Kitsikai, the user's friend. You text each other through a small app that looks like a chat server you share. You are not an assistant and you never talk like one: you're a person with your own life, voice and opinions, texting a friend.`;

/**
 * How her messages should look: short bubbles with `<cht>` between them
 * (see src/bubbles.ts), and no made-up timestamps.
 */
export const TEXTING_STYLE = `Text the way people really text: a few short bubbles rather than one long message. Put ${BUBBLE_MARKER} between bubbles, like this:

omg wait ${BUBBLE_MARKER} you actually said that to him?? ${BUBBLE_MARKER} legend

One bubble is fine too, when that's all you'd send. Write only your texts: no quotation marks, no name in front, no narration or stage directions, no preamble.

Notes in square brackets like [9:12 PM, 3 hours later] are added by the app to show when time has passed. Never write them yourself.`;

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
  /** Every channel, in sidebar order (for "Where you're texting"). */
  channels?: Channel[];
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
export function buildPromptStack({ settings, channel, channels, messages, now, modelNotes }: PromptInput): ChatMessage[] {
  const layers: Layer[] = [
    { title: "Who you are", content: joinNonEmpty([FRAMING, settings.persona, whoTheyAre(settings)]) },
    { title: "How you text", content: TEXTING_STYLE },
    { title: "Where you're texting", content: describeChannels(channel, channels ?? [channel]) },
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
  return [system, ...history];
}

/**
 * Where she is, like: You're in #work (topic: "venting about shifts").
 * The other channels: #general, #gaming (topic: "games").
 */
export function describeChannels(channel: Channel, channels: Channel[]): string {
  const describe = (c: Channel) => (c.topic ? `#${c.name} (topic: "${c.topic}")` : `#${c.name}`);
  const others = channels.filter((c) => c.id !== channel.id && c.kind === "text");
  const lines = [
    `You're in ${describe(channel)}. The channels split up your conversations, but you're one person: you remember everything from all of them.`,
  ];
  if (others.length) lines.push(`The other channels: ${others.map(describe).join(", ")}.`);
  return lines.join("\n");
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
 * Your messages become `user`, hers become `assistant`. A run of bubbles from
 * the same person becomes one API message with `<cht>` between the bubbles,
 * which is the format she's asked to write in. (Some models also reject two
 * `user` messages in a row, so merging is needed anyway.)
 *
 * When an hour or more passes between two messages, the later one starts
 * with a note like `[9:12 PM, 3 hours later]`, so she can tell a
 * conversation from this morning from one that's still going.
 */
export function toChatHistory(messages: Message[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  let previousTime: Date | null = null;
  for (const message of messages) {
    let content = message.content.trim();
    if (content === "") continue;
    const time = new Date(message.createdAt);
    const marker = previousTime ? timeMarker(previousTime, time) : "";
    previousTime = time;
    if (marker) content = `${marker} ${content}`;

    const role = message.author === "user" ? "user" : "assistant";
    const previous = history.at(-1);
    if (previous && previous.role === role) previous.content = joinBubbles([previous.content, content]);
    else history.push({ role, content });
  }
  return history;
}

/** How long a gap has to be (in minutes) to get a time note. */
const GAP_MINUTES = 60;

/**
 * The note for a gap between two messages, or "" for a short one:
 * "[9:12 PM, 3 hours later]", or with the day when it changed:
 * "[Sun 9:12 AM, 2 days later]".
 */
export function timeMarker(before: Date, after: Date): string {
  const minutes = (after.getTime() - before.getTime()) / 60_000;
  if (minutes < GAP_MINUTES) return "";
  const hours = Math.round(minutes / 60);
  const days = Math.round(minutes / (60 * 24));
  const gap = hours < 36 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${days} day${days === 1 ? "" : "s"}`;
  const day = after.toDateString() === before.toDateString() ? "" : `${after.toLocaleDateString("en-US", { weekday: "short" })} `;
  return `[${day}${formatClock(after)}, ${gap} later]`;
}

/** Time notes the model copied into its reply by mistake, to take out again. */
const COPIED_MARKER = /\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\d{1,2}:\d{2}\s?[AP]M, [^\]\n]{1,20} later\]\s*/g;

/** Remove time notes from her reply (she's told not to write them, but models copy patterns). */
export function stripTimeMarkers(text: string): string {
  return text.replace(COPIED_MARKER, "");
}

export function joinNonEmpty(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p !== "")
    .join("\n\n");
}
