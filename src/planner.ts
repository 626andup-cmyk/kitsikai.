/**
 * The planner: plans, shifts, repeats and reminders (stage 3).
 *
 * A **plan** is anything planned, on a day, maybe at a time. Shifts and
 * events are the same record with different kinds (see `Plan` in
 * src/types.ts). This file has two halves:
 *
 *   1. Pure functions that work things out from plans: when a repeating plan
 *      happens (`occurrencesOf`), a shift's hours and draw time
 *      (`shiftFacts`), stretches of work (`workBlocks`), when reminders go
 *      off (`reminderTimes`), and week totals (`weekSummary`). "Pure" means
 *      they only look at what they're given and return an answer: no
 *      database, no clock. That makes them easy to test with any date.
 *   2. The `Plans` class, which reads and writes plans in the database and
 *      uses those functions to answer the app's questions.
 *
 * Nothing calculated is ever stored. Draw time, shift hours and reminder
 * times are worked out every time they're shown, so they can never disagree
 * with the plan.
 */

import type { Database } from "bun:sqlite";
import {
  addDays,
  addMinutes,
  dateOf,
  daysBetween,
  isDate,
  isTime,
  minutesBetween,
  sameDayInYear,
  timeOf,
  toMoment,
  type LocalDate,
} from "./dates.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Occurrence, OvernightStay, Plan, PlanKind, PlanSource, ReminderId, ReminderTime, Repeats, ShiftType, WorkBlock } from "./types.ts";

// --------------------------------------------------------------- choices

export const PLAN_KINDS: PlanKind[] = ["shift", "appointment", "birthday", "hangout", "other"];
export const SHIFT_TYPES: ShiftType[] = ["regular", "meeting", "oncall"];
export const REPEATS: Repeats[] = ["never", "weekly", "yearly"];
export const PLAN_SOURCES: PlanSource[] = ["manual", "screenshot", "chat"];
export const REMINDER_IDS: ReminderId[] = ["week-before", "day-before", "morning-of", "2h-before"];

/** How each reminder is described. */
export const REMINDER_LABELS: Record<ReminderId, string> = {
  "week-before": "A week before",
  "day-before": "Day before",
  "morning-of": "Morning of",
  "2h-before": "2 hours before",
};

/**
 * Each kind's reminders, unless a plan has its own. Shifts have none: she
 * just knows your schedule and uses it naturally.
 */
export const DEFAULT_REMINDERS: Record<PlanKind, ReminderId[]> = {
  appointment: ["day-before", "2h-before"],
  birthday: ["week-before", "morning-of"],
  hangout: ["morning-of"],
  other: ["day-before"],
  shift: [],
};

/** The clock times reminders use. */
export const REMINDER_CLOCK = {
  /** "A week before", at midday. */
  weekBefore: "12:00",
  /** "Day before", in the evening. */
  dayBefore: "18:00",
  /** "Morning of" (and "2 hours before" for all-day plans). */
  morning: "09:00",
};

/** A reminder that would land during work moves to this many minutes before the work starts. */
export const DODGE_MINUTES = 30;

// ------------------------------------------------------------ validation

/** A plan's editable fields. */
export type PlanInput = Omit<Plan, "id" | "createdAt" | "updatedAt">;

function choice<T extends string>(value: unknown, options: T[], field: string): T {
  if (!options.includes(value as T)) throw new ValidationError(`${field} must be one of: ${options.join(", ")}`);
  return value as T;
}

function optionalTime(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isTime(value)) throw new ValidationError(`${field} must be a time like 09:30`);
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isDate(value)) throw new ValidationError(`${field} must be a date like 2026-09-28`);
  return value;
}

/**
 * Check a whole plan, as it would be saved. Fields that don't apply are
 * cleared (a birthday has no shift type; a meeting has no draw hours), and
 * an end time without an end date gets one: the same day, or the next day
 * if the end time is earlier than the start (an overnight shift).
 */
