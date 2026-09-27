/**
 * Texting first (stage 8): the snapshot check.
 *
 * Every few minutes (Settings, default 10), the scheduler asks: should she
 * text you now? Most of the time the answer is no. The check takes a
 * **snapshot** of what's going on (the time, today's and tomorrow's plans,
 * due reminders, whether you're at work, when you last talked and who sent
 * the last message, how many times she's texted first without a reply, her
 * pins and notes) and asks Jev, each with a probability:
 *
 *   - Did you already talk about a due reminder? (then it's skipped)
 *   - Your work just ended: would "how'd it go?" feel natural now?
 *   - Is something from her notes, pins or trackers worth following up on?
 *   - It's been quiet a while: would a "just because" text feel natural?
 *   - She's already waiting on a reply: would another text feel natural, or
 *     pushy?
 *
 * Any confident yes → her turn runs, with a note saying why she's texting
 * (never saved or shown). All no → nothing happens.
 *
 * ## Rules that aren't up to Jev
 *
 * - **The double-text cap** (Settings): "Let her judge" asks Jev every time;
 *   a cap of 1, 2 or 3 is a **hard wall**: once she's texted first that many
 *   times without a reply, Jev isn't even asked. **Reminders ignore it.**
 * - Nothing but reminders within 20 minutes of the last message anywhere
 *   (that's a conversation, not texting first), and no "just because" until
 *   it's been quiet for 2 hours. Nothing but reminders before you've ever
 *   texted her.
 * - No check while she's writing or waiting to reply somewhere.
 * - After the safeword, only reminders, until you bring her back
 *   (src/intimacy.ts).
 *
 * ## Picking the channel
 *
 * Jev picks the channel that fits the reason best, from the channels' names
 * and topics; unsure → the home channel. Then the **interruption check**:
 * for a channel with messages in the last 30 minutes, would a text now
 * interrupt a conversation in progress? Yes (or unsure) → the next-best
 * channel. If every candidate is mid-conversation, a reminder is queued into
 * the conversation you're already having (she mentions it there, "oh btw,
 * dentist in 2 hours"); anything else waits for the next check.
 *
 * After any of her turns, if reminders are due, Jev checks whether she
 * mentioned them (`noticeTurn`), so a reminder she worked into a
 * conversation isn't sent again.
 */

import { todayAndTomorrow } from "./binder.ts";
import { addDays, dateOf } from "./dates.ts";
import { confidentChoice, percent, probabilityOf, tier, type Answers, type Question } from "./jev.ts";
import { BusyError, type Kitsikai } from "./kitsikai.ts";
import { describePin } from "./memory.ts";
import { ApiError, CancelledError } from "./nanogpt.ts";
import { formatClock } from "./prompt.ts";
import { dueReminders } from "./reminders.ts";
import type { Replies } from "./replies.ts";
import { chatLine, describeTrackerNote, longNow, type MemoryDeps } from "./scratchpad.ts";
import type { Channel, DueReminder, Message, ProactiveOutcome, ProactiveReason } from "./types.ts";

/** Nothing but reminders this soon (minutes) after the last message anywhere. */
export const MIN_QUIET_MINUTES = 20;
/** No "just because" until it's been quiet this long (hours). */
export const JUST_BECAUSE_HOURS = 2;
/** A work block that ended this recently (minutes) has "just ended". */
export const CHECKIN_WINDOW_MINUTES = 90;
/** How far back the interruption check looks (minutes). */
export const INTERRUPT_MINUTES = 30;
/** Recent chat in the snapshot: this many hours, at most this many lines per channel. */
const CHAT_HOURS = 3;
const CHAT_LINES = 12;

/** What one check did. */
export interface CheckResult {
  outcome: ProactiveOutcome;
  reason: ProactiveReason | null;
  channelId: string | null;
  /** What happened and why, in words. */
  detail: string;
  /** What she texted, if she did. */
  messages: Message[];
}

/** What the check needs besides the memory's helpers. */
export interface ProactiveDeps extends MemoryDeps {
  kitsikai: Kitsikai;
  replies: Replies;
}

