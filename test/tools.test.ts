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
  test("are the binder lookups, keeping trackers, her notes (stage 7), and do_nothing", () => {
    expect(TOOL_NAMES).toEqual([
      "look_up_plans",
      "find_plans",
      "list_trackers",
      "look_up_log",
      "make_tracker",
      "log_sticker",
      "remove_sticker",
      "read_channel",
      "search_history",
      "jot_note",
      "look_in_drawer",
      "do_nothing",
    ]);
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

describe("keeping their trackers, like they can", () => {
  /** Your message this turn answers. */
  const yours = (content: string) => app.store.addMessage({ channelId: general.id, author: "user", content, createdAt: new Date(2026, 8, 28, 10, 59).toISOString() });
  const stickers = () => app.store.trackers.entries().map((e) => ({ date: e.date, value: e.value, source: e.source }));

  test("make_tracker: a new tracker, with what it records, hint words, and whether she may bring it up", () => {
    const events: any[] = [];
    ctx.events = app.events;
    app.events.listen((e) => events.push(e));
    const made = run("make_tracker", { name: " Migraine ", records: "1 to 10", hint_words: ["Head hurts", "migraine"], may_bring_up: false });
    expect(made).toMatchObject({ ok: true, summary: "made a tracker: Migraine (1 to 10)" });
    expect(made.result).toMatchObject({ made: { name: "Migraine", records: "1 to 10", hint_words: ["head hurts", "migraine"], you_may_bring_it_up: false } });
    expect(app.store.trackers.list()).toEqual([expect.objectContaining({ name: "Migraine", kind: "scale", canBringUp: false })]);
    expect(events).toContainEqual({ type: "log" });

    // Other ways to say what it records; she may bring it up unless told otherwise.
    expect(run("make_tracker", { name: "meds", records: "yes/no" }).ok).toBe(true);
    expect(run("make_tracker", { name: "payday", records: "a note" }).ok).toBe(true);
    expect(app.store.trackers.list().map((t) => [t.name, t.kind, t.canBringUp])).toEqual([
      ["Migraine", "scale", false],
      ["meds", "yesno", true],
      ["payday", "note", true],
    ]);
  });

  test("make_tracker: explains mistakes, and won't make the same one twice", () => {
    run("make_tracker", { name: "headache", records: "1 to 10" });
    expect(run("make_tracker", { name: "Headache", records: "yes or no" }).summary).toBe('There\'s already a tracker called "headache" (1 to 10). Log to it with log_sticker.');
    expect(run("make_tracker", { name: "gym", records: "sometimes" }).summary).toBe('"records" must be one of: "yes or no", "1 to 10", "a note".');
    expect(run("make_tracker", { records: "a note" }).summary).toBe('"name" is required.');
    expect(run("make_tracker", { name: "gym", records: "yes or no", hint_words: "lifting" }).summary).toBe('"hint_words" must be a list of words.');
    expect(run("make_tracker", { name: "x".repeat(61), records: "yes or no" }).summary).toContain("60 characters");
    expect(app.store.trackers.list()).toHaveLength(1);
  });

  test("log_sticker: a sticker on today, as hers, linked to your message", () => {
    const events: any[] = [];
    ctx.events = app.events;
    app.events.listen((e) => events.push(e));
    const headache = app.store.trackers.create({ name: "headache", kind: "scale" });
    const message = yours("my head is killing me, like a 7");
    const logged = run("log_sticker", { tracker: "headache", value: 7 });
    expect(logged).toMatchObject({ ok: true, summary: "logged headache 7/10 for Mon, Sep 28", result: { logged: "Mon, Sep 28: headache 7/10" } });
    expect(app.store.trackers.entries({ trackerId: headache.id })).toEqual([
      expect.objectContaining({ date: "2026-09-28", value: "7", source: "kitsikai", messageId: message.id }),
    ]);
    expect(events).toContainEqual({ type: "log" });
    // look_up_log tells her it was her.
    expect(run("look_up_log").result).toEqual([{ entry: "Mon, Sep 28: headache 7/10", how: "you logged it yourself" }]);
  });

  test("log_sticker: yesterday or a date, never the future; mistakes are explained", () => {
    app.store.trackers.create({ name: "took meds", kind: "yesno" });
    app.store.trackers.create({ name: "headache", kind: "scale" });
    expect(run("log_sticker", { tracker: "meds", value: "Yes", date: "yesterday" }).summary).toBe("logged took meds yes for Sun, Sep 27");
    expect(run("log_sticker", { tracker: "took meds", value: "no", date: "2026-09-20" }).ok).toBe(true);
    expect(run("log_sticker", { tracker: "took meds", value: "yes", date: "tomorrow" }).summary).toBe("Stickers are for what happened: pick today or a day before.");
    expect(run("log_sticker", { tracker: "headache", value: "11" }).summary).toBe("A scale tracker's value must be a whole number from 1 to 10.");
    expect(run("log_sticker", { tracker: "gym", value: "yes" }).summary).toContain('There\'s no tracker called "gym"');
    expect(run("log_sticker", { tracker: "headache" }).summary).toBe('"value" is required.');
    expect(stickers()).toEqual([
      { date: "2026-09-27", value: "yes", source: "kitsikai" },
      { date: "2026-09-20", value: "no", source: "kitsikai" },
    ]);
  });

  test("log_sticker: the same tracker and day again changes it, even one you added; the same value changes nothing", () => {
    const headache = app.store.trackers.create({ name: "headache", kind: "scale" });
    app.store.trackers.addEntry({ trackerId: headache.id, date: "2026-09-28", value: 6 });
    expect(run("log_sticker", { tracker: "headache", value: "6" })).toMatchObject({ summary: "already had headache 6/10 for Mon, Sep 28", result: { already: "Mon, Sep 28: headache 6/10" } });
    expect(stickers()).toEqual([{ date: "2026-09-28", value: "6", source: "user" }]);

    const message = yours("ok it's more like a 9 now");
    expect(run("log_sticker", { tracker: "headache", value: "9" })).toMatchObject({ summary: "changed headache 9/10 for Mon, Sep 28", result: { changed: "Mon, Sep 28: headache 9/10", was: "6" } });
    expect(app.store.trackers.entries()).toEqual([expect.objectContaining({ value: "9", source: "kitsikai", messageId: message.id })]);
  });

  test("remove_sticker: takes one off a day, and explains when there's none", () => {
    const meds = app.store.trackers.create({ name: "took meds", kind: "yesno" });
    app.store.trackers.addEntry({ trackerId: meds.id, date: "2026-09-27", value: "yes" });
    app.store.trackers.addEntry({ trackerId: meds.id, date: "2026-09-28", value: "yes" });
    expect(run("remove_sticker", { tracker: "took meds" })).toMatchObject({ ok: true, summary: "took off took meds yes for Mon, Sep 28", result: { removed: "Mon, Sep 28: took meds yes" } });
    expect(stickers()).toEqual([{ date: "2026-09-27", value: "yes", source: "user" }]);
    expect(run("remove_sticker", { tracker: "took meds" }).summary).toBe("There's no took meds sticker on Mon, Sep 28.");
    expect(run("remove_sticker", { tracker: "took meds", date: "yesterday" }).ok).toBe(true);
    expect(stickers()).toEqual([]);
  });

  test("her pencil notes about the same tracker and day are settled, so processing won't log them again", () => {
    const headache = app.store.trackers.create({ name: "headache", kind: "scale" });
    const note = (date: string, value: string) =>
      app.store.memory.addNote({ kind: "tracker", text: `headache ${value}/10`, origin: "noticed", channelId: general.id, trackerId: headache.id, date, value }, NOW);
    const today = note("2026-09-28", "7");
    const other = note("2026-09-27", "4");
    run("log_sticker", { tracker: "headache", value: "7" });
    expect(app.store.memory.getNote(today.id).status).toBe("done");
    expect(app.store.memory.getNote(other.id).status).toBe("open");
    expect(app.store.memory.recentLog()[0]).toMatchObject({ action: "committed", text: "headache 7/10", reason: "you logged it yourself" });

    // Taking a sticker off tosses the note about it too.
    const again = note("2026-09-28", "7");
    run("remove_sticker", { tracker: "headache" });
    expect(app.store.memory.getNote(again.id).status).toBe("tossed");
    expect(app.store.memory.recentLog()[0]).toMatchObject({ action: "tossed", reason: "you took the sticker off" });
  });

  test("in a turn: she logs it, and the line under her reply says so", async () => {
    app.store.profiles.update(app.store.profiles.list()[0]!.id, { supportsTools: true });
    app.store.trackers.create({ name: "headache", kind: "scale" });
    const message = yours("headache again, a 5 today");
    fake.replies.push({ toolCalls: [{ name: "log_sticker", arguments: { tracker: "headache", value: "5" } }] }, { content: "ugh, noted" });
    const { data } = await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(data.toolCalls[0]).toMatchObject({ name: "log_sticker", status: "ok", summary: "logged headache 5/10 for Mon, Sep 28" });
    expect(app.store.trackers.entries()).toEqual([expect.objectContaining({ value: "5", source: "kitsikai", messageId: message.id })]);
    expect(fake.requests[0]!.messages[0]!.content).toContain("put a sticker on a day when they tell you how it went (log_sticker)");
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
