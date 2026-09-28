/**
 * Tests for planner changes she makes (src/planchanges.ts): her add_plan,
 * change_plan and remove_plan tools, Jev asked whether she should, your yes
 * in chat or with a tap, and what she's told.
 *
 * The fake Jev answers "asked" (did they ask for it?) with "no" unless a
 * test says otherwise, and planner-change questions in the scratchpad check
 * with "not answered".
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ServerEvent } from "../src/events.ts";
import { promptForChannel } from "../src/kitsikai.ts";
import { describePlan, type PlanChange } from "../src/planchanges.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, type ToolContext } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { caller, startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt, type JevReply } from "./helpers.ts";

setDefaultTimeout(15_000);

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let call: ReturnType<typeof caller>;
let general: Channel;
let events: ServerEvent[];
/** Monday, September 28, 2026, 11 AM, until a test moves it. */
let time: Date;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  time = new Date(2026, 8, 28, 11, 0);
  app = createApp(testConfig(dir.path, fake.baseUrl), { now: () => time });
  call = caller(app.fetch);
  app.store.updateSettings({ replyDebounceSeconds: 0 });
  app.store.profiles.update(app.store.profiles.list()[0]!.id, { supportsTools: true });
  general = app.store.listChannels()[0]!;
  events = [];
  app.events.listen((e) => events.push(e));
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

/** Jev's answers, by question id, whichever call they're in. */
function jev(answers: JevReply) {
  fake.jev = (request) => Object.fromEntries(request.questions.filter((q) => q.id in answers).map((q) => [q.id, (answers as Record<string, string>)[q.id]!]));
}

const ctx = (): ToolContext => ({ store: app.store, channel: general, now: time, events: app.events, decider: app.decider, turnId: "turn-1" });
const say = (content: string) => app.store.addMessage({ channelId: general.id, author: "user", content });
const changes = () => app.store.planChanges.forChannel(general.id);
const plans = () => app.store.plans.list().map((p) => ({ title: p.title, startDate: p.startDate, startTime: p.startTime }));
const changeEvents = () => events.filter((e): e is Extract<ServerEvent, { type: "plan-change" }> => e.type === "plan-change").map((e) => e.change);

const DENTIST = { kind: "appointment", title: "Dentist", date: "2026-10-01", start_time: "3pm" };

