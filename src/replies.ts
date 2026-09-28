/**
 * Waiting before replying: the "debounce".
 *
 * You text in bursts: "hey", "so guess what", "the new manager moved my
 * break AGAIN". If she answered each bubble the moment it arrived, she'd
 * reply to "hey" while you were still typing the rest. So she waits:
 *
 *   you send a bubble   → start a timer (a few seconds, from settings)
 *   you send another    → start the timer again from zero
 *   you're still typing → the app says so, and the timer starts again too
 *   the timer runs out  → she takes her turn, and sees everything you sent
 *
 * That's a *debounce*: many quick events turn into one action, once they
 * stop. (The word comes from electronics: a pressed button "bounces" and
 * sends several signals; debouncing turns them into one press.)
 *
 * If she's already writing when you send another bubble, that reply is
 * out of date, so it's stopped (nothing was saved yet) and she starts
 * waiting again, then answers everything together.
 *
 * Timers live here, on the server, not in the browser: if you send a
 * message and lock your phone, she still replies. Her reply reaches the
 * app through the events stream (src/events.ts).
 *
 * From stage 7, when the wait is over, Jev first checks your new messages
 * for her scratchpad (src/scratchpad.ts), then she replies, with any new
 * notes (and your "yes" to one of her questions) already in view. If you
 * send another bubble during the check, it stops, and starts again with
 * everything after the next wait.
 */

import type { Events } from "./events.ts";
import { BusyError, type Kitsikai } from "./kitsikai.ts";
import { ApiError, CancelledError } from "./nanogpt.ts";
import type { Scratchpad } from "./scratchpad.ts";
import type { Store } from "./store.ts";

export class Replies {
  /** A waiting timer per channel. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Turns this has started and that haven't finished, so tests can wait for them. */
  private readonly running = new Set<Promise<void>>();
  /** Channels where the scratchpad check (or reading your images) is running. */
  private readonly checkingIn = new Set<string>();
  /** Goes up in a channel each time its wait is cancelled or restarted, so a turn can tell it's out of date. */
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly kitsikai: Kitsikai,
    private readonly events: Events,
    private readonly scratchpad?: Scratchpad,
    /** Images you sent that are still being read (src/images.ts). */
    private readonly images?: { settled(channelId: string): Promise<void> },
  ) {}

  /** You sent a bubble in a channel: (re)start her wait there. */
  bubbleSent(channelId: string): void {
    // A reply she was writing is out of date now. (Nothing was saved yet.)
    if (this.kitsikai.isBusy(channelId)) this.kitsikai.cancel(channelId);
    this.scratchpad?.cancel(channelId);
    this.start(channelId);
  }

  /**
   * You're still typing in a channel: if she's waiting to reply there, she
   * waits a little longer. Does nothing if she isn't waiting.
   */
  typing(channelId: string): void {
    if (this.timers.has(channelId)) this.start(channelId);
  }

  /** Whether she's waiting to reply in a channel. */
  isWaiting(channelId: string): boolean {
    return this.timers.has(channelId);
  }

  /** Whether Jev is checking your new messages there, before she replies (stage 7). */
  isChecking(channelId: string): boolean {
    return this.checkingIn.has(channelId);
  }

  /** Stop waiting in a channel (the Stop button, or the channel was deleted). */
  cancel(channelId: string): void {
    clearTimeout(this.timers.get(channelId));
    this.timers.delete(channelId);
    this.scratchpad?.cancel(channelId);
    this.epochs.set(channelId, (this.epochs.get(channelId) ?? 0) + 1);
  }

  /**
   * Stop waiting everywhere and reply now, and wait until every reply this
   * started has finished. For tests, and for shutting down tidily.
   */
  async flush(): Promise<void> {
    for (const channelId of [...this.timers.keys()]) {
      this.cancel(channelId);
      this.reply(channelId);
    }
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private start(channelId: string): void {
    this.cancel(channelId);
    const seconds = this.store.getSettings().replyDebounceSeconds;
    this.timers.set(
      channelId,
      setTimeout(() => {
        this.timers.delete(channelId);
        this.reply(channelId);
      }, seconds * 1000),
    );
  }

  /** The wait is over: she takes her turn (see src/kitsikai.ts). */
  private reply(channelId: string): void {
    const turn = this.takeTurn(channelId).finally(() => this.running.delete(turn));
    this.running.add(turn);
  }

  private async takeTurn(channelId: string): Promise<void> {
    // Only reply to you: if your messages were deleted meanwhile, or the
    // channel is gone, there's nothing to answer.
    let last;
    try {
      last = this.store.lastMessage(channelId);
    } catch {
      return; // the channel was deleted
    }
    if (last?.author !== "user") return;

    // Images you sent are read first (src/images.ts): she never answers a
    // picture she hasn't seen. If you sent more meanwhile, or pressed Stop,
    // this turn is out of date.
    if (this.images) {
      const epoch = this.epochs.get(channelId) ?? 0;
      this.checkingIn.add(channelId);
      await this.images.settled(channelId).finally(() => this.checkingIn.delete(channelId));
      if ((this.epochs.get(channelId) ?? 0) !== epoch || this.timers.has(channelId)) return;
      if (this.store.lastMessage(channelId)?.author !== "user") return;
    }

    // Stage 7: Jev checks your new messages for her scratchpad first. It
    // never fails; if you sent more meanwhile (or pressed Stop), the next
    // wait takes over.
    if (this.scratchpad) {
      this.checkingIn.add(channelId);
      const { skipped } = await this.scratchpad.check(channelId).finally(() => this.checkingIn.delete(channelId));
      if (skipped === "stopped" || this.timers.has(channelId)) return;
      if (this.store.lastMessage(channelId)?.author !== "user") return;
    }

    // Something else is writing here (the "Her turn" button, say): try
    // again once it's done.
    if (this.kitsikai.isBusy(channelId)) {
      this.timers.set(
        channelId,
        setTimeout(() => {
          this.timers.delete(channelId);
          this.reply(channelId);
        }, 1000),
      );
      return;
    }

    try {
      await this.kitsikai.takeTurn(channelId, "user-message");
    } catch (error) {
      // Stopped on purpose (Stop, or you sent another bubble): not a problem.
      if (error instanceof CancelledError) return;
      if (error instanceof ApiError || error instanceof BusyError) {
        this.events.publish({ type: "turn-error", channelId, error: error.message });
        return;
      }
      console.error("[replies] unexpected error", error);
      this.events.publish({ type: "turn-error", channelId, error: "Something went wrong on the server." });
    }
  }
}
