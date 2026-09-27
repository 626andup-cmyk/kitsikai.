/**
 * Processing (stage 7): pencil to pen, every few hours.
 *
 * Every few hours (Settings, default 3) she goes through her scratchpad.
 * This is a **batch job**: instead of deciding each note the moment it's
 * written, the notes pile up and are decided together, with the chat since
 * each one in view. That's what gives you time to correct things just by
 * talking. For every note, Jev is asked: *is this still true, or did later
 * chat change it?*
 *
 *   | Note           | Clearly true              | Clearly wrong | Unsure      |
 *   | -------------- | ------------------------- | ------------- | ----------- |
 *   | tracker        | a sticker in the log      | tossed        | she asks    |
 *   | plan           | she asks "want me to put…" | tossed       | she asks    |
 *   | to remember    | something to bring up (maybe pinned) | tossed | she asks |
 *   | your request   | honored: pinned / let go  | tossed        | she asks    |
 *
 * Plans always go through asking: nothing from chat becomes a plan until
 * you say yes (src/scratchpad.ts commits it when you do).
 *
 * The same round checks her **pins**: a pin whose date has passed comes down
 * without asking; for the others Jev is asked whether its "when to unpin"
 * has happened. Only a confident yes takes it down: a pin that stays up too
 * long is harmless, one that comes down too early is forgetting. There's a
 * **cap** (default 10): when it's full, Jev picks what matters least.
 *
 * **Time-sensitive notes are processed early** ("dentist in an hour" can't
 * wait three hours): src/scheduler.ts starts a small round for just those.
 *
 * Everything that happens is written to the memory log, with why and how
 * sure Jev was, for the advanced page.
 */

import { dateOf, type LocalDate } from "./dates.ts";
import { confidentChoice, percent, probabilityOf, tier, type Answers, type Question, type Tier } from "./jev.ts";
import { describePin, type Memory, type NewLogEntry } from "./memory.ts";
import { chatLine, longNow, stamp, type MemoryDeps } from "./scratchpad.ts";
import type { MemoryLogEntry, Note, Pin, ProcessingRun, ProcessingTrigger } from "./types.ts";
import { composePins, describeDraft, type WrittenPin } from "./writer.ts";

/** How old a note has to be (minutes) before a regular round takes it: a little time for corrections. */
export const MIN_NOTE_AGE_MINUTES = 10;
/** How long she waits for an answer to something she asked (days), before letting it go. */
export const ASK_EXPIRY_DAYS = 3;
/** How far back the chat in a round goes (days), at most. */
const CHAT_DAYS = 7;
/** How many recent messages per channel a round sees, at most. */
const CHAT_MESSAGES = 30;

/** Thrown when a round is asked for while one is running. */
export class AlreadyProcessingError extends Error {
  constructor() {
    super("She's already processing her notes. Wait for that to finish.");
    this.name = "AlreadyProcessingError";
  }
}

/** What a round did. */
export interface RunResult {
  run: ProcessingRun;
  log: MemoryLogEntry[];
}

export class Processing {
  private running: Promise<RunResult> | null = null;

  constructor(private readonly deps: MemoryDeps) {}