/** Everything the snapshot is made of. */
interface Snapshot {
  now: Date;
  channels: Channel[];
  due: DueReminder[];
  /** The newest message anywhere, and yours. */
  last: Message | null;
  yourLast: Message | null;
  herLast: Message | null;
  /** Minutes since the last message anywhere (Infinity if there's none). */
  quietMinutes: number;
  /** How many times she's texted first since your last message. */
  inARow: number;
  /** A work block that just ended and hasn't had its check-in. */
  workEnd: { key: string; end: Date } | null;
  /** What she could follow up on. */
  followUps: string[];
}

export class Proactive {
  private running = false;
  /** The channel where her own proactive turn is running, which `noticeTurn` leaves alone. */
  private ownTurn: string | null = null;
  /** `noticeTurn` checks in progress, so tests can wait for them. */
  private readonly pending = new Set<Promise<void>>();
  /** When the last check ran. */
  lastCheckAt: Date | null = null;

  constructor(private readonly deps: ProactiveDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Wait for any `noticeTurn` checks in progress (for tests). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /**
   * The snapshot check: decide whether to text first, and do it. Never
   * throws. Checks where nothing was worth asking about aren't logged
   * (there'd be one every 10 minutes); a manual check always is.
   */
  async check(trigger: "timer" | "manual"): Promise<CheckResult> {
    if (this.running) return result("nothing", "a check is already running");
    this.running = true;
    try {
      const { outcome: checked, logIt } = await this.decide(trigger);
      if (logIt || trigger === "manual") {
        this.deps.store.proactiveLog.add(
          {
            trigger,
            outcome: checked.outcome,
            reason: checked.reason,
            channelId: checked.channelId,
            messageId: checked.messages[0]?.id ?? null,
            detail: checked.detail,
            key: checked.key ?? null,
          },
          this.deps.clock(),
        );
        this.deps.events?.publish({ type: "memory" });
      }
      return checked;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[proactive] check failed: ${detail}`);
      this.deps.store.proactiveLog.add(
        { trigger, outcome: "error", reason: null, channelId: null, messageId: null, detail, key: null },
        this.deps.clock(),
      );
      return result("error", detail);
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------ deciding

  private async decide(trigger: "timer" | "manual"): Promise<{ outcome: CheckResult & { key?: string }; logIt: boolean }> {
    const { store, decider, kitsikai, replies, clock } = this.deps;
    const settings = store.getSettings();
    const threshold = settings.decisionConfidence;
    const now = clock();
    this.lastCheckAt = now;
    if (!settings.textFirst) return { outcome: result("nothing", "Texting first is off in Settings."), logIt: false };

    const channels = store.listChannels().filter((c) => c.kind === "text");
    if (channels.some((c) => kitsikai.isBusy(c.id) || replies.isWaiting(c.id) || replies.isChecking(c.id))) {
      return { outcome: result("nothing", "She's in the middle of replying."), logIt: false };
    }

    const snap = this.snapshot(now, channels);
    const cap = settings.doubleTextCap;
    const wall = cap !== "judge" && snap.inARow >= cap;
    // Before you've ever texted her, only reminders: she doesn't start the
    // friendship. And after the safeword, only reminders, until you bring her
    // back (src/intimacy.ts); her turn is in the "safe" register, so they go
    // out plain.
    const held = store.intimacy.get() !== null;
    const others = !wall && !held && snap.yourLast !== null && snap.quietMinutes >= MIN_QUIET_MINUTES;
    const askQuiet = others && snap.quietMinutes >= JUST_BECAUSE_HOURS * 60;
    const askAgain = others && cap === "judge" && snap.inARow >= 1;

    // --- the questions: only what's worth asking about
    const questions: Question[] = snap.due.map((r, i) => ({
      id: `r${i + 1}`,
      kind: "yesno" as const,
      question: `Did they already talk about ${r.text} in the last few hours, so that reminding them now would be redundant?`,
    }));
    if (others && snap.workEnd) {
      questions.push({
        id: "checkin",
        kind: "yesno",
        question: `Their work just ended, at ${formatClock(snap.workEnd.end)}. Would ${settings.name} texting now to ask how it went feel natural?`,
      });
    }
    if (others && snap.followUps.length) {
      questions.push({
        id: "followup",
        kind: "yesno",
        question: `Is one of the things ${settings.name} might follow up on (listed above) worth texting them about right now, in a natural way?`,
      });
    }
    if (askQuiet) {
      questions.push({
        id: "quiet",
        kind: "yesno",
        question: `It's been quiet for ${hoursWords(snap.quietMinutes)}. Would a "just because" text from ${settings.name} feel natural now, not needy?`,
      });
    }
    if (askAgain) {
      questions.push({
        id: "again",
        kind: "choice",
        question: `${settings.name} has already texted first ${times(snap.inARow)} without a reply. Would another text now feel natural, or pushy?`,
        options: ["natural", "pushy"],
      });
    }
    if (questions.length === 0) {
      const why = held
        ? "Holding after the safeword: only reminders, until they bring her back."
        : wall
          ? `The double-text cap (${cap}) is reached: waiting for their reply.`
          : "Nothing to text about.";
      return { outcome: result("nothing", why), logIt: false };
    }
    if (!decider.enabled() && snap.due.length === 0) {
      return { outcome: result("nothing", "Jev is turned off (and there's no fallback), so only reminders can go out."), logIt: false };
    }

