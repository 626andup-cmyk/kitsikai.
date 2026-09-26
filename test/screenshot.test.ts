/**
 * Tests for screenshot import (src/screenshot.ts, src/json.ts): reading a
 * schedule with a vision model, tidying what it wrote, the review list's
 * warnings, and saving.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { extractJson, JsonReplyError } from "../src/json.ts";
import { checkRows, normalizeDate, normalizeShiftType, normalizeTime, parseScheduleReply } from "../src/screenshot.ts";
import { createApp, type App } from "../src/server.ts";
import type { Plan, ScreenshotRow } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** Saturday, September 26, 2026, 4 PM: the "today" of these tests. */
const NOW = new Date(2026, 8, 26, 16, 0);

function row(fields: Partial<ScreenshotRow>): ScreenshotRow {
  return {
    date: "2026-09-28",
    shiftType: "regular",
    startTime: "09:00",
    endTime: "17:30",
    drawStart: "10:00",
    drawEnd: "14:00",
    weekdayRead: "Mon",
    overnight: false,
    ...fields,
  };
}

describe("extractJson", () => {
  test("finds JSON in fences, after chatter, with trailing commas and curly quotes", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson("<think>hmm</think> [“x”]")).toEqual(["x"]);
    expect(extractJson('Sure! {"shifts": []} Hope that helps.')).toEqual({ shifts: [] });
  });

  test("gives up clearly when there's no JSON", () => {
    expect(() => extractJson("I can't see any image.")).toThrow(JsonReplyError);
    expect(() => extractJson("{not json at all")).toThrow(JsonReplyError);
  });
});

describe("tidying what the model wrote", () => {
  test("times in the usual shapes", () => {
    expect(normalizeTime("09:00")).toBe("09:00");
    expect(normalizeTime("9:00")).toBe("09:00");
    expect(normalizeTime("9:00a")).toBe("09:00");
    expect(normalizeTime("5:30p")).toBe("17:30");
    expect(normalizeTime("5:30 PM")).toBe("17:30");
    expect(normalizeTime("12:00am")).toBe("00:00");
    expect(normalizeTime("12pm")).toBe("12:00");
    expect(normalizeTime("9pm")).toBe("21:00");
    expect(normalizeTime("21:30")).toBe("21:30");
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("13pm")).toBeNull();
    expect(normalizeTime("soon")).toBeNull();
    expect(normalizeTime(null)).toBeNull();
  });

  test("dates, with the year closest to today when there isn't one", () => {
    expect(normalizeDate("2026-09-28", "2026-09-26")).toBe("2026-09-28");
    expect(normalizeDate("9/28", "2026-09-26")).toBe("2026-09-28");
    expect(normalizeDate("Mon 9/28", "2026-09-26")).toBe("2026-09-28");
    expect(normalizeDate("1/3", "2026-12-28")).toBe("2027-01-03");
    expect(normalizeDate("12/30", "2027-01-02")).toBe("2026-12-30");
    expect(normalizeDate("9/28/26", "2026-09-26")).toBe("2026-09-28");
    expect(normalizeDate("2/30", "2026-09-26")).toBeNull();
    expect(normalizeDate("tomorrow", "2026-09-26")).toBeNull();
  });

  test("shift types from the words a model might use", () => {
    expect(normalizeShiftType("regular")).toBe("regular");
    expect(normalizeShiftType("On-Call")).toBe("oncall");
    expect(normalizeShiftType("on call")).toBe("oncall");
    expect(normalizeShiftType("Staff meeting")).toBe("meeting");
    expect(normalizeShiftType("Training")).toBe("meeting");
    expect(normalizeShiftType(undefined)).toBe("regular");
  });

  test("a reply becomes rows, whether it's a list or {shifts: [...]}", () => {
    const rows = parseScheduleReply(
      { shifts: [{ weekday: "Monday", date: "9/28", type: "Regular", start: "9:00a", end: "5:30p", drawStart: "10a", drawEnd: "2p" }] },
      NOW,
    );
    expect(rows).toEqual([row({})]);
    expect(parseScheduleReply([{ date: "2026-09-29", start: "22:00", end: "06:00" }], NOW)[0]).toMatchObject({
      date: "2026-09-29",
      drawStart: null,
      weekdayRead: null,
    });
    expect(() => parseScheduleReply({ days: [] }, NOW)).toThrow(/no list of shifts/);
  });
});

