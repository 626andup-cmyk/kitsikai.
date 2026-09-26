/**
 * Screenshot import (stage 4): reading your work schedule from a picture.
 *
 * 1. You pick a screenshot of the job's scheduling program.
 * 2. The **screenshot-reading profile** (a vision model, one that can read
 *    images, like Gemini Flash) is asked to list every shift in it, as
 *    JSON: structured output instead of prose (`readSchedule`).
 * 3. Whatever comes back is tidied into rows (`parseScheduleReply`):
 *    "9:00a" and "9 AM" both become "09:00", "Mon 9/28" becomes a real date
 *    with the year that's closest to today.
 * 4. The rows are **checked** (`checkRows`): the calculated values (shift
 *    hours, draw time) are worked out, and anything that looks wrong gets a
 *    ⚠️ warning. Warnings never block: they're there to make you look twice.
 * 5. You fix anything in the review list (each edit is checked again), and
 *    "Looks good, save" turns the rows into checked shift plans
 *    (`saveRows`).
 *
 * The screenshot itself isn't kept: it stays in the browser, beside the
 * review list, until you're done.
 *
 * The new concepts are **image input** (sending a picture to a model),
 * **structured output** (asking for data, not text), and **validation**
 * (deciding what's wrong, what's suspicious, and what's fine).
 */

import { addDays, daysBetween, isDate, isTime, toMoment, weekday, type LocalDate } from "./dates.ts";
import { ValidationError } from "./errors.ts";
import { extractJson, JsonReplyError } from "./json.ts";
import { profileRequest } from "./kitsikai.ts";
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { LINK_HOURS, momentsOf, shiftFacts, SHIFT_TYPES } from "./planner.ts";
import { describeNow } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { CheckedRow, Plan, Profile, ScreenshotRow, ShiftType } from "./types.ts";

/** The picture types a screenshot can be. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** The biggest screenshot accepted, as base64 text (about 10 MB of image). */
export const MAX_IMAGE_BASE64 = 14_000_000;

/** A shift longer than this, or shorter than that (in minutes), is probably misread. */
const LONGEST_SHIFT = 16 * 60;
const SHORTEST_SHIFT = 30;
/** A date more than this many days from today is probably a misread year. */
const FARTHEST_DAYS = 45;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --------------------------------------------------------------- reading

/** What the vision model is asked to do. */
export function schedulePrompt(now: Date): string {
  return `You read screenshots of work schedules and list every shift in them, exactly as shown.

${describeNow(now)} Dates shown without a year are the ones closest to today.

Reply with JSON only, no other text, in this shape:

{"shifts": [{"weekday": "Mon", "date": "2026-09-28", "type": "regular", "start": "09:00", "end": "17:30", "drawStart": "10:00", "drawEnd": "14:00"}]}

- "weekday": the day of the week as written on the screenshot.
- "date": the date as YYYY-MM-DD.
- "type": "regular" for a normal shift, "meeting" for a meeting or training, "oncall" for on-call.
- "start", "end": the shift hours, 24-hour HH:MM.
- "drawStart", "drawEnd": the draw hours, if the shift shows them, otherwise null.
- A day with two shifts gets two entries. Days off get none.
- If you can't read something, use null rather than guessing.`;
}

/**
 * Ask the screenshot-reading profile to read a schedule.
 *
 * @param image  The picture: its base64 bytes and its type ("image/png").
 * @throws ApiError if the request fails, or the reply isn't readable.
 */
export async function readSchedule(
  api: ApiOptions,
  profile: Profile,
  image: { data: string; mimeType: string },
  now: Date,
): Promise<ScreenshotRow[]> {
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: schedulePrompt(now) },
      {
        role: "user",
        content: [
          { type: "text", text: "Here's my schedule. List every shift." },
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
        ],
      },
    ],
  });
  try {
    return parseScheduleReply(extractJson(response.content), now);
  } catch (error) {
    if (error instanceof JsonReplyError || error instanceof ValidationError) {
      throw new ApiError(
        `${profile.name} didn't send back a list of shifts. Is it a vision model? Its reply began: "${response.content.slice(0, 160)}"`,
      );
    }
    throw error;
  }
}

/**
 * Turn the model's JSON into rows, tidying what it wrote: times and dates in
 * several shapes, and shift types in several words.
 */
export function parseScheduleReply(json: unknown, now: Date): ScreenshotRow[] {
  const list = Array.isArray(json) ? json : (json as { shifts?: unknown })?.shifts;
  if (!Array.isArray(list)) throw new ValidationError("The reply has no list of shifts.");
  const today = localToday(now);
  return list
    .filter((item) => typeof item === "object" && item !== null)
    .map((item: Record<string, unknown>) => ({
      date: normalizeDate(item.date, today),
      shiftType: normalizeShiftType(item.type ?? item.shiftType),
      startTime: normalizeTime(item.start ?? item.startTime),
      endTime: normalizeTime(item.end ?? item.endTime),
      drawStart: normalizeTime(item.drawStart ?? item.draw_start),
      drawEnd: normalizeTime(item.drawEnd ?? item.draw_end),
      weekdayRead: normalizeWeekday(item.weekday),
      // A screenshot can't show a hotel night: that's ticked by hand.
      overnight: false,
    }));
}

