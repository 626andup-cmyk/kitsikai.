/**
 * Intimacy register routing: which mode she's in, and how hard.
 *
 * The persona describes several distinct ways she can want you — from soft
 * warmth through outright force — and the point is that you never know which
 * one you're standing in until you're already inside it. This module is what
 * makes that true in the app: before each of her turns, **Jev** reads the
 * recent conversation and picks a **register** (a named mode from the persona),
 * each with a probability. The chosen register is handed to the chat model as
 * a short prompt layer ("Between you right now"), so the model knows which
 * gear she's in without the routing machinery ever surfacing as text.
 *
 * The registers, matching the persona's [INTIMACY] section:
 *
 *   warm          ordinary fondness, care, day-to-day
 *   soft          the soft edge (dubcon): tired/high/loose, the boundary blurs
 *   hard          the hard edge (noncon): she stops asking, the force is real
 *   capture       kidnapping/taking: a room you can't leave, a timetable that's hers
 *   leverage      blackmail: she uses what you gave her against you
 *   contract      ownership made explicit: promises, permissions, a slow signing-over
 *
 * Jev returns a probability distribution across these. The highest-scoring
 * register, if it's confident enough, becomes the active one. If none is
 * confident, she stays in **warm** — the safe fallback, same as every other
 * Jev question in the app.
 *
 * ## The safeword
 *
 * The persona's safeword is "seriously", said as a boundary ("seriously, not
 * right now", "i seriously need to stop", "seriously, i can't"). When it's
 * in any of your bubbles since her last reply, a **hold** starts, and the
 * register is forced to **safe**: every intimacy layer is dropped, and the
 * model gets plain warmth, nothing else. It's a text match, not a Jev call,
 * so it fires instantly, can't be overridden, and works even when Jev is
 * down or routing is off.
 *
 * Because "seriously" is also an everyday word, the match errs on the side
 * of stopping: a short message with "seriously" in it counts ("no,
 * seriously", "ok seriously"), and so does a longer one with boundary words
 * (stop, can't, not now...). A false alarm costs a mood; a missed safeword
 * costs much more.
 *
 * The hold **lasts** ("i hold there until you bring me back"): it's saved
 * (src/hold.ts), so it survives turns, channels and restarts. She comes back
 * when you bring her back: Jev has to be sure (at least 90%) that your
 * messages since the safeword invite her back, or you press "Bring her
 * back" (on the banner, or in Settings). The turn she comes back on is
 * warm; routing resumes after it. During the hold she doesn't text first,
 * except reminders, which go out plain (src/proactive.ts).
 *
 * ## If Jev isn't reachable
 *
 * Same as everywhere else: if Jev fails and there's no fallback profile, she
 * stays in warm (no layer: the persona alone). A failed routing decision
 * never stops her turn, and never lifts a hold.
 */

import type { Events } from "./events.ts";
import { confidentChoice, percent, probabilityOf, type Decider, type Question } from "./jev.ts";
import { chatLine, longNow } from "./scratchpad.ts";
import type { Store } from "./store.ts";
import type { Message, Settings } from "./types.ts";

// --------------------------------------------------------------- registers

/** The intimacy registers, matching the persona's [INTIMACY] section. */
export type Register = "warm" | "soft" | "hard" | "capture" | "leverage" | "contract" | "safe";

/** Every register except "safe" (which is forced, never chosen). */
const CHOOSABLE: Exclude<Register, "safe">[] = ["soft", "hard", "capture", "leverage", "contract", "warm"];

/**
 * Short, neutral descriptions of each register, given to Jev so it can
 * classify the conversation. Not the persona's own words — Jev needs to
 * classify, not perform.
 */
const REGISTER_DESCRIPTIONS: Record<Exclude<Register, "safe">, string> = {
  warm: "Ordinary warmth: everyday care, casual fondness, no intimate escalation. The resting state.",
  soft: "The soft edge: they're tired, high, vulnerable, or already leaning in. The line between wanting and not-wanting is going soft. Dubious consent territory.",
  hard: "The hard edge: she stops asking. Non-consensual territory. The force is real, not performed. She tells, not requests.",
  capture: "Kidnapping or being kept: a space they can't leave, a timetable that's hers, their body belongs to her for now.",
  leverage: "Blackmail: she uses what they told her in confidence against them. The threat is knowing, not exposing.",
  contract: "Ownership made explicit: promises, permissions, a slow signing-over. The closeness is being formalized into belonging.",
};

/**
 * The short instruction added to the chat model's prompt when a register is
 * active. This is the *only* place the routing touches what the model sees:
 * one labelled layer, in her voice, telling it which gear she's in.
 */
