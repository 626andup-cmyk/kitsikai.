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
 *   - **Her snapshot check** (stage 8), every few minutes (Settings, default
 *     10): whether to text you first (src/proactive.ts).
 *
 * The timer itself is only started by the real server (`start`). Tests call
 * `tick()` with a fake clock instead, so a whole day can pass in a moment.
 */

import type { Processing, RunResult } from "./processing.ts";
import type { CheckResult, Proactive } from "./proactive.ts";
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
    private readonly proactive?: Proactive,
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

  /** Whether her snapshot check is due (stage 8). */
  snapshotDue(): boolean {
    if (!this.proactive || this.proactive.isRunning()) return false;
    const last = this.proactive.lastCheckAt;
    if (!last) return true;
    return this.clock().getTime() - last.getTime() >= this.store.getSettings().snapshotMinutes * 60_000;
  }

  /** When the next snapshot check is due. */
  nextCheckAt(): Date {
    const last = this.proactive?.lastCheckAt;
    return last ? new Date(last.getTime() + this.store.getSettings().snapshotMinutes * 60_000) : this.clock();
  }

  /** Run whatever is due: a processing round, then the snapshot check. */
  async tick(): Promise<{ processed: RunResult | null; checked: CheckResult | null }> {
    const trigger = this.due();
    const processed = trigger ? await this.processing.run(trigger) : null;
    const checked = this.snapshotDue() ? await this.proactive!.check("timer") : null;
    return { processed, checked };
  }
}