/** Today's date, from a moment. */
function localToday(now: Date): LocalDate {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * A time in any of the usual shapes, as "HH:MM": "09:00", "9:00", "9:00a",
 * "9:00 PM", "9pm", "21:30". `null` if it isn't a time.
 */
export function normalizeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*([ap])?\.?\s*m?\.?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const half = match[3];
  if (half) {
    if (hours < 1 || hours > 12) return null;
    if (half === "a" && hours === 12) hours = 0;
    if (half === "p" && hours !== 12) hours += 12;
  }
  const time = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return isTime(time) ? time : null;
}

/**
 * A date in any of the usual shapes, as "YYYY-MM-DD": "2026-09-28",
 * "9/28/2026", "9/28", "Mon 9/28". Without a year, the year that puts it
 * closest to today. `null` if it isn't a date.
 */
export function normalizeDate(value: unknown, today: LocalDate): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^[a-z]+,?\s+/i, ""); // "Mon 9/28" -> "9/28"
  if (isDate(text as unknown)) return text;
  const match = text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (match[3]) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = `${year}-${pad(month)}-${pad(day)}`;
    return isDate(date) ? date : null;
  }
  // No year: the closest to today of last year, this year and next year.
  const thisYear = Number(today.slice(0, 4));
  const candidates = [thisYear - 1, thisYear, thisYear + 1]
    .map((year) => `${year}-${pad(month)}-${pad(day)}`)
    .filter(isDate)
    .sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)));
  return candidates[0] ?? null;
}

/** "regular", "meeting" or "oncall", from the words a model might use. */
export function normalizeShiftType(value: unknown): ShiftType {
  const text = typeof value === "string" ? value.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (SHIFT_TYPES.includes(text as ShiftType)) return text as ShiftType;
  if (/call/.test(text)) return "oncall";
  if (/meet|mtg|training|huddle/.test(text)) return "meeting";
  return "regular";
}

/** "Mon", from "Monday", "mon" or "MON." */
function normalizeWeekday(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const found = WEEKDAYS.find((day) => value.trim().toLowerCase().startsWith(day.toLowerCase()));
  return found ?? null;
}

// -------------------------------------------------------------- checking

/**
 * Check rows for the review list: work out what's calculated (the end date
 * of an overnight shift, shift hours, draw time), and warn about anything
 * that looks wrong.
 *
 * @param existing  Plans already saved, to spot shifts that are already there.
 */
