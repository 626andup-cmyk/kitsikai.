/**
 * The binder, in words: how plans, work and stickers are described to her.
 *
 * The binder (DESIGN.md) is everything she knows about your life: plans,
 * trackers and log entries. The model reads text, not database rows, so
 * this file turns them into short, clear lines, used in two places:
 *
 *   - the prompt's "Today and tomorrow" section, always in view (stage 6)
 *   - the results of her lookup tools (src/tools.ts), for anything further
 *
 * Keeping the wording in one place means she sees a plan described the same
 * way whether it's in view or looked up.
 */

import { addDays, dateOf, shortTime, toMoment, type LocalDate } from "./dates.ts";
import { formatClock } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { LogEntry, Occurrence, Tracker } from "./types.ts";

const KIND_NAMES: Record<string, string> = {
  shift: "Shift",
  appointment: "Appointment",
  birthday: "Birthday",
  hangout: "Hangout",
  other: "Plan",
};

const SHIFT_NAMES: Record<string, string> = {
  regular: "shift",
  meeting: "meeting",
  oncall: "on call",
};

/** "Sat Sep 26" */
export function dayName(date: LocalDate): string {
  return toMoment(date, "12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "4h", "4h 30m" */
function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * One occurrence of a plan, in a line:
 *
 *   Work (shift) 9:00a–5:30p, 8h 30m, draw 10:00a–2:00p (4h)
 *   Appointment: Dentist, 3:00p (not confirmed yet)
 *   Birthday: Mia, all day, every year
 *
 * @param today  When given, an occurrence that started on another day says so.
 */
export function describeOccurrence(o: Occurrence, today?: LocalDate): string {
  const { plan } = o;
  const time = o.startTime ? (o.endTime ? `${shortTime(o.startTime)}–${shortTime(o.endTime)}` : shortTime(o.startTime)) : "all day";
  const parts: string[] = [];
  if (plan.kind === "shift") {
    parts.push(`${plan.title} (${SHIFT_NAMES[plan.shiftType ?? "regular"]}) ${time}`);
    if (o.shiftMinutes) parts.push(hours(o.shiftMinutes));
    if (plan.shiftType === "regular") {
      parts.push(plan.drawStart && plan.drawEnd ? `draw ${shortTime(plan.drawStart)}–${shortTime(plan.drawEnd)} (${hours(o.drawMinutes ?? 0)})` : "no draw hours");
    }
    if (plan.shiftType === "oncall") parts.push("free unless they get called in");
  } else {
    parts.push(`${KIND_NAMES[plan.kind]}: ${plan.title}, ${time}`);
  }
  let line = parts.join(", ");
  if (today && o.date !== today) line += ` (started ${dayName(o.date)})`;
  if (o.endDate && o.endDate !== o.date && !plan.startTime) line += `, until ${dayName(o.endDate)}`;
  if (plan.repeats !== "never") line += `, every ${plan.repeats === "weekly" ? "week" : "year"}`;
  if (!plan.checked) line += " (not confirmed yet)";
  if (plan.notes) line += `. Notes: ${plan.notes}`;
  return line;
}

/**
 * Whether you're at work right now, in words, or `null` if not. Regular
 * shifts and meetings count; on-call only once you're called in (stage 8).
 */
export function workStatus(store: Store, now: Date, calledIn?: Set<string>): string | null {
  const today = dateOf(now);
  const block = store.plans
    .workBlocks(today, today, { calledIn })
    .find((b) => b.start <= now && now < b.end);
  if (block) return `They're at work right now, until ${formatClock(block.end)}.`;
  const onCall = store.plans
    .occurrences(addDays(today, -1), today, { calledIn })
    .find((o) => o.plan.shiftType === "oncall" && !o.busy && o.startTime && o.endDate && o.endTime && toMoment(o.date, o.startTime) <= now && now < toMoment(o.endDate, o.endTime));
  if (onCall) return `They're on call until ${formatClock(toMoment(onCall.endDate!, onCall.endTime!))}: free unless they get called in.`;
  return null;
}

/**
 * The prompt's "Today and tomorrow": every plan for both days, and whether
 * you're at work now. Always in view, so she never has to look these up.
 */
export function todayAndTomorrow(store: Store, now: Date, calledIn?: Set<string>): string {
  const today = dateOf(now);
  const tomorrow = addDays(today, 1);
  const occurrences = store.plans.occurrences(today, tomorrow, { calledIn });
  const day = (date: LocalDate, label: string) => {
    // An overnight shift from yesterday still counts today.
    const onDay = occurrences.filter((o) => o.date === date || (o.date < date && (o.endDate ?? o.date) >= date && date === today));
    const lines = onDay.map((o) => `- ${describeOccurrence(o, date)}`);
    return [`${label}, ${dayName(date)}:`, ...(lines.length ? lines : ["- Nothing planned."])].join("\n");
  };
  const status = workStatus(store, now, calledIn);
  return [day(today, "Today"), day(tomorrow, "Tomorrow"), ...(status ? [status] : [])].join("\n");
}

/** A sticker, in a line: "Sat Sep 26: headache 6/10". */
export function describeEntry(entry: LogEntry, tracker: Tracker | undefined): string {
  const value =
    tracker?.kind === "yesno" ? (entry.value === "yes" ? "yes" : "no") : tracker?.kind === "scale" ? `${entry.value}/10` : `"${entry.value}"`;
  return `${dayName(entry.date)}: ${tracker?.name ?? "?"} ${value}`;
}

/** What each way a sticker got there means, for her. */
export const SOURCE_WORDS: Record<LogEntry["source"], string> = {
  user: "they logged it",
  processing: "you noted it from chat",
  confirmed: "you asked and they confirmed",
};
