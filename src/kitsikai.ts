/**
 * Kitsikai's turn: the single place where she writes something.
 *
 * The design's core rule (same as Aettica's) is that *a Kitsikai turn never
 * requires a user message*. There is one "takes a turn" function, and
 * anything can call it:
 *
 *   - you sending a message         (stage 1)
 *   - you pressing "Her turn"       (stage 1)
 *   - you asking for a regeneration (stage 1)
 *   - a timer or an event           (stage 8: she texts first)
 *
 * The turn itself only ever looks at what's already saved: it reads the
 * channel, builds the prompt stack, asks the model, and saves the reply. It
 * never receives your message as an argument. That's what keeps proactive
 * turns an add-on instead of a rewrite later.
 */

import { splitBubbles } from "./bubbles.ts";
import type { Events } from "./events.ts";
import { CancelledError, createChatCompletion, type ApiOptions, type ToolSpec } from "./nanogpt.ts";
import { parseExtraParams } from "./profiles.ts";
import { buildPromptStack, stripTimeMarkers } from "./prompt.ts";
import type { Store } from "./store.ts";
import { extractTextToolCalls, parseArguments } from "./toolcalls.ts";
import type { Channel, ChatMessage, Message, Profile } from "./types.ts";

/**
 * What caused a turn. Used for the server log.
 *
 * - `"user-message"`: you texted, and she waited a few seconds after your
 *   last bubble (see src/replies.ts).
 * - `"continue"`: the "Her turn" button, or "Try again".
 * - `"regenerate"`: replacing her last reply.
 */
export type TurnTrigger = "user-message" | "continue" | "regenerate";

/** Extra options for a turn. */
export interface TurnOptions {
  /**
   * Ids of her existing messages this turn replaces (a regeneration: every
   * bubble of her last reply). They're left out of the prompt, as if never
   * written, and deleted only once the new reply has been saved. If
   * generation fails, or writes nothing, they stay.
   */
  replacing?: string[];
  /** Write with this connection profile instead of the channel's assignment ("Regenerate with..."). */
  profileId?: string;
}

/** Everything one turn produced. */
export interface TurnResult {
  /** The new messages: one per bubble. */
  messages: Message[];
  /** The messages that were replaced (a regeneration that wrote something). */
  replaced: string[];
}

/** Thrown when a turn is requested in a channel where one is still being written. */
export class BusyError extends Error {
  constructor() {
    super("Kitsikai is already writing in this channel. Wait for that reply first.");
    this.name = "BusyError";
  }
}

/**
 * The connection profile for one turn in a channel: the channel's own
 * assignment if it has one, otherwise the app-wide chat assignment. A
 * roulette picks at random each time (pass `random` to choose).
 */
export function pickProfile(store: Store, channel: Channel, random?: number): Profile {
  const assignment = channel.assignment ?? store.getSettings().chatAssignment;
  return store.profiles.pick(assignment, true, random);
}

/** Options for building a channel's prompt. */
export interface PromptOptions {
  /** Messages to leave out (the ones being regenerated). */
  excludeIds?: string[];
  /** The profile writing: its model notes. */
  profile?: Profile;
  /** The time "now" (tests pass their own). */
  now?: Date;
}

/**
 * Build the prompt stack for a channel from what's saved.
 *
 * Used by the turn itself and by the "Preview prompt" button, so the preview
 * is always exactly what a turn would send.
 */
export function promptForChannel(store: Store, channelId: string, options: PromptOptions = {}): ChatMessage[] {
  const excluded = new Set(options.excludeIds ?? []);
  const channel = store.getChannel(channelId);
  const settings = store.getSettings();
  // A few extra, in case some are excluded.
  const messages = store
    .recentMessages(channelId, settings.historyLimit + excluded.size)
    .filter((m) => !excluded.has(m.id))
    .slice(-settings.historyLimit);
  return buildPromptStack({
    settings,
    channel,
    channels: store.listChannels(),
    messages,
    now: options.now ?? new Date(),
    modelNotes: options.profile?.quirkPrompt,
  });
}

/** The request settings a profile locks in (everything but the messages). */
export function profileRequest(profile: Profile) {
  return {
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    topP: profile.topP,
    reasoningEffort: profile.reasoningEffort,
    extraParams: parseExtraParams(profile.extraParams),
  };
}

export class Kitsikai {
  /**
   * The channels she's writing in right now, each with the controller that
   * can stop that turn (see `cancel`).
   *
   * Only one turn may run per channel at a time. Without this, tapping Send
   * twice would start two generations that both read the same channel and
   * both save a reply. Different channels don't block each other.
   */
  private readonly writingIn = new Map<string, AbortController>();

  /**
   * @param clock   What time it is. Tests pass a fake clock.
   * @param events  Where to announce new messages and busy channels, so the
   *                app hears about replies it didn't ask for (see src/events.ts).
   */
  constructor(
    private readonly store: Store,
    private readonly api: ApiOptions,
    private readonly clock: () => Date = () => new Date(),
    private readonly events?: Events,
  ) {}

  /** Tell the app which channels she's writing in. */
  private announceBusy(): void {
    this.events?.publish({ type: "busy", channelIds: this.busyChannels() });
  }

  /** Whether a turn is in progress in a channel. */
  isBusy(channelId: string): boolean {
    return this.writingIn.has(channelId);
  }

  /** Every channel with a turn in progress. */
  busyChannels(): string[] {
    return [...this.writingIn.keys()];
  }

