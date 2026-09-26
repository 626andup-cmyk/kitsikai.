/**
 * Tests for trackers and log entries (src/trackers.ts): user-defined data.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server.ts";
import { checkValue } from "../src/trackers.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

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

describe("values are checked against their tracker's kind", () => {
  test("yes/no", () => {
    expect(checkValue("yesno", "Yes")).toBe("yes");
    expect(checkValue("yesno", false)).toBe("no");
    expect(() => checkValue("yesno", "maybe")).toThrow(/"yes" or "no"/);
  });

  test("a scale from 1 to 10", () => {
    expect(checkValue("scale", " 7 ")).toBe("7");
    expect(checkValue("scale", 10)).toBe("10");
    expect(() => checkValue("scale", 11)).toThrow(/1 to 10/);
    expect(() => checkValue("scale", "6.5")).toThrow(/whole number/);
    expect(() => checkValue("scale", "loads")).toThrow(/whole number/);
  });

  test("a note", () => {
    expect(checkValue("note", "  $1,240  ")).toBe("$1,240");
    expect(() => checkValue("note", "   ")).toThrow(/can't be empty/);
    expect(() => checkValue("note", "x".repeat(1001))).toThrow(/1000 characters/);
  });
});

describe("trackers", () => {
  test("a new server has a trackers channel, after the planner", () => {
    expect(app.store.listChannels().map((c) => c.kind)).toEqual(["text", "planner", "trackers"]);
  });

  test("can be made with hint words and whether she can bring them up, and changed", async () => {
    const made = await call("POST", "/api/trackers", {
      name: " headache ",
      kind: "scale",
      hintWords: ["Head", "migraine", "head", ""],
      canBringUp: false,
    });
    expect(made.data.tracker).toMatchObject({ name: "headache", kind: "scale", hintWords: ["head", "migraine"], canBringUp: false });
    const id = made.data.tracker.id;
    const changed = await call("PATCH", `/api/trackers/${id}`, { name: "headaches", canBringUp: true });
    expect(changed.data.tracker).toMatchObject({ name: "headaches", canBringUp: true, hintWords: ["head", "migraine"] });
    expect((await call("GET", "/api/trackers")).data.trackers).toHaveLength(1);
  });

  test("are checked", async () => {
    expect((await call("POST", "/api/trackers", { name: "", kind: "yesno" })).status).toBe(400);
    expect((await call("POST", "/api/trackers", { name: "x", kind: "rating" })).status).toBe(400);
    expect((await call("POST", "/api/trackers", { name: "x", kind: "yesno", hintWords: "head" })).status).toBe(400);
    expect((await call("POST", "/api/trackers", { name: "x", kind: "yesno", canBringUp: "no" })).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `word${i}`);
    expect((await call("POST", "/api/trackers", { name: "x", kind: "yesno", hintWords: many })).status).toBe(400);
  });

  test("a tracker's kind can only change while it has no entries", async () => {
    const tracker = app.store.trackers.create({ name: "meds", kind: "yesno" });
    expect((await call("PATCH", `/api/trackers/${tracker.id}`, { kind: "note" })).data.tracker.kind).toBe("note");
    app.store.trackers.addEntry({ trackerId: tracker.id, date: "2026-09-28", value: "took them late" });
    const refused = await call("PATCH", `/api/trackers/${tracker.id}`, { kind: "yesno" });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain("once it has entries");
  });

  test("deleting a tracker deletes its entries", async () => {
    const tracker = app.store.trackers.create({ name: "meds", kind: "yesno" });
    app.store.trackers.addEntry({ trackerId: tracker.id, date: "2026-09-28", value: "yes" });
    await call("DELETE", `/api/trackers/${tracker.id}`, {});
    expect(app.store.trackers.entries()).toEqual([]);
    expect((await call("DELETE", `/api/trackers/${tracker.id}`, {})).status).toBe(404);
  });
});

describe("log entries", () => {
  test("stickers on days: added, listed newest first, filtered, changed and deleted", async () => {
    const events: string[] = [];
    app.events.listen((e) => events.push(e.type));
    const headache = app.store.trackers.create({ name: "headache", kind: "scale" });
    const meds = app.store.trackers.create({ name: "meds", kind: "yesno" });

    const first = await call("POST", "/api/log", { trackerId: headache.id, date: "2026-09-26", value: 6 });
    expect(first.data.entry).toMatchObject({ value: "6", source: "user", messageId: null });
    await call("POST", "/api/log", { trackerId: meds.id, date: "2026-09-28", value: "yes" });
    await call("POST", "/api/log", { trackerId: headache.id, date: "2026-09-30", value: "3" });

    const all = await call("GET", "/api/log");
    expect(all.data.entries.map((e: { date: string }) => e.date)).toEqual(["2026-09-30", "2026-09-28", "2026-09-26"]);
    const range = await call("GET", `/api/log?from=2026-09-27&to=2026-09-30&tracker=${headache.id}`);
    expect(range.data.entries.map((e: { value: string }) => e.value)).toEqual(["3"]);

    const id = first.data.entry.id;
    expect((await call("PATCH", `/api/log/${id}`, { value: "8", date: "2026-09-25" })).data.entry).toMatchObject({ value: "8", date: "2026-09-25" });
    expect((await call("PATCH", `/api/log/${id}`, { value: "11" })).status).toBe(400);
    expect((await call("DELETE", `/api/log/${id}`, {})).status).toBe(200);
    expect(events.filter((e) => e === "log")).toHaveLength(5);
  });

  test("are checked", async () => {
    const meds = app.store.trackers.create({ name: "meds", kind: "yesno" });
    expect((await call("POST", "/api/log", { trackerId: "nope", date: "2026-09-28", value: "yes" })).status).toBe(404);
    expect((await call("POST", "/api/log", { trackerId: meds.id, date: "someday", value: "yes" })).status).toBe(400);
    expect((await call("POST", "/api/log", { trackerId: meds.id, date: "2026-09-28", value: "kind of" })).status).toBe(400);
    expect((await call("GET", "/api/log?from=yesterday")).status).toBe(400);
    expect((await call("GET", "/api/log?tracker=nope")).status).toBe(404);
  });

  test("remember the message they came from, and keep going if it's deleted", async () => {
    const channel = app.store.listChannels()[0]!;
    const message = app.store.addMessage({ channelId: channel.id, author: "user", content: "ugh my head" });
    const headache = app.store.trackers.create({ name: "headache", kind: "yesno" });
    const entry = app.store.trackers.addEntry({ trackerId: headache.id, date: "2026-09-28", value: "yes", source: "processing", messageId: message.id });
    expect((await call("GET", `/api/messages/${entry.messageId}`)).data.message.content).toBe("ugh my head");
    app.store.deleteMessage(message.id);
    expect(app.store.trackers.getEntry(entry.id)).toMatchObject({ messageId: null, source: "processing" });
  });
});
