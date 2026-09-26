/**
 * The scratchpad check (stage 7): Jev reads each of your messages.
 *
 * When she's done waiting for you to finish typing (src/replies.ts), and
 * before she replies, **Jev** looks at your newest messages and answers a
 * handful of questions at once, each with a probability:
 *
 *   - For each tracker: did this happen? Which day? How much (for a scale)?
 *     Your hint words are given as clues, not rules, so "I *don't* have a
 *     headache" doesn't count.
 *   - Did you mention a plan? Something a friend would remember? Did you ask
 *     her to pin something, or let something go? Is any of it happening in
 *     the next few hours?
 *   - For each note already on the scratchpad: did you take it back, or
 *     change it? ("wait no, the dentist is *Friday*")
 *   - For each thing she asked you: did you answer yes, no, or not at all?
 *
 * Confident yeses become **sticky notes** (src/memory.ts), in pencil.
 * Anything that needs words (a plan card, "they seemed stressed about the
 * new manager") is written by the processing writer (src/writer.ts), in one
 * request. Your "yes" to one of her questions commits it right away: a plan
 * goes into the planner, a sticker into the log. Nothing from chat becomes
 * a plan without that yes.
 *
 * ## Decisions, confidence, and the safe path
 *
 * Every answer is read in three tiers (src/jev.ts): confident yes, confident
 * no, or unsure. Here, unsure always means "do nothing": no note is better
 * than a wrong one, since processing will look at everything again anyway.
 *
 * The check never stops her from replying: if Jev can't be reached, it's
 * logged and skipped. Each of your messages is checked once (a "mark"
 * remembers how far it has read in each channel).
 */

import { dayName } from "./binder.ts";
import { dateOf, addDays, toMoment, type LocalDate } from "./dates.ts";
import type { Events } from "./events.ts";
import { confidentChoice, percent, probabilityOf, tier, type Answers, type Decider, type Question } from "./jev.ts";
import type { Memory } from "./memory.ts";
import { ApiError, CancelledError, type ApiOptions } from "./nanogpt.ts";
import { formatClock } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { Message, MemoryLogEntry, Note, Tracker } from "./types.ts";
import { describeDraft, writeNotes, type WriteRequest, type Written } from "./writer.ts";

/** What the scratchpad check and processing need to do their work. */
export interface MemoryDeps {
  store: Store;
  api: ApiOptions;
  decider: Decider;
  events?: Events;
  /** What time it is. Tests pass a fake clock. */
  clock: () => Date;
}

/** How many messages before your new ones Jev sees, for context. */
const CONTEXT_MESSAGES = 12;
/** The most of your new messages one check reads. */
const MAX_FRESH = 20;

/** What one check did. */
export interface CheckResult {
  /** What changed, as logged. Empty if nothing did. */
  changes: MemoryLogEntry[];
  /** Why nothing was checked, if it wasn't. */
  skipped?: string;
}

// ------------------------------------------------------------- wording