  /**
   * Stop the turn running in a channel, if there is one (the Stop button).
   *
   * The request to the model is abandoned and nothing is saved, so the
   * channel is left as it was. The channel is free again as soon as this
   * returns.
   *
   * @returns `true` if a turn was stopped, `false` if none was running.
   */
  cancel(channelId: string): boolean {
    const controller = this.writingIn.get(channelId);
    if (!controller) return false;
    controller.abort();
    // Free the channel right away rather than waiting for the aborted
    // request to wind down.
    this.writingIn.delete(channelId);
    this.announceBusy();
    console.log(`[kitsikai] turn stopped in channel ${channelId}`);
    return true;
  }

  /**
   * Kitsikai takes one turn in a channel: reads it, writes a reply, saves it.
   *
   * @throws NotFoundError  if the channel doesn't exist.
   * @throws BusyError      if a turn is already running in that channel.
   * @throws CancelledError if the turn was stopped with `cancel`.
   * @throws ApiError       if the model couldn't produce a reply.
   *                        In those cases no message is saved.
   */
  async takeTurn(channelId: string, trigger: TurnTrigger, options: TurnOptions = {}): Promise<TurnResult> {
    if (this.writingIn.has(channelId)) throw new BusyError();
    const channel = this.store.getChannel(channelId); // throws if missing

    const controller = new AbortController();
    this.writingIn.set(channelId, controller);
    this.announceBusy();
    try {
      const profile = options.profileId ? this.store.profiles.get(options.profileId) : pickProfile(this.store, channel);
      const conversation = promptForChannel(this.store, channelId, {
        excludeIds: options.replacing,
        profile,
        now: this.clock(),
      });

      const started = Date.now();
      console.log(`[kitsikai] turn started in #${channel.name} (${trigger}) using "${profile.name}" (${profile.model})`);
      const response = await createChatCompletion(this.api, {
        ...profileRequest(profile),
        messages: conversation,
        signal: controller.signal,
      });
      // Belt and braces: if the turn was stopped just as the reply arrived,
      // don't save it.
      if (controller.signal.aborted) throw new CancelledError();
      console.log(`[kitsikai] turn finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      // One message per bubble (see src/bubbles.ts).
      const bubbles = splitBubbles(stripTimeMarkers(response.content));
      const result: TurnResult = { messages: [], replaced: [] };
      if (bubbles.length === 0) return result;

      // Swap old for new in one transaction: never both, never neither.
      result.messages = this.store.db.transaction(() => {
        for (const id of options.replacing ?? []) this.store.deleteMessage(id);
        return this.store.addTurn(
          bubbles.map((content) => ({ channelId, author: "kitsikai", content, model: response.model, profile: profile.name })),
        );
      })();
      result.replaced = options.replacing ?? [];
      this.events?.publish({ type: "messages", channelId, messages: result.messages, replacedIds: result.replaced });
      return result;
    } finally {
      // Always release the lock, even if generation failed. Otherwise one
      // network error would leave the channel "busy" forever. (Only if it's
      // still *this* turn's lock: after a Stop, a new turn may already have
      // started in the channel.)
      if (this.writingIn.get(channelId) === controller) {
        this.writingIn.delete(channelId);
        this.announceBusy();
      }
    }
  }
}

// ------------------------------------------------------------ tool test

/** The outcome of testing whether a profile's model can call tools. */
export interface ToolTestResult {
  /**
   * `native`: it called the tool through the API, the best case.
   * `text`: it wrote the call out in its reply, which works, but less reliably.
   * `none`: it didn't call the tool at all.
   * `broken`: it called it, but the arguments couldn't be read.
   */
  verdict: "native" | "text" | "none" | "broken";
  /** A sentence explaining the verdict. */
  detail: string;
  /** What the model wrote, if anything. */
  content: string;
  /** The call's arguments, as written. */
  arguments: string | null;
  seconds: number;
}

/**
 * Check whether a profile's model can call tools, with one tiny request:
 * the model is asked to call a `check_in` tool with a given word.
 * Throws `ApiError` if the request itself fails. (Copied from Aettica.)
 */
export async function testToolCalling(api: ApiOptions, profile: Profile): Promise<ToolTestResult> {
  const spec: ToolSpec = {
    type: "function",
    function: {
      name: "check_in",
      description: "Check in, with a word.",
      parameters: {
        type: "object",
        properties: { word: { type: "string", description: "The word to check in with." } },
        required: ["word"],
      },
    },
  };
  const started = Date.now();
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: 'This is a test of tool calling. Call the check_in tool with the word "lighthouse". Write nothing else.' },
      { role: "user", content: "Call check_in now, please." },
    ],
    tools: [spec],
    allowEmpty: true,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  const native = response.toolCalls.find((c) => c.name === "check_in");
  const written = native ? undefined : extractTextToolCalls(response.content).calls.find((c) => c.name === "check_in");
  const call = native ?? written;
  if (!call) {
    return {
      verdict: "none",
      detail: 'The model didn\'t call the tool. Turn off "Can use tools" for this profile, or try another model.',
      content: response.content,
      arguments: null,
      seconds,
    };
  }
  const args = parseArguments(call.arguments);
  if (!args.ok || typeof args.value.word !== "string") {
    return {
      verdict: "broken",
      detail: `The model called the tool, but its arguments couldn't be read${args.ok ? "" : `: ${args.error}`}`,
      content: response.content,
      arguments: call.arguments,
      seconds,
    };
  }
  return native
    ? {
        verdict: "native",
        detail: "The model called the tool properly, through the API. Tools should work well.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      }
    : {
        verdict: "text",
        detail: "The model wrote the tool call into its reply instead of using the API. Kitsikai can read it, but it may be less reliable.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      };
}