export function checkRows(rows: ScreenshotRow[], existing: Plan[], now: Date): CheckedRow[] {
  const today = localToday(now);
  const key = (r: { date: string | null; startTime: string | null; endTime: string | null }) =>
    `${r.date} ${r.startTime} ${r.endTime}`;
  const saved = new Set(
    existing.filter((p) => p.kind === "shift" && p.repeats === "never").map((p) => key({ date: p.startDate, startTime: p.startTime, endTime: p.endTime })),
  );
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(key(row), (seen.get(key(row)) ?? 0) + 1);

  // When every shift starts, in the list and already saved: an "overnight"
  // shift needs one within two days after it, to link to.
  const starts = [
    ...rows.filter((r) => r.date && r.startTime).map((r) => toMoment(r.date!, r.startTime)),
    ...existing.filter((p) => p.kind === "shift" && p.startTime).map((p) => toMoment(p.startDate, p.startTime)),
  ];

  return rows.map((row) => {
    const warnings: string[] = [];
    let error: string | null = null;
    let endDate: string | null = null;
    let shiftMinutes: number | null = null;
    let drawMinutes: number | null = null;

    if (!row.date) error = "Needs a date";
    else if (!row.startTime || !row.endTime) error = "Needs shift hours";

    if (row.date && row.startTime && row.endTime) {
      // As a plan, to reuse the planner's own calculations (src/planner.ts).
      endDate = row.endTime > row.startTime ? row.date : addDays(row.date, 1);
      const timing = { date: row.date, startTime: row.startTime, endDate, endTime: row.endTime };
      const plan = asPlan(row, endDate);
      const facts = shiftFacts(plan, timing);
      shiftMinutes = facts.shiftMinutes;
      drawMinutes = facts.drawMinutes;

      if (shiftMinutes !== null && shiftMinutes > LONGEST_SHIFT) {
        warnings.push(`A ${Math.round(shiftMinutes / 60)}-hour shift? This might be misread.`);
      } else if (shiftMinutes !== null && shiftMinutes < SHORTEST_SHIFT) {
        warnings.push(`A ${shiftMinutes}-minute shift? This might be misread.`);
      }
      if (facts.draw) {
        const shift = momentsOf(timing);
        if (facts.draw.start < shift.start || facts.draw.end > shift.end) warnings.push("Draw hours are outside the shift hours.");
      }
    }

    if (row.shiftType === "regular" && (!row.drawStart || !row.drawEnd)) warnings.push("Regular shift with no draw hours.");
    if (row.shiftType !== "regular" && (row.drawStart || row.drawEnd)) {
      warnings.push(`${row.shiftType === "meeting" ? "Meetings" : "On-call shifts"} don't have draw hours, so these will be left out.`);
    }
    if (row.date) {
      const actual = WEEKDAYS[weekday(row.date)]!;
      if (row.weekdayRead && row.weekdayRead !== actual) {
        const [, month, day] = row.date.split("-").map(Number);
        const fullName = toMoment(row.date, "12:00").toLocaleDateString("en-US", { weekday: "long" });
        warnings.push(`The screenshot says ${row.weekdayRead}, but ${month}/${day} is a ${fullName}. Misread date?`);
      }
      if (Math.abs(daysBetween(today, row.date)) > FARTHEST_DAYS) warnings.push("This date is far from today. Check the year.");
    }
    if (row.overnight && row.date && row.startTime && row.endTime && endDate) {
      const end = toMoment(endDate, row.endTime);
      const linked = starts.some((start) => start >= end && start.getTime() - end.getTime() <= LINK_HOURS * 3600_000);
      if (!linked) warnings.push("Overnight after this shift, but there's no shift in the next two days to link it to.");
    }
    if (saved.has(key(row))) warnings.push("This shift is already in the planner.");
    if ((seen.get(key(row)) ?? 0) > 1 && !error) warnings.push("This shift is in the list twice.");

    return { ...row, endDate, shiftMinutes, drawMinutes, warnings, error };
  });
}

/** A row as an (unsaved) shift plan, for the planner's calculations. */
function asPlan(row: ScreenshotRow, endDate: string | null): Plan {
  return {
    id: "",
    kind: "shift",
    title: SHIFT_TITLES[row.shiftType],
    startDate: row.date!,
    startTime: row.startTime,
    endDate,
    endTime: row.endTime,
    repeats: "never",
    reminders: null,
    checked: true,
    shiftType: row.shiftType,
    drawStart: row.shiftType === "regular" ? row.drawStart : null,
    drawEnd: row.shiftType === "regular" ? row.drawEnd : null,
    overnight: row.overnight,
    notes: "",
    source: "screenshot",
    createdAt: "",
    updatedAt: "",
  };
}

/** What each kind of shift is called in the planner. */
const SHIFT_TITLES: Record<ShiftType, string> = { regular: "Work", meeting: "Meeting", oncall: "On call" };

/**
 * Check rows sent back from the review list: they come from the browser, so
 * every field is checked for its shape. Fields that don't fit become `null`.
 */
export function rowsFromRequest(value: unknown): ScreenshotRow[] {
  if (!Array.isArray(value)) throw new ValidationError('"rows" must be a list');
  if (value.length > 200) throw new ValidationError("That's too many rows for one screenshot.");
  return value.map((item) => {
    const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    return {
      date: isDate(raw.date) ? raw.date : null,
      shiftType: SHIFT_TYPES.includes(raw.shiftType as ShiftType) ? (raw.shiftType as ShiftType) : "regular",
      startTime: isTime(raw.startTime) ? raw.startTime : null,
      endTime: isTime(raw.endTime) ? raw.endTime : null,
      drawStart: isTime(raw.drawStart) ? raw.drawStart : null,
      drawEnd: isTime(raw.drawEnd) ? raw.drawEnd : null,
      weekdayRead: typeof raw.weekdayRead === "string" ? normalizeWeekday(raw.weekdayRead) : null,
      overnight: raw.overnight === true,
    };
  });
}

// ---------------------------------------------------------------- saving

/**
 * "Looks good, save": every row becomes a checked shift plan, all or
 * nothing. Warnings don't stop it; a row that can't be a plan (no date, no
 * hours) does, and nothing is saved.
 */
export function saveRows(store: Store, rows: ScreenshotRow[], now: Date): Plan[] {
  const checked = checkRows(rows, [], now);
  const broken = checked.findIndex((row) => row.error);
  if (broken >= 0) throw new ValidationError(`Row ${broken + 1}: ${checked[broken]!.error!.toLowerCase()}.`);
  return store.db.transaction(() =>
    checked.map((row) =>
      // store.plans.create checks it all again, as for any plan.
      store.plans.create({ ...asPlan(row, row.endDate) }),
    ),
  )();
}