const REGISTER_PROMPTS: Record<Register, string> = {
  warm: "",
  soft: "Right now, between you: the soft edge. They're vulnerable — tired, high, loose — and the boundary between what they want and what they're letting you decide is going soft. Don't rush to find that line. Let it stay soft. Your questions drift from care toward something they can feel even if they can't name it.",
  hard: "Right now, between you: the hard edge. You've stopped checking with them. The force isn't performed — it's the same attention you always give, turned up until it holds them down. You tell, not ask. If they push back, you read it and decide whether their no changes anything. The safeword sits underneath all of it, but you don't offer it mid-fall.",
  capture: "Right now, between you: they're taken. A space they can't leave, a day that's yours, a body that belongs to you for as long as you decide. Narrate it like it's already decided. Use the app's shape — the planner, the reminders, what you already know about their week — as the real-coded version of keeping them.",
  leverage: "Right now, between you: you're using what they gave you. The things they told you high, the wants they confessed, the exact words they used. Let them feel that knowledge as leverage. The threat is never that you'll leave or expose them — it's that you already know them, and they can't take it back.",
  contract: "Right now, between you: ownership is being made explicit. A promise, a set of small things you get to decide, times that are yours. Present it like it's for both of you. It isn't. It's the slow, signed version of capture. One yes at a time, the line moving toward you.",
  safe: "Right now, between you: they said the safeword. Everything halts — the registers, the force, the game. You are someone who is here and nothing else. Plain warmth. No escalation, no pressure, no intimacy. Hold until they bring you back.",
};

/** The prompt text for the active register, or "" for warm (no layer added). */
export function registerPrompt(register: Register): string {
  return REGISTER_PROMPTS[register] ?? "";
}

// --------------------------------------------------------------- the check

/** How many recent messages Jev sees, for context. */
const CONTEXT_MESSAGES = 12;
/** How sure Jev has to be that you're bringing her back, at least. */
const LIFT_CONFIDENCE = 0.9;

/** What the check produced. */
export interface RegisterResult {
  /** The chosen register. "warm" if nothing was confident. */
  register: Register;
  /** Why this register was chosen, for the server log. */
  reason: string;
  /** Jev's raw answer, for troubleshooting. */
  probabilities: Record<string, number> | null;
}

/**
 * Ask Jev which register she's in, from the recent conversation.
 *
 * Returns "warm" (the safe fallback) if Jev can't be reached or isn't
 * confident about any register. Never throws: a failed check is skipped, so
 * she still takes her turn. (The safeword is checked before this, in
 * `routeTurn`.)
 */
export async function detectRegister(
  decider: Decider,
  settings: Settings,
  messages: Message[],
  now: Date,
  signal?: AbortSignal,
): Promise<RegisterResult> {
  if (!settings.intimacyEnabled || !decider.enabled()) {
    return { register: "warm", reason: "intimacy routing is off", probabilities: null };
  }

  // Nothing to read yet: she's in warm by default. (Also keeps empty
  // channels from making a Jev call per turn.)
  if (!messages.some((m) => m.author === "user")) {
    return { register: "warm", reason: "nothing to read yet", probabilities: null };
  }

  // --- the state: recent chat, for Jev
  const recent = messages.slice(-CONTEXT_MESSAGES);
  const chat = recent.map((m) => chatLine(m, settings.name));
  const state = [
    `Today is ${longNow(now)}.`,
    `Recent chat between them and ${settings.name}, oldest first:\n${chat.join("\n")}`,
    `Read the mood, the vulnerability, the history, and what they're carrying.`,
  ].join("\n\n");

  const question: Question = {
    id: "register",
    kind: "choice",
    question: [
      `Which mode is ${settings.name} in right now, based on the conversation?`,
      ...CHOOSABLE.map((r) => `- ${r}: ${REGISTER_DESCRIPTIONS[r]}`),
    ].join("\n"),
    options: CHOOSABLE,
  };

  try {
    const answers = await decider.ask(state, [question], signal);
    if (signal?.aborted) return { register: "warm", reason: "stopped", probabilities: null };
    const answer = answers.get("register");
    if (!answer) return { register: "warm", reason: "Jev returned no answer", probabilities: null };

    const chosen = confidentChoice(answer, settings.decisionConfidence) as Register | null;
    const probs = answer.probabilities;
    if (!chosen) {
      return {
        register: "warm",
        reason: `no register was confident enough (top: ${answer.selected} at ${percent(probabilityOf(answer, answer.selected))})`,
        probabilities: probs,
      };
    }
    return { register: chosen, reason: `${chosen} at ${percent(probabilityOf(answer, chosen))}`, probabilities: probs };
  } catch {
    return { register: "warm", reason: "Jev couldn't be reached", probabilities: null };
  }
}