    // Without Jev, reminders still go out; anything else needs a decision.
    const answers: Answers = decider.enabled() ? await decider.ask(this.state(snap, settings.name), questions, { purpose: "Texting first: snapshot check" }) : new Map();
    const sure = (id: string, option = "yes") => `${percent(probabilityOf(answers.get(id), option))} sure`;

    // --- reminders: skip the ones you just talked about
    const reminders: DueReminder[] = [];
    snap.due.forEach((r, i) => {
      const id = `r${i + 1}`;
      if (tier(answers.get(id), threshold) === "yes") {
        store.reminders.record(r, "skipped", { reason: `they already talked about it (${sure(id)})` }, now);
      } else {
        reminders.push(r);
      }
    });
    const skipped = snap.due.length - reminders.length;

    // --- why she'd text
    let reason: ProactiveReason | null = null;
    let why = "";
    if (reminders.length) {
      reason = "reminder";
      why = `reminders due: ${reminders.map((r) => r.text).join("; ")}`;
    } else if (!askAgain || confidentChoice(answers.get("again"), threshold) === "natural") {
      if (tier(answers.get("checkin"), threshold) === "yes") {
        reason = "checkin";
        why = `their work just ended at ${formatClock(snap.workEnd!.end)} (${sure("checkin")})`;
      } else if (tier(answers.get("followup"), threshold) === "yes") {
        reason = "followup";
        why = `something worth following up on (${sure("followup")})`;
      } else if (tier(answers.get("quiet"), threshold) === "yes") {
        reason = "just-because";
        why = `quiet for ${hoursWords(snap.quietMinutes)} (${sure("quiet")})`;
      }
    }
    if (!reason) {
      const parts = [skipped ? `skipped ${times(skipped, "reminder")} they'd already talked about` : "", askAgain ? `another text would be pushy or unsure` : "", "nothing else worth texting about"];
      // Not kept for timer checks: "nothing" is most checks, every few minutes.
      return { outcome: result("nothing", capitalize(parts.filter(Boolean).join("; ")) + "."), logIt: false };
    }

    // --- where
    const pick = await this.pickChannel(snap, reason, why, settings.name, threshold);
    if (!pick.channel) {
      if (reason === "reminder" && snap.last) {
        // Into the conversation you're already having.
        const channelId = snap.last.channelId;
        for (const r of reminders) store.reminders.record(r, "queued", { channelId, reason: "every channel was mid-conversation" }, now);
        const name = channels.find((c) => c.id === channelId)?.name;
        return { outcome: { ...result("queued", `${capitalize(why)}. ${pick.why} She'll mention it in #${name}.`), reason, channelId }, logIt: true };
      }
      return { outcome: { ...result("waiting", `${capitalize(why)}. ${pick.why} Waiting for the next check.`), reason }, logIt: true };
    }