export function validatePlan(input: Record<string, unknown>): PlanInput {
  const kind = choice(input.kind, PLAN_KINDS, "kind");
  if (typeof input.title !== "string" || input.title.trim() === "") throw new ValidationError("A plan needs a title.");
  if (input.title.trim().length > 200) throw new ValidationError("The title is too long.");
  if (!isDate(input.startDate)) throw new ValidationError("startDate must be a date like 2026-09-28");
  const startDate = input.startDate;
  const startTime = optionalTime(input.startTime, "startTime");
  let endTime = optionalTime(input.endTime, "endTime");
  let endDate = optionalDate(input.endDate, "endDate");

  if (startTime === null) {
    // All day: it can last several days, but has no times.
    if (endTime !== null) throw new ValidationError("An all-day plan can't have an end time.");
    if (endDate !== null && endDate < startDate) throw new ValidationError("A plan can't end before it starts.");
  } else if (endTime !== null || endDate !== null) {
    if (endTime === null) throw new ValidationError("An end date needs an end time.");
    endDate ??= endTime > startTime ? startDate : addDays(startDate, 1);
    if (toMoment(endDate, endTime).getTime() <= toMoment(startDate, startTime).getTime()) {
      throw new ValidationError("A plan has to end after it starts.");
    }
  }

  const isShift = kind === "shift";
  const shiftType = isShift ? choice(input.shiftType ?? "regular", SHIFT_TYPES, "shiftType") : null;
  if (isShift && (startTime === null || endTime === null)) {
    throw new ValidationError("A shift needs a start and an end time.");
  }
  let drawStart = shiftType === "regular" ? optionalTime(input.drawStart, "drawStart") : null;
  let drawEnd = shiftType === "regular" ? optionalTime(input.drawEnd, "drawEnd") : null;
  if ((drawStart === null) !== (drawEnd === null)) throw new ValidationError("Draw hours need a start and an end.");

  let reminders: ReminderId[] | null = null;
  if (input.reminders !== null && input.reminders !== undefined) {
    if (!Array.isArray(input.reminders)) throw new ValidationError("reminders must be a list, or null for the default");
    reminders = [...new Set(input.reminders.map((r) => choice(r, REMINDER_IDS, "reminders")))];
    // Keep them in their natural order.
    reminders.sort((a, b) => REMINDER_IDS.indexOf(a) - REMINDER_IDS.indexOf(b));
  }

  if (input.checked !== undefined && typeof input.checked !== "boolean") throw new ValidationError("checked must be true or false");
  if (input.overnight !== undefined && typeof input.overnight !== "boolean") throw new ValidationError("overnight must be true or false");
  if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2000)) {
    throw new ValidationError("notes must be text of 2000 characters at most");
  }
  endTime = startTime === null ? null : endTime;
  if (drawStart === null) drawEnd = null;
  if (drawEnd === null) drawStart = null;

  return {
    kind,
    title: input.title.trim(),
    startDate,
    startTime,
    endDate,
    endTime,
    repeats: choice(input.repeats ?? "never", REPEATS, "repeats"),
    reminders,
    checked: input.checked === true,
    shiftType,
    drawStart,
    drawEnd,
    // Only shifts link to the next one.
    overnight: isShift && input.overnight === true,
    notes: typeof input.notes === "string" ? input.notes : "",
    source: choice(input.source ?? "manual", PLAN_SOURCES, "source"),
  };
}

// ----------------------------------------------------------- occurrences

/** A plan's start and end on one date it happens. */
export interface Timing {
  date: LocalDate;
  startTime: string | null;
  endDate: LocalDate | null;
  endTime: string | null;
}

/**
 * Every date a plan happens that overlaps `from`–`to` (inclusive):
 * once, every week on the same weekday, or every year on the same day.
 * A repeating plan's end moves with it, keeping the same length.
 */
export function occurrencesOf(plan: Plan, from: LocalDate, to: LocalDate): Timing[] {
  const span = plan.endDate ? daysBetween(plan.startDate, plan.endDate) : 0;
  const starts: LocalDate[] = [];
  if (plan.repeats === "never") {
    starts.push(plan.startDate);
  } else if (plan.repeats === "weekly") {
    // Skip straight to the first week that could overlap the range.
    const firstWeek = Math.max(0, Math.ceil((daysBetween(plan.startDate, from) - span) / 7));
    for (let week = firstWeek; ; week++) {
      const date = addDays(plan.startDate, week * 7);
      if (date > to) break;
      starts.push(date);
    }
  } else {
    const firstYear = Math.max(Number(plan.startDate.slice(0, 4)), Number(from.slice(0, 4)) - 1);
    for (let year = firstYear; year <= Number(to.slice(0, 4)); year++) {
      const date = sameDayInYear(plan.startDate, year);
      if (date >= plan.startDate) starts.push(date);
    }
  }

  return starts
    .map((date) => {
      const shift = daysBetween(plan.startDate, date);
      return {
        date,
        startTime: plan.startTime,
        endDate: plan.endDate ? addDays(plan.endDate, shift) : null,
        endTime: plan.endTime,
      };
    })
    .filter((t) => t.date <= to && (t.endDate ?? t.date) >= from);
}

