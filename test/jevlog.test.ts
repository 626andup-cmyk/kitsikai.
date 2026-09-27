/**
 * Tests for the Jev log (src/jevlog.ts): every Jev call from the last 36
 * hours, exactly as sent and received, and GET /api/jev/log.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { JevCall } from "../src/jev.ts";
import { JEV_LOG_HOURS } from "../src/jevlog.ts";
import { createApp, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
/** The app's clock: Saturday, September 26, 2026, 4 PM, until a test moves it. */
let time: Date;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  time = new Date(2026, 8, 26, 16, 0);
  app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => time });
  call = caller(app.fetch);
  app.store.updateSettings({ replyDebounceSeconds: 0 });
  general = app.store.listChannels()[0]!;
});

afterEach(async () => {
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const later = (minutes: number) => {
  time = new Date(time.getTime() + minutes * 60_000);
};

const jevCall = (purpose: string, extra: Partial<JevCall> = {}): JevCall => ({
  purpose,
  model: "typesafe/jev-1.13",
  request: { model: "typesafe/jev-1.13", messages: [{ role: "user", content: "state" }] },
  response: '{"answers": {}}',
  error: null,
  answeredBy: "jev",
  summary: "q1: yes (95%)",
  fallback: null,
  durationMs: 700,
  ...extra,
});

describe("the log", () => {
  test("keeps each call as it was, newest first", () => {
    const log = app.store.jevLog;
    log.add(jevCall("Scratchpad check"), time);
    later(1);
    const fallback = { profile: "Steady", model: "steady/model", messages: [{ role: "user" as const, content: "state" }], response: "{}", error: null };
    log.add(jevCall("Processing", { error: "HTTP 503", answeredBy: "fallback", fallback }), time);
    const [newest, oldest] = log.recent(time);
    expect(newest).toMatchObject({ purpose: "Processing", error: "HTTP 503", answeredBy: "fallback", fallback, at: time.toISOString() });
    expect(oldest).toMatchObject({ ...jevCall("Scratchpad check"), at: new Date(time.getTime() - 60_000).toISOString() });
    expect(log.recent(time, { errorsOnly: true }).map((c) => c.purpose)).toEqual(["Processing"]);
  });

  test(`rolls: calls older than ${JEV_LOG_HOURS} hours go`, () => {
    const log = app.store.jevLog;
    log.add(jevCall("first"), time);
    later(12 * 60);
    log.add(jevCall("second"), time);
    later(24 * 60); // 36 hours after the first
    expect(log.recent(time).map((c) => c.purpose)).toEqual(["second", "first"]);
    later(1);
    expect(log.recent(time).map((c) => c.purpose)).toEqual(["second"]);
    // Adding lets go of old calls too.
    later(12 * 60);
    log.add(jevCall("third"), time);
    expect(log.recent(time).map((c) => c.purpose)).toEqual(["third"]);
  });
});

describe("GET /api/jev/log", () => {
  test("every call the app makes, with what asked", async () => {
    await call("POST", `/api/channels/${general.id}/messages`, { content: "[message]" });
    await app.replies.flush();
    await call("POST", "/api/jev/test", {});
    const { status, data } = await call("GET", "/api/jev/log");
    expect(status).toBe(200);
    expect(data.hours).toBe(36);
    expect(data.calls.map((c: JevCall) => c.purpose)).toEqual(["Test Jev", "Intimacy register", "Scratchpad check"]);
    const scratchpad = data.calls[2];
    expect(scratchpad.request.messages[0].content).toContain("them (NEW): [message]");
    expect(scratchpad.answeredBy).toBe("jev");
    expect(JSON.parse(scratchpad.response).choices[0].message.content).toContain('"answers"');
  });

  test("?errors=1: only the calls that went wrong", async () => {
    fake.jevReplies.push({ status: 503, error: "Model unavailable" });
    await call("POST", "/api/jev/test", {});
    await call("POST", "/api/jev/test", {});
    const { data } = await call("GET", "/api/jev/log?errors=1");
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0]).toMatchObject({ purpose: "Test Jev", answeredBy: null, response: '{"error":{"message":"Model unavailable"}}' });
  });
});