/** "Sat 4:10 PM" */
export function stamp(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${formatClock(date)}`;
}

/** A chat line for Jev and the writer: "[Sat 4:10 PM] them (NEW): ugh my head". */
export function chatLine(message: Message, name: string, isNew = false): string {
  const who = message.author === "user" ? "them" : name;
  return `[${stamp(message.createdAt)}] ${who}${isNew ? " (NEW)" : ""}: ${message.content.replace(/\s+/g, " ").trim()}`;
}

/** "Saturday, September 26, 2026, 4:12 PM" */
export function longNow(now: Date): string {
  return `${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, ${formatClock(now)}`;
}

/** What a tracker records, in words. */
function records(tracker: Tracker): string {
  return { yesno: "yes or no", scale: "how much, 1 to 10", note: "a few words" }[tracker.kind];
}

/**
 * A tracker note in words: "headache 7/10 on Sat, Sep 26", "took meds on
 * Sat, Sep 26", "payday: $1,240 on Fri, Sep 25".
 */
export function describeTrackerNote(tracker: Tracker, value: string, date: LocalDate): string {
  const what = tracker.kind === "scale" ? `${tracker.name} ${value}/10` : tracker.kind === "note" ? `${tracker.name}: ${value}` : tracker.name;
  return `${what} on ${dayName(date)}`;
}

/** A short quote of a message, for a note the writer couldn't write. */
function quote(messages: Message[]): string {
  const text = messages.map((m) => m.content).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

// ---------------------------------------------------------------- check

export class Scratchpad {
  /** The check running in each channel, so a new bubble can stop it. */
  private readonly checking = new Map<string, AbortController>();
  /** Why the last check failed, for the advanced page. `null` if it worked. */
  lastError: string | null = null;

  constructor(private readonly deps: MemoryDeps) {}

  private get memory(): Memory {
    return this.deps.store.memory;
  }

  /** Stop a check in progress (you sent another bubble: it'll check everything again). */
  cancel(channelId: string): void {
    this.checking.get(channelId)?.abort();
  }

  /**
   * Check your new messages in a channel. Never throws: a failed check is
   * logged and skipped, so she still replies.
   */
  async check(channelId: string): Promise<CheckResult> {
    const { store, decider } = this.deps;
    let channel;
    try {
      channel = store.getChannel(channelId);
    } catch {
      return { changes: [], skipped: "the channel is gone" };
    }
    if (channel.kind !== "text") return { changes: [], skipped: "not a text channel" };

    // Your messages since the mark, and since her last reply: that's this
    // turn. (The first check in an old channel doesn't read its whole history.)
    const since = store.messagesSince(channelId, this.memory.mark(channelId));
    const herLast = since.findLastIndex((m) => m.message.author === "kitsikai");
    const fresh = since.slice(herLast + 1).slice(-MAX_FRESH);
    if (fresh.length === 0) return { changes: [], skipped: "no new messages" };
    const lastSeq = since.at(-1)!.seq;
    if (!decider.enabled()) {
      this.memory.setMark(channelId, lastSeq);
      return { changes: [], skipped: "Jev is turned off" };
    }

    this.cancel(channelId);
    const controller = new AbortController();
    this.checking.set(channelId, controller);
    try {
      const changes = await this.run(channel.id, channel.name, fresh.map((m) => m.message), controller.signal);
      this.memory.setMark(channelId, lastSeq);
      this.lastError = null;
      if (changes.length) this.deps.events?.publish({ type: "memory" });
      return { changes };
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) return { changes: [], skipped: "stopped" };
      // A failed check is skipped, not retried: those messages stay unchecked.
      this.memory.setMark(channelId, lastSeq);
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[scratchpad] check in #${channel.name} failed: ${this.lastError}`);
      return { changes: [], skipped: this.lastError };
    } finally {
      if (this.checking.get(channelId) === controller) this.checking.delete(channelId);
    }
  }

  /** The check itself: ask Jev, write what needs words, save the notes. */
  private async run(channelId: string, channelName: string, fresh: Message[], signal: AbortSignal): Promise<MemoryLogEntry[]> {
    const { store, api, decider, clock } = this.deps;
    const settings = store.getSettings();
    const threshold = settings.decisionConfidence;
    const now = clock();
    const today = dateOf(now);
    const trackers = store.trackers.list();
    const open = this.memory.notes(["open"]);
    const asking = this.memory.notes(["asking"]);

    // --- the state: what Jev (and the writer) read
    const freshIds = new Set(fresh.map((m) => m.id));
    const earlier = store
      .recentMessages(channelId, CONTEXT_MESSAGES + fresh.length)
      .filter((m) => !freshIds.has(m.id) && m.createdAt <= fresh[0]!.createdAt)
      .slice(-CONTEXT_MESSAGES);
    const chat = [...earlier.map((m) => chatLine(m, settings.name)), ...fresh.map((m) => chatLine(m, settings.name, true))];
    const noteIds = new Map(open.map((n, i) => [`n${i + 1}`, n]));
    const askIds = new Map(asking.map((n, i) => [`a${i + 1}`, n]));
    const state = [
      `Today is ${longNow(now)}.`,
      `The chat in #${channelName} between them and ${settings.name}, oldest first. Their NEW messages, the ones the questions are about, are marked NEW:\n${chat.join("\n")}`,
      trackers.length
        ? `What they asked ${settings.name} to keep an eye out for (trackers):\n${trackers
            .map((t) => `- ${t.name}: ${records(t)}${t.hintWords.length ? ` (clue words: ${t.hintWords.join(", ")})` : ""}`)
            .join("\n")}`
        : "",
      open.length ? `${settings.name}'s notes, not processed yet:\n${[...noteIds].map(([id, n]) => `- ${id}: ${n.text}`).join("\n")}` : "",
      asking.length ? `What ${settings.name} asked them about:\n${[...askIds].map(([id, n]) => `- ${id}: ${n.ask ?? n.text}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // --- the questions
    const questions: Question[] = [];
    trackers.forEach((t, i) => {
      const id = `t${i + 1}`;
      questions.push({
        id,
        kind: "yesno",
        question: `Do their NEW messages say that "${t.name}" happened? Only if they say it did: "no ${t.name} today" doesn't count.`,
      });
      questions.push({ id: `${id}.day`, kind: "choice", question: `If "${t.name}" happened, when?`, options: ["today", "yesterday"] });
      if (t.kind === "scale") {
        questions.push({
          id: `${id}.level`,
          kind: "choice",
          question: `If "${t.name}" happened, how much, from 1 (a little) to 10 (the worst)?`,
          options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        });
      }
    });
    questions.push(
      {
        id: "plan",
        kind: "yesno",
        question: "Do their NEW messages mention a plan for a future day or time (an appointment, a birthday, a hangout, a shift)?",
      },
      {
        id: "remember",
        kind: "yesno",
        question:
          "Do their NEW messages say something a close friend would want to remember for later: how they're feeling, news, or something coming up to ask about? Not small talk, and not a plan.",
      },
      {
        id: "request",
        kind: "choice",
        question: `Do their NEW messages ask ${settings.name} to pin something (keep it in mind), to let something go (take it off her pins), or neither?`,
        options: ["pin", "let go", "neither"],
      },
      { id: "soon", kind: "yesno", question: "Is anything in their NEW messages about something happening in the next few hours?" },
    );
    for (const id of noteIds.keys()) {
      questions.push({ id, kind: "choice", question: `Do their NEW messages take back or change note ${id}?`, options: ["took it back", "changed it", "neither"] });
    }
    for (const id of askIds.keys()) {
      questions.push({ id, kind: "choice", question: `Do their NEW messages answer what ${settings.name} asked in ${id}?`, options: ["yes", "no", "not answered"] });
    }

    // Stage 8: on call right now? Then: called in, or done?
    const onCall = this.onCall(now);
    if (onCall) {
      questions.push(
        onCall.calledIn
          ? { id: "done", kind: "yesno", question: "Do their NEW messages say they're done with work now (off, heading home)?" }
          : { id: "calledIn", kind: "yesno", question: "Do their NEW messages say they got called in to work (they're on call)?" },
      );
    }
    const onCallState = onCall
      ? `\n\n${onCall.calledIn ? `They got called in to their on-call shift (until ${formatClock(onCall.end)}).` : `They're on call right now, until ${formatClock(onCall.end)}: free unless they get called in.`}`
      : "";

    const answers = await decider.ask(state + onCallState, questions, signal);
    if (signal.aborted) throw new CancelledError();
    const changes = await this.apply({ answers, threshold, state, trackers, noteIds, askIds, fresh, channelId, now, today, signal, api });
    if (onCall) changes.push(...this.applyOnCall(onCall, answers, threshold, fresh.at(-1)!.id));
    return changes;
  }

  /**
   * The on-call shift you're in right now, if any (stage 8): on call means
   * free unless you get called in; called in means at work until you say
   * you're done or the window ends.
   */
  private onCall(now: Date): { key: string; end: Date; calledIn: boolean } | null {
    const { store } = this.deps;
    const today = dateOf(now);
    const calledIn = store.reminders.calledIn();
    const found = store.plans
      .occurrences(addDays(today, -1), today, { calledIn })
      .find((o) => o.plan.shiftType === "oncall" && o.startTime && o.endTime && o.endDate && toMoment(o.date, o.startTime) <= now && now < toMoment(o.endDate, o.endTime));
    return found ? { key: found.key, end: toMoment(found.endDate!, found.endTime!), calledIn: calledIn.has(found.key) } : null;
  }

  /** You got called in, or you're done: from then on, she treats you as at work, or not. */
  private applyOnCall(onCall: { key: string; end: Date; calledIn: boolean }, answers: Answers, threshold: number, messageId: string): MemoryLogEntry[] {
    const { store, events, clock } = this.deps;
    const now = clock();
    const id = onCall.calledIn ? "done" : "calledIn";
    if (tier(answers.get(id), threshold) !== "yes") return [];
    const reason = `they said so (${percent(probabilityOf(answers.get(id), "yes"))} sure)`;
    let entry: MemoryLogEntry;
    if (onCall.calledIn) {
      store.reminders.doneWith(onCall.key, now);
      entry = this.memory.log({ runId: null, action: "done", text: "done with work (they'd been called in)", reason, messageId }, now);
    } else {
      store.reminders.callIn(onCall.key, now);
      entry = this.memory.log({ runId: null, action: "noted", text: `called in to work (on call until ${formatClock(onCall.end)})`, reason, messageId }, now);
    }
    events?.publish({ type: "plans" });
    return [entry];
  }

  /** Turn Jev's answers into notes (and commits, and tossed notes). */
  private async apply(c: {
    answers: Answers;
    threshold: number;
    state: string;
    trackers: Tracker[];
    noteIds: Map<string, Note>;
    askIds: Map<string, Note>;
    fresh: Message[];
    channelId: string;
    now: Date;
    today: LocalDate;
    signal: AbortSignal;
    api: ApiOptions;
  }): Promise<MemoryLogEntry[]> {
    const { store, clock } = this.deps;
    const { answers, threshold, now, today } = c;
    const changes: MemoryLogEntry[] = [];
    const messageId = c.fresh.at(-1)!.id;
    const log = (entry: Parameters<Memory["log"]>[0]) => changes.push(this.memory.log({ ...entry, messageId: entry.messageId ?? messageId }, clock()));
    const sure = (id: string, option = "yes") => `${percent(probabilityOf(answers.get(id), option))} sure`;

    // --- answers to what she asked
    for (const [id, note] of c.askIds) {
      const answer = confidentChoice(answers.get(id), threshold);
      if (answer === "yes") this.confirm(note, sure(id), log);
      else if (answer === "no") {
        this.memory.updateNote(note.id, { status: "tossed" }, now);
        log({ runId: null, action: "declined", text: note.text, reason: `they said no (${sure(id, "no")})`, noteId: note.id });
      }
    }

    // Short ids for the writer's requests: w1, w2...
    let writeCount = 0;
    const nextId = () => `w${++writeCount}`;

    // --- notes taken back or changed
    const rewrites: { note: Note; request: WriteRequest }[] = [];
    const changedKinds = new Set<string>();
    for (const [id, note] of c.noteIds) {
      const answer = confidentChoice(answers.get(id), threshold);
      if (answer === "took it back") {
        this.memory.updateNote(note.id, { status: "tossed" }, now);
        log({ runId: null, action: "tossed", text: note.text, reason: `they took it back (${sure(id, "took it back")})`, noteId: note.id });
      } else if (answer === "changed it") {
        changedKinds.add(note.kind);
        // Tracker notes are rewritten by the tracker questions below.
        if (note.kind !== "tracker") {
          const kind = note.kind === "request" ? (note.request === "unpin" ? "unpin" : "pin") : note.kind;
          rewrites.push({ note, request: { id: nextId(), kind, was: note.text } });
        }
      }
    }

    // --- trackers
    const writeRequests: WriteRequest[] = [];
    const trackerHits: { tracker: Tracker; value: string | null; date: LocalDate; request?: WriteRequest; reason: string }[] = [];
    c.trackers.forEach((tracker, i) => {
      const id = `t${i + 1}`;
      if (tier(answers.get(id), threshold) !== "yes") return;
      const date = answers.get(`${id}.day`)?.selected === "yesterday" ? addDays(today, -1) : today;
      const hit = { tracker, date, value: null as string | null, reason: `they said so (${sure(id)})` };
      if (tracker.kind === "yesno") hit.value = "yes";
      if (tracker.kind === "scale") hit.value = answers.get(`${id}.level`)?.selected ?? null;
      if (tracker.kind === "note") {
        const request: WriteRequest = { id: nextId(), kind: "value", tracker: tracker.name };
        writeRequests.push(request);
        trackerHits.push({ ...hit, request });
        return;
      }
      if (hit.value) trackerHits.push(hit);
    });

    // --- plans, things to remember, requests (not when they just corrected a note of that kind)
    const soon = tier(answers.get("soon"), threshold) === "yes";
    const newNotes: { request: WriteRequest; kind: Note["kind"]; reason: string; pinRequest?: "pin" | "unpin" }[] = [];
    if (tier(answers.get("plan"), threshold) === "yes" && !changedKinds.has("plan")) {
      newNotes.push({ request: { id: nextId(), kind: "plan" }, kind: "plan", reason: `a plan came up (${sure("plan")})` });
    }
    if (tier(answers.get("remember"), threshold) === "yes" && !changedKinds.has("remember")) {
      newNotes.push({
        request: { id: nextId(), kind: "remember" },
        kind: "remember",
        reason: `worth remembering (${sure("remember")})`,
      });
    }
    const request = confidentChoice(answers.get("request"), threshold);
    if ((request === "pin" || request === "let go") && !changedKinds.has("request")) {
      const which = request === "pin" ? "pin" : "unpin";
      newNotes.push({
        request: { id: nextId(), kind: which },
        kind: "request",
        pinRequest: which,
        reason: `they asked you to ${request === "pin" ? "pin it" : "let it go"} (${sure("request", request)})`,
      });
    }
    writeRequests.push(...newNotes.map((n) => n.request), ...rewrites.map((r) => r.request));

    // --- the words, all in one request to the writer
    let written = new Map<string, Written>();
    if (writeRequests.length) {
      try {
        const profile = store.profiles.pick(store.getSettings().writerAssignment, false);
        written = await writeNotes(c.api, profile, c.state, today, writeRequests, c.signal);
      } catch (error) {
        if (error instanceof CancelledError || c.signal.aborted) throw new CancelledError();
        // Without the writer, notes keep a quote of your message instead.
        const reason = error instanceof ApiError || error instanceof Error ? error.message : String(error);
        console.warn(`[scratchpad] the writer failed: ${reason}`);
        log({ runId: null, action: "error", text: "Couldn't write the notes", reason });
      }
    }
    if (c.signal.aborted) throw new CancelledError();

    // --- save: trackers (one note per tracker and day: a new value rewrites it)
    for (const hit of trackerHits) {
      const value = hit.request ? (written.get(hit.request.id)?.value ?? quote(c.fresh)) : hit.value!;
      const text = describeTrackerNote(hit.tracker, value, hit.date);
      const existing = this.memory
        .notes(["open", "asking"])
        .find((n) => n.kind === "tracker" && n.trackerId === hit.tracker.id && n.date === hit.date);
      if (existing) {
        if (existing.value === value) continue;
        this.memory.updateNote(existing.id, { value, text }, now);
        log({ runId: null, action: "rewritten", text, reason: `was "${existing.text}"; ${hit.reason}`, noteId: existing.id });
      } else {
        const note = this.memory.addNote(
          { kind: "tracker", text, origin: "noticed", trackerId: hit.tracker.id, value, date: hit.date, channelId: c.channelId, messageId },
          now,
        );
        log({ runId: null, action: "noted", text, reason: hit.reason, noteId: note.id });
      }
    }

    // --- save: new notes
    const fallbackWords = { plan: "they mentioned a plan", remember: "worth remembering", request: "they asked about your pins", tracker: "" };
    for (const n of newNotes) {
      const words = written.get(n.request.id);
      const text = words?.text ?? `${fallbackWords[n.kind]}: "${quote(c.fresh)}"`;
      const note = this.memory.addNote(
        {
          kind: n.kind,
          text,
          origin: "noticed",
          yours: n.kind === "request",
          timeSensitive: soon && n.kind !== "request",
          planDraft: words?.plan ?? null,
          request: n.pinRequest ?? null,
          channelId: c.channelId,
          messageId,
        },
        now,
      );
      log({ runId: null, action: "noted", text, reason: n.reason + (soon && n.kind !== "request" ? ", and it's soon" : ""), noteId: note.id });
    }

    // --- save: rewrites
    for (const { note, request: r } of rewrites) {
      const words = written.get(r.id);
      if (!words) continue;
      const changesToNote = note.kind === "plan" ? { text: words.text, planDraft: words.plan ?? note.planDraft } : { text: words.text };
      this.memory.updateNote(note.id, changesToNote, now);
      log({ runId: null, action: "rewritten", text: words.text, reason: `they changed it; was "${note.text}"`, noteId: note.id });
    }
    return changes;
  }

  /**
   * You said yes to something she asked. A plan goes into the planner and a
   * sticker into the log, right away; anything else is marked confirmed, so
   * processing takes it as true.
   */
  private confirm(note: Note, sure: string, log: (entry: Parameters<Memory["log"]>[0]) => void): void {
    const { store, events, clock } = this.deps;
    const now = clock();
    try {
      if (note.kind === "plan" && note.planDraft) {
        store.plans.create({ ...note.planDraft, repeats: "never", checked: true, source: "chat" });
        this.memory.updateNote(note.id, { status: "done", confirmed: true }, now);
        log({ runId: null, action: "confirmed", text: describeDraft(note.planDraft), reason: `they said yes (${sure}), so it's in the planner`, noteId: note.id });
        events?.publish({ type: "plans" });
        return;
      }
      if (note.kind === "tracker" && note.trackerId && note.date && note.value) {
        store.trackers.addEntry({ trackerId: note.trackerId, date: note.date, value: note.value, source: "confirmed", messageId: note.messageId });
        this.memory.updateNote(note.id, { status: "done", confirmed: true }, now);
        log({ runId: null, action: "confirmed", text: note.text, reason: `they said yes (${sure}), so it's in the log`, noteId: note.id });
        events?.publish({ type: "log" });
        return;
      }
      this.memory.updateNote(note.id, { status: "open", confirmed: true, ask: null }, now);
      log({ runId: null, action: "confirmed", text: note.text, reason: `they said yes (${sure}); it'll be kept at processing`, noteId: note.id });
    } catch (error) {
      // The tracker was deleted, or the plan no longer checks out.
      this.memory.updateNote(note.id, { status: "tossed" }, now);
      log({ runId: null, action: "error", text: note.text, reason: `they said yes, but it couldn't be saved: ${(error as Error).message}`, noteId: note.id });
    }
  }
}