describe("Jev asks whether she should", () => {
  test("they asked for it: done at once", async () => {
    say("can you add my dentist thursday at 3");
    jev({ asked: "yes" });
    const outcome = await runTool(ctx(), "add_plan", DENTIST);
    expect(outcome).toMatchObject({
      ok: true,
      summary: "added Thu, Oct 1: Appointment: Dentist, 3:00p",
      result: { done: "Add: Thu, Oct 1: Appointment: Dentist, 3:00p" },
    });
    expect(app.store.plans.list()).toEqual([expect.objectContaining({ title: "Dentist", startDate: "2026-10-01", startTime: "15:00", checked: true, source: "chat" })]);
    expect(changes()).toEqual([expect.objectContaining({ action: "add", status: "applied", reason: "they asked for it (95% sure)", turnId: "turn-1", planId: app.store.plans.list()[0]!.id })]);
    expect(events).toContainEqual({ type: "plans" });

    // What Jev was asked.
    const request = fake.jevRequests.find((r) => r.questions[0]?.id === "asked")!;
    expect(request.questions[0]!.question).toContain("Did they ask Kitsikai to make exactly this change to their planner, or clearly say yes to it?");
    expect(request.state).toContain("them: can you add my dentist thursday at 3");
    expect(request.state).toContain("Kitsikai wants to change their planner:\nAdd: Thu, Oct 1: Appointment: Dentist, 3:00p");
    expect(app.store.jevLog.recent(time).map((c) => c.purpose)).toContain("Planner: did they ask for this?");
  });

  test("her idea: it waits for their yes, and she's told to ask", async () => {
    say("ugh my teeth hurt");
    const outcome = await runTool(ctx(), "add_plan", DENTIST);
    expect(outcome).toMatchObject({
      ok: true,
      summary: "offered to add Thu, Oct 1: Appointment: Dentist, 3:00p",
      result: { waiting: "Add: Thu, Oct 1: Appointment: Dentist, 3:00p" },
    });
    expect((outcome.result as { note: string }).note).toContain("ask them in your reply");
    expect(plans()).toEqual([]);
    expect(changes()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(changeEvents()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  test("unsure, or Jev off: it waits too", async () => {
    jev({ asked: { selected: "yes", p: 0.6 } });
    await runTool(ctx(), "add_plan", DENTIST);
    app.store.updateSettings({ decisionModel: "" });
    const asked = fake.jevRequests.length;
    await runTool(ctx(), "add_plan", { ...DENTIST, title: "Haircut" });
    expect(fake.jevRequests).toHaveLength(asked);
    expect(changes().map((c) => c.status)).toEqual(["pending", "pending"]);
    expect(plans()).toEqual([]);
  });
});

describe("your yes", () => {
  /** She offers the dentist in a reply; returns the change. */
  async function offer(): Promise<PlanChange> {
    fake.replies.push({ toolCalls: [{ name: "add_plan", arguments: DENTIST }] }, { content: "want me to put the dentist in for thursday at 3?" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "i need to see the dentist thursday at 3 i guess" });
    await app.replies.flush();
    return changes()[0]!;
  }

  test("in chat: Jev reads it in your next message, and it's done", async () => {
    const offered = await offer();
    expect(offered.status).toBe("pending");
    // Under her reply: its turn is the reply's.
    expect(offered.turnId).toBe(app.store.lastMessage(general.id)!.turnId);

    jev({ p1: "yes" });
    later(1);
    await call("POST", `/api/channels/${general.id}/messages`, { content: "yes please" });
    await app.replies.flush();
    const check = fake.jevRequests.find((r) => r.questions.some((q) => q.id === "p1"))!;
    expect(check.state).toContain("Changes to their planner Kitsikai offered, waiting for their yes:\n- p1: Add: Thu, Oct 1: Appointment: Dentist, 3:00p");
    expect(check.questions.find((q) => q.id === "p1")).toMatchObject({ options: ["yes", "no", "not answered"] });

    const done = app.store.planChanges.get(offered.id);
    expect(done).toMatchObject({ status: "applied", reason: "they said yes (95% sure)", messageId: app.store.getMessages(general.id).at(-2)!.id });
    expect(plans()).toEqual([{ title: "Dentist", startDate: "2026-10-01", startTime: "15:00" }]);
    // Her reply knows.
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain(
      "## Planner changes you offered\n\nRecently:\n- Add: Thu, Oct 1: Appointment: Dentist, 3:00p: done (they said yes (95% sure))",
    );
  });

  test("no, or no answer", async () => {
    const offered = await offer();
    await call("POST", `/api/channels/${general.id}/messages`, { content: "lol anyway" });
    await app.replies.flush();
    expect(app.store.planChanges.get(offered.id).status).toBe("pending");
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain(
      "## Planner changes you offered\n\nWaiting for their yes (ask, if you haven't):\n- Add: Thu, Oct 1: Appointment: Dentist, 3:00p",
    );

    jev({ p1: "no" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "nah don't" });
    await app.replies.flush();
    expect(app.store.planChanges.get(offered.id)).toMatchObject({ status: "declined", reason: "they said no (95% sure)" });
    expect(plans()).toEqual([]);
  });

  test("with a tap: Yes or No, once", async () => {
    const offered = await offer();
    expect((await call("GET", `/api/channels/${general.id}/messages`)).data.planChanges).toEqual([expect.objectContaining({ id: offered.id, status: "pending" })]);
    expect((await call("POST", `/api/plan-changes/${offered.id}`, { answer: "maybe" })).status).toBe(400);
    const tapped = await call("POST", `/api/plan-changes/${offered.id}`, { answer: "yes" });
    expect(tapped.data.change).toMatchObject({ status: "applied", reason: "you tapped Yes" });
    expect(plans()).toHaveLength(1);
    expect((await call("POST", `/api/plan-changes/${offered.id}`, { answer: "no" })).status).toBe(409);
    expect((await call("POST", "/api/plan-changes/nope", { answer: "no" })).status).toBe(404);
  });

  test("a day without an answer: dropped", async () => {
    const offered = await offer();
    later(24 * 60 + 1);
    expect(app.store.planChanges.pending(time)).toEqual([]);
    expect(app.store.planChanges.get(offered.id)).toMatchObject({ status: "expired", reason: "no answer for a day" });
    expect((await call("POST", `/api/plan-changes/${offered.id}`, { answer: "yes" })).status).toBe(409);
  });

  test("a reply that's regenerated takes its offers with it", async () => {
    const offered = await offer();
    fake.replies.push({ content: "never mind" });
    await call("POST", `/api/channels/${general.id}/regenerate`, {});
    expect(() => app.store.planChanges.get(offered.id)).toThrow();
    expect(changeEvents().at(-1)).toMatchObject({ id: offered.id, status: "expired" });
  });

  test("a turn that writes nothing drops what it offered", async () => {
    fake.replies.push({ toolCalls: [{ name: "add_plan", arguments: DENTIST }] }, { toolCalls: [{ name: "do_nothing", arguments: {} }] });
    say("dentist thursday at 3");
    await call("POST", `/api/channels/${general.id}/turn`, {});
    expect(changes()).toEqual([]);
  });
});

describe("changing and removing", () => {
  test("change_plan: only what changes, with what it was; a repeating plan changes every time", async () => {
    const work = app.store.plans.create({ kind: "shift", title: "Work", startDate: "2026-10-05", startTime: "09:00", endTime: "17:00", repeats: "weekly", checked: true });
    say("my monday shift starts at 10 now");
    jev({ asked: "yes" });
    const outcome = await runTool(ctx(), "change_plan", { plan_id: work.id, start_time: "10:00", end_time: "18:00" });
    expect(outcome.summary).toBe("changed Mon, Oct 5: Work (shift) 10:00a–6:00p, 8h, no draw hours, every week");
    expect(changes()[0]).toMatchObject({ action: "change", before: "Mon, Oct 5: Work (shift) 9:00a–5:00p, 8h, no draw hours, every week", status: "applied" });
    expect(app.store.plans.get(work.id)).toMatchObject({ startTime: "10:00", endTime: "18:00", repeats: "weekly", title: "Work" });
  });

  test("change_plan: explains mistakes", async () => {
    const dentist = app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00" });
    expect((await runTool(ctx(), "change_plan", { start_time: "4pm" })).summary).toContain('"plan_id" is required');
    expect((await runTool(ctx(), "change_plan", { plan_id: "nope", start_time: "4pm" })).summary).toContain('There\'s no plan with id "nope"');
    expect((await runTool(ctx(), "change_plan", { plan_id: dentist.id })).summary).toBe("Say what changes: a new date, time, title...");
    expect((await runTool(ctx(), "change_plan", { plan_id: dentist.id, start_time: "3pm" })).summary).toBe("That's how it is already.");
    expect((await runTool(ctx(), "change_plan", { plan_id: dentist.id, start_time: "later" })).summary).toBe('"start_time" must be a time like 15:00 or 3pm.');
    expect(changes()).toEqual([]);
  });

  test("remove_plan: gone when they say yes; a plan deleted meanwhile can't be", async () => {
    const dentist = app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00" });
    const outcome = await runTool(ctx(), "remove_plan", { plan_id: dentist.id });
    expect(outcome.summary).toBe("offered to remove Thu, Oct 1: Appointment: Dentist, 3:00p");
    const offered = changes()[0]!;
    await call("POST", `/api/plan-changes/${offered.id}`, { answer: "yes" });
    expect(plans()).toEqual([]);

    const haircut = app.store.plans.create({ kind: "appointment", title: "Haircut", startDate: "2026-10-02", startTime: "11:00" });
    await runTool(ctx(), "remove_plan", { plan_id: haircut.id });
    app.store.plans.delete(haircut.id);
    expect(app.store.planChanges.pending(time)).toEqual([]);
    expect(changes().at(-1)).toMatchObject({ status: "expired", reason: "the plan was deleted" });
  });

  test("add_plan: checked like any plan, and never twice", async () => {
    expect((await runTool(ctx(), "add_plan", { kind: "shift", title: "Work", date: "tomorrow", start_time: "9am" })).summary).toBe("A shift needs a start and an end time.");
    expect((await runTool(ctx(), "add_plan", { kind: "party", title: "x", date: "today" })).ok).toBe(false);
    app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00" });
    expect((await runTool(ctx(), "add_plan", DENTIST)).summary).toMatch(/^That's in the planner already: Appointment: Dentist, 3:00p/);
    // An overnight shift, a hotel night after it, and times in several shapes.
    jev({ asked: "yes" });
    await runTool(ctx(), "add_plan", { kind: "shift", title: "Night", date: "2026-10-03", start_time: "10pm", end_time: "6:00a", overnight: true });
    expect(app.store.plans.list().find((p) => p.title === "Night")).toMatchObject({ startTime: "22:00", endTime: "06:00", endDate: "2026-10-04", overnight: true, shiftType: "regular" });
  });

  test("a plan you said yes to at processing isn't added twice", async () => {
    jev({ asked: "yes" });
    await runTool(ctx(), "add_plan", DENTIST);
    const note = app.store.memory.addNote(
      { kind: "plan", text: "dentist thursday at 3", origin: "noticed", channelId: general.id, planDraft: { kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00", endTime: null, endDate: null, shiftType: null, notes: "" } },
      time,
    );
    app.store.memory.updateNote(note.id, { status: "asking", ask: "whether they want the dentist in the planner" }, time);
    jev({ a1: "yes" });
    await call("POST", `/api/channels/${general.id}/messages`, { content: "yes" });
    await app.replies.flush();
    expect(plans()).toHaveLength(1);
  });
});

describe("in her prompt and tools", () => {
  test("the guidance, and plan ids in her lookups", async () => {
    const dentist = app.store.plans.create({ kind: "appointment", title: "Dentist", startDate: "2026-10-01", startTime: "15:00" });
    const system = promptForChannel(app.store, general.id, { now: time, profile: app.store.profiles.list()[0]! })[0]!.content;
    expect(system).toContain("You can change their planner too: add_plan, change_plan, remove_plan");
    expect((await runTool(ctx(), "find_plans", { query: "dentist" })).result).toEqual([expect.objectContaining({ plan_id: dentist.id })]);
  });

  test("describePlan: the way her lookups say it, on its first day", () => {
    expect(describePlan({ kind: "birthday", title: "Mia's birthday", startDate: "2026-10-02", startTime: null, endDate: null, endTime: null, repeats: "yearly", reminders: null, checked: false, shiftType: null, drawStart: null, drawEnd: null, overnight: false, notes: "", source: "chat" })).toBe(
      "Fri, Oct 2: Birthday: Mia's birthday, all day, every year",
    );
  });
});