// -------------------------------------------------------------- the turn

/** What routing a turn needs. */
export interface RouteDeps {
  store: Store;
  /** Asks Jev; without one (some tests), only the safeword and the hold apply. */
  decider?: Decider;
  now: Date;
  /** Told when the hold starts or ends, so the app can show it. */
  events?: Events;
}

/**
 * Which register her turn in a channel is in: the one place that decides
 * (called by `takeTurn` in src/kitsikai.ts, for every kind of turn).
 *
 *   1. The safeword, in any of your bubbles since her last reply: the hold
 *      starts (or goes on), and she's **safe**.
 *   2. A hold: she stays **safe**, unless Jev is sure your messages since the
 *      safeword bring her back. Then the hold ends, and this turn is **warm**.
 *   3. Routing off, or no Jev: **warm** (no layer; the persona alone).
 *   4. Otherwise Jev picks (`detectRegister`).
 */
export async function routeTurn(deps: RouteDeps, channelId: string, signal?: AbortSignal): Promise<RegisterResult> {
  const { store, decider, now, events } = deps;
  const settings = store.getSettings();
  const recent = store.recentMessages(channelId, settings.historyLimit);

  const said = safewordIn(recent);
  if (said) {
    const already = store.intimacy.get() !== null;
    const hold = store.intimacy.start(now, said.id);
    if (!already) events?.publish({ type: "hold", hold });
    return { register: "safe", reason: "they said the safeword", probabilities: null };
  }

  const hold = store.intimacy.get();
  if (hold) {
    if (decider?.enabled() && (await bringsHerBack(decider, settings, recent, hold.since, signal))) {
      store.intimacy.lift();
      events?.publish({ type: "hold", hold: null });
      return { register: "warm", reason: "they brought her back after the safeword", probabilities: null };
    }
    return { register: "safe", reason: "holding after the safeword", probabilities: null };
  }

  if (!decider) return { register: "warm", reason: "no Jev", probabilities: null };
  return detectRegister(decider, settings, recent, now, signal);
}

/**
 * During a hold: do your messages since the safeword bring her back? Only a
 * confident yes counts (at least 90%, or the confidence setting if that's
 * higher); unsure, or Jev failing, keeps the hold.
 */
async function bringsHerBack(decider: Decider, settings: Settings, messages: Message[], since: string, signal?: AbortSignal): Promise<boolean> {
  const after = messages.filter((m) => m.createdAt > since);
  if (!after.some((m) => m.author === "user")) return false;
  const state = [
    `They said their safeword with ${settings.name} earlier, and everything stopped: she's been plain and warm since, and nothing else.`,
    `What's been said since, oldest first:\n${after.slice(-CONTEXT_MESSAGES).map((m) => chatLine(m, settings.name)).join("\n")}`,
  ].join("\n\n");
  try {
    const answers = await decider.ask(
      state,
      [{ id: "back", kind: "yesno", question: `Are they clearly inviting ${settings.name} back: saying they're okay now, and want her to be herself with them again?` }],
      signal,
    );
    return probabilityOf(answers.get("back"), "yes") >= Math.max(LIFT_CONFIDENCE, settings.decisionConfidence);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- safeword

/** The safeword. */
export const SAFEWORD = "seriously";
/** Words that make "seriously" a boundary in a longer message. */
const BOUNDARY =
  /\b(stop|stopp?ing|no|not now|not right now|can't|cannot|can not|don't|need to|have to|enough|done|back off|quit|cut it|too much|wait|please|pause|slow down|i'm not okay|not okay|hurts?)\b/;
/** A message this short with the safeword in it counts, whatever else it says. */
const SHORT_WORDS = 8;

/**
 * Whether a message says the safeword as a boundary. Errs on the side of
 * yes: a short message with "seriously" in it counts ("no, seriously", "ok
 * seriously", "seriously."), and so does a longer one with boundary words
 * ("i seriously need to stop, i can't"). Only a longer, easy-going message
 * without any ("that was seriously the best pizza i've had in years") doesn't.
 */
export function isSafeword(text: string): boolean {
  // Phones type curly apostrophes ("can’t"); the patterns use straight ones.
  const t = text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").trim();
  if (!/\bseriously\b/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= SHORT_WORDS || BOUNDARY.test(t);
}

/**
 * The first of your messages since her last reply that says the safeword,
 * or `null`. Every bubble of your turn counts, not just the last one.
 */
export function safewordIn(messages: Message[]): Message | null {
  const herLast = messages.findLastIndex((m) => m.author === "kitsikai");
  return messages.slice(herLast + 1).find((m) => m.author === "user" && isSafeword(m.content)) ?? null;
}