describe("the review list's checks", () => {
  test("a good row has its calculated values and no warnings", () => {
    const [checked] = checkRows([row({})], [], NOW);
    expect(checked).toMatchObject({ endDate: "2026-09-28", shiftMinutes: 510, drawMinutes: 240, warnings: [], error: null });
  });

  test("overnight shifts end the next day, draw hours after midnight included", () => {
    const [night] = checkRows([row({ startTime: "22:00", endTime: "06:00", drawStart: "01:00", drawEnd: "03:00" })], [], NOW);
    expect(night).toMatchObject({ endDate: "2026-09-29", shiftMinutes: 480, drawMinutes: 120, warnings: [] });
  });

  test("warns (never blocks) about what looks wrong", () => {
    const warningsFor = (fields: Partial<ScreenshotRow>) => checkRows([row(fields)], [], NOW)[0]!.warnings;
    expect(warningsFor({ drawStart: null, drawEnd: null })).toEqual(["Regular shift with no draw hours."]);
    expect(warningsFor({ drawStart: "08:00", drawEnd: "12:00" })).toEqual(["Draw hours are outside the shift hours."]);
    expect(warningsFor({ weekdayRead: "Tue" })).toEqual(["The screenshot says Tue, but 9/28 is a Monday. Misread date?"]);
    expect(warningsFor({ startTime: "09:00", endTime: "08:00" })[0]).toContain("23-hour shift?");
    expect(warningsFor({ startTime: "09:00", endTime: "09:15", drawStart: null, drawEnd: null })[0]).toContain("15-minute shift?");
    expect(warningsFor({ date: "2027-03-01", weekdayRead: null })).toEqual(["This date is far from today. Check the year."]);
    expect(warningsFor({ shiftType: "meeting" })).toEqual(["Meetings don't have draw hours, so these will be left out."]);
    expect(warningsFor({ shiftType: "oncall", drawStart: null, drawEnd: null })).toEqual([]);
  });

  test("a double-booked day is two rows; the same shift twice gets a warning", () => {
    const double = checkRows([row({ endTime: "13:00", drawEnd: "12:00" }), row({ startTime: "13:00", drawStart: "14:00", drawEnd: "16:00" })], [], NOW);
    expect(double.map((r) => r.warnings)).toEqual([[], []]);
    const twice = checkRows([row({}), row({})], [], NOW);
    expect(twice[0]!.warnings).toEqual(["This shift is in the list twice."]);
  });

  test("warns about shifts already in the planner", () => {
    const existing = [{ kind: "shift", repeats: "never", startDate: "2026-09-28", startTime: "09:00", endTime: "17:30" } as Plan];
    expect(checkRows([row({})], existing, NOW)[0]!.warnings).toEqual(["This shift is already in the planner."]);
  });

  test("a missing date or time is an error, not just a warning", () => {
    expect(checkRows([row({ date: null })], [], NOW)[0]!.error).toBe("Needs a date");
    expect(checkRows([row({ endTime: null })], [], NOW)[0]!.error).toBe("Needs shift hours");
  });
});

// -------------------------------------------------------------- the API

describe("screenshot import over the API", () => {
  let fake: FakeNanoGpt;
  let dir: ReturnType<typeof tempDir>;
  let app: App;
  let call: ReturnType<typeof caller>;
  const image = Buffer.from("pretend this is a png").toString("base64");

  beforeEach(() => {
    fake = startFakeNanoGpt();
    dir = tempDir();
    app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => NOW });
    call = caller(app.fetch);
  });

  afterEach(() => {
    app.store.close();
    fake.stop();
    dir.cleanup();
  });

  test("sends the picture to the screenshot profile and returns checked rows", async () => {
    const vision = app.store.profiles.create({ name: "Gemini", model: "google/gemini-flash" });
    await call("PUT", "/api/settings", { screenshotAssignment: `profile:${vision.id}` });
    fake.replies.push({
      content:
        '```json\n{"shifts": [{"weekday": "Mon", "date": "9/28", "type": "regular", "start": "9:00a", "end": "5:30p", "drawStart": null, "drawEnd": null}, {"weekday": "Tue", "date": "9/29", "type": "oncall", "start": "08:00", "end": "20:00"}]}\n```',
    });

    const { status, data } = await call("POST", "/api/screenshots/read", { image, mimeType: "image/png" });
    expect(status).toBe(200);
    expect(data.profile).toBe("Gemini");
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ date: "2026-09-28", startTime: "09:00", endTime: "17:30", warnings: ["Regular shift with no draw hours."] });
    expect(data.rows[1]).toMatchObject({ shiftType: "oncall", shiftMinutes: 720, warnings: [] });

    const request = fake.requests[0]! as any;
    expect(request.model).toBe("google/gemini-flash");
    expect(request.messages[0].content).toContain("It's Saturday, September 26, 2026");
    const parts = request.messages[1].content;
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } });
  });

  test("a model that can't read images gets a clear error", async () => {
    fake.replies.push({ content: "Sorry, I can't see images." });
    const { status, data } = await call("POST", "/api/screenshots/read", { image, mimeType: "image/png" });
    expect(status).toBe(502);
    expect(data.error).toContain("Is it a vision model?");
  });

  test("the picture is checked", async () => {
    expect((await call("POST", "/api/screenshots/read", { image, mimeType: "application/pdf" })).status).toBe(400);
    expect((await call("POST", "/api/screenshots/read", { image: "", mimeType: "image/png" })).status).toBe(400);
  });

  test("edited rows are checked again", async () => {
    const rows = [row({ drawStart: null, drawEnd: null }), { date: "nope", startTime: "9am", shiftType: "party" }];
    const { data } = await call("POST", "/api/screenshots/check", { rows });
    expect(data.rows[0].warnings).toEqual(["Regular shift with no draw hours."]);
    expect(data.rows[1]).toMatchObject({ date: null, startTime: null, shiftType: "regular", error: "Needs a date" });
  });

  test("saving makes checked shifts from the screenshot, all or nothing", async () => {
    const events: string[] = [];
    app.events.listen((e) => events.push(e.type));
    const rows = [row({}), row({ date: "2026-09-29", startTime: "22:00", endTime: "06:00", drawStart: null, drawEnd: null, weekdayRead: "Tue" })];
    const { data } = await call("POST", "/api/screenshots/save", { rows });
    expect(data.plans).toHaveLength(2);
    expect(data.plans[1]).toMatchObject({ kind: "shift", title: "Work", checked: true, source: "screenshot", endDate: "2026-09-30" });
    expect(events).toEqual(["plans"]);

    const bad = await call("POST", "/api/screenshots/save", { rows: [row({ date: "2026-10-05" }), row({ date: null })] });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("Row 2: needs a date.");
    expect(app.store.plans.list()).toHaveLength(2); // nothing more was saved
  });

  test("meetings are saved without draw hours", async () => {
    const { data } = await call("POST", "/api/screenshots/save", { rows: [row({ shiftType: "meeting" })] });
    expect(data.plans[0]).toMatchObject({ title: "Meeting", shiftType: "meeting", drawStart: null });
  });
});
