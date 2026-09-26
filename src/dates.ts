/**
 * Dates and times, the planner's way.
 *
 * All times in Kitsikai are the **phone's local time** (the server runs on
 * the phone, so its clock is the phone's clock). So the planner never stores
 * a moment in time like "2026-09-28T13:00:00Z" (which means different
 * clock times in different time zones). It stores what you'd write on a
 * paper calendar:
 *
 *   a date     "2026-09-28"   (a `LocalDate`: year-month-day)
 *   a time     "13:00"        (a `LocalTime`: 24-hour hours:minutes)
 *
 * Text in these shapes sorts correctly as text ("2026-09-28" < "2026-10-01"),
 * which keeps comparisons simple.
 *
 * When a real moment is needed (to compare with "now", or to count the hours
 * between two times), `toMoment` turns a date and time into a JavaScript
 * `Date` using the local time zone.
 *
 * ## Overnight ranges
 *
 * A shift from 10 PM to 6 AM ends the day after it starts. That's why a
 * plan's end has **its own date**: "2026-09-28 22:00" to "2026-09-29 06:00".
 * Durations are always worked out from full moments, never by subtracting
 * clock times, so they're right across midnight (and across daylight saving
 * changes, when a night can be 7 or 9 hours long).
 */

/** "2026-09-28" */
export type LocalDate = string;
/** "13:05" (24-hour) */
export type LocalTime = string;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether text is a real date like "2026-09-28" (not "2026-02-30"). */
export function isDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  const match = value.match(DATE);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Whether text is a time like "09:30" or "22:00". */
export function isTime(value: unknown): value is LocalTime {
  return typeof value === "string" && TIME.test(value);
}

/** Two digits: 7 → "07". */
const pad = (n: number) => String(n).padStart(2, "0");

/** The local date of a moment: "2026-09-28". */
export function dateOf(moment: Date): LocalDate {
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** The local time of a moment: "13:05". */
export function timeOf(moment: Date): LocalTime {
  return `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

/** The parts of a date, as numbers. */
function parts(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

/** A date and time as a real moment, in local time. No time means midnight. */
export function toMoment(date: LocalDate, time: LocalTime | null = null): Date {
  const [y, m, d] = parts(date);
  const [hh, mm] = time ? (time.split(":").map(Number) as [number, number]) : [0, 0];
  return new Date(y, m - 1, d, hh, mm);
}

/** The date `days` days after (or before, if negative) another. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parts(date);
  // Built at noon, so a daylight saving change can't push it into another day.
  return dateOf(new Date(y, m - 1, d + days, 12));
}

/** Whole days from one date to another (negative if `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((toMoment(to, "12:00").getTime() - toMoment(from, "12:00").getTime()) / 86_400_000);
}

/** Day of the week: 0 is Sunday, 1 is Monday, ... 6 is Saturday. */
export function weekday(date: LocalDate): number {
  return toMoment(date, "12:00").getDay();
}

/** The Monday of the week a date is in. Weeks run Monday to Sunday. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** Minutes between two moments. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/** A moment `minutes` minutes later (or earlier). */
export function addMinutes(moment: Date, minutes: number): Date {
  return new Date(moment.getTime() + minutes * 60_000);
}

/**
 * The next time a clock time comes round, at or after a moment. Used for
 * times written without a date, like a regular shift's draw hours: a draw
 * starting "02:00" during a shift that began at 22:00 is 2 AM the next day.
 */
export function nextAtOrAfter(after: Date, time: LocalTime): Date {
  const sameDay = toMoment(dateOf(after), time);
  return sameDay.getTime() >= after.getTime() ? sameDay : toMoment(addDays(dateOf(after), 1), time);
}

/** Whether a year has a February 29th. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The same month and day in another year. February 29th becomes February
 * 28th in years that don't have one (a leap-day birthday still comes round).
 */
export function sameDayInYear(date: LocalDate, year: number): LocalDate {
  const [, m, d] = parts(date);
  const day = m === 2 && d === 29 && !isLeapYear(year) ? 28 : d;
  return `${year}-${pad(m)}-${pad(day)}`;
}

/** "9:00a", "5:30p", like a work schedule. */
export function shortTime(time: LocalTime): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${pad(m)}${h < 12 ? "a" : "p"}`;
}

/** "4h", "4h 30m", "45m": a length of time, for draw time and totals. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Mon 9/28", like the job's scheduling program. */
export function shortDate(date: LocalDate): string {
  const [, m, d] = parts(date);
  const day = toMoment(date, "12:00").toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${m}/${d}`;
}