/** The real start and end of an occurrence (a plan with no end ends when it starts, or at the end of an all-day date). */
export function momentsOf(t: Timing): { start: Date; end: Date } {
  const start = toMoment(t.date, t.startTime);
  if (t.startTime === null) return { start, end: toMoment(addDays(t.endDate ?? t.date, 1)) };
  return { start, end: t.endDate && t.endTime ? toMoment(t.endDate, t.endTime) : start };
}

/**
 * A shift's hours and draw time, worked out from the shift and draw hours.
 *
 * Draw hours are written as times without dates, so their dates come from
 * the shift: a draw starting at 02:00 during a shift from 22:00 to 06:00 is
 * the next morning. The draw ends at the next time its end comes round
 * after it starts.
 */
export function shiftFacts(plan: Plan, t: Timing): { shiftMinutes: number | null; drawMinutes: number | null; draw: { start: Date; end: Date } | null } {
  if (plan.kind !== "shift" || !t.startTime || !t.endDate || !t.endTime) return { shiftMinutes: null, drawMinutes: null, draw: null };
  const { start, end } = momentsOf(t);
  const shiftMinutes = minutesBetween(start, end);
  if (plan.shiftType !== "regular" || !plan.drawStart || !plan.drawEnd) return { shiftMinutes, drawMinutes: null, draw: null };

  let drawStart = toMoment(t.date, plan.drawStart);
  // An overnight shift's draw can start after midnight.
  const nextDay = toMoment(addDays(t.date, 1), plan.drawStart);
  if (drawStart < start && nextDay <= end) drawStart = nextDay;
  let drawEnd = toMoment(dateOf(drawStart), plan.drawEnd);
  if (drawEnd < drawStart) drawEnd = toMoment(addDays(dateOf(drawStart), 1), plan.drawEnd);
  return { shiftMinutes, drawMinutes: minutesBetween(drawStart, drawEnd), draw: { start: drawStart, end: drawEnd } };
}

/**
 * Whether an occurrence counts as busy: regular shifts and meetings always,
 * on-call only when you've been called in (from stage 8).
 */
export function countsAsBusy(plan: Plan, key: string, calledIn: Set<string>): boolean {
  if (plan.kind !== "shift") return false;
  return plan.shiftType === "oncall" ? calledIn.has(key) : true;
}

/**
 * Stretches of work. Busy shifts that touch or overlap (one ends as the next
 * begins, like a double-booked day) merge into one block, which matters for
 * "how'd it go?" check-ins and for reminders dodging work.
 */
export function workBlocks(shifts: { key: string; start: Date; end: Date }[]): WorkBlock[] {
  const sorted = [...shifts].sort((a, b) => a.start.getTime() - b.start.getTime());
  const blocks: WorkBlock[] = [];
  for (const shift of sorted) {
    const last = blocks.at(-1);
    if (last && shift.start.getTime() <= last.end.getTime()) {
      if (shift.end > last.end) last.end = shift.end;
      last.keys.push(shift.key);
    } else {
      blocks.push({ start: shift.start, end: shift.end, keys: [shift.key] });
    }
  }
  return blocks;
}

/** When one reminder goes off, before dodging work. */
export function reminderMoment(id: ReminderId, t: Timing): Date {
  const start = t.startTime ? toMoment(t.date, t.startTime) : null;
  switch (id) {
    case "week-before":
      return toMoment(addDays(t.date, -7), REMINDER_CLOCK.weekBefore);
    case "day-before":
      return toMoment(addDays(t.date, -1), REMINDER_CLOCK.dayBefore);
    case "morning-of": {
      // In the morning, but at least an hour before an early start.
      const morning = toMoment(t.date, REMINDER_CLOCK.morning);
      return start && addMinutes(start, -60) < morning ? addMinutes(start, -60) : morning;
    }
    case "2h-before":
      return start ? addMinutes(start, -120) : toMoment(t.date, REMINDER_CLOCK.morning);
  }
}

/**
 * When an occurrence's reminders go off. A reminder that would land during
 * a work block moves to shortly before it ("reminders dodge work").
 *
 * @param blocks  Work blocks around the reminders (see `workBlocks`).
 * @param ownKey  The occurrence's own key: a shift's reminder never dodges
 *                the shift it's about.
 */
export function reminderTimes(ids: ReminderId[], t: Timing, blocks: WorkBlock[], ownKey: string): ReminderTime[] {
  return ids.map((id) => {
    let at = reminderMoment(id, t);
    let dodged = false;
    // Moving before one block could land in an earlier one, so check again.
    for (let tries = 0; tries < 10; tries++) {
      const block = blocks.find((b) => !b.keys.includes(ownKey) && b.start <= at && at < b.end);
      if (!block) break;
      at = addMinutes(block.start, -DODGE_MINUTES);
      dodged = true;
    }
    return { id, label: REMINDER_LABELS[id], date: dateOf(at), time: timeOf(at), dodged };
  });
}

