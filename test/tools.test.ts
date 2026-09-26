/**
 * Tests for stage 6: her tools (src/tools.ts), the tool loop in her turn
 * (src/kitsikai.ts), the tool log, and today's and tomorrow's plans in the
 * prompt (src/binder.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeOccurrence, todayAndTomorrow, workStatus } from "../src/binder.ts";
import { MAX_ROUNDS } from "../src/kitsikai.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, TOOL_NAMES, type ToolContext } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

/** Monday, September 28, 2026, 11 AM. */
const NOW = new Date(2026, 8, 28, 11, 0);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let ctx: ToolContext;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => NOW });
  call = caller(app.fetch);
  general = app.store.listChannels()[0]!;
  ctx = { store: app.store, channel: general, now: NOW };
});

afterEach(async () => {
  await app.replies.flush();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

/** Run a tool and return its outcome. */
const run = (name: string, args: Record<string, unknown> = {}) => runTool(ctx, name, args);

describe("the tools", () => {
  test("are the binder lookups, and do_nothing", () => {
    expect(TOOL_NAMES).toEqual(["look_up_plans", "find_plans", "list_trackers", "look_up_log", "read_channel", "do_nothing"]);
  });

  test("look_up_plans: plans between two dates, described", () => {
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-10-01", startTime: "22:00", endTime: "06:00", drawStart: "23:00", drawEnd: "03:00" });
    app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-02", startTime: "15:00" });
    const outcome = run("look_up_plans", { from: "2026-10-01", to: "2026-10-07" });
    expect(outcome).toMatchObject({ ok: true, summary: "looked up plans for Oct 1–7" });
    expect(outcome.result).toEqual([
      { day: "Thu, Oct 1", date: "2026-10-01", plan: "Work (shift) 10:00p–6:00a, 8h, draw 11:00p–3:00a (4h) (not confirmed yet)" },
      { day: "Fri, Oct 2", date: "2026-10-02", plan: "Appointment: Dentist, 3:00p (not confirmed yet)" },
    ]);
    expect(run("look_up_plans", { from: "today", to: "tomorrow", kind: "birthday" }).result).toEqual({
      note: "Nothing planned between Mon, Sep 28 and Tue, Sep 29.",
    });
  });

  test("look_up_plans: explains mistakes so the model can fix them", () => {
    expect(run("look_up_plans", { from: "next week", to: "2026-10-01" })).toMatchObject({ ok: false });
    expect(run("look_up_plans", { from: "2026-10-05", to: "2026-10-01" }).summary).toContain("on or after");
    expect(run("look_up_plans", { from: "2026-01-01", to: "2026-12-31" }).summary).toContain("more than 92 days");
    expect(run("look_up_plans", { from: "today", to: "today", kind: "party" }).summary).toContain("kind");
  });

  test("find_plans: when a plan happens next (or last)", () => {
    app.store.plans.create({ kind: "birthday", title: "Mia's birthday", startDate: "2020-10-02", repeats: "yearly", checked: true });
    app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-09-01", startTime: "10:00", checked: true });
    expect(run("find_plans", { query: "mia" }).result).toEqual([
      { when: "next", day: "Fri, Oct 2", date: "2026-10-02", plan: "Birthday: Mia's birthday, all day, every year" },
    ]);
    expect(run("find_plans", { query: "dentist" }).result).toEqual([
      { when: "last", day: "Tue, Sep 1", date: "2026-09-01", plan: "Appointment: Dentist, 10:00a" },
    ]);
    expect(run("find_plans", { query: "gym" }).result).toEqual({ note: 'No plans mention "gym".' });
  });

  test("list_trackers and look_up_log", () => {
    const headache = app.store.trackers.create({ name: "headache", kind: "scale", hintWords: ["head"] });
    const meds = app.store.trackers.create({ name: "meds", kind: "yesno", canBringUp: false });
    app.store.trackers.addEntry({ trackerId: headache.id, date: "2026-09-26", value: 6 });
    app.store.trackers.addEntry({ trackerId: meds.id, date: "2026-09-27", value: "yes", source: "confirmed" });

    expect(run("list_trackers").result).toEqual([
      { name: "headache", records: "1 to 10", hint_words: ["head"], you_may_bring_it_up: true },
      { name: "meds", records: "yes or no", hint_words: [], you_may_bring_it_up: false },
    ]);
    expect(run("look_up_log").result).toEqual([
      { entry: "Sun, Sep 27: meds yes", how: "you asked and they confirmed" },
      { entry: "Sat, Sep 26: headache 6/10", how: "they logged it" },
    ]);
    const onlyHeadaches = run("look_up_log", { tracker: "Headache", from: "2026-09-01", to: "2026-09-30" });
    expect(onlyHeadaches.summary).toBe("checked the headache log for Sep 1–30");
    expect(run("look_up_log", { tracker: "gym" }).summary).toContain('There\'s no tracker called "gym"');
  });

  test("read_channel: another channel's latest messages", () => {
    const gaming = app.store.createChannel({ name: "gaming", kind: "text" });
    app.store.addMessage({ channelId: gaming.id, author: "user", content: "finally beat the boss", createdAt: new Date(2026, 8, 28, 10, 30).toISOString() });
    app.store.addMessage({ channelId: gaming.id, author: "kitsikai", content: "LETS GO", createdAt: new Date(2026, 8, 28, 10, 31).toISOString() });
    expect(run("read_channel", { channel: "#gaming" })).toMatchObject({
      ok: true,
      summary: "read #gaming",
      result: [
        { from: "them", text: "finally beat the boss", when: "30 minutes ago" },
        { from: "you", text: "LETS GO", when: "29 minutes ago" },
      ],
    });
    expect(run("read_channel", { channel: "general" }).summary).toContain("That's this channel");
    expect(run("read_channel", { channel: "planner" }).summary).toContain("no text channel called #planner");
  });

  test("unknown tools are explained", () => {
    expect(run("book_flight").summary).toContain('There\'s no tool called "book_flight"');
  });
});

describe("today and tomorrow, always in view", () => {
  test("every plan for both days, and whether they're at work", () => {
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-09-28", startTime: "09:00", endTime: "17:30", drawStart: "10:00", drawEnd: "14:00", checked: true });
    app.store.plans.create({ kind: "hangout", title: "Movies", startDate: "2026-09-29", startTime: "19:00" });
    expect(todayAndTomorrow(app.store, NOW)).toBe(
      [
        "Today, Mon, Sep 28:",
        "- Work (shift) 9:00a–5:30p, 8h 30m, draw 10:00a–2:00p (4h)",
        "Tomorrow, Tue, Sep 29:",
        "- Hangout: Movies, 7:00p (not confirmed yet)",
        "They're at work right now, until 5:30 PM.",
      ].join("\n"),
    );
  });

  test("an overnight shift from yesterday still shows today", () => {
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-09-27", startTime: "22:00", endTime: "06:00", checked: true });
    const early = new Date(2026, 8, 28, 3, 0);
    const text = todayAndTomorrow(app.store, early);
    expect(text).toContain("- Work (shift) 10:00p–6:00a, 8h, no draw hours (started Sun, Sep 27)");
    expect(text).toContain("They're at work right now, until 6:00 AM.");
  });

  test("on-call is described as free unless called in", () => {
    const oncall = app.store.plans.create({ kind: "shift", shiftType: "oncall", title: "On call", startDate: "2026-09-28", startTime: "08:00", endTime: "20:00", checked: true });
    expect(workStatus(app.store, NOW)).toBe("They're on call until 8:00 PM: free unless they get called in.");
    expect(workStatus(app.store, NOW, new Set([`${oncall.id}:2026-09-28`]))).toBe("They're at work right now, until 8:00 PM.");
    const [occurrence] = app.store.plans.occurrences("2026-09-28", "2026-09-28");
    expect(describeOccurrence(occurrence!)).toBe("On call (on call) 8:00a–8:00p, 12h, free unless they get called in");
  });

  test("is in the prompt, with the tool guidance when the profile can use tools", async () => {
    app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-09-29", startTime: "15:00", checked: true });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain("## Today and tomorrow");
    expect(system).toContain("- Appointment: Dentist, 3:00p");
    expect(system).toContain("## Tools");
    expect(fake.requests[0]!.tools!.map((t) => t.function.name)).toEqual(TOOL_NAMES);

    const [profile] = app.store.profiles.list();
    app.store.profiles.update(profile!.id, { supportsTools: false });
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(fake.requests[1]!.messages[0]!.content).not.toContain("## Tools");
    expect(fake.requests[1]!.tools).toBeUndefined();
  });
});

describe("the tool loop", () => {
  test("runs her lookups, sends back the results, and saves her reply with its actions", async () => {
    app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-10-05", startTime: "09:00", endTime: "17:00", checked: true });
    const events: any[] = [];
    app.events.listen((e) => events.push(e));
    fake.replies.push(
      { toolCalls: [{ name: "look_up_plans", arguments: { from: "2026-10-05", to: "2026-10-11" } }] },
      { content: "ooh you're working monday<cht>9 to 5 at least" },
    );

    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.kitsikaiMessages.map((m: { content: string }) => m.content)).toEqual(["ooh you're working monday", "9 to 5 at least"]);
    expect(data.toolCalls).toHaveLength(1);
    expect(data.toolCalls[0]).toMatchObject({ name: "look_up_plans", status: "ok", source: "native", round: 0, summary: "looked up plans for Oct 5–11" });
    // The turn's messages and its tool calls share a turn id.
    expect(data.toolCalls[0].turnId).toBe(data.kitsikaiMessages[0].turnId);

    // The second request carried the model's call and the result.
    const second = fake.requests[1]!.messages as any[];
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "look_up_plans" } }] });
    expect(second.at(-1).role).toBe("tool");
    expect(JSON.parse(second.at(-1).content)[0].plan).toContain("Work (shift) 9:00a–5:00p");

    const reply = events.find((e) => e.type === "messages" && e.messages.length);
    expect(reply.toolCalls).toHaveLength(1);
    const log = await call("GET", `/api/channels/${general.id}/tool-log`);
    expect(log.data.toolCalls).toHaveLength(1);
    expect((await call("GET", `/api/channels/${general.id}/messages`)).data.toolCalls).toHaveLength(1);
  });

  test("finds tool calls written as text, and keeps them out of her reply", async () => {
    fake.replies.push(
      { content: 'let me think <tool_call>{"name": "list_trackers", "arguments": {}}</tool_call>' },
      { content: "you haven't asked me to track anything yet!" },
    );
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.toolCalls[0]).toMatchObject({ name: "list_trackers", source: "text", status: "ok" });
    expect(data.kitsikaiMessages.map((m: { content: string }) => m.content)).toEqual(["you haven't asked me to track anything yet!"]);
    // Results of text calls go back as a user message.
    expect((fake.requests[1]!.messages.at(-1) as any).content).toStartWith("(Tool results)");
  });

  test("broken arguments are explained back to the model", async () => {
    fake.replies.push({ toolCalls: [{ name: "look_up_plans", arguments: "{from: today" }] }, { content: "oops, anyway hi" });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.toolCalls[0].status).toBe("error");
    expect(data.toolCalls[0].summary).toContain("aren't valid JSON");
    expect(data.kitsikaiMessages[0].content).toBe("oops, anyway hi");
  });

  test("do_nothing ends the turn without a message; the app still hears what she did", async () => {
    const events: any[] = [];
    app.events.listen((e) => events.push(e));
    fake.replies.push({ toolCalls: [{ name: "do_nothing", arguments: { reason: "they're asleep" } }] });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data).toMatchObject({ kitsikaiMessages: [], skipped: true });
    expect(data.toolCalls[0].summary).toBe("chose not to reply (they're asleep)");
    expect(app.store.getMessages(general.id)).toEqual([]);
    expect(events.find((e) => e.type === "messages")).toMatchObject({ messages: [], toolCalls: [{ name: "do_nothing" }] });
  });

  test("the last round offers no tools, so she has to write", async () => {
    for (let i = 0; i < MAX_ROUNDS - 1; i++) fake.replies.push({ toolCalls: [{ name: "list_trackers", arguments: {} }] });
    fake.replies.push({ content: "ok ok, done looking" });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(fake.requests).toHaveLength(MAX_ROUNDS);
    expect(fake.requests.at(-1)!.tools).toBeUndefined();
    expect(data.kitsikaiMessages[0].content).toBe("ok ok, done looking");
  });

  test("a regeneration replaces her reply, and keeps the new turn's actions", async () => {
    app.store.addMessage({ channelId: general.id, author: "user", content: "what's my week like" });
    app.store.addTurn([{ channelId: general.id, author: "kitsikai", content: "no idea lol" }]);
    fake.replies.push({ toolCalls: [{ name: "look_up_plans", arguments: { from: "today", to: "2026-10-04" } }] }, { content: "pretty chill actually" });
    const { data } = await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(data.replacedIds).toHaveLength(1);
    expect(data.toolCalls).toHaveLength(1);
    expect(app.store.getMessages(general.id).map((m) => m.content)).toEqual(["what's my week like", "pretty chill actually"]);
  });
});