  private get memory(): Memory {
    return this.deps.store.memory;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Process her scratchpad and pins once.
   *
   * @param trigger  "timer" (the regular round), "early" (only time-sensitive
   *                 notes), or "manual" ("Process now": everything, however new).
   * @throws AlreadyProcessingError if a round is running.
   */
  async run(trigger: ProcessingTrigger): Promise<RunResult> {
    if (this.running) throw new AlreadyProcessingError();
    this.running = this.process(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async process(trigger: ProcessingTrigger): Promise<RunResult> {
    const { clock, events } = this.deps;
    const run = this.memory.startRun(trigger, clock());
    const log: MemoryLogEntry[] = [];
    const write = (entry: Omit<NewLogEntry, "runId">) => log.push(this.memory.log({ ...entry, runId: run.id }, clock()));
    let error: string | null = null;
    try {
      await this.steps(trigger, write);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.warn(`[processing] round stopped: ${error}`);
      write({ action: "error", text: "Processing stopped", reason: error });
    }
    const finished = this.memory.finishRun(run.id, clock(), error);
    events?.publish({ type: "memory" });
    if (log.length) console.log(`[processing] ${trigger} round: ${log.length} change(s)${error ? " (stopped early)" : ""}`);
    return { run: finished, log };
  }

  private async steps(trigger: ProcessingTrigger, write: (entry: Omit<NewLogEntry, "runId">) => void): Promise<void> {
    const { store, decider, clock, events } = this.deps;
    const settings = store.getSettings();
    const threshold = settings.decisionConfidence;
    const now = clock();
    const today = dateOf(now);
    let changedLog = false;

    // --- 1. Pins whose date has passed come down: no need to ask.
    for (const pin of this.memory.pins()) {
      if (pin.unpinDate && pin.unpinDate < today) {
        this.memory.unpin(pin.id, "its date passed", now);
        write({ action: "unpinned", text: pin.text, reason: `its date (${pin.unpinDate}) passed`, pinId: pin.id });
      }
    }

    // --- 2. Questions nobody answered for days are let go.
    if (trigger !== "early") {
      for (const note of this.memory.notes(["asking"])) {
        if (ageMinutes(note.updatedAt, now) > ASK_EXPIRY_DAYS * 24 * 60) {
          this.memory.updateNote(note.id, { status: "tossed" }, now);
          write({ action: "tossed", text: note.text, reason: `never answered in ${ASK_EXPIRY_DAYS} days`, noteId: note.id, messageId: note.messageId });
        }
      }
    }

    // --- 3. What this round looks at.
    const open = this.memory.notes(["open"]).filter((n) => {
      if (trigger === "early") return n.timeSensitive;
      if (trigger === "timer") return n.timeSensitive || ageMinutes(n.createdAt, now) >= MIN_NOTE_AGE_MINUTES;
      return true;
    });
    const bringUps = trigger === "early" ? [] : this.memory.notes(["bringup"]);
    const pins = trigger === "early" ? [] : this.memory.pins();
    if (open.length === 0 && bringUps.length === 0 && pins.length === 0) return;
    if (!decider.enabled()) throw new Error("Jev is turned off and there's no fallback profile, so nothing can be decided.");

    const ids = {
      notes: new Map(open.map((n, i) => [`n${i + 1}`, n])),
      bringUps: new Map(bringUps.map((n, i) => [`b${i + 1}`, n])),
      pins: new Map(pins.map((p, i) => [`p${i + 1}`, p])),
    };
    const state = this.state(now, settings.name, ids);

    // --- 4. One set of questions for everything.
    const questions: Question[] = [];
    for (const [id, note] of ids.notes) {
      if (!note.confirmed) {
        questions.push({
          id,
          kind: "yesno",
          question:
            note.kind === "request"
              ? `Do they still want what note ${id} says? No if they took it back.`
              : `Is note ${id} still true, given the chat since ${settings.name} wrote it? No if they took it back, corrected it, or it was a misunderstanding.`,
        });
      }
      if (note.kind === "remember") {
        questions.push({
          id: `${id}_pin`,
          kind: "yesno",
          question: `Does note ${id} matter so much right now that ${settings.name} should keep it in front of her at all times (pin it)? Only for big things: an exam, a hard week, something they're waiting on.`,
        });
      }
      if (note.kind === "request" && note.request === "unpin" && pins.length) {
        questions.push({
          id: `${id}_which`,
          kind: "choice",
          question: `Which of ${settings.name}'s pins do they want her to let go of, in note ${id}?`,
          options: [...ids.pins.keys(), "none of these"],
        });
      }
    }
    for (const id of ids.bringUps.keys()) {
      questions.push({
        id,
        kind: "yesno",
        question: `Has what note ${id} is about been talked through or settled since it was written? Yes if they already talked it over, or it no longer matters.`,
      });
    }
    for (const id of ids.pins.keys()) {
      questions.push({
        id,
        kind: "yesno",
        question: `Should pin ${id} come down now? Only yes if its "unpin when" has clearly happened, or it clearly no longer matters.`,
      });
    }
    const answers: Answers = questions.length ? await decider.ask(state, questions) : new Map();
    const read = (id: string, note?: Note): Tier => (note?.confirmed ? "yes" : tier(answers.get(id), threshold));
    const sure = (id: string, option = "yes") => `${percent(probabilityOf(answers.get(id), option))} sure`;

    // --- 5. The notes.
    const toPin: { note: Note; yours: boolean }[] = [];
    for (const [id, note] of ids.notes) {
      const verdict = read(id, note);
      const why = note.confirmed ? "they confirmed it" : verdict === "yes" ? `still true, ${sure(id)}` : `no longer true, ${sure(id, "no")}`;
      const base = { noteId: note.id, messageId: note.messageId };
      const ask = (question: string, reason: string) => {
        this.memory.updateNote(note.id, { status: "asking", ask: question }, now);
        write({ action: "asking", text: note.text, reason, ...base });
      };
      const unsure = `unsure (${percent(probabilityOf(answers.get(id), "yes"))} it's still true), so she'll ask`;
      if (verdict === "no") {
        this.memory.updateNote(note.id, { status: "tossed" }, now);
        write({ action: "tossed", text: note.text, reason: why, ...base });
        continue;
      }

      if (note.kind === "tracker") {
        if (verdict === "unsure") {
          ask(`whether this is right: ${note.text}`, unsure);
          continue;
        }
        try {
          // The same sticker may be there already (you logged it, or she did
          // with her log_sticker tool): then there's nothing to add.
          const already = store.trackers
            .entries({ trackerId: note.trackerId!, from: note.date!, to: note.date! })
            .some((e) => e.value === note.value);
          if (!already) {
            store.trackers.addEntry({ trackerId: note.trackerId!, date: note.date!, value: note.value!, source: "processing", messageId: note.messageId });
          }
          this.memory.updateNote(note.id, { status: "done" }, now);
          write({ action: "committed", text: note.text, reason: already ? `${why}: already in the log` : `${why}: in the log`, ...base });
          changedLog ||= !already;
        } catch (e) {
          this.memory.updateNote(note.id, { status: "tossed" }, now);
          write({ action: "error", text: note.text, reason: `couldn't be logged: ${(e as Error).message}`, ...base });
        }
      } else if (note.kind === "plan") {
        const draft = note.planDraft;
        if (!draft) {
          this.memory.updateNote(note.id, { status: "tossed" }, now);
          write({ action: "tossed", text: note.text, reason: "couldn't work out the plan's day and time", ...base });
          continue;
        }
        const already = store.plans
          .occurrences(draft.startDate, draft.startDate)
          .some((o) => o.plan.title.trim().toLowerCase() === draft.title.trim().toLowerCase());
        if (already) {
          this.memory.updateNote(note.id, { status: "done" }, now);
          write({ action: "done", text: note.text, reason: "it's already in the planner", ...base });
          continue;
        }
        ask(
          `whether they want "${describeDraft(draft)}" put in the planner`,
          verdict === "yes" ? `${why}; plans from chat need their yes` : unsure,
        );
      } else if (note.kind === "remember") {
        if (verdict === "unsure") {
          ask(`whether this is still the case: ${note.text}`, unsure);
          continue;
        }
        this.memory.updateNote(note.id, { status: "bringup" }, now);
        write({ action: "bringup", text: note.text, reason: why, ...base });
        if (tier(answers.get(`${id}_pin`), threshold) === "yes") toPin.push({ note, yours: false });
      } else if (note.kind === "request") {
        if (verdict === "unsure") {
          ask(`whether they still want you to ${note.request === "unpin" ? "let go of" : "pin"}: ${note.text}`, unsure);
          continue;
        }
        if (note.request === "pin") {
          toPin.push({ note, yours: true });
          continue;
        }
        // Let something go: which pin?
        const which = confidentChoice(answers.get(`${id}_which`), threshold);
        const pin = which ? ids.pins.get(which) : undefined;
        if (pin && pin.status === "pinned") {
          this.memory.unpin(pin.id, "they asked", now);
          pin.status = "drawer";
          write({ action: "unpinned", text: pin.text, reason: `they asked (${sure(`${id}_which`, which!)})`, pinId: pin.id, messageId: note.messageId });
          this.memory.updateNote(note.id, { status: "done" }, now);
        } else if (pins.length === 0) {
          this.memory.updateNote(note.id, { status: "tossed" }, now);
          write({ action: "tossed", text: note.text, reason: "nothing is pinned", ...base });
        } else {
          ask(`which pin they want you to let go of (${note.text})`, "not sure which pin they meant, so she'll ask");
        }
      }
    }

    // --- 6. Things she might bring up.
    for (const [id, note] of ids.bringUps) {
      const verdict = read(id);
      if (verdict === "yes") {
        this.memory.updateNote(note.id, { status: "done" }, now);
        write({ action: "done", text: note.text, reason: `talked through or settled, ${sure(id)}`, noteId: note.id, messageId: note.messageId });
      } else {
        write({ action: "kept", text: note.text, reason: verdict === "no" ? `not settled yet, ${sure(id, "no")}` : "unsure, so it stays", noteId: note.id });
      }
    }

    // --- 7. Pins: only a confident yes takes one down.
    for (const [id, pin] of ids.pins) {
      if (pin.status !== "pinned") continue;
      const verdict = read(id);
      if (verdict === "yes") {
        this.memory.unpin(pin.id, `time to come down (${sure(id)})`, now);
        pin.status = "drawer";
        write({ action: "unpinned", text: pin.text, reason: `time to come down, ${sure(id)}`, pinId: pin.id });
      } else {
        write({ action: "kept", text: pin.text, reason: verdict === "no" ? `still matters, ${sure(id, "no")}` : "unsure, so it stays up", pinId: pin.id });
      }
    }

    // --- 8. New pins, written by the processing writer, within the cap.
    if (toPin.length) await this.pinAll(toPin, state, today, write);

    if (changedLog) events?.publish({ type: "log" });
  }

  /** Pin notes, making room when the pins are full. */
  private async pinAll(toPin: { note: Note; yours: boolean }[], state: string, today: LocalDate, write: (entry: Omit<NewLogEntry, "runId">) => void): Promise<void> {
    const { store, api, decider, clock } = this.deps;
    const settings = store.getSettings();
    const items = toPin.map((t, i) => ({ id: `new${i + 1}`, text: t.note.text, yours: t.yours }));
    let written = new Map<string, WrittenPin>();
    try {
      written = await composePins(api, store.profiles.pick(settings.writerAssignment, false), state, today, items);
    } catch (e) {
      // Without the writer, a pin is just the note.
      write({ action: "error", text: "Couldn't write the pins", reason: (e as Error).message });
    }

    for (const [i, { note, yours }] of toPin.entries()) {
      const words = written.get(`new${i + 1}`) ?? { text: note.text, reason: "", unpinWhen: "", unpinDate: null };
      const now = clock();
      const pins = this.memory.pins();
      if (pins.length >= settings.pinCap) {
        const room = await this.makeRoom(pins, words.text, yours, settings.decisionConfidence, settings.name);
        if (!room) {
          // Not pinned, but not forgotten: it's still something she might bring up.
          this.memory.updateNote(note.id, { status: note.kind === "remember" ? "bringup" : "tossed" }, now);
          write({ action: "kept", text: note.text, reason: "her pins are full, and this mattered least", noteId: note.id, messageId: note.messageId });
          continue;
        }
        this.memory.unpin(room.pin.id, room.reason, now);
        write({ action: "unpinned", text: room.pin.text, reason: room.reason, pinId: room.pin.id });
      }
      const pin = this.memory.addPin({ ...words, yours, noteId: note.id }, now);
      if (note.kind === "request") this.memory.updateNote(note.id, { status: "done" }, now);
      write({ action: "pinned", text: pin.text, reason: yours ? "they asked" : words.reason || "it matters right now", pinId: pin.id, noteId: note.id, messageId: note.messageId });
    }
  }

  /**
   * The pins are full: which one comes down for the new one? Jev picks the
   * one that matters least (maybe the new one). If Jev isn't sure: for your
   * request, the oldest pin you didn't ask for comes down; otherwise the
   * new one isn't pinned.
   */
  private async makeRoom(pins: Pin[], newText: string, yours: boolean, threshold: number, name: string): Promise<{ pin: Pin; reason: string } | null> {
    const ids = new Map(pins.map((p, i) => [`p${i + 1}`, p]));
    let pick: string | null = null;
    try {
      const answers = await this.deps.decider.ask(
        `${name}'s pins are full (${pins.length}). She wants to pin: "${newText}"${yours ? " (they asked her to)" : ""}.\n\nHer pins:\n${[...ids]
          .map(([id, p]) => `- ${id}: ${describePin(p)}`)
          .join("\n")}`,
        [{ id: "drop", kind: "choice", question: "Which matters least right now, and should come down?", options: [...ids.keys(), "the new one"] }],
      );
      pick = confidentChoice(answers.get("drop"), threshold);
    } catch {
      pick = null;
    }
    const chosen = pick ? ids.get(pick) : undefined;
    if (chosen) return { pin: chosen, reason: `made room for "${newText}"` };
    if (!yours) return null;
    const oldest = pins.find((p) => !p.yours) ?? pins[0]!;
    return { pin: oldest, reason: `made room for their request "${newText}" (the oldest pin)` };
  }

  /** What Jev reads: the time, the recent chat, and every note and pin, with short ids. */
  private state(now: Date, name: string, ids: { notes: Map<string, Note>; bringUps: Map<string, Note>; pins: Map<string, Pin> }): string {
    const { store } = this.deps;
    const items = [...ids.notes.values(), ...ids.bringUps.values()];
    const oldest = Math.min(
      ...items.map((n) => new Date(n.createdAt).getTime()),
      ...[...ids.pins.values()].map((p) => new Date(p.pinnedAt).getTime()),
    );
    const from = Math.max(oldest - 3600_000, now.getTime() - CHAT_DAYS * 24 * 3600_000);
    const chats = store
      .listChannels()
      .filter((c) => c.kind === "text")
      .map((c) => ({ channel: c, messages: store.recentMessages(c.id, CHAT_MESSAGES).filter((m) => new Date(m.createdAt).getTime() >= from) }))
      .filter((c) => c.messages.length)
      .map((c) => `#${c.channel.name}:\n${c.messages.map((m) => chatLine(m, name)).join("\n")}`);
    const channelName = (id: string | null) => (id ? store.listChannels().find((c) => c.id === id)?.name : undefined);
    const describeNote = ([id, n]: [string, Note]) =>
      `- ${id} (written ${stamp(n.createdAt)}${channelName(n.channelId) ? ` in #${channelName(n.channelId)}` : ""}${n.yours ? ", they asked for this" : ""}${n.confirmed ? ", they confirmed it" : ""}): ${n.text}`;
    return [
      `Today is ${longNow(now)}.`,
      chats.length ? `The chat between them and ${name} since then, by channel (oldest first):\n\n${chats.join("\n\n")}` : "There's been no chat since.",
      ids.notes.size ? `${name}'s notes to process:\n${[...ids.notes].map(describeNote).join("\n")}` : "",
      ids.bringUps.size ? `Things ${name} kept to maybe bring up:\n${[...ids.bringUps].map(describeNote).join("\n")}` : "",
      ids.pins.size ? `${name}'s pins:\n${[...ids.pins].map(([id, p]) => `- ${id} (pinned ${stamp(p.pinnedAt)}): ${describePin(p)}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

/** Minutes since a time. */
function ageMinutes(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / 60_000;
}