    // --- her turn
    const channel = pick.channel;
    const note = appNote(reason, { reminders, workEnd: snap.workEnd, quietMinutes: snap.quietMinutes, inARow: snap.inARow });
    this.ownTurn = channel.id;
    let messages: Message[];
    try {
      messages = (await kitsikai.takeTurn(channel.id, "proactive", { note })).messages;
    } catch (error) {
      if (error instanceof BusyError || error instanceof CancelledError) {
        return { outcome: { ...result("waiting", `${capitalize(why)}, but #${channel.name} got busy. Waiting for the next check.`), reason }, logIt: true };
      }
      if (error instanceof ApiError) throw new Error(`Her turn in #${channel.name} failed: ${error.message}`);
      throw error;
    } finally {
      this.ownTurn = null;
    }

    const key = reason === "checkin" ? snap.workEnd!.key : undefined;
    if (messages.length === 0) {
      for (const r of reminders) store.reminders.record(r, "skipped", { channelId: channel.id, reason: "she chose not to text it" }, clock());
      return { outcome: { ...result("declined", `${capitalize(why)}. In #${channel.name} (${pick.why}), she chose not to text.`), reason, channelId: channel.id, key }, logIt: true };
    }
    for (const r of reminders) store.reminders.record(r, "sent", { channelId: channel.id, messageId: messages[0]!.id, reason: "she texted it" }, clock());
    console.log(`[proactive] texted first in #${channel.name}: ${why}`);
    return { outcome: { outcome: "sent", reason, channelId: channel.id, detail: `${capitalize(why)}. ${pick.why}`, messages, key }, logIt: true };
  }

  /** Put the snapshot together. */
  private snapshot(now: Date, channels: Channel[]): Snapshot {
    const { store } = this.deps;
    const newest = (author?: Message["author"]) =>
      channels
        .map((c) => (author ? store.recentMessages(c.id, 200).filter((m) => m.author === author).at(-1) : store.lastMessage(c.id)))
        .filter((m): m is Message => Boolean(m))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    const last = newest();
    const yourLast = newest("user");
    const herLast = newest("kitsikai");

    // A work block that just ended, without its check-in yet.
    const calledIn = store.reminders.calledIn();
    const today = dateOf(now);
    const ended = store.plans
      .workBlocks(addDays(today, -1), today, { calledIn })
      .filter((b) => b.end <= now && now.getTime() - b.end.getTime() <= CHECKIN_WINDOW_MINUTES * 60_000)
      .map((b) => ({ key: `checkin:${b.end.toISOString()}`, end: b.end }))
      .find((b) => !store.proactiveLog.has(b.key));

    // Her pins, the things she might bring up, and recent stickers from trackers she may bring up.
    const trackers = new Map(store.trackers.list().filter((t) => t.canBringUp).map((t) => [t.id, t]));
    const followUps = [
      ...store.memory.pins().map((p) => `pin: ${describePin(p)}`),
      ...store.memory.notes(["bringup"]).map((n) => `to bring up: ${n.text}`),
      ...store.trackers
        .entries({ from: addDays(today, -2), to: today, limit: 10 })
        .filter((e) => trackers.has(e.trackerId))
        .map((e) => `logged: ${describeTrackerNote(trackers.get(e.trackerId)!, e.value, e.date)}`),
    ];

    return {
      now,
      channels,
      due: dueReminders(store, now),
      last,
      yourLast,
      herLast,
      quietMinutes: last ? (now.getTime() - new Date(last.createdAt).getTime()) / 60_000 : Infinity,
      inARow: store.proactiveLog.sentSince(yourLast?.createdAt ?? "").length,
      workEnd: ended ?? null,
      followUps,
    };
  }

  /** The snapshot in words, for Jev. */
  private state(snap: Snapshot, name: string): string {
    const { store } = this.deps;
    const channelName = (id: string) => snap.channels.find((c) => c.id === id)?.name ?? "?";
    const since = (m: Message) => hoursWords((snap.now.getTime() - new Date(m.createdAt).getTime()) / 60_000);
    const lines = [
      `It's ${longNow(snap.now)}.`,
      `Their day, from the planner:\n${todayAndTomorrow(store, snap.now, store.reminders.calledIn())}`,
    ];
    if (snap.due.length) lines.push(`Reminders due now:\n${snap.due.map((r, i) => `- r${i + 1}: ${r.text} (${r.reminder.label.toLowerCase()} reminder)`).join("\n")}`);
    lines.push(
      snap.last
        ? `The last message was ${since(snap.last)} ago, from ${snap.last.author === "user" ? "them" : name}, in #${channelName(snap.last.channelId)}.` +
            (snap.inARow ? ` ${name} has texted first ${times(snap.inARow)} since their last message.` : "")
        : "They haven't talked yet.",
    );
    if (snap.followUps.length) lines.push(`Things ${name} might follow up on:\n${snap.followUps.map((f) => `- ${f}`).join("\n")}`);
    const cutoff = snap.now.getTime() - CHAT_HOURS * 3600_000;
    for (const channel of snap.channels) {
      const recent = store
        .recentMessages(channel.id, CHAT_LINES)
        .filter((m) => new Date(m.createdAt).getTime() >= cutoff);
      if (recent.length) lines.push(`Recent chat in #${channel.name} (oldest first):\n${recent.map((m) => chatLine(m, name)).join("\n")}`);
    }
    return lines.join("\n\n");
  }

  /**
   * Pick where to text: Jev's best fit (or the home channel, if it isn't
   * sure), then the next best, skipping any channel where a text would
   * interrupt a conversation in progress.
   */
  private async pickChannel(snap: Snapshot, reason: ProactiveReason, why: string, name: string, threshold: number): Promise<{ channel: Channel | null; why: string }> {
    const { store, decider } = this.deps;
    const home = store.homeChannel();
    const cutoff = snap.now.getTime() - INTERRUPT_MINUTES * 60_000;
    const recent = new Map(
      snap.channels.map((c) => [c.id, store.recentMessages(c.id, 10).filter((m) => new Date(m.createdAt).getTime() >= cutoff)]),
    );
    const names = snap.channels.map((c) => c.name);
    const busyIds = snap.channels.filter((c) => recent.get(c.id)!.length).map((c) => c.id);

    const questions: Question[] = [];
    if (snap.channels.length > 1) {
      questions.push({ id: "channel", kind: "choice", question: `Which channel fits best for this text from ${name}: ${REASON_WORDS[reason]}?`, options: names });
    }
    snap.channels.forEach((c, i) => {
      if (recent.get(c.id)!.length) {
        questions.push({ id: `i${i + 1}`, kind: "yesno", question: `Would a new text from ${name} in #${c.name} right now interrupt a conversation in progress there?` });
      }
    });
    const state = [
      `It's ${longNow(snap.now)}. ${name} wants to text them first: ${why}.`,
      `The channels (name and topic):\n${snap.channels.map((c) => `- #${c.name}${c.topic ? `: ${c.topic}` : ""}${c.id === home.id ? " (the home channel)" : ""}`).join("\n")}`,
      ...snap.channels
        .filter((c) => recent.get(c.id)!.length)
        .map((c) => `The last ${INTERRUPT_MINUTES} minutes in #${c.name}:\n${recent.get(c.id)!.map((m) => chatLine(m, name)).join("\n")}`),
    ].join("\n\n");
    const answers: Answers = questions.length && decider.enabled() ? await decider.ask(state, questions, { purpose: "Texting first: picking the channel" }) : new Map();

    // Best fit first (or home, if unsure), then the others by how well they fit.
    const choice = answers.get("channel");
    const picked = confidentChoice(choice, threshold);
    const first = snap.channels.find((c) => c.name === picked) ?? snap.channels.find((c) => c.id === home.id) ?? snap.channels[0]!;
    const order = [first, ...snap.channels.filter((c) => c.id !== first.id).sort((a, b) => probabilityOf(choice, b.name) - probabilityOf(choice, a.name))];
    const fit = picked ? `#${first.name} fits best (${percent(probabilityOf(choice, picked))} sure)` : snap.channels.length > 1 ? `#${first.name} is home (unsure where it fits)` : `#${first.name}`;

    const skipped: string[] = [];
    for (const channel of order.slice(0, 3)) {
      const i = snap.channels.findIndex((c) => c.id === channel.id);
      // A channel with nothing recent can't be interrupted. Otherwise, only a confident no counts.
      const interrupting = busyIds.includes(channel.id) && tier(answers.get(`i${i + 1}`), threshold) !== "no";
      if (!interrupting) {
        if (channel.id === first.id) return { channel, why: `${fit}.` };
        return { channel, why: `${fit}, but ${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} mid-conversation, so #${channel.name}.` };
      }
      skipped.push(`#${channel.name}`);
    }
    return { channel: null, why: `${fit}, but ${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} mid-conversation.` };
  }

  // ------------------------------------------------------- after a turn

  /**
   * After one of her turns, anywhere: if reminders are due, did she mention
   * them? Then they count as sent, and won't be texted separately.
   */
  noticeTurn(channelId: string, messages: Message[]): void {
    if (this.ownTurn === channelId || messages.length === 0) return;
    const job = this.checkMentions(channelId, messages)
      .catch((error) => console.warn(`[proactive] couldn't check her message for reminders: ${(error as Error).message}`))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  private async checkMentions(channelId: string, messages: Message[]): Promise<void> {
    const { store, decider, clock } = this.deps;
    const now = clock();
    const due = dueReminders(store, now);
    if (due.length === 0) return;
    const record = (r: DueReminder, reason: string) =>
      store.reminders.record(r, "sent", { channelId, messageId: messages[0]!.id, reason }, clock());
    if (!decider.enabled()) {
      // Without Jev, a reminder she was told to mention here counts as mentioned.
      for (const r of due.filter((d) => d.queuedIn === channelId)) record(r, "mentioned in the conversation");
      return;
    }
    const name = store.getSettings().name;
    const answers = await decider.ask(
      `${name} just texted them:\n${messages.map((m) => m.content).join("\n")}\n\nReminders that are due:\n${due.map((r, i) => `- r${i + 1}: ${r.text}`).join("\n")}`,
      due.map((r, i) => ({ id: `r${i + 1}`, kind: "yesno" as const, question: `Did ${name}'s text remind them about r${i + 1} (${r.text})?` })),
      { purpose: "Reminders: did she mention them?" },
    );
    const threshold = store.getSettings().decisionConfidence;
    due.forEach((r, i) => {
      const answer = answers.get(`r${i + 1}`);
      if (tier(answer, threshold) === "yes") record(r, `mentioned in the conversation (${percent(probabilityOf(answer, "yes"))} sure)`);
    });
  }
}

