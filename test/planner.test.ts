/**
 * Tests for the planner (src/planner.ts, src/dates.ts): plans, shifts,
 * overnight ranges, repeats, draw time, work blocks, reminders and the
 * weekly list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addDays,
  daysBetween,
  formatMinutes,
  isDate,
  isTime,
  mondayOf,
  nextAtOrAfter,
  sameDayInYear,
  shortDate,
  shortTime,
  toMoment,
  weekday,
} from "../src/dates.ts";
import { describeOccurrence, workStatus } from "../src/binder.ts";
import { occurrencesOf, reminderTimes, validatePlan, workBlocks } from "../src/planner.ts";
import { checkRows, rowsFromRequest, saveRows } from "../src/screenshot.ts";
import { createApp, type App } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Plan } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** A full plan from a few fields, for the pure functions. */
function plan(fields: Record<string, unknown>): Plan {
  return {
    id: "p1",
    createdAt: "",
    updatedAt: "",
    ...validatePlan({ kind: "other", title: "Thing", startDate: "2026-09-28", ...fields }),
  };
}

describe("dates", () => {
  test("checks dates and times", () => {
    expect(isDate("2026-09-28")).toBe(true);
    expect(isDate("2026-02-30")).toBe(false);
    expect(isDate("2026-9-28")).toBe(false);
    expect(isTime("09:30")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("9:30")).toBe(false);
  });

  test("counts days across months, years and daylight saving", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
    expect(daysBetween("2026-10-30", "2026-11-03")).toBe(4);
  });

  test("weeks run Monday to Sunday", () => {
    expect(weekday("2026-09-28")).toBe(1); // a Monday
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2026-09-30")).toBe("2026-09-28");
  });

  test("leap-day plans come round on February 28th in other years", () => {
    expect(sameDayInYear("2028-02-29", 2029)).toBe("2029-02-28");
    expect(sameDayInYear("2028-02-29", 2032)).toBe("2032-02-29");
  });

  test("finds the next time a clock time comes round", () => {
    const tenPm = toMoment("2026-09-28", "22:00");
    expect(nextAtOrAfter(tenPm, "23:00")).toEqual(toMoment("2026-09-28", "23:00"));
    expect(nextAtOrAfter(tenPm, "02:00")).toEqual(toMoment("2026-09-29", "02:00"));
  });

  test("formats like a work schedule", () => {
    expect(shortTime("09:00")).toBe("9:00a");
    expect(shortTime("17:30")).toBe("5:30p");
    expect(shortTime("00:15")).toBe("12:15a");
    expect(shortTime("12:00")).toBe("12:00p");
    expect(formatMinutes(240)).toBe("4h");
    expect(formatMinutes(270)).toBe("4h 30m");
    expect(formatMinutes(45)).toBe("45m");
    expect(shortDate("2026-09-28")).toBe("Mon 9/28");
  });
});