/** A linked shift starts within this many hours after an "overnight" shift ends. */
export const LINK_HOURS = 48;

/**
 * The hotel night after an "overnight" shift: until the next shift that
 * starts within two days of it ending (the one it's linked to). Two or more
 * linked shifts are a chain: each but the last is marked overnight.
 */
export function overnightStay(key: string, t: Timing, all: { plan: Plan; t: Timing; key: string }[]): OvernightStay {
  const end = momentsOf(t).end;
  const next = all
    .filter((o) => o.plan.kind === "shift" && o.key !== key)
    .map((o) => ({ key: o.key, t: o.t, start: momentsOf(o.t).start }))
    .filter((o) => o.start >= end && o.start.getTime() - end.getTime() <= LINK_HOURS * 3600_000)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  return next ? { nextKey: next.key, nextDate: next.t.date, nextTime: next.t.startTime } : { nextKey: null, nextDate: null, nextTime: null };
}

/** A day of the weekly list. */
export interface WeekDay {
  date: LocalDate;
  occurrences: Occurrence[];
  /** More than one shift that day (double-booked): the list shows day totals. */
  doubleBooked: boolean;
  shiftMinutes: number;
  drawMinutes: number;
}

/** The weekly list: Monday to Sunday, with totals. */
export interface WeekSummary {
  monday: LocalDate;
  days: WeekDay[];
  totals: {
    /** Regular shifts and meetings. */
    shiftMinutes: number;
    drawMinutes: number;
    /**
     * On-call windows, kept apart: on-call is free unless you're called in,
     * so it isn't counted in the shift hours. (An open question in
     * DESIGN.md; showing it separately answers it both ways.)
     */
    onCallMinutes: number;
  };
}

/** Group a week's occurrences by day, with day and week totals. */
export function weekSummary(monday: LocalDate, occurrences: Occurrence[]): WeekSummary {
  const days: WeekDay[] = [];
  const totals = { shiftMinutes: 0, drawMinutes: 0, onCallMinutes: 0 };
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const today = occurrences.filter((o) => o.date === date);
    const shifts = today.filter((o) => o.plan.kind === "shift");
    const working = shifts.filter((o) => o.plan.shiftType !== "oncall");
    const day: WeekDay = {
      date,
      occurrences: today,
      doubleBooked: shifts.length > 1,
      shiftMinutes: working.reduce((sum, o) => sum + (o.shiftMinutes ?? 0), 0),
      drawMinutes: working.reduce((sum, o) => sum + (o.drawMinutes ?? 0), 0),
    };
    totals.shiftMinutes += day.shiftMinutes;
    totals.drawMinutes += day.drawMinutes;
    totals.onCallMinutes += shifts.filter((o) => o.plan.shiftType === "oncall").reduce((sum, o) => sum + (o.shiftMinutes ?? 0), 0);
    days.push(day);
  }
  return { monday, days, totals };
}

// -------------------------------------------------------------- database

interface PlanRow {
  id: string;
  kind: PlanKind;
  title: string;
  start_date: string;
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  repeats: Repeats;
  reminders: string | null;
  checked: number;
  shift_type: ShiftType | null;
  draw_start: string | null;
  draw_end: string | null;
  overnight: number;
  notes: string;
  source: PlanSource;
  created_at: string;
  updated_at: string;
}

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    startDate: row.start_date,
    startTime: row.start_time,
    endDate: row.end_date,
    endTime: row.end_time,
    repeats: row.repeats,
    reminders: row.reminders === null ? null : (JSON.parse(row.reminders) as ReminderId[]),
    checked: row.checked === 1,
    shiftType: row.shift_type,
    drawStart: row.draw_start,
    drawEnd: row.draw_end,
    overnight: row.overnight === 1,
    notes: row.notes,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Options for working out occurrences. */
export interface OccurrenceOptions {
  /** On-call occurrences you've been called in to (stage 8), by key. */
  calledIn?: Set<string>;
}

/** Plans in the database, and the questions the app asks about them. */
export class Plans {
  constructor(private readonly db: Database) {}

  /** Every plan, by start date. */
  list(): Plan[] {
    return (this.db.query("SELECT * FROM plans ORDER BY start_date, start_time").all() as PlanRow[]).map(toPlan);
  }

