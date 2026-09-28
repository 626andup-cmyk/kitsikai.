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
 *   5. Today and tomorrow      your plans for both days, and whether you're at work (stage 6)
 *   6. Reminders due           reminders that have gone off and aren't sent yet (stage 8)
 *   7. Planner changes         ones she offered, waiting for your yes or just settled
 *   8. Your notes and pins     her scratchpad, pins, what she'll ask you about (stage 7)
 *   9. Between you right now   the intimacy register, if there is one (src/intimacy.ts)
 *  10. Tools                   how to use her lookups, if the profile can (stage 6)
 *  11. Model notes             the connection profile's notes on this model
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

Notes in square brackets like [9:12 PM, 3 hours later] are added by the app to show when time has passed. Never write them yourself.

When they send you an image, you get a description of it in square brackets, like [Sent an image: ...]. React to what's in it the way you would if you'd seen it; don't mention the description.`;

/** Before today's and tomorrow's plans: where they come from. */
export const PLANNER_NOTE = `From the planner you share with them (their shifts and plans; "not confirmed yet" means they haven't checked it):`;

/** How to use her tools (stage 6: lookups; stage 7: her notes). */
export const TOOL_GUIDANCE = `You can look things up: their plans further out (look_up_plans, find_plans), the things they asked you to keep an eye on and what's been logged (list_trackers, look_up_log), what you said in other channels (read_channel), anything older you two said (search_history), and things you've unpinned (look_in_drawer). You can jot a note on your scratchpad (jot_note) when something's worth remembering, or when they ask you to pin something or let a pin go. You can change their planner too: add_plan, change_plan, remove_plan (get a plan_id from look_up_plans or find_plans first). If they asked you to, it's done; if it's your idea, it waits for their yes, so ask them. And you can keep their trackers the way they can: make one when they ask you to keep track of something (make_tracker), put a sticker on a day when they tell you how it went (log_sticker), and take one off if it's wrong (remove_sticker).

Use tools only when they help: most texts need none. If a plan or something logged comes up and it isn't in front of you, look it up instead of guessing. Never mention tools or looking things up: just know it, like a friend who remembers. If there's nothing you'd text, you can call do_nothing.`;

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
  /** She used her tools, then wrote nothing (src/kitsikai.ts): asked once more. */
  afterTools: "(App note, not from them: you've got what you needed from your tools. Now write your reply to them.)",
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
  /** Today's and tomorrow's plans, in words (see `todayAndTomorrow` in src/binder.ts). */
  todayAndTomorrow?: string;
  /** Due reminders, in words (see `remindersForPrompt` in src/reminders.ts). */
  reminders?: string | null;
  /** Her notes and pins, in words (see `memoryForPrompt` in src/memory.ts). */
  memory?: string;
  /** Planner changes she offered, waiting or just settled (see src/planchanges.ts). */
  planChanges?: string | null;
  /** Why she's texting first (stage 8): ends the stack instead of the usual note. */
  note?: string;
  /** Whether she can use tools this turn (adds guidance on them). */
  tools?: boolean;
  /** The intimacy register's prompt text, or "" for none (see src/intimacy.ts). */
  registerPrompt?: string;
}

/**
 * Build the prompt stack for one of her turns.
 *
 * @returns The messages to send to the chat completions API.
 */
export function buildPromptStack(input: PromptInput): ChatMessage[] {
  const { settings, channel, channels, messages, now, modelNotes, tools } = input;
  const layers: Layer[] = [
    { title: "Who you are", content: joinNonEmpty([FRAMING, settings.persona, whoTheyAre(settings)]) },
    { title: "How you text", content: TEXTING_STYLE },
    { title: "Where you're texting", content: describeChannels(channel, channels ?? [channel]) },
    { title: "Right now", content: describeNow(now) },
    { title: "Today and tomorrow", content: input.todayAndTomorrow ? `${PLANNER_NOTE}\n\n${input.todayAndTomorrow}` : null },
    { title: "Reminders due", content: input.reminders },
    { title: "Planner changes you offered", content: input.planChanges ?? null },
    { title: "Your notes and pins", content: input.memory },
    { title: "Between you right now", content: input.registerPrompt?.trim() || null },
    { title: "Tools", content: tools ? TOOL_GUIDANCE : null },
    { title: "Model notes", content: modelNotes },
  ];

  const system: ChatMessage = { role: "system", content: renderLayers(layers) };
  const history = toChatHistory(messages);

  // If the conversation doesn't end on your message, add a note so the model
  // knows it's being asked to continue. This is what lets her take a turn
  // without you writing anything: the design's core rule.
  const last = history.at(-1);
  if (input.note) {
    // She's texting first (stage 8): say why. Added to your last message if
    // the chat ends on one, since some models reject two in a row.
    if (last?.role === "user") last.content = `${last.content}\n\n${input.note}`;
    else history.push({ role: "user", content: input.note });
  } else if (!last || last.role !== "user") {
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
    let content = modelText(message).trim();
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

/**
 * A message as every model sees it (her chat model, Jev, the writer, her
 * tools): its text, or for an image you sent, what the vision model saw in
 * it, in brackets (src/images.ts). So a text-only model can follow a chat
 * with pictures in it.
 */
export function modelText(message: Message): string {
  if (!message.image) return message.content;
  const seen = message.content.replace(/\s+/g, " ").trim();
  if (seen) return `[Sent an image: ${seen}]`;
  return message.image.status === "reading" ? "[Sent an image. It's still being looked at.]" : "[Sent an image that couldn't be described.]";
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
