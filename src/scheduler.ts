/**
 * The scheduler (stage 7): what runs on a timer, not because you texted.
 *
 * Once a minute, the server checks whether anything is due:
 *
 *   - **A processing round**, every few hours (Settings: "Process notes
 *     every"), counted from the last regular or manual round.
 *   - **An early round**, when a time-sensitive note ("dentist in an
 *     hour") has sat for a few minutes, so it doesn't wait for the next
 *     regular one. At most one every 10 minutes, so a Jev outage can't turn
 *     it into a request every minute.
 *
 * (Stage 8 adds her snapshot check here: whether to text you first.)
 *
 * The timer itself is only started by the real server (`start`). Tests call
 * `tick()` with a fake clock instead, so a whole day can pass in a moment.
 */

import type { Processing, RunResult } from "./processing.ts";
import type { Store } from "./store.ts";
import type { ProcessingTrigger } from "./types.ts";

/** How often the scheduler looks, in milliseconds. */
export const TICK_MS = 60_000;
/** How long a time-sensitive note waits (minutes) for an early round: a moment for corrections. */
export const EARLY_AFTER_MINUTES = 5;
/** The least time between early rounds (minutes). */
export const EARLY_GAP_MINUTES = 10;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly processing: Processing,
    private readonly clock: () => Date,
  ) {}

  /** Start looking once a minute. */
  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error("[scheduler] tick failed", error));
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** When the next regular round is due (or `now`, if it already is). */
  nextRunAt(): Date {
    const last = this.store.memory.runs(1, ["timer", "manual"])[0];
    if (!last) return this.clock();
    const hours = this.store.getSettings().processingHours;
    return new Date(new Date(last.startedAt).getTime() + hours * 3600_000);
  }

  /** What's due right now, if anything. */
  due(): ProcessingTrigger | null {
    if (this.processing.isRunning()) return null;
    const now = this.clock();
    if (this.nextRunAt() <= now) return "timer";
    const minutes = (iso: string) => (now.getTime() - new Date(iso).getTime()) / 60_000;
    const lastEarly = this.store.memory.runs(1, ["early"])[0];
    if (lastEarly && minutes(lastEarly.startedAt) < EARLY_GAP_MINUTES) return null;
    const waiting = this.store.memory.notes(["open"]).some((n) => n.timeSensitive && minutes(n.createdAt) >= EARLY_AFTER_MINUTES);
    return waiting ? "early" : null;
  }

  /** Run whatever is due. Returns the round, if one ran. */
  async tick(): Promise<RunResult | null> {
    const trigger = this.due();
    return trigger ? this.processing.run(trigger) : null;
  }
}