  get(id: string): Plan {
    const row = this.db.query("SELECT * FROM plans WHERE id = $id").get({ id }) as PlanRow | null;
    if (!row) throw new NotFoundError("plan");
    return toPlan(row);
  }

  create(input: Record<string, unknown>): Plan {
    const clean = validatePlan(input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO plans (id, kind, title, start_date, start_time, end_date, end_time, repeats, reminders, checked,
                            shift_type, draw_start, draw_end, overnight, notes, source, created_at, updated_at)
         VALUES ($id, $kind, $title, $startDate, $startTime, $endDate, $endTime, $repeats, $reminders, $checked,
                 $shiftType, $drawStart, $drawEnd, $overnight, $notes, $source, $now, $now)`,
      )
      .run({ id, now, ...row(clean) });
    return this.get(id);
  }

  /** Change a plan. The result is checked as a whole, as if it were new. */
  update(id: string, input: Record<string, unknown>): Plan {
    const current = this.get(id);
    const clean = validatePlan({ ...current, ...input });
    this.db
      .query(
        `UPDATE plans SET kind = $kind, title = $title, start_date = $startDate, start_time = $startTime,
                end_date = $endDate, end_time = $endTime, repeats = $repeats, reminders = $reminders,
                checked = $checked, shift_type = $shiftType, draw_start = $drawStart, draw_end = $drawEnd,
                overnight = $overnight, notes = $notes, source = $source, updated_at = $now
          WHERE id = $id`,
      )
      .run({ id, now: new Date().toISOString(), ...row(clean) });
    return this.get(id);
  }

  delete(id: string): void {
    const result = this.db.query("DELETE FROM plans WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("plan");
  }

  /**
   * Every occurrence overlapping `from`–`to`, in time order, with its shift
   * hours, draw time and reminder times worked out.
   */
  occurrences(from: LocalDate, to: LocalDate, options: OccurrenceOptions = {}): Occurrence[] {
    const calledIn = options.calledIn ?? new Set<string>();
    const plans = this.list();
    // Reminders can be a week ahead of their plan, and dodge work the day
    // before, so work blocks are found over a wider stretch.
    const wide = { from: addDays(from, -2), to: addDays(to, 8) };
    const expanded = plans.flatMap((plan) =>
      occurrencesOf(plan, wide.from, wide.to).map((t) => ({ plan, t, key: `${plan.id}:${t.date}` })),
    );
    const blocks = workBlocks(
      expanded
        .filter(({ plan, key }) => countsAsBusy(plan, key, calledIn))
        .map(({ t, key }) => ({ key, ...momentsOf(t) })),
    );

    return expanded
      .filter(({ t }) => t.date <= to && (t.endDate ?? t.date) >= from)
      .map(({ plan, t, key }) => {
        const facts = shiftFacts(plan, t);
        return {
          key,
          plan,
          date: t.date,
          startTime: t.startTime,
          endDate: t.endDate,
          endTime: t.endTime,
          shiftMinutes: facts.shiftMinutes,
          drawMinutes: facts.drawMinutes,
          busy: countsAsBusy(plan, key, calledIn),
          reminders: reminderTimes(plan.reminders ?? DEFAULT_REMINDERS[plan.kind], t, blocks, key),
          stay: plan.overnight ? overnightStay(key, t, expanded) : null,
        };
      })
      .sort((a, b) => (a.date + (a.startTime ?? "")).localeCompare(b.date + (b.startTime ?? "")));
  }

  /** The work blocks overlapping `from`–`to`. */
  workBlocks(from: LocalDate, to: LocalDate, options: OccurrenceOptions = {}): WorkBlock[] {
    const calledIn = options.calledIn ?? new Set<string>();
    return workBlocks(
      this.list().flatMap((plan) =>
        occurrencesOf(plan, addDays(from, -1), to)
          .map((t) => ({ plan, t, key: `${plan.id}:${t.date}` }))
          .filter(({ key }) => countsAsBusy(plan, key, calledIn))
          .map(({ t, key }) => ({ key, ...momentsOf(t) })),
      ),
    );
  }

  /** The weekly list for the week starting on `monday`. */
  week(monday: LocalDate, options: OccurrenceOptions = {}): WeekSummary {
    return weekSummary(monday, this.occurrences(monday, addDays(monday, 6), options));
  }
}

/** A clean plan's fields as named query parameters. */
function row(clean: PlanInput) {
  return {
    ...clean,
    reminders: clean.reminders === null ? null : JSON.stringify(clean.reminders),
    checked: clean.checked ? 1 : 0,
    overnight: clean.overnight ? 1 : 0,
  };
}