// ---------------------------------------------------------------- words

/** What each reason is, for picking a channel. */
const REASON_WORDS: Record<ProactiveReason, string> = {
  reminder: "a reminder about a plan",
  checkin: "asking how work went",
  followup: "following up on something they talked about",
  "just-because": "a just-because text",
};

/**
 * Why she's texting first, as the note that ends her prompt (never saved or
 * shown). It says why, and that choosing not to text is fine.
 */
export function appNote(
  reason: ProactiveReason,
  facts: { reminders: DueReminder[]; workEnd: { end: Date } | null; quietMinutes: number; inARow: number },
): string {
  const why = {
    reminder: `to remind them: ${facts.reminders.map((r) => `${r.text} (${r.reminder.label.toLowerCase()} reminder)`).join("; ")}. Remind them in your own words, the way a friend would, not like a notification`,
    checkin: `because their work just ended${facts.workEnd ? ` (at ${formatClock(facts.workEnd.end)})` : ""}: a good moment to ask how it went`,
    followup: "to follow up on something from your pins or the things you might bring up, if it still feels right",
    "just-because": `just because: it's been quiet for ${hoursWords(facts.quietMinutes)}`,
  }[reason];
  const waiting = facts.inARow ? " They haven't answered your last text yet, so keep it light." : "";
  return `(App note, not from them: you're texting first, ${why}.${waiting} If it doesn't feel right after all, you can choose not to text.)`;
}

function result(outcome: ProactiveOutcome, detail: string): CheckResult {
  return { outcome, reason: null, channelId: null, detail, messages: [] };
}

/** "3 hours", "45 minutes", "2 days". */
export function hoursWords(minutes: number): string {
  if (!Number.isFinite(minutes)) return "a long time";
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  if (minutes < 36 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / 1440)} days`;
}

/** "once", "2 times"; or "1 reminder", "2 reminders". */
function times(count: number, noun?: string): string {
  if (noun) return `${count} ${noun}${count === 1 ? "" : "s"}`;
  return count === 1 ? "once" : `${count} times`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