describe("validatePlan", () => {
  test("works out an overnight shift's end date", () => {
    const night = validatePlan({ kind: "shift", title: "Work", startDate: "2026-09-28", startTime: "22:00", endTime: "06:00" });
    expect(night).toMatchObject({ endDate: "2026-09-29", endTime: "06:00", shiftType: "regular" });
    const day = validatePlan({ kind: "shift", title: "Work", startDate: "2026-09-28", startTime: "09:00", endTime: "17:30" });
    expect(day.endDate).toBe("2026-09-28");
  });

  test("clears fields that don't apply", () => {
    const birthday = validatePlan({
      kind: "birthday",
      title: "Mia",
      startDate: "2026-10-02",
      shiftType: "regular",
      drawStart: "10:00",
      drawEnd: "14:00",
    });
    expect(birthday).toMatchObject({ shiftType: null, drawStart: null, drawEnd: null, repeats: "never", checked: false });
    const meeting = validatePlan({
      kind: "shift",
      shiftType: "meeting",
      title: "Staff meeting",
      startDate: "2026-10-02",
      startTime: "08:00",
      endTime: "09:00",
      drawStart: "08:00",
      drawEnd: "09:00",
    });
    expect(meeting).toMatchObject({ drawStart: null, drawEnd: null });
  });

  test.each([
    [{ kind: "party" }, /kind must be one of/],
    [{ title: " " }, /needs a title/],
    [{ startDate: "2026-13-01" }, /startDate/],
    [{ startTime: "25:00" }, /startTime/],
    [{ endTime: "10:00" }, /all-day plan can't have an end time/],
    [{ endDate: "2026-09-01" }, /can't end before it starts/],
    [{ startTime: "10:00", endDate: "2026-09-29" }, /end date needs an end time/],
    [{ startTime: "10:00", endDate: "2026-09-28", endTime: "09:00" }, /end after it starts/],
    [{ kind: "shift", startTime: "09:00" }, /shift needs a start and an end time/],
    [{ kind: "shift", startTime: "09:00", endTime: "17:00", drawStart: "10:00" }, /Draw hours need a start and an end/],
    [{ repeats: "daily" }, /repeats/],
    [{ reminders: ["hour-before"] }, /reminders/],
    [{ checked: "yes" }, /checked/],
  ])("rejects %j", (fields, error) => {
    expect(() => validatePlan({ kind: "other", title: "Thing", startDate: "2026-09-28", ...fields })).toThrow(error);
  });

  test("keeps reminders in order, without repeats; null means the kind's default", () => {
    expect(plan({ reminders: ["2h-before", "day-before", "2h-before"] }).reminders).toEqual(["day-before", "2h-before"]);
    expect(plan({ reminders: [] }).reminders).toEqual([]);
    expect(plan({}).reminders).toBeNull();
  });
});

describe("repeats", () => {
  test("a weekly plan happens on the same weekday, keeping its length", () => {
    const night = plan({ kind: "shift", startDate: "2026-09-28", startTime: "22:00", endTime: "06:00", repeats: "weekly" });
    const dates = occurrencesOf(night, "2026-10-01", "2026-10-20");
    expect(dates.map((t) => t.date)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(dates[0]).toMatchObject({ endDate: "2026-10-06", endTime: "06:00" });
  });

  test("an overnight occurrence counts on the day it ends, too", () => {
    const night = plan({ kind: "shift", startDate: "2026-09-28", startTime: "22:00", endTime: "06:00", repeats: "weekly" });
    expect(occurrencesOf(night, "2026-10-06", "2026-10-06").map((t) => t.date)).toEqual(["2026-10-05"]);
  });

  test("never before the plan starts", () => {
    const weekly = plan({ startDate: "2026-09-28", repeats: "weekly" });
    expect(occurrencesOf(weekly, "2026-09-01", "2026-10-06").map((t) => t.date)).toEqual(["2026-09-28", "2026-10-05"]);
  });

  test("a yearly plan comes round every year", () => {
    const birthday = plan({ kind: "birthday", startDate: "2024-10-02", repeats: "yearly" });
    expect(occurrencesOf(birthday, "2026-01-01", "2027-12-31").map((t) => t.date)).toEqual(["2026-10-02", "2027-10-02"]);
  });

  test("a plan that doesn't repeat happens once", () => {
    const once = plan({ startDate: "2026-09-28" });
    expect(occurrencesOf(once, "2026-09-01", "2026-12-31")).toHaveLength(1);
    expect(occurrencesOf(once, "2026-10-01", "2026-12-31")).toHaveLength(0);
  });

  test("multi-day all-day plans overlap every day they cover", () => {
    const trip = plan({ startDate: "2026-09-28", endDate: "2026-10-01" });
    expect(occurrencesOf(trip, "2026-09-30", "2026-09-30")).toHaveLength(1);
  });
});

describe("daylight saving", () => {
  test("a night shift over the night the clocks go back is 9 hours, not 8", () => {
    // Restored to the zone itself afterwards: deleting TZ doesn't switch back.
    const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "America/New_York"; // clocks go back at 2 AM on November 1, 2026
    try {
      const store = new Store(":memory:");
      store.plans.create({ kind: "shift", title: "Night", startDate: "2026-10-31", startTime: "22:00", endTime: "06:00" });
      store.plans.create({ kind: "shift", title: "Night", startDate: "2026-11-07", startTime: "22:00", endTime: "06:00" });
      const [changeNight, normalNight] = store.plans.occurrences("2026-10-31", "2026-11-07");
      expect(changeNight!.shiftMinutes).toBe(9 * 60);
      expect(normalNight!.shiftMinutes).toBe(8 * 60);
      store.close();
    } finally {
      process.env.TZ = saved;
    }
  });
});

describe("work blocks", () => {
  test("shifts that run into each other are one block; a gap splits them", () => {
    const blocks = workBlocks([
      { key: "b", start: toMoment("2026-09-28", "13:00"), end: toMoment("2026-09-28", "17:00") },
      { key: "a", start: toMoment("2026-09-28", "09:00"), end: toMoment("2026-09-28", "13:00") },
      { key: "c", start: toMoment("2026-09-28", "18:00"), end: toMoment("2026-09-28", "20:00") },
    ]);
    expect(blocks.map((b) => b.keys)).toEqual([["a", "b"], ["c"]]);
    expect(blocks[0]!.end).toEqual(toMoment("2026-09-28", "17:00"));
  });
});

describe("reminders", () => {
  const dentist = { date: "2026-10-01", startTime: "15:00", endDate: null, endTime: null };

  test("go off at their times", () => {
    const times = reminderTimes(["week-before", "day-before", "morning-of", "2h-before"], dentist, [], "x");
    expect(times.map((r) => [r.id, r.date, r.time])).toEqual([
      ["week-before", "2026-09-24", "12:00"],
      ["day-before", "2026-09-30", "18:00"],
      ["morning-of", "2026-10-01", "09:00"],
      ["2h-before", "2026-10-01", "13:00"],
    ]);
  });

  test("'morning of' is at least an hour before an early start; '2 hours before' an all-day plan is the morning", () => {
    const early = { date: "2026-10-01", startTime: "08:30", endDate: null, endTime: null };
    expect(reminderTimes(["morning-of"], early, [], "x")[0]!.time).toBe("07:30");
    const allDay = { date: "2026-10-01", startTime: null, endDate: null, endTime: null };
    expect(reminderTimes(["2h-before"], allDay, [], "x")[0]!.time).toBe("09:00");
  });

  test("dodge work: a reminder during a shift moves to before it", () => {
    const shift = { start: toMoment("2026-10-01", "12:00"), end: toMoment("2026-10-01", "20:00"), keys: ["shift"] };
    const [twoHours] = reminderTimes(["2h-before"], dentist, [shift], "dentist");
    expect(twoHours).toMatchObject({ date: "2026-10-01", time: "11:30", dodged: true });
  });

  test("dodging again if moving lands in an earlier block", () => {
    const blocks = [
      { start: toMoment("2026-10-01", "08:00"), end: toMoment("2026-10-01", "11:45"), keys: ["a"] },
      { start: toMoment("2026-10-01", "12:00"), end: toMoment("2026-10-01", "20:00"), keys: ["b"] },
    ];
    expect(reminderTimes(["2h-before"], dentist, blocks, "dentist")[0]).toMatchObject({ time: "07:30", dodged: true });
  });
});

// ------------------------------------------------------------ the database

describe("plans in the database", () => {
  let dir: ReturnType<typeof tempDir>;
  let store: Store;

  beforeEach(() => {
    dir = tempDir();
    store = new Store(dir.path);
  });

  afterEach(() => {
    store.close();
    dir.cleanup();
  });

  test("a new server has a planner channel", () => {
    expect(store.listChannels().map((c) => [c.name, c.kind])).toEqual([
      ["general", "text"],
      ["planner", "planner"],
      ["trackers", "trackers"],
    ]);
  });

  test("there can only be one planner channel", () => {
    expect(() => store.createChannel({ name: "calendar", kind: "planner" })).toThrow(/already a planner/);
  });

  test("can be made, changed and deleted", () => {
    const made = store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00" });
    expect(made).toMatchObject({ title: "Dentist", source: "manual", checked: false, reminders: null });
    const changed = store.plans.update(made.id, { startDate: "2026-10-02", checked: true });
    expect(changed).toMatchObject({ startDate: "2026-10-02", startTime: "15:00", checked: true });
    // Changing a shift into an appointment clears its shift fields.
    const shift = store.plans.create({
      kind: "shift",
      title: "Work",
      startDate: "2026-10-01",
      startTime: "09:00",
      endTime: "17:00",
      drawStart: "10:00",
      drawEnd: "14:00",
    });
    expect(store.plans.update(shift.id, { kind: "hangout" })).toMatchObject({ shiftType: null, drawStart: null });
    store.plans.delete(made.id);
    expect(() => store.plans.get(made.id)).toThrow(/doesn't exist/);
  });

  test("occurrences have shift hours, draw time (overnight too) and reminders worked out", () => {
    store.plans.create({
      kind: "shift",
      title: "Night",
      startDate: "2026-09-28",
      startTime: "22:00",
      endTime: "06:00",
      drawStart: "01:00",
      drawEnd: "04:30",
    });
    store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-09-29", startTime: "15:00" });
    const [night, dentist] = store.plans.occurrences("2026-09-28", "2026-09-29");
    expect(night).toMatchObject({ shiftMinutes: 480, drawMinutes: 210, busy: true, reminders: [] });
    expect(dentist!.reminders.map((r) => r.label)).toEqual(["Day before", "2 hours before"]);
  });

  test("on-call is free unless you're called in", () => {
    const oncall = store.plans.create({
      kind: "shift",
      shiftType: "oncall",
      title: "On call",
      startDate: "2026-09-28",
      startTime: "08:00",
      endTime: "20:00",
    });
    const key = `${oncall.id}:2026-09-28`;
    expect(store.plans.occurrences("2026-09-28", "2026-09-28")[0]!.busy).toBe(false);
    expect(store.plans.occurrences("2026-09-28", "2026-09-28", { calledIn: new Set([key]) })[0]!.busy).toBe(true);
    expect(store.plans.workBlocks("2026-09-28", "2026-09-28")).toEqual([]);
  });

  test("reminders dodge the shifts in the planner", () => {
    store.plans.create({ kind: "shift", title: "Work", startDate: "2026-10-01", startTime: "12:00", endTime: "20:00" });
    store.plans.create({ kind: "appointment", title: "Call the bank", startDate: "2026-10-01", startTime: "15:00" });
    const bank = store.plans.occurrences("2026-10-01", "2026-10-01").find((o) => o.plan.title === "Call the bank")!;
    expect(bank.reminders.find((r) => r.id === "2h-before")).toMatchObject({ time: "11:30", dodged: true });
  });

  test("the weekly list has day totals on double-booked days, and week totals", () => {
    const shift = (date: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
      store.plans.create({ kind: "shift", title: "Work", startDate: date, startTime: start, endTime: end, ...extra });
    shift("2026-09-28", "09:00", "13:00", { drawStart: "09:30", drawEnd: "12:30" });
    shift("2026-09-28", "13:00", "17:30", { drawStart: "14:00", drawEnd: "16:00" });
    shift("2026-09-30", "22:00", "06:00", { drawStart: "23:00", drawEnd: "03:00" });
    shift("2026-10-02", "08:00", "09:00", { shiftType: "meeting" });
    shift("2026-10-03", "08:00", "20:00", { shiftType: "oncall" });
    store.plans.create({ kind: "birthday", title: "Mia", startDate: "2026-10-04" });

    const week = store.plans.week("2026-09-28");
    const monday = week.days[0]!;
    expect(monday).toMatchObject({ doubleBooked: true, shiftMinutes: 510, drawMinutes: 300 });
    expect(week.days[2]!.shiftMinutes).toBe(480);
    expect(week.days[6]!.occurrences[0]!.plan.title).toBe("Mia");
    expect(week.totals).toEqual({ shiftMinutes: 510 + 480 + 60, drawMinutes: 300 + 240, onCallMinutes: 720 });
  });
});

describe("linked shifts: a hotel night between shifts", () => {
  let dir: ReturnType<typeof tempDir>;
  let store: Store;
  const shift = (startDate: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) =>
    store.plans.create({ kind: "shift", title: "Work", startDate, startTime, endTime, drawStart: null, drawEnd: null, checked: true, ...extra });

  beforeEach(() => {
    dir = tempDir();
    store = new Store(dir.path);
  });

  afterEach(() => {
    store.close();
    dir.cleanup();
  });

  test("only shifts can be overnight, and it's saved", () => {
    expect(validatePlan({ kind: "appointment", title: "Dentist", startDate: "2026-09-28", startTime: "15:00", overnight: true }).overnight).toBe(false);
    expect(() => validatePlan({ kind: "shift", title: "Work", startDate: "2026-09-28", startTime: "09:00", endTime: "17:00", overnight: "yes" })).toThrow(
      "overnight must be true or false",
    );
    const monday = shift("2026-09-28", "09:00", "17:00", { overnight: true });
    expect(store.plans.get(monday.id).overnight).toBe(true);
    expect(store.plans.update(monday.id, { overnight: false }).overnight).toBe(false);
    expect(shift("2026-09-29", "09:00", "17:00").overnight).toBe(false);
  });

  test("links to the next shift, and a chain of them is a trip", () => {
    const monday = shift("2026-09-28", "06:00", "14:00", { overnight: true });
    const tuesday = shift("2026-09-29", "07:00", "15:00", { overnight: true });
    const wednesday = shift("2026-09-30", "06:00", "12:00");
    const [mon, tue, wed] = store.plans.occurrences("2026-09-28", "2026-09-30");
    expect(mon!.stay).toEqual({ nextKey: `${tuesday.id}:2026-09-29`, nextDate: "2026-09-29", nextTime: "07:00" });
    expect(tue!.stay).toEqual({ nextKey: `${wednesday.id}:2026-09-30`, nextDate: "2026-09-30", nextTime: "06:00" });
    expect(wed!.stay).toBeNull();
    expect(mon!.plan.id).toBe(monday.id);
  });

  test("with no shift in the next two days, it has nothing to link to", () => {
    shift("2026-09-28", "06:00", "14:00", { overnight: true });
    shift("2026-09-30", "15:00", "20:00"); // 49 hours later
    const [mon] = store.plans.occurrences("2026-09-28", "2026-09-28");
    expect(mon!.stay).toEqual({ nextKey: null, nextDate: null, nextTime: null });
  });

  test("a weekly overnight shift links to that week's next shift", () => {
    shift("2026-09-28", "06:00", "14:00", { overnight: true, repeats: "weekly" });
    shift("2026-09-29", "07:00", "15:00", { repeats: "weekly" });
    const mondays = store.plans.occurrences("2026-10-05", "2026-10-12").filter((o) => o.stay);
    expect(mondays.map((o) => o.stay!.nextDate)).toEqual(["2026-10-06", "2026-10-13"]);
  });

  test("she's told: the hotel night on the shift, and that they're away between shifts", () => {
    shift("2026-09-28", "06:00", "14:00", { overnight: true });
    shift("2026-09-29", "07:00", "15:00");
    const [mon] = store.plans.occurrences("2026-09-28", "2026-09-28");
    expect(describeOccurrence(mon!)).toBe("Work (shift) 6:00a–2:00p, 8h, no draw hours, then a hotel night: staying away until the next shift, Tue, Sep 29 at 7:00a");
    // At work, then away (not at work, and not home), then at work again.
    expect(workStatus(store, new Date(2026, 8, 28, 13, 0))).toBe("They're at work right now, until 2:00 PM.");
    expect(workStatus(store, new Date(2026, 8, 28, 20, 0))).toBe(
      "They're away overnight, staying at a hotel between shifts: not at work, and not home. Their next shift starts at 7:00 AM tomorrow.",
    );
    expect(workStatus(store, new Date(2026, 8, 29, 6, 0))).toContain("Their next shift starts at 7:00 AM.");
    expect(workStatus(store, new Date(2026, 8, 29, 8, 0))).toBe("They're at work right now, until 3:00 PM.");
    expect(workStatus(store, new Date(2026, 8, 29, 16, 0))).toBeNull();
  });

  test("the screenshot review: ticked by hand, warned about when there's nothing to link to, and saved", () => {
    const rows = rowsFromRequest([
      { date: "2026-09-28", shiftType: "regular", startTime: "06:00", endTime: "14:00", drawStart: "07:00", drawEnd: "11:00", overnight: true },
      { date: "2026-09-29", shiftType: "regular", startTime: "07:00", endTime: "15:00", drawStart: "08:00", drawEnd: "12:00", overnight: true },
      { date: "2026-10-05", shiftType: "regular", startTime: "07:00", endTime: "15:00", drawStart: "08:00", drawEnd: "12:00", overnight: "yes" },
    ]);
    expect(rows.map((r) => r.overnight)).toEqual([true, true, false]);
    const checked = checkRows(rows, [], new Date(2026, 8, 26, 12, 0));
    const linkWarning = "Overnight after this shift, but there's no shift in the next two days to link it to.";
    expect(checked[0]!.warnings).not.toContain(linkWarning);
    expect(checked[1]!.warnings).toContain(linkWarning);
    const saved = saveRows(store, rows, new Date(2026, 8, 26, 12, 0));
    expect(saved.map((p) => p.overnight)).toEqual([true, true, false]);
  });
});

describe("the planner over the API", () => {
  let fake: FakeNanoGpt;
  let dir: ReturnType<typeof tempDir>;
  let app: App;
  let call: ReturnType<typeof caller>;

  beforeEach(() => {
    fake = startFakeNanoGpt();
    dir = tempDir();
    app = createApp(testConfig(dir.path, fake.baseUrl));
    call = caller(app.fetch);
  });

  afterEach(() => {
    app.store.close();
    fake.stop();
    dir.cleanup();
  });

  test("plans can be made, read, changed and deleted, and the app hears about it", async () => {
    const events: string[] = [];
    app.events.listen((e) => events.push(e.type));
    const made = await call("POST", "/api/plans", { kind: "hangout", title: "Movies", startDate: "2026-10-03", startTime: "19:00" });
    expect(made.status).toBe(200);
    const id = made.data.plan.id;
    expect((await call("GET", `/api/plans/${id}`)).data.plan.title).toBe("Movies");
    expect((await call("PATCH", `/api/plans/${id}`, { title: "Movies with Mia" })).data.plan.title).toBe("Movies with Mia");
    expect((await call("PATCH", `/api/plans/${id}`, { startTime: "nope" })).status).toBe(400);
    expect((await call("DELETE", `/api/plans/${id}`, {})).status).toBe(200);
    expect((await call("GET", `/api/plans/${id}`)).status).toBe(404);
    expect(events).toEqual(["plans", "plans", "plans"]);
  });

  test("occurrences for a date range, and the weekly list", async () => {
    await call("POST", "/api/plans", { kind: "shift", title: "Work", startDate: "2026-09-28", startTime: "09:00", endTime: "17:00", repeats: "weekly" });
    const range = await call("GET", "/api/plans?from=2026-09-01&to=2026-10-31");
    expect(range.data.occurrences.map((o: { date: string }) => o.date)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    const week = await call("GET", "/api/planner/week?date=2026-10-08");
    expect(week.data.week.monday).toBe("2026-10-05");
    expect(week.data.week.totals.shiftMinutes).toBe(480);
  });

  test("date ranges are checked", async () => {
    expect((await call("GET", "/api/plans?from=2026-10-01")).status).toBe(400);
    expect((await call("GET", "/api/plans?from=2026-10-01&to=2026-09-01")).status).toBe(400);
    expect((await call("GET", "/api/plans?from=2026-01-01&to=2028-01-01")).status).toBe(400);
    expect((await call("GET", "/api/planner/week?date=soon")).status).toBe(400);
  });

  test("you can't text in the planner channel", async () => {
    const planner = app.store.listChannels().find((c) => c.kind === "planner")!;
    expect((await call("POST", `/api/channels/${planner.id}/messages`, { content: "hi" })).status).toBe(400);
  });

  test("the app gets each kind's default reminders", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.planner.defaultReminders.appointment).toEqual(["day-before", "2h-before"]);
    expect(data.planner.reminderLabels["morning-of"]).toBe("Morning of");
  });
});
